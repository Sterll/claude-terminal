/**
 * Cloud Sync IPC Handlers
 * Manages SyncEngine lifecycle and exposes sync operations to the renderer.
 */

const { ipcMain } = require('electron');
const { syncEngine } = require('../services/SyncEngine');
const { _getCloudConfig, _loadSettings } = require('./cloud-shared');

let mainWindow = null;

function registerCloudSyncHandlers() {

  // Wire SyncEngine callbacks to renderer events
  syncEngine.setCallbacks({
    onStatusChange: (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cloud:sync-status-changed', status);
      }
    },
    onConflict: (conflicts) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cloud:sync-conflict', conflicts);
      }
    },
    onProjectsMerged: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cloud:projects-reloaded');
      }
    },
    getSettings: () => _loadSettings(),
  });

  // Start sync engine
  ipcMain.handle('cloud:sync-start', async () => {
    const { url, key } = _getCloudConfig();
    await syncEngine.start(url, key);
    return { ok: true };
  });

  // Stop sync engine
  ipcMain.handle('cloud:sync-stop', async () => {
    syncEngine.stop();
    return { ok: true };
  });

  // Get sync status
  ipcMain.handle('cloud:sync-status', async () => {
    return syncEngine.getStatus();
  });

  // Force full sync
  ipcMain.handle('cloud:sync-force', async () => {
    await syncEngine.forceFullSync();
    return { ok: true };
  });

  // Force push specific entity
  ipcMain.handle('cloud:sync-push', async (_event, entityType) => {
    await syncEngine.forcePush(entityType);
    return { ok: true };
  });

  // Get pending conflicts
  ipcMain.handle('cloud:sync-get-conflicts', async () => {
    return syncEngine.getConflicts();
  });

  // Resolve one conflict
  ipcMain.handle('cloud:sync-resolve', async (_event, { entityType, resolution }) => {
    await syncEngine.resolveConflict(entityType, resolution);
    return { ok: true };
  });

  // Resolve all conflicts
  ipcMain.handle('cloud:sync-resolve-all', async (_event, resolution) => {
    await syncEngine.resolveAllConflicts(resolution);
    return { ok: true };
  });
}

function setCloudSyncMainWindow(win) {
  mainWindow = win;
}

module.exports = { registerCloudSyncHandlers, setCloudSyncMainWindow };
