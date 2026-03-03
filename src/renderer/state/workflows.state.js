/**
 * Workflows State Module
 * Manages workflow definitions, run history, and live execution state.
 *
 * Shape:
 *   workflows      Object[]  — saved workflow definitions
 *   runs           Object[]  — recent run history (from disk + live)
 *   activeRuns     Object[]  — currently executing runs
 *   selectedId     string|null — workflow selected in list
 *   selectedRunId  string|null — run selected in history detail
 */

'use strict';

const { State } = require('./State');

// ─── Initial state ────────────────────────────────────────────────────────────

const initialState = {
  workflows:     [],
  runs:          [],
  activeRuns:    [],
  selectedId:    null,
  selectedRunId: null,
};

const workflowsState = new State(initialState);

// ─── Workflows ────────────────────────────────────────────────────────────────

function getWorkflows() {
  return workflowsState.get().workflows;
}

function setWorkflows(workflows) {
  workflowsState.setProp('workflows', workflows);
}

function getWorkflow(id) {
  return workflowsState.get().workflows.find(w => w.id === id) || null;
}

function upsertWorkflow(workflow) {
  const all = workflowsState.get().workflows;
  const idx = all.findIndex(w => w.id === workflow.id);
  const next = idx >= 0
    ? all.map((w, i) => i === idx ? workflow : w)
    : [...all, workflow];
  workflowsState.setProp('workflows', next);
}

function removeWorkflow(id) {
  workflowsState.setProp(
    'workflows',
    workflowsState.get().workflows.filter(w => w.id !== id)
  );
}

function updateWorkflowEnabled(id, enabled) {
  upsertWorkflow({ ...getWorkflow(id), enabled });
}

// ─── Run history ──────────────────────────────────────────────────────────────

function getRuns() {
  return workflowsState.get().runs;
}

function setRuns(runs) {
  workflowsState.setProp('runs', runs);
}

function getRunsForWorkflow(workflowId) {
  return workflowsState.get().runs.filter(r => r.workflowId === workflowId);
}

/** Prepend a new run and keep list bounded (soft cap: 200 in UI) */
function prependRun(run) {
  const runs = [run, ...workflowsState.get().runs].slice(0, 200);
  workflowsState.setProp('runs', runs);
}

/** Patch a run by id (e.g. finalize status) */
function patchRun(runId, patch) {
  const runs = workflowsState.get().runs.map(r =>
    r.id === runId ? { ...r, ...patch } : r
  );
  workflowsState.setProp('runs', runs);
}

/** Update a step within a run */
function patchRunStep(runId, stepId, patch) {
  const runs = workflowsState.get().runs.map(r => {
    if (r.id !== runId) return r;
    return {
      ...r,
      steps: (r.steps || []).map(s =>
        s.id === stepId ? { ...s, ...patch } : s
      ),
    };
  });
  workflowsState.setProp('runs', runs);
}

// ─── Active runs ──────────────────────────────────────────────────────────────

function getActiveRuns() {
  return workflowsState.get().activeRuns;
}

function addActiveRun(run) {
  const activeRuns = [...workflowsState.get().activeRuns, run];
  workflowsState.setProp('activeRuns', activeRuns);
}

function removeActiveRun(runId) {
  workflowsState.setProp(
    'activeRuns',
    workflowsState.get().activeRuns.filter(r => r.id !== runId)
  );
}

// ─── Selection ────────────────────────────────────────────────────────────────

function getSelectedId() {
  return workflowsState.get().selectedId;
}

function setSelectedId(id) {
  workflowsState.setProp('selectedId', id);
}

function getSelectedRunId() {
  return workflowsState.get().selectedRunId;
}

function setSelectedRunId(id) {
  workflowsState.setProp('selectedRunId', id);
}

// ─── IPC event handlers (call from WorkflowPanel or renderer init) ────────────

/**
 * Wire all workflow IPC listeners.
 * Call once after the app is loaded.
 */
function initWorkflowListeners() {
  const api = window.electron_api?.workflow;
  if (!api) return;

  api.onRunStart((run) => {
    prependRun(run);
    addActiveRun(run);
  });

  api.onRunEnd(({ runId, status, duration, error }) => {
    patchRun(runId, { status, duration, finishedAt: new Date().toISOString(), error });
    removeActiveRun(runId);
  });

  api.onRunQueued(({ workflowId, queueLength }) => {
    // Optional: show queued badge in UI
    console.log(`[WorkflowState] ${workflowId} queued (depth: ${queueLength})`);
  });

  api.onStepUpdate(({ runId, stepId, status, output, attempt }) => {
    patchRunStep(runId, stepId, { status, output, attempt, updatedAt: Date.now() });
  });

  api.onNotifyDesktop(({ title, message, type }) => {
    // Delegate to app's notification system if available
    if (window.electron_api?.notification?.show) {
      window.electron_api.notification.show({ title, body: message });
    }
  });
}

/**
 * Load workflows and recent runs from disk via IPC.
 * Call after initWorkflowListeners().
 */
async function loadFromDisk() {
  const api = window.electron_api?.workflow;
  if (!api) return;

  const [wfRes, runsRes] = await Promise.allSettled([
    api.list(),
    api.getRecentRuns(50),
  ]);

  if (wfRes.status === 'fulfilled' && wfRes.value?.success) {
    setWorkflows(wfRes.value.workflows || []);
  }
  if (runsRes.status === 'fulfilled' && runsRes.value?.success) {
    setRuns(runsRes.value.runs || []);
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  workflowsState,
  // Workflows
  getWorkflows,
  setWorkflows,
  getWorkflow,
  upsertWorkflow,
  removeWorkflow,
  updateWorkflowEnabled,
  // Runs
  getRuns,
  setRuns,
  getRunsForWorkflow,
  prependRun,
  patchRun,
  patchRunStep,
  // Active
  getActiveRuns,
  addActiveRun,
  removeActiveRun,
  // Selection
  getSelectedId,
  setSelectedId,
  getSelectedRunId,
  setSelectedRunId,
  // Init
  initWorkflowListeners,
  loadFromDisk,
};
