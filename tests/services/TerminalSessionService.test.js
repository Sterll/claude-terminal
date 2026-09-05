/**
 * Restoring terminal sessions must not bring a CLI failure back as a tab title.
 *
 * Before the naming guard, a lapsed login was persisted as the tab's own name,
 * so the tab came back called "Not logged in · Please run /login" on every
 * launch — the guard stops new ones, it cannot undo the ones already on disk.
 */

jest.mock('../../src/renderer/state/settings.state', () => ({
  getSetting: () => true, // restoreTerminalSessions
}));

const { loadSessionData } = require('../../src/renderer/services/TerminalSessionService');

const readFile = window.electron_nodeModules.fs.promises.readFile;

const onDisk = (projects) =>
  readFile.mockResolvedValue(JSON.stringify({ version: 1, projects }));

beforeEach(() => {
  readFile.mockReset();
});

describe('loadSessionData name healing', () => {
  test('clears a generated name that is really a CLI failure', async () => {
    onDisk({
      p1: {
        tabs: [
          { cwd: '/repo', mode: 'chat', name: 'Not logged in · Please run /login', nameCustom: false },
          { cwd: '/repo', mode: 'chat', name: 'Refonte left menu', nameCustom: false },
        ],
      },
    });

    const data = await loadSessionData();

    // Cleared, not deleted — restore falls back to the project name.
    expect(data.projects.p1.tabs[0].name).toBeNull();
    expect(data.projects.p1.tabs[1].name).toBe('Refonte left menu');
  });

  test('keeps a name the user typed, whatever it says', async () => {
    onDisk({
      p1: {
        tabs: [{ cwd: '/repo', name: 'Not logged in · Please run /login', nameCustom: true }],
      },
    });

    const data = await loadSessionData();

    expect(data.projects.p1.tabs[0].name).toBe('Not logged in · Please run /login');
  });

  test('heals every project and tolerates one with no tabs', async () => {
    onDisk({
      p1: { tabs: [{ name: 'API Error: 401 Invalid API key · Please run /login', nameCustom: false }] },
      p2: { tabs: [{ name: 'Credit balance is too low', nameCustom: false }] },
      p3: {},
    });

    const data = await loadSessionData();

    expect(data.projects.p1.tabs[0].name).toBeNull();
    expect(data.projects.p2.tabs[0].name).toBeNull();
    expect(data.projects.p3.tabs).toBeUndefined();
  });

  test('returns null when there is nothing saved', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

    expect(await loadSessionData()).toBeNull();
  });
});
