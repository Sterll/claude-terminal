/**
 * GitHub IPC Handlers
 * Handles GitHub authentication IPC communication
 */

const { ipcMain, shell } = require('electron');
const GitHubAuthService = require('../services/GitHubAuthService');

// Store active polling sessions
const pollingSessions = new Map();

/**
 * Register GitHub IPC handlers
 */
function registerGitHubHandlers() {
  // Start device flow
  ipcMain.handle('github-start-auth', async () => {
    console.log('[GitHub IPC] github-start-auth called');
    try {
      const deviceFlow = await GitHubAuthService.startDeviceFlow();
      console.log('[GitHub IPC] Device flow started:', deviceFlow);
      return { success: true, ...deviceFlow };
    } catch (e) {
      console.error('[GitHub IPC] Error starting device flow:', e);
      return { success: false, error: e.message };
    }
  });

  // Open verification URL in browser
  ipcMain.handle('github-open-auth-url', async (event, url) => {
    shell.openExternal(url);
    return { success: true };
  });

  // Poll for token (runs in background)
  ipcMain.handle('github-poll-token', async (event, { deviceCode, interval }) => {
    try {
      const token = await GitHubAuthService.pollForToken(deviceCode, interval);
      await GitHubAuthService.setToken(token);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Get auth status
  ipcMain.handle('github-auth-status', async () => {
    try {
      const status = await GitHubAuthService.getAuthStatus();
      return { success: true, ...status };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Logout
  ipcMain.handle('github-logout', async () => {
    try {
      await GitHubAuthService.deleteToken();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Set token manually (for PAT)
  ipcMain.handle('github-set-token', async (event, token) => {
    try {
      await GitHubAuthService.setToken(token);
      const status = await GitHubAuthService.getAuthStatus();
      return { success: true, ...status };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Get token for git operations
  ipcMain.handle('github-get-token', async () => {
    try {
      const token = await GitHubAuthService.getTokenForGit();
      return { success: true, token };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

module.exports = { registerGitHubHandlers };
