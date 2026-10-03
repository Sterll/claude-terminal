/**
 * @jest-environment node
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { SshHostService, validateProfile, classifyOpenFailure } = require('../../src/main/services/SshHostService');
const { classifySshFailure } = require('../../src/shared/remote-shell');
const { findSh, FAILURES, FAKE_SSH } = require('../helpers/fake-ssh');

const HANDSHAKE_OUT = [
  'os\tLinux', 'arch\tx86_64', 'home\t/home/yanis', 'shell\t/bin/bash', 'user\tyanis', 'b64\tbase64 -d',
  'loginPath\t1', 'path\t/home/yanis/.local/bin:/usr/bin:/bin', 'claudeConfigDir\t', 'git\tgit version 2.43.0',
  'claude\t/home/yanis/.local/bin/claude', 'claudeVersion\t2.1.280 (Claude Code)', 'has\tbase64', 'has\tgit', '',
].join('\n');

/** An in-memory lane: opens or fails per the mode it was created with. */
class FakeLane extends EventEmitter {
  constructor(mode, handler) {
    super();
    this.mode = mode;
    this.handler = handler;
    this.ready = false;
    this.exited = false;
    this.closingReason = null;
    this.killer = null;
    this.inFlight = 0;
    this.requests = [];
  }
  get isOpen() { return this.ready && !this.exited && !this.closingReason; }
  get load() { return this.inFlight; }
  setKiller(fn) { this.killer = fn; }
  async open() {
    if (this.mode === 'ok') { this.ready = true; return { version: 1 }; }
    this.exited = true;
    const stderr = FAILURES[this.mode] || '';
    const error = new Error('ssh exited before the remote shell was ready');
    Object.assign(error, { code: 'LANE_OPEN_FAILED', failKind: 'exit', exitCode: this.mode === 'nosh' ? 1 : 255, stderr, sshFailure: classifySshFailure(255, stderr) });
    throw error;
  }
  async request(script, opts = {}) {
    if (this.exited || this.closingReason) return { ok: false, reason: 'disconnected', code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    this.requests.push({ script, opts });
    if (script.startsWith("printf 'os")) return { ok: true, code: 0, stdout: Buffer.from(HANDSHAKE_OUT), stderr: Buffer.alloc(0) };
    this.inFlight++;
    try {
      return await this.handler(script, opts, this);
    } finally {
      this.inFlight--;
    }
  }
  async setPath(value) { this.path = value; return { ok: true, code: 0 }; }
  close(reason = 'closed') {
    if (this.exited) return;
    this.closingReason = reason;
    this.exited = true;
    this.emit('exit', { code: 0, expected: true, reason });
  }
  die() {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', { code: 255, expected: false, sshFailure: 'network', stderr: 'client_loop: send disconnect: Connection reset' });
  }
}

/** fs.promises over a Map: resolves on microtasks only, so fake timers drive everything. */
function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  let tick = 1;
  const meta = new Map();
  const touch = (p) => meta.set(p, ++tick);
  for (const p of files.keys()) touch(p);
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    files,
    stat: async (p) => { if (!files.has(p)) throw enoent(p); return { mtimeMs: meta.get(p), size: files.get(p).length }; },
    readFile: async (p) => { if (!files.has(p)) throw enoent(p); return files.get(p); },
    writeFile: async (p, text) => { files.set(p, String(text)); touch(p); },
    copyFile: async (a, b) => { if (!files.has(a)) throw enoent(a); files.set(b, files.get(a)); touch(b); },
    rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); touch(b); },
    mkdir: async () => {},
  };
}

const STORE = '/mem/remote-hosts.json';
const PROFILE_ID = 'abcd1234';

function storeWith(profiles) {
  return { [STORE]: JSON.stringify({ version: 1, sshBinary: null, profiles }) };
}

function makeService({ modes = [], handler, profiles = [{ id: PROFILE_ID, label: 'Box', host: 'build.example.com', user: 'yanis', port: 22 }], ...rest } = {}) {
  const queue = [...modes];
  const lanes = [];
  const broadcast = jest.fn();
  const createLane = jest.fn(() => {
    const lane = new FakeLane(queue.length ? queue.shift() : 'ok', handler || (async () => ({ ok: true, code: 0, stdout: Buffer.from('ok\n'), stderr: Buffer.alloc(0) })));
    lanes.push(lane);
    return lane;
  });
  const fsp = memoryFs(storeWith(profiles));
  const service = new SshHostService({
    dataDir: '/mem',
    storeFile: STORE,
    platform: 'win32',
    broadcast,
    createLane,
    fsp,
    resolveLauncher: async () => ({ command: 'ssh', prefixArgs: [] }),
    pingIntervalMs: 0,
    ...rest,
  });
  return { service, lanes, broadcast, createLane, fsp, queue };
}

const states = (broadcast) => broadcast.mock.calls.filter(([channel]) => channel === 'ssh-status-changed').map(([, s]) => s.state);

describe('SshHostService connection state machine (fake timers)', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('backoff schedule is 1, 2, 4, 8, 16, then 30 s', async () => {
    const { service, createLane } = makeService({ modes: Array(10).fill('timeout') });
    const times = [];
    createLane.mockImplementation(((orig) => (opts) => { times.push(Date.now()); return orig(opts); })(createLane.getMockImplementation()));
    const status = await service.connect(PROFILE_ID);
    expect(status.state).toBe('reconnecting');
    expect(status.retryAt - Date.now()).toBe(1000);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      await jest.advanceTimersByTimeAsync(delay);
    }
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    expect(gaps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    service.disposeAll();
  });

  test.each([
    ['auth', 'authFailed'],
    ['hostkey-unknown', 'hostKeyUnknown'],
    ['hostkey-changed', 'hostKeyChanged'],
  ])('no automatic retry after %s', async (mode, state) => {
    const { service, createLane } = makeService({ modes: [mode] });
    const status = await service.connect(PROFILE_ID);
    expect(status.state).toBe(state);
    expect(status.retryAt).toBeNull();
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(createLane).toHaveBeenCalledTimes(1);
    expect(service.getStatus(PROFILE_ID).state).toBe(state);
  });

  test('a host that cannot run /bin/sh is unsupported and not retried', async () => {
    const { service, createLane } = makeService({ modes: ['nosh'] });
    expect((await service.connect(PROFILE_ID)).state).toBe('unsupported');
    await jest.advanceTimersByTimeAsync(60000);
    expect(createLane).toHaveBeenCalledTimes(1);
  });

  test('status broadcast sequence connecting -> connected -> reconnecting -> connected', async () => {
    const { service, lanes, broadcast } = makeService();
    expect((await service.connect(PROFILE_ID)).state).toBe('connected');
    expect(service.getStatus(PROFILE_ID).capabilities).toMatchObject({ os: 'Linux', git: 'git version 2.43.0', loginShellSupported: true });
    expect(lanes[0].path).toBe('/home/yanis/.local/bin:/usr/bin:/bin');
    lanes[0].die();
    expect(service.getStatus(PROFILE_ID)).toMatchObject({ state: 'reconnecting', detail: { kind: 'network', attempt: 1 } });
    await jest.advanceTimersByTimeAsync(1000);
    expect(states(broadcast)).toEqual(['connecting', 'connected', 'reconnecting', 'connected']);
    const payload = broadcast.mock.calls[2][1];
    expect(payload).toMatchObject({ profileId: PROFILE_ID, state: 'reconnecting' });
    expect(typeof payload.retryAt).toBe('number');
    service.disposeAll();
  });

  test('reads wait while reconnecting, writes fail fast with disconnected', async () => {
    const { service, lanes } = makeService();
    await service.connect(PROFILE_ID);
    lanes[0].die();
    const read = service.exec(PROFILE_ID, 'git status --porcelain', { timeoutMs: 10000 });
    const write = await service.exec(PROFILE_ID, 'git commit -m x', { write: true });
    expect(write).toMatchObject({ ok: false, reason: 'disconnected' });
    const put = await service.exec(PROFILE_ID, 'cat > f', { input: Buffer.from('x') });
    expect(put).toMatchObject({ ok: false, reason: 'disconnected' });
    await jest.advanceTimersByTimeAsync(1000);
    expect(await read).toMatchObject({ ok: true });
    service.disposeAll();
  });

  test('a read gives up when its own timeout passes before the host is back', async () => {
    const { service, lanes } = makeService({ modes: ['ok', 'timeout', 'timeout', 'timeout'] });
    await service.connect(PROFILE_ID);
    lanes[0].die();
    const read = service.exec(PROFILE_ID, 'git status', { timeoutMs: 2500 });
    await jest.advanceTimersByTimeAsync(3000);
    expect(await read).toMatchObject({ ok: false, reason: 'disconnected' });
    service.disposeAll();
  });

  test('a read whose lane dies under it is re-run after the reconnect', async () => {
    let calls = 0;
    const handler = async (script, opts, lane) => {
      calls++;
      if (calls === 1) { lane.die(); return { ok: false, reason: 'disconnected', code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
      return { ok: true, code: 0, stdout: Buffer.from('second'), stderr: Buffer.alloc(0) };
    };
    const { service } = makeService({ handler });
    await service.connect(PROFILE_ID);
    const read = service.exec(PROFILE_ID, 'cat file', { timeoutMs: 10000 });
    await jest.advanceTimersByTimeAsync(1000);
    expect((await read).stdout.toString()).toBe('second');
    service.disposeAll();
  });

  test('resume retries immediately instead of waiting out the backoff', async () => {
    const { service, createLane } = makeService({ modes: ['timeout', 'ok'] });
    await service.connect(PROFILE_ID);
    expect(createLane).toHaveBeenCalledTimes(1);
    service.onResume();
    await jest.advanceTimersByTimeAsync(0);
    expect(createLane).toHaveBeenCalledTimes(2);
    expect(service.getStatus(PROFILE_ID).state).toBe('connected');
    service.disposeAll();
  });

  test('disconnect stops retrying: reconnecting goes offline, connected goes idle', async () => {
    const { service, createLane, lanes } = makeService({ modes: ['timeout'] });
    await service.connect(PROFILE_ID);
    expect(service.disconnect(PROFILE_ID).state).toBe('offline');
    await jest.advanceTimersByTimeAsync(60000);
    expect(createLane).toHaveBeenCalledTimes(1);
    await service.connect(PROFILE_ID);
    expect(service.getStatus(PROFILE_ID).state).toBe('connected');
    expect(service.disconnect(PROFILE_ID).state).toBe('idle');
    expect(lanes[lanes.length - 1].closingReason).toBe('reconnect');
  });

  test('a connect asked for after a disconnect is not swallowed by the attempt it cancelled', async () => {
    const { service, createLane } = makeService();
    let releaseOpen;
    const gate = new Promise((resolve) => { releaseOpen = resolve; });
    const original = createLane.getMockImplementation();
    let first = true;
    createLane.mockImplementation((opts) => {
      const lane = original(opts);
      if (first) {
        first = false;
        const open = lane.open.bind(lane);
        lane.open = async () => { await gate; return open(); };
      }
      return lane;
    });
    const stale = service.connect(PROFILE_ID);
    await jest.advanceTimersByTimeAsync(0);
    service.disconnect(PROFILE_ID);
    const fresh = service.connect(PROFILE_ID);
    releaseOpen();
    expect((await stale).state).toBe('idle');
    expect((await fresh).state).toBe('connected');
    expect(createLane).toHaveBeenCalledTimes(2);
    service.disposeAll();
  });

  test('a one-shot ends its stdin unless its script watches stdin for the end of the session', async () => {
    const children = [];
    const spawnImpl = jest.fn(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = Object.assign(new EventEmitter(), { end: jest.fn() });
      child.kill = jest.fn();
      children.push(child);
      return child;
    });
    const { service } = makeService({ spawnImpl });
    await service.connect(PROFILE_ID);
    const plain = service.oneShot(PROFILE_ID, 'true');
    const watching = service.oneShot(PROFILE_ID, 'inotifywait -m x', { keepStdinOpen: true });
    expect(children).toHaveLength(2);
    expect(children[0].stdin.end).toHaveBeenCalled();
    expect(children[1].stdin.end).not.toHaveBeenCalled();
    for (const child of children) child.emit('close', 0);
    await Promise.all([plain, watching]);
    service.disposeAll();
  });

  test('an idle host connects lazily on the first read', async () => {
    const { service, createLane } = makeService();
    const res = await service.exec(PROFILE_ID, 'echo ok', { timeoutMs: 5000 });
    expect(res.ok).toBe(true);
    expect(createLane).toHaveBeenCalledTimes(1);
    service.disposeAll();
  });

  test('busy lanes open more lanes up to three', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const handler = async (script) => (script === 'slow' ? gate : null) || { ok: true, code: 0, stdout: Buffer.from(script), stderr: Buffer.alloc(0) };
    const { service, createLane } = makeService({ handler });
    await service.connect(PROFILE_ID);
    const slow = [service.exec(PROFILE_ID, 'slow'), service.exec(PROFILE_ID, 'slow'), service.exec(PROFILE_ID, 'slow')];
    await jest.advanceTimersByTimeAsync(0);
    expect(createLane).toHaveBeenCalledTimes(3);
    const fourth = service.exec(PROFILE_ID, 'slow');
    await jest.advanceTimersByTimeAsync(0);
    expect(createLane).toHaveBeenCalledTimes(3);
    release({ ok: true, code: 0, stdout: Buffer.from('done'), stderr: Buffer.alloc(0) });
    await Promise.all([...slow, fourth]);
    service.disposeAll();
  });

  test('a burst waits for the first free lane instead of piling onto lane 0 while the others open', async () => {
    // Every request takes 1 s, every extra lane 1 s to open (a handshake
    // through a jump host). Pinning each request to the least busy lane at
    // arrival put seven of nine behind lane 0: 7 s instead of about 4.
    const handler = (script) => new Promise((resolve) => setTimeout(() => resolve({ ok: true, code: 0, stdout: Buffer.from(script), stderr: Buffer.alloc(0) }), 1000));
    const { service, createLane, lanes } = makeService({ handler });
    await service.connect(PROFILE_ID);
    const original = createLane.getMockImplementation();
    createLane.mockImplementation((opts) => {
      const lane = original(opts);
      const open = lane.open.bind(lane);
      lane.open = () => new Promise((resolve) => setTimeout(resolve, 1000)).then(open);
      return lane;
    });
    let done = 0;
    const burst = Array.from({ length: 9 }, (_, i) => service.exec(PROFILE_ID, `r${i}`, { timeoutMs: 30000 }).then((r) => { done++; return r; }));
    await jest.advanceTimersByTimeAsync(4000);
    expect(done).toBe(9);
    const results = await Promise.all(burst);
    expect(results.map((r) => r.stdout.toString())).toEqual(Array.from({ length: 9 }, (_, i) => `r${i}`));
    expect(lanes).toHaveLength(3);
    // Spread over the pool, lane 0 serving no more than its share.
    const served = lanes.map((l) => l.requests.filter((r) => /^r\d$/.test(r.script)).length);
    expect(served[0]).toBeLessThanOrEqual(4);
    expect(served[1]).toBeGreaterThanOrEqual(2);
    expect(served[2]).toBeGreaterThanOrEqual(2);
    service.disposeAll();
  });

  test('a waiting request takes whichever lane frees first, never queueing behind a slow one', async () => {
    let releaseSlow;
    const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
    const ok = (text) => ({ ok: true, code: 0, stdout: Buffer.from(text), stderr: Buffer.alloc(0) });
    const handler = (script) => (script === 'slow' ? slowGate.then(() => ok('slow')) : new Promise((resolve) => setTimeout(() => resolve(ok(script)), 100)));
    const { service, lanes } = makeService({ handler, maxLanes: 2 });
    await service.connect(PROFILE_ID);
    const slow = service.exec(PROFILE_ID, 'slow', { timeoutMs: 60000 });
    const first = service.exec(PROFILE_ID, 'fast1', { timeoutMs: 60000 });
    await jest.advanceTimersByTimeAsync(0);
    // Both lanes busy now; this one waits at the host, not in lane 0's queue.
    const second = service.exec(PROFILE_ID, 'fast2', { timeoutMs: 60000 });
    await jest.advanceTimersByTimeAsync(250);
    expect((await second).stdout.toString()).toBe('fast2');
    expect((await first).stdout.toString()).toBe('fast1');
    expect(lanes[0].requests.map((r) => r.script)).toEqual(expect.not.arrayContaining(['fast2']));
    releaseSlow();
    expect((await slow).stdout.toString()).toBe('slow');
    service.disposeAll();
  });

  test('a request waiting for a lane is released when the host drops, and reads wait for the reconnect', async () => {
    let releaseSlow;
    const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
    const handler = (script) => (script === 'slow' ? slowGate : Promise.resolve({ ok: true, code: 0, stdout: Buffer.from(script), stderr: Buffer.alloc(0) }));
    const { service, lanes } = makeService({ handler, maxLanes: 1 });
    await service.connect(PROFILE_ID);
    const slow = service.exec(PROFILE_ID, 'slow', { timeoutMs: 60000, write: true });
    await jest.advanceTimersByTimeAsync(0);
    const write = service.exec(PROFILE_ID, 'w', { timeoutMs: 60000, write: true });
    const read = service.exec(PROFILE_ID, 'r', { timeoutMs: 60000 });
    await jest.advanceTimersByTimeAsync(0);
    lanes[0].die();
    releaseSlow({ ok: false, reason: 'disconnected', code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    expect((await write).reason).toBe('disconnected');
    await jest.advanceTimersByTimeAsync(1000);
    expect((await read).stdout.toString()).toBe('r');
    await slow;
    service.disposeAll();
  });

  test('the keepalive pings an idle lane when lane 0 is stuck, and a missed ping reconnects', async () => {
    // A link that went dead: nothing answers any more, every request runs into its own timeout.
    let dead = false;
    const ok = (text) => ({ ok: true, code: 0, stdout: Buffer.from(text), stderr: Buffer.alloc(0) });
    const handler = (script, opts) => {
      if (script === 'stuck' || dead) return new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: 'timeout', code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }), opts.timeoutMs));
      return Promise.resolve(ok(script));
    };
    const { service, lanes, broadcast } = makeService({ handler, pingIntervalMs: 20000, pingTimeoutMs: 10000 });
    await service.connect(PROFILE_ID);
    const stuck = service.exec(PROFILE_ID, 'stuck', { timeoutMs: 120000 });
    await jest.advanceTimersByTimeAsync(0);
    expect((await service.exec(PROFILE_ID, 'fast')).ok).toBe(true); // opens lane 1, which is idle again
    dead = true;
    await jest.advanceTimersByTimeAsync(20000);
    expect(lanes[1].requests.some((r) => r.script === ':')).toBe(true);
    await jest.advanceTimersByTimeAsync(10000);
    expect(states(broadcast)).toContain('reconnecting');
    // The write that comes now fails fast instead of queueing on the dead link.
    expect((await service.exec(PROFILE_ID, 'touch x', { write: true })).reason).toBe('disconnected');
    service.disposeAll();
    await jest.advanceTimersByTimeAsync(120000);
    await stuck;
  });

  test('a request waiting while the ping holds the only free lane runs when the ping answers', async () => {
    const ok = (text) => ({ ok: true, code: 0, stdout: Buffer.from(text), stderr: Buffer.alloc(0) });
    const handler = (script) => (script === ':' ? new Promise((resolve) => setTimeout(() => resolve(ok('')), 3000)) : Promise.resolve(ok(script)));
    const { service } = makeService({ handler, maxLanes: 1, pingIntervalMs: 20000, pingTimeoutMs: 10000 });
    await service.connect(PROFILE_ID);
    await jest.advanceTimersByTimeAsync(20000); // the ping is on the only lane now
    const res = service.exec(PROFILE_ID, 'after-ping', { timeoutMs: 8000 });
    await jest.advanceTimersByTimeAsync(3000);
    expect((await res).stdout.toString()).toBe('after-ping');
    service.disposeAll();
  });

  test('probe: unknown for a host never reached, dead for one that is not connected, never connects', async () => {
    const { service, createLane } = makeService({ modes: ['ok'] });
    expect(await service.probe(PROFILE_ID)).toBe('unknown');
    expect(createLane).not.toHaveBeenCalled();
    await service.connect(PROFILE_ID);
    service.hosts.get(PROFILE_ID).lanes[0].die();
    expect(service.getStatus(PROFILE_ID).state).toBe('reconnecting');
    expect(await service.probe(PROFILE_ID)).toBe('dead');
    service.disposeAll();
  });

  test('probe: alive when the connected host answers a no-op, dead when it does not in time', async () => {
    let answer = true;
    const handler = async (script, opts) => {
      // A real lane gives up after the request's own timeout; this one is told to.
      if (script === ':' && !answer) return new Promise((r) => setTimeout(() => r({ ok: false, reason: 'timeout', code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }), opts.timeoutMs));
      return { ok: true, code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    const { service, lanes } = makeService({ handler });
    await service.connect(PROFILE_ID);
    expect(await service.probe(PROFILE_ID)).toBe('alive');
    expect(lanes[0].requests.some((r) => r.script === ':')).toBe(true);
    answer = false;
    const probing = service.probe(PROFILE_ID, { timeoutMs: 3000 });
    await jest.advanceTimersByTimeAsync(3000);
    expect(await probing).toBe('dead');
    service.disposeAll();
  });

  test('a missing profile is reported rather than retried', async () => {
    const { service, createLane } = makeService({ profiles: [] });
    expect((await service.connect(PROFILE_ID)).state).toBe('unsupported');
    expect(createLane).not.toHaveBeenCalled();
  });
});

describe('SshHostService profile store', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-hosts-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const service = (extra = {}) => new SshHostService({ dataDir: dir, platform: 'win32', broadcast: () => {}, ...extra });

  test('absent file means no profiles', async () => {
    expect(await service().listProfiles()).toEqual([]);
  });

  test('an unreadable remote-hosts.json throws REMOTE_HOSTS_UNREADABLE and is left untouched', async () => {
    const file = path.join(dir, 'remote-hosts.json');
    fs.writeFileSync(file, '{"version":1,"profiles":[{"id":"abcd1234"');
    const svc = service();
    await expect(svc.listProfiles()).rejects.toMatchObject({ code: 'REMOTE_HOSTS_UNREADABLE' });
    await expect(svc.saveProfile({ host: 'new.example.com' })).rejects.toMatchObject({ code: 'REMOTE_HOSTS_UNREADABLE' });
    await expect(svc.deleteProfile('abcd1234')).rejects.toMatchObject({ code: 'REMOTE_HOSTS_UNREADABLE' });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"version":1,"profiles":[{"id":"abcd1234"');
    expect(fs.readdirSync(dir)).toEqual(['remote-hosts.json']);
    fs.writeFileSync(file, '{"profiles": "not a list"}');
    await expect(service().listProfiles()).rejects.toMatchObject({ code: 'REMOTE_HOSTS_UNREADABLE' });
  });

  test('save creates an id, writes atomically with a .bak, and update keeps id and createdAt', async () => {
    const svc = service();
    const created = await svc.saveProfile({ label: 'Build', host: 'build.example.com', user: 'yanis', port: '2222' });
    expect(created.id).toMatch(/^[a-z0-9]{8}$/);
    expect(created).toMatchObject({ host: 'build.example.com', user: 'yanis', port: 2222, forwardAgent: false, lastConnectedAt: null });
    const file = path.join(dir, 'remote-hosts.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).profiles).toHaveLength(1);
    const updated = await svc.saveProfile({ ...created, label: 'Renamed', forwardAgent: true });
    expect(updated).toMatchObject({ id: created.id, createdAt: created.createdAt, label: 'Renamed', forwardAgent: true });
    expect(fs.existsSync(`${file}.bak`)).toBe(true);
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).profiles[0].label).toBe('Build');
    expect(await svc.getProfile(created.id)).toMatchObject({ label: 'Renamed' });
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(await svc.deleteProfile(created.id)).toBe(true);
    expect(await svc.listProfiles()).toEqual([]);
  });

  test('verifyCommand builds the verify argv from the stored profile, never a relaxed check', async () => {
    const svc = service({ resolveLauncher: async () => ({ command: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe', prefixArgs: [] }) });
    const created = await svc.saveProfile({ host: 'build.example.com', user: 'yanis', port: 2222 });
    const cmd = await svc.verifyCommand(created.id);
    expect(cmd.file).toBe('C:\\Windows\\System32\\OpenSSH\\ssh.exe');
    expect(cmd.args).toEqual(expect.arrayContaining(['-o', 'StrictHostKeyChecking=ask', '--', 'build.example.com', 'exit']));
    expect(cmd.args.join(' ')).not.toMatch(/StrictHostKeyChecking=no|BatchMode=yes|UserKnownHostsFile/);
    expect(cmd.args.slice(-3)).toEqual(['--', 'build.example.com', 'exit']);
    expect(cmd.destination).toBe('yanis@build.example.com:2222');
    await expect(svc.verifyCommand('zzzz9999')).rejects.toMatchObject({ code: 'REMOTE_PROFILE_UNKNOWN' });
  });

  test('a well-formed unknown id is kept, so a synced project can get its host back', async () => {
    const created = await service().saveProfile({ id: 'h7k2m9qa', host: 'build.example.com' });
    expect(created.id).toBe('h7k2m9qa');
    await expect(service().saveProfile({ id: '../evil', host: 'x' })).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
  });
});

describe('profile validation', () => {
  const exists = () => true;

  test.each([
    ['a free-form option field', { host: 'h', options: '-oProxyCommand=calc' }],
    ['a ProxyCommand field', { host: 'h', proxyCommand: 'calc' }],
    ['a LocalCommand field', { host: 'h', localCommand: 'calc' }],
    ['no host and no alias', { user: 'u' }],
    ['a host starting with -', { host: '-oProxyCommand=calc' }],
    ['a host with a space', { host: 'a b' }],
    ['a host with a shell character', { host: 'a$(id)' }],
    ['an alias starting with -', { sshConfigAlias: '-F/tmp/x' }],
    ['port 0', { host: 'h', port: 0 }],
    ['port 70000', { host: 'h', port: 70000 }],
    ['a non-numeric port', { host: 'h', port: 'ssh' }],
    ['a fractional port', { host: 'h', port: 22.5 }],
    ['a user with a space', { host: 'h', user: 'a b' }],
    ['a user starting with -', { host: 'h', user: '-l' }],
    ['a jump host starting with -', { host: 'h', proxyJump: '-J' }],
    ['a relative identity file', { host: 'h', identityFile: 'id_rsa' }],
    ['a relative remote claude path', { host: 'h', remoteClaudePath: 'bin/claude' }],
    ['a non-boolean forwardAgent', { host: 'h', forwardAgent: 'yes' }],
    ['a label with a newline', { host: 'h', label: 'a\nb' }],
  ])('rejects %s', (_label, input) => {
    expect(() => validateProfile(input, { fileExists: exists })).toThrow(expect.objectContaining({ code: 'INVALID_PROFILE' }));
  });

  test('an identity file that does not exist is refused', () => {
    const abs = process.platform === 'win32' ? 'C:\\nope\\id' : '/nope/id';
    expect(() => validateProfile({ host: 'h', identityFile: abs }, { fileExists: () => false })).toThrow(/does not exist/);
  });

  test('a valid profile is normalised', () => {
    expect(validateProfile({ host: ' build.example.com ', user: 'yanis', port: '22', proxyJump: 'a@b:2200,c' }, { fileExists: exists }))
      .toMatchObject({ host: 'build.example.com', user: 'yanis', port: 22, proxyJump: 'a@b:2200,c', label: 'yanis@build.example.com', forwardAgent: false });
    expect(validateProfile({ sshConfigAlias: 'buildbox' }, { fileExists: exists })).toMatchObject({ sshConfigAlias: 'buildbox', host: null, label: 'buildbox' });
  });

  test('classifyOpenFailure maps lane failures to states', () => {
    expect(classifyOpenFailure({ failKind: 'spawn', errno: 'ENOENT' })).toMatchObject({ retry: false, state: 'unsupported', detail: { code: 'ssh-not-found' } });
    expect(classifyOpenFailure({ failKind: 'exit', exitCode: 255, stderr: FAILURES.auth })).toMatchObject({ retry: false, state: 'authFailed' });
    expect(classifyOpenFailure({ failKind: 'exit', exitCode: 255, stderr: FAILURES.dns })).toMatchObject({ retry: true, kind: 'dns' });
    expect(classifyOpenFailure({ failKind: 'exit', exitCode: 127, stderr: 'sh: /bin/sh: not found' })).toMatchObject({ retry: false, state: 'unsupported', detail: { code: 'no-posix-shell' } });
    expect(classifyOpenFailure({ failKind: 'timeout', sshFailure: 'timeout' })).toMatchObject({ retry: true, kind: 'timeout' });
  });

  test('Windows ssh exiting -1 before ready (the server dropped the session) is retried, not unsupported', () => {
    // child_process reports Windows OpenSSH's exit(-1) as 4294967295, node-pty as -1.
    const dropped = 'Connection to build.example.com closed by remote host.\r\n';
    expect(classifyOpenFailure({ failKind: 'exit', exitCode: 4294967295, stderr: dropped })).toMatchObject({ retry: true, kind: 'network' });
    expect(classifyOpenFailure({ failKind: 'exit', exitCode: 4294967295, stderr: '' })).toMatchObject({ retry: true, kind: 'network' });
    expect(classifyOpenFailure({ failKind: 'exit', exitCode: -1, stderr: '' })).toMatchObject({ retry: true, kind: 'network' });
  });
});

const SH = findSh();
(SH ? describe : describe.skip)('SshHostService end to end against fake-ssh and a real sh', () => {
  jest.setTimeout(60000);
  let dir;
  let mode;
  let svc;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-hosts-e2e-'));
    mode = 'ok';
    svc = new SshHostService({
      dataDir: dir,
      platform: 'win32',
      broadcast: () => {},
      pingIntervalMs: 0,
      resolveLauncher: async () => ({ command: process.execPath, prefixArgs: [FAKE_SSH], env: { ...process.env, FAKE_SSH_SH: SH, FAKE_SSH_MODE: mode } }),
    });
  });

  afterEach(() => {
    svc.disposeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('connects, runs the real handshake and executes requests', async () => {
    const profile = await svc.saveProfile({ host: 'build.example.com', user: 'yanis' });
    const status = await svc.connect(profile.id);
    expect(status.state).toBe('connected');
    expect(status.capabilities.home).toBeTruthy();
    expect(status.capabilities.path).toBeTruthy();
    expect(status.capabilities.base64).toMatch(/base64|openssl/);
    const res = await svc.exec(profile.id, "printf '%s' hello");
    expect(res).toMatchObject({ ok: true });
    expect(res.stdout.toString()).toBe('hello');
    const listed = await svc.listProfiles();
    expect(listed[0].lastConnectedAt).toEqual(expect.any(Number));
  });

  test('a real auth failure ends in authFailed', async () => {
    const profile = await svc.saveProfile({ host: 'build.example.com' });
    mode = 'auth';
    expect((await svc.connect(profile.id)).state).toBe('authFailed');
  });

  test('a profile test reports without changing the connection state', async () => {
    const profile = await svc.saveProfile({ host: 'build.example.com' });
    const ok = await svc.testProfile(profile.id);
    expect(ok).toMatchObject({ ok: true, state: 'connected' });
    expect(ok.capabilities.git).toBeDefined();
    mode = 'hostkey-unknown';
    expect(await svc.testProfile(profile.id)).toMatchObject({ ok: false, state: 'hostKeyUnknown' });
    mode = 'refused';
    expect(await svc.testProfile(profile.id)).toMatchObject({ ok: false, state: 'unreachable', detail: { kind: 'refused' } });
    expect(svc.getStatus(profile.id).state).toBe('idle');
  });
});

describe('SshHostService terminal PTY launch', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-hosts-pty-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const service = (extra = {}) => new SshHostService({
    dataDir: dir,
    platform: 'win32',
    broadcast: () => {},
    resolveLauncher: async () => ({ command: '/usr/bin/ssh', prefixArgs: [] }),
    ...extra,
  });

  test('gives the ssh binary, the stored profile and no capabilities before any connection', async () => {
    const svc = service();
    const profile = await svc.saveProfile({ host: 'build.example.com', user: 'yanis', tmuxSessions: true });
    const launch = await svc.ptyLaunch(profile.id);
    expect(launch).toMatchObject({
      profileId: profile.id,
      command: '/usr/bin/ssh',
      prefixArgs: [],
      capabilities: null,
      controlDir: null,
      platform: 'win32',
    });
    expect(launch.profile).toMatchObject({ host: 'build.example.com', user: 'yanis', tmuxSessions: true });
  });

  test('an unknown profile or a missing ssh binary is refused', async () => {
    await expect(service().ptyLaunch('zzzz9999')).rejects.toMatchObject({ code: 'REMOTE_PROFILE_UNKNOWN' });
    await expect(service().ptyLaunch('../etc')).rejects.toMatchObject({ code: 'INVALID_PROFILE' });
    const svc = service({ resolveLauncher: async () => null });
    const profile = await svc.saveProfile({ host: 'build.example.com' });
    await expect(svc.ptyLaunch(profile.id)).rejects.toMatchObject({ code: 'SSH_NOT_FOUND' });
  });

  test('ending a tmux session fails fast on a host that is not connected', async () => {
    const svc = service();
    const profile = await svc.saveProfile({ host: 'build.example.com' });
    expect(await svc.killTmuxSession(profile.id, 'ct-tab_r1_1')).toBe(false);
    expect(svc.getStatus(profile.id).state).toBe('idle');
  });
});

describe('SshHostService ssh_config alias resolution', () => {
  function fakeSsh(stdout, code = 0) {
    return jest.fn(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn();
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', code);
      });
      return child;
    });
  }
  const G_OUTPUT = 'host build-box\nuser yanis\nhostname 10.0.0.7\nport 2222\nproxyjump admin@bastion:22\nbatchmode no\n';

  test('reads user, host name, port and jump from `ssh -G -- <alias>`', async () => {
    const spawnImpl = fakeSsh(G_OUTPUT);
    const { service } = makeService({ spawnImpl, profiles: [{ id: PROFILE_ID, label: 'Box', sshConfigAlias: 'build-box' }] });
    const resolved = await service.resolveAlias(PROFILE_ID);
    expect(resolved).toEqual({ user: 'yanis', hostname: '10.0.0.7', port: 2222, proxyJump: 'admin@bastion:22', display: 'yanis@10.0.0.7:2222' });
    const [command, args] = spawnImpl.mock.calls[0];
    expect(command).toBe('ssh');
    expect(args.slice(-3)).toEqual(['-G', '--', 'build-box']);
  });

  test('a profile without an alias, or an ssh that fails, resolves to null', async () => {
    const plain = makeService({ spawnImpl: fakeSsh(G_OUTPUT) });
    expect(await plain.service.resolveAlias(PROFILE_ID)).toBeNull();
    expect(plain.service.spawnImpl).not.toHaveBeenCalled();
    const broken = makeService({ spawnImpl: fakeSsh('', 255), profiles: [{ id: PROFILE_ID, label: 'Box', sshConfigAlias: 'nope' }] });
    expect(await broken.service.resolveAlias(PROFILE_ID)).toBeNull();
  });
});
