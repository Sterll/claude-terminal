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

/** Accounts whose credential store this run has already bootstrapped. */
const seededStores = new Set();

/**
 * Make sure an account has a credential store to read a token from, once per
 * run. Accounts captured before per-account stores existed have only a
 * snapshot, and without the seed they report themselves signed out forever.
 *
 * Bounded to one attempt per account because probing a store costs a Keychain
 * read on macOS, and the settings list asks for these figures on every account
 * change — a rename would otherwise re-probe every account. The explicit
 * refresh gesture lifts the bound: it exists precisely to re-examine stores
 * that have changed since (a `claude /login` on an account that had none).
 *
 * @param {string} id
 * @param {boolean} [force]
 */
async function seedStoreOnce(id, force = false) {
  if (seededStores.has(id) && !force) return;
  seededStores.add(id);
  try {
    await AccountManager.ensureAccountStore(id);
  } catch (err) {
    console.warn('[accounts.ipc] credential store seed failed:', err.message);
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

  // Usage figures for every stored account, keyed by account id, so the
  // settings list can say which account still has room before the user moves
  // a project onto it.
  //
  // Fetched in parallel: the calls are independent, and a serial sweep would
  // make the whole list wait out one account's five-second API timeout.
  //
  // `force` is the explicit refresh button, and it has to reach all the way
  // down to the credential store: a stale max-age only re-runs the API call
  // with the token already cached, which cannot notice an account that was
  // signed in again outside the app.
  ipcMain.handle('accounts-usage', (_event, { maxAgeMs, force = false } = {}) => wrap(async () => {
    const { accounts } = await AccountManager.listAccounts();
    const usage = {};
    await Promise.all(accounts.map(async (account) => {
      await seedStoreOnce(account.id, force);
      try {
        usage[account.id] = await UsageService.usageForAccount(account.id, maxAgeMs, force);
      } catch (err) {
        // One unreadable account must not blank the whole list: report it as
        // an account whose figures failed, and let the others through.
        console.warn('[accounts.ipc] usage failed for', account.id, '-', err.message);
        usage[account.id] = { accountId: account.id, data: null, stale: true, error: err.message };
      }
    }));
    return usage;
  }));

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
      // So do the Remote Control mirrors: each was minted with the outgoing
      // account's OAuth token, and its worker JWT authenticates as that account
      // until it expires.
      require('../services/RemoteControlService').onAccountChanged();
      UsageService.refreshUsage().catch(err => console.warn('[accounts.ipc] usage refresh failed:', err.message));
      await broadcastAccounts();
    }
    return result;
  });

  ipcMain.handle('accounts-set-default', async (_event, { id } = {}) => {
    const result = await wrap(() => AccountManager.setDefault(id ?? null));
    if (result.success) await broadcastAccounts();
    return result;
  });

  ipcMain.handle('accounts-update', async (_event, { id, name, color } = {}) => {
    // Only forward the keys the caller actually sent: undefined means "leave
    // it alone", and the renderer sends one field at a time.
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (color !== undefined) patch.color = color;
    const result = await wrap(() => AccountManager.updateAccount(id, patch));
    if (result.success) await broadcastAccounts();
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
