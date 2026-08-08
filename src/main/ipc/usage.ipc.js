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

  // Force refresh usage data.
  // refreshUsage() resolves with cached data when the API call fails, so a
  // resolved promise is NOT proof the numbers are current — ask the service
  // whether the fetch actually succeeded before reporting success. Otherwise an
  // expired OAuth token or a moved endpoint shows the same percentages forever.
  ipcMain.handle('refresh-usage', async () => {
    try {
      const data = await usageService.refreshUsage();
      const fetchState = typeof usageService.getFetchState === 'function'
        ? usageService.getFetchState()
        : null;

      if (fetchState && fetchState.stale) {
        return {
          success: false,
          stale: true,
          data: data || null,
          lastFetch: fetchState.lastFetch,
          error: fetchState.error || 'Usage API unreachable'
        };
      }

      if (!data) {
        return {
          success: false,
          stale: true,
          data: null,
          error: (fetchState && fetchState.error) || 'No usage data available'
        };
      }

      return { success: true, data };
    } catch (error) {
      return { success: false, error: error && error.message };
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
