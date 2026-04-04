/**
 * Cloud Relay IPC Handlers
 * Manages CloudRelayClient lifecycle: connect, disconnect, status, send.
 * Routes cloud relay messages through RemoteServer so cloud mobiles
 * get the same experience as local Wi-Fi clients.
 */

const { ipcMain } = require('electron');
const { cloudRelayClient } = require('../services/CloudRelayClient');
const remoteServer = require('../services/RemoteServer');
const cloudSyncService = require('../services/CloudSyncService');
const { syncEngine } = require('../services/SyncEngine');
const { sendFeaturePing } = require('../services/TelemetryService');
const { getMachineId } = require('../utils/machineId');
const { _loadSettings } = require('./cloud-shared');

let mainWindow = null;

function registerCloudRelayHandlers() {
  // Wire callbacks once (they just register listeners, not start anything)
  cloudRelayClient.onMessage((msg) => {
    // Forward cloud events to renderer
    if (msg?.type === 'cloud:project-updated' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('cloud:project-updated', msg);
    }
    remoteServer.handleExternalMessage(msg);
  });

  cloudRelayClient.onStatusChange((status) => {
    if (status.connected) {
      remoteServer.sendInitToTransport();
      cloudSyncService.start();
      // Start entity sync engine
      const settings = _loadSettings();
      syncEngine.start(settings.cloudServerUrl, settings.cloudApiKey);
      // Trigger full sync on connect
      setImmediate(() => syncEngine.fullSync());
      // Check for pending changes from headless sessions
      setImmediate(() => _checkPendingChangesOnReconnect());
      // Auto-sync skills if enabled
      setImmediate(async () => {
        try {
          if (settings.cloudSyncSkills) {
            const { _syncSkillsToCloud } = require('./cloud-projects.ipc');
            const result = await _syncSkillsToCloud();
            console.log(`[Cloud] Auto skills sync: ${result.skillCount} skill(s), ${result.agentCount} agent(s)`);
          }
        } catch (e) {
          console.warn('[Cloud] Auto skills sync failed:', e.message);
        }
      });
    } else {
      syncEngine.stop();
    }
    // Note: we do NOT call setExternalTransport(null) here on disconnect because
    // CloudRelayClient auto-reconnects. Only explicit cloud:disconnect clears it.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('cloud:status-changed', status);
    }
  });

  // ── Relay connect/disconnect ──

  ipcMain.handle('cloud:connect', async (_event, { serverUrl, apiKey }) => {
    sendFeaturePing('cloud:connect');
    remoteServer.setExternalTransport(cloudRelayClient);
    cloudRelayClient.connect(serverUrl, apiKey);
    return { ok: true };
  });

  ipcMain.handle('cloud:disconnect', async () => {
    cloudRelayClient.disconnect();
    remoteServer.setExternalTransport(null);
    cloudSyncService.stop();
    syncEngine.stop();
    return { ok: true };
  });

  ipcMain.handle('cloud:status', async () => {
    return cloudRelayClient.getStatus();
  });

  ipcMain.handle('cloud:get-machine-id', async () => {
    return getMachineId();
  });

  ipcMain.on('cloud:send', (_event, data) => {
    cloudRelayClient.send(data);
  });
}

// ── Helpers ──

async function _checkPendingChangesOnReconnect() {
  try {
    const { _getCloudConfig, _fetchCloud } = require('./cloud-shared');
    const { url, key } = _getCloudConfig();
    const headers = { 'Authorization': `Bearer ${key}` };

    // Check for active headless sessions
    const sessionsResp = await _fetchCloud(`${url}/api/sessions`, { headers });
    if (sessionsResp.ok) {
      const { sessions } = await sessionsResp.json();
      const activeSessions = sessions.filter(s => s.status === 'running');
      if (activeSessions.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cloud:headless-active', { sessions: activeSessions });
      }
    }

    // Pending file changes are now handled exclusively by CloudSyncService polling
    // (avoids duplicate cloud:pending-changes events)
  } catch (err) {
    console.warn('[Cloud] Failed to check pending changes on reconnect:', err.message);
  }
}

function setCloudRelayMainWindow(win) {
  mainWindow = win;
}

module.exports = { registerCloudRelayHandlers, setCloudRelayMainWindow };
