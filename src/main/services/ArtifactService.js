'use strict';

/**
 * ArtifactService
 *
 * Main-process facade over the artifact store. The store itself lives in
 * src/shared/artifact-store.js because the MCP server process needs the exact
 * same code (see the header there); this file adds the two things only the main
 * process can do:
 *
 *   1. Broadcast `artifacts-changed` to every window after a mutation, so the
 *      library panel refreshes when an artifact is deleted from somewhere else.
 *   2. Poll for out-of-process writes. The MCP tools mutate index.json directly
 *      and have no way to reach a BrowserWindow, so the app watches the file and
 *      broadcasts on its behalf.
 */

const fs = require('fs');
const { BrowserWindow } = require('electron');
const store = require('../../shared/artifact-store');

let watcher = null;
let lastSeenMtimeMs = 0;

function broadcast(reason) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('artifacts-changed', { reason });
  }
}

/**
 * Watch index.json for writes we did not make ourselves (the MCP process).
 * fs.watch fires more than once per logical write, so changes are collapsed by
 * mtime and debounced.
 */
function startWatching() {
  if (watcher) return;
  try {
    fs.mkdirSync(store.ARTIFACTS_DIR, { recursive: true });
    let timer = null;
    watcher = fs.watch(store.ARTIFACTS_DIR, (_event, filename) => {
      if (filename && filename !== 'index.json') return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(store.INDEX_FILE).mtimeMs; } catch { return; }
        if (mtimeMs === lastSeenMtimeMs) return;
        lastSeenMtimeMs = mtimeMs;
        broadcast('external');
      }, 250);
    });
  } catch (e) {
    // A missing watch is a missing refresh, not a broken feature.
    console.warn('[Artifacts] index watch unavailable:', e.message);
  }
}

function stopWatching() {
  if (!watcher) return;
  try { watcher.close(); } catch { /* ignore */ }
  watcher = null;
}

/** Remember our own write so the watcher does not echo it back as external. */
function markSelfWrite() {
  try { lastSeenMtimeMs = fs.statSync(store.INDEX_FILE).mtimeMs; } catch { /* ignore */ }
}

async function saveArtifact(input) {
  const result = await store.saveArtifact(input);
  if (result.created) { markSelfWrite(); broadcast('save'); }
  return result;
}

async function saveMany(inputs) {
  const result = await store.saveMany(inputs);
  if (result.created.length) { markSelfWrite(); broadcast('save'); }
  return result;
}

async function deleteArtifact(id) {
  const deleted = await store.deleteArtifact(id);
  if (deleted) { markSelfWrite(); broadcast('delete'); }
  return deleted;
}

async function deleteWhere(filter) {
  const count = await store.deleteWhere(filter);
  if (count) { markSelfWrite(); broadcast('delete'); }
  return count;
}

module.exports = {
  // reads pass straight through
  listArtifacts: store.listArtifacts,
  getArtifact: store.getArtifact,
  getVersions: store.getVersions,
  getStats: store.getStats,
  KINDS: store.KINDS,
  ARTIFACTS_DIR: store.ARTIFACTS_DIR,
  // writes broadcast
  saveArtifact,
  saveMany,
  deleteArtifact,
  deleteWhere,
  // lifecycle
  startWatching,
  stopWatching,
};
