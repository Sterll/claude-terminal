#!/usr/bin/env node
/**
 * Live harness for remote SSH projects: the real main-process modules against
 * a real sshd, through the OpenSSH client the app discovers.
 *
 * Opt-in and never part of `npm test` or CI. Without CT_REMOTE_LIVE_DEST it
 * prints why it skipped and exits 0.
 *
 *   CT_REMOTE_LIVE_DEST   [user@]host[:port] of a throwaway POSIX host whose
 *                         sshd accepts the local key or agent (required)
 *   CT_REMOTE_LIVE_JUMP   ProxyJump for it, `[user@]host[:port]` (optional)
 *   CT_REMOTE_LIVE_ADMIN  an ssh-style command prefix that runs a shell
 *                         command line as root on the same host, for example
 *                         `ssh -p 2222 root@pve pct exec 990 --` (optional).
 *                         It must not go through the host's own network.
 *                         The harness appends `sh -c <one quoted script>`.
 *                         Without it, the scenarios that need root (host
 *                         keys, a user without a key, network drop, sshd
 *                         restart, root-wide process checks) are skipped.
 *   CT_REMOTE_LIVE_IFACE  interface the network drop takes down (eth0)
 *   CT_REMOTE_LIVE_DROP_S seconds the network stays down (45)
 *   CT_REMOTE_LIVE_ONLY   comma-separated groups to run (default: all): channel,
 *                         auth, fs, git, sessions, chat, watcher, pty, shells,
 *                         reconnect, leaks.
 *                         discovery, hostkeys and connect always run
 *   CT_REMOTE_LIVE_REBOOT `1` to also stop and start the host through
 *                         CT_REMOTE_LIVE_ADMIN_REBOOT (a full command line,
 *                         e.g. `ssh -p 2222 root@pve pct stop 990 && pct start 990`)
 *
 * Isolation: os.homedir() points at a temporary directory before any app
 * module loads, so remote-hosts.json, projects.json and every cache live
 * there. The ssh processes keep the real environment, so they read the
 * user's own keys and ~/.ssh/config. The harness never writes the user's
 * ~/.ssh/known_hosts: when it has root on the host, it builds a dedicated
 * known_hosts from the host's public keys and hands ssh
 * `-o UserKnownHostsFile=` through the launcher hook SshHostService exposes
 * for exactly this kind of caller. The product code never redirects it.
 *
 * Nothing is left behind: the remote work directory, any user the harness
 * created and the temporary home are removed at the end, the network is
 * brought back up, and the run fails if an ssh process of ours survives on
 * either side.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');

const DEST = process.env.CT_REMOTE_LIVE_DEST || '';
if (!DEST) {
  console.log('remote-ssh-live: skipped (set CT_REMOTE_LIVE_DEST=[user@]host[:port], optionally CT_REMOTE_LIVE_JUMP and CT_REMOTE_LIVE_ADMIN)');
  process.exit(0);
}
const JUMP = process.env.CT_REMOTE_LIVE_JUMP || '';
const ADMIN = (process.env.CT_REMOTE_LIVE_ADMIN || '').trim().split(/\s+/).filter(Boolean);
const IFACE = process.env.CT_REMOTE_LIVE_IFACE || 'eth0';
const DROP_S = Math.max(10, Number(process.env.CT_REMOTE_LIVE_DROP_S) || 45);
const ONLY = new Set((process.env.CT_REMOTE_LIVE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean));
const REBOOT_CMD = process.env.CT_REMOTE_LIVE_REBOOT === '1' ? (process.env.CT_REMOTE_LIVE_ADMIN_REBOOT || '') : '';

const destMatch = /^(?:([^@]+)@)?([^:@]+)(?::(\d+))?$/.exec(DEST);
if (!destMatch) {
  console.error(`remote-ssh-live: CT_REMOTE_LIVE_DEST must be [user@]host[:port], got ${DEST}`);
  process.exit(2);
}
const [, DEST_USER = null, DEST_HOST, DEST_PORT = null] = destMatch;

// ── Isolation: a throwaway home for every app module ─────────────────────────

const REAL_HOME = os.homedir();
const RUN_ID = crypto.randomBytes(4).toString('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-remote-live-'));
os.homedir = () => TMP;

/** Electron, as far as the main-process modules under test need it. */
const ipcHandlers = new Map();
const ipcListeners = new Map();
const sentToRenderer = [];
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: (channel, payload) => sentToRenderer.push({ channel, payload, at: Date.now() }) },
};
const electronMock = {
  app: {
    isPackaged: false,
    getPath: () => path.join(TMP, 'electron'),
    getVersion: () => '0.0.0-live',
    getAppPath: () => path.resolve(__dirname, '..'),
    on() {}, once() {}, whenReady: () => Promise.resolve(),
  },
  ipcMain: {
    handle: (channel, fn) => ipcHandlers.set(channel, fn),
    on: (channel, fn) => ipcListeners.set(channel, fn),
    removeHandler: (channel) => ipcHandlers.delete(channel),
  },
  BrowserWindow: { getAllWindows: () => [fakeWindow], fromWebContents: () => fakeWindow },
  powerMonitor: new EventEmitter(),
  dialog: {}, shell: {}, Notification: function Notification() {},
};
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return electronMock;
  return originalLoad.call(this, request, parent, isMain);
};

const ROOT = path.resolve(__dirname, '..');
const req = (p) => require(path.join(ROOT, p));

const sshCommand = req('src/main/utils/sshCommand');
const remoteShell = req('src/shared/remote-shell');
const remotePathLib = req('src/shared/remote-path');
const { q } = remoteShell;
const { SshLane } = req('src/main/utils/sshChannel');
const svc = req('src/main/services/SshHostService');
const { SshHostService, validateProfile } = svc;
const { createRemoteFs, PUT_LIMIT } = req('src/main/utils/remoteFs');

const DATA_DIR = path.join(TMP, '.claude-terminal');
fs.mkdirSync(DATA_DIR, { recursive: true });
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

// ── Reporting ────────────────────────────────────────────────────────────────

const results = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
function log(...args) { console.log(`[${stamp()}]`, ...args); }

class Skip extends Error {}
function skip(message) { throw new Skip(message); }
function check(condition, message) {
  if (!condition) throw new Error(message);
}
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** The groups every other one builds on: the profile, the known_hosts and the connection. */
const REQUIRED_GROUPS = new Set(['discovery', 'hostkeys', 'connect']);

function groupEnabled(group) {
  return ONLY.size === 0 || ONLY.has(group) || REQUIRED_GROUPS.has(group);
}

async function scenario(group, name, fn, { timeoutMs = 120000 } = {}) {
  if (!groupEnabled(group)) return;
  const started = Date.now();
  let timer;
  try {
    const detail = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs); }),
    ]);
    results.push({ group, name, result: 'pass', detail: detail || '', ms: Date.now() - started });
    log(`PASS ${group} / ${name}${detail ? ` - ${detail}` : ''}`);
  } catch (e) {
    if (e instanceof Skip) {
      results.push({ group, name, result: 'skip', detail: e.message, ms: Date.now() - started });
      log(`SKIP ${group} / ${name} - ${e.message}`);
    } else {
      results.push({ group, name, result: 'fail', detail: e && e.stack ? e.stack : String(e), ms: Date.now() - started });
      log(`FAIL ${group} / ${name} - ${e && e.stack ? e.stack : e}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ── Local processes ──────────────────────────────────────────────────────────

/** PIDs of running ssh client processes on this machine. */
function localSshPids() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ssh.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      return new Set(out.split(/\r?\n/).map((l) => l.split('","')[1]).filter((p) => p && /^\d+$/.test(p)).map(Number));
    }
    const out = execFileSync('ps', ['-eo', 'pid=,comm='], { encoding: 'utf8' });
    return new Set(out.split('\n').map((l) => l.trim().split(/\s+/)).filter(([, c]) => c === 'ssh').map(([p]) => Number(p)));
  } catch {
    return new Set();
  }
}

// ── Admin access to the host (root, out of band) ─────────────────────────────

let SSH_BIN = null;

/** Run a shell script as root on the host through CT_REMOTE_LIVE_ADMIN. */
function admin(script, { timeoutMs = 60000, allowFail = false } = {}) {
  if (ADMIN.length === 0) skip('CT_REMOTE_LIVE_ADMIN is not set');
  const [first, ...rest] = ADMIN;
  const command = /^ssh(\.exe)?$/i.test(first) && SSH_BIN ? SSH_BIN : first;
  const args = [...(/^ssh(\.exe)?$/i.test(first) ? ['-o', 'BatchMode=yes'] : []), ...rest, 'sh', '-c', q(script)];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !allowFail) reject(new Error(`admin script failed (${code}): ${err.trim() || out.trim()}`));
      else resolve({ code, out, err });
    });
  });
}

function hasAdmin() { return ADMIN.length > 0; }

/** Whether the user's own known_hosts has an entry for the destination (`ssh-keygen -F` exits 1 when not). */
function userKnowsHost() {
  const file = path.join(REAL_HOME, '.ssh', 'known_hosts');
  if (!fs.existsSync(file) || !SSH_BIN) return false;
  const keygen = path.join(path.dirname(SSH_BIN), process.platform === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen');
  const name = DEST_PORT && DEST_PORT !== '22' ? `[${DEST_HOST}]:${DEST_PORT}` : DEST_HOST;
  try {
    return execFileSync(keygen, ['-F', name, '-f', file], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
  } catch {
    return false;
  }
}

// ── Profiles and the launcher ────────────────────────────────────────────────

const KNOWN_HOSTS = path.join(TMP, 'known_hosts');
const KNOWN_HOSTS_EMPTY = path.join(TMP, 'known_hosts.empty');
const KNOWN_HOSTS_WRONG = path.join(TMP, 'known_hosts.wrong');
fs.writeFileSync(KNOWN_HOSTS_EMPTY, '');

/** ssh option values take forward slashes on every platform. */
const optPath = (p) => p.replace(/\\/g, '/');

let knownHostsMode = 'user'; // 'user' | 'dedicated' | 'empty' | 'wrong'
function launcherPrefix() {
  const file = { dedicated: KNOWN_HOSTS, empty: KNOWN_HOSTS_EMPTY, wrong: KNOWN_HOSTS_WRONG }[knownHostsMode];
  if (!file) return [];
  // The global file too, so a system-wide entry cannot answer for the host.
  return ['-o', `UserKnownHostsFile=${optPath(file)}`, '-o', `GlobalKnownHostsFile=${optPath(KNOWN_HOSTS_EMPTY)}`];
}

/** The real binary SshHostService would find, with the harness's known_hosts choice. */
function installLauncher(service) {
  service.resolveLauncher = async () => (SSH_BIN ? { command: SSH_BIN, prefixArgs: launcherPrefix() } : null);
}

function profileInput(overrides = {}) {
  return {
    label: `live ${DEST}`,
    host: DEST_HOST,
    user: DEST_USER,
    port: DEST_PORT ? Number(DEST_PORT) : null,
    proxyJump: JUMP || null,
    ...overrides,
  };
}

function writeProjects(projects) {
  const tmp = `${PROJECTS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ projects, folders: [], rootOrder: projects.map((p) => p.id) }, null, 2));
  fs.renameSync(tmp, PROJECTS_FILE);
}

function remoteProject(id, profileId, posix) {
  return {
    id,
    name: path.posix.basename(posix),
    type: 'general',
    path: remotePathLib.format(profileId, posix),
    remote: { profileId, path: posix, hostLabel: DEST },
  };
}

// ── State shared across groups ───────────────────────────────────────────────

const ctx = {
  profile: null,      // the main profile
  caps: null,         // its handshake capabilities
  home: null,         // remote $HOME
  base: null,         // remote work directory for this run
  extraUsers: [],     // users the harness created on the host
  statusLog: [],      // [{ at, state, detail }]
};

function run(script, opts = {}) {
  return svc.exec(ctx.profile.id, script, { timeoutMs: 30000, ...opts });
}
async function runText(script, opts = {}) {
  const res = await run(script, opts);
  if (!res.ok) throw new Error(`remote script failed (${res.reason || res.code}): ${res.stderr ? res.stderr.toString('utf8').trim() : ''}\n  script: ${script}`);
  return res.stdout.toString('utf8');
}

module.exports = {}; // keeps eslint's sourceType detection quiet for a .cjs script

// ── Groups ───────────────────────────────────────────────────────────────────

async function groupDiscovery() {
  await scenario('discovery', 'ssh binary discovery', async () => {
    SSH_BIN = await sshCommand.findSshBinary();
    check(SSH_BIN, 'no ssh binary found');
    if (process.platform === 'win32') {
      const builtin = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
      if (fs.existsSync(builtin)) eq(SSH_BIN.toLowerCase(), builtin.toLowerCase(), 'win32 picks the built-in OpenSSH first');
    }
    const version = execFileSync(SSH_BIN, ['-V'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
    return `${SSH_BIN} (${version || 'version on stderr'})`;
  });
  if (!SSH_BIN) {
    try { SSH_BIN = await sshCommand.findSshBinary(); } catch { /* reported above */ }
  }
  if (!SSH_BIN) throw new Error('Cannot continue without an ssh binary');

  await scenario('discovery', 'profile validation (good, proxyJump, refusals)', async () => {
    const good = validateProfile(profileInput());
    eq(good.host, DEST_HOST, 'host kept');
    if (JUMP) eq(good.proxyJump, JUMP, 'proxyJump kept');
    const refusals = [
      [{ ...profileInput(), ProxyCommand: 'calc.exe' }, 'unknown field'],
      [profileInput({ host: '-oProxyCommand=calc' }), 'host starting with -'],
      [profileInput({ proxyJump: '-oProxyCommand=calc' }), 'jump starting with -'],
      [profileInput({ proxyJump: 'a@b,-c' }), 'second jump starting with -'],
      [profileInput({ host: 'a b' }), 'space in host'],
      [profileInput({ user: 'x;id' }), 'shell metacharacter in user'],
      [profileInput({ port: 70000 }), 'port out of range'],
      [profileInput({ identityFile: path.join(TMP, 'nope') }), 'identity file that does not exist'],
      [profileInput({ remoteClaudePath: 'claude' }), 'relative remoteClaudePath'],
    ];
    for (const [input, why] of refusals) {
      let threw = false;
      try { validateProfile(input); } catch (e) { threw = e.code === 'INVALID_PROFILE'; }
      check(threw, `not refused: ${why}`);
    }
    return `${refusals.length} refusals`;
  });

  await scenario('discovery', 'profile store save, update, .bak, reload', async () => {
    installLauncher(svc);
    const saved = await svc.saveProfile(profileInput());
    check(remotePathLib.isValidProfileId(saved.id), 'profile id');
    const file = path.join(DATA_DIR, 'remote-hosts.json');
    check(fs.existsSync(file), 'remote-hosts.json written in the temporary home');
    const updated = await svc.saveProfile({ ...profileInput({ label: 'renamed' }), id: saved.id });
    eq(updated.label, 'renamed', 'label updated');
    check(fs.existsSync(`${file}.bak`), '.bak written on the second save');
    const listed = await svc.listProfiles();
    eq(listed.length, 1, 'one profile');
    const again = await svc.saveProfile({ ...profileInput(), id: saved.id });
    ctx.profile = again;
    // Settings must never hold any of it.
    check(!fs.existsSync(path.join(DATA_DIR, 'settings.json')), 'settings.json untouched');
    return `profile ${again.id}`;
  });

  await scenario('discovery', 'ssh argv (channel, verify)', async () => {
    const args = sshCommand.channelArgs(ctx.profile, { platform: process.platform });
    const dd = args.indexOf('--');
    check(dd > 0 && args[dd + 1] === DEST_HOST, '`--` right before the destination');
    check(args.includes('BatchMode=yes'), 'BatchMode on the channel');
    check(!args.some((a) => /StrictHostKeyChecking=(no|accept-new)/i.test(a)), 'no relaxed host key checking');
    check(!args.some((a) => /UserKnownHostsFile/i.test(a)), 'known_hosts never redirected by the product');
    if (JUMP) check(args[args.indexOf('-J') + 1] === JUMP, 'jump passed with -J');
    if (process.platform === 'win32') check(!args.some((a) => /ControlMaster/.test(a)), 'no ControlMaster on win32');
    const verify = await svc.verifyCommand(ctx.profile.id);
    check(verify.args.includes('StrictHostKeyChecking=ask'), 'verify asks');
    check(!verify.args.includes('BatchMode=yes'), 'verify is interactive');
    eq(verify.args[verify.args.length - 1], 'exit', 'verify runs exit');
    return args.filter((a) => a !== '-o').join(' ');
  });

  await scenario('discovery', 'ssh -G resolves an ssh_config alias', async () => {
    if (typeof svc.resolveAlias !== 'function') skip('SshHostService has no alias resolution');
    const config = path.join(TMP, 'ssh_config');
    const lines = [`Host ct-live-alias`, `  HostName ${DEST_HOST}`];
    if (DEST_USER) lines.push(`  User ${DEST_USER}`);
    if (DEST_PORT) lines.push(`  Port ${DEST_PORT}`);
    if (JUMP) lines.push(`  ProxyJump ${JUMP}`);
    fs.writeFileSync(config, lines.join('\n') + '\n');
    const service = new SshHostService({ dataDir: path.join(TMP, 'alias-store'), broadcast: () => {} });
    service.resolveLauncher = async () => ({ command: SSH_BIN, prefixArgs: ['-F', optPath(config), ...launcherPrefix()] });
    const profile = await service.saveProfile({ sshConfigAlias: 'ct-live-alias' });
    const resolved = await service.resolveAlias(profile.id);
    eq(resolved.hostname, DEST_HOST, 'alias host name');
    if (DEST_USER) eq(resolved.user, DEST_USER, 'alias user');
    eq(resolved.port, DEST_PORT ? Number(DEST_PORT) : 22, 'alias port');
    // ssh -G writes an IP literal of a jump host in brackets.
    if (JUMP) eq(String(resolved.proxyJump).replace(/\[([^\]]+)\]/g, '$1'), JUMP, 'alias jump');
    service.disposeAll();
    return resolved.display;
  });
}

async function groupHostKeys() {
  if (!hasAdmin()) {
    await scenario('hostkeys', 'host key states', () => skip('needs CT_REMOTE_LIVE_ADMIN to read the host keys'));
    return;
  }
  // The host's own public keys, read out of band, are what the dedicated
  // known_hosts trusts.
  const keyHost = DEST_PORT && DEST_PORT !== '22' ? `[${DEST_HOST}]:${DEST_PORT}` : DEST_HOST;
  const { out } = await admin('cat /etc/ssh/ssh_host_*_key.pub');
  const keys = out.split('\n').map((l) => l.trim()).filter((l) => /^(ssh-|ecdsa-)/.test(l)).map((l) => l.split(/\s+/).slice(0, 2).join(' '));
  if (keys.length === 0) throw new Error('no host keys read from the host');
  fs.writeFileSync(KNOWN_HOSTS, keys.map((k) => `${keyHost} ${k}`).join('\n') + '\n');
  // A wrong key of every type the host offers, so ssh meets a mismatch rather than an unknown type.
  const wrong = keys.map((k) => {
    const [type, blob] = k.split(' ');
    const bytes = Buffer.from(blob, 'base64');
    // Flip bytes of the key material at the end, keeping the type header valid.
    for (let i = bytes.length - 8; i < bytes.length; i++) bytes[i] ^= 0x5a;
    return `${keyHost} ${type} ${bytes.toString('base64')}`;
  });
  fs.writeFileSync(KNOWN_HOSTS_WRONG, wrong.join('\n') + '\n');

  const userKnownHosts = path.join(REAL_HOME, '.ssh', 'known_hosts');
  const userKnownHash = () => (fs.existsSync(userKnownHosts) ? crypto.createHash('sha256').update(fs.readFileSync(userKnownHosts)).digest('hex') : 'absent');
  const before = userKnownHash();

  const expectStopped = async (mode, expectedState) => {
    knownHostsMode = mode;
    const service = new SshHostService({ dataDir: path.join(TMP, `hk-${mode}`), broadcast: () => {}, backoffMs: [200] });
    installLauncher(service);
    if (mode === 'user') service.resolveLauncher = null; // the product's own launcher, nothing injected
    const profile = await service.saveProfile(profileInput());
    const states = [];
    service.on('status', (s) => states.push(s.state));
    const status = await service.connect(profile.id);
    await wait(1500); // a retry would have fired by now
    const host = service.hosts.get(profile.id);
    service.disposeAll();
    eq(status.state, expectedState, `state with ${mode} known_hosts`);
    check(!host.retryTimer, 'no retry scheduled');
    check(!states.includes('reconnecting'), `never reconnecting (${states.join(' > ')})`);
    // A read fails fast, it does not reconnect the host.
    return `${states.join(' > ')}; ${String(status.detail && status.detail.stderr || '').trim().split('\n').pop()}`;
  };

  await scenario('hostkeys', 'unknown key through the product launcher and the user known_hosts', async () => {
    if (userKnowsHost()) skip(`the user's known_hosts already trusts ${DEST_HOST}`);
    return expectStopped('user', 'hostKeyUnknown');
  });
  await scenario('hostkeys', 'unknown key with an empty known_hosts', () => expectStopped('empty', 'hostKeyUnknown'));
  await scenario('hostkeys', 'changed key is blocked', () => expectStopped('wrong', 'hostKeyChanged'));
  await scenario('hostkeys', 'user known_hosts never written', async () => {
    eq(userKnownHash(), before, 'user known_hosts hash');
  });
  knownHostsMode = 'dedicated';
}

async function groupConnect() {
  await scenario('connect', 'connect and handshake', async () => {
    if (!hasAdmin()) knownHostsMode = 'user';
    svc.on('status', (s) => ctx.statusLog.push({ at: Date.now(), state: s.state, detail: s.detail }));
    const t0 = Date.now();
    const status = await svc.connect(ctx.profile.id);
    eq(status.state, 'connected', `state (${JSON.stringify(status.detail)})`);
    const caps = status.capabilities;
    ctx.caps = caps;
    ctx.home = caps.home;
    check(caps.os === 'Linux' || caps.os === 'Darwin' || /BSD/.test(caps.os), `POSIX os (${caps.os})`);
    check(caps.home && caps.home.startsWith('/'), 'home');
    check(caps.shell, 'login shell');
    check(caps.loginPath, 'login PATH captured');
    check(/(^|:)\/usr\/bin(:|$)/.test(caps.path), 'PATH contains /usr/bin');
    check(caps.git && /^git version/.test(caps.git), 'git found');
    check(caps.base64, 'base64 decoder found');
    return `${Date.now() - t0} ms; os=${caps.os} home=${caps.home} shell=${caps.shell} claude=${caps.claude || '(missing)'} tools=${caps.tools.join(',')}`;
  });
  if (!ctx.caps) throw new Error('Cannot continue without a connection');

  await scenario('connect', 'claude reported missing, not as a failure', async () => {
    if (ctx.caps.claude) skip(`claude is installed on the host (${ctx.caps.claude})`);
    eq(ctx.caps.claudeVersion, '', 'no version for a missing CLI');
  });

  await scenario('connect', '/bin/sh is the driver shell (dash on Debian)', async () => {
    // $$ in a request is the driver itself.
    const out = (await runText('readlink -f /bin/sh; readlink /proc/$$/exe 2>/dev/null || echo unknown; case $- in *m*) echo jobs;; *) echo nojobs;; esac')).trim().split('\n');
    return `/bin/sh -> ${out[0]}, driver runs ${out[1]}, job control ${out[2]}`;
  });

  ctx.base = `${ctx.home}/ct-live-${RUN_ID}`;
  await scenario('connect', 'work directory created', async () => {
    await runText(`mkdir -p -- ${q(ctx.base)}`, { write: true });
    return ctx.base;
  });
}

async function groupChannel() {
  await scenario('channel', 'binary-safe output, all 256 byte values and NUL', async () => {
    const res = await run("i=0; while [ $i -lt 256 ]; do printf \"\\\\$(printf %o $i)\"; i=$((i+1)); done; printf 'tail'");
    check(res.ok, `request failed: ${res.reason || res.code}`);
    const expected = Buffer.concat([Buffer.from([...Array(256).keys()]), Buffer.from('tail')]);
    check(res.stdout.equals(expected), `bytes differ (${res.stdout.length} bytes)`);
    return `${res.stdout.length} bytes`;
  });

  await scenario('channel', 'stdout and stderr kept apart, exit codes', async () => {
    const res = await run("printf out; printf err >&2; exit 7");
    eq(res.code, 7, 'exit code');
    eq(res.stdout.toString(), 'out', 'stdout');
    eq(res.stderr.toString(), 'err', 'stderr');
  });

  await scenario('channel', 'large output over 1 MB with a raised maxBuffer', async () => {
    const t0 = Date.now();
    const res = await run('seq 1 400000', { maxBuffer: 8 * 1024 * 1024, timeoutMs: 60000 });
    check(res.ok, `request failed: ${res.reason || res.code}`);
    const expected = Array.from({ length: 400000 }, (_, i) => `${i + 1}\n`).join('');
    eq(res.stdout.length, Buffer.byteLength(expected), 'length');
    check(res.stdout.toString() === expected, 'content differs');
    return `${(res.stdout.length / 1048576).toFixed(2)} MB in ${Date.now() - t0} ms`;
  });

  await scenario('channel', 'output over maxBuffer fails cleanly, lane survives', async () => {
    const res = await run('seq 1 400000', { maxBuffer: 1024 * 1024 });
    eq(res.reason, 'maxbuffer', 'reason');
    const after = await runText('echo still-here');
    eq(after.trim(), 'still-here', 'next request on the lanes');
  });

  await scenario('channel', 'PUT writes below and above 256 KB, verified on the host', async () => {
    const rfs = createRemoteFs(svc.runner(ctx.profile.id));
    const out = [];
    for (const size of [0, 1, 1000, PUT_LIMIT - 1, PUT_LIMIT, PUT_LIMIT + 1, 3 * 1024 * 1024 + 17]) {
      const data = crypto.randomBytes(size);
      const file = `${ctx.base}/put-${size}.bin`;
      const t0 = Date.now();
      await rfs.writeFile(file, data);
      const remote = (await runText(`sha256sum -- ${q(file)} | cut -d' ' -f1; wc -c < ${q(file)}`)).trim().split('\n');
      eq(remote[0], crypto.createHash('sha256').update(data).digest('hex'), `sha256 of ${size} bytes`);
      eq(Number(remote[1]), size, `size of ${size} bytes`);
      const back = await rfs.readFile(file, { maxBytes: size + 10, oneShot: size > PUT_LIMIT });
      check(back.data.equals(data), `read back ${size} bytes`);
      out.push(`${size}:${Date.now() - t0}ms`);
    }
    return out.join(' ');
  }, { timeoutMs: 180000 });

  await scenario('channel', 'concurrency across lanes', async () => {
    const t0 = Date.now();
    const jobs = Array.from({ length: 9 }, (_, i) => runText(`sleep 1; echo ${i}`));
    const outs = await Promise.all(jobs);
    const elapsed = Date.now() - t0;
    outs.forEach((o, i) => eq(o.trim(), String(i), `answer ${i}`));
    const host = svc.hosts.get(ctx.profile.id);
    eq(host.lanes.length, 3, 'lanes opened');
    check(elapsed < 7000, `9 x 1 s over 3 lanes took ${elapsed} ms`);
    return `${elapsed} ms over ${host.lanes.length} lanes`;
  });

  await scenario('channel', 'cancel kills the remote process group', async () => {
    const marker = `ct-live-cancel-${RUN_ID}`;
    const controller = new AbortController();
    const pending = run(`sh -c 'exec sleep 31' ${marker}; sleep 32`, { signal: controller.signal });
    await wait(1500);
    const during = await runText(`pgrep -f -- ${q('sleep 31')} | wc -l`);
    controller.abort();
    const t0 = Date.now();
    const res = await pending;
    const tookMs = Date.now() - t0;
    eq(res.reason, 'cancelled', 'reason');
    check(tookMs < 3000, `cancel answered in ${tookMs} ms`);
    await wait(1000);
    const after = await runText(`pgrep -u "$(id -u)" -f -- ${q('sleep 3[12]')} | wc -l`);
    eq(Number(after.trim()), 0, 'sleeps left on the host');
    return `running before: ${during.trim()}, cancelled in ${tookMs} ms`;
  });

  await scenario('channel', 'timeout kills the remote process group', async () => {
    const t0 = Date.now();
    const res = await run('sleep 33', { timeoutMs: 2000 });
    eq(res.reason, 'timeout', 'reason');
    check(Date.now() - t0 < 4000, 'timed out on time');
    await wait(1000);
    const after = await runText(`pgrep -u "$(id -u)" -f -- ${q('sleep 33')} | wc -l`);
    eq(Number(after.trim()), 0, 'sleep left on the host');
  });

  await scenario('channel', 'quoting round trip through dash', async () => {
    const values = ["it's", 'a "b"', 'back\\slash', '$HOME `id` $(id)', 'star * ? [x]', 'ünïcødé 日本', '-n', '-- -e', 'tab-less;semi&amp|pipe', '~user', '!bang'];
    for (const value of values) {
      const out = await runText(`printf '%s' ${q(value)}`);
      eq(out, value, `round trip of ${value}`);
    }
    return `${values.length} values`;
  });
}

async function groupAuth() {
  await scenario('auth', 'a user without an authorized key ends in authFailed, no retry loop', async () => {
    const user = `ctnokey${RUN_ID.slice(0, 6)}`;
    await admin(`useradd -m -s /bin/bash ${q(user)}`);
    ctx.extraUsers.push(user);
    const service = new SshHostService({ dataDir: path.join(TMP, 'auth-store'), broadcast: () => {}, backoffMs: [200] });
    installLauncher(service);
    const created = [];
    const createLane = service.createLane;
    service.createLane = (opts) => { created.push(Date.now()); return createLane(opts); };
    const profile = await service.saveProfile(profileInput({ user }));
    const states = [];
    service.on('status', (s) => states.push(s.state));
    const status = await service.connect(profile.id);
    // Reads do not reconnect a host that stopped on an auth failure.
    const read = await service.exec(profile.id, 'echo hi', { timeoutMs: 3000 });
    await wait(3000);
    const tested = await service.testProfile(profile.id);
    service.disposeAll();
    eq(status.state, 'authFailed', 'state');
    eq(read.reason, 'disconnected', 'read on an authFailed host');
    eq(created.length, 2, 'lanes spawned (the connect, then the explicit profile test)');
    check(!states.includes('reconnecting'), `states ${states.join(' > ')}`);
    eq(tested.state, 'authFailed', 'profile test result');
    return `${states.join(' > ')}; ${String(status.detail.stderr || '').trim().split('\n').pop()}`;
  });
}

const ZSHRC_MARK = '# ct-remote-ssh-live: empty zshrc for the test run';

const FS_NAMES = [
  'plain.txt', 'a b.txt', "it's.txt", '"dq".txt', '$HOME.txt', '$(id).txt', '`id`.txt', 'back\\slash.txt',
  'ünïcødé-日本.txt', '-leading-dash.txt', '--double', 'semi;colon&amp|pipe.txt', 'star*?.txt', ' lead space.txt', 'trail space.txt ',
];

/** The real `ssh-fs` IPC handler, as the renderer reaches it. */
async function sshFs(request) {
  const handler = ipcHandlers.get('ssh-fs');
  const res = await handler({ sender: {} }, request);
  if (!res.success) {
    const error = new Error(res.error);
    error.code = res.code;
    error.reason = res.reason;
    throw error;
  }
  return res.value;
}

async function expectCode(promise, code, what) {
  try {
    await promise;
  } catch (e) {
    if (e.code === code) return;
    throw new Error(`${what}: expected ${code}, got ${e.code} (${e.message})`);
  }
  throw new Error(`${what}: expected ${code}, but it succeeded`);
}

async function groupFs() {
  const pid = ctx.profile.id;
  const proj = `${ctx.base}/proj`;
  const uri = (p) => remotePathLib.format(pid, p);
  ctx.projects = [
    remoteProject('p_live_home', pid, ctx.home),
    remoteProject('p_live_proj', pid, proj),
    remoteProject('p_live_repo', pid, `${ctx.base}/repo`),
  ];
  writeProjects(ctx.projects);
  req('src/main/ipc/ssh.ipc.js').registerSshHandlers();
  await runText(`mkdir -p -- ${q(proj)}`, { write: true });

  await scenario('fs', 'write, stat, readdir, read, rename, copy, rm with hostile names', async () => {
    for (const name of FS_NAMES) {
      const p = `${proj}/${name}`;
      const body = `content of ${name}\nsecond line ${RUN_ID}\n`;
      await sshFs({ op: 'writeFile', path: uri(p), data: body });
      const st = await sshFs({ op: 'stat', path: uri(p) });
      check(st.isFile && st.size === Buffer.byteLength(body), `stat of ${name}: ${JSON.stringify(st)}`);
      const read = await sshFs({ op: 'readFile', path: uri(p) });
      eq(read.data, body, `content of ${name}`);
      await sshFs({ op: 'rename', from: uri(p), to: uri(`${p}.moved`) });
      await sshFs({ op: 'copy', from: uri(`${p}.moved`), to: uri(p) });
      await sshFs({ op: 'rm', path: uri(`${p}.moved`) });
    }
    const listing = await sshFs({ op: 'readdir', path: uri(proj) });
    const names = new Set(listing.map((e) => e.name));
    for (const name of FS_NAMES) check(names.has(name), `readdir lists ${JSON.stringify(name)}`);
    check(![...names].some((n) => n.endsWith('.moved')), 'renamed copies removed');
    const onHost = (await runText(`cd -- ${q(proj)} && ls -A | wc -l`)).trim();
    eq(Number(onHost), FS_NAMES.length, 'files on the host');
    return `${FS_NAMES.length} names`;
  });

  await scenario('fs', 'mkdir, nested rm, listFiles and grep', async () => {
    const dir = `${proj}/dir with space/sub 'q'/$x`;
    await sshFs({ op: 'mkdir', path: uri(dir) });
    await sshFs({ op: 'writeFile', path: uri(`${dir}/deep.txt`), data: `needle-${RUN_ID} deep\n` });
    const files = await sshFs({ op: 'listFiles', path: uri(proj) });
    check(files.files.includes("dir with space/sub 'q'/$x/deep.txt"), `listFiles: ${files.files.slice(0, 5).join(', ')}`);
    for (const name of FS_NAMES) check(files.files.includes(name), `listFiles has ${JSON.stringify(name)}`);
    const grep = await sshFs({ op: 'grep', path: uri(proj), pattern: `NEEDLE-${RUN_ID}` });
    eq(grep.matches.length, 1, 'case-insensitive grep matches');
    eq(grep.matches[0].file, "dir with space/sub 'q'/$x/deep.txt", 'grep file');
    const grepAll = await sshFs({ op: 'grep', path: uri(proj), pattern: `second line ${RUN_ID}` });
    eq(grepAll.matches.length, FS_NAMES.length, 'grep over the hostile names');
    await sshFs({ op: 'rm', path: uri(`${proj}/dir with space`), recursive: true });
    await expectCode(sshFs({ op: 'stat', path: uri(`${proj}/dir with space`) }), 'ENOENT', 'removed directory');
  });

  await scenario('fs', 'binary read and write in base64, caps, media cache', async () => {
    const data = crypto.randomBytes(300 * 1024);
    await sshFs({ op: 'writeFile', path: uri(`${proj}/blob.png`), data: data.toString('base64'), encoding: 'base64' });
    const back = await sshFs({ op: 'readFile', path: uri(`${proj}/blob.png`), encoding: 'base64', maxBytes: 1024 * 1024 });
    check(Buffer.from(back.data, 'base64').equals(data), 'base64 round trip');
    const capped = await sshFs({ op: 'readFile', path: uri(`${proj}/blob.png`), maxBytes: 1000 });
    check(capped.truncated && capped.size === data.length, 'a read over its cap says it was cut');
    const media = await sshFs({ op: 'cacheMedia', path: uri(`${proj}/blob.png`) });
    check(fs.readFileSync(media.localPath).equals(data), 'cached media is byte-exact');
    check(media.localPath.startsWith(TMP), 'media cache under the temporary home');
    const again = await sshFs({ op: 'cacheMedia', path: uri(`${proj}/blob.png`) });
    check(again.cached, 'second preview served from the cache');
  });

  await scenario('fs', 'symlink escapes refused, reads through a symlinked dir allowed', async () => {
    await runText([
      `cd -- ${q(proj)}`,
      'ln -s /etc escape',
      'ln -s "$HOME/.ssh/authorized_keys" keylink',
      'ln -s "$HOME/.ssh" sshdir',
      `ln -s /tmp/ct-live-out-${RUN_ID} outfile`,
    ].join(' && '), { write: true });
    await expectCode(sshFs({ op: 'writeFile', path: uri(`${proj}/escape/ct-live.txt`), data: 'x' }), 'REMOTE_PATH_OUTSIDE_PROJECT', 'write through a symlinked directory');
    await expectCode(sshFs({ op: 'writeFile', path: uri(`${proj}/outfile`), data: 'x' }), 'REMOTE_PATH_OUTSIDE_PROJECT', 'write through a symlinked file');
    await expectCode(sshFs({ op: 'mkdir', path: uri(`${proj}/escape/newdir`) }), 'REMOTE_PATH_OUTSIDE_PROJECT', 'mkdir through a symlinked directory');
    await expectCode(sshFs({ op: 'readFile', path: uri(`${proj}/keylink`) }), 'REMOTE_PATH_BLOCKED', 'read of a link to ~/.ssh');
    await expectCode(sshFs({ op: 'readFile', path: uri(`${proj}/sshdir/authorized_keys`) }), 'REMOTE_PATH_BLOCKED', 'read through a link to ~/.ssh');
    const hostname = await sshFs({ op: 'readFile', path: uri(`${proj}/escape/hostname`) });
    check(hostname.data.trim().length > 0, 'read through a symlinked directory outside the project');
    const outside = (await runText(`[ -e /tmp/ct-live-out-${RUN_ID} ] && echo exists || echo absent`)).trim();
    eq(outside, 'absent', 'nothing written outside the project');
  });

  await scenario('fs', 'blocklist and containment', async () => {
    await expectCode(sshFs({ op: 'readFile', path: uri(`${ctx.home}/.ssh/authorized_keys`) }), 'REMOTE_PATH_BLOCKED', 'read ~/.ssh inside a project');
    await expectCode(sshFs({ op: 'stat', path: uri(`${ctx.home}/.ssh`) }), 'REMOTE_PATH_BLOCKED', 'stat ~/.ssh');
    await expectCode(sshFs({ op: 'writeFile', path: uri(`${ctx.home}/.bashrc`), data: 'x' }), 'REMOTE_PATH_BLOCKED', 'write ~/.bashrc');
    await expectCode(sshFs({ op: 'writeFile', path: uri(`${ctx.home}/.claude/.credentials.json`), data: '{}' }), 'REMOTE_PATH_BLOCKED', 'write the CLI credentials');
    await expectCode(sshFs({ op: 'readFile', path: uri('/etc/passwd') }), 'REMOTE_PATH_NOT_IN_PROJECT', 'read outside every project');
    let threw = false;
    try { await sshFs({ op: 'readFile', path: `ssh-remote://${pid}${proj}/../../../../etc/passwd` }); } catch { threw = true; }
    check(threw, '.. escape refused');
    await expectCode(sshFs({ op: 'rm', path: uri(proj), recursive: true }), 'EPERM', 'remove a project root');
    await expectCode(sshFs({ op: 'readFile', path: remotePathLib.format('zzzz9999', '/etc/hostname') }), 'REMOTE_PROFILE_UNKNOWN', 'unknown profile');
    const bashrc = (await runText('sha256sum "$HOME/.bashrc" | cut -c1-16')).trim();
    return `~/.bashrc untouched (${bashrc})`;
  });

  await scenario('fs', 'Open Remote Project browser: browse, mkdir, init', async () => {
    const browse = await ipcHandlers.get('ssh-browse')({}, { profileId: pid, path: '' });
    check(browse.success, `browse home: ${browse.error}`);
    eq(browse.path, ctx.home, 'browse starts at the canonical home');
    check(browse.entries.some((e) => e.name === path.posix.basename(ctx.base)), 'work directory listed');
    const made = await ipcHandlers.get('ssh-mkdir')({}, { profileId: pid, path: `${ctx.base}/new project` });
    check(made.success, `mkdir: ${made.error}`);
    const init = await ipcHandlers.get('ssh-init')({}, { profileId: pid, path: `${ctx.base}/new project` });
    check(init.success && /Initialized empty Git repository/.test(init.output), `init: ${init.error || init.output}`);
    const blocked = await ipcHandlers.get('ssh-mkdir')({}, { profileId: pid, path: `${ctx.home}/.ssh/ct-live` });
    check(!blocked.success && blocked.code === 'REMOTE_PATH_BLOCKED', 'mkdir in ~/.ssh refused');
  });
}

async function groupGit() {
  const pid = ctx.profile.id;
  const repo = `${ctx.base}/repo`;
  const bare = `${ctx.base}/bare.git`;
  const uri = remotePathLib.format(pid, repo);
  const git = req('src/main/utils/git.js');
  const ok = (r, what) => { check(r && (r.success || r.ok), `${what}: ${JSON.stringify(r && (r.error || r))}`); return r; };

  await scenario('git', 'init, identity, status, stage, multi-line commit', async () => {
    await runText(`mkdir -p -- ${q(repo)} && git init -q --bare ${q(bare)}`, { write: true });
    const init = await ipcHandlers.get('ssh-init')({}, { profileId: pid, path: repo });
    ok(init, 'init');
    ok(await git.execGitResult(uri, ['config', 'user.name', 'CT Live']), 'user.name');
    ok(await git.execGitResult(uri, ['config', 'user.email', 'ct-live@example.invalid']), 'user.email');
    ok(await git.execGitResult(uri, ['checkout', '-q', '-b', 'main']), 'main branch');
    await sshFs({ op: 'writeFile', path: remotePathLib.format(pid, `${repo}/a.js`), data: 'const a = 1; // TODO first todo\n' });
    await sshFs({ op: 'mkdir', path: remotePathLib.format(pid, `${repo}/src`) });
    await sshFs({ op: 'writeFile', path: remotePathLib.format(pid, `${repo}/src/app.py`), data: '# FIXME second\nprint("x")\n' });
    await sshFs({ op: 'writeFile', path: remotePathLib.format(pid, `${repo}/it's a file.txt`), data: 'quoted\n' });
    const status = await git.getGitStatusDetailed(uri);
    check(status && status.success !== false, `status: ${JSON.stringify(status)}`);
    const paths = JSON.stringify(status);
    check(paths.includes('a.js') && paths.includes("it's a file.txt"), `untracked listed: ${paths.slice(0, 300)}`);
    ok(await git.gitStageFiles(uri, ['a.js', 'src/app.py', "it's a file.txt"]), 'stage');
    const message = `Add the first files\n\nBody line with "quotes" and 'apostrophes'\n\tTabbed line and $HOME stays literal`;
    ok(await git.gitCommit(uri, message), 'commit');
    const logged = await git.execGitResult(uri, ['log', '-1', '--format=%B']);
    eq(logged.output.trim(), message, 'commit message on the host');
    return status.files ? `${status.files.length} files in status` : 'ok';
  });

  await scenario('git', 'branch, diff, stash, log, blame', async () => {
    ok(await git.createBranch(uri, 'feature/live x'.replace(' ', '-')), 'create branch');
    const branches = await git.getBranches(uri);
    check(JSON.stringify(branches).includes('feature/live-x'), `branches: ${JSON.stringify(branches)}`);
    eq(await git.getCurrentBranch(uri), 'feature/live-x', 'current branch after create');
    ok(await git.checkoutBranch(uri, 'main'), 'checkout main');
    await sshFs({ op: 'writeFile', path: remotePathLib.format(pid, `${repo}/a.js`), data: 'const a = 2; // TODO first todo\n' });
    const diff = await git.getFileDiff(uri, 'a.js');
    check(/-const a = 1/.test(diff) && /\+const a = 2/.test(diff), `diff: ${diff}`);
    ok(await git.gitStashSave(uri, 'live stash'), 'stash save');
    const stashes = await git.execGitResult(uri, ['stash', 'list']);
    check(stashes.output.includes('live stash'), `stashes: ${JSON.stringify(stashes)}`);
    const shown = await git.stashShow(uri, 'stash@{0}');
    check(JSON.stringify(shown).includes('a.js'), `stash show: ${JSON.stringify(shown).slice(0, 200)}`);
    ok(await git.stashPop(uri, 'stash@{0}'), 'stash pop');
    ok(await git.gitStageFiles(uri, ['a.js']), 'stage a.js');
    ok(await git.gitCommit(uri, 'Bump a'), 'second commit');
    const history = await git.getCommitHistory(uri, { limit: 10 });
    check(Array.isArray(history) ? history.length === 2 : JSON.stringify(history).includes('Bump a'), `history: ${JSON.stringify(history).slice(0, 300)}`);
    const blame = await git.gitBlame(uri, 'a.js');
    eq(blame.length, 1, 'blame lines');
    eq(blame[0].summary, 'Bump a', 'blame summary');
    eq(blame[0].author, 'CT Live', 'blame author');
  });

  await scenario('git', 'push and pull against a bare repository on the host', async () => {
    ok(await git.addRemote(uri, 'origin', bare), 'add remote');
    ok(await git.gitPushBranch(uri, 'main'), 'push -u origin main');
    const heads = (await runText(`git --git-dir=${q(bare)} log --format=%s main`)).trim().split('\n');
    eq(heads[0], 'Bump a', 'bare repository head');
    // Someone else pushes; pull brings it in.
    const other = `${ctx.base}/other`;
    await runText(`git clone -q -b main ${q(bare)} ${q(other)} && cd -- ${q(other)} && git -c user.name=Other -c user.email=o@example.invalid commit -q --allow-empty -m 'From elsewhere' && git push -q origin main`, { write: true, timeoutMs: 60000 });
    const pulled = ok(await git.gitPull(uri), 'pull');
    const head = await git.execGitResult(uri, ['log', '-1', '--format=%s']);
    eq(head.output, 'From elsewhere', 'pulled commit');
    // The dashboard's ~18 git calls in one go, over the lane pool.
    const t0 = Date.now();
    const info = await git.getGitInfoFull(uri);
    check(info && info.isGitRepo !== false && JSON.stringify(info).includes('main'), `dashboard git info: ${JSON.stringify(info).slice(0, 300)}`);
    return `pull: ${String(pulled.output).split('\n')[0]}; dashboard git info in ${Date.now() - t0} ms`;
  });

  await scenario('git', 'clone into a new directory on the host (https)', async () => {
    const { cloneOnHost } = req('src/main/ipc/ssh.ipc.js');
    const target = `${ctx.base}/cloned hello`;
    const progress = [];
    const res = await cloneOnHost({ profileId: pid, url: 'https://github.com/octocat/Hello-World.git', path: target, progress: (p) => progress.push(p.message) });
    if (!res.success && /Could not resolve host|unable to access/i.test(res.error || '')) skip(`the host has no internet access: ${res.error}`);
    check(res.success, `clone: ${res.error}`);
    const readme = (await runText(`ls -- ${q(target)}`)).trim();
    check(/README/.test(readme), `cloned files: ${readme}`);
    const again = await cloneOnHost({ profileId: pid, url: 'https://github.com/octocat/Hello-World.git', path: target });
    check(!again.success && /already exists/.test(again.error), `second clone refused: ${again.error}`);
    const local = await cloneOnHost({ profileId: pid, url: bare, path: `${ctx.base}/from-bare` });
    check(!local.success, 'a local-path URL is outside the clone allowlist');
    return `${progress.length} progress lines`;
  }, { timeoutMs: 180000 });

  await scenario('git', 'worktree create, list, resolve, remove', async () => {
    const wt = remotePathLib.format(pid, `${ctx.base}/repo-wt`);
    ok(await git.createWorktree(uri, wt, { newBranch: 'wt-branch' }), 'worktree add');
    const list = await git.getWorktrees(uri);
    check(JSON.stringify(list).includes('repo-wt'), `worktrees: ${JSON.stringify(list)}`);
    // A path inside the worktree resolves to the project of the same repository.
    const inside = await git.getCurrentBranch(wt);
    eq(inside, 'wt-branch', 'branch read inside the worktree');
    const detected = await git.detectWorktree(wt);
    check(detected && detected.isWorktree, `detectWorktree: ${JSON.stringify(detected)}`);
    ok(await git.removeWorktree(uri, wt), 'worktree remove');
    const after = (await runText(`[ -e ${q(`${ctx.base}/repo-wt`)} ] && echo exists || echo gone`)).trim();
    eq(after, 'gone', 'worktree directory removed');
  });

  await scenario('git', 'TODO scan and project stats through their IPC handlers', async () => {
    req('src/main/ipc/project.ipc.js').registerProjectHandlers?.();
    let todos;
    const scan = ipcHandlers.get('scan-todos');
    if (scan) todos = await scan({}, uri);
    else todos = (await git.grepTodoCandidates(uri, { extensions: ['.js', '.py'], ignoreDirs: ['node_modules'] })).lines;
    const text = JSON.stringify(todos);
    check(text.includes('first todo') && text.includes('second'), `todos: ${text}`);
    const stats = await git.getProjectStats(uri);
    check(stats && (stats.files > 0 || (stats.code && stats.code.files > 0) || JSON.stringify(stats).includes('.js')), `stats: ${JSON.stringify(stats).slice(0, 300)}`);
    return `${Array.isArray(todos) ? todos.length : '?'} todos via ${scan ? 'IPC' : 'git.js'}; stats ${JSON.stringify(stats).slice(0, 120)}`;
  });

  await scenario('git', 'a missing directory and a path outside every project fail closed', async () => {
    const gone = await git.execGitResult(remotePathLib.format(pid, `${ctx.base}/repo/nope`), ['status']);
    eq(gone.reason, 'nodir', 'missing directory');
    const outside = await git.execGitResult(remotePathLib.format(pid, '/etc'), ['status']);
    eq(outside.reason, 'nodir', 'outside every project');
  });
}

async function groupSessions() {
  const pid = ctx.profile.id;
  const repo = `${ctx.base}/repo`;
  const uri = remotePathLib.format(pid, repo);
  const sessionDirs = req('src/shared/session-dirs.js');
  const claude = req('src/main/ipc/claude.ipc.js');

  await scenario('sessions', 'remote history listing, title, tail and delete', async () => {
    const dir = sessionDirs.getRemoteSessionsDir(repo, ctx.caps);
    check(dir && dir.startsWith(`${ctx.home}/.claude/projects/`), `sessions dir ${dir}`);
    const t0 = Date.parse('2026-01-02T10:00:00.000Z');
    const transcript = (sessionId, prompt, turns, title) => {
      const lines = [];
      let parent = null;
      const base = { cwd: repo, entrypoint: 'cli', gitBranch: 'main', isSidechain: false, sessionId, userType: 'external', version: '2.1.0' };
      lines.push({ type: 'queue-operation', operation: 'enqueue', sessionId, timestamp: new Date(t0).toISOString() });
      for (let i = 0; i < turns; i++) {
        const u = crypto.randomUUID();
        lines.push({ ...base, type: 'user', parentUuid: parent, uuid: u, timestamp: new Date(t0 + i * 60000).toISOString(), message: { role: 'user', content: i === 0 ? prompt : `dummy follow-up ${i}` } });
        const a = crypto.randomUUID();
        lines.push({ ...base, type: 'assistant', parentUuid: u, uuid: a, requestId: `req_${i}`, timestamp: new Date(t0 + i * 60000 + 5000).toISOString(), message: { id: `msg_${i}`, type: 'message', role: 'assistant', model: 'dummy-model', content: [{ type: 'text', text: `dummy answer ${i} ${'x'.repeat(200)}` }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } });
        parent = a;
      }
      if (title) lines.push({ type: 'ai-title', aiTitle: title, sessionId });
      return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    };
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const files = [
      [ids[0], transcript(ids[0], 'Dummy first prompt for the live harness', 3, 'Dummy title one')],
      [ids[1], transcript(ids[1], 'Another dummy prompt', 400, null)],
    ];
    const rfs = createRemoteFs(svc.runner(pid));
    await rfs.mkdir(dir);
    for (const [id, body] of files) await rfs.writeFile(`${dir}/${id}.jsonl`, Buffer.from(body));
    await runText(`touch -d '2026-01-02 10:00' ${q(`${dir}/${ids[0]}.jsonl`)}; touch -d '2026-01-03 10:00' ${q(`${dir}/${ids[1]}.jsonl`)}`, { write: true });

    const listing = await claude.getRemoteSessionsListing(uri);
    check(!listing.disconnected && !listing.error, `listing: ${JSON.stringify(listing).slice(0, 300)}`);
    eq(listing.sessions.length, 2, 'sessions listed');
    const first = listing.sessions.find((s) => s.sessionId === ids[0]);
    check(first, 'first session listed');
    eq(first.firstPrompt, 'Dummy first prompt for the live harness', 'first prompt');
    eq(first.title, 'Dummy title one', 'title from the tail');
    eq(first.cwd, uri, 'resumed where it lives');
    const bare = await claude.getClaudeSessions(uri);
    eq(bare.length, 2, 'getClaudeSessions answers the bare list');

    const history = await claude.loadSessionHistory(uri, ids[1], 20);
    const text = JSON.stringify(history);
    check(text.includes('dummy follow-up 399') && !text.includes('dummy follow-up 300 '), `tail-first history: ${text.slice(0, 200)}`);

    const deleted = await claude.deleteSession(uri, ids[0]);
    check(deleted === true || (deleted && deleted.success !== false), `delete: ${JSON.stringify(deleted)}`);
    const after = await claude.getRemoteSessionsListing(uri);
    eq(after.sessions.length, 1, 'one session left after delete');
    const bad = await claude.loadSessionHistory(uri, '../../etc/passwd', 20).catch((e) => e);
    check(bad instanceof Error || (bad && (bad.error || (Array.isArray(bad) && bad.length === 0) || (bad.messages && bad.messages.length === 0))), `a path-shaped session id is refused: ${JSON.stringify(bad).slice(0, 200)}`);
    await rfs.rm(`${ctx.home}/.claude`, { recursive: true });
    return `listed ${listing.sessions.length}, history ${Array.isArray(history) ? history.length : (history.messages || []).length} entries`;
  });
}

async function groupChat() {
  await scenario('chat', 'a chat on a host without claude fails with a clear "not installed"', async () => {
    if (ctx.caps.claude) skip(`claude is installed on the host (${ctx.caps.claude}); the authentication path needs a logged-out CLI`);
    const { prepareRemoteChat } = req('src/main/utils/sshClaudeSpawn.js');
    const uri = remotePathLib.format(ctx.profile.id, `${ctx.base}/repo`);
    let error = null;
    try { await prepareRemoteChat({ cwd: uri, projectId: 'p_live_repo' }); } catch (e) { error = e; }
    check(error, 'the chat start was refused');
    eq(error.code, 'CLAUDE_NOT_INSTALLED', `code (${error.message})`);
    check(error.message.includes(DEST_HOST), `the message names the host: ${error.message}`);
    let mismatch = null;
    try { await prepareRemoteChat({ cwd: uri, projectId: 'p_live_proj' }); } catch (e) { mismatch = e; }
    check(mismatch && /does not match/.test(mismatch.message), 'a project id that does not own the path is refused');
    return error.message;
  });
}

/** Processes of the remote user, minus the systemd user manager that logind keeps around. */
async function remoteUserProcesses(filter = '') {
  const user = ctx.caps.user || DEST_USER;
  const { out } = await admin(`ps -u ${q(user)} -o pid=,args= 2>/dev/null; :`);
  return out.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/systemd --user|\(sd-pam\)/.test(l))
    .filter((l) => !filter || l.includes(filter));
}

async function groupWatcher() {
  const pid = ctx.profile.id;
  const proj = `${ctx.base}/proj`;
  const { createRemoteDirPoller } = req('src/main/utils/remoteDirPoller.js');
  const { resolveTarget } = req('src/main/utils/projectTarget.js');
  const changes = [];
  const makePoller = () => createRemoteDirPoller({
    service: svc,
    authorize: async (u) => { const t = await resolveTarget(u); return { profileId: t.profileId, path: t.remotePath }; },
    isActive: () => true,
    emit: (batch) => changes.push(...batch.map((c) => ({ ...c, at: Date.now() }))),
  });
  const waitFor = async (pred, ms, what) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (pred()) return; await wait(100); }
    throw new Error(`timed out waiting for ${what}`);
  };

  await scenario('watcher', 'inotifywait reports adds and removes within a second', async () => {
    if (!ctx.caps.tools.includes('inotifywait')) skip('no inotifywait on the host');
    const poller = makePoller();
    await poller.watch(remotePathLib.format(pid, proj));
    await waitFor(() => poller._hosts.get(pid) && poller._hosts.get(pid).inotify, 5000, 'the watcher to start');
    await wait(1500);
    if (hasAdmin()) check((await remoteUserProcesses('inotifywait -m')).length >= 1, 'inotifywait running on the host');
    const t0 = Date.now();
    await runText(`touch -- ${q(`${proj}/watched new.txt`)}`, { write: true });
    await waitFor(() => changes.some((c) => c.type === 'add' && c.path.endsWith('/watched new.txt')), 5000, 'the add event');
    const addMs = changes.find((c) => c.type === 'add').at - t0;
    await runText(`rm -f -- ${q(`${proj}/watched new.txt`)}`, { write: true });
    await waitFor(() => changes.some((c) => c.type === 'remove' && c.path.endsWith('/watched new.txt')), 5000, 'the remove event');
    poller.dispose();
    await wait(3000);
    if (hasAdmin()) {
      const left = await remoteUserProcesses('inotifywait');
      eq(left.length, 0, `inotifywait left after dispose: ${left.join(' | ')}`);
      const cats = await remoteUserProcesses('cat');
      eq(cats.length, 0, `stdin watcher left after dispose: ${cats.join(' | ')}`);
    }
    return `add seen after ${addMs} ms`;
  });

  await scenario('watcher', 'plain polling without inotifywait', async () => {
    const poller = createRemoteDirPoller({
      service: svc,
      authorize: async (u) => { const t = await resolveTarget(u); return { profileId: t.profileId, path: t.remotePath }; },
      isActive: () => true,
      emit: (batch) => changes.push(...batch.map((c) => ({ ...c, at: Date.now() }))),
      intervalMs: 1000,
      useInotify: false,
    });
    changes.length = 0;
    await poller.watch(remotePathLib.format(pid, proj));
    await wait(1500);
    await runText(`mkdir -- ${q(`${proj}/polled dir`)}`, { write: true });
    await waitFor(() => changes.some((c) => c.type === 'add' && c.isDirectory && c.path.endsWith('/polled dir')), 5000, 'the polled add');
    poller.dispose();
  });

  await scenario('watcher', 'the watcher stops with the channel and leaves nothing on the host', async () => {
    if (!ctx.caps.tools.includes('inotifywait')) skip('no inotifywait on the host');
    if (!hasAdmin()) skip('needs CT_REMOTE_LIVE_ADMIN to list remote processes');
    const poller = makePoller();
    await poller.watch(remotePathLib.format(pid, proj));
    await waitFor(() => poller._hosts.get(pid) && poller._hosts.get(pid).inotify, 5000, 'the watcher to start');
    await wait(1500);
    check((await remoteUserProcesses('inotifywait -m')).length >= 1, 'inotifywait running');
    svc.disconnect(pid);
    await wait(3000);
    const left = await remoteUserProcesses('inotifywait');
    poller.dispose();
    eq(left.length, 0, `inotifywait left after disconnect: ${left.join(' | ')}`);
    const drivers = await remoteUserProcesses('/bin/sh -s');
    eq(drivers.length, 0, `drivers left after disconnect: ${drivers.join(' | ')}`);
    const status = await svc.connect(pid);
    eq(status.state, 'connected', 'reconnected after the check');
  });
}

async function groupPty() {
  const pid = ctx.profile.id;
  const proj = `${ctx.base}/proj`;
  let terminalService;
  try {
    terminalService = req('src/main/services/TerminalService.js');
    req('src/main/ipc/terminal.ipc.js').registerTerminalHandlers();
  } catch (e) {
    await scenario('pty', 'remote terminal tab', () => skip(`node-pty or the terminal service did not load: ${e.message}`));
    return;
  }
  terminalService.setMainWindow(fakeWindow);
  const output = (id) => sentToRenderer.filter((m) => m.channel === 'terminal-data' && m.payload && m.payload.id === id).map((m) => m.payload.data).join('');
  const eventFor = (channel, id) => sentToRenderer.find((m) => m.channel === channel && m.payload && m.payload.id === id);
  const waitFor = async (pred, ms, what) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (pred()) return; await wait(100); }
    throw new Error(`timed out waiting for ${what}`);
  };
  const open = async () => {
    const res = await ipcHandlers.get('terminal-create')({}, { cwd: remotePathLib.format(pid, proj), projectPath: remotePathLib.format(pid, proj), projectId: 'p_live_proj' });
    check(res && res.success, `terminal-create: ${JSON.stringify(res)}`);
    return res.id;
  };
  const type = (id, text) => ipcListeners.get('terminal-input')({}, { id, data: text });

  await scenario('pty', 'a shell tab runs in the project directory and exits normally', async () => {
    const id = await open();
    type(id, 'echo CT_LIVE_$((6*7)) "$PWD"\r');
    await waitFor(() => /CT_LIVE_42 \S+\/proj/.test(output(id)), 30000, 'the echo');
    type(id, 'exit\r');
    await waitFor(() => eventFor('terminal-exit', id) || eventFor('terminal-disconnected', id), 15000, 'the exit');
    check(eventFor('terminal-exit', id), `exited, not disconnected: ${JSON.stringify(eventFor('terminal-disconnected', id))}`);
    const tail = output(id).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim().split(/\r?\n/).pop();
    return `last line: ${tail}`;
  });

  await scenario('pty', 'a remote `exit 255` closes the tab instead of reconnecting it', async () => {
    const id = await open();
    type(id, 'echo ready-255\r');
    await waitFor(() => output(id).includes('ready-255'), 30000, 'the shell');
    type(id, 'exit 255\r');
    await waitFor(() => eventFor('terminal-exit', id) || eventFor('terminal-disconnected', id), 15000, 'the exit');
    const exit = eventFor('terminal-exit', id);
    check(exit, `closed as an exit: ${JSON.stringify(eventFor('terminal-disconnected', id))}`);
    eq(exit.payload.exitCode, 255, 'exit code');
    const lines = output(id).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim().split(/\r?\n/).filter(Boolean);
    return `ssh's last words: ${JSON.stringify(lines[lines.length - 1])}`;
  });

  ctx.openPty = open;
  ctx.ptyOutput = output;
  ctx.ptyEvent = eventFor;
}

/** Reconnect the shared service, so the next handshake sees the host as it is now. */
async function reconnectMain() {
  svc.disconnect(ctx.profile.id);
  const status = await svc.connect(ctx.profile.id);
  eq(status.state, 'connected', `reconnect (${JSON.stringify(status.detail)})`);
  ctx.caps = status.capabilities;
  return status.capabilities;
}

/** The checks every login shell must pass: handshake, a channel read, git, a terminal tab. */
async function shellSmoke(label) {
  const caps = await reconnectMain();
  check(caps.loginPath, `${label}: login PATH captured`);
  check(/(^|:)\/usr\/bin(:|$)/.test(caps.path), `${label}: PATH has /usr/bin (${caps.path})`);
  eq((await runText(`printf '%s' ${q("it's $HOME")}`)), "it's $HOME", `${label}: quoting through the login shell`);
  const git = req('src/main/utils/git.js');
  const branch = await git.getCurrentBranch(remotePathLib.format(ctx.profile.id, `${ctx.base}/repo`));
  check(branch === 'main' || branch === null, `${label}: git (${branch})`);
  let pty = '';
  if (ctx.openPty) {
    const id = await ctx.openPty();
    // Typed once the prompt is there and the output has settled.
    let seen = -1;
    for (let i = 0; i < 100 && (ctx.ptyOutput(id).length === 0 || ctx.ptyOutput(id).length !== seen); i++) {
      seen = ctx.ptyOutput(id).length;
      await wait(300);
    }
    ipcListeners.get('terminal-input')({}, { id, data: 'echo CT_LIVE_SHELL_$SHELL\r' });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !/CT_LIVE_SHELL_\/\S+/.test(ctx.ptyOutput(id))) await wait(200);
    const m = /CT_LIVE_SHELL_(\/\S+)/.exec(ctx.ptyOutput(id));
    check(m, `${label}: terminal tab answers: ${JSON.stringify(ctx.ptyOutput(id).slice(-300))}`);
    ipcListeners.get('terminal-input')({}, { id, data: 'exit\r' });
    const until = Date.now() + 15000;
    while (Date.now() < until && !ctx.ptyEvent('terminal-exit', id) && !ctx.ptyEvent('terminal-disconnected', id)) await wait(200);
    check(ctx.ptyEvent('terminal-exit', id), `${label}: terminal tab exits normally`);
    pty = `, tab shell ${m[1]}`;
  }
  return `shell=${caps.shell}${pty}`;
}

async function groupShells() {
  if (!hasAdmin()) {
    await scenario('shells', 'login shells and noisy rc files', () => skip('needs CT_REMOTE_LIVE_ADMIN'));
    return;
  }
  const user = ctx.caps.user || DEST_USER;
  const bak = `/root/ct-live-${RUN_ID}`;
  ctx.restoreShell = async () => {
    await admin(`chsh -s /bin/bash ${q(user)}; if [ -d ${q(bak)} ]; then cp -p ${q(`${bak}/.bashrc`)} ${q(`${bak}/.profile`)} ${q(`${ctx.home}/`)} && rm -rf ${q(bak)}; fi; if grep -qx ${q(ZSHRC_MARK)} ${q(`${ctx.home}/.zshrc`)} 2>/dev/null; then rm -f ${q(`${ctx.home}/.zshrc`)}; fi; :`);
  };

  await scenario('shells', 'noisy .bashrc and .profile, PATH from the login shell', async () => {
    await admin([
      `mkdir -p ${q(bak)}`,
      `cp -p ${q(`${ctx.home}/.bashrc`)} ${q(`${ctx.home}/.profile`)} ${q(`${bak}/`)}`,
      // Before Debian's "not interactive: return", so every ssh command sees it.
      `{ echo 'echo ct-live-rc-noise; echo ct-live-rc-noise >&2; printf "CT-READY-0000000000000000 1\\n"'; cat ${q(`${bak}/.bashrc`)}; } > ${q(`${ctx.home}/.bashrc`)}`,
      `{ cat ${q(`${bak}/.profile`)}; echo 'echo ct-live-profile-noise'; echo 'PATH="$HOME/ct-live-bin:$PATH"'; } > ${q(`${ctx.home}/.profile`)}`,
      `chown ${q(user)}: ${q(`${ctx.home}/.bashrc`)} ${q(`${ctx.home}/.profile`)}`,
    ].join(' && '));
    try {
      const out = await shellSmoke('bash with noise');
      check(ctx.caps.path.split(':').includes(`${ctx.home}/ct-live-bin`), `login PATH from .profile: ${ctx.caps.path}`);
      return out;
    } finally {
      await ctx.restoreShell();
    }
  });

  for (const shell of ['zsh', 'fish']) {
    await scenario('shells', `${shell} as the login shell`, async () => {
      await admin(`command -v ${shell} >/dev/null || { DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends ${shell} >/dev/null && apt-get clean; }`, { timeoutMs: 300000 });
      const { out } = await admin(`command -v ${shell}`);
      // A zsh without ~/.zshrc opens its interactive new-user wizard, which
      // would eat what the tab types: give it an empty one for the run.
      if (shell === 'zsh') await admin(`[ -e ${q(`${ctx.home}/.zshrc`)} ] || { printf '%s\\n' ${q(ZSHRC_MARK)} > ${q(`${ctx.home}/.zshrc`)} && chown ${q(user)}: ${q(`${ctx.home}/.zshrc`)}; }`);
      await admin(`chsh -s ${q(out.trim())} ${q(user)}`);
      try {
        const res = await shellSmoke(shell);
        check(ctx.caps.shell.endsWith(`/${shell}`), `handshake saw ${ctx.caps.shell}`);
        return res;
      } finally {
        await ctx.restoreShell();
      }
    }, { timeoutMs: 360000 });
  }
  await scenario('shells', 'back to bash', async () => {
    await ctx.restoreShell();
    const caps = await reconnectMain();
    check(caps.shell.endsWith('/bash'), `shell ${caps.shell}`);
    const { out } = await admin('df -h / | tail -1');
    return `disk: ${out.trim().replace(/\s+/g, ' ')}`;
  });
}

async function groupReconnect() {
  const pid = ctx.profile.id;
  if (!hasAdmin()) {
    await scenario('reconnect', 'network drop and sshd restart', () => skip('needs CT_REMOTE_LIVE_ADMIN'));
    return;
  }
  const since = (t) => ctx.statusLog.filter((s) => s.at >= t).map((s) => s.state);
  const waitState = async (state, ms, t0) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (since(t0).includes(state) && svc.getStatus(pid).state === state) return Date.now();
      await wait(200);
    }
    throw new Error(`no ${state} within ${ms} ms (saw ${since(t0).join(' > ') || 'nothing'}, now ${svc.getStatus(pid).state})`);
  };

  await scenario('reconnect', 'sshd restart keeps the connection, new lanes still open', async () => {
    const t0 = Date.now();
    await admin('systemctl restart ssh || systemctl restart sshd');
    await wait(2000);
    eq((await runText('echo after-restart')).trim(), 'after-restart', 'request after the restart');
    const outs = await Promise.all(Array.from({ length: 6 }, (_, i) => runText(`sleep 0.5; echo ${i}`)));
    eq(outs.length, 6, 'burst after the restart');
    eq(svc.getStatus(pid).state, 'connected', 'still connected');
    return since(t0).join(' > ') || 'no state change';
  });

  await scenario('reconnect', `network drop of ${DROP_S} s: reconnecting, writes fail fast, reads wait, recovery`, async () => {
    const t0 = Date.now();
    let ptyId = null;
    if (ctx.openPty) {
      ptyId = await ctx.openPty();
      await wait(3000);
    }
    // Detached inside the host, so it comes back up even if this process dies.
    // Taking the link down drops the default route, and bringing it up does
    // not restore it under ifupdown: the gateway is put back by hand.
    const { out: gw } = await admin(`ip -4 route show default | awk '{ print $3; exit }'`);
    ctx.gateway = /^\d{1,3}(\.\d{1,3}){3}$/.test(gw.trim()) ? gw.trim() : '';
    await admin(`nohup sh -c ${q(`ip link set ${IFACE} down; sleep ${DROP_S}; ip link set ${IFACE} up; ${ctx.gateway ? `ip route replace default via ${ctx.gateway} dev ${IFACE}` : ':'}`)} >/dev/null 2>&1 </dev/null &`);
    ctx.networkDown = true;
    const readDuring = run('echo read-through-the-drop', { timeoutMs: (DROP_S + 120) * 1000 });
    const detectedAt = await waitState('reconnecting', 60000, t0);
    const w0 = Date.now();
    const write = await run('touch should-not-exist', { write: true, timeoutMs: 30000 });
    const writeMs = Date.now() - w0;
    eq(write.reason, 'disconnected', 'write while reconnecting');
    check(writeMs < 1000, `write failed fast (${writeMs} ms)`);
    const lateRead = run('echo late-read', { timeoutMs: (DROP_S + 120) * 1000 });
    const connectedAt = await waitState('connected', (DROP_S + 120) * 1000, detectedAt);
    ctx.networkDown = false;
    const [r1, r2] = await Promise.all([readDuring, lateRead]);
    check(r1.ok && r1.stdout.toString().trim() === 'read-through-the-drop', `read issued before the drop: ${JSON.stringify({ reason: r1.reason, code: r1.code })}`);
    check(r2.ok && r2.stdout.toString().trim() === 'late-read', `read issued while reconnecting: ${JSON.stringify({ reason: r2.reason })}`);
    const states = since(t0);
    if (ctx.gateway) {
      const { out: route } = await admin('ip -4 route show default');
      check(route.includes(ctx.gateway), `default route restored on the host: ${route.trim()}`);
    }
    let ptyNote = '';
    if (ptyId !== null) {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !ctx.ptyEvent('terminal-disconnected', ptyId) && !ctx.ptyEvent('terminal-exit', ptyId)) await wait(200);
      const lost = ctx.ptyEvent('terminal-disconnected', ptyId);
      const exited = ctx.ptyEvent('terminal-exit', ptyId);
      check(lost || !exited, `the terminal tab was closed as an exit: ${JSON.stringify(exited && exited.payload)}`);
      ptyNote = lost ? `; pty disconnected (${lost.payload.kind})` : '; pty survived the drop';
      if (lost) {
        const back = await ipcHandlers.get('terminal-respawn')({}, { id: ptyId });
        check(back && back.success, `respawn: ${JSON.stringify(back)}`);
        ipcListeners.get('terminal-input')({}, { id: ptyId, data: 'echo respawned-$((1+1))\r' });
        const until = Date.now() + 30000;
        while (Date.now() < until && !ctx.ptyOutput(ptyId).includes('respawned-2')) await wait(200);
        check(ctx.ptyOutput(ptyId).includes('respawned-2'), 'respawned tab answers');
        ptyNote += ', respawned under the same id';
      }
      ipcListeners.get('terminal-kill')({}, { id: ptyId });
    }
    return `detected after ${Math.round((detectedAt - t0) / 1000)} s, back ${Math.round((connectedAt - t0) / 1000)} s after the drop; ${states.join(' > ')}${ptyNote}`;
  }, { timeoutMs: (DROP_S + 240) * 1000 });

  await scenario('reconnect', 'the host restarts (stop and start)', async () => {
    if (!REBOOT_CMD) skip('set CT_REMOTE_LIVE_REBOOT=1 and CT_REMOTE_LIVE_ADMIN_REBOOT');
    const t0 = Date.now();
    const parts = REBOOT_CMD.trim().split(/\s+/);
    const [first, ...rest] = parts;
    const command = /^ssh(\.exe)?$/i.test(first) && SSH_BIN ? SSH_BIN : first;
    const head = /^ssh(\.exe)?$/i.test(first) ? rest.slice(0, rest.findIndex((a) => !a.startsWith('-') && !/^\d+$/.test(a)) + 1) : [];
    const tail = /^ssh(\.exe)?$/i.test(first) ? rest.slice(head.length) : rest;
    await new Promise((resolve, reject) => {
      const child = spawn(command, /^ssh(\.exe)?$/i.test(first) ? ['-o', 'BatchMode=yes', ...head, tail.join(' ')] : tail, { windowsHide: true, stdio: 'ignore' });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`reboot command exited ${code}`))));
    });
    const lostAt = await waitState('reconnecting', 60000, t0);
    const read = await run('echo after-reboot', { timeoutMs: 180000 });
    check(read.ok, `read after the restart: ${read.reason}`);
    eq(svc.getStatus(pid).state, 'connected', 'connected again');
    return `${Math.round((lostAt - t0) / 1000)} s to notice, ${Math.round((Date.now() - t0) / 1000)} s to answer again; ${since(t0).join(' > ')}`;
  }, { timeoutMs: 300000 });
}

// ── Main ─────────────────────────────────────────────────────────────────────

let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (ctx.networkDown) {
    try { await admin(`ip link set ${IFACE} up${ctx.gateway ? `; ip route replace default via ${ctx.gateway} dev ${IFACE}` : ''}`); } catch (e) { log('cleanup: network up:', e.message); }
  }
  if (ctx.restoreShell) {
    try { await ctx.restoreShell(); } catch (e) { log('cleanup: login shell:', e.message); }
  }
  try {
    if (ctx.base && svc.getStatus(ctx.profile.id).state === 'connected') {
      await run(`rm -rf -- ${q(ctx.base)}`, { write: true, timeoutMs: 60000 });
    }
  } catch (e) { log('cleanup: remote work directory:', e.message); }
  for (const user of ctx.extraUsers) {
    try { await admin(`userdel -r ${q(user)} 2>/dev/null; :`); } catch (e) { log(`cleanup: user ${user}:`, e.message); }
  }
  try { svc.disposeAll(); } catch { /* best effort */ }
}

async function main() {
  const sshBefore = localSshPids();
  log(`remote-ssh-live run ${RUN_ID}: dest=${DEST}${JUMP ? ` jump=${JUMP}` : ''} admin=${hasAdmin() ? 'yes' : 'no'} home=${TMP}`);
  try {
    await groupDiscovery();
    await groupHostKeys();
    await groupConnect();
    await groupChannel();
    await groupAuth();
    await groupFs();
    await groupGit();
    await groupSessions();
    await groupChat();
    await groupWatcher();
    await groupPty();
    await groupShells();
    await groupReconnect();
    if (groupEnabled('leaks') && hasAdmin()) {
      await scenario('leaks', 'no driver, watcher or request left on the host after dispose', async () => {
        try { req('src/main/services/TerminalService.js').killAll?.(); } catch { /* not loaded */ }
        await cleanup();
        // A session cut during a network drop only ends on the host once the
        // close gets through (the jump host retransmits its FIN with backoff),
        // so the host gets a bounded while to notice.
        const t0 = Date.now();
        let left = [];
        do {
          await wait(3000);
          left = await remoteUserProcesses();
        } while (left.length > 0 && Date.now() - t0 < 180000);
        eq(left.length, 0, `processes left: ${left.join(' | ')}`);
        return `host clean after ${Math.round((Date.now() - t0) / 1000)} s`;
      }, { timeoutMs: 240000 });
    }
  } catch (e) {
    results.push({ group: 'harness', name: 'aborted', result: 'fail', detail: e.stack || String(e) });
    log('ABORT', e.stack || e);
  } finally {
    await cleanup();
  }

  await scenario('leaks', 'no ssh process of ours left on this machine', async () => {
    await wait(3000);
    const leaked = [...localSshPids()].filter((pid) => !sshBefore.has(pid));
    eq(leaked.length, 0, `ssh processes left (${leaked.join(', ')})`);
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  const counts = results.reduce((acc, r) => ({ ...acc, [r.result]: (acc[r.result] || 0) + 1 }), {});
  console.log('\n=== remote-ssh-live summary ===');
  for (const r of results) console.log(`${r.result.toUpperCase().padEnd(4)} ${r.group} / ${r.name}${r.result === 'fail' ? `\n     ${r.detail.split('\n')[0]}` : ''}`);
  console.log(`pass=${counts.pass || 0} fail=${counts.fail || 0} skip=${counts.skip || 0}`);
  process.exit(counts.fail ? 1 : 0);
}

main();
