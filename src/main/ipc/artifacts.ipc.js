'use strict';

/**
 * Artifacts IPC Handlers
 * Library of artifacts produced by Claude across every session and project.
 */

const { ipcMain } = require('electron');
const ArtifactService = require('../services/ArtifactService');

function registerArtifactHandlers() {
  // The MCP tools write index.json from another process; watching it is how the
  // library panel learns about those writes.
  ArtifactService.startWatching();

  ipcMain.handle('artifacts-list', async (_event, options) => {
    try {
      const { artifacts, total } = await ArtifactService.listArtifacts(options || {});
      return { success: true, artifacts, total };
    } catch (e) {
      console.error('[Artifacts IPC] List error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('artifacts-get', async (_event, { id }) => {
    try {
      const artifact = await ArtifactService.getArtifact(id);
      if (!artifact) return { success: false, error: 'Artifact not found' };
      return { success: true, artifact };
    } catch (e) {
      console.error('[Artifacts IPC] Get error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('artifacts-versions', async (_event, { groupKey }) => {
    try {
      const versions = await ArtifactService.getVersions(groupKey);
      return { success: true, versions };
    } catch (e) {
      console.error('[Artifacts IPC] Versions error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('artifacts-save', async (_event, artifact) => {
    try {
      const result = await ArtifactService.saveArtifact(artifact || {});
      return { success: true, ...result };
    } catch (e) {
      console.error('[Artifacts IPC] Save error:', e);
      return { success: false, error: e.message };
    }
  });

  // Batch entry point used by the renderer's harvest pass.
  ipcMain.handle('artifacts-save-many', async (_event, { artifacts }) => {
    try {
      const result = await ArtifactService.saveMany(artifacts || []);
      return { success: true, created: result.created, skipped: result.skipped };
    } catch (e) {
      console.error('[Artifacts IPC] Save many error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('artifacts-delete', async (_event, { id }) => {
    try {
      const deleted = await ArtifactService.deleteArtifact(id);
      return { success: true, deleted };
    } catch (e) {
      console.error('[Artifacts IPC] Delete error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('artifacts-delete-where', async (_event, filter) => {
    try {
      const count = await ArtifactService.deleteWhere(filter || {});
      return { success: true, count };
    } catch (e) {
      console.error('[Artifacts IPC] Delete where error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('artifacts-stats', async () => {
    try {
      const stats = await ArtifactService.getStats();
      return { success: true, stats };
    } catch (e) {
      console.error('[Artifacts IPC] Stats error:', e);
      return { success: false, error: e.message };
    }
  });
}

module.exports = { registerArtifactHandlers };
