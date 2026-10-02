/**
 * @jest-environment node
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { FrameParser, SshLane, encodePut } = require('../../src/main/utils/sshChannel');
const { findSh, toShPath, FAKE_SSH } = require('../helpers/fake-ssh');

// ── Pure frame parser ────────────────────────────────────────────────────────

describe('FrameParser', () => {
  const nonce = '0123456789abcdef0123456789abcdef';

  function buildStream(responses) {
    const parts = [
      Buffer.from('motd line\nCT-READY-ffffffffffffffff 1\n.bashrc says hi\n', 'latin1'),
      Buffer.from([0, 255, 10, 13]),
      Buffer.from(`\nCT-READY-${nonce} 1\n`, 'latin1'),
    ];
    for (const r of responses) {
      parts.push(Buffer.from(`PID ${r.id} ${1000 + r.id}\n`, 'latin1'));
      parts.push(Buffer.from(`RES ${r.id} ${r.code} ${r.stdout.length} ${r.stderr.length}\n`, 'latin1'));
      parts.push(r.stdout, r.stderr);
    }
    return Buffer.concat(parts);
  }

  function randomResponses(rand) {
    const out = [];
    for (let id = 1; id <= 12; id++) {
      const size = Math.floor(rand() * 3000);
      const stdout = Buffer.alloc(size);
      for (let i = 0; i < size; i++) stdout[i] = Math.floor(rand() * 256);
      // Bodies that look like protocol lines must not confuse the parser.
      const stderr = id % 3 === 0 ? Buffer.from(`RES 99 0 5 5\nPID 1 2\n\u0000`, 'latin1') : Buffer.alloc(0);
      out.push({ id, code: id % 4, stdout, stderr });
    }
    return out;
  }

  function seeded(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  test('random chunk splits always yield the same events, byte-exact', () => {
    for (let round = 0; round < 40; round++) {
      const rand = seeded(round + 1);
      const responses = randomResponses(rand);
      const stream = buildStream(responses);
      const parser = new FrameParser({ nonce });
      const events = [];
      let offset = 0;
      while (offset < stream.length) {
        const size = 1 + Math.floor(rand() * (round % 2 ? 7 : 4096));
        events.push(...parser.feed(stream.subarray(offset, offset + size)));
        offset += size;
      }
      expect(events[0]).toEqual({ type: 'ready', version: 1 });
      const res = events.filter((e) => e.type === 'res');
      const pids = events.filter((e) => e.type === 'pid');
      expect(pids.map((p) => p.pid)).toEqual(responses.map((r) => 1000 + r.id));
      expect(res).toHaveLength(responses.length);
      res.forEach((e, i) => {
        expect(e.id).toBe(responses[i].id);
        expect(e.code).toBe(responses[i].code);
        expect(e.stdout.equals(responses[i].stdout)).toBe(true);
        expect(e.stderr.equals(responses[i].stderr)).toBe(true);
      });
      expect(events.some((e) => e.type === 'error')).toBe(false);
    }
  });

  test('noise before the marker is kept for diagnostics and the decoy marker is ignored', () => {
    const parser = new FrameParser({ nonce });
    parser.feed(buildStream([]));
    expect(parser.noise).toContain('motd line');
    expect(parser.state).toBe('header');
  });

  test('a response over the limit is discarded and flagged', () => {
    const parser = new FrameParser({ nonce, limitFor: () => 10 });
    const events = parser.feed(Buffer.concat([
      Buffer.from(`\nCT-READY-${nonce} 1\nRES 1 0 20 0\n`),
      Buffer.alloc(20, 65),
      Buffer.from('RES 2 0 3 0\nabc'),
    ]));
    const res = events.filter((e) => e.type === 'res');
    expect(res[0]).toMatchObject({ id: 1, overflow: true });
    expect(res[0].stdout.length).toBe(0);
    expect(res[1].stdout.toString()).toBe('abc');
  });

  test('a fail marker and garbage after ready are reported', () => {
    expect(new FrameParser({ nonce }).feed(Buffer.from(`CT-FAIL-${nonce} tmpdir\n`))).toEqual([{ type: 'fail', reason: 'tmpdir' }]);
    const events = new FrameParser({ nonce }).feed(Buffer.from(`\nCT-READY-${nonce} 1\nhello there\n`));
    expect(events[1]).toMatchObject({ type: 'error' });
  });

  test('PUT frames are base64 in short lines with a dot terminator', () => {
    const frame = encodePut(7, Buffer.alloc(100, 1));
    const lines = frame.split('\n');
    expect(lines[0]).toBe('PUT 7 100');
    expect(lines.slice(1, -2).every((l) => l.length <= 64)).toBe(true);
    expect(lines[lines.length - 2]).toBe('.');
    expect(encodePut(8, Buffer.alloc(0))).toBe('PUT 8 0\n.\n');
  });
});

// ── Lanes against a real local sh ────────────────────────────────────────────

const SH = findSh();
const describeSh = SH ? describe : describe.skip;

describeSh('SshLane against fake-ssh and a real sh', () => {
  jest.setTimeout(30000);
  let tmp;
  const lanes = [];

  function makeLane(env = {}, options = {}) {
    const lane = new SshLane({
      command: process.execPath,
      args: [FAKE_SSH, '-T', '-o', 'BatchMode=yes', '--', 'fake-host', '/bin/sh', '-s'],
      env: { ...process.env, FAKE_SSH_SH: SH, ...env },
      ...options,
    });
    lanes.push(lane);
    return lane;
  }

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-lane-'));
  });

  afterEach(() => {
    while (lanes.length) lanes.pop().close();
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('finds the ready marker after noisy rc output', async () => {
    const lane = makeLane({ FAKE_SSH_MODE: 'noisy' });
    const ready = await lane.open();
    expect(ready.version).toBe(1);
    expect(ready.noise).toContain('Welcome to fake host');
    const res = await lane.request('echo hi; echo err >&2; exit 3');
    expect(res).toMatchObject({ ok: false, code: 3 });
    expect(res.stdout.toString()).toBe('hi\n');
    expect(res.stderr.toString()).toBe('err\n');
  });

  test('NUL-containing and >64 KB outputs are byte-exact on both streams', async () => {
    const lane = makeLane();
    await lane.open();
    const data = crypto.randomBytes(300 * 1024);
    data[10] = 0; data[11] = 10; data[12] = 0;
    const file = path.join(tmp, 'blob.bin');
    fs.writeFileSync(file, data);
    const res = await lane.request(`cat '${toShPath(file)}'; cat '${toShPath(file)}' >&2`, { maxBuffer: 2 * 1024 * 1024 });
    expect(res.ok).toBe(true);
    expect(res.stdout.equals(data)).toBe(true);
    expect(res.stderr.equals(data)).toBe(true);
    const small = await lane.request("printf 'a\\000b\\377'");
    expect([...small.stdout]).toEqual([97, 0, 98, 255]);
  });

  test("an output over maxBuffer yields reason 'maxbuffer' and the lane keeps working", async () => {
    const lane = makeLane();
    await lane.open();
    const res = await lane.request('head -c 300000 /dev/zero', { maxBuffer: 64 * 1024 });
    expect(res).toMatchObject({ ok: false, reason: 'maxbuffer' });
    const next = await lane.request('echo still here');
    expect(next.stdout.toString()).toBe('still here\n');
  });

  test('two lanes run concurrently', async () => {
    const a = makeLane();
    const b = makeLane();
    await Promise.all([a.open(), b.open()]);
    const started = Date.now();
    const [ra, rb] = await Promise.all([a.request('sleep 1; echo a'), b.request('sleep 1; echo b')]);
    const elapsed = Date.now() - started;
    expect(ra.stdout.toString()).toBe('a\n');
    expect(rb.stdout.toString()).toBe('b\n');
    expect(elapsed).toBeLessThan(1900);
  });

  test("a timeout kills the remote process group and returns reason 'timeout'", async () => {
    const lane = makeLane({}, { graceMs: 4000 });
    const sibling = makeLane();
    await Promise.all([lane.open(), sibling.open()]);
    lane.setKiller((script) => sibling.request(script, { timeoutMs: 5000 }));
    const pidFile = toShPath(path.join(tmp, 'grandchild.pid'));
    const started = Date.now();
    const res = await lane.request(`sleep 30 & echo $! > '${pidFile}'; wait`, { timeoutMs: 600 });
    expect(res).toMatchObject({ ok: false, reason: 'timeout' });
    // The kill landed: the request returned well before the grace period
    // would have closed the lane, and the lane is still usable.
    expect(Date.now() - started).toBeLessThan(3500);
    expect(lane.isOpen).toBe(true);
    expect((await lane.request('echo alive')).stdout.toString()).toBe('alive\n');
    // The background grandchild was in the request's process group and died with it.
    const probe = await sibling.request(`kill -0 "$(cat '${pidFile}')" 2>/dev/null`);
    expect(probe.ok).toBe(false);
  });

  test('without a killer, a stuck request closes the lane after the grace period', async () => {
    const lane = makeLane({}, { graceMs: 300 });
    await lane.open();
    const exited = new Promise((resolve) => lane.once('exit', resolve));
    const res = await lane.request('sleep 20', { timeoutMs: 300 });
    expect(res.reason).toBe('timeout');
    const info = await exited;
    expect(info).toMatchObject({ expected: true, reason: 'stuck' });
  });

  test('PUT decodes binary input byte-exact', async () => {
    const lane = makeLane();
    await lane.open();
    const data = crypto.randomBytes(100 * 1024);
    const file = path.join(tmp, 'put.bin');
    const res = await lane.request(`cat > '${toShPath(file)}' && wc -c < '${toShPath(file)}'`, { input: data, timeoutMs: 20000 });
    expect(res.ok).toBe(true);
    expect(Number(res.stdout.toString().trim())).toBe(data.length);
    expect(fs.readFileSync(file).equals(data)).toBe(true);
    const empty = await lane.request('wc -c', { input: Buffer.alloc(0) });
    expect(Number(empty.stdout.toString().trim())).toBe(0);
  });

  test('PATH set on the lane reaches later requests', async () => {
    const lane = makeLane();
    await lane.open();
    expect((await lane.setPath('/opt/ct-test/bin:/usr/bin:/bin')).ok).toBe(true);
    const res = await lane.request('printf %s "$PATH"');
    expect(res.stdout.toString()).toBe('/opt/ct-test/bin:/usr/bin:/bin');
  });

  test('an abort signal cancels a running request; queued requests time out without running', async () => {
    const lane = makeLane({}, { graceMs: 500 });
    await lane.open();
    const controller = new AbortController();
    const running = lane.request('sleep 20', { signal: controller.signal });
    const queued = lane.request('echo never', { timeoutMs: 100 });
    expect(await queued).toMatchObject({ ok: false, reason: 'timeout' });
    controller.abort();
    expect(await running).toMatchObject({ ok: false, reason: 'cancelled' });
  });

  test('multi-line scripts are refused before anything is sent', async () => {
    const lane = makeLane();
    await lane.open();
    expect(await lane.request('echo a\necho b')).toMatchObject({ ok: false, reason: 'invalid' });
  });

  test.each([
    ['auth', 'auth'],
    ['hostkey-changed', 'hostkey-changed'],
    ['timeout', 'timeout'],
  ])('a %s failure before ready rejects open() with its classification', async (mode, kind) => {
    const lane = makeLane({ FAKE_SSH_MODE: mode });
    await expect(lane.open()).rejects.toMatchObject({ failKind: 'exit', exitCode: 255, sshFailure: kind });
  });

  test('a host that cannot run /bin/sh exits non-255 before ready', async () => {
    const lane = makeLane({ FAKE_SSH_MODE: 'nosh' });
    await expect(lane.open()).rejects.toMatchObject({ failKind: 'exit', exitCode: 1 });
  });

  test('a connection dying mid-request resolves it as disconnected', async () => {
    const lane = makeLane({ FAKE_SSH_MODE: 'die', FAKE_SSH_DIE_AFTER_MS: '800' });
    await lane.open();
    const exited = new Promise((resolve) => lane.once('exit', resolve));
    const res = await lane.request('sleep 10');
    expect(res).toMatchObject({ ok: false, reason: 'disconnected' });
    const info = await exited;
    expect(info).toMatchObject({ expected: false, code: 255, sshFailure: 'network' });
  });
});
