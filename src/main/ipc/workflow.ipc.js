/**
 * Workflow IPC Handlers
 * Bridges renderer ↔ WorkflowService for all workflow operations.
 *
 * Channels (invoke):
 *   workflow-list              → listWorkflows()
 *   workflow-get               → getWorkflow(id)
 *   workflow-save              → saveWorkflow(workflow)
 *   workflow-delete            → deleteWorkflow(id)
 *   workflow-enable            → setEnabled(id, true/false)
 *   workflow-trigger           → trigger(id, opts)
 *   workflow-cancel            → cancel(runId)
 *   workflow-approve-wait      → approveWait(runId, stepId, data)
 *   workflow-runs              → getRunsForWorkflow(workflowId, limit)
 *   workflow-recent-runs       → getRecentRuns(limit)
 *   workflow-run-get           → getRun(runId)
 *   workflow-run-result        → getRunResult(runId)
 *   workflow-active-runs       → getActiveRuns()
 *   workflow-dependency-graph  → getDependencyGraph()
 *   workflow-validate-cron     → validate a cron expression (no-exec)
 *
 * Channels (on — one-way from renderer):
 *   (none for now — all operations are request/response)
 *
 * Channels emitted TO renderer (via WorkflowService._send):
 *   workflow-run-start         { run }
 *   workflow-run-end           { runId, workflowId, status, duration, error }
 *   workflow-run-queued        { workflowId, queueLength }
 *   workflow-step-update       { runId, stepId, stepType, status, output, attempt }
 *   workflow-agent-message     { runId, stepId, message }
 *   workflow-notify-desktop    { title, message, type }
 */

'use strict';

const { ipcMain } = require('electron');
const workflowService = require('../services/WorkflowService');

/**
 * Serialize a function to a string that can be reconstructed via
 * new Function('return (' + str + ')')() on the renderer side.
 * Handles both arrow/regular functions AND shorthand methods.
 * Shorthand: "render(a, b) { ... }" → "function render(a, b) { ... }"
 */
function _serializeFn(fn) {
  const s = fn.toString().replace(/\r\n/g, '\n');
  // Shorthand method: "render(a, b) { ... }" — starts with an identifier
  // directly followed by '(', without a 'function' keyword prefix.
  // We cannot use includes('=>') to exclude arrows because the function body
  // may itself contain arrow functions (e.g. .map(t => ...)).
  // Instead: check only the very first token.
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(/.test(s) && !s.startsWith('function') && !s.startsWith('async')) {
    return 'function ' + s;
  }
  return s;
}

function registerWorkflowHandlers(mainWindow) {
  // Inject main window so service can emit events
  workflowService.setMainWindow(mainWindow);

  // ── CRUD ────────────────────────────────────────────────────────────────────

  ipcMain.handle('workflow-list', async () => {
    try {
      return { success: true, workflows: await workflowService.listWorkflows() };
    } catch (err) {
      console.error('[workflow-list]', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('workflow-get', async (_e, { id }) => {
    try {
      const workflow = await workflowService.getWorkflow(id);
      if (!workflow) return { success: false, error: 'Not found' };
      return { success: true, workflow };
    } catch (err) {
      console.error('[workflow-get]', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('workflow-save', async (_e, { workflow }) => {
    try {
      return await workflowService.saveWorkflow(workflow);
    } catch (err) {
      console.error('[workflow-save]', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('workflow-delete', async (_e, { id }) => {
    try {
      return await workflowService.deleteWorkflow(id);
    } catch (err) {
      console.error('[workflow-delete]', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('workflow-enable', async (_e, { id, enabled }) => {
    try {
      return await workflowService.setEnabled(id, enabled);
    } catch (err) {
      console.error('[workflow-enable]', err.message);
      return { success: false, error: err.message };
    }
  });

  // ── Execution ────────────────────────────────────────────────────────────────

  ipcMain.handle('workflow-trigger', async (_e, { id, opts }) => {
    try {
      return await workflowService.trigger(id, { ...opts, source: 'manual' });
    } catch (err) {
      console.error('[workflow-trigger]', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('workflow-test-node', async (_e, { step, ctx }) => {
    try {
      return await workflowService.testNode(step, ctx || {});
    } catch (err) {
      console.error('[workflow-test-node]', err.message);
      return { success: false, error: err.message, duration: 0 };
    }
  });

  ipcMain.handle('workflow-cancel', async (_e, { runId }) => {
    try {
      return workflowService.cancel(runId);
    } catch (err) {
      console.error('[workflow-cancel]', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('workflow-approve-wait', async (_e, { runId, stepId, data }) => {
    try {
      return workflowService.approveWait(runId, stepId, data);
    } catch (err) {
      console.error('[workflow-approve-wait]', err.message);
      return { success: false, error: err.message };
    }
  });

  // ── History ──────────────────────────────────────────────────────────────────

  ipcMain.handle('workflow-runs', async (_e, { workflowId, limit }) => {
    try {
      return { success: true, runs: await workflowService.getRunsForWorkflow(workflowId, limit) };
    } catch (err) {
      console.error('[workflow-runs]', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('workflow-recent-runs', async (_e, { limit } = {}) => {
    try {
      return { success: true, runs: await workflowService.getRecentRuns(limit) };
    } catch (err) {
      console.error('[workflow-recent-runs]', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('workflow-clear-runs', async () => {
    try {
      await workflowService.clearAllRuns();
      return { success: true };
    } catch (err) {
      console.error('[workflow-clear-runs]', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('workflow-run-get', async (_e, { runId }) => {
    try {
      const run = await workflowService.getRun(runId);
      if (!run) return { success: false, error: 'Run not found' };
      return { success: true, run };
    } catch (err) {
      console.error('[workflow-run-get]', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('workflow-run-result', async (_e, { runId }) => {
    try {
      const result = await workflowService.getRunResult(runId);
      return { success: true, result };
    } catch (err) {
      console.error('[workflow-run-result]', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('workflow-active-runs', async () => {
    try {
      return { success: true, runs: workflowService.getActiveRuns() };
    } catch (err) {
      console.error('[workflow-active-runs]', err.message);
      return { success: false, error: err.message };
    }
  });

  // ── Dependency graph ─────────────────────────────────────────────────────────

  ipcMain.handle('workflow-dependency-graph', async () => {
    try {
      return { success: true, graph: await workflowService.getDependencyGraph() };
    } catch (err) {
      console.error('[workflow-dependency-graph]', err.message);
      return { success: false, error: err.message };
    }
  });

  // ── Utilities ────────────────────────────────────────────────────────────────

  ipcMain.handle('workflow-validate-cron', async (_e, { expr }) => {
    try {
      const fields = (expr || '').trim().split(/\s+/);
      if (fields.length !== 5) {
        return { success: false, valid: false, error: 'Cron must have 5 fields: min hour dom month dow' };
      }
      const validField = /^[0-9*,\-/]+$/;
      for (const f of fields) {
        if (!validField.test(f)) {
          return { success: false, valid: false, error: `Invalid cron field: "${f}"` };
        }
      }
      return { success: true, valid: true };
    } catch (err) {
      return { success: false, valid: false, error: err.message };
    }
  });

  // ── Project opened event (forwarded to scheduler for project_opened trigger) ──

  ipcMain.on('workflow-notify-project-opened', (_e, payload = {}) => {
    try {
      if (payload && payload.projectId) {
        workflowService.onProjectOpened(payload);
      }
    } catch (err) {
      console.warn('[workflow-notify-project-opened]', err.message);
    }
  });

  // ── Node Registry ─────────────────────────────────────────────────────────

  ipcMain.handle('workflow:get-node-registry', () => {
    const registry = require('../workflow-nodes/_registry');
    registry.loadRegistry();
    return registry.getAll().map(def => ({
      type:      def.type,
      title:     def.title,
      desc:      def.desc,
      color:     def.color,
      width:     def.width      || 200,
      category:  def.category   || 'actions',
      icon:      def.icon       || '',
      inputs:    def.inputs     || [],
      outputs:   def.outputs    || [],
      props:     def.props      || {},
      fields:    (def.fields || []).map(f => ({
        ...f,
        // showIf, render, bind sont des fonctions → sérialiser en string pour re-eval côté renderer
        // Les méthodes shorthand (ex: render(a,b){}) ne sont pas des expressions valides —
        // on les préfixe avec 'function' pour que new Function('return (fn)')() fonctionne.
        showIf: f.showIf ? _serializeFn(f.showIf) : undefined,
        render: f.render ? _serializeFn(f.render) : undefined,
        bind:   f.bind   ? _serializeFn(f.bind)   : undefined,
      })),
      dynamic:   def.dynamic   || null,
      removable: def.removable !== false,
      resizable: def.resizable !== false,
    }));
  });

  console.log('[WorkflowIPC] Handlers registered');
}

/**
 * Forward a hook event from HookEventServer to WorkflowService.
 * Called from main.js after HookEventServer emits.
 * @param {Object} hookEvent
 */
function forwardHookEvent(hookEvent) {
  workflowService.onHookEvent(hookEvent);
}

module.exports = { registerWorkflowHandlers, forwardHookEvent };
