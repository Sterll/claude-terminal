/**
 * Vault IPC Handlers
 * The user's notes vault (Obsidian-compatible), see VaultService.
 *
 * No handler takes a folder from the renderer: `vault-connect` either shows
 * the folder dialog itself or takes the id of a vault from Obsidian's own
 * list. Notes are named by vault-relative path and checked in the service.
 */

const { ipcMain, dialog, shell, BrowserWindow } = require('electron');
const VaultService = require('../services/VaultService');

function wrap(name, fn) {
  return async (event, params) => {
    try {
      return { success: true, ...(await fn(params || {}, event)) };
    } catch (e) {
      console.warn(`[Vault IPC] ${name} failed:`, e.message);
      return { success: false, error: e.message };
    }
  };
}

function registerVaultHandlers() {
  ipcMain.handle('vault-status', wrap('status', async ({ refresh }) => ({ status: await VaultService.status({ refresh: refresh === true }) })));

  ipcMain.handle('vault-known', wrap('known', async () => ({ vaults: await VaultService.knownVaults() })));

  ipcMain.handle('vault-connect', wrap('connect', async ({ knownId }, event) => {
    if (typeof knownId === 'string' && knownId) return { status: await VaultService.connectKnown(knownId) };
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { status: await VaultService.connect(result.filePaths[0]) };
  }));

  ipcMain.handle('vault-disconnect', wrap('disconnect', async () => ({ status: VaultService.disconnect() })));

  ipcMain.handle('vault-set-options', wrap('setOptions', async (opts) => ({ status: await VaultService.setOptions(opts) })));

  ipcMain.handle('vault-search', wrap('search', async ({ query, content, limit }) => VaultService.search(query, { content: content === true, limit: Number(limit) || 30 })));

  ipcMain.handle('vault-read', wrap('read', async ({ path }) => ({ note: await VaultService.read(path) })));

  ipcMain.handle('vault-resolve', wrap('resolve', async ({ target, from }) => VaultService.resolve(target, from)));

  ipcMain.handle('vault-append-daily', wrap('appendDaily', async ({ text, heading }) => VaultService.appendDaily({ text, heading })));

  ipcMain.handle('vault-create-note', wrap('createNote', async ({ title, content, folder, tags }) => VaultService.createNote({ title, content, folder, tags })));

  // Built here from a note path checked to be inside the vault: the renderer
  // never hands over a URI, and open-external stays http(s) only.
  ipcMain.handle('vault-open-in-obsidian', wrap('openInObsidian', async ({ path }) => {
    await shell.openExternal(await VaultService.obsidianUri(path));
    return {};
  }));

  ipcMain.handle('vault-reveal', wrap('reveal', async () => {
    const root = VaultService.vaultRoot();
    if (!root) throw new Error('No vault connected');
    const error = await shell.openPath(root);
    if (error) throw new Error(error);
    return {};
  }));
}

module.exports = { registerVaultHandlers };
