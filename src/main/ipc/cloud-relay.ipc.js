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
    return { ok: true };
  });

  ipcMain.handle('cloud:disconnect', async () => {
    cloudRelayClient.disconnect();
    remoteServer.setExternalTransport(null);
    return { ok: true };
  });

  ipcMain.handle('cloud:status', async () => {
    return cloudRelayClient.getStatus();
  });

  ipcMain.on('cloud:send', (_event, data) => {
    cloudRelayClient.send(data);
  });
}

function setCloudRelayMainWindow(win) {
  mainWindow = win;
}

module.exports = { registerCloudRelayHandlers, setCloudRelayMainWindow };
