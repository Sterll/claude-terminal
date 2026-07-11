'use strict';

/**
 * Cross-process advisory file lock.
 *
 * The workflow MCP server runs in a SEPARATE process from the Electron main
 * process, yet both mutate ~/.claude-terminal/workflows/definitions.json.
 * WorkflowStorage's in-process promise chain (withFileLock) only serializes
 * writers within one process — it cannot prevent a lost update when the MCP
 * process and the main process interleave a read-modify-write on the same file.
 *
 * This module provides mutual exclusion ACROSS processes using an atomic
 * exclusive-create lock file (`open` with the 'wx' flag). A protocol-identical
 * synchronous implementation lives inline in
 * resources/mcp-servers/tools/workflow.js so both sides honour the same lock
 * path. Keep the two in sync (lock path + staleness rules).
 */

const fs = require('fs');

// A held lock older than this is treated as abandoned (holder crashed) and broken.
const STALE_MS  = 15000;
// Absolute ceiling on how long we wait before force-breaking as a last resort.
const GIVE_UP_MS = 30000;
// Poll interval while another process holds the lock.
const STEP_MS   = 25;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Acquire the lock. Returns the open file descriptor, or null if we gave up and
 * proceed unlocked (best-effort — never hang forever).
 * @param {string} lockPath
 * @returns {Promise<number|null>}
 */
async function acquire(lockPath) {
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try { fs.writeSync(fd, `${process.pid} ${Date.now()}`); } catch { /* non-fatal */ }
      return fd;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;

      // Someone holds it — break it only if it is stale (holder crashed).
      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        // Lock vanished between open and stat — retry immediately.
        continue;
      }
      if (ageMs > STALE_MS) {
        try { fs.unlinkSync(lockPath); } catch { /* someone else broke it */ }
        continue;
      }
      if (Date.now() - start > GIVE_UP_MS) {
        // Last resort: a live holder that somehow never releases. Break and go.
        try { fs.unlinkSync(lockPath); } catch {}
        try { return fs.openSync(lockPath, 'wx'); } catch { return null; }
      }
      await sleep(STEP_MS);
    }
  }
}

function release(fd, lockPath) {
  if (fd != null) { try { fs.closeSync(fd); } catch {} }
  try { fs.unlinkSync(lockPath); } catch {}
}

/**
 * Run `fn` while holding an exclusive cross-process lock on `lockPath`.
 * The lock is always released, even if `fn` throws.
 * @template T
 * @param {string} lockPath
 * @param {() => (T | Promise<T>)} fn
 * @returns {Promise<T>}
 */
async function withCrossProcessLock(lockPath, fn) {
  const fd = await acquire(lockPath);
  try {
    return await fn();
  } finally {
    release(fd, lockPath);
  }
}

module.exports = { withCrossProcessLock };
