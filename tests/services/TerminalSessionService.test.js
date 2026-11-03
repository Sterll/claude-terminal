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

describe('saving a split layout', () => {
  const service = require('../../src/renderer/services/TerminalSessionService');
  const { terminalsState } = require('../../src/renderer/state/terminals.state');
  const writeFile = window.electron_nodeModules.fs.promises.writeFile;

  const project = { id: 'p1', name: 'P', path: '/repo' };
  const savedFile = () => JSON.parse(writeFile.mock.calls[writeFile.mock.calls.length - 1][1]);

  beforeEach(() => {
    writeFile.mockReset();
    readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  });

  afterEach(() => service.setSplitLayoutProvider(null));

  test('indices are computed from the tab ids at save time, so an earlier close cannot shift them', async () => {
    const terminals = new Map([
      [10, { project, mode: 'terminal' }],
      ['chat-a', { project, mode: 'chat' }],
      ['file-1', { project, type: 'file' }], // never saved
      [40, { project, mode: 'terminal' }],
    ]);
    terminalsState.set({ terminals, activeTerminal: 40 });
    service.setSplitLayoutProvider((pid, indexOf) => ({ chat: indexOf('chat-a'), last: indexOf(40), file: indexOf('file-1') }));

    await service.saveTerminalSessionsImmediate();
    expect(savedFile().projects.p1.split).toEqual({ chat: 1, last: 2, file: -1 });

    terminals.delete(10);
    terminalsState.set({ terminals, activeTerminal: 40 });
    await service.saveTerminalSessionsImmediate();
    expect(savedFile().projects.p1.split).toEqual({ chat: 0, last: 1, file: -1 });
    expect(savedFile().projects.p1.tabs).toHaveLength(2);
  });

  test('no layout, no split entry', async () => {
    terminalsState.set({ terminals: new Map([[1, { project, mode: 'terminal' }]]), activeTerminal: 1 });
    service.setSplitLayoutProvider(() => null);
    await service.saveTerminalSessionsImmediate();
    expect(savedFile().projects.p1).not.toHaveProperty('split');
  });

  test('a remote project not opened yet keeps the layout it was saved with', async () => {
    terminalsState.set({ terminals: new Map(), activeTerminal: null });
    const split = { root: { dir: 'row', ratio: 0.5, a: { tab: 0 }, b: { tab: 1 } }, focused: 1 };
    service.stashRemoteTabs('remote-1', { tabs: [{ cwd: 'ssh-remote://h/a' }, { cwd: 'ssh-remote://h/a' }], activeCwd: null, split });
    await service.saveTerminalSessionsImmediate();
    expect(savedFile().projects['remote-1'].split).toEqual(split);
    expect(service.takeRemoteTabs('remote-1').split).toEqual(split);
  });
});
