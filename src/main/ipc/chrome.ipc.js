/**
 * Claude in Chrome IPC Handlers
 * Bridges the renderer settings UI with ChromeBridgeService.
 */

const { ipcMain, shell } = require('electron');
const chromeBridgeService = require('../services/ChromeBridgeService');

function registerChromeHandlers() {
  // Full status for the settings panel: platform support, extension presence,
  // native host state. `force` bypasses the extension-detection cache, which the
  // renderer passes after sending the user off to install it.
  ipcMain.handle('chrome-status', async (_event, { force = false } = {}) => {
    try {
      return { success: true, status: await chromeBridgeService.getStatus(force) };
    } catch (err) {
      console.error('[chrome-status] Error:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Install (or adopt) the native messaging host. Called when the user enables
  // the toggle, so the browser side is ready before the first session needs it.
  ipcMain.handle('chrome-install-host', async () => {
    try {
      // This is the one handler with a system-level side effect — it writes
      // native messaging manifests and, on Windows, HKCU keys. It re-reads the
      // opt-in rather than trusting the caller: the CSP means injected markup
      // cannot reach IPC today, and this is what keeps that from being the only
      // thing standing between a chat message and the registry.
      if (!chromeBridgeService.isEnabled()) {
        return { success: false, error: 'disabled' };
      }
      return { success: true, result: await chromeBridgeService.ensureNativeHost(true) };
    } catch (err) {
      console.error('[chrome-install-host] Error:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Remove only the manifests we wrote; one left by Claude Code stays.
  ipcMain.handle('chrome-remove-host', async () => {
    try {
      return { success: true, result: await chromeBridgeService.removeNativeHost() };
    } catch (err) {
      console.error('[chrome-remove-host] Error:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Open the Chrome Web Store listing in the user's default browser.
  ipcMain.handle('chrome-open-store', async () => {
    try {
      await shell.openExternal(chromeBridgeService.getExtensionUrl());
      return { success: true };
    } catch (err) {
      console.error('[chrome-open-store] Error:', err.message);
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerChromeHandlers };
