/**
 * Knowledge IPC Handlers
 * Global knowledge base shared by every project.
 */

const { ipcMain } = require('electron');
const KnowledgeService = require('../services/KnowledgeService');

function registerKnowledgeHandlers() {
  // Repair the CLAUDE.md block on boot: entries can have been written by an MCP
  // tool, or the block hand-edited, while the app was closed.
  KnowledgeService.syncToClaudeMd().catch(e =>
    console.warn('[Knowledge IPC] Initial CLAUDE.md sync failed:', e.message)
  );

  ipcMain.handle('knowledge-list', async () => {
    try {
      const { enabled, entries } = await KnowledgeService.listEntries();
      return { success: true, enabled, entries };
    } catch (e) {
      console.error('[Knowledge IPC] List error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('knowledge-get', async (_event, { ref }) => {
    try {
      const entry = await KnowledgeService.getEntry(ref);
      if (!entry) return { success: false, error: 'Entry not found' };
      return { success: true, entry };
    } catch (e) {
      console.error('[Knowledge IPC] Get error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('knowledge-write', async (_event, params) => {
    try {
      const entry = await KnowledgeService.writeEntry(params || {});
      return { success: true, entry };
    } catch (e) {
      console.error('[Knowledge IPC] Write error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('knowledge-delete', async (_event, { ref }) => {
    try {
      const deleted = await KnowledgeService.deleteEntry(ref);
      return { success: true, deleted };
    } catch (e) {
      console.error('[Knowledge IPC] Delete error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('knowledge-set-pinned', async (_event, { ref, pinned }) => {
    try {
      const entry = await KnowledgeService.setPinned(ref, pinned);
      if (!entry) return { success: false, error: 'Entry not found' };
      return { success: true, entry };
    } catch (e) {
      console.error('[Knowledge IPC] Pin error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('knowledge-set-enabled', async (_event, { enabled }) => {
    try {
      const value = await KnowledgeService.setEnabled(enabled);
      return { success: true, enabled: value };
    } catch (e) {
      console.error('[Knowledge IPC] Enable error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('knowledge-search', async (_event, { query }) => {
    try {
      const results = await KnowledgeService.searchEntries(query);
      return { success: true, results };
    } catch (e) {
      console.error('[Knowledge IPC] Search error:', e);
      return { success: false, error: e.message };
    }
  });

  // Preview the exact block injected into ~/.claude/CLAUDE.md
  ipcMain.handle('knowledge-preview', async () => {
    try {
      const block = await KnowledgeService.buildContextBlock();
      return { success: true, block };
    } catch (e) {
      console.error('[Knowledge IPC] Preview error:', e);
      return { success: false, error: e.message };
    }
  });

  // Force a rewrite of the CLAUDE.md block (repair after a manual edit)
  ipcMain.handle('knowledge-sync', async () => {
    try {
      const result = await KnowledgeService.syncToClaudeMd();
      return { success: true, ...result };
    } catch (e) {
      console.error('[Knowledge IPC] Sync error:', e);
      return { success: false, error: e.message };
    }
  });
}

module.exports = { registerKnowledgeHandlers };
