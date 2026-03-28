/**
 * Time Tracking State Module (v3 - Heartbeat model)
 *
 * Simplified time tracking based on a single heartbeat() entry point.
 * Tracks all activity (Claude working + user interaction) with a 10-minute idle margin.
 *
 * Key design:
 * - Single heartbeat(projectId, source) function replaces start/stop/record/pause/resume
 * - All counters (today/week/month) computed on-the-fly from sessions (no stored counters that drift)
 * - Global timer separate from per-project timers to avoid double-counting
 * - Single 60s tick replaces 5 separate timers
 * - Crash-safe: tick saves active session startedAt as checkpoint
 */

const { fs, path } = window.electron_nodeModules;
const { fileExists } = require('../utils/fs-async');
const fsp = require('../utils/fs-async').fsp;
const { State } = require('./State');
const { timeTrackingFile, projectsFile } = require('../utils/paths');
const ArchiveService = require('../services/ArchiveService');

// ============================================================
// CONSTANTS
// ============================================================

const IDLE_TIMEOUT = 10 * 60 * 1000;    // 10 minutes without heartbeat → idle out
const TICK_INTERVAL = 60 * 1000;         // 60s tick (idle check, midnight, sleep/wake, checkpoint)
const SAVE_DEBOUNCE = 1000;              // 1 second debounce for disk writes
const MERGE_GAP = 5 * 60 * 1000;        // 5 minutes: merge sessions closer than this
const SLEEP_GAP = 2 * 60 * 1000;        // 2 minutes between ticks = system was asleep
const HEARTBEAT_THROTTLE = 1000;         // 1 second: ignore heartbeats faster than this per project

// ============================================================
// STATE
// ============================================================

// Runtime state (not persisted) — observable for UI subscriptions
const trackingState = new State({
  activeProjects: new Map(),    // projectId -> { startedAt, lastHeartbeat, source }
  globalStartedAt: null,        // When global timer started (first active project)
  globalLastHeartbeat: null     // Last heartbeat from any source
});

// Persisted state (timetracking.json)
const dataState = new State({
  version: 3,
  month: null,
  global: { sessions: [] },
  projects: {}
});

// Internal (not observable)
let tickTimer = null;
let lastTickTime = Date.now();
let lastKnownDate = null;
let projectsStateRef = null;
let saveDebounceTimer = null;
let saveInProgress = false;
let pendingSave = false;
let dirty = false;

// ============================================================
// PERSISTENCE
// ============================================================

async function loadData() {
  try {
    if (!await fileExists(timeTrackingFile)) return;
    const content = await fsp.readFile(timeTrackingFile, 'utf8');
    if (!content || !content.trim()) return;
    const data = JSON.parse(content);
    dataState.set({
      version: data.version || 2,
      month: data.month || null,
      global: data.global || { sessions: [] },
      projects: data.projects || {}
    });
  } catch (e) {
    console.warn('[TimeTracking] Failed to load:', e.message);
  }
}

function save() {
  dirty = true;
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    if (saveInProgress) { pendingSave = true; return; }
    saveImmediate();
  }, SAVE_DEBOUNCE);
}

async function saveImmediate() {
  if (saveInProgress) { pendingSave = true; return; }
  saveInProgress = true;

  try {
    const state = dataState.get();
    const data = {
      version: 3,
      month: state.month || getMonthString(),
      global: state.global,
      projects: state.projects
    };

    // Save active sessions as checkpoint for crash recovery
    const runtime = trackingState.get();
    if (runtime.activeProjects.size > 0) {
      data._activeCheckpoint = {};
      for (const [pid, info] of runtime.activeProjects) {
        data._activeCheckpoint[pid] = { startedAt: info.startedAt, source: info.source };
      }
      if (runtime.globalStartedAt) {
        data._activeCheckpoint._global = { startedAt: runtime.globalStartedAt };
      }
    }

    const tmpFile = timeTrackingFile + '.tmp';
    const bakFile = timeTrackingFile + '.bak';
    const jsonStr = JSON.stringify(data, null, 2);

    // Ensure parent directory exists
    const dir = path.dirname(timeTrackingFile);
    await fsp.mkdir(dir, { recursive: true });

    try {
      await fsp.writeFile(tmpFile, jsonStr, 'utf8');
      try { await fsp.copyFile(timeTrackingFile, bakFile); } catch {}
      await fsp.rename(tmpFile, timeTrackingFile);
      try { await fsp.unlink(bakFile); } catch {}
    } catch (renameErr) {
      // Fallback: write directly if atomic rename fails (e.g. antivirus lock on Windows)
      console.warn('[TimeTracking] Atomic save failed, falling back to direct write:', renameErr.message);
      await fsp.writeFile(timeTrackingFile, jsonStr, 'utf8');
      try { await fsp.unlink(tmpFile); } catch {}
    }

    dirty = false;
  } catch (e) {
    console.error('[TimeTracking] Save failed:', e.message);
    // Try to restore from backup
    const bakFile = timeTrackingFile + '.bak';
    try {
      if (await fileExists(bakFile)) await fsp.copyFile(bakFile, timeTrackingFile);
    } catch (e2) { /* ignore */ }
  } finally {
    saveInProgress = false;
    if (pendingSave) {
      pendingSave = false;
      setTimeout(saveImmediate, 50);
    }
  }
}

// ============================================================
// INITIALIZATION & MIGRATION
// ============================================================

async function initTimeTracking(projectsState) {
  projectsStateRef = projectsState;

  // 1. Migrate old archive format
  await ArchiveService.migrateOldArchives();

  // 2. Load data
  await loadData();

  // 3. Migrate v2 → v3
  migrateV2ToV3();

  // 4. Recover crashed sessions from checkpoint
  recoverFromCheckpoint();

  // 5. Archive past-month sessions
  await archivePastMonths();

  // 6. Cleanup orphaned projects
  cleanupOrphans();

  // 7. Start tick
  lastKnownDate = getTodayString();
  lastTickTime = Date.now();
  tickTimer = setInterval(tick, TICK_INTERVAL);

  console.debug('[TimeTracking] Initialized (v3)');
}

function migrateV2ToV3() {
  const state = dataState.get();
  if (state.version >= 3) return;

  console.debug('[TimeTracking] Migrating v2 → v3');

  // Strip computed counters, keep only sessions
  const migratedProjects = {};
  for (const [id, tracking] of Object.entries(state.projects || {})) {
    migratedProjects[id] = {
      sessions: Array.isArray(tracking.sessions) ? tracking.sessions.filter(isValidSession) : []
    };
  }

  const globalSessions = state.global?.sessions || [];

  dataState.set({
    version: 3,
    month: state.month || getMonthString(),
    global: { sessions: globalSessions.filter(isValidSession) },
    projects: migratedProjects
  });

  save();
}

function recoverFromCheckpoint() {
  const state = dataState.get();
  const checkpoint = state._activeCheckpoint;
  if (!checkpoint) return;

  const now = Date.now();
  let recovered = 0;

  for (const [pid, info] of Object.entries(checkpoint)) {
    if (pid === '_global') continue;
    if (!info.startedAt) continue;

    // Only recover if the checkpoint is recent (< 1 hour)
    const age = now - info.startedAt;
    if (age > 60 * 60 * 1000) continue;

    // Finalize the crashed session using the checkpoint data
    // Use startedAt as both start, and estimate end as startedAt + (age capped at idle timeout)
    const estimatedEnd = info.startedAt + Math.min(age, IDLE_TIMEOUT);
    const duration = estimatedEnd - info.startedAt;
    if (duration > 1000) {
      addSession('projects', pid, info.startedAt, estimatedEnd, duration, info.source);
      recovered++;
    }
  }

  // Recover global
  if (checkpoint._global?.startedAt) {
    const age = now - checkpoint._global.startedAt;
    if (age <= 60 * 60 * 1000) {
      const estimatedEnd = checkpoint._global.startedAt + Math.min(age, IDLE_TIMEOUT);
      const duration = estimatedEnd - checkpoint._global.startedAt;
      if (duration > 1000) {
        addSession('global', null, checkpoint._global.startedAt, estimatedEnd, duration);
      }
    }
  }

  // Clear checkpoint from persisted data
  const updated = { ...dataState.get() };
  delete updated._activeCheckpoint;
  dataState.set(updated);

  if (recovered > 0) {
    console.debug(`[TimeTracking] Recovered ${recovered} crashed sessions`);
    save();
  }
}

async function archivePastMonths() {
  const state = dataState.get();
  const currentMonthStr = getMonthString(); // "YYYY-MM"

  // If month hasn't changed, nothing to do
  if (state.month === currentMonthStr) return;

  // First run ever — just stamp the current month, don't archive
  if (!state.month) {
    dataState.set({ ...state, month: currentMonthStr });
    save();
    return;
  }

  // Safety check: only archive if the stored month is strictly in the past.
  // This protects existing users whose timetracking.json has an outdated month
  // stamp but still contains current-month sessions (e.g. after a refactor or
  // clock drift). If any session belongs to the current month, skip archiving.
  const hasCurrentMonthSessions = (
    (state.global?.sessions || []).some(s => s.startTime?.startsWith(currentMonthStr)) ||
    Object.values(state.projects || {}).some(p =>
      (p.sessions || []).some(s => s.startTime?.startsWith(currentMonthStr))
    )
  );

  if (hasCurrentMonthSessions) {
    // Sessions du mois courant détectées — juste corriger le stamp, pas d'archivage
    dataState.set({ ...state, month: currentMonthStr });
    save();
    return;
  }

  // The stored month is truly past — copy file as archive then reset
  await ArchiveService.archiveCurrentFile(state.month);

  dataState.set({
    version: 3,
    month: currentMonthStr,
    global: { sessions: [] },
    projects: {}
  });
  save();
  console.debug(`[TimeTracking] Archived ${state.month} → starting fresh for ${currentMonthStr}`);
}

function cleanupOrphans() {
  if (!projectsStateRef) return;
  const projects = projectsStateRef.get().projects || [];
  const projectIds = new Set(projects.map(p => p.id));
  const state = dataState.get();
  let changed = false;

  for (const pid of Object.keys(state.projects || {})) {
    if (!projectIds.has(pid)) {
      delete state.projects[pid];
      changed = true;
    }
  }

  if (changed) {
    dataState.set({ ...state });
    save();
  }
}

// ============================================================
// CORE TRACKING
// ============================================================

/**
 * Record activity for a project. This is the SINGLE entry point.
 * Auto-starts tracking if not already active. Internal 1s throttle.
 */
function heartbeat(projectId, source = 'terminal') {
  if (!projectId) return;

  const now = Date.now();
  const runtime = trackingState.get();
  const existing = runtime.activeProjects.get(projectId);

  if (existing) {
    // Throttle: ignore if less than 1s since last heartbeat for this project
    if (now - existing.lastHeartbeat < HEARTBEAT_THROTTLE) return;
    existing.lastHeartbeat = now;
  } else {
    // Auto-start tracking for this project
    runtime.activeProjects.set(projectId, { startedAt: now, lastHeartbeat: now, source });
  }

  // Global timer: start if this is the first active project
  if (!runtime.globalStartedAt && runtime.activeProjects.size > 0) {
    runtime.globalStartedAt = now;
  }

  runtime.globalLastHeartbeat = now;
  trackingState._notify();
}

/**
 * Explicitly stop tracking for a project (terminal closed).
 */
function stopProject(projectId) {
  if (!projectId) return;

  const now = Date.now();
  const runtime = trackingState.get();
  const activeProjects = new Map(runtime.activeProjects);
  const info = activeProjects.get(projectId);

  if (info) {
    // Finalize project session
    const duration = now - info.startedAt;
    if (duration > 1000) {
      addSession('projects', projectId, info.startedAt, now, duration, info.source);
    }
    activeProjects.delete(projectId);
  }

  // If last project stopped, finalize global session too
  let globalStartedAt = runtime.globalStartedAt;
  if (activeProjects.size === 0 && globalStartedAt) {
    const duration = now - globalStartedAt;
    if (duration > 1000) {
      addSession('global', null, globalStartedAt, now, duration);
    }
    globalStartedAt = null;
  }

  trackingState.set({
    activeProjects,
    globalStartedAt,
    globalLastHeartbeat: activeProjects.size > 0 ? runtime.globalLastHeartbeat : null
  });

  save();
}

/**
 * Main tick — runs every 60s. Handles idle detection, midnight, sleep/wake, and checkpoint saves.
 */
function tick() {
  const now = Date.now();
  const elapsed = now - lastTickTime;
  lastTickTime = now;

  const runtime = trackingState.get();
  const activeProjects = new Map(runtime.activeProjects);
  let globalStartedAt = runtime.globalStartedAt;
  let changed = false;

  // --- Sleep/wake detection ---
  if (elapsed > SLEEP_GAP) {
    const sleepStart = now - elapsed;
    // Finalize all sessions at the pre-sleep timestamp
    for (const [pid, info] of activeProjects) {
      const duration = sleepStart - info.startedAt;
      if (duration > 1000) {
        addSession('projects', pid, info.startedAt, sleepStart, duration, info.source);
      }
      info.startedAt = now;
      info.lastHeartbeat = now;
    }
    if (globalStartedAt) {
      const duration = sleepStart - globalStartedAt;
      if (duration > 1000) {
        addSession('global', null, globalStartedAt, sleepStart, duration);
      }
      globalStartedAt = activeProjects.size > 0 ? now : null;
    }
    changed = true;
  }

  // --- Per-project idle check ---
  for (const [pid, info] of activeProjects) {
    if (now - info.lastHeartbeat > IDLE_TIMEOUT) {
      // Idle out: finalize at last heartbeat time
      const duration = info.lastHeartbeat - info.startedAt;
      if (duration > 1000) {
        addSession('projects', pid, info.startedAt, info.lastHeartbeat, duration, info.source);
      }
      activeProjects.delete(pid);
      changed = true;
    }
  }

  // --- Global idle check ---
  if (globalStartedAt && activeProjects.size === 0) {
    const lastHb = runtime.globalLastHeartbeat || globalStartedAt;
    const duration = lastHb - globalStartedAt;
    if (duration > 1000) {
      addSession('global', null, globalStartedAt, lastHb, duration);
    }
    globalStartedAt = null;
    changed = true;
  }

  // --- Midnight check ---
  const todayStr = getTodayString();
  if (lastKnownDate && todayStr !== lastKnownDate) {
    splitSessionsAtMidnight(activeProjects, globalStartedAt);
    const midnight = startOfDay(now);

    // Reset session starts to midnight
    for (const info of activeProjects.values()) {
      info.startedAt = midnight;
    }
    if (globalStartedAt && activeProjects.size > 0) {
      globalStartedAt = midnight;
    }

    // Archive past months if month changed
    const oldMonth = lastKnownDate.substring(0, 7);
    const newMonth = todayStr.substring(0, 7);
    if (oldMonth !== newMonth) {
      archivePastMonths().catch(e => console.warn('[TimeTracking] archivePastMonths error:', e.message));
    }

    lastKnownDate = todayStr;
    changed = true;
  }

  if (changed) {
    trackingState.set({
      activeProjects,
      globalStartedAt,
      globalLastHeartbeat: activeProjects.size > 0 ? runtime.globalLastHeartbeat : null
    });
  }

  // --- Checkpoint save (always save on tick if there are active sessions) ---
  if (activeProjects.size > 0 || dirty) {
    save();
  }
}

function splitSessionsAtMidnight(activeProjects, globalStartedAt) {
  const midnight = startOfDay(Date.now());
  const preMidnight = midnight - 1;

  // Split project sessions
  for (const [pid, info] of activeProjects) {
    if (info.startedAt < midnight) {
      const duration = preMidnight - info.startedAt;
      if (duration > 1000) {
        addSession('projects', pid, info.startedAt, preMidnight, duration, info.source);
      }
    }
  }

  // Split global session
  if (globalStartedAt && globalStartedAt < midnight) {
    const duration = preMidnight - globalStartedAt;
    if (duration > 1000) {
      addSession('global', null, globalStartedAt, preMidnight, duration);
    }
  }
}

// ============================================================
// SESSION STORAGE
// ============================================================

function addSession(target, projectId, startTime, endTime, duration, source) {
  const state = dataState.get();
  const session = {
    id: `sess-${startTime}-${Math.random().toString(36).slice(2, 10)}`,
    startTime: new Date(startTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
    duration
  };
  if (source) session.source = source;

  if (target === 'global') {
    if (!state.global) state.global = { sessions: [] };
    state.global.sessions = mergeOrAppend(state.global.sessions, session);
  } else {
    if (!state.projects[projectId]) state.projects[projectId] = { sessions: [] };
    state.projects[projectId].sessions = mergeOrAppend(state.projects[projectId].sessions, session);
  }

  dataState.set({ ...state });
  dirty = true;
}

/**
 * Merge a new session with the last one if gap < MERGE_GAP, otherwise append.
 */
function mergeOrAppend(sessions, newSession) {
  if (!sessions.length) return [newSession];

  const last = sessions[sessions.length - 1];
  const lastEnd = new Date(last.endTime).getTime();
  const newStart = new Date(newSession.startTime).getTime();
  const gap = newStart - lastEnd;

  if (gap >= 0 && gap < MERGE_GAP) {
    // Merge: extend the last session
    last.endTime = newSession.endTime;
    last.duration += newSession.duration;
    return sessions;
  }

  if (gap < 0) {
    // Overlap: extend to max endTime, use wall-clock duration
    const lastStart = new Date(last.startTime).getTime();
    const newEnd = new Date(newSession.endTime).getTime();
    last.endTime = new Date(Math.max(lastEnd, newEnd)).toISOString();
    last.duration = Math.max(lastEnd, newEnd) - lastStart;
    return sessions;
  }

  // Gap >= MERGE_GAP: new session
  sessions.push(newSession);
  return sessions;
}

// ============================================================
// GETTERS (computed from sessions, never cached wrong)
// ============================================================

function getGlobalTimes() {
  const now = Date.now();
  const todayStart = startOfDay(now);
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);

  const state = dataState.get();
  let today = 0, week = 0, month = 0;

  // Sum from saved sessions (sessions may span period boundaries due to merging)
  for (const session of (state.global?.sessions || [])) {
    const start = new Date(session.startTime).getTime();
    const end = new Date(session.endTime).getTime();
    // Only count the portion of the session that falls within each period
    if (end > todayStart) today += Math.min(end, now) - Math.max(start, todayStart);
    if (end > weekStart) week += Math.min(end, now) - Math.max(start, weekStart);
    if (end > monthStart) month += Math.min(end, now) - Math.max(start, monthStart);
  }

  // Add elapsed time from active global session
  const runtime = trackingState.get();
  if (runtime.globalStartedAt) {
    const activeStart = runtime.globalStartedAt;
    if (now > Math.max(activeStart, todayStart)) today += now - Math.max(activeStart, todayStart);
    if (now > Math.max(activeStart, weekStart)) week += now - Math.max(activeStart, weekStart);
    if (now > Math.max(activeStart, monthStart)) month += now - Math.max(activeStart, monthStart);
  }

  return { today, week, month };
}

function getProjectTimes(projectId) {
  if (!projectId) return { today: 0, total: 0 };

  const now = Date.now();
  const todayStart = startOfDay(now);
  const state = dataState.get();
  const sessions = state.projects?.[projectId]?.sessions || [];

  let today = 0, total = 0;
  for (const s of sessions) {
    const start = new Date(s.startTime).getTime();
    const end = new Date(s.endTime).getTime();
    total += s.duration || 0;
    // Only count the portion that falls within today
    if (end > todayStart) today += Math.min(end, now) - Math.max(start, todayStart);
  }

  // Add active session time
  const runtime = trackingState.get();
  const active = runtime.activeProjects.get(projectId);
  if (active) {
    const elapsed = now - active.startedAt;
    total += elapsed;
    if (now > Math.max(active.startedAt, todayStart)) today += now - Math.max(active.startedAt, todayStart);
  }

  return { today, total };
}

function getProjectSessions(projectId) {
  if (!projectId) return [];
  const state = dataState.get();
  return state.projects?.[projectId]?.sessions || [];
}

function getGlobalTrackingData() {
  return dataState.get().global || { sessions: [] };
}

// ============================================================
// SHUTDOWN
// ============================================================

function saveAndShutdown() {
  const now = Date.now();
  const runtime = trackingState.get();

  // Finalize all active project sessions
  for (const [pid, info] of runtime.activeProjects) {
    const duration = now - info.startedAt;
    if (duration > 1000) {
      addSession('projects', pid, info.startedAt, now, duration, info.source);
    }
  }

  // Finalize global session
  if (runtime.globalStartedAt) {
    const duration = now - runtime.globalStartedAt;
    if (duration > 1000) {
      addSession('global', null, runtime.globalStartedAt, now, duration);
    }
  }

  // Stop tick
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (saveDebounceTimer) { clearTimeout(saveDebounceTimer); saveDebounceTimer = null; }

  // Reset runtime
  trackingState.set({
    activeProjects: new Map(),
    globalStartedAt: null,
    globalLastHeartbeat: null
  });

  // Save immediately
  saveImmediate();
}

// ============================================================
// HELPERS
// ============================================================

function isValidSession(s) {
  if (!s || !s.startTime || !s.endTime) return false;
  if (!Number.isFinite(s.duration) || s.duration <= 0) return false;
  if (s.duration > 24 * 60 * 60 * 1000) return false; // > 24h is invalid
  const start = new Date(s.startTime).getTime();
  const end = new Date(s.endTime).getTime();
  if (isNaN(start) || isNaN(end) || end < start) return false;
  return true;
}

function getTodayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getMonthString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeek(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1; // Monday = start of week
  d.setDate(d.getDate() - diff);
  return d.getTime();
}

function startOfMonth(ts) {
  const d = new Date(ts);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function getProjectName(projectId) {
  if (!projectsStateRef) return projectId;
  const projects = projectsStateRef.get().projects || [];
  const project = projects.find(p => p.id === projectId);
  return project?.name || projectId;
}

function isTracking(projectId) {
  return trackingState.get().activeProjects.has(projectId);
}

function getActiveProjectCount() {
  return trackingState.get().activeProjects.size;
}

module.exports = {
  trackingState,
  dataState,
  initTimeTracking,
  heartbeat,
  stopProject,
  saveAndShutdown,
  getProjectTimes,
  getGlobalTimes,
  getProjectSessions,
  getGlobalTrackingData,
  isTracking,
  getActiveProjectCount
};
