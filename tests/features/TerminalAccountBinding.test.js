/**
 * A project pinned to a Claude account has to spawn its terminals as that
 * account, not only its chat tabs.
 *
 * The main process resolves `accountId` into the credential-store overlay the
 * CLI is launched with. TerminalManager had four `terminal.create` calls of its
 * own — new tab, session resume, quick-action prompt, chat -> terminal switch —
 * and none of them sent the binding, so every `claude` started from a terminal
 * tab ran on the machine-wide login whatever the project was pinned to.
 */

jest.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));

const TM_PATH = '../../src/renderer/ui/components/TerminalManager';

let TerminalManager;
let projectsState, setProjectAccount;
let terminalsState;
let create;

beforeAll(() => {
  create = jest.fn(async () => ({ success: true, id: 42 }));
  window.electron_api = {
    ...window.electron_api,
    terminal: {
      create,
      input: jest.fn(),
      resize: jest.fn(),
      kill: jest.fn(),
      onData: jest.fn(() => () => {}),
      onExit: jest.fn(() => () => {}),
    },
  };

  ({ TerminalManager } = require(TM_PATH));
  ({ projectsState, setProjectAccount } = require('../../src/renderer/state/projects.state'));
  ({ terminalsState } = require('../../src/renderer/state/terminals.state'));
});

const project = { id: 'p1', name: 'Proj', path: '/p', type: 'general' };
let tm;

beforeEach(() => {
  create.mockClear();
  projectsState.set({ projects: [{ ...project }], folders: [], rootOrder: ['p1'] });
  terminalsState.set({ ...terminalsState.get(), terminals: new Map(), activeTerminal: null });
  document.body.innerHTML = `
    <div id="terminals-tabs"></div>
    <div id="terminals-container"></div>
    <div id="empty-terminals"></div>
    <div id="terminals-filter"></div>`;
  tm = new TerminalManager();
  tm.filterByProject = jest.fn();
  tm.setCallbacks({ onRenderProjects: jest.fn() });
});

async function spawn(options) {
  // Only the IPC call is under test; whatever follows (xterm mount, tab paint)
  // is allowed to fail in jsdom.
  try { await tm.createTerminal(project, options); } catch (e) { /* ignore */ }
  expect(create).toHaveBeenCalledTimes(1);
  return create.mock.calls[0][0];
}

describe('createTerminal sends the project account binding', () => {
  test('a pinned project spawns as its account', async () => {
    setProjectAccount('p1', 'acc-1');

    const params = await spawn({ mode: 'terminal', runClaude: true });

    expect(params.accountId).toBe('acc-1');
  });

  test('an unbound project sends null so the machine-wide login is used', async () => {
    const params = await spawn({ mode: 'terminal', runClaude: true });

    expect(params.accountId).toBeNull();
  });

  test('a resumed session carries the binding too', async () => {
    setProjectAccount('p1', 'acc-1');

    const params = await spawn({ mode: 'terminal', runClaude: true, resumeSessionId: 'sess-1' });

    expect(params).toMatchObject({ accountId: 'acc-1', resumeSessionId: 'sess-1' });
  });
});
