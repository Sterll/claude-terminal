/**
 * Background Tasks State Module
 *
 * One registry for every background task the CLI reports, across all chat
 * sessions. The chat's own task cards are per-session and scroll away with the
 * transcript; this is what lets a panel answer "what is running right now, and
 * what ran earlier".
 *
 * Fed by the two CLI feeds, which say different things:
 *
 *   `chat-task-update`        edge bookends — the only source that knows *how*
 *                             a task ended, and the only one carrying usage.
 *   `chat-background-tasks`   the full live set per session — authoritative
 *                             about *whether* a task is still running.
 *
 * `syncLive` is what keeps the list honest when a bookend never arrives: a task
 * missing from its session's live set is over, whatever the edges said. Sessions
 * are reconciled independently, since each carries only its own set.
 */

const { State } = require('./State');

// Finished tasks accumulate for the life of the app run. The cap is generous
// because each entry is small, but unbounded growth in a long-lived desktop
// session is not acceptable.
const MAX_FINISHED = 500;

const initialState = {
  /** @type {Map<string, object>} taskId -> task */
  tasks: new Map(),
};

const backgroundTasksState = new State(initialState);

/** Broadcast a new Map so subscribers comparing references actually re-render. */
function _commit(tasks) {
  backgroundTasksState.setProp('tasks', new Map(tasks));
}

function _all() {
  return backgroundTasksState.get().tasks;
}

/**
 * Drop the oldest finished entries once past the cap. Running tasks are never
 * evicted — a list that forgets live work is worse than a long one.
 */
function _prune(tasks) {
  const finished = [...tasks.values()].filter(t => t.status !== 'running');
  if (finished.length <= MAX_FINISHED) return tasks;
  finished
    .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0))
    .slice(0, finished.length - MAX_FINISHED)
    .forEach(t => tasks.delete(t.taskId));
  return tasks;
}

// ── API ─────────────────────────────────────────────────────────────────────

/**
 * Record a task the CLI just started.
 * @param {object} data A `chat-task-update` payload with `phase: 'started'`.
 */
function taskStarted(data) {
  if (!data?.taskId) return;
  const tasks = _all();
  const existing = tasks.get(data.taskId);
  tasks.set(data.taskId, {
    taskId: data.taskId,
    sessionId: data.sessionId || null,
    projectId: data.projectId || null,
    toolUseId: data.toolUseId || null,
    type: data.taskType || (data.subagentType ? 'subagent' : null),
    agentType: data.subagentType || null,
    workflowName: data.workflowName || null,
    description: data.description || '',
    status: 'running',
    startedAt: existing?.startedAt || Date.now(),
    endedAt: null,
    usage: null,
  });
  _commit(tasks);
}

/**
 * Settle a task from its end bookend, which is the only feed that knows the
 * outcome and the token usage.
 *
 * @param {object} data A `chat-task-update` payload with `phase: 'ended'`.
 */
function taskEnded(data) {
  if (!data?.taskId) return;
  const tasks = _all();
  const existing = tasks.get(data.taskId);
  // A bookend for a task we never saw start is still worth keeping — it is
  // real history, just history we joined late.
  tasks.set(data.taskId, {
    ...(existing || {
      taskId: data.taskId,
      sessionId: data.sessionId || null,
      startedAt: Date.now(),
      description: data.description || '',
    }),
    type: existing?.type || data.taskType || null,
    agentType: existing?.agentType || data.subagentType || null,
    workflowName: existing?.workflowName || data.workflowName || null,
    description: data.description || existing?.description || '',
    status: data.status || 'completed',
    endedAt: Date.now(),
    usage: data.usage || existing?.usage || null,
  });
  _commit(_prune(tasks));
}

/**
 * Reconcile one session against its live set.
 *
 * Anything this session still shows as running but that the set no longer
 * carries has ended without a bookend, so it is settled as `ended` — the
 * outcome is genuinely unknown and must not be reported as success.
 *
 * Other sessions are untouched: each payload describes one session only, so
 * treating it as global would wipe every other session's running tasks.
 *
 * @param {string} sessionId
 * @param {Array<{taskId: string}>} liveTasks
 */
function syncLive(sessionId, liveTasks) {
  if (!sessionId) return;
  const live = new Set((liveTasks || []).map(t => t?.taskId).filter(Boolean));
  const tasks = _all();
  let changed = false;
  for (const task of tasks.values()) {
    if (task.sessionId !== sessionId || task.status !== 'running') continue;
    if (live.has(task.taskId)) continue;
    tasks.set(task.taskId, { ...task, status: 'ended', endedAt: Date.now() });
    changed = true;
  }
  if (changed) _commit(_prune(tasks));
}

/** @returns {object[]} running first, then most recently finished. */
function listTasks() {
  return [..._all().values()].sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (b.status === 'running' && a.status !== 'running') return 1;
    if (a.status === 'running') return b.startedAt - a.startedAt;
    return (b.endedAt || 0) - (a.endedAt || 0);
  });
}

function getTask(taskId) {
  return _all().get(taskId) || null;
}

/** Drop finished entries, keeping anything still running. */
function clearFinished() {
  const tasks = _all();
  for (const task of [...tasks.values()]) {
    if (task.status !== 'running') tasks.delete(task.taskId);
  }
  _commit(tasks);
}

function reset() {
  backgroundTasksState.setProp('tasks', new Map());
}

module.exports = {
  backgroundTasksState,
  taskStarted,
  taskEnded,
  syncLive,
  listTasks,
  getTask,
  clearFinished,
  reset,
  MAX_FINISHED,
};
