/**
 * Discord Bot IPC Handlers
 */

const { ipcMain } = require('electron');
const discordService = require('./DiscordService');

function registerHandlers() {
  ipcMain.handle('discord-start', async (event, { projectIndex, projectPath, startCommand }) => {
    return discordService.start({ projectIndex, projectPath, startCommand });
  });

  ipcMain.handle('discord-stop', async (event, { projectIndex }) => {
    return discordService.stop({ projectIndex });
  });

  ipcMain.on('discord-input', (event, { projectIndex, data }) => {
    discordService.write(projectIndex, data);
  });

  ipcMain.on('discord-resize', (event, { projectIndex, cols, rows }) => {
    discordService.resize(projectIndex, cols, rows);
  });

  ipcMain.handle('discord-detect-library', async (event, { projectPath }) => {
    return discordService.detectLibrary(projectPath);
  });

  ipcMain.handle('discord-scan-commands', async (event, { projectPath }) => {
    return discordService.scanCommands(projectPath);
  });
}

module.exports = { registerHandlers, registerDiscordHandlers: registerHandlers };
