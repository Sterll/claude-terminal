/**
 * Parallel Task State Module
 * Manages active parallel runs and recent run history.
 *
 * Shape:
 *   activeRun   Object|null  — the currently active parallel run
 *   history     Object[]     — lightweight summaries of recent runs (loaded from disk)
 */

'use strict';

const { State } = require('./State');

// ─── Initial state ────────────────────────────────────────────────────────────

const initialState = {
  activeRun: null,
  history: [],
};

const parallelTaskState = new State(initialState);

// ─── Selectors ────────────────────────────────────────────────────────────────

function getActiveRun() {
  return parallelTaskState.get().activeRun;
}

function getHistory() {
  return parallelTaskState.get().history;
}

// ─── Mutators ─────────────────────────────────────────────────────────────────

function setActiveRun(run) {
  parallelTaskState.setProp('activeRun', run);
}

function clearActiveRun() {
  parallelTaskState.setProp('activeRun', null);
}

function setHistory(runs) {
  parallelTaskState.setProp('history', runs);
}

function setRunPhase(runId, phase, extra = {}) {
  const run = parallelTaskState.get().activeRun;
  if (!run || run.id !== runId) return;
  parallelTaskState.setProp('activeRun', { ...run, phase, ...extra });
}

/**
 * Insert or update a task within the active run.
 * @param {string} runId
 * @param {Object} taskData — partial task object (must include id)
 */
function upsertTask(runId, taskData) {
  const run = parallelTaskState.get().activeRun;
  if (!run || run.id !== runId) return;
  const tasks = run.tasks || [];
  const idx = tasks.findIndex(t => t.id === taskData.id);
  const nextTasks = idx >= 0
    ? tasks.map((t, i) => i === idx ? { ...t, ...taskData } : t)
    : [...tasks, { output: '', error: null, ...taskData }];
  parallelTaskState.setProp('activeRun', { ...run, tasks: nextTasks });
}

/**
 * Append a text chunk to a task's output. Caps at 50 KB.
 */
function appendTaskOutput(runId, taskId, chunk) {
  const run = parallelTaskState.get().activeRun;
  if (!run || run.id !== runId) return;
  const tasks = (run.tasks || []).map(t => {
    if (t.id !== taskId) return t;
    const next = ((t.output || '') + chunk).slice(-50000);
    return { ...t, output: next };
  });
  parallelTaskState.setProp('activeRun', { ...run, tasks });
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

  api.onRunStatus(({ runId, phase, error, endedAt }) => {
    const run = parallelTaskState.get().activeRun;
    if (run && run.id === runId) {
      setRunPhase(runId, phase, {
        error: error || null,
        endedAt: endedAt || run.endedAt || null
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
  getActiveRun,
  getHistory,
  // Mutators
  setActiveRun,
  clearActiveRun,
  setHistory,
  setRunPhase,
  upsertTask,
  appendTaskOutput,
  // Init
  initParallelListeners,
};
