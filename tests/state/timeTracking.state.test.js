const {
  trackingState,
  dataState,
  heartbeat,
  stopProject,
  saveAndShutdown,
  getProjectTimes,
  getGlobalTimes,
  getProjectSessions,
  getGlobalTrackingData,
  isTracking,
  getActiveProjectCount,
} = require('../../src/renderer/state/timeTracking.state');

// Mock ArchiveService
jest.mock('../../src/renderer/services/ArchiveService', () => ({
  migrateOldArchives: jest.fn(),
  appendToArchive: jest.fn(),
  isCurrentMonth: jest.fn(() => true),
  getMonthsInRange: jest.fn(() => []),
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();

  // Reset fs mocks
  window.electron_nodeModules.fs.existsSync = jest.fn(() => false);
  window.electron_nodeModules.fs.readFileSync = jest.fn(() => '{}');
  window.electron_nodeModules.fs.writeFileSync = jest.fn();
  window.electron_nodeModules.fs.copyFileSync = jest.fn();
  window.electron_nodeModules.fs.renameSync = jest.fn();
  window.electron_nodeModules.fs.unlinkSync = jest.fn();
  window.electron_nodeModules.fs.promises.readFile = jest.fn().mockResolvedValue('{}');

  // Reset tracking state
  trackingState.set({
    activeProjects: new Map(),
    globalStartedAt: null,
    globalLastHeartbeat: null
  });

  // Reset persisted data state
  dataState.set({
    version: 3,
    month: null,
    global: { sessions: [] },
    projects: {}
  });
});

afterEach(() => {
  // Stop all active tracking to clean up timers
  const state = trackingState.get();
  for (const [id] of state.activeProjects) {
    stopProject(id);
  }
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

// ── heartbeat ──

describe('heartbeat', () => {
  test('auto-starts tracking for a project', () => {
    heartbeat('proj-1', 'terminal');
    expect(isTracking('proj-1')).toBe(true);
  });

  test('starts global timer on first heartbeat', () => {
    heartbeat('proj-1', 'terminal');
    const state = trackingState.get();
    expect(state.globalStartedAt).toBeGreaterThan(0);
    expect(state.globalLastHeartbeat).toBeGreaterThan(0);
  });

  test('throttles heartbeats within 1 second', () => {
    heartbeat('proj-1', 'terminal');
    const firstHb = trackingState.get().activeProjects.get('proj-1').lastHeartbeat;

    // Second heartbeat within 1s should be ignored
    jest.advanceTimersByTime(500);
    heartbeat('proj-1', 'terminal');
    const secondHb = trackingState.get().activeProjects.get('proj-1').lastHeartbeat;
    expect(secondHb).toBe(firstHb);

    // After 1s, heartbeat should go through
    jest.advanceTimersByTime(600);
    heartbeat('proj-1', 'terminal');
    const thirdHb = trackingState.get().activeProjects.get('proj-1').lastHeartbeat;
    expect(thirdHb).toBeGreaterThan(firstHb);
  });

  test('does nothing for null projectId', () => {
    heartbeat(null, 'terminal');
    expect(getActiveProjectCount()).toBe(0);
  });

  test('tracks multiple projects independently', () => {
    heartbeat('proj-1', 'terminal');
    heartbeat('proj-2', 'chat');
    expect(getActiveProjectCount()).toBe(2);
    expect(isTracking('proj-1')).toBe(true);
    expect(isTracking('proj-2')).toBe(true);
  });
});

// ── stopProject ──

describe('stopProject', () => {
  test('removes project from active sessions', () => {
    heartbeat('proj-1', 'terminal');
    jest.advanceTimersByTime(5000);
    stopProject('proj-1');
    expect(isTracking('proj-1')).toBe(false);
  });

  test('stops global timer when last project stopped', () => {
    heartbeat('proj-1', 'terminal');
    jest.advanceTimersByTime(5000);
    stopProject('proj-1');
    const state = trackingState.get();
    expect(state.globalStartedAt).toBeNull();
  });

  test('keeps global timer when other projects still active', () => {
    heartbeat('proj-1', 'terminal');
    heartbeat('proj-2', 'chat');
    jest.advanceTimersByTime(5000);
    stopProject('proj-1');
    const state = trackingState.get();
    expect(state.globalStartedAt).toBeGreaterThan(0);
    expect(isTracking('proj-2')).toBe(true);
  });

  test('does nothing for non-tracked project', () => {
    // Should not throw
    stopProject('unknown');
    expect(getActiveProjectCount()).toBe(0);
  });
});

// ── isTracking ──

describe('isTracking', () => {
  test('returns false for non-tracked project', () => {
    expect(isTracking('unknown-project')).toBe(false);
  });

  test('returns true after heartbeat', () => {
    heartbeat('proj-1', 'terminal');
    expect(isTracking('proj-1')).toBe(true);
  });

  test('returns false after stopProject', () => {
    heartbeat('proj-1', 'terminal');
    jest.advanceTimersByTime(5000);
    stopProject('proj-1');
    expect(isTracking('proj-1')).toBe(false);
  });
});

// ── getActiveProjectCount ──

describe('getActiveProjectCount', () => {
  test('returns 0 when nothing is tracked', () => {
    expect(getActiveProjectCount()).toBe(0);
  });

  test('counts active projects', () => {
    heartbeat('proj-1', 'terminal');
    heartbeat('proj-2', 'chat');
    expect(getActiveProjectCount()).toBe(2);
  });
});

// ── getProjectTimes ──

describe('getProjectTimes', () => {
  test('returns zeros for unknown project', () => {
    const times = getProjectTimes('unknown');
    expect(times.today).toBe(0);
    expect(times.total).toBe(0);
  });

  test('returns null project gracefully', () => {
    const times = getProjectTimes(null);
    expect(times.today).toBe(0);
    expect(times.total).toBe(0);
  });
});

// ── getGlobalTimes ──

describe('getGlobalTimes', () => {
  test('returns object with today, week, month keys', () => {
    const times = getGlobalTimes();
    expect(times).toHaveProperty('today');
    expect(times).toHaveProperty('week');
    expect(times).toHaveProperty('month');
    expect(typeof times.today).toBe('number');
    expect(typeof times.week).toBe('number');
    expect(typeof times.month).toBe('number');
  });

  test('returns zeros when no sessions', () => {
    const times = getGlobalTimes();
    expect(times.today).toBe(0);
    expect(times.week).toBe(0);
    expect(times.month).toBe(0);
  });
});

// ── getProjectSessions ──

describe('getProjectSessions', () => {
  test('returns empty array for unknown project', () => {
    expect(getProjectSessions('unknown')).toEqual([]);
  });

  test('returns empty array for null project', () => {
    expect(getProjectSessions(null)).toEqual([]);
  });
});

// ── getGlobalTrackingData ──

describe('getGlobalTrackingData', () => {
  test('returns object with sessions array', () => {
    const data = getGlobalTrackingData();
    expect(data).toHaveProperty('sessions');
    expect(Array.isArray(data.sessions)).toBe(true);
  });
});

// ── getProjectTimes with real data ──

describe('getProjectTimes with sessions', () => {
  test('computes total from saved sessions', () => {
    // Place sessions right after start of today to guarantee they fall within today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const base = todayStart.getTime() + 1000; // 1 second after midnight
    dataState.set({
      version: 3,
      month: null,
      global: { sessions: [] },
      projects: {
        'proj-1': {
          sessions: [
            { startTime: new Date(base).toISOString(), endTime: new Date(base + 3600000).toISOString(), duration: 3600000 },
            { startTime: new Date(base + 3600000).toISOString(), endTime: new Date(base + 4800000).toISOString(), duration: 1200000 },
          ]
        }
      }
    });
    const times = getProjectTimes('proj-1');
    expect(times.total).toBe(3600000 + 1200000);
    expect(times.today).toBeGreaterThan(0);
  });

  test('today only counts today portion of sessions', () => {
    const now = Date.now();
    const yesterdayStart = now - 48 * 60 * 60 * 1000; // 2 days ago
    const yesterdayEnd = now - 47 * 60 * 60 * 1000;   // still yesterday
    dataState.set({
      version: 3,
      month: null,
      global: { sessions: [] },
      projects: {
        'proj-old': {
          sessions: [
            { startTime: new Date(yesterdayStart).toISOString(), endTime: new Date(yesterdayEnd).toISOString(), duration: 3600000 },
          ]
        }
      }
    });
    const times = getProjectTimes('proj-old');
    expect(times.total).toBe(3600000);
    expect(times.today).toBe(0); // session is from yesterday
  });

  test('includes active session elapsed time', () => {
    const now = Date.now();
    heartbeat('proj-active', 'terminal');
    jest.advanceTimersByTime(5000); // 5 seconds of "active time"
    const times = getProjectTimes('proj-active');
    expect(times.total).toBeGreaterThan(0);
  });
});

// ── getGlobalTimes with real data ──

describe('getGlobalTimes with sessions', () => {
  test('computes today/week/month from sessions', () => {
    // Use a fixed time at noon to avoid timezone edge cases near midnight
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    jest.setSystemTime(noon);
    const now = Date.now();
    dataState.set({
      version: 3,
      month: null,
      global: {
        sessions: [
          { startTime: new Date(now - 3600000).toISOString(), endTime: new Date(now - 1800000).toISOString(), duration: 1800000 },
        ]
      },
      projects: {}
    });
    const times = getGlobalTimes();
    expect(times.today).toBeGreaterThan(0);
    expect(times.week).toBeGreaterThanOrEqual(times.today);
    expect(times.month).toBeGreaterThanOrEqual(times.week);
  });

  test('week includes today', () => {
    // Use a fixed time at noon to avoid timezone edge cases near midnight
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    jest.setSystemTime(noon);
    const now = Date.now();
    dataState.set({
      version: 3,
      month: null,
      global: {
        sessions: [
          { startTime: new Date(now - 600000).toISOString(), endTime: new Date(now - 300000).toISOString(), duration: 300000 },
        ]
      },
      projects: {}
    });
    const times = getGlobalTimes();
    expect(times.week).toBeGreaterThanOrEqual(times.today);
  });

  test('includes active global session', () => {
    heartbeat('proj-1', 'terminal');
    jest.advanceTimersByTime(5000);
    const times = getGlobalTimes();
    expect(times.today).toBeGreaterThan(0);
  });
});

// ── getProjectSessions with real data ──

describe('getProjectSessions with data', () => {
  test('returns sessions for project with data', () => {
    const now = Date.now();
    dataState.set({
      version: 3,
      month: null,
      global: { sessions: [] },
      projects: {
        'proj-1': {
          sessions: [
            { startTime: new Date(now - 3600000).toISOString(), endTime: new Date(now).toISOString(), duration: 3600000 },
          ]
        }
      }
    });
    const sessions = getProjectSessions('proj-1');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].duration).toBe(3600000);
  });
});

// ── saveAndShutdown ──

describe('saveAndShutdown', () => {
  test('clears all active sessions', () => {
    heartbeat('proj-1', 'terminal');
    heartbeat('proj-2', 'chat');
    jest.advanceTimersByTime(5000);
    saveAndShutdown();
    expect(getActiveProjectCount()).toBe(0);
    const state = trackingState.get();
    expect(state.globalStartedAt).toBeNull();
  });
});
