/**
 * SSH host profiles and live connections to them.
 *
 * Owns three things (design/remote-ssh.md sections 3.1 and 6):
 *
 * 1. `~/.claude-terminal/remote-hosts.json`, the profile store. Main-process
 *    only, never synced, never reachable from an MCP tool, never part of
 *    settings.json. Atomic write with a `.bak`; an unreadable file throws
 *    REMOTE_HOSTS_UNREADABLE and is left exactly as it is, because every
 *    mutation here is a read-modify-write of the whole list.
 *
 * 2. Per profile, a pool of up to three channel lanes (`sshChannel.js`). Lane
 *    0 opens on connect, runs the handshake and carries the keepalive ping;
 *    further lanes open lazily when the existing ones are busy, so a slow
 *    `git fetch` does not hold up a status poll.
 *
 * 3. The connection state machine, broadcast to every window as
 *    `ssh-status-changed`:
 *
 *      idle -> connecting -> connected
 *      connecting -> authFailed | hostKeyUnknown | hostKeyChanged | unsupported
 *      connecting | connected -> reconnecting   (network, dns, timeout, refused)
 *      reconnecting -> connected                (a retry succeeded)
 *      reconnecting -> offline                  (the user disconnected)
 *      any -> idle                              (the user disconnected)
 *
 *    Retries stay in `reconnecting` rather than flipping back to `connecting`
 *    on each attempt, so a badge does not flicker; `detail.attempt` and
 *    `retryAt` say what is happening. Backoff is 1, 2, 4, 8, 16, then 30 s for
 *    as long as the host is wanted, with an immediate attempt on resume from
 *    sleep and on the renderer's `online` event. Authentication and host key
 *    failures are never retried automatically: retrying an auth failure can
 *    lock an account (fail2ban, MaxAuthTries), and a host key problem needs a
 *    human.
 *
 * Requests: idempotent reads wait for a (re)connection within their own
 * timeout and are re-dispatched if a lane dies under them; writes fail fast
 * with `reason: 'disconnected'` and are never replayed.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const { SshLane } = require('../utils/sshChannel');
const { handshakeScript, parseHandshake } = require('../utils/sshDriver');
const sshCommand = require('../utils/sshCommand');
const { shC, withPath, tmuxKillScript, classifySshFailure, isTerminalFailure } = require('../../shared/remote-shell');
const { isValidProfileId } = require('../../shared/remote-path');

const STORE_VERSION = 1;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const PING_INTERVAL_MS = 20000;
const PING_TIMEOUT_MS = 10000;
const MAX_LANES = 3;
const HANDSHAKE_TIMEOUT_MS = 30000;
const STDERR_DETAIL = 2000;

const STATES = Object.freeze([
  'idle', 'connecting', 'connected', 'reconnecting', 'offline',
  'authFailed', 'hostKeyUnknown', 'hostKeyChanged', 'unsupported',
]);

/** States in which nothing will connect until the user acts. */
const STOPPED_STATES = new Set(['offline', 'authFailed', 'hostKeyUnknown', 'hostKeyChanged', 'unsupported']);

const FAILURE_STATE = {
  auth: 'authFailed',
  'hostkey-unknown': 'hostKeyUnknown',
  'hostkey-changed': 'hostKeyChanged',
};

const PROFILE_FIELDS = new Set([
  'id', 'label', 'sshConfigAlias', 'host', 'user', 'port', 'identityFile', 'proxyJump',
  'forwardAgent', 'tmuxSessions', 'remoteClaudePath', 'createdAt', 'lastConnectedAt',
]);

function serviceError(code, message, extra) {
  const error = new Error(message);
  error.code = code;
  if (extra) Object.assign(error, extra);
  return error;
}

function emptyStore() {
  return { version: STORE_VERSION, sshBinary: null, profiles: [] };
}

function hasControlChars(text) {
  return /[\u0000-\u001f\u007f-\u009f]/.test(text);
}

function blank(value) {
  return value === undefined || value === null || value === '';
}

/**
 * Validate and normalise a profile coming from the renderer.
 *
 * Unknown fields are refused rather than dropped: there is deliberately no way
 * to carry a free-form ssh option (`ProxyCommand`, `LocalCommand`, `-o ...`),
 * and a caller trying to is told so.
 *
 * @param {object} input
 * @param {object} [options]
 * @param {(p: string) => boolean} [options.fileExists]
 * @returns {object} the normalised profile, without id/createdAt
 */
function validateProfile(input, { fileExists = fs.existsSync } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw serviceError('INVALID_PROFILE', 'Profile must be an object');
  for (const key of Object.keys(input)) {
    if (!PROFILE_FIELDS.has(key)) throw serviceError('INVALID_PROFILE', `Unknown profile field: ${key}`);
  }
  const wrap = (fn) => {
    try { return fn(); } catch (e) { throw serviceError('INVALID_PROFILE', e.message); }
  };
  const out = {};

  out.sshConfigAlias = blank(input.sshConfigAlias) ? null : wrap(() => sshCommand.assertHost(String(input.sshConfigAlias).trim(), 'sshConfigAlias'));
  out.host = blank(input.host) ? null : wrap(() => sshCommand.assertHost(String(input.host).trim(), 'host'));
  if (!out.sshConfigAlias && !out.host) throw serviceError('INVALID_PROFILE', 'Either a host or an ssh_config alias is required');
  out.user = blank(input.user) ? null : wrap(() => sshCommand.assertUser(String(input.user).trim()));
  out.port = blank(input.port) ? null : wrap(() => sshCommand.assertPort(input.port));
  out.proxyJump = blank(input.proxyJump) ? null : wrap(() => sshCommand.assertProxyJump(String(input.proxyJump).trim()));

  if (blank(input.identityFile)) out.identityFile = null;
  else {
    const file = wrap(() => sshCommand.assertLocalPath(String(input.identityFile), 'identityFile'));
    if (!fileExists(file)) throw serviceError('INVALID_PROFILE', 'identityFile does not exist');
    out.identityFile = file;
  }

  if (blank(input.remoteClaudePath)) out.remoteClaudePath = null;
  else {
    const p = String(input.remoteClaudePath);
    if (!p.startsWith('/') || hasControlChars(p)) throw serviceError('INVALID_PROFILE', 'remoteClaudePath must be an absolute POSIX path');
    out.remoteClaudePath = p;
  }

  for (const flag of ['forwardAgent', 'tmuxSessions']) {
    if (!blank(input[flag]) && typeof input[flag] !== 'boolean') throw serviceError('INVALID_PROFILE', `${flag} must be a boolean`);
    out[flag] = input[flag] === true;
  }

  const label = blank(input.label) ? '' : String(input.label).trim();
  if (hasControlChars(label) || label.length > 80) throw serviceError('INVALID_PROFILE', 'label must be at most 80 printable characters');
  out.label = label || sshCommand.displayDestination(out);
  return out;
}

/**
 * What a lane that failed to open means for the connection.
 * @returns {{ retry: true, kind: string, stderr: string } | { retry: false, state: string, detail: object }}
 */
function classifyOpenFailure(err) {
  const stderr = String(err.stderr || '').slice(-STDERR_DETAIL);
  if (err.failKind === 'spawn') {
    return { retry: false, state: 'unsupported', detail: { code: err.errno === 'ENOENT' ? 'ssh-not-found' : 'spawn-failed', message: err.message } };
  }
  if (err.failKind === 'driver') {
    return { retry: false, state: 'unsupported', detail: { code: 'remote-tmp', message: err.reason || '' } };
  }
  const kind = err.sshFailure || classifySshFailure(err.exitCode, stderr) || 'network';
  if (isTerminalFailure(kind)) return { retry: false, state: FAILURE_STATE[kind], detail: { kind, stderr } };
  // ssh exits 255 for its own failures. Any other exit before the ready
  // marker means ssh connected and the remote side could not run the driver:
  // no /bin/sh, or a Windows sshd whose shell is cmd.exe or PowerShell.
  if (err.failKind === 'exit' && Number.isInteger(err.exitCode) && err.exitCode !== 255) {
    return { retry: false, state: 'unsupported', detail: { code: 'no-posix-shell', exitCode: err.exitCode, stderr } };
  }
  return { retry: true, kind, stderr };
}

function defaultBroadcast(channel, payload) {
  let BrowserWindow;
  try { ({ BrowserWindow } = require('electron')); } catch { return; }
  if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') return;
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
    } catch { /* window going away */ }
  }
}

class SshHostService extends EventEmitter {
  /**
   * @param {object} [options]  every dependency is injectable for tests
   */
  constructor({
    dataDir = require('../utils/paths').dataDir,
    storeFile = null,
    platform = process.platform,
    env = process.env,
    broadcast = defaultBroadcast,
    createLane = (opts) => new SshLane(opts),
    spawnImpl = spawn,
    resolveLauncher = null,
    fileExists = fs.existsSync,
    fsp = fs.promises,
    now = () => Date.now(),
    backoffMs = BACKOFF_MS,
    pingIntervalMs = PING_INTERVAL_MS,
    pingTimeoutMs = PING_TIMEOUT_MS,
    maxLanes = MAX_LANES,
  } = {}) {
    super();
    this.dataDir = dataDir;
    this.storeFile = storeFile || path.join(dataDir, 'remote-hosts.json');
    this.platform = platform;
    this.env = env;
    this.broadcast = broadcast;
    this.createLane = createLane;
    this.spawnImpl = spawnImpl;
    this.resolveLauncher = resolveLauncher;
    this.fileExists = fileExists;
    this.fsp = fsp;
    this.now = now;
    this.backoffMs = backoffMs;
    this.pingIntervalMs = pingIntervalMs;
    this.pingTimeoutMs = pingTimeoutMs;
    this.maxLanes = maxLanes;
    this.hosts = new Map();
    this.oneShots = new Set();
    this._cache = null;
    this._writeChain = Promise.resolve();
    this._sshBinary = undefined;
    this._disposed = false;
  }

  // ── Profile store ─────────────────────────────────────────────────────────

  /**
   * Read remote-hosts.json. Absent means no profiles. Anything unreadable
   * throws REMOTE_HOSTS_UNREADABLE and the file is not touched.
   */
  async loadStore() {
    let stat;
    try {
      stat = await this.fsp.stat(this.storeFile);
    } catch (e) {
      if (e.code === 'ENOENT') { this._cache = null; return emptyStore(); }
      throw serviceError('REMOTE_HOSTS_UNREADABLE', `Refusing to use remote-hosts.json: ${e.message}`);
    }
    if (this._cache && this._cache.mtimeMs === stat.mtimeMs && this._cache.size === stat.size) {
      return structuredClone(this._cache.store);
    }
    let parsed;
    try {
      parsed = JSON.parse(await this.fsp.readFile(this.storeFile, 'utf8'));
    } catch (e) {
      throw serviceError('REMOTE_HOSTS_UNREADABLE', `Refusing to use remote-hosts.json - it is unreadable (${e.message})`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed.profiles !== undefined && !Array.isArray(parsed.profiles))) {
      throw serviceError('REMOTE_HOSTS_UNREADABLE', 'Refusing to use remote-hosts.json - it does not have the expected shape');
    }
    const store = {
      version: parsed.version || STORE_VERSION,
      sshBinary: typeof parsed.sshBinary === 'string' && parsed.sshBinary ? parsed.sshBinary : null,
      profiles: (parsed.profiles || []).filter((p) => p && typeof p === 'object' && isValidProfileId(p.id)),
    };
    this._cache = { mtimeMs: stat.mtimeMs, size: stat.size, store };
    return structuredClone(store);
  }

  async _saveStore(store) {
    await this.fsp.mkdir(path.dirname(this.storeFile), { recursive: true });
    const text = JSON.stringify(store, null, 2);
    const tmp = `${this.storeFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await this.fsp.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
    try {
      await this.fsp.copyFile(this.storeFile, `${this.storeFile}.bak`);
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[SshHostService] Could not back up remote-hosts.json:', e.message);
    }
    await this.fsp.rename(tmp, this.storeFile);
    this._cache = null;
  }

  /** Serialise read-modify-write cycles so two saves cannot interleave. */
  _mutate(fn) {
    const run = this._writeChain.then(async () => {
      const store = await this.loadStore();
      const result = await fn(store);
      await this._saveStore(store);
      return result;
    });
    this._writeChain = run.catch(() => {});
    return run;
  }

  async listProfiles() {
    return (await this.loadStore()).profiles;
  }

  async getProfile(profileId) {
    if (!isValidProfileId(profileId)) return null;
    const store = await this.loadStore();
    return store.profiles.find((p) => p.id === profileId) || null;
  }

  _newId(existing) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (;;) {
      const bytes = crypto.randomBytes(8);
      let id = '';
      for (const b of bytes) id += alphabet[b % alphabet.length];
      if (!existing.has(id)) return id;
    }
  }

  /**
   * Create or update a profile. An `id` that is not in the store creates a
   * profile with that id when it is well formed, which is how a project synced
   * from another machine gets its host back.
   */
  async saveProfile(input) {
    const fields = validateProfile(input, { fileExists: this.fileExists });
    const requestedId = input && input.id;
    if (!blank(requestedId) && !isValidProfileId(requestedId)) throw serviceError('INVALID_PROFILE', 'Invalid profile id');
    const saved = await this._mutate((store) => {
      const index = requestedId ? store.profiles.findIndex((p) => p.id === requestedId) : -1;
      if (index !== -1) {
        const prev = store.profiles[index];
        store.profiles[index] = { ...prev, ...fields, id: prev.id, createdAt: prev.createdAt || this.now(), lastConnectedAt: prev.lastConnectedAt || null };
        return store.profiles[index];
      }
      const id = requestedId || this._newId(new Set(store.profiles.map((p) => p.id)));
      const profile = { id, ...fields, createdAt: this.now(), lastConnectedAt: null };
      store.profiles.push(profile);
      return profile;
    });
    // A changed profile must not keep using lanes opened with the old argv.
    const host = this.hosts.get(saved.id);
    if (host && host.state !== 'idle') this.disconnect(saved.id);
    return saved;
  }

  async deleteProfile(profileId) {
    if (!isValidProfileId(profileId)) throw serviceError('INVALID_PROFILE', 'Invalid profile id');
    this.disconnect(profileId);
    this.hosts.delete(profileId);
    return this._mutate((store) => {
      const before = store.profiles.length;
      store.profiles = store.profiles.filter((p) => p.id !== profileId);
      return before !== store.profiles.length;
    });
  }

  async _touchLastConnected(profileId) {
    try {
      await this._mutate((store) => {
        const profile = store.profiles.find((p) => p.id === profileId);
        if (profile) profile.lastConnectedAt = this.now();
      });
    } catch (e) {
      console.warn('[SshHostService] Could not record last connection:', e.message);
    }
  }

  // ── ssh binary ────────────────────────────────────────────────────────────

  async _launcher(store) {
    if (this.resolveLauncher) return this.resolveLauncher(store);
    if (this._sshBinary === undefined || (store.sshBinary && this._sshBinary !== store.sshBinary)) {
      this._sshBinary = await sshCommand.findSshBinary({ override: store.sshBinary, platform: this.platform, env: this.env });
    }
    return this._sshBinary ? { command: this._sshBinary, prefixArgs: [] } : null;
  }

  _controlDir() {
    if (this.platform === 'win32') return null;
    try {
      return sshCommand.ensureControlDir(this.dataDir, { platform: this.platform });
    } catch (e) {
      console.warn('[SshHostService] ControlMaster directory unavailable:', e.message);
      return null;
    }
  }

  // ── State ─────────────────────────────────────────────────────────────────

  _host(profileId) {
    let host = this.hosts.get(profileId);
    if (!host) {
      host = {
        profileId,
        state: 'idle',
        detail: null,
        retryAt: null,
        capabilities: null,
        attempt: 0,
        wanted: false,
        generation: 0,
        lanes: [],
        opening: 0,
        connectPromise: null,
        connectGeneration: 0,
        retryTimer: null,
        pingTimer: null,
        waiters: new Set(),
        profile: null,
        launcher: null,
      };
      this.hosts.set(profileId, host);
    }
    return host;
  }

  _statusOf(host) {
    return {
      profileId: host.profileId,
      state: host.state,
      detail: host.detail,
      retryAt: host.retryAt,
      capabilities: host.capabilities,
    };
  }

  getStatus(profileId) {
    const host = this.hosts.get(profileId);
    return host ? this._statusOf(host) : { profileId, state: 'idle', detail: null, retryAt: null, capabilities: null };
  }

  getAllStatuses() {
    return [...this.hosts.values()].map((h) => this._statusOf(h));
  }

  _setState(host, state, detail = null, retryAt = null) {
    host.state = state;
    host.detail = detail;
    host.retryAt = retryAt;
    const status = this._statusOf(host);
    try { this.broadcast('ssh-status-changed', status); } catch (e) { console.warn('[SshHostService] Broadcast failed:', e.message); }
    this.emit('status', status);
    for (const waiter of [...host.waiters]) waiter(state);
  }

  /**
   * Resolve true once connected, false when the host stops trying, the
   * deadline passes or the signal aborts.
   */
  _waitConnected(host, ms, signal) {
    if (host.state === 'connected') return Promise.resolve(true);
    if (ms <= 0 || (signal && signal.aborted)) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer = null;
      const finish = (value) => {
        host.waiters.delete(waiter);
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const waiter = (state) => {
        if (state === 'connected') finish(true);
        else if (state === 'idle' || STOPPED_STATES.has(state)) finish(false);
      };
      const onAbort = () => finish(false);
      host.waiters.add(waiter);
      timer = setTimeout(() => finish(false), ms);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ── Connecting ────────────────────────────────────────────────────────────

  /**
   * Connect a profile (or join the attempt in progress). Resolves with the
   * resulting status; never rejects for a connection failure, which is a state.
   */
  async connect(profileId) {
    if (!isValidProfileId(profileId)) throw serviceError('INVALID_PROFILE', 'Invalid profile id');
    if (this._disposed) return this.getStatus(profileId);
    const host = this._host(profileId);
    host.wanted = true;
    if (host.state === 'connected') return this._statusOf(host);
    if (host.connectPromise) {
      // Join the attempt in progress, unless a disconnect (or a profile edit)
      // made it stale: that one settles without connecting, and a connect
      // asked for after the disconnect must start a fresh attempt once it has.
      if (host.connectGeneration === host.generation) return host.connectPromise;
      return host.connectPromise.catch(() => {}).then(() => this.connect(profileId));
    }
    clearTimeout(host.retryTimer);
    host.retryTimer = null;
    if (host.state !== 'reconnecting') host.attempt = 0;
    return this._attempt(host);
  }

  _attempt(host) {
    const generation = host.generation;
    const stale = () => generation !== host.generation || this._disposed;
    host.connectGeneration = generation;
    host.connectPromise = (async () => {
      if (host.state !== 'reconnecting') this._setState(host, 'connecting', host.attempt ? { attempt: host.attempt } : null);

      let store, profile, launcher;
      try {
        store = await this.loadStore();
        profile = store.profiles.find((p) => p.id === host.profileId) || null;
      } catch (e) {
        this._setState(host, 'unsupported', { code: 'store-unreadable', message: e.message });
        return this._statusOf(host);
      }
      if (!profile) {
        host.wanted = false;
        this._setState(host, 'unsupported', { code: 'profile-missing' });
        return this._statusOf(host);
      }
      try {
        launcher = await this._launcher(store);
      } catch (e) {
        launcher = null;
      }
      if (!launcher) {
        this._setState(host, 'unsupported', { code: 'ssh-not-found' });
        return this._statusOf(host);
      }
      if (stale()) return this._statusOf(host);
      host.profile = profile;
      host.launcher = launcher;

      let lane;
      try {
        lane = this._makeLane(host);
      } catch (e) {
        // A hand-edited remote-hosts.json the argv builder refuses.
        this._setState(host, 'unsupported', { code: 'invalid-profile', message: e.message });
        return this._statusOf(host);
      }
      try {
        await lane.open();
      } catch (err) {
        if (stale()) return this._statusOf(host);
        return this._onConnectFailure(host, err);
      }
      if (stale()) { lane.close('stale'); return this._statusOf(host); }

      const res = await lane.request(handshakeScript({ claudePath: profile.remoteClaudePath }), { timeoutMs: HANDSHAKE_TIMEOUT_MS, maxBuffer: 512 * 1024 });
      if (stale()) { lane.close('stale'); return this._statusOf(host); }
      if (!res.ok) {
        lane.close('handshake-failed');
        if (res.reason === 'disconnected' || res.reason === 'timeout') return this._scheduleRetry(host, res.reason === 'timeout' ? 'timeout' : 'network');
        this._setState(host, 'unsupported', { code: 'handshake-failed', stderr: res.stderr ? res.stderr.toString('utf8').slice(-STDERR_DETAIL) : '' });
        return this._statusOf(host);
      }
      const capabilities = parseHandshake(res.stdout.toString('utf8'));
      if (!capabilities.loginShellSupported) {
        lane.close('unsupported');
        host.capabilities = capabilities;
        this._setState(host, 'unsupported', { code: 'login-shell', shell: capabilities.shell });
        return this._statusOf(host);
      }
      if (capabilities.path) await lane.setPath(capabilities.path);
      if (stale() || lane.exited) { lane.close('stale'); return stale() ? this._statusOf(host) : this._scheduleRetry(host, 'network'); }

      host.capabilities = capabilities;
      host.lanes = [lane];
      host.attempt = 0;
      this._watchLane(host, lane, generation);
      this._startPing(host);
      this._setState(host, 'connected');
      this._touchLastConnected(host.profileId);
      return this._statusOf(host);
    })().finally(() => {
      host.connectPromise = null;
    });
    return host.connectPromise;
  }

  _makeLane(host) {
    const args = sshCommand.channelArgs(host.profile, { platform: this.platform, controlDir: this._controlDir() });
    return this.createLane({
      command: host.launcher.command,
      args: [...(host.launcher.prefixArgs || []), ...args],
      env: host.launcher.env || this.env,
      spawnImpl: this.spawnImpl,
    });
  }

  _onConnectFailure(host, err) {
    const verdict = classifyOpenFailure(err);
    if (verdict.retry) return this._scheduleRetry(host, verdict.kind, verdict.stderr);
    this._setState(host, verdict.state, verdict.detail);
    return this._statusOf(host);
  }

  _scheduleRetry(host, kind, stderr = '') {
    this._dropLanes(host);
    if (!host.wanted || this._disposed) {
      this._setState(host, 'offline', { kind });
      return this._statusOf(host);
    }
    const delay = this.backoffMs[Math.min(host.attempt, this.backoffMs.length - 1)];
    host.attempt += 1;
    const retryAt = this.now() + delay;
    clearTimeout(host.retryTimer);
    host.retryTimer = setTimeout(() => {
      host.retryTimer = null;
      if (host.wanted && !this._disposed && !host.connectPromise) this._attempt(host).catch(() => {});
    }, delay);
    this._setState(host, 'reconnecting', { kind, attempt: host.attempt, stderr: stderr ? stderr.slice(-STDERR_DETAIL) : undefined }, retryAt);
    return this._statusOf(host);
  }

  _watchLane(host, lane, generation) {
    lane.on('exit', (info) => {
      host.lanes = host.lanes.filter((l) => l !== lane);
      if (generation !== host.generation || this._disposed) return;
      if (info.expected) return;
      if (host.state === 'connected') this._scheduleRetry(host, info.sshFailure || 'network', info.stderr || '');
    });
  }

  _dropLanes(host) {
    clearInterval(host.pingTimer);
    host.pingTimer = null;
    const lanes = host.lanes;
    host.lanes = [];
    for (const lane of lanes) lane.close('reconnect');
  }

  _startPing(host) {
    clearInterval(host.pingTimer);
    if (!this.pingIntervalMs) return;
    host.pingTimer = setInterval(() => this._ping(host), this.pingIntervalMs);
    if (host.pingTimer.unref) host.pingTimer.unref();
  }

  async _ping(host) {
    if (host.state !== 'connected') return;
    const lane = host.lanes.find((l) => l.isOpen);
    if (!lane || lane.load > 0) return; // a busy lane is talking already; ServerAlive covers a dead link
    const generation = host.generation;
    const res = await lane.request(':', { timeoutMs: this.pingTimeoutMs });
    if (generation !== host.generation || host.state !== 'connected') return;
    if (res.reason === 'timeout') this._scheduleRetry(host, 'timeout');
  }

  /**
   * Whether the link to a host is alive right now, for a caller that has to
   * tell a dropped connection from a remote command's own failure (a PTY
   * whose ssh exited 255 without saying why).
   *
   * Never connects a host and never waits for one: `alive` needs a connected
   * host answering a no-op on a lane within `timeoutMs`; `dead` is a host
   * that is not connected or did not answer; `unknown` is a host this service
   * has not reached yet (idle, or still on its first attempt), about which it
   * knows nothing. The state
   * machine is left alone: the regular ping and keepalives decide reconnects.
   *
   * @param {string} profileId
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<'alive'|'dead'|'unknown'>}
   */
  async probe(profileId, { timeoutMs = 5000 } = {}) {
    const host = this.hosts.get(profileId);
    if (!host || host.state === 'idle' || host.state === 'connecting') return 'unknown';
    if (host.state !== 'connected') return 'dead';
    const res = await this.exec(profileId, ':', { write: true, timeoutMs });
    return res && res.ok ? 'alive' : 'dead';
  }

  /** The user disconnected. A host that was retrying goes `offline`, anything else `idle`. */
  disconnect(profileId) {
    const host = this.hosts.get(profileId);
    if (!host) return this.getStatus(profileId);
    const wasRetrying = host.state === 'reconnecting';
    host.wanted = false;
    host.generation += 1;
    clearTimeout(host.retryTimer);
    host.retryTimer = null;
    this._dropLanes(host);
    host.attempt = 0;
    this._setState(host, wasRetrying ? 'offline' : 'idle');
    return this._statusOf(host);
  }

  /** Resume from sleep or the network came back: retry now instead of waiting out the backoff. */
  retryNow(reason = 'resume') {
    for (const host of this.hosts.values()) {
      if (host.state === 'reconnecting' && host.wanted && !host.connectPromise) {
        clearTimeout(host.retryTimer);
        host.retryTimer = null;
        this._attempt(host).catch(() => {});
      } else if (host.state === 'connected') {
        // After a sleep the TCP connection is often dead without anyone
        // having noticed yet; a ping finds out now rather than in 45 s.
        this._ping(host);
      }
    }
    return reason;
  }

  onResume() { return this.retryNow('resume'); }
  onOnline() { return this.retryNow('online'); }

  // ── Requests ──────────────────────────────────────────────────────────────

  async _openExtraLane(host) {
    host.opening += 1;
    const generation = host.generation;
    try {
      const lane = this._makeLane(host);
      await lane.open();
      if (generation !== host.generation || host.state !== 'connected') { lane.close('stale'); return null; }
      if (host.capabilities && host.capabilities.path) await lane.setPath(host.capabilities.path);
      if (lane.exited) return null;
      host.lanes.push(lane);
      this._watchLane(host, lane, generation);
      return lane;
    } catch (e) {
      return null;
    } finally {
      host.opening -= 1;
    }
  }

  /** An open lane with nothing queued, or null. Synchronous on purpose, see exec(). */
  _idleLane(host) {
    return host.lanes.find((l) => l.isOpen && l.load === 0) || null;
  }

  async _pickLane(host) {
    const idle = this._idleLane(host);
    if (idle) return idle;
    if (host.lanes.length + host.opening < this.maxLanes) {
      const lane = await this._openExtraLane(host);
      if (lane) return lane;
    }
    const stillOpen = host.lanes.filter((l) => l.isOpen);
    if (stillOpen.length) return stillOpen.reduce((a, b) => (b.load < a.load ? b : a));
    return null;
  }

  /** Send the process-group kill for a stuck request on a lane other than the stuck one. */
  async _runKill(host, stuckLane, script) {
    let sibling = host.lanes.filter((l) => l !== stuckLane && l.isOpen).sort((a, b) => a.load - b.load)[0];
    if (!sibling) sibling = await this._openExtraLane(host);
    if (!sibling) return;
    await sibling.request(script, { timeoutMs: 5000 });
  }

  /**
   * Run a one-line script on the host.
   *
   * @param {string} profileId
   * @param {string} script
   * @param {object} [options]
   * @param {boolean} [options.write]      fail fast when not connected, never replay
   * @param {number} [options.timeoutMs]   wall-clock budget, waiting included
   * @param {number} [options.maxBuffer]
   * @param {AbortSignal} [options.signal]
   * @param {Buffer} [options.input]       bytes for the script's stdin (implies write)
   */
  async exec(profileId, script, { write = false, timeoutMs = 15000, maxBuffer, signal, input } = {}) {
    const isWrite = write || Boolean(input);
    const deadline = this.now() + timeoutMs;
    const fail = (reason, extra) => ({ ok: false, reason, code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), ...extra });
    if (!isValidProfileId(profileId)) return fail('disconnected', { state: 'unknown' });
    const host = this._host(profileId);

    for (;;) {
      if (signal && signal.aborted) return fail('cancelled');
      const remaining = deadline - this.now();
      if (remaining <= 0) return fail(host.state === 'connected' ? 'timeout' : 'disconnected', { state: host.state });

      if (host.state !== 'connected') {
        if (isWrite || STOPPED_STATES.has(host.state)) return fail('disconnected', { state: host.state });
        // connect() joins a current attempt and outwaits a stale one.
        if (host.state === 'idle') this.connect(profileId).catch(() => {});
        const ok = await this._waitConnected(host, remaining, signal);
        if (!ok) return fail(signal && signal.aborted ? 'cancelled' : 'disconnected', { state: host.state });
        continue;
      }

      // The idle check and the request are made in the same tick, so a burst
      // of requests spreads over the pool instead of every one of them
      // seeing lane 0 idle before the first has been queued on it.
      const lane = this._idleLane(host) || await this._pickLane(host);
      if (!lane) {
        if (host.state === 'connected') this._scheduleRetry(host, 'network');
        continue;
      }
      if (!lane.killer) lane.setKiller((killScript) => this._runKill(host, lane, killScript));
      const res = await lane.request(script, { timeoutMs: Math.max(1, deadline - this.now()), maxBuffer, signal, input });
      // A lane that died under a read is not the read's fault: wait for the
      // connection and run it again. A write is never replayed.
      if (res.reason === 'disconnected' && !isWrite) continue;
      return res;
    }
  }

  /** `exec` and `oneShot` bound to one profile, the shape `createRemoteFs` takes. */
  runner(profileId) {
    return {
      exec: (script, opts) => this.exec(profileId, script, opts),
      oneShot: (script, opts) => this.oneShot(profileId, script, opts),
    };
  }

  /**
   * A one-shot `ssh ... /bin/sh -c <script>` process, for what cannot share
   * the channel: transfers over the PUT limit and streams such as
   * `git clone --progress`. Requires a connected host (it is a write-class
   * operation) so it inherits the handshake's PATH.
   *
   * @returns {Promise<{ ok: boolean, code: number|null, stdout: Buffer, stderr: Buffer, reason?: string }>}
   */
  async oneShot(profileId, script, { input, onStdout, onStderr, timeoutMs = 300000, maxBuffer = 1024 * 1024, signal, keepStdinOpen = false } = {}) {
    const empty = { code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    const host = this.hosts.get(profileId);
    if (!host || host.state !== 'connected' || !host.profile || !host.launcher) return { ok: false, reason: 'disconnected', ...empty };
    if (signal && signal.aborted) return { ok: false, reason: 'cancelled', ...empty };
    let args;
    try {
      const remote = shC(withPath(host.capabilities && host.capabilities.path, script));
      args = sshCommand.oneShotArgs(host.profile, remote, { platform: this.platform, controlDir: this._controlDir() });
    } catch (e) {
      return { ok: false, reason: 'invalid', error: e.message, ...empty };
    }
    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnImpl(host.launcher.command, [...(host.launcher.prefixArgs || []), ...args], {
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: host.launcher.env || this.env,
        });
      } catch (e) {
        resolve({ ok: false, reason: 'disconnected', error: e.message, ...empty });
        return;
      }
      this.oneShots.add(child);
      const out = [];
      let outLen = 0;
      let overflow = false;
      let errText = '';
      let abortReason = null;
      let settled = false;
      const stop = (reason) => {
        if (abortReason) return;
        abortReason = reason;
        try { child.kill(); } catch { /* gone */ }
      };
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      const onAbort = () => stop('cancelled');
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk) => {
        if (onStdout) { try { onStdout(chunk); } catch { /* listener error */ } }
        if (overflow) return;
        outLen += chunk.length;
        if (outLen > maxBuffer) { overflow = true; out.length = 0; stop('maxbuffer'); return; }
        out.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        if (onStderr) { try { onStderr(chunk); } catch { /* listener error */ } }
        errText = (errText + chunk.toString('utf8')).slice(-65536);
      });
      child.stdin.on('error', () => { /* the remote side closed early; the exit code tells */ });
      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        this.oneShots.delete(child);
        const stderr = Buffer.from(errText, 'utf8');
        if (abortReason) { resolve({ ok: false, reason: abortReason, code, stdout: Buffer.alloc(0), stderr }); return; }
        if (code === 255) {
          resolve({ ok: false, reason: 'disconnected', code, stdout: Buffer.concat(out), stderr, sshFailure: classifySshFailure(code, errText) });
          return;
        }
        resolve({ ok: code === 0, code, stdout: Buffer.concat(out), stderr });
      };
      let exitTimer = null;
      child.on('error', (e) => { errText += e.message; finish(null); });
      child.on('exit', (code) => { exitTimer = setTimeout(() => finish(code), 1000); });
      child.on('close', (code) => { clearTimeout(exitTimer); finish(code); });
      // `keepStdinOpen`: a long-running script that watches its stdin for the
      // end of the session (the remote inotify watcher). The pipe closes when
      // this ssh exits or is killed.
      if (input) child.stdin.end(Buffer.from(input));
      else if (!keepStdinOpen) child.stdin.end();
    });
  }

  // ── Host key verification ─────────────────────────────────────────────────

  /**
   * The program and argv of the "Verify host" action: `ssh -o
   * StrictHostKeyChecking=ask -- <dest> exit`, run in a local PTY so OpenSSH
   * itself shows the fingerprint, asks, and writes known_hosts. The app never
   * answers for the user and never touches known_hosts.
   * @returns {Promise<{ file: string, args: string[], destination: string }>}
   */
  async verifyCommand(profileId) {
    const store = await this.loadStore();
    const profile = store.profiles.find((p) => p.id === profileId);
    if (!profile) throw serviceError('REMOTE_PROFILE_UNKNOWN', 'No SSH host profile with this id is configured on this machine');
    const launcher = await this._launcher(store);
    if (!launcher) throw serviceError('SSH_NOT_FOUND', 'No OpenSSH client was found on this machine');
    const args = sshCommand.buildSshArgs(profile, { mode: 'verify', platform: this.platform });
    return { file: launcher.command, args: [...(launcher.prefixArgs || []), ...args], destination: sshCommand.displayDestination(profile) };
  }

  // ── Terminal PTYs ─────────────────────────────────────────────────────────

  /**
   * The ControlMaster socket directory for processes that cannot share the
   * channel (terminal PTYs, chat), or null on win32 or when it cannot be made.
   */
  controlDir() {
    return this._controlDir();
  }

  /**
   * What a terminal PTY needs to reach a host: the ssh binary, the stored
   * profile, the ControlMaster directory, and the host's capabilities when a
   * channel has already connected (null otherwise: a PTY is its own ssh
   * process and does not wait for the channel, which is what lets a
   * password-only host work in a terminal).
   *
   * Main-process only. The renderer never names a host: the terminal IPC
   * resolves the profile from a registered project first.
   *
   * @param {string} profileId
   * @returns {Promise<{ profileId: string, profile: object, command: string, prefixArgs: string[], env: object|null, capabilities: object|null, controlDir: string|null, platform: string }>}
   */
  async ptyLaunch(profileId) {
    if (!isValidProfileId(profileId)) throw serviceError('INVALID_PROFILE', 'Invalid profile id');
    const store = await this.loadStore();
    const profile = store.profiles.find((p) => p.id === profileId);
    if (!profile) throw serviceError('REMOTE_PROFILE_UNKNOWN', 'No SSH host profile with this id is configured on this machine');
    const launcher = await this._launcher(store);
    if (!launcher) throw serviceError('SSH_NOT_FOUND', 'No OpenSSH client was found on this machine');
    const host = this.hosts.get(profileId);
    return {
      profileId,
      profile,
      command: launcher.command,
      prefixArgs: launcher.prefixArgs || [],
      env: launcher.env || null,
      capabilities: host && host.capabilities ? host.capabilities : null,
      controlDir: this._controlDir(),
      platform: this.platform,
    };
  }

  /**
   * End a terminal's tmux session after the user closed its tab. Fails fast
   * rather than connecting a host for it: a session left behind on a host
   * that was not reachable is the lesser harm.
   */
  async killTmuxSession(profileId, tmuxSession) {
    const res = await this.exec(profileId, tmuxKillScript(tmuxSession), { write: true, timeoutMs: 10000 });
    return Boolean(res && res.ok);
  }

  // ── Profile test ──────────────────────────────────────────────────────────

  /**
   * Open a throwaway lane and run the handshake, without touching the
   * connection state. What the profile editor's "Test" button shows.
   */
  async testProfile(profileId) {
    const store = await this.loadStore();
    const profile = store.profiles.find((p) => p.id === profileId);
    if (!profile) throw serviceError('REMOTE_PROFILE_UNKNOWN', 'No SSH host profile with this id is configured on this machine');
    const launcher = await this._launcher(store);
    if (!launcher) return { ok: false, state: 'unsupported', detail: { code: 'ssh-not-found' } };
    const probe = { profileId, profile, launcher };
    let lane;
    try {
      lane = this._makeLane(probe);
    } catch (e) {
      return { ok: false, state: 'unsupported', detail: { code: 'invalid-profile', message: e.message } };
    }
    try {
      await lane.open();
    } catch (err) {
      const verdict = classifyOpenFailure(err);
      if (verdict.retry) return { ok: false, state: 'unreachable', detail: { kind: verdict.kind, stderr: verdict.stderr } };
      return { ok: false, state: verdict.state, detail: verdict.detail };
    }
    try {
      const res = await lane.request(handshakeScript({ claudePath: profile.remoteClaudePath }), { timeoutMs: HANDSHAKE_TIMEOUT_MS, maxBuffer: 512 * 1024 });
      if (!res.ok) return { ok: false, state: 'unsupported', detail: { code: 'handshake-failed', reason: res.reason || null } };
      const capabilities = parseHandshake(res.stdout.toString('utf8'));
      if (!capabilities.loginShellSupported) return { ok: false, state: 'unsupported', detail: { code: 'login-shell', shell: capabilities.shell }, capabilities };
      return { ok: true, state: 'connected', capabilities, destination: sshCommand.displayDestination(profile) };
    } finally {
      lane.close('test-done');
    }
  }

  // ── Shutdown ──────────────────────────────────────────────────────────────

  /** Close every lane and one-shot process. Called at quit. */
  disposeAll() {
    this._disposed = true;
    for (const host of this.hosts.values()) {
      host.wanted = false;
      host.generation += 1;
      clearTimeout(host.retryTimer);
      host.retryTimer = null;
      this._dropLanes(host);
    }
    for (const child of this.oneShots) {
      try { child.kill(); } catch { /* gone */ }
    }
    this.oneShots.clear();
  }
}

const instance = new SshHostService();

module.exports = instance;
module.exports.SshHostService = SshHostService;
module.exports.validateProfile = validateProfile;
module.exports.classifyOpenFailure = classifyOpenFailure;
module.exports.STATES = STATES;
module.exports.BACKOFF_MS = BACKOFF_MS;
