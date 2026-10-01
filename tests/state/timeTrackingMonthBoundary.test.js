// timetracking.json only holds the current month: on the 1st it is archived and
// reset. The week total used to be computed from that file alone, so a week
// starting in the previous month dropped to the days of the new one, and the
// archive itself was a copy of the file on disk, missing whatever the midnight
// split had closed but not yet saved.
//
// Its own test file because each case needs a fresh module (initTimeTracking
// and the archived sessions it loads are module-level state).

const HOUR = 3600000;

// Thursday 1 October 2026, noon local. Its week started on Monday 28 September.
const NOW = new Date(2026, 9, 1, 12, 0, 0);

function session(start, hours) {
  return {
    id: `sess-${start.getTime()}`,
    startTime: start.toISOString(),
    endTime: new Date(start.getTime() + hours * HOUR).toISOString(),
    duration: hours * HOUR
  };
}

function loadModuleFresh(archive) {
  let mod;
  jest.isolateModules(() => {
    jest.doMock('../../src/renderer/services/ArchiveService', () => archive);
    mod = require('../../src/renderer/state/timeTracking.state');
  });
  return mod;
}

function archiveMock(overrides = {}) {
  return {
    migrateOldArchives: jest.fn().mockResolvedValue(undefined),
    archiveCurrentFile: jest.fn().mockResolvedValue(true),
    getArchivedGlobalSessions: jest.fn().mockResolvedValue([]),
    ...overrides
  };
}

let fsMock;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);

  fsMock = window.electron_nodeModules.fs;
  fsMock.promises.access = jest.fn().mockResolvedValue(undefined);
  fsMock.promises.writeFile = jest.fn().mockResolvedValue(undefined);
  fsMock.promises.copyFile = jest.fn().mockResolvedValue(undefined);
  fsMock.promises.rename = jest.fn().mockResolvedValue(undefined);
  fsMock.promises.unlink = jest.fn().mockResolvedValue(undefined);
  fsMock.promises.mkdir = jest.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

function seedFile(data) {
  fsMock.promises.readFile = jest.fn().mockResolvedValue(JSON.stringify({ version: 3, projects: {}, ...data }));
}

describe('the week across a month boundary', () => {
  test('counts the days of this week that were archived with the previous month', async () => {
    seedFile({ month: '2026-10', global: { sessions: [session(new Date(2026, 9, 1, 9), 1)] } });
    const archive = archiveMock({
      getArchivedGlobalSessions: jest.fn().mockResolvedValue([
        session(new Date(2026, 8, 28, 10), 2), // Monday of this week
        session(new Date(2026, 8, 27, 10), 4)  // Sunday, previous week
      ])
    });
    const mod = loadModuleFresh(archive);

    await mod.initTimeTracking({ get: () => ({ projects: [] }) });

    expect(archive.getArchivedGlobalSessions).toHaveBeenCalledWith(2026, 8);
    const times = mod.getGlobalTimes();
    expect(times.today).toBe(1 * HOUR);
    expect(times.week).toBe(3 * HOUR);
    expect(times.month).toBe(1 * HOUR);
    mod.saveAndShutdown();
  });

  test('an unreadable previous archive leaves the current month intact', async () => {
    seedFile({ month: '2026-10', global: { sessions: [session(new Date(2026, 9, 1, 9), 1)] } });
    const mod = loadModuleFresh(archiveMock({
      getArchivedGlobalSessions: jest.fn().mockRejectedValue(new Error('boom'))
    }));
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await mod.initTimeTracking({ get: () => ({ projects: [] }) });

    expect(mod.getGlobalTimes().week).toBe(1 * HOUR);
    console.warn.mockRestore();
    mod.saveAndShutdown();
  });
});

describe('archiving the past month', () => {
  test('archives the sessions held in memory, then starts the new month empty', async () => {
    const september = session(new Date(2026, 8, 30, 20), 2);
    seedFile({ month: '2026-09', global: { sessions: [september] } });
    const archive = archiveMock();
    const mod = loadModuleFresh(archive);

    await mod.initTimeTracking({ get: () => ({ projects: [] }) });

    expect(archive.archiveCurrentFile).toHaveBeenCalledWith('2026-09', expect.objectContaining({
      month: '2026-09',
      global: { sessions: [september] }
    }));
    expect(mod.dataState.get().month).toBe('2026-10');
    expect(mod.getGlobalTrackingData().sessions).toEqual([]);
    mod.saveAndShutdown();
  });

  test('keeps the month in place when the archive could not be written', async () => {
    const september = session(new Date(2026, 8, 30, 20), 2);
    seedFile({ month: '2026-09', global: { sessions: [september] } });
    const mod = loadModuleFresh(archiveMock({ archiveCurrentFile: jest.fn().mockResolvedValue(false) }));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await mod.initTimeTracking({ get: () => ({ projects: [] }) });

    expect(mod.dataState.get().month).toBe('2026-09');
    expect(mod.getGlobalTrackingData().sessions).toEqual([september]);
    console.error.mockRestore();
    mod.saveAndShutdown();
  });
});
