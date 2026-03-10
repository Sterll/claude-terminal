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
    return databaseService.testConnection(config);
  });

  ipcMain.handle('database-connect', async (event, { id, config }) => {
    return databaseService.connect(id, config);
  });

  ipcMain.handle('database-disconnect', async (event, { id }) => {
    return databaseService.disconnect(id);
  });

  ipcMain.handle('database-get-schema', async (event, { id }) => {
    return databaseService.getSchema(id);
  });

  ipcMain.handle('database-execute-query', async (event, { id, sql, limit, allowDestructive }) => {
    return databaseService.executeQuery(id, sql, limit, { allowDestructive: !!allowDestructive });
  });

  ipcMain.handle('database-detect', async (event, { projectPath }) => {
    return databaseService.detectDatabases(projectPath);
  });

  ipcMain.handle('database-save-connections', async (event, { connections }) => {
    return databaseService.saveConnections(connections);
  });

  ipcMain.handle('database-load-connections', async () => {
    return databaseService.loadConnections();
  });

  ipcMain.handle('database-refresh-mcp', async () => {
    return databaseService.provisionGlobalMcp();
  });

  ipcMain.handle('database-get-credential', async (event, { id }) => {
    return databaseService.getCredential(id);
  });

  ipcMain.handle('database-set-credential', async (event, { id, password }) => {
    return databaseService.setCredential(id, password);
  });
}

module.exports = { registerDatabaseHandlers };
