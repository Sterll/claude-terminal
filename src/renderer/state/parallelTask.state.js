/**
 * Parallel Task State Module
 * Manages multiple concurrent parallel runs.
 *
 * Shape:
 *   runs     Object[]  — all active and recently completed runs
 *   history  Object[]  — lightweight summaries of past runs (from disk)
 */

'use strict';

const { State } = require('./State');

// ─── Initial state ────────────────────────────────────────────────────────────

const initialState = {
  runs: [],
  history: [],
};

const parallelTaskState = new State(initialState);

// ─── Selectors ────────────────────────────────────────────────────────────────

function getRuns() {
  return parallelTaskState.get().runs;
}

function getHistory() {
  return parallelTaskState.get().history;
}

function getRunById(runId) {
  return parallelTaskState.get().runs.find(r => r.id === runId) || null;
}

// ─── Mutators ─────────────────────────────────────────────────────────────────

function addRun(run) {
  parallelTaskState.setProp('runs', [...parallelTaskState.get().runs, run]);
}

function removeRun(runId) {
  parallelTaskState.setProp('runs', parallelTaskState.get().runs.filter(r => r.id !== runId));
}

function setHistory(runs) {
  parallelTaskState.setProp('history', runs);
}

function setRunPhase(runId, phase, extra = {}) {
  const runs = parallelTaskState.get().runs;
  const idx = runs.findIndex(r => r.id === runId);
  if (idx < 0) return;
  parallelTaskState.setProp('runs', runs.map((r, i) =>
    i === idx ? { ...r, phase, ...extra } : r
  ));
}

/**
 * Insert or update a task within a run.
 */
function upsertTask(runId, taskData) {
  const runs = parallelTaskState.get().runs;
  const idx = runs.findIndex(r => r.id === runId);
  if (idx < 0) return;
  const run = runs[idx];
  const tasks = run.tasks || [];
  const ti = tasks.findIndex(t => t.id === taskData.id);
  const nextTasks = ti >= 0
    ? tasks.map((t, i) => i === ti ? { ...t, ...taskData } : t)
    : [...tasks, { output: '', error: null, ...taskData }];
  parallelTaskState.setProp('runs', runs.map((r, i) =>
    i === idx ? { ...r, tasks: nextTasks } : r
  ));
}

/**
 * Append a text chunk to a task's output. Caps at 50 KB.
 */
function appendTaskOutput(runId, taskId, chunk) {
  const runs = parallelTaskState.get().runs;
  const idx = runs.findIndex(r => r.id === runId);
  if (idx < 0) return;
  const run = runs[idx];
  const tasks = (run.tasks || []).map(t => {
    if (t.id !== taskId) return t;
    return { ...t, output: ((t.output || '') + chunk).slice(-50000) };
  });
  parallelTaskState.setProp('runs', runs.map((r, i) =>
    i === idx ? { ...r, tasks } : r
  ));
}

// ─── IPC event listeners ──────────────────────────────────────────────────────

let _listenersInitialized = false;

/**
 * Wire IPC event listeners from the main process.
 * Call once after the app is loaded.
 */
function initParallelListeners() {
  if (_listenersInitialized) return;
  _listenersInitialized = true;

  const api = window.electron_api?.parallel;
  if (!api) return;

  api.onRunStatus(({ runId, phase, error, endedAt, proposedTasks, featureName, mergeBranch, mergeProgress, mergeResult, resolving }) => {
    const run = getRunById(runId);
    if (run) {
      setRunPhase(runId, phase, {
        error: error || null,
        endedAt: endedAt || run.endedAt || null,
        ...(proposedTasks !== undefined && { proposedTasks }),
        ...(featureName && { featureName }),
        ...(mergeBranch && { mergeBranch }),
        ...(mergeProgress && { mergeProgress }),
        ...(mergeResult && { mergeResult }),
        ...(resolving !== undefined && { resolving }),
      });
    }
  });

  api.onTaskUpdate(({ runId, taskId, status, title, description, branch, worktreePath, error }) => {
    upsertTask(runId, { id: taskId, status, title, description, branch, worktreePath, error: error || null });
  });

  api.onTaskOutput(({ runId, taskId, chunk }) => {
    appendTaskOutput(runId, taskId, chunk);
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  parallelTaskState,
  // Selectors
  getRuns,
  getHistory,
  getRunById,
  // Mutators
  addRun,
  removeRun,
  setHistory,
  setRunPhase,
  upsertTask,
  appendTaskOutput,
  // Init
  initParallelListeners,
};
