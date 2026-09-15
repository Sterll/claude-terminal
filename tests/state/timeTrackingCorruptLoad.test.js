// timetracking.json is the one store in the app whose contents exist nowhere
// else. A parse failure used to be logged and then ignored: dataState stayed at
// its empty default and the next heartbeat's debounced save wrote that over the
// file. The .bak is no help - saveImmediate creates it during the write and
// unlinks it the moment the write succeeds.
//
// Its own test file because loadFailed latches for the life of the module, so
// these cases need a module registry nothing else shares.

const path = require('path');

const TRACKING_FILE = path.join('/mock/home', '.claude-terminal', 'timetracking.json');

function loadModuleFresh() {
  let mod;
  jest.isolateModules(() => {
    jest.doMock('../../src/renderer/services/ArchiveService', () => ({
      migrateOldArchives: jest.fn().mockResolvedValue(undefined),
      appendToArchive: jest.fn(),
      isCurrentMonth: jest.fn(() => true),
      getMonthsInRange: jest.fn(() => []),
    }));
    mod = require('../../src/renderer/state/timeTracking.state');
  });
  return mod;
}

let fsMock;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();

  fsMock = window.electron_nodeModules.fs;
  fsMock.promises.access = jest.fn().mockResolvedValue(undefined); // file exists
  fsMock.promises.readFile = jest.fn().mockResolvedValue('{}');
  fsMock.promises.writeFile = jest.fn().mockResolvedValue(undefined);
  fsMock.promises.copyFile = jest.fn().mockResolvedValue(undefined);
  fsMock.promises.rename = jest.fn().mockResolvedValue(undefined);
  fsMock.promises.unlink = jest.fn().mockResolvedValue(undefined);
  fsMock.promises.mkdir = jest.fn().mockResolvedValue(undefined);

  window.electron_api.notification = { show: jest.fn() };

  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  console.error.mockRestore();
});

function writesToTrackingFile() {
  return fsMock.promises.writeFile.mock.calls.filter(([target]) =>
    String(target).includes('timetracking.json')
  );
}

describe('a corrupt timetracking.json', () => {
  test('blocks every later save instead of overwriting the file', async () => {
    fsMock.promises.readFile.mockResolvedValue('{not valid json!!!');
    const mod = loadModuleFresh();

    await mod.initTimeTracking({ get: () => ({ projects: [] }) });
    mod.heartbeat('project-1', 'test');
    await mod.saveAndShutdown();

    expect(writesToTrackingFile()).toHaveLength(0);
  });

  test('copies the unreadable file aside before anything can touch it', async () => {
    fsMock.promises.readFile.mockResolvedValue('{not valid json!!!');
    const mod = loadModuleFresh();

    await mod.initTimeTracking({ get: () => ({ projects: [] }) });

    const backups = fsMock.promises.copyFile.mock.calls.filter(([, dest]) =>
      /timetracking\.json\.corrupted\.\d+$/.test(String(dest))
    );
    expect(backups).toHaveLength(1);
    expect(String(backups[0][0])).toContain('timetracking.json');
  });

  test('tells the user rather than failing silently', async () => {
    fsMock.promises.readFile.mockResolvedValue('{not valid json!!!');
    const mod = loadModuleFresh();

    await mod.initTimeTracking({ get: () => ({ projects: [] }) });

    expect(window.electron_api.notification.show).toHaveBeenCalledTimes(1);
  });

  test('an empty file counts as corrupt, not as a fresh start', async () => {
    // saveImmediate only ever writes a complete document, so zero length means
    // a truncated write, never a legitimate state.
    fsMock.promises.readFile.mockResolvedValue('   ');
    const mod = loadModuleFresh();

    await mod.initTimeTracking({ get: () => ({ projects: [] }) });
    mod.heartbeat('project-1', 'test');
    await mod.saveAndShutdown();

    expect(writesToTrackingFile()).toHaveLength(0);
  });
});

describe('a readable timetracking.json', () => {
  test('still saves normally', async () => {
    fsMock.promises.readFile.mockResolvedValue(JSON.stringify({
      version: 3, month: null, global: { sessions: [] }, projects: {}
    }));
    const mod = loadModuleFresh();

    await mod.initTimeTracking({ get: () => ({ projects: [] }) });
    mod.heartbeat('project-1', 'test');
    await mod.saveAndShutdown();

    const wroteSomewhere = fsMock.promises.writeFile.mock.calls.some(([target]) =>
      String(target).includes('timetracking.json')
    );
    expect(wroteSomewhere).toBe(true);
    expect(window.electron_api.notification.show).not.toHaveBeenCalled();
  });

  test('a missing file is a legitimate fresh start', async () => {
    fsMock.promises.access = jest.fn().mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    );
    const mod = loadModuleFresh();

    await mod.initTimeTracking({ get: () => ({ projects: [] }) });
    mod.heartbeat('project-1', 'test');
    await mod.saveAndShutdown();

    expect(window.electron_api.notification.show).not.toHaveBeenCalled();
    expect(TRACKING_FILE).toContain('timetracking.json');
  });
});
