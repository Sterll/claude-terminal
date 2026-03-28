/**
 * Workspace IPC Handlers
 * Handles workspace operations for the renderer process
 */

const { ipcMain } = require('electron');
const WorkspaceService = require('../services/WorkspaceService');

function registerWorkspaceHandlers() {
  // List all workspaces
  ipcMain.handle('workspace-list', async () => {
    try {
      const workspaces = WorkspaceService.loadWorkspaces();
      return { success: true, workspaces };
    } catch (e) {
      console.error('[Workspace IPC] List error:', e);
      return { success: false, error: e.message };
    }
  });

  // Get workspace overview (workspace + docs + links)
  ipcMain.handle('workspace-overview', async (_event, { workspaceId }) => {
    try {
      const overview = WorkspaceService.getWorkspaceOverview(workspaceId);
      if (!overview) return { success: false, error: 'Workspace not found' };
      return { success: true, ...overview };
    } catch (e) {
      console.error('[Workspace IPC] Overview error:', e);
      return { success: false, error: e.message };
    }
  });

  // Search across workspace docs
  ipcMain.handle('workspace-search-docs', async (_event, { workspaceId, query }) => {
    try {
      const results = WorkspaceService.searchDocs(workspaceId, query);
      return { success: true, results };
    } catch (e) {
      console.error('[Workspace IPC] Search error:', e);
      return { success: false, error: e.message };
    }
  });

  // Read a specific doc
  ipcMain.handle('workspace-read-doc', async (_event, { workspaceId, docId }) => {
    try {
      const result = WorkspaceService.readDoc(workspaceId, docId);
      if (!result) return { success: false, error: 'Document not found' };
      return { success: true, ...result };
    } catch (e) {
      console.error('[Workspace IPC] Read doc error:', e);
      return { success: false, error: e.message };
    }
  });

  // Write/update a doc
  ipcMain.handle('workspace-write-doc', async (_event, { workspaceId, title, content }) => {
    try {
      const doc = WorkspaceService.writeDoc(workspaceId, title, content);
      return { success: true, doc };
    } catch (e) {
      console.error('[Workspace IPC] Write doc error:', e);
      return { success: false, error: e.message };
    }
  });

  // Create a new doc
  ipcMain.handle('workspace-create-doc', async (_event, { workspaceId, title, content = '' }) => {
    try {
      const doc = WorkspaceService.writeDoc(workspaceId, title, content || `# ${title}\n`);
      return { success: true, doc };
    } catch (e) {
      console.error('[Workspace IPC] Create doc error:', e);
      return { success: false, error: e.message };
    }
  });

  // Delete a doc
  ipcMain.handle('workspace-delete-doc', async (_event, { workspaceId, docId }) => {
    try {
      const deleted = WorkspaceService.deleteDoc(workspaceId, docId);
      return { success: true, deleted };
    } catch (e) {
      console.error('[Workspace IPC] Delete doc error:', e);
      return { success: false, error: e.message };
    }
  });
}

module.exports = { registerWorkspaceHandlers };
