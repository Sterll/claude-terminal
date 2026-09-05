/**
 * Claude Remote Control IPC Handlers
 *
 * Bridges the renderer settings UI with RemoteControlService, and hands the
 * service its chat event stream at registration time so mirroring is live from
 * the first session rather than from the first time settings are opened.
 *
 * Not to be confused with `remote.ipc.js`, which serves the app's own mobile
 * PWA over the local network. This one is Claude Code's Remote Control: the
 * bridge that puts a session on claude.ai and in the Claude mobile app.
 */

const { ipcMain } = require('electron');
const remoteControlService = require('../services/RemoteControlService');
const chatService = require('../services/ChatService');

function registerRemoteControlHandlers() {
  // Subscribing here rather than lazily means a session started before the
  // settings panel has ever been opened is still mirrored.
  remoteControlService.attachToChatService(chatService);

  // Full status for the settings panel: whether the SDK can serve the bridge at
  // all, whether policy forbids it, and the last failure worth showing.
  ipcMain.handle('remote-control:status', async () => {
    try {
      return { success: true, status: await remoteControlService.getStatus() };
    } catch (err) {
      console.error('[remote-control:status] Error:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Called after the user flips the toggle off. Existing mirrors are dropped
  // immediately: leaving them running would keep streaming a transcript the
  // user has just asked to stop sharing.
  ipcMain.handle('remote-control:disable', async () => {
    try {
      remoteControlService.shutdown();
      return { success: true };
    } catch (err) {
      console.error('[remote-control:disable] Error:', err.message);
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerRemoteControlHandlers };
