/**
 * Time Tracking State Module
 * Tracks time spent on each project based on terminal activity
 * Supports multiple projects being tracked simultaneously
 */

const { State } = require('./State');

// Constants
const IDLE_TIMEOUT = 15 * 60 * 1000; // 15 minutes
const OUTPUT_IDLE_TIMEOUT = 2 * 60 * 1000; // 2 minutes - idle after last terminal output
const SLEEP_GAP_THRESHOLD = 2 * 60 * 1000; // 2 minutes - gap indicating system sleep/wake
let lastHeartbeat = Date.now();
let heartbeatTimer = null;

// Runtime state (not persisted)
// activeSessions: Map<projectId, { sessionStartTime, lastActivityTime, isIdle }>
const trackingState = new State({
  activeSessions: new Map(),
  // Global tracking (real time worked, not sum of projects)
  globalSessionStartTime: null,
  globalLastActivityTime: null,
  globalIsIdle: false
});

// Internal state
const idleTimers = new Map(); // projectId -> timerId (input-based, 15 min)
const lastOutputTimes = new Map(); // projectId -> timestamp of last terminal output
let globalLastOutputTime = 0; // timestamp of last terminal output (any project)
let globalIdleTimer = null;
let midnightCheckTimer = null;
let lastKnownDate = null;
let projectsStateRef = null;
let saveProjectsRef = null;
let saveProjectsImmediateRef = null;
let globalTimesCache = null; // { sessionsToday, sessionsWeek, sessionsMonth, computedAt }

/**
 * Sanitize and validate all time tracking data on load
 * Fixes: negative times, NaN durations, future dates, malformed sessions
 */
function sanitizeTimeTrackingData() {
  if (!projectsStateRef) return;

  const currentState = projectsStateRef.get();
  let needsSave = false;
  const now = Date.now();
  const maxReasonableDuration = 24 * 60 * 60 * 1000; // 24h max per session

  // Sanitize per-project time tracking
  const projects = currentState.projects.map(p => {
    if (!p.timeTracking) return p;
    const tracking = { ...p.timeTracking };
    let changed = false;

    // Fix negative or NaN totalTime
    if (!Number.isFinite(tracking.totalTime) || tracking.totalTime < 0) {
      console.warn(`[TimeTracking] Sanitize: project ${p.id} totalTime was ${tracking.totalTime}, reset to 0`);
      tracking.totalTime = 0;
      changed = true;
    }

    // Fix negative or NaN todayTime
    if (!Number.isFinite(tracking.todayTime) || tracking.todayTime < 0) {
      tracking.todayTime = 0;
      changed = true;
    }

    // Fix future lastActiveDate
    if (tracking.lastActiveDate) {
      const lastDate = new Date(tracking.lastActiveDate + 'T00:00:00');
      if (lastDate.getTime() > now + 86400000) { // more than 1 day in the future
        tracking.lastActiveDate = null;
        tracking.todayTime = 0;
        changed = true;
      }
    }

    // Sanitize sessions
    if (Array.isArray(tracking.sessions)) {
      const validSessions = tracking.sessions.filter(s => {
        if (!s || !s.startTime || !s.endTime) return false;
        if (!Number.isFinite(s.duration) || s.duration <= 0) return false;
        if (s.duration > maxReasonableDuration) return false;
        const start = new Date(s.startTime).getTime();
        const end = new Date(s.endTime).getTime();
        if (isNaN(start) || isNaN(end)) return false;
        if (end < start) return false;
        return true;
      });

      if (validSessions.length !== tracking.sessions.length) {
        console.warn(`[TimeTracking] Sanitize: project ${p.id} removed ${tracking.sessions.length - validSessions.length} invalid sessions`);
        tracking.sessions = validSessions;
        changed = true;
      }
    } else {
      tracking.sessions = [];
      changed = true;
    }

    if (changed) {
      needsSave = true;
      return { ...p, timeTracking: tracking };
    }
    return p;
  });

  // Sanitize global time tracking
  let globalTracking = currentState.globalTimeTracking;
  if (globalTracking) {
    globalTracking = { ...globalTracking };
    let gChanged = false;

    for (const key of ['totalTime', 'todayTime', 'weekTime', 'monthTime']) {
      if (!Number.isFinite(globalTracking[key]) || globalTracking[key] < 0) {
        globalTracking[key] = 0;
        gChanged = true;
      }
    }

    if (Array.isArray(globalTracking.sessions)) {
      const validSessions = globalTracking.sessions.filter(s => {
        if (!s || !s.startTime || !s.endTime) return false;
        if (!Number.isFinite(s.duration) || s.duration <= 0) return false;
        if (s.duration > maxReasonableDuration) return false;
        const start = new Date(s.startTime).getTime();
        const end = new Date(s.endTime).getTime();
        if (isNaN(start) || isNaN(end)) return false;
        if (end < start) return false;
        return true;
      });

      if (validSessions.length !== globalTracking.sessions.length) {
        console.warn(`[TimeTracking] Sanitize: global removed ${globalTracking.sessions.length - validSessions.length} invalid sessions`);
        globalTracking.sessions = validSessions;
        gChanged = true;
      }
    } else {
      globalTracking.sessions = [];
      gChanged = true;
    }

    if (gChanged) {
      needsSave = true;
    }
  }

  if (needsSave) {
    const newState = { ...currentState, projects };
    if (globalTracking) {
      newState.globalTimeTracking = globalTracking;
    }
    projectsStateRef.set(newState);
    saveProjectsRef();
    console.log('[TimeTracking] Data sanitized and saved');
  }
}

/**
 * Initialize with references to projects state functions
 * @param {Object} projectsState - Reference to projectsState
 * @param {Function} saveProjects - Reference to saveProjects function (debounced)
 * @param {Function} saveProjectsImmediate - Reference to saveProjectsImmediate function (sync)
 */
function initTimeTracking(projectsState, saveProjects, saveProjectsImmediate) {
  projectsStateRef = projectsState;
  saveProjectsRef = saveProjects;
  saveProjectsImmediateRef = saveProjectsImmediate;
  console.log('[TimeTracking] Initialized with projectsState:', !!projectsState, 'saveProjects:', !!saveProjects, 'saveProjectsImmediate:', !!saveProjectsImmediate);

  // Sanitize data on load
  sanitizeTimeTrackingData();

  // Migrate existing data to new counter format
  migrateGlobalTimeTracking();

  // Start midnight check interval
  lastKnownDate = getTodayString();
  startMidnightCheck();

  // Start sleep/wake detection heartbeat
  startHeartbeat();
}

/**
 * Migrate global time tracking to use weekTime/monthTime counters
 * Called once at init to preserve existing session data
 */
function migrateGlobalTimeTracking() {
  if (!projectsStateRef || !saveProjectsRef) return;

  const currentState = projectsStateRef.get();
  const globalTracking = currentState.globalTimeTracking;

  if (!globalTracking) return;

  const weekStart = getWeekStartString();
  const monthStart = getMonthString();
  let needsSave = false;

  // Check if migration is needed (weekTime/monthTime don't exist or period changed)
  const needsWeekMigration = globalTracking.weekTime === undefined || globalTracking.weekStart !== weekStart;
  const needsMonthMigration = globalTracking.monthTime === undefined || globalTracking.monthStart !== monthStart;

  if (needsWeekMigration || needsMonthMigration) {
    // Calculate from existing sessions
    const sessions = globalTracking.sessions || [];

    // Week calculation
    if (needsWeekMigration) {
      const weekStartDate = new Date(weekStart + 'T00:00:00');
      const weekEndDate = new Date(weekStartDate);
      weekEndDate.setDate(weekEndDate.getDate() + 7);

      let weekTotal = 0;
      for (const session of sessions) {
        const sessionDate = new Date(session.startTime);
        if (sessionDate >= weekStartDate && sessionDate < weekEndDate) {
          weekTotal += session.duration || 0;
        }
      }

      globalTracking.weekTime = weekTotal;
      globalTracking.weekStart = weekStart;
      needsSave = true;
      console.log('[TimeTracking] Migrated weekTime:', Math.round(weekTotal / 1000) + 's');
    }

    // Month calculation
    if (needsMonthMigration) {
      const [year, month] = monthStart.split('-').map(Number);

      let monthTotal = 0;
      for (const session of sessions) {
        const sessionDate = new Date(session.startTime);
        if (sessionDate.getFullYear() === year && sessionDate.getMonth() + 1 === month) {
          monthTotal += session.duration || 0;
        }
      }

      globalTracking.monthTime = monthTotal;
      globalTracking.monthStart = monthStart;
      needsSave = true;
      console.log('[TimeTracking] Migrated monthTime:', Math.round(monthTotal / 1000) + 's');
    }

    if (needsSave) {
      projectsStateRef.set({ ...currentState, globalTimeTracking: globalTracking });
      saveProjectsRef();
    }
  }
}

/**
 * Start periodic midnight check to split sessions at day boundaries
 */
function startMidnightCheck() {
  clearInterval(midnightCheckTimer);
  midnightCheckTimer = setInterval(checkMidnightReset, 30 * 1000); // Check every 30 seconds
}

/**
 * Start heartbeat timer to detect system sleep/wake
 * Runs every 30 seconds; if gap between ticks > SLEEP_GAP_THRESHOLD, system was asleep
 */
function startHeartbeat() {
  clearInterval(heartbeatTimer);
  lastHeartbeat = Date.now();
  heartbeatTimer = setInterval(checkSleepWake, 30 * 1000);
}

/**
 * Check if system was asleep and handle session splitting
 */
function checkSleepWake() {
  const now = Date.now();
  const elapsed = now - lastHeartbeat;
  lastHeartbeat = now;

  if (elapsed > SLEEP_GAP_THRESHOLD) {
    console.log(`[TimeTracking] Sleep/wake detected: gap of ${Math.round(elapsed / 1000)}s`);
    handleSleepWake(now - elapsed, now);
  }
}

/**
 * Handle system sleep/wake: cut active sessions at the last known awake time
 * @param {number} sleepStart - Approximate time system went to sleep (last heartbeat)
 * @param {number} wakeTime - Time system woke up (now)
 */
function handleSleepWake(sleepStart, wakeTime) {
  const state = trackingState.get();

  // Cut global session at sleep time, restart from wake time
  if (state.globalSessionStartTime && !state.globalIsIdle) {
    const duration = sleepStart - state.globalSessionStartTime;
    if (duration > 1000) {
      saveGlobalSession(state.globalSessionStartTime, sleepStart, duration);
    }
    trackingState.set({
      ...trackingState.get(),
      globalSessionStartTime: wakeTime,
      globalLastActivityTime: wakeTime
    });
    console.log('[TimeTracking] Global session cut at sleep boundary');
  }

  // Cut project sessions
  const activeSessions = new Map(trackingState.get().activeSessions);
  for (const [projectId, session] of activeSessions) {
    if (session.sessionStartTime && !session.isIdle) {
      const duration = sleepStart - session.sessionStartTime;
      if (duration > 1000) {
        saveSession(projectId, session.sessionStartTime, sleepStart, duration);
      }
      activeSessions.set(projectId, {
        ...session,
        sessionStartTime: wakeTime,
        lastActivityTime: wakeTime
      });
      console.log('[TimeTracking] Project session cut at sleep boundary:', projectId);
    }
  }

  trackingState.set({ ...trackingState.get(), activeSessions });
}

/**
 * Check if the date has changed (midnight crossed) and split active sessions
 */
function checkMidnightReset() {
  const today = getTodayString();

  if (lastKnownDate && lastKnownDate !== today) {
    console.log('[TimeTracking] Midnight detected! Date changed from', lastKnownDate, 'to', today);
    lastKnownDate = today;
    globalTimesCache = null; // Invalidate cache on date change
    splitSessionsAtMidnight();
  }
}

/**
 * Split all active sessions at midnight boundary
 * Saves the pre-midnight portion, then restarts sessions from midnight
 */
function splitSessionsAtMidnight() {
  const state = trackingState.get();
  const now = Date.now();
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const midnightTs = todayMidnight.getTime();

  // Split global session
  if (state.globalSessionStartTime && !state.globalIsIdle) {
    const duration = midnightTs - state.globalSessionStartTime;
    if (duration > 1000) {
      saveGlobalSession(state.globalSessionStartTime, midnightTs, duration);
    }
    // Restart from midnight
    trackingState.set({
      ...trackingState.get(),
      globalSessionStartTime: midnightTs,
      globalLastActivityTime: now
    });
    console.log('[TimeTracking] Global session split at midnight');
  }

  // Split project sessions
  const activeSessions = new Map(trackingState.get().activeSessions);
  for (const [projectId, session] of activeSessions) {
    if (session.sessionStartTime && !session.isIdle) {
      const duration = midnightTs - session.sessionStartTime;
      if (duration > 1000) {
        saveSession(projectId, session.sessionStartTime, midnightTs, duration);
      }
      // Restart from midnight
      activeSessions.set(projectId, {
        ...session,
        sessionStartTime: midnightTs,
        lastActivityTime: now
      });
      console.log('[TimeTracking] Project session split at midnight:', projectId);
    }
  }

  trackingState.set({ ...trackingState.get(), activeSessions });
}

/**
 * Get today's date string for comparison (ISO format YYYY-MM-DD)
 * @returns {string}
 */
function getTodayString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Get the start of the current week (Monday 00:00:00)
 * @returns {string} ISO string of week start
 */
function getWeekStartString() {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1; // Monday = 0 diff
  const monday = new Date(now);
  monday.setDate(monday.getDate() - diff);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString().split('T')[0]; // YYYY-MM-DD
}

/**
 * Get the current month string (YYYY-MM)
 * @returns {string}
 */
function getMonthString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Initialize time tracking data for a project if not present
 * @param {Object} project
 * @returns {Object} - The timeTracking object
 */
function ensureTimeTracking(project) {
  if (!project.timeTracking) {
    project.timeTracking = {
      totalTime: 0,
      todayTime: 0,
      lastActiveDate: null,
      sessions: []
    };
  }
  return project.timeTracking;
}

/**
 * Reset today's time if date has changed
 * @param {Object} project
 */
function resetTodayIfNeeded(project) {
  const tracking = ensureTimeTracking(project);
  const today = getTodayString();

  if (tracking.lastActiveDate !== today) {
    tracking.todayTime = 0;
    tracking.lastActiveDate = today;
  }
}

/**
 * Get project by ID from projects state
 * @param {string} projectId
 * @returns {Object|undefined}
 */
function getProjectById(projectId) {
  if (!projectsStateRef) return undefined;
  return projectsStateRef.get().projects.find(p => p.id === projectId);
}

/**
 * Generate unique session ID
 * @returns {string}
 */
function generateSessionId() {
  return `sess-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Get count of non-idle active sessions
 * @returns {number}
 */
function getActiveNonIdleCount() {
  const state = trackingState.get();
  let count = 0;
  for (const session of state.activeSessions.values()) {
    if (session.sessionStartTime && !session.isIdle) {
      count++;
    }
  }
  return count;
}

/**
 * Start global timer if not already running
 */
function startGlobalTimer() {
  const state = trackingState.get();

  // Already running
  if (state.globalSessionStartTime && !state.globalIsIdle) {
    return;
  }

  const now = Date.now();

  trackingState.set({
    ...state,
    globalSessionStartTime: now,
    globalLastActivityTime: now,
    globalIsIdle: false
  });

  // Start global idle timer
  clearTimeout(globalIdleTimer);
  globalIdleTimer = setTimeout(checkAndPauseGlobalTimer, IDLE_TIMEOUT);

  console.log('[TimeTracking] Global timer started');
}

/**
 * Pause global timer (idle)
 */
function pauseGlobalTimer() {
  const state = trackingState.get();

  if (!state.globalSessionStartTime || state.globalIsIdle) {
    return;
  }

  // Save global session
  const now = Date.now();
  const duration = now - state.globalSessionStartTime;

  if (duration > 1000) {
    saveGlobalSession(state.globalSessionStartTime, now, duration);
  }

  trackingState.set({
    ...state,
    globalSessionStartTime: null,
    globalIsIdle: true
  });

  console.log('[TimeTracking] Global timer paused (idle)');
}

/**
 * Resume global timer after activity
 */
function resumeGlobalTimer() {
  const state = trackingState.get();

  if (!state.globalIsIdle) {
    return;
  }

  const now = Date.now();

  trackingState.set({
    ...state,
    globalSessionStartTime: now,
    globalLastActivityTime: now,
    globalIsIdle: false
  });

  // Restart global idle timer
  clearTimeout(globalIdleTimer);
  globalIdleTimer = setTimeout(checkAndPauseGlobalTimer, IDLE_TIMEOUT);

  console.log('[TimeTracking] Global timer resumed');
}

/**
 * Stop global timer completely
 */
function stopGlobalTimer() {
  const state = trackingState.get();

  if (state.globalSessionStartTime && !state.globalIsIdle) {
    const now = Date.now();
    const duration = now - state.globalSessionStartTime;

    if (duration > 1000) {
      saveGlobalSession(state.globalSessionStartTime, now, duration);
    }
  }

  clearTimeout(globalIdleTimer);

  trackingState.set({
    ...state,
    globalSessionStartTime: null,
    globalLastActivityTime: null,
    globalIsIdle: false
  });

  console.log('[TimeTracking] Global timer stopped');
}

/**
 * Reset global idle timer on activity
 */
function resetGlobalIdleTimer() {
  const state = trackingState.get();

  if (state.globalIsIdle) {
    resumeGlobalTimer();
    return;
  }

  if (state.globalSessionStartTime) {
    clearTimeout(globalIdleTimer);
    globalIdleTimer = setTimeout(checkAndPauseGlobalTimer, IDLE_TIMEOUT);

    trackingState.set({
      ...state,
      globalLastActivityTime: Date.now()
    });
  }
}

/**
 * Save a global session
 * @param {number} startTime
 * @param {number} endTime
 * @param {number} duration
 */
function saveGlobalSession(startTime, endTime, duration) {
  console.log('[TimeTracking] saveGlobalSession:', { duration: Math.round(duration / 1000) + 's' });

  if (!projectsStateRef || !saveProjectsRef) {
    return;
  }

  const today = getTodayString();
  const weekStart = getWeekStartString();
  const monthStart = getMonthString();

  // Immutable update: read fresh state, produce new object without mutation
  const currentState = projectsStateRef.get();
  const prev = currentState.globalTimeTracking || {
    totalTime: 0, todayTime: 0, weekTime: 0, monthTime: 0,
    lastActiveDate: null, weekStart: null, monthStart: null, sessions: []
  };

  const todayTime = (prev.lastActiveDate !== today ? 0 : (prev.todayTime || 0)) + duration;
  const weekTime = (prev.weekStart !== weekStart ? 0 : (prev.weekTime || 0)) + duration;
  const monthTime = (prev.monthStart !== monthStart ? 0 : (prev.monthTime || 0)) + duration;

  const newSession = {
    id: generateSessionId(),
    startTime: new Date(startTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
    duration
  };

  let sessions = [...(prev.sessions || []), newSession];
  if (sessions.length > 500) {
    sessions = sessions.slice(-500);
  }

  const globalTracking = {
    ...prev,
    totalTime: (prev.totalTime || 0) + duration,
    todayTime,
    weekTime,
    monthTime,
    lastActiveDate: today,
    weekStart,
    monthStart,
    sessions
  };

  // Invalidate global times cache
  globalTimesCache = null;

  projectsStateRef.set({ ...currentState, globalTimeTracking: globalTracking });
  saveProjectsRef();
}

/**
 * Start tracking time for a project
 * Supports multiple projects being tracked simultaneously
 * @param {string} projectId
 */
function startTracking(projectId) {
  console.log('[TimeTracking] startTracking called with projectId:', projectId);

  if (!projectId) {
    console.warn('[TimeTracking] startTracking called with undefined/null projectId');
    return;
  }

  const state = trackingState.get();
  const activeSessions = new Map(state.activeSessions);
  const existingSession = activeSessions.get(projectId);

  // Already tracking this project and not idle
  if (existingSession && existingSession.sessionStartTime && !existingSession.isIdle) {
    console.log('[TimeTracking] Already tracking project:', projectId);
    return;
  }

  // If was idle, resume instead
  if (existingSession && existingSession.isIdle) {
    resumeTracking(projectId);
    return;
  }

  // Check if this is the first active project (for global timer)
  const wasEmpty = getActiveNonIdleCount() === 0;

  const now = Date.now();

  // Add new session for this project
  activeSessions.set(projectId, {
    sessionStartTime: now,
    lastActivityTime: now,
    isIdle: false
  });

  trackingState.set({ ...trackingState.get(), activeSessions });

  console.log('[TimeTracking] Started tracking project:', projectId, 'Total active:', activeSessions.size);

  // Start global timer if this is the first active project
  if (wasEmpty) {
    startGlobalTimer();
  }

  // Start idle timer for this project
  clearTimeout(idleTimers.get(projectId));
  idleTimers.set(projectId, setTimeout(() => checkAndPauseTracking(projectId), IDLE_TIMEOUT));
}

/**
 * Stop tracking and save the session for a specific project
 * @param {string} projectId
 */
function stopTracking(projectId) {
  const state = trackingState.get();
  const activeSessions = new Map(state.activeSessions);
  const session = activeSessions.get(projectId);

  // Not tracking this project
  if (!session || !session.sessionStartTime) {
    activeSessions.delete(projectId);
    trackingState.set({ ...trackingState.get(), activeSessions });
    return;
  }

  const now = Date.now();
  const duration = now - session.sessionStartTime;

  // Only save if we have a meaningful duration (> 1 second)
  if (duration > 1000) {
    saveSession(projectId, session.sessionStartTime, now, duration);
  }

  // Clear timers and remove session
  clearTimeout(idleTimers.get(projectId));
  idleTimers.delete(projectId);
  lastOutputTimes.delete(projectId);
  activeSessions.delete(projectId);

  trackingState.set({ ...trackingState.get(), activeSessions });

  console.log('[TimeTracking] Stopped tracking project:', projectId, 'Remaining active:', activeSessions.size);

  // Stop global timer if no more active projects
  if (getActiveNonIdleCount() === 0) {
    stopGlobalTimer();
  }
}

/**
 * Save a session to the project's time tracking data
 * @param {string} projectId
 * @param {number} startTime
 * @param {number} endTime
 * @param {number} duration
 */
function saveSession(projectId, startTime, endTime, duration) {
  console.log('[TimeTracking] saveSession called:', { projectId, duration: Math.round(duration / 1000) + 's' });

  if (!projectsStateRef || !saveProjectsRef) {
    console.error('[TimeTracking] Cannot save session - refs not initialized');
    return;
  }

  const today = getTodayString();
  const newSession = {
    id: generateSessionId(),
    startTime: new Date(startTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
    duration
  };

  // Immutable update: read fresh state, produce new state without mutation
  const currentState = projectsStateRef.get();
  const projects = currentState.projects.map(p => {
    if (p.id !== projectId) return p;

    const tracking = p.timeTracking ? { ...p.timeTracking } : {
      totalTime: 0, todayTime: 0, lastActiveDate: null, sessions: []
    };

    // Reset today if date changed
    if (tracking.lastActiveDate !== today) {
      tracking.todayTime = 0;
    }

    tracking.totalTime = (tracking.totalTime || 0) + duration;
    tracking.todayTime = (tracking.todayTime || 0) + duration;
    tracking.lastActiveDate = today;
    tracking.sessions = [...(tracking.sessions || []), newSession];

    // Limit sessions
    if (tracking.sessions.length > 100) {
      tracking.sessions = tracking.sessions.slice(-100);
    }

    return { ...p, timeTracking: tracking };
  });

  projectsStateRef.set({ ...currentState, projects });
  saveProjectsRef();
}

/**
 * Record activity for a specific project - resets idle timer
 * @param {string} projectId
 */
function recordActivity(projectId) {
  if (!projectId) return;

  const state = trackingState.get();
  const activeSessions = new Map(state.activeSessions);
  const session = activeSessions.get(projectId);

  // Not tracking this project - start tracking
  if (!session) {
    startTracking(projectId);
    return;
  }

  // Resume if was idle
  if (session.isIdle) {
    resumeTracking(projectId);
    return;
  }

  // Reset idle timer for project
  clearTimeout(idleTimers.get(projectId));
  idleTimers.set(projectId, setTimeout(() => checkAndPauseTracking(projectId), IDLE_TIMEOUT));

  // Reset global idle timer too
  resetGlobalIdleTimer();

  // Update last activity time
  activeSessions.set(projectId, {
    ...session,
    lastActivityTime: Date.now()
  });

  trackingState.set({ ...trackingState.get(), activeSessions });
}

/**
 * Check if project can be paused: if there was recent terminal output, reschedule instead
 * @param {string} projectId
 */
function checkAndPauseTracking(projectId) {
  const lastOutput = lastOutputTimes.get(projectId) || 0;
  const timeSinceOutput = Date.now() - lastOutput;

  if (timeSinceOutput < OUTPUT_IDLE_TIMEOUT) {
    // Terminal still producing output recently, reschedule
    const delay = OUTPUT_IDLE_TIMEOUT - timeSinceOutput + 100;
    clearTimeout(idleTimers.get(projectId));
    idleTimers.set(projectId, setTimeout(() => checkAndPauseTracking(projectId), delay));
    return;
  }

  pauseTracking(projectId);
}

/**
 * Check if global timer can be paused: if there was recent terminal output, reschedule
 */
function checkAndPauseGlobalTimer() {
  const timeSinceOutput = Date.now() - globalLastOutputTime;

  if (timeSinceOutput < OUTPUT_IDLE_TIMEOUT) {
    const delay = OUTPUT_IDLE_TIMEOUT - timeSinceOutput + 100;
    clearTimeout(globalIdleTimer);
    globalIdleTimer = setTimeout(checkAndPauseGlobalTimer, delay);
    return;
  }

  pauseGlobalTimer();
}

/**
 * Record terminal output activity for a project (keeps session alive with shorter timeout)
 * Does NOT resume idle sessions - only user input can do that
 * @param {string} projectId
 */
function recordOutputActivity(projectId) {
  if (!projectId) return;

  const state = trackingState.get();
  const session = state.activeSessions.get(projectId);

  // Only track output for active (non-idle) sessions
  if (!session || session.isIdle) return;

  lastOutputTimes.set(projectId, Date.now());
  globalLastOutputTime = Date.now();
}

/**
 * Pause tracking for a specific project due to idle
 * @param {string} projectId
 */
function pauseTracking(projectId) {
  const state = trackingState.get();
  const activeSessions = new Map(state.activeSessions);
  const session = activeSessions.get(projectId);

  if (!session || !session.sessionStartTime || session.isIdle) {
    return;
  }

  const now = Date.now();
  const duration = now - session.sessionStartTime;

  // Save the session up to now
  if (duration > 1000) {
    saveSession(projectId, session.sessionStartTime, now, duration);
  }

  // Mark as idle but keep in activeSessions
  activeSessions.set(projectId, {
    ...session,
    sessionStartTime: null,
    isIdle: true
  });

  trackingState.set({ ...trackingState.get(), activeSessions });

  console.log('[TimeTracking] Paused tracking (idle) for project:', projectId);

  // Pause global timer if no more active (non-idle) projects
  if (getActiveNonIdleCount() === 0) {
    pauseGlobalTimer();
  }
}

/**
 * Resume tracking for a specific project after activity
 * @param {string} projectId
 */
function resumeTracking(projectId) {
  const state = trackingState.get();
  const activeSessions = new Map(state.activeSessions);
  const session = activeSessions.get(projectId);

  if (!session || !session.isIdle) {
    return;
  }

  // Check if this will be the first active project (for global timer)
  const wasAllIdle = getActiveNonIdleCount() === 0;

  const now = Date.now();

  activeSessions.set(projectId, {
    sessionStartTime: now,
    lastActivityTime: now,
    isIdle: false
  });

  trackingState.set({ ...trackingState.get(), activeSessions });

  // Resume global timer if this is the first to resume
  if (wasAllIdle) {
    resumeGlobalTimer();
  }

  // Restart idle timer
  clearTimeout(idleTimers.get(projectId));
  idleTimers.set(projectId, setTimeout(() => checkAndPauseTracking(projectId), IDLE_TIMEOUT));

  console.log('[TimeTracking] Resumed tracking for project:', projectId);
}

/**
 * Switch tracking focus (for backward compatibility)
 * Now just ensures both projects are tracked appropriately
 * @param {string} oldProjectId
 * @param {string} newProjectId
 */
function switchProject(oldProjectId, newProjectId) {
  // With multi-project support, we don't stop the old project
  // Just ensure the new project is being tracked
  if (newProjectId) {
    startTracking(newProjectId);
  }
}

/**
 * Get time tracking data for a project
 * @param {string} projectId
 * @returns {{ today: number, total: number }}
 */
function getProjectTimes(projectId) {
  const project = getProjectById(projectId);

  if (!project || !project.timeTracking) {
    return { today: 0, total: 0 };
  }

  // Check if we need to reset today
  const tracking = project.timeTracking;
  const today = getTodayString();

  if (tracking.lastActiveDate !== today) {
    return { today: 0, total: tracking.totalTime || 0 };
  }

  // Add current session time if actively tracking this project
  const state = trackingState.get();
  const session = state.activeSessions.get(projectId);
  let currentSessionTime = 0;
  let currentSessionTimeToday = 0;

  if (session && session.sessionStartTime && !session.isIdle) {
    const now = Date.now();
    currentSessionTime = now - session.sessionStartTime;

    // Clip to today boundary for todayTime
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const effectiveStart = Math.max(session.sessionStartTime, todayStart.getTime());
    currentSessionTimeToday = Math.max(0, now - effectiveStart);
  }

  return {
    today: (tracking.todayTime || 0) + currentSessionTimeToday,
    total: (tracking.totalTime || 0) + currentSessionTime
  };
}

/**
 * Save all active sessions (for app close)
 */
function saveAllActiveSessions() {
  const state = trackingState.get();
  const now = Date.now();

  // Save all project sessions
  for (const [projectId, session] of state.activeSessions) {
    if (session.sessionStartTime && !session.isIdle) {
      const duration = now - session.sessionStartTime;

      if (duration > 1000) {
        saveSession(projectId, session.sessionStartTime, now, duration);
      }
    }
  }

  // Save global session
  if (state.globalSessionStartTime && !state.globalIsIdle) {
    const duration = now - state.globalSessionStartTime;
    if (duration > 1000) {
      saveGlobalSession(state.globalSessionStartTime, now, duration);
    }
  }

  // Clear all timers and state
  for (const timerId of idleTimers.values()) {
    clearTimeout(timerId);
  }
  idleTimers.clear();
  clearTimeout(globalIdleTimer);
  clearInterval(midnightCheckTimer);
  clearInterval(heartbeatTimer);

  trackingState.set({
    activeSessions: new Map(),
    globalSessionStartTime: null,
    globalLastActivityTime: null,
    globalIsIdle: false
  });

  // Force immediate save (bypass debounce) for app close
  if (saveProjectsImmediateRef) {
    saveProjectsImmediateRef();
    console.log('[TimeTracking] Forced immediate save on quit');
  }
}

/**
 * Check if there are terminals for a project
 * @param {string} projectId
 * @param {Map} terminals - Terminals map from terminalsState
 * @returns {boolean}
 */
function hasTerminalsForProject(projectId, terminals) {
  for (const [, termData] of terminals) {
    if (termData.project && termData.project.id === projectId) {
      return true;
    }
  }
  return false;
}

/**
 * Get the tracking state (for debugging)
 * @returns {Object}
 */
function getTrackingState() {
  return trackingState.get();
}

/**
 * Get global time tracking stats (real time, not sum of projects)
 * Always calculates from sessions to ensure accuracy
 * @returns {{ today: number, week: number, month: number }}
 */
function getGlobalTimes() {
  if (!projectsStateRef) {
    console.warn('[TimeTracking] getGlobalTimes called but projectsStateRef is null');
    return { today: 0, week: 0, month: 0 };
  }

  const now = new Date();
  const nowMs = now.getTime();

  // Calculate date boundaries
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart);
  todayEnd.setDate(todayEnd.getDate() + 1);

  const day = now.getDay();
  const diffToMonday = day === 0 ? 6 : day - 1;
  const weekStartDate = new Date(now);
  weekStartDate.setDate(weekStartDate.getDate() - diffToMonday);
  weekStartDate.setHours(0, 0, 0, 0);
  const weekEndDate = new Date(weekStartDate);
  weekEndDate.setDate(weekEndDate.getDate() + 7);

  const monthStartDate = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEndDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  // Use cached session totals if available (invalidated on save)
  let todayTotal, weekTotal, monthTotal;

  if (globalTimesCache) {
    todayTotal = globalTimesCache.sessionsToday;
    weekTotal = globalTimesCache.sessionsWeek;
    monthTotal = globalTimesCache.sessionsMonth;
  } else {
    todayTotal = 0;
    weekTotal = 0;
    monthTotal = 0;

    const currentState = projectsStateRef.get();
    const globalTracking = currentState.globalTimeTracking;

    if (globalTracking) {
      const sessions = globalTracking.sessions || [];
      for (const session of sessions) {
        const sessionDate = new Date(session.startTime);
        const duration = session.duration || 0;

        if (sessionDate >= todayStart && sessionDate < todayEnd) {
          todayTotal += duration;
        }
        if (sessionDate >= weekStartDate && sessionDate < weekEndDate) {
          weekTotal += duration;
        }
        if (sessionDate >= monthStartDate && sessionDate < monthEndDate) {
          monthTotal += duration;
        }
      }
    }

    globalTimesCache = {
      sessionsToday: todayTotal,
      sessionsWeek: weekTotal,
      sessionsMonth: monthTotal
    };
  }

  // Add current global session time if active, clipped to period boundaries
  const state = trackingState.get();
  if (state.globalSessionStartTime && !state.globalIsIdle) {
    const sessionStart = state.globalSessionStartTime;

    const todayEffectiveStart = Math.max(sessionStart, todayStart.getTime());
    if (nowMs > todayEffectiveStart) {
      todayTotal += nowMs - todayEffectiveStart;
    }

    const weekEffectiveStart = Math.max(sessionStart, weekStartDate.getTime());
    if (nowMs > weekEffectiveStart) {
      weekTotal += nowMs - weekEffectiveStart;
    }

    const monthEffectiveStart = Math.max(sessionStart, monthStartDate.getTime());
    if (nowMs > monthEffectiveStart) {
      monthTotal += nowMs - monthEffectiveStart;
    }
  }

  return { today: todayTotal, week: weekTotal, month: monthTotal };
}

/**
 * Check if a project is currently being tracked
 * @param {string} projectId
 * @returns {boolean}
 */
function isTracking(projectId) {
  const state = trackingState.get();
  const session = state.activeSessions.get(projectId);
  return session && session.sessionStartTime && !session.isIdle;
}

/**
 * Get count of actively tracked projects
 * @returns {number}
 */
function getActiveProjectCount() {
  const state = trackingState.get();
  let count = 0;
  for (const session of state.activeSessions.values()) {
    if (session.sessionStartTime && !session.isIdle) {
      count++;
    }
  }
  return count;
}

module.exports = {
  trackingState,
  initTimeTracking,
  startTracking,
  stopTracking,
  recordActivity,
  recordOutputActivity,
  pauseTracking,
  resumeTracking,
  switchProject,
  getProjectTimes,
  getGlobalTimes,
  saveAllActiveSessions,
  hasTerminalsForProject,
  getTrackingState,
  ensureTimeTracking,
  isTracking,
  getActiveProjectCount
};
