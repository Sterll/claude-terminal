'use strict';

/**
 * Shared access to workflows/definitions.json for the MCP tool modules.
 *
 * Both workflow.js (graph workflows) and automation.js (simple tasks) write the
 * same file, from a process that is NOT the Electron main process. Everything
 * that makes that safe lives here and only here:
 *
 *   - the cross-process lock, which must stay protocol-compatible with
 *     src/main/utils/fileLock.js (same lock path, same staleness rules);
 *   - read-modify-write under that lock, aborting rather than starting from []
 *     when the file is unreadable — a fresh [] would erase every other workflow;
 *   - the trigger-file signals the main process polls to reload its scheduler.
 *
 * A second copy of the lock in another module would be a silent drift hazard:
 * two implementations that disagree on staleness stop excluding each other.
 */

const fs = require('fs');
const path = require('path');

// -- Paths --------------------------------------------------------------------

// Falls back to the default data dir rather than '' so a server started by hand
// (without CT_DATA_DIR) reads the real workflows instead of a relative path
// under whatever the current working directory happens to be.
function getDataDir() {
  return process.env.CT_DATA_DIR || path.join(require('os').homedir(), '.claude-terminal');
}

function workflowsDir() {
  return path.join(getDataDir(), 'workflows');
}

function definitionsFile() {
  return path.join(workflowsDir(), 'definitions.json');
}

function log(...args) {
  process.stderr.write(`[ct-mcp:store] ${args.join(' ')}\n`);
}

// -- Cross-process lock (definitions.json) ------------------------------------

const LOCK_STALE_MS = 15000;
const LOCK_GIVE_UP_MS = 30000;
const LOCK_STEP_MS = 25;

function _sleepSync(ms) {
  // Real synchronous sleep without a busy CPU spin.
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* spin fallback */ } }
}

/**
 * Run `fn` while holding the shared definitions.json lock.
 * Best-effort: never hangs — breaks a stale/abandoned lock and proceeds as a
 * last resort, since a permanently stuck lock would wedge every tool.
 */
function withDefsLock(fn) {
  const lockPath = definitionsFile() + '.lock';
  const start = Date.now();
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      try { fs.writeSync(fd, `${process.pid} ${Date.now()}`); } catch (_) {}
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let ageMs = 0;
      try { ageMs = Date.now() - fs.statSync(lockPath).mtimeMs; }
      catch (_) { continue; } // vanished — retry
      if (ageMs > LOCK_STALE_MS) { try { fs.unlinkSync(lockPath); } catch (_) {} continue; }
      if (Date.now() - start > LOCK_GIVE_UP_MS) {
        try { fs.unlinkSync(lockPath); } catch (_) {}
        try { fd = fs.openSync(lockPath, 'wx'); } catch (_) { fd = null; }
        break;
      }
      _sleepSync(LOCK_STEP_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.unlinkSync(lockPath); } catch (_) {}
  }
}

// -- Definitions I/O ----------------------------------------------------------

/** All workflow definitions, unwrapped. Never throws — returns [] on failure. */
function loadDefinitions() {
  const file = definitionsFile();
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Format may be [{ workflow: {...} }] or [{id, name, ...}]
      return raw.map(entry => entry.workflow || entry);
    }
  } catch (e) {
    log('Error reading definitions.json:', e.message);
  }
  return [];
}

/**
 * Read the raw on-disk array, preserving each entry's wrapper shape.
 * Throws rather than returning a partial result: every caller is about to write
 * the array back, so guessing here would destroy the entries it guessed wrong.
 * MUST be called inside withDefsLock().
 */
function readRawDefinitions({ requireFile = false } = {}) {
  const file = definitionsFile();
  if (!fs.existsSync(file)) {
    if (requireFile) throw new Error('definitions.json does not exist — nothing to delete.');
    return [];
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read definitions.json (${e.message}). Aborting to avoid data loss.`);
  }
  let defs;
  try {
    defs = JSON.parse(raw);
  } catch (e) {
    throw new Error(`definitions.json is unparseable (${e.message}). Aborting to avoid destroying other workflows.`);
  }
  if (!Array.isArray(defs)) {
    throw new Error('definitions.json is not an array. Aborting to avoid data loss.');
  }
  return defs;
}

/** Atomic write (temp + rename). MUST be called inside withDefsLock(). */
function writeRawDefinitions(defs) {
  const file = definitionsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(defs, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Insert or replace one definition, under the lock.
 * A concurrent write from the Electron main process (WorkflowStorage) cannot
 * clobber this change, nor this one that.
 */
function upsertDefinition(workflow) {
  withDefsLock(() => {
    const defs = readRawDefinitions();
    // Entries on disk may be { workflow: {...} } wrappers or bare objects.
    // Match on both and preserve the shape, to avoid duplicating an entry.
    const idx = defs.findIndex(entry => (entry.workflow || entry).id === workflow.id);
    if (idx >= 0) {
      defs[idx] = defs[idx] && defs[idx].workflow ? { ...defs[idx], workflow } : workflow;
    } else {
      defs.push(workflow);
    }
    writeRawDefinitions(defs);
  });
}

/** Remove one definition by id, under the lock. Throws on an unreadable file. */
function removeDefinition(id) {
  withDefsLock(() => {
    const defs = readRawDefinitions({ requireFile: true });
    writeRawDefinitions(defs.filter(entry => (entry.workflow || entry).id !== id));
  });
}

/** Run history. Written by the main process only — read-only here. */
function loadHistory() {
  const file = path.join(workflowsDir(), 'history.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log('Error reading history.json:', e.message);
  }
  return [];
}

// -- Signals to the main process ----------------------------------------------

/**
 * Drop a request file the main process polls (WorkflowService._startMcpTriggerPoll).
 * Returns true on success; on failure the caller should warn that the change was
 * saved but the app may not pick it up until it is restarted.
 */
function signalMain(prefix, payload) {
  try {
    const triggerDir = path.join(workflowsDir(), 'triggers');
    if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });
    const f = path.join(triggerDir, `${prefix}_${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify({ source: 'mcp', timestamp: new Date().toISOString(), ...payload }), 'utf8');
    return true;
  } catch (e) {
    log('signalMain error:', e.message);
    return false;
  }
}

/** Ask the main process to re-read definitions.json and rearm the scheduler. */
function signalReload() {
  return signalMain('reload', { action: 'reload' });
}

/**
 * Ask the main process to clean up a deleted workflow's run history and result
 * files. Delegated rather than done here so history.json stays single-writer.
 * Falls back to a plain reload so the UI at least refreshes.
 */
function signalDeleted(workflowId) {
  return signalMain('deleted', { action: 'workflow_deleted', workflowId }) || signalReload();
}

module.exports = {
  getDataDir,
  workflowsDir,
  definitionsFile,
  withDefsLock,
  loadDefinitions,
  readRawDefinitions,
  writeRawDefinitions,
  upsertDefinition,
  removeDefinition,
  loadHistory,
  signalMain,
  signalReload,
  signalDeleted,
};
