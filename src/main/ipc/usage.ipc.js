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
  // Figures are per account: the caller says which one it is showing, and
  // omitting it means the machine-wide login that unbound projects run as.
  ipcMain.handle('get-usage-data', (_event, accountId = null) => {
    return usageService.getUsageData(accountId);
  });

  // The poller only refreshes the account on screen.
  ipcMain.handle('set-usage-focus', (_event, accountId = null) => {
    usageService.setFocusedAccount(accountId);
    return { success: true };
  });

  // Force refresh usage data.
  // refreshUsage() resolves with cached data when the API call fails, so a
  // resolved promise is NOT proof the numbers are current — ask the service
  // whether the fetch actually succeeded before reporting success. Otherwise an
  // expired OAuth token or a moved endpoint shows the same percentages forever.
  ipcMain.handle('refresh-usage', async (_event, accountId = null) => {
    try {
      const data = await usageService.refreshUsage(accountId);
      const fetchState = typeof usageService.getFetchState === 'function'
        ? usageService.getFetchState(accountId)
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

      return { success: true, data, accountId };
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
  usageService.onUpdate((data, accountId) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      // The renderer drops a payload for an account it is no longer showing —
      // a background refresh must not repaint the titlebar with another
      // account's numbers.
      mainWindow.webContents.send('usage-data-updated', { data, accountId, lastFetch: new Date().toISOString() });
    }
  });

  // Proactive notification when a usage bucket crosses the threshold,
  // so the renderer can offer to switch accounts before a 429 occurs.
  usageService.onLimit(async (alert) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // The alert names the account it was measured for. Falling back to the
    // default only covers the machine-wide login, whose figures it is.
    let activeAccountId = alert.accountId || null;
    if (!activeAccountId) {
      try { activeAccountId = (await require('../services/AccountManager').listAccounts()).defaultId; } catch (_) {}
    }
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('usage-limit-reached', { ...alert, activeAccountId });
  });
}

module.exports = { registerUsageHandlers, setMainWindow };
