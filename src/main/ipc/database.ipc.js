/**
 * Database IPC Handlers
 * Handles database-related IPC communication
 */

const { ipcMain } = require('electron');
const databaseService = require('../services/DatabaseService');

/**
 * Register Database IPC handlers
 */
function registerDatabaseHandlers() {
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
