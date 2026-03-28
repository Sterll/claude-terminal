/**
 * Plugin IPC Handlers
 * Handles Claude Code plugin data retrieval
 */

const { ipcMain } = require('electron');
const PluginService = require('../services/PluginService');
const { sendFeaturePing } = require('../services/TelemetryService');

function registerPluginHandlers() {
  ipcMain.handle('plugin-installed', async () => {
    try {
      const installed = PluginService.getInstalledPlugins();
      return { success: true, installed };
    } catch (e) {
      console.error('[Plugin IPC] Installed error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('plugin-catalog', async () => {
    try {
      const catalog = PluginService.getCatalog();
      return { success: true, catalog };
    } catch (e) {
      console.error('[Plugin IPC] Catalog error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('plugin-marketplaces', async () => {
    try {
      const marketplaces = PluginService.getMarketplaces();
      return { success: true, marketplaces };
    } catch (e) {
      console.error('[Plugin IPC] Marketplaces error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('plugin-readme', async (event, { marketplace, pluginName }) => {
    try {
      const readme = PluginService.getPluginReadme(marketplace, pluginName);
      return { success: true, readme };
    } catch (e) {
      console.error('[Plugin IPC] Readme error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('plugin-install', async (event, { marketplace, pluginName }) => {
    try {
      sendFeaturePing('plugin:install');
      return await PluginService.installPlugin(marketplace, pluginName);
    } catch (e) {
      console.error('[Plugin IPC] Install error:', e);
      return { success: false, error: e.message };
    }
  });

ipcMain.handle('plugin-uninstall', async (event, { pluginKey }) => {
    try {
      sendFeaturePing('plugin:uninstall');
      return await PluginService.uninstallPlugin(pluginKey);
    } catch (e) {
      console.error('[Plugin IPC] Uninstall error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('plugin-add-marketplace', async (event, { url }) => {
    try {
      return await PluginService.addMarketplace(url);
    } catch (e) {
      console.error('[Plugin IPC] Add marketplace error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('plugin-check-updates', async () => {
    try {
      const updates = PluginService.checkPluginUpdates();
      return { success: true, updates };
    } catch (e) {
      console.error('[Plugin IPC] Check updates error:', e);
      return { success: false, error: e.message };
    }
  });
}

module.exports = { registerPluginHandlers };
