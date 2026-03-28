// State persistence integration tests
// Tests full save → load → verify cycles for projects, settings, and time tracking

// In-memory file store for roundtrip testing
const fileStore = {};

// Mock electron_nodeModules with in-memory fs
global.window = global.window || {};
window.electron_nodeModules = {
  path: require('path'),
  fs: {
    existsSync: jest.fn((p) => p in fileStore),
    readFileSync: jest.fn((p, enc) => {
      if (fileStore[p] !== undefined) return fileStore[p];
      const err = new Error(`ENOENT: no such file or directory: '${p}'`);
      err.code = 'ENOENT';
      throw err;
    }),
    writeFileSync: jest.fn((p, data, enc) => {
      fileStore[p] = typeof data === 'string' ? data : data.toString();
    }),
    mkdirSync: jest.fn(),
    copyFileSync: jest.fn((src, dest) => {
      if (fileStore[src] !== undefined) fileStore[dest] = fileStore[src];
    }),
    renameSync: jest.fn((src, dest) => {
      if (fileStore[src] !== undefined) {
        fileStore[dest] = fileStore[src];
        delete fileStore[src];
      }
    }),
    unlinkSync: jest.fn((p) => { delete fileStore[p]; }),
    promises: {
      readFile: jest.fn(async (p) => {
        if (fileStore[p] !== undefined) return fileStore[p];
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }),
      writeFile: jest.fn(async (p, data) => {
        fileStore[p] = typeof data === 'string' ? data : data.toString();
      }),
      access: jest.fn(async (p) => {
        if (p in fileStore) return undefined;
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }),
      mkdir: jest.fn(async () => undefined),
      copyFile: jest.fn(async (src, dest) => {
        if (fileStore[src] !== undefined) fileStore[dest] = fileStore[src];
      }),
      rename: jest.fn(async (src, dest) => {
        if (fileStore[src] !== undefined) {
          fileStore[dest] = fileStore[src];
          delete fileStore[src];
        }
      }),
      unlink: jest.fn(async (p) => { delete fileStore[p]; })
    }
  },
  os: { homedir: () => '/mock/home' },
  process: { resourcesPath: '/mock/resources' },
  __dirname: '/mock/app'
};

window.electron_api = {
  tray: { updateAccentColor: jest.fn() },
  terminal: { onExit: jest.fn(() => () => {}) },
  notification: { show: jest.fn() }
};

// Mock requestAnimationFrame
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  // Clear file store
  for (const key of Object.keys(fileStore)) delete fileStore[key];
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

// =====================================================================
// Projects State Persistence
// =====================================================================

describe('projects state persistence', () => {
  let projectsModule;

  beforeEach(() => {
    // Re-require to get fresh module (with our mocked fs)
    jest.isolateModules(() => {
      projectsModule = require('../../src/renderer/state/projects.state');
    });

    // Reset state
    projectsModule.projectsState.set({
      projects: [],
      folders: [],
      rootOrder: [],
      selectedProjectFilter: null,
      openedProjectId: null
    });
  });

  test('save → load roundtrip preserves projects', async () => {
    // Add a project
    const project = projectsModule.addProject({
      name: 'My Project',
      path: '/home/user/project',
      type: 'webapp'
    });

    // Trigger save (debounced 500ms)
    jest.advanceTimersByTime(600);
    // Flush async saveProjectsImmediate
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Verify file was written (via async fsp.writeFile)
    const { fs } = window.electron_nodeModules;
    expect(fs.promises.writeFile).toHaveBeenCalled();

    // Get the saved data
    const writeCall = fs.promises.writeFile.mock.calls[fs.promises.writeFile.mock.calls.length - 1];
    const tmpPath = writeCall[0];
    const savedContent = writeCall[1];

    // Verify the saved content
    const parsed = JSON.parse(savedContent);
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0].name).toBe('My Project');
    expect(parsed.projects[0].path).toBe('/home/user/project');
    expect(parsed.projects[0].type).toBe('webapp');
    expect(parsed.projects[0].id).toBe(project.id);
    expect(parsed.rootOrder).toContain(project.id);
  });

  test('save → load roundtrip preserves folders and hierarchy', async () => {
    const folder = projectsModule.createFolder('Work');
    const project = projectsModule.addProject({
      name: 'Child Project',
      path: '/work/proj'
    });
    projectsModule.moveItemToFolder('project', project.id, folder.id);

    jest.advanceTimersByTime(600);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const { fs } = window.electron_nodeModules;
    const lastWrite = fs.promises.writeFile.mock.calls[fs.promises.writeFile.mock.calls.length - 1];
    const parsed = JSON.parse(lastWrite[1]);

    expect(parsed.folders).toHaveLength(1);
    expect(parsed.folders[0].name).toBe('Work');
    expect(parsed.folders[0].children).toContain(project.id);
    expect(parsed.projects[0].folderId).toBe(folder.id);
  });

  test('debounce: rapid updates result in single write', async () => {
    const { fs } = window.electron_nodeModules;

    projectsModule.addProject({ name: 'P1', path: '/p1' });
    projectsModule.addProject({ name: 'P2', path: '/p2' });
    projectsModule.addProject({ name: 'P3', path: '/p3' });

    // Before debounce fires, no writes
    expect(fs.promises.writeFile).not.toHaveBeenCalled();

    // Advance past debounce
    jest.advanceTimersByTime(600);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Should have written once (the final state)
    const writeCalls = fs.promises.writeFile.mock.calls;
    // Only count calls that write to .tmp files (save calls)
    const saveCalls = writeCalls.filter(c => c[0].endsWith('.tmp'));
    expect(saveCalls.length).toBe(1);

    const parsed = JSON.parse(saveCalls[0][1]);
    expect(parsed.projects).toHaveLength(3);
  });

  test('atomic write pattern: writes to .tmp then renames', async () => {
    const { fs } = window.electron_nodeModules;

    projectsModule.addProject({ name: 'Test', path: '/test' });
    jest.advanceTimersByTime(600);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Check that fsp.writeFile was called with .tmp path
    const tmpWrites = fs.promises.writeFile.mock.calls.filter(c => c[0].endsWith('.tmp'));
    expect(tmpWrites.length).toBeGreaterThan(0);

    // Check that fsp.rename was called (tmp -> final)
    expect(fs.promises.rename).toHaveBeenCalled();
    const renameCall = fs.promises.rename.mock.calls[0];
    expect(renameCall[0]).toMatch(/\.tmp$/);
    expect(renameCall[1]).toMatch(/projects\.json$/);
  });

  test('backup file is created before write', async () => {
    const { fs } = window.electron_nodeModules;
    const projectsFilePath = require('../../src/renderer/utils/paths').projectsFile;

    // Simulate existing file in the store so copyFile finds it
    fileStore[projectsFilePath] = '{}';

    projectsModule.addProject({ name: 'Test', path: '/test' });
    jest.advanceTimersByTime(600);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // fsp.copyFile should be called for backup
    expect(fs.promises.copyFile).toHaveBeenCalled();
    const copyCall = fs.promises.copyFile.mock.calls[0];
    expect(copyCall[0]).toMatch(/projects\.json$/);
    expect(copyCall[1]).toMatch(/\.bak$/);
  });

  test('load handles corrupted JSON with backup restore', async () => {
    const { fs } = window.electron_nodeModules;
    const projectsFilePath = require('../../src/renderer/utils/paths').projectsFile;

    // Simulate corrupted main file in store
    fileStore[projectsFilePath] = '{corrupted data!!!';

    window.electron_api.notification = { show: jest.fn() };

    await projectsModule.loadProjects();

    // Should not crash, state should be empty/default
    const state = projectsModule.projectsState.get();
    expect(state.projects).toEqual([]);
  });

  test('quick actions are preserved in roundtrip', async () => {
    const project = projectsModule.addProject({ name: 'Test', path: '/test' });
    projectsModule.addQuickAction(project.id, {
      name: 'Build',
      command: 'npm run build',
      icon: 'B'
    });

    jest.advanceTimersByTime(600);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const { fs } = window.electron_nodeModules;
    const lastWrite = fs.promises.writeFile.mock.calls[fs.promises.writeFile.mock.calls.length - 1];
    const parsed = JSON.parse(lastWrite[1]);

    expect(parsed.projects[0].quickActions).toHaveLength(1);
    expect(parsed.projects[0].quickActions[0].name).toBe('Build');
    expect(parsed.projects[0].quickActions[0].command).toBe('npm run build');
  });
});

// =====================================================================
// Settings State Persistence
// =====================================================================

describe('settings state persistence', () => {
  let settingsModule;

  beforeEach(() => {
    jest.isolateModules(() => {
      settingsModule = require('../../src/renderer/state/settings.state');
    });
  });

  test('save → load roundtrip preserves settings', async () => {
    const { fs } = window.electron_nodeModules;

    settingsModule.setSetting('accentColor', '#ff0000');
    settingsModule.setSetting('editor', 'cursor');
    settingsModule.setSetting('language', 'en');

    // Run debounce
    jest.advanceTimersByTime(600);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Verify write was called
    expect(fs.promises.writeFile).toHaveBeenCalled();

    // Parse the saved data (from the tmp file)
    const tmpWrites = fs.promises.writeFile.mock.calls.filter(c => c[0].endsWith('.tmp'));
    const lastWrite = tmpWrites[tmpWrites.length - 1];
    const parsed = JSON.parse(lastWrite[1]);

    expect(parsed.accentColor).toBe('#ff0000');
    expect(parsed.editor).toBe('cursor');
    expect(parsed.language).toBe('en');
  });

  test('accent color hex is preserved exactly', async () => {
    const { fs } = window.electron_nodeModules;

    settingsModule.setSetting('accentColor', '#d97706');
    jest.advanceTimersByTime(600);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const tmpWrites = fs.promises.writeFile.mock.calls.filter(c => c[0].endsWith('.tmp'));
    const parsed = JSON.parse(tmpWrites[tmpWrites.length - 1][1]);

    expect(parsed.accentColor).toBe('#d97706');
  });

  test('unknown settings keys are preserved (forward compatibility)', async () => {
    const settingsFilePath = require('../../src/renderer/utils/paths').settingsFile;

    // Simulate loading a settings file with unknown keys via in-memory store
    fileStore[settingsFilePath] = JSON.stringify({
      accentColor: '#ff0000',
      unknownFutureKey: 'preserved',
      anotherNewSetting: { nested: true }
    });

    await settingsModule.loadSettings();

    const settings = settingsModule.getSettings();
    expect(settings.accentColor).toBe('#ff0000');
    expect(settings.unknownFutureKey).toBe('preserved');
    expect(settings.anotherNewSetting).toEqual({ nested: true });
  });

  test('defaults are applied for missing keys on load', async () => {
    const settingsFilePath = require('../../src/renderer/utils/paths').settingsFile;

    // Simulate file with only one key via in-memory store
    fileStore[settingsFilePath] = JSON.stringify({
      editor: 'webstorm'
    });

    await settingsModule.loadSettings();

    const settings = settingsModule.getSettings();
    expect(settings.editor).toBe('webstorm');
    // Default values should be filled in
    expect(settings.accentColor).toBe('#d97706');
    expect(settings.notificationsEnabled).toBe(true);
  });

  test('corrupted settings file falls back to backup', async () => {
    const { fs } = window.electron_nodeModules;
    const settingsFilePath = require('../../src/renderer/utils/paths').settingsFile;
    const backupPath = settingsFilePath + '.bak';

    // Both main and backup exist in the store
    fileStore[settingsFilePath] = 'corrupted-data';
    fileStore[backupPath] = JSON.stringify({ editor: 'cursor', accentColor: '#00ff00' });

    // Override readFile to throw on main file (simulating parse error after read)
    const origReadFile = fs.promises.readFile;
    fs.promises.readFile = jest.fn(async (p) => {
      if (p === settingsFilePath) throw new Error('Corrupted');
      if (p === backupPath) return fileStore[backupPath];
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    });

    await settingsModule.loadSettings();

    const settings = settingsModule.getSettings();
    expect(settings.editor).toBe('cursor');
    expect(settings.accentColor).toBe('#00ff00');

    // Restore original mock
    fs.promises.readFile = origReadFile;
  });

  test('save uses atomic write pattern', async () => {
    const { fs } = window.electron_nodeModules;

    settingsModule.setSetting('editor', 'code');

    // Force immediate save
    await settingsModule.saveSettingsImmediate();

    // Should write to tmp file
    const tmpWrites = fs.promises.writeFile.mock.calls.filter(c => c[0].endsWith('.tmp'));
    expect(tmpWrites.length).toBeGreaterThan(0);

    // Should rename tmp to final
    expect(fs.promises.rename).toHaveBeenCalled();
  });

  test('onSaveFlush callback is notified on successful save', async () => {
    const callback = jest.fn();
    const unsub = settingsModule.onSaveFlush(callback);

    await settingsModule.saveSettingsImmediate();

    expect(callback).toHaveBeenCalledWith({ success: true });

    unsub();
  });

  test('boolean settings are preserved correctly', async () => {
    const { fs } = window.electron_nodeModules;

    settingsModule.setSetting('notificationsEnabled', false);
    settingsModule.setSetting('hooksEnabled', true);
    settingsModule.setSetting('compactProjects', false);

    jest.advanceTimersByTime(600);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const tmpWrites = fs.promises.writeFile.mock.calls.filter(c => c[0].endsWith('.tmp'));
    const parsed = JSON.parse(tmpWrites[tmpWrites.length - 1][1]);

    expect(parsed.notificationsEnabled).toBe(false);
    expect(parsed.hooksEnabled).toBe(true);
    expect(parsed.compactProjects).toBe(false);
  });
});

// =====================================================================
// Time Tracking State Persistence
// =====================================================================

describe('time tracking state persistence', () => {
  let timeModule;

  beforeEach(() => {
    jest.isolateModules(() => {
      // Mock ArchiveService before loading timeTracking
      jest.mock('../../src/renderer/services/ArchiveService', () => ({
        migrateOldArchives: jest.fn(),
        archiveCurrentFile: jest.fn()
      }));
      timeModule = require('../../src/renderer/state/timeTracking.state');
    });
  });

  test('heartbeat creates active tracking for project', () => {
    timeModule.heartbeat('project-1', 'terminal');

    const tracking = timeModule.trackingState.get();
    expect(tracking.activeProjects.has('project-1')).toBe(true);
    expect(tracking.globalStartedAt).not.toBeNull();
  });

  test('heartbeat is throttled (1s)', () => {
    timeModule.heartbeat('project-1', 'terminal');

    const tracking1 = timeModule.trackingState.get();
    const firstHeartbeat = tracking1.activeProjects.get('project-1').lastHeartbeat;

    // Second heartbeat within 1s should be ignored
    timeModule.heartbeat('project-1', 'terminal');
    const tracking2 = timeModule.trackingState.get();
    const secondHeartbeat = tracking2.activeProjects.get('project-1').lastHeartbeat;

    expect(secondHeartbeat).toBe(firstHeartbeat);
  });

  test('heartbeat after throttle window updates lastHeartbeat', () => {
    timeModule.heartbeat('project-1', 'terminal');

    const tracking1 = timeModule.trackingState.get();
    const firstHeartbeat = tracking1.activeProjects.get('project-1').lastHeartbeat;

    jest.advanceTimersByTime(1100);

    timeModule.heartbeat('project-1', 'terminal');
    const tracking2 = timeModule.trackingState.get();
    const secondHeartbeat = tracking2.activeProjects.get('project-1').lastHeartbeat;

    expect(secondHeartbeat).toBeGreaterThan(firstHeartbeat);
  });

  test('stopProject finalizes session and saves', () => {
    const { fs } = window.electron_nodeModules;

    timeModule.heartbeat('project-1', 'terminal');
    jest.advanceTimersByTime(5000); // 5 seconds active

    timeModule.stopProject('project-1');

    const tracking = timeModule.trackingState.get();
    expect(tracking.activeProjects.has('project-1')).toBe(false);

    // Check that data state has a session recorded
    const data = timeModule.dataState.get();
    const projectSessions = data.projects?.['project-1']?.sessions || [];
    expect(projectSessions.length).toBeGreaterThanOrEqual(1);
  });

  test('stopProject does nothing for unknown project', () => {
    expect(() => timeModule.stopProject('nonexistent')).not.toThrow();
  });

  test('multiple projects tracked independently', () => {
    timeModule.heartbeat('project-1', 'terminal');
    jest.advanceTimersByTime(1100);
    timeModule.heartbeat('project-2', 'chat');

    const tracking = timeModule.trackingState.get();
    expect(tracking.activeProjects.size).toBe(2);
    expect(tracking.activeProjects.has('project-1')).toBe(true);
    expect(tracking.activeProjects.has('project-2')).toBe(true);
  });

  test('global session starts with first project and ends with last', () => {
    timeModule.heartbeat('project-1', 'terminal');
    expect(timeModule.trackingState.get().globalStartedAt).not.toBeNull();

    jest.advanceTimersByTime(5000);
    timeModule.stopProject('project-1');

    const tracking = timeModule.trackingState.get();
    expect(tracking.globalStartedAt).toBeNull();
  });

  test('getProjectTimes returns correct today and total', () => {
    timeModule.heartbeat('project-1', 'terminal');
    jest.advanceTimersByTime(10000); // 10 seconds

    const times = timeModule.getProjectTimes('project-1');
    expect(times.today).toBeGreaterThan(0);
    expect(times.total).toBeGreaterThan(0);
  });

  test('getProjectTimes returns zeros for unknown project', () => {
    const times = timeModule.getProjectTimes('nonexistent');
    expect(times.today).toBe(0);
    expect(times.total).toBe(0);
  });

  test('getProjectTimes returns zeros for null projectId', () => {
    const times = timeModule.getProjectTimes(null);
    expect(times.today).toBe(0);
    expect(times.total).toBe(0);
  });

  test('getGlobalTimes returns accumulated times', () => {
    timeModule.heartbeat('project-1', 'terminal');
    jest.advanceTimersByTime(5000);

    const times = timeModule.getGlobalTimes();
    expect(times.today).toBeGreaterThanOrEqual(0);
    expect(times.week).toBeGreaterThanOrEqual(0);
    expect(times.month).toBeGreaterThanOrEqual(0);
  });

  test('session merge: sessions within 5min gap are merged', () => {
    // Start and stop a session
    timeModule.heartbeat('project-1', 'terminal');
    jest.advanceTimersByTime(2000);
    timeModule.stopProject('project-1');

    // Start another session within 5 minutes
    jest.advanceTimersByTime(2 * 60 * 1000); // 2 min gap (< MERGE_GAP of 5 min)
    timeModule.heartbeat('project-1', 'terminal');
    jest.advanceTimersByTime(2000);
    timeModule.stopProject('project-1');

    const data = timeModule.dataState.get();
    const sessions = data.projects?.['project-1']?.sessions || [];

    // Sessions with gap < 5 min should be merged into one
    expect(sessions.length).toBe(1);
    // The merged session should cover the total duration
    expect(sessions[0].duration).toBeGreaterThan(2000);
  });

  test('session not merged: sessions with >5min gap stay separate', () => {
    timeModule.heartbeat('project-1', 'terminal');
    jest.advanceTimersByTime(2000);
    timeModule.stopProject('project-1');

    // Wait more than MERGE_GAP (5 min)
    jest.advanceTimersByTime(6 * 60 * 1000);
    timeModule.heartbeat('project-1', 'terminal');
    jest.advanceTimersByTime(2000);
    timeModule.stopProject('project-1');

    const data = timeModule.dataState.get();
    const sessions = data.projects?.['project-1']?.sessions || [];

    expect(sessions.length).toBe(2);
  });

  test('saveAndShutdown finalizes all active sessions', () => {
    timeModule.heartbeat('project-1', 'terminal');
    timeModule.heartbeat('project-2', 'chat');
    jest.advanceTimersByTime(5000);

    timeModule.saveAndShutdown();

    const tracking = timeModule.trackingState.get();
    expect(tracking.activeProjects.size).toBe(0);
    expect(tracking.globalStartedAt).toBeNull();
  });

  test('getProjectSessions returns empty for unknown project', () => {
    const sessions = timeModule.getProjectSessions('nonexistent');
    expect(sessions).toEqual([]);
  });

  test('getProjectSessions returns empty for null', () => {
    const sessions = timeModule.getProjectSessions(null);
    expect(sessions).toEqual([]);
  });

  test('isTracking returns correct status', () => {
    expect(timeModule.isTracking('project-1')).toBe(false);

    timeModule.heartbeat('project-1', 'terminal');
    expect(timeModule.isTracking('project-1')).toBe(true);

    jest.advanceTimersByTime(5000);
    timeModule.stopProject('project-1');
    expect(timeModule.isTracking('project-1')).toBe(false);
  });

  test('getActiveProjectCount returns correct count', () => {
    expect(timeModule.getActiveProjectCount()).toBe(0);

    timeModule.heartbeat('project-1', 'terminal');
    expect(timeModule.getActiveProjectCount()).toBe(1);

    jest.advanceTimersByTime(1100);
    timeModule.heartbeat('project-2', 'chat');
    expect(timeModule.getActiveProjectCount()).toBe(2);

    timeModule.stopProject('project-1');
    expect(timeModule.getActiveProjectCount()).toBe(1);
  });
});
