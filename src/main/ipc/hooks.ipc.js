/**
 * Hooks IPC Handlers
 * Handles hooks install/remove/status from renderer
 */

const { ipcMain, BrowserWindow } = require('electron');
const HooksService = require('../services/HooksService');
const hookEventServer = require('../services/HookEventServer');
const { sendFeaturePing } = require('../services/TelemetryService');

function registerHooksHandlers() {
  ipcMain.handle('hooks-install', (event) => {
    const result = HooksService.installHooks();
    // Start event server when hooks are enabled
    if (result.success) {
      sendFeaturePing('hooks:install');
      const win = BrowserWindow.fromWebContents(event.sender);
      try {
        hookEventServer.start(win);
      } catch (err) {
        result.eventServerError = err.message;
      }
    }
    return result;
  });

  ipcMain.handle('hooks-remove', () => {
    const result = HooksService.removeHooks();
    // Stop event server when hooks are disabled
    if (result.success) {
      hookEventServer.stop();
    }
    return result;
  });

  ipcMain.handle('hooks-status', () => {
    return HooksService.areHooksInstalled();
  });

  ipcMain.handle('hooks-verify', () => {
    return HooksService.verifyAndRepairHooks();
  });

  // Resolve a pending PermissionRequest from the renderer side
  // (e.g., when a question notification was deduped and we need to unblock the hook handler)
  ipcMain.on('hooks-resolve-permission', (event, { requestId, decision }) => {
    if (!requestId) return;
    const resolved = hookEventServer.resolvePendingPermission(requestId, decision || 'allow');
    if (!resolved) {
      console.debug(`[HooksIPC] No pending permission found for requestId=${requestId}`);
    }
  });
}

module.exports = {
  registerHooksHandlers
};
