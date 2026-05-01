/**
 * Accounts IPC Handlers
 * Multi-account Claude OAuth management.
 */

const { ipcMain, BrowserWindow } = require('electron');
const AccountManager = require('../services/AccountManager');

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function wrap(fn) {
  try {
    return { success: true, data: fn() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function registerAccountsHandlers() {
  ipcMain.handle('accounts-list', () => wrap(() => AccountManager.listAccounts()));

  ipcMain.handle('accounts-capture', (_event, { name } = {}) => {
    const result = wrap(() => AccountManager.captureCurrent(name));
    if (result.success) broadcast('accounts-changed', AccountManager.listAccounts());
    return result;
  });

  ipcMain.handle('accounts-switch', (_event, { id } = {}) => {
    const result = wrap(() => AccountManager.switchTo(id));
    if (result.success) broadcast('accounts-changed', AccountManager.listAccounts());
    return result;
  });

  ipcMain.handle('accounts-rename', (_event, { id, name } = {}) => {
    const result = wrap(() => AccountManager.renameAccount(id, name));
    if (result.success) broadcast('accounts-changed', AccountManager.listAccounts());
    return result;
  });

  ipcMain.handle('accounts-remove', (_event, { id } = {}) => {
    const result = wrap(() => AccountManager.removeAccount(id));
    if (result.success) broadcast('accounts-changed', AccountManager.listAccounts());
    return result;
  });

  ipcMain.handle('accounts-sync-active', () => wrap(() => AccountManager.syncActiveFromDisk()));
}

module.exports = { registerAccountsHandlers };
