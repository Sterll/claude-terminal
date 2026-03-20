/**
 * Sync IPC Handlers
 * Bridge between renderer and SyncEngine for entity-based sync.
 */

const { ipcMain } = require('electron');
const { syncEngine } = require('../services/SyncEngine');

let mainWindow = null;

/** @type {Array<{entityType, entityId, localValue, cloudValue, cloudTimestamp, localTimestamp}>} */
let _pendingConflicts = [];

function registerSyncHandlers() {
  // Wire conflict handler: forward to renderer for user resolution
  syncEngine.onConflict(async (conflicts) => {
    _pendingConflicts = conflicts;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync:conflicts', conflicts);
    }
    // Wait for renderer to resolve (via sync:resolve-conflicts IPC)
    return new Promise((resolve) => {
      syncEngine._conflictResolver = resolve;
    });
  });

  // ── Full sync ──
  ipcMain.handle('sync:full', async () => {
    await syncEngine.fullSync();
    return { ok: true };
  });

  // ── Push a single entity ──
  ipcMain.handle('sync:push-entity', async (_event, { entityType, entityId }) => {
    syncEngine.notifyLocalChange(entityType, entityId);
    return { ok: true };
  });

  // ── Pull a conversation on-demand ──
  ipcMain.handle('sync:pull-conversation', async (_event, { sessionId, projectPath }) => {
    const data = await syncEngine.pullConversation(sessionId, projectPath);
    return data;
  });

  // ── Resolve conflicts (from renderer modal) ──
  ipcMain.handle('sync:resolve-conflicts', async (_event, resolutions) => {
    if (syncEngine._conflictResolver) {
      syncEngine._conflictResolver(resolutions);
      syncEngine._conflictResolver = null;
    }
    _pendingConflicts = [];
    return { ok: true };
  });

  // ── Get manifest (for debug / status display) ──
  ipcMain.handle('sync:get-manifest', async () => {
    return syncEngine.manifest;
  });
}

function setMainWindow(win) {
  mainWindow = win;
  syncEngine.setMainWindow(win);
}

module.exports = { registerSyncHandlers, setMainWindow };
