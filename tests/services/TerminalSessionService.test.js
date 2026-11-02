/**
 * Restoring terminal sessions must not bring a CLI failure back as a tab title.
 *
 * Before the naming guard, a lapsed login was persisted as the tab's own name,
 * so the tab came back called "Not logged in · Please run /login" on every
 * launch — the guard stops new ones, it cannot undo the ones already on disk.
 *
 * Nor may it resume a tab on ChatService's handle, which names no transcript.
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

describe('loadSessionData drops ChatService handles', () => {
  // A handle names no transcript: resuming it fails with "no conversation
  // found" on every restart, and the tab opens empty until the user closes it.
  test('a tab saved under a handle restores as a new conversation, keeping its name', async () => {
    onDisk({
      p1: {
        tabs: [
          { cwd: '/repo', mode: 'chat', claudeSessionId: 'chat-1793613128112-bylaf5', name: 'Design Ripple', nameCustom: true },
          { cwd: '/repo', mode: 'chat', claudeSessionId: '1612b7f8-fc55-4c2e-9a51-3f0e2d1c7b44', name: 'Sandbox startup' },
          { cwd: '/repo', mode: 'chat', claudeSessionId: null },
        ],
      },
    });

    const [handle, cli, none] = (await loadSessionData()).projects.p1.tabs;

    expect(handle.claudeSessionId).toBeNull();
    expect(handle.name).toBe('Design Ripple');
    expect(handle.nameCustom).toBe(true);
    expect(cli.claudeSessionId).toBe('1612b7f8-fc55-4c2e-9a51-3f0e2d1c7b44');
    expect(none.claudeSessionId).toBeNull();
  });
});

describe('isChatServiceHandle', () => {
  const { isChatServiceHandle } = require('../../src/renderer/services/TerminalSessionService');

  test('tells ChatService handles from CLI ids', () => {
    expect(isChatServiceHandle('chat-1793613128112-bylaf5')).toBe(true);
    expect(isChatServiceHandle('1612b7f8-fc55-4c2e-9a51-3f0e2d1c7b44')).toBe(false);
    expect(isChatServiceHandle(null)).toBe(false);
    expect(isChatServiceHandle(undefined)).toBe(false);
  });
});
