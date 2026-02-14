/**
 * Hooks IPC Handlers
 * Handles hooks install/remove/status from renderer
 */

const { ipcMain, BrowserWindow } = require('electron');
const HooksService = require('../services/HooksService');
const hookEventServer = require('../services/HookEventServer');

function registerHooksHandlers() {
  ipcMain.handle('hooks-install', (event) => {
    const result = HooksService.installHooks();
    // Start event server when hooks are enabled
    if (result.success) {
      const win = BrowserWindow.fromWebContents(event.sender);
      hookEventServer.start(win);
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
}

module.exports = {
  registerHooksHandlers
};
