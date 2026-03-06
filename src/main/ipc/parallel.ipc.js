/**
 * Parallel Task IPC Handlers
 * Bridges renderer Parallel Task Manager with ParallelTaskService.
 */

'use strict';

const { ipcMain } = require('electron');
const parallelTaskService = require('../services/ParallelTaskService');

function registerParallelHandlers(mainWindow) {
  parallelTaskService.setMainWindow(mainWindow);

  // Start a new parallel run (async — returns runId immediately)
  ipcMain.handle('parallel-run-start', async (_e, { projectPath, mainBranch, goal, maxTasks, model, effort }) => {
    try {
      return parallelTaskService.startRun({ projectPath, mainBranch, goal, maxTasks, model, effort });
    } catch (err) {
      console.error('[parallel-run-start]', err.message);
      return { success: false, error: err.message };
    }
  });

  // Cancel an active run
  ipcMain.handle('parallel-run-cancel', async (_e, { runId }) => {
    try {
      return parallelTaskService.cancelRun(runId);
    } catch (err) {
      console.error('[parallel-run-cancel]', err.message);
      return { success: false, error: err.message };
    }
  });

  // Remove all worktrees for a finished run
  ipcMain.handle('parallel-run-cleanup', async (_e, { runId, projectPath }) => {
    try {
      return parallelTaskService.cleanupRun(runId, projectPath);
    } catch (err) {
      console.error('[parallel-run-cleanup]', err.message);
      return { success: false, error: err.message };
    }
  });

  // Load run history for a project
  ipcMain.handle('parallel-history', async (_e, { projectPath } = {}) => {
    try {
      const runs = parallelTaskService.getHistory(projectPath);
      return { success: true, runs };
    } catch (err) {
      console.error('[parallel-history]', err.message);
      return { success: false, error: err.message };
    }
  });

  console.log('[ParallelIPC] Handlers registered');
}

module.exports = { registerParallelHandlers };
