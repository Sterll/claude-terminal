/**
 * Usage IPC Handler
 * Fetches Claude Code usage via /usage command
 */

const { ipcMain } = require('electron');
const usageService = require('../services/UsageService');

let mainWindow = null;

/**
 * Set main window reference for sending updates
 */
function setMainWindow(win) {
  mainWindow = win;
}

/**
 * Register IPC handlers
 */
function registerUsageHandlers() {
  // Get current cached usage data
  ipcMain.handle('get-usage-data', () => {
    return usageService.getUsageData();
  });

  // Force refresh usage data
  ipcMain.handle('refresh-usage', async () => {
    try {
      const data = await usageService.refreshUsage();
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Start periodic fetching
  ipcMain.handle('start-usage-monitor', (event, intervalMs) => {
    usageService.startPeriodicFetch(intervalMs || 60000);
    return { success: true };
  });

  // Stop periodic fetching
  ipcMain.handle('stop-usage-monitor', () => {
    usageService.stopPeriodicFetch();
    return { success: true };
  });

  // Push usage updates to renderer when data arrives from periodic fetch
  usageService.onUpdate((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('usage-data-updated', { data, lastFetch: new Date().toISOString() });
    }
  });

  // Proactive notification when a usage bucket crosses the threshold,
  // so the renderer can offer to switch accounts before a 429 occurs.
  usageService.onLimit((alert) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    let activeAccountId = null;
    try { activeAccountId = require('../services/AccountManager').listAccounts().activeId; } catch (_) {}
    mainWindow.webContents.send('usage-limit-reached', { ...alert, activeAccountId });
  });
}

module.exports = { registerUsageHandlers, setMainWindow };
