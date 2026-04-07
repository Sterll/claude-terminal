/**
 * Cloud Relay IPC Handlers
 * Manages CloudRelayClient lifecycle: connect, disconnect, status, send.
 * Routes cloud relay messages through RemoteServer so cloud mobiles
 * get the same experience as local Wi-Fi clients.
 */

const { ipcMain } = require('electron');
const { cloudRelayClient } = require('../services/CloudRelayClient');
const remoteServer = require('../services/RemoteServer');
const { sendFeaturePing } = require('../services/TelemetryService');
const { syncEngine } = require('../services/SyncEngine');
const { _loadSettings } = require('./cloud-shared');

let mainWindow = null;

function registerCloudRelayHandlers() {
  // Wire callbacks once (they just register listeners, not start anything)
  cloudRelayClient.onMessage((msg) => {
    // Forward cloud events to renderer
    if (msg?.type === 'cloud:project-updated' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('cloud:project-updated', msg);
    }
    // Wire sync entity change notifications
    if (msg?.type === 'sync:entity-changed' && msg.entityType) {
      syncEngine.onRemoteChange(msg.entityType);
    }
    remoteServer.handleExternalMessage(msg);
  });

  cloudRelayClient.onStatusChange((status) => {
    if (status.connected) {
      remoteServer.sendInitToTransport();
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('cloud:status-changed', status);
    }
  });

  // ── Relay connect/disconnect ──

  ipcMain.handle('cloud:connect', async (_event, { serverUrl, apiKey }) => {
    sendFeaturePing('cloud:connect');
    remoteServer.setExternalTransport(cloudRelayClient);
    cloudRelayClient.connect(serverUrl, apiKey);

    // Auto-start sync engine if enabled
    const settings = _loadSettings();
    if (settings.cloudAutoSync !== false) {
      syncEngine.start(serverUrl, apiKey).catch(err => {
        console.error('[CloudRelay] Auto-start sync failed:', err.message);
      });
    }

    return { ok: true };
  });

  ipcMain.handle('cloud:disconnect', async () => {
    syncEngine.stop();
    cloudRelayClient.disconnect();
    remoteServer.setExternalTransport(null);
    return { ok: true };
  });

  ipcMain.handle('cloud:status', async () => {
    return cloudRelayClient.getStatus();
  });

  // Fetch cloud server health (version, relay stats)
  ipcMain.handle('cloud:server-health', async () => {
    const { _getCloudConfig, _fetchCloud } = require('./cloud-shared');
    const { url, key } = _getCloudConfig();
    const res = await _fetchCloud(`${url}/health`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    return res.json();
  });

  ipcMain.on('cloud:send', (_event, data) => {
    cloudRelayClient.send(data);
  });
}

function setCloudRelayMainWindow(win) {
  mainWindow = win;
}

module.exports = { registerCloudRelayHandlers, setCloudRelayMainWindow };
