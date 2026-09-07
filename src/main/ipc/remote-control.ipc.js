/**
 * Claude Remote Control IPC Handlers
 *
 * Bridges the renderer with RemoteControlService: the settings panel's master
 * switch and preferences, and — the actual per-session control surface — a
 * chat tab's footer button and `/remote-control` input command enabling or
 * disabling the mirror for that one conversation.
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

  // The footer button / `/remote-control` command in one specific chat tab.
  ipcMain.handle('remote-control:enable-session', async (_event, { sessionId } = {}) => {
    try {
      return await remoteControlService.enableForSession(sessionId);
    } catch (err) {
      console.error('[remote-control:enable-session] Error:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('remote-control:disable-session', async (_event, { sessionId } = {}) => {
    try {
      return remoteControlService.disableForSession(sessionId);
    } catch (err) {
      console.error('[remote-control:disable-session] Error:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Lets a tab paint its button correctly right after it is created — the
  // push channel (`remote-control:session-status-changed`) only reaches a
  // listener that already exists at the moment something changes.
  ipcMain.handle('remote-control:session-status', async (_event, { sessionId } = {}) => {
    try {
      return { success: true, status: remoteControlService.getSessionStatus(sessionId) };
    } catch (err) {
      console.error('[remote-control:session-status] Error:', err.message);
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerRemoteControlHandlers };
