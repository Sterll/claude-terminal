// UpdaterService.quitAndInstall — the two arguments that decide whether an
// update is an update or a wizard the user has to fight.
//
// electron-updater's signature is quitAndInstall(isSilent = false,
// isForceRunAfter = false), and both defaults are wrong here:
//
//   * isSilent=false makes NsisUpdater omit /S, so the assisted installer shows
//     its wizard after the app has already quit. The install section runs
//     uninstallOldVersion (RMDir /r $INSTDIR, plus the shortcuts unless
//     --keep-shortcuts) before extracting, so closing that unexpected window
//     midway leaves no installed app and no shortcuts.
//   * installSection.nsh restarts the app on `${isForceRun} && ${Silent}`, so
//     without isSilent the app never comes back on its own either.

const mockQuitAndInstall = jest.fn();
const mockCheckForUpdates = jest.fn();
const mockSetQuitting = jest.fn();

jest.mock('electron-updater', () => ({
  autoUpdater: {
    quitAndInstall: mockQuitAndInstall,
    checkForUpdates: mockCheckForUpdates,
    on: jest.fn(),
    autoDownload: true,
    autoInstallOnAppQuit: false,
    forceDevUpdateConfig: false,
  },
}));

jest.mock('electron', () => ({
  app: { getVersion: () => '1.3.3', isPackaged: false },
  Notification: jest.fn(),
}));

jest.mock('../../src/main/windows/MainWindow', () => ({
  setQuitting: mockSetQuitting,
}), { virtual: true });

const updaterService = require('../../src/main/services/UpdaterService');

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckForUpdates.mockResolvedValue(null);
  updaterService.lastKnownVersion = null;
  updaterService.installAfterDownload = false;
});

describe('quitAndInstall', () => {
  test('installs silently and forces the app to run afterwards', async () => {
    await updaterService.quitAndInstall();

    expect(mockQuitAndInstall).toHaveBeenCalledTimes(1);
    expect(mockQuitAndInstall).toHaveBeenCalledWith(true, true);
  });

  test('still installs silently when the pre-install check throws', async () => {
    mockCheckForUpdates.mockRejectedValue(new Error('offline'));

    await updaterService.quitAndInstall();

    expect(mockQuitAndInstall).toHaveBeenCalledWith(true, true);
  });

  test('defers to a re-download when the server advertises a newer version', async () => {
    updaterService.lastKnownVersion = '1.3.3';
    mockCheckForUpdates.mockResolvedValue({ updateInfo: { version: '1.3.4' } });

    await updaterService.quitAndInstall();

    expect(mockQuitAndInstall).not.toHaveBeenCalled();
    expect(updaterService.installAfterDownload).toBe(true);
  });

  test('clears the quitting flag when the install throws', async () => {
    mockQuitAndInstall.mockImplementationOnce(() => { throw new Error('nope'); });

    await updaterService.quitAndInstall();

    expect(mockSetQuitting).toHaveBeenNthCalledWith(1, true);
    expect(mockSetQuitting).toHaveBeenNthCalledWith(2, false);
  });
});
