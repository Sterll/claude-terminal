/**
 * Marketplace IPC Handlers
 * Handles marketplace skill discovery and installation
 */

const { ipcMain } = require('electron');
const MarketplaceService = require('../services/MarketplaceService');
const { sendFeaturePing } = require('../services/TelemetryService');

/**
 * Register Marketplace IPC handlers
 */
function registerMarketplaceHandlers() {
  // Search skills
  ipcMain.handle('marketplace-search', async (event, { query, limit }) => {
    try {
      const result = await MarketplaceService.searchSkills(query, limit);
      return { success: true, ...result };
    } catch (e) {
      console.error('[Marketplace IPC] Search error:', e);
      return { success: false, error: e.message };
    }
  });

  // Get featured/popular skills
  ipcMain.handle('marketplace-featured', async (event, { limit }) => {
    try {
      const result = await MarketplaceService.getFeatured(limit);
      return { success: true, ...result };
    } catch (e) {
      console.error('[Marketplace IPC] Featured error:', e);
      return { success: false, error: e.message };
    }
  });

  // Get skill README
  ipcMain.handle('marketplace-readme', async (event, { source, skillId }) => {
    try {
      const readme = await MarketplaceService.getSkillReadme(source, skillId);
      return { success: true, readme };
    } catch (e) {
      console.error('[Marketplace IPC] Readme error:', e);
      return { success: false, error: e.message };
    }
  });

  // Install a skill
  ipcMain.handle('marketplace-install', async (event, { skill }) => {
    try {
      sendFeaturePing('skill:install');
      const result = await MarketplaceService.installSkill(skill);
      return { success: true, ...result };
    } catch (e) {
      console.error('[Marketplace IPC] Install error:', e);
      return { success: false, error: e.message };
    }
  });

  // Uninstall a skill
  ipcMain.handle('marketplace-uninstall', async (event, { skillId }) => {
    try {
      const result = await MarketplaceService.uninstallSkill(skillId);
      return { success: true, ...result };
    } catch (e) {
      console.error('[Marketplace IPC] Uninstall error:', e);
      return { success: false, error: e.message };
    }
  });

  // Get installed marketplace skills
  ipcMain.handle('marketplace-installed', async () => {
    try {
      const installed = MarketplaceService.getInstalled();
      return { success: true, installed };
    } catch (e) {
      console.error('[Marketplace IPC] Installed error:', e);
      return { success: false, error: e.message };
    }
  });

  // Check for skill updates
  ipcMain.handle('marketplace-check-updates', async () => {
    try {
      const updates = await MarketplaceService.checkSkillUpdates();
      return { success: true, updates };
    } catch (e) {
      console.error('[Marketplace IPC] Check updates error:', e);
      return { success: false, error: e.message };
    }
  });
}

module.exports = { registerMarketplaceHandlers };
