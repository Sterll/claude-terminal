'use strict';

// Shared by Electron and the external MCP process. An old lock is not proof
// its owner is dead. Leave abandoned locks for recovery with all writers stopped.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

function tryAcquire(file) {
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  const owner = `${process.pid} ${randomUUID()}`;
  try { fs.writeSync(fd, owner); }
  catch (error) { fs.closeSync(fd); fs.unlinkSync(file); throw error; }
  return () => {
    try {
      // Never remove a replacement lock, even if a recovery tool intervened.
      if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { fs.closeSync(fd); }
  };
}

function busy(file) {
  return Object.assign(new Error(`Storage lock is busy: ${file}. Retry; only remove an abandoned lock after stopping all app/MCP writers.`), { code: 'ELOCKED' });
}

async function withCrossProcessLock(file, fn, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = tryAcquire(file);
    if (release) {
      try { return await fn(); } finally { release(); }
    }
    if (Date.now() >= deadline) throw busy(file);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function withCrossProcessLockSync(file, fn, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const release = tryAcquire(file);
    if (release) {
      try { return fn(); } finally { release(); }
    }
    if (Date.now() >= deadline) throw busy(file);
    Atomics.wait(sleeper, 0, 0, 25);
  }
}

module.exports = { withCrossProcessLock, withCrossProcessLockSync };
