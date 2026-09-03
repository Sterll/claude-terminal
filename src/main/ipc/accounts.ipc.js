/**
 * Accounts IPC Handlers
 * Multi-account Claude OAuth management.
 */

const { ipcMain, BrowserWindow } = require('electron');
const AccountManager = require('../services/AccountManager');
const UsageService = require('../services/UsageService');

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

async function wrap(fn) {
  try {
    return { success: true, data: await fn() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Reading the live store can hit the macOS Keychain, so the broadcast payload
// has to be awaited too.
async function broadcastAccounts() {
  try {
    broadcast('accounts-changed', await AccountManager.listAccounts());
  } catch (err) {
    console.error('[accounts.ipc] broadcast failed:', err.message);
  }
}

function registerAccountsHandlers() {
  ipcMain.handle('accounts-list', () => wrap(() => AccountManager.listAccounts()));

  ipcMain.handle('accounts-capture', async (_event, { name } = {}) => {
    const result = await wrap(() => AccountManager.captureCurrent(name));
    if (result.success) await broadcastAccounts();
    return result;
  });

  ipcMain.handle('accounts-switch', async (_event, { id } = {}) => {
    const result = await wrap(() => AccountManager.switchTo(id));
    if (result.success) {
      // The usage figures and the cached token belong to the outgoing account.
      UsageService.invalidateCredentials();
      UsageService.refreshUsage().catch(err => console.warn('[accounts.ipc] usage refresh failed:', err.message));
      await broadcastAccounts();
    }
    return result;
  });

  ipcMain.handle('accounts-rename', async (_event, { id, name } = {}) => {
    const result = await wrap(() => AccountManager.renameAccount(id, name));
    if (result.success) await broadcastAccounts();
    return result;
  });

  ipcMain.handle('accounts-remove', async (_event, { id } = {}) => {
    const result = await wrap(() => AccountManager.removeAccount(id));
    if (result.success) await broadcastAccounts();
    return result;
  });

  ipcMain.handle('accounts-sync-active', () => wrap(() => AccountManager.syncActiveFromDisk()));
}

module.exports = { registerAccountsHandlers };
