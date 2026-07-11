'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { withCrossProcessLock } = require('../../src/main/utils/fileLock');

describe('withCrossProcessLock', () => {
  let dir;
  let lockPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-lock-'));
    lockPath = path.join(dir, 'res.lock');
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  it('returns the value produced by the critical section', async () => {
    const out = await withCrossProcessLock(lockPath, () => 42);
    expect(out).toBe(42);
  });

  it('releases the lock file after completion', async () => {
    await withCrossProcessLock(lockPath, () => 'done');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('releases the lock file even when the section throws', async () => {
    await expect(
      withCrossProcessLock(lockPath, () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('serializes overlapping critical sections (no interleave)', async () => {
    const events = [];
    const section = (id) => withCrossProcessLock(lockPath, async () => {
      events.push(`${id}:enter`);
      await new Promise(r => setTimeout(r, 30));
      events.push(`${id}:exit`);
    });

    await Promise.all([section('A'), section('B')]);

    // Whoever entered first must exit before the other enters.
    const first = events[0].split(':')[0];
    const second = first === 'A' ? 'B' : 'A';
    expect(events).toEqual([
      `${first}:enter`, `${first}:exit`,
      `${second}:enter`, `${second}:exit`,
    ]);
  });

  it('breaks a stale lock left behind by a crashed holder', async () => {
    // Simulate an abandoned lock whose mtime is well past the staleness window.
    fs.writeFileSync(lockPath, '9999 0');
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, oldTime, oldTime);

    const out = await withCrossProcessLock(lockPath, () => 'recovered');
    expect(out).toBe('recovered');
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
