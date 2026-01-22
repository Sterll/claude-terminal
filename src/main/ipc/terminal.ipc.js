/**
 * Terminal IPC Handlers
 * Handles terminal-related IPC communication
 */

const { ipcMain } = require('electron');
const terminalService = require('../services/TerminalService');

/**
 * Register terminal IPC handlers
 */
function registerTerminalHandlers() {
  // Create terminal
  ipcMain.handle('terminal-create', (event, { cwd, runClaude, skipPermissions, resumeSessionId }) => {
    return terminalService.create({ cwd, runClaude, skipPermissions, resumeSessionId });
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
