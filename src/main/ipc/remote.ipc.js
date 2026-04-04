/**
 * Remote Control IPC Handlers
 */

const { ipcMain } = require('electron');
const remoteServer = require('../services/RemoteServer');
const { sendFeaturePing } = require('../services/TelemetryService');

function registerRemoteHandlers() {
  // Get current PIN (auto-generates if expired)
  ipcMain.handle('remote:get-pin', () => {
    try {
      return { success: true, ...remoteServer.getPin() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Force-generate a new PIN
  ipcMain.handle('remote:generate-pin', () => {
    try {
      const pin = remoteServer.generatePin();
      return { success: true, ...remoteServer.getPin(), pin };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get server info (running status, port, local IPs)
  ipcMain.handle('remote:get-server-info', () => {
    try {
      return { success: true, ...remoteServer.getServerInfo() };
    } catch (err) {
      return { success: false, error: err.message, running: false };
    }
  });

  // Manually start the server (coexists with cloud relay)
  ipcMain.handle('remote:start-server', () => {
    try {
      sendFeaturePing('remote:connect');
      remoteServer._syncServerState();
      return { success: true, ...remoteServer.getServerInfo() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Manually stop the server
  ipcMain.handle('remote:stop-server', () => {
    try {
      remoteServer.stop();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Renderer notifies that projects state changed
  ipcMain.on('remote:notify-projects-updated', (_e, { projects }) => {
    remoteServer.broadcastProjectsUpdate(projects);
  });

  // Renderer notifies that a new chat session was created (from remote:open-chat-tab)
  ipcMain.on('remote:session-created', (_e, { sessionId, projectId, tabName }) => {
    remoteServer.broadcastSessionStarted({ sessionId, projectId, tabName });
  });

  // Renderer notifies that a tab was renamed
  ipcMain.on('remote:tab-renamed', (_e, { sessionId, tabName }) => {
    remoteServer.broadcastTabRenamed({ sessionId, tabName });
  });

  // Renderer pushes live time tracking data
  ipcMain.on('remote:push-time-data', (_e, { todayMs }) => {
    remoteServer.setTimeData({ todayMs });
  });

  // List connected clients with metadata
  ipcMain.handle('remote:get-clients', () => {
    try {
      return { success: true, clients: remoteServer.getConnectedClients() };
    } catch (err) {
      return { success: false, error: err.message, clients: [] };
    }
  });

  // Disconnect a specific client by short ID
  ipcMain.handle('remote:disconnect-client', (_e, { clientId }) => {
    try {
      if (!clientId || typeof clientId !== 'string') {
        return { success: false, error: 'Invalid client ID' };
      }
      const result = remoteServer.disconnectClient(clientId);
      return { success: result, error: result ? null : 'Client not found' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

}

module.exports = { registerRemoteHandlers };
