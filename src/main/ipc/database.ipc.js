/**
 * Database IPC Handlers
 * Handles database-related IPC communication
 */

const { ipcMain, dialog, BrowserWindow } = require('electron');
const operations = require('../utils/cancellableOperation');
const databaseService = require('../services/DatabaseService');

/**
 * Register Database IPC handlers
 */
function registerDatabaseHandlers() {
  ipcMain.handle('database-secure-backups', async () => {
    const result = await databaseService.provisionGlobalMcp();
    return { ...result, ...(databaseService._backupMigration || { secured: 0, errors: [] }) };
  });
  ipcMain.handle('database-backup-status', () => databaseService._backupMigration || { secured: 0, errors: [] });
  ipcMain.handle('database-recover-backup', async event => {
    const backups = require('../utils/secretBackups');
    const parent = BrowserWindow.fromWebContents(event.sender);
    const choice = await dialog.showOpenDialog(parent, { defaultPath: backups.directory(), properties: ['openFile'], filters: [{ name: 'Encrypted backup', extensions: ['ctbackup'] }] });
    if (choice.canceled || !choice.filePaths[0]) return { cancelled: true };
    const restored = await backups.readArchive(choice.filePaths[0]);
    const output = await dialog.showSaveDialog(parent, { title: 'Recover decrypted backup to a file', defaultPath: require('path').basename(restored.file) + '.recovered.json' });
    if (output.canceled || !output.filePath) return { cancelled: true };
    await require('fs').promises.writeFile(output.filePath, restored.original, { mode: 0o600 });
    await require('fs').promises.chmod(output.filePath, 0o600);
    return { success: true };
  });
  operations.handle(ipcMain, 'database-export', async (_event, params, signal, progress) => {
    if (!require('../utils/rendererSecurity').permitted(params.filePath, true)) throw new Error('Export destination is not authorized');
    return require('../utils/exportTable').exportTable({ ...params, signal, progress });
  });
  ipcMain.handle('database-test-connection', async (event, config) => {
    try {
      return await databaseService.testConnection(config);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('database-connect', async (event, { id, config }) => {
    try {
      return await databaseService.connect(id, config);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('database-disconnect', async (event, { id }) => {
    try {
      return await databaseService.disconnect(id);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('database-get-schema', async (event, { id }) => {
    try {
      return await databaseService.getSchema(id);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('database-execute-query', async (event, { id, sql, limit, allowDestructive }) => {
    try {
      return await databaseService.executeQuery(id, sql, limit, { allowDestructive: !!allowDestructive });
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('database-detect', async (event, { projectPath }) => {
    try {
      return await databaseService.detectDatabases(projectPath);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('database-save-connections', async (event, { connections }) => {
    try {
      return await databaseService.saveConnections(connections);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('database-load-connections', async () => {
    try {
      return await databaseService.loadConnections();
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('database-refresh-mcp', async () => {
    try {
      return await databaseService.provisionGlobalMcp();
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('database-get-credential', async (event, { id }) => {
    try {
      return await databaseService.getCredential(id);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('database-set-credential', async (event, { id, password }) => {
    try {
      return await databaseService.setCredential(id, password);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerDatabaseHandlers };
