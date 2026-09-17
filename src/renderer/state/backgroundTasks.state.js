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
 *
 * ── Owners ──────────────────────────────────────────────────────────────────
 *
 * A task is reported under a session id, but a tab does not have one id: it
 * mints an app-local `chat-…` handle per ChatView, picks up a CLI session uuid
 * once the SDK starts, and gets fresh ones again on a restart or an account
 * switch. Keying the drawer on the id a task happened to carry therefore loses
 * the whole history every time any of those rotate.
 *
 * So each task also carries an `ownerKey`: the tab it belongs to. Sessions are
 * linked to an owner through `claimSession`, which is deliberately forgiving —
 * a link that lands after the tasks re-stamps them, and two ids that turn out
 * to name the same tab merge into one owner rather than splitting its history.
 *
 * ── Persistence ─────────────────────────────────────────────────────────────
 *
 * The registry is written to `~/.claude-terminal/background-tasks.json` and
 * read back at boot, so a reload, a crash or a restart no longer empties it.
 * A task the file still shows as running is settled as `ended` on load: the
 * process that ran it is gone, and nobody recorded how it finished.
 */

const { State } = require('./State');

// Finished tasks accumulate across app runs. The cap is generous because each
// entry is small, but unbounded growth in a long-lived desktop install is not
// acceptable.
const MAX_FINISHED = 500;

const STORE_VERSION = 1;
const SAVE_DEBOUNCE_MS = 500;

const initialState = {
  /** @type {Map<string, object>} taskId -> task */
  tasks: new Map(),
};

const backgroundTasksState = new State(initialState);

/** @type {Map<string, string>} sessionId -> ownerKey */
let owners = new Map();

let _saveTimer = null;
let _pendingSave = null;
let _loading = null;
let _loaded = false;
// Latched when background-tasks.json exists but cannot be parsed. Blocks every
// save for the rest of the session - see load(). The registry is a
// read-modify-write of the whole collection, so treating an unreadable file as
// an absent one would rewrite it with this run alone and drop the history the
// file still holds. Absent is legitimate and starts empty; unreadable is not.
let _loadFailed = false;

/** Broadcast a new Map so subscribers comparing references actually re-render. */
function _commit(tasks) {
  backgroundTasksState.setProp('tasks', new Map(tasks));
}

function _all() {
  return backgroundTasksState.get().tasks;
}

/**
 * The owner a task reported under `sessionId` belongs to.
 *
 * An unclaimed session owns itself, so a task that arrives before its tab has
 * linked anything is still filed somewhere a later `claimSession` can find it.
 */
function _ownerFor(sessionId) {
  if (!sessionId) return null;
  return owners.get(sessionId) || sessionId;
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

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * What goes to disk.
 *
 * Aliases are kept only for owners that still hold a task: an owner pruned out
 * of the history has nothing left to adopt, and keeping its ids would let the
 * map grow without a bound of its own.
 */
function _snapshot() {
  const tasks = [...backgroundTasksState.get().tasks.values()];
  const live = new Set(tasks.map(t => t.ownerKey).filter(Boolean));
  const ownersOut = {};
  for (const [sessionId, ownerKey] of owners) {
    if (live.has(ownerKey)) ownersOut[sessionId] = ownerKey;
  }
  return {
    version: STORE_VERSION,
    savedAt: new Date().toISOString(),
    tasks,
    owners: ownersOut,
  };
}

/**
 * Write now.
 *
 * Flushes are chained so two overlapping saves never interleave their
 * backup/rename steps on the same file.
 */
function _saveNow() {
  clearTimeout(_saveTimer);
  _saveTimer = null;
  if (_loadFailed) return Promise.resolve();
  const prev = _pendingSave;
  const flush = (async () => {
    if (prev) { try { await prev; } catch (_) { /* a failed save must not block the next */ } }
    const { atomicWriteJSON } = require('../utils/fs-async');
    const { backgroundTasksFile } = require('../utils/paths');
    return atomicWriteJSON(backgroundTasksFile, _snapshot());
  })();
  _pendingSave = flush;
  return flush.catch(e => { console.error('Error saving background tasks:', e); });
}

/** Tasks churn in bursts — one write per burst is enough. */
function _save() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveNow(); }, SAVE_DEBOUNCE_MS);
}

/**
 * Read the registry back at boot.
 *
 * Order-independent with respect to the tabs: a ChatView that claimed its ids
 * before the file landed keeps the owner it minted, and the persisted owner is
 * merged into it. Whatever this run already recorded wins over the file.
 *
 * @returns {Promise<void>}
 */
function load() {
  if (_loading) return _loading;
  _loading = (async () => {
    const { fileExists, safeReadFile } = require('../utils/fs-async');
    const { backgroundTasksFile } = require('../utils/paths');
    let data = null;
    try {
      // Absent is the normal first run. Present but unparseable is not, and it
      // must not be answered by starting empty: the next save would rewrite the
      // file with this run alone. Empty content counts as unreadable too, since
      // a save only ever writes a complete document.
      if (await fileExists(backgroundTasksFile)) {
        const raw = await safeReadFile(backgroundTasksFile);
        if (!raw || !raw.trim()) throw new Error('file is empty');
        data = JSON.parse(raw);
      }
    } catch (e) {
      _loadFailed = true;
      _loaded = true;
      console.error('[BackgroundTasks] Registry unreadable, saving is now disabled:', e.message);
      return;
    }
    _loaded = true;
    if (!data || data.version !== STORE_VERSION || !Array.isArray(data.tasks)) return;

    // A task still marked running was running when the app went away, so its
    // end is the last moment the file knows about rather than now — otherwise
    // a tab reopened a week later would report a week-long task.
    const diedAt = Date.parse(data.savedAt) || Date.now();
    const tasks = _all();
    /** @type {Map<string, string>} persisted owner -> the live one it is the same tab as */
    const merges = new Map();

    for (const [sessionId, ownerKey] of Object.entries(data.owners || {})) {
      if (!sessionId || !ownerKey) continue;
      const claimed = owners.get(sessionId);
      if (!claimed) { owners.set(sessionId, ownerKey); continue; }
      if (claimed !== ownerKey) merges.set(ownerKey, claimed);
    }

    for (const task of data.tasks) {
      if (!task?.taskId || tasks.has(task.taskId)) continue;
      const wasRunning = task.status === 'running';
      tasks.set(task.taskId, {
        ...task,
        status: wasRunning ? 'ended' : task.status,
        endedAt: wasRunning ? (task.endedAt || diedAt) : (task.endedAt || null),
      });
    }

    if (merges.size) {
      for (const task of tasks.values()) {
        const to = merges.get(task.ownerKey);
        if (to) tasks.set(task.taskId, { ...task, ownerKey: to });
      }
      for (const [sessionId, ownerKey] of owners) {
        const to = merges.get(ownerKey);
        if (to) owners.set(sessionId, to);
      }
    }

    _commit(_prune(tasks));
    _save();
  })();
  return _loading;
}

/**
 * Last-gasp write for `beforeunload`, where an awaited one would never land.
 *
 * Still tmp-then-rename: a truncated file is worse than a slightly stale one.
 */
function flushSync() {
  if (!_saveTimer || _loadFailed) return;
  clearTimeout(_saveTimer);
  _saveTimer = null;
  try {
    const { fs, path } = window.electron_nodeModules;
    const { backgroundTasksFile } = require('../utils/paths');
    const tmp = `${backgroundTasksFile}.${Date.now().toString(36)}.tmp`;
    fs.mkdirSync(path.dirname(backgroundTasksFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(_snapshot(), null, 2), 'utf8');
    fs.renameSync(tmp, backgroundTasksFile);
  } catch (_) {
    // Unload is no place to throw.
  }
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
    ownerKey: _ownerFor(data.sessionId) || existing?.ownerKey || null,
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
  _save();
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
    ownerKey: existing?.ownerKey || _ownerFor(data.sessionId),
    type: existing?.type || data.taskType || null,
    agentType: existing?.agentType || data.subagentType || null,
    workflowName: existing?.workflowName || data.workflowName || null,
    description: data.description || existing?.description || '',
    status: data.status || 'completed',
    endedAt: Date.now(),
    usage: data.usage || existing?.usage || null,
  });
  _commit(_prune(tasks));
  _save();
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
  if (changed) { _commit(_prune(tasks)); _save(); }
}

/**
 * Tell the registry that `sessionId` is one of `ownerKey`'s ids.
 *
 * Forgiving on purpose, because the ids arrive in no fixed order:
 *  - tasks already filed under that session move to the owner;
 *  - a session that already answered to another owner brings that owner's
 *    whole history along, rather than leaving the tab split across two keys.
 *
 * @param {string} ownerKey
 * @param {string} sessionId
 * @returns {string|null} the owner key to keep using
 */
function claimSession(ownerKey, sessionId) {
  if (!ownerKey) return null;
  if (!sessionId) return ownerKey;
  const previous = owners.get(sessionId);
  if (previous === ownerKey) return ownerKey;
  owners.set(sessionId, ownerKey);

  const tasks = _all();
  let changed = false;
  for (const task of tasks.values()) {
    const mine = task.sessionId === sessionId
      || (previous ? task.ownerKey === previous : task.ownerKey === sessionId);
    if (!mine || task.ownerKey === ownerKey) continue;
    tasks.set(task.taskId, { ...task, ownerKey });
    changed = true;
  }
  const absorbed = previous || sessionId;
  for (const [sid, key] of owners) {
    if (key === absorbed) owners.set(sid, ownerKey);
  }

  if (changed) _commit(tasks);
  _save();
  return ownerKey;
}

/**
 * The owner a session is already known to belong to, or null.
 *
 * A tab resuming on an id it used last run reads its own history back through
 * this; an unknown id answers null so the caller can mint a fresh owner.
 *
 * @param {string} sessionId
 * @returns {string|null}
 */
function resolveOwner(sessionId) {
  if (!sessionId) return null;
  return owners.get(sessionId) || null;
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

/**
 * One tab's tasks, in the same order.
 * @param {string} ownerKey
 * @returns {object[]}
 */
function listTasksForOwner(ownerKey) {
  if (!ownerKey) return [];
  return listTasks().filter(task => task.ownerKey === ownerKey);
}

/**
 * Forget finished tasks.
 *
 * Running work is never dropped: the list is there to say what is happening,
 * and a clear that silently stopped reporting live tasks would be a lie rather
 * than a tidy-up. With no owner given, the whole registry is cleared.
 *
 * @param {string} [ownerKey] limit the clear to one tab's history
 * @returns {number} how many entries were dropped
 */
function clearFinished(ownerKey) {
  const tasks = _all();
  let dropped = 0;
  for (const task of [...tasks.values()]) {
    if (task.status === 'running') continue;
    if (ownerKey && task.ownerKey !== ownerKey) continue;
    tasks.delete(task.taskId);
    dropped++;
  }
  if (dropped) { _commit(tasks); _save(); }
  return dropped;
}

function getTask(taskId) {
  return _all().get(taskId) || null;
}

/** Wipe the registry in memory. Deliberately does not touch the file. */
function reset() {
  clearTimeout(_saveTimer);
  _saveTimer = null;
  _pendingSave = null;
  _loading = null;
  _loaded = false;
  _loadFailed = false;
  owners = new Map();
  backgroundTasksState.setProp('tasks', new Map());
}

module.exports = {
  backgroundTasksState,
  taskStarted,
  taskEnded,
  syncLive,
  claimSession,
  resolveOwner,
  listTasks,
  listTasksForOwner,
  clearFinished,
  getTask,
  load,
  flushSync,
  reset,
  MAX_FINISHED,
};
