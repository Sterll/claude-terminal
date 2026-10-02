/**
 * Terminal IPC Handlers
 * Handles terminal-related IPC communication
 */

const { ipcMain } = require('electron');
const AccountManager = require('../services/AccountManager');
const terminalService = require('../services/TerminalService');
const { sendFeaturePing } = require('../services/TelemetryService');
const { isRemotePath } = require('../../shared/remote-path');

/**
 * Register terminal IPC handlers
 */
function registerTerminalHandlers() {
  // Create terminal
  ipcMain.handle('terminal-create', async (event, { cwd, runClaude, skipPermissions, resumeSessionId, projectId, projectPath, accountId }) => {
    try {
      // A remote (ssh-remote://) cwd does not exist locally, and create() falls
      // back to the home directory for a missing cwd: that would be a local
      // shell posing as the remote project. Refused until remote terminals land.
      if (isRemotePath(cwd) || isRemotePath(projectPath)) {
        return { success: false, error: 'Terminals are not available for remote projects yet' };
      }
      sendFeaturePing('terminal:create');
      // Resolved here rather than inside create(), which stays synchronous:
      // reading an account's store can hit the Keychain.
      const accountEnv = await AccountManager.accountEnv(accountId || null);
      return terminalService.create({ cwd, runClaude, skipPermissions, resumeSessionId, projectId, projectPath, accountEnv });
    } catch (error) {
      console.error('[Terminal IPC] Create error:', error);
      return { success: false, error: error.message };
    }
  });

  // Terminal input
  ipcMain.on('terminal-input', (event, { id, data }) => {
    terminalService.write(id, data);
  });

  // Terminal resize
  ipcMain.on('terminal-resize', (event, { id, cols, rows }) => {
    terminalService.resize(id, cols, rows);
  });

  // Kill terminal
  ipcMain.on('terminal-kill', (event, { id }) => {
    terminalService.kill(id);
  });
}

module.exports = { registerTerminalHandlers };
