'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { withCrossProcessLock, withCrossProcessLockSync } = require('../../src/main/utils/fileLock');

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

  it('never breaks an old lock or enters without ownership', async () => {
    fs.writeFileSync(lockPath, 'another owner');
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, oldTime, oldTime);
    const action = jest.fn();
    await expect(withCrossProcessLock(lockPath, action, { timeoutMs: 30 })).rejects.toMatchObject({ code: 'ELOCKED' });
    expect(() => withCrossProcessLockSync(lockPath, action, { timeoutMs: 0 })).toThrow(/lock is busy/);
    expect(action).not.toHaveBeenCalled();
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('another owner');
  });

  it('does not unlink a replacement lock when releasing', async () => {
    await withCrossProcessLock(lockPath, () => {
      fs.unlinkSync(lockPath);
      fs.writeFileSync(lockPath, 'replacement owner');
    });
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('replacement owner');
  });
});

it('serializes an external synchronous MCP writer behind an asynchronous desktop writer', async () => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-lock-process-'));
  const file = path.join(dir, 'shared.lock'), marker = path.join(dir, 'written');
  let child;
  try {
    let completion;
    await withCrossProcessLock(file, async () => {
      child = spawn(process.execPath, ['-e', `const fs = require('fs'); const { withCrossProcessLockSync } = require(${JSON.stringify(path.resolve(__dirname, '../../src/shared/file-lock.js'))}); process.stdout.write('ready'); withCrossProcessLockSync(${JSON.stringify(file)}, () => fs.writeFileSync(${JSON.stringify(marker)}, 'child'), { timeoutMs: 2000 });`], { stdio: ['ignore', 'pipe', 'pipe'] });
      completion = once(child, 'exit');
      await once(child.stdout, 'data');
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(fs.existsSync(marker)).toBe(false);
    });
    expect((await completion)[0]).toBe(0);
    expect(fs.readFileSync(marker, 'utf8')).toBe('child');
    expect(fs.existsSync(file)).toBe(false);
  } finally { child?.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
