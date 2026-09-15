/**
 * Every terminal PTY has to say which project it belongs to.
 *
 * `TerminalService.create` tags the PTY with `{ projectId, projectPath }`, and
 * two consumers read that tag: `TerminalOutputCapture.record()`, which drops
 * the output outright when `projectId` is falsy, and the `terminal_exit_code`
 * trigger, whose `triggerWatchesProject()` never matches a project-scoped
 * workflow against a null id.
 *
 * Only the chat -> terminal switch sent the pair. The other three
 * `terminal.create` calls — new tab, session resume, quick action with prompt —
 * did not, so a terminal opened any other way wrote no capture log and fired no
 * project-scoped trigger.
 *
 * The account binding is asserted alongside it at each site: it reached the
 * same four calls and only the first of them had a test.
 */

jest.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));

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

  ({ TerminalManager } = require('../../src/renderer/ui/components/TerminalManager'));
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

/**
 * Drive one spawn path and hand back the IPC payload. Only that payload is
 * under test; whatever follows it (xterm mount, tab paint) is allowed to fail
 * in jsdom, and does — the emulator is loaded through a dynamic import jsdom
 * cannot serve.
 */
async function payloadOf(run) {
  try { await run(); } catch (e) { /* ignore */ }
  expect(create).toHaveBeenCalledTimes(1);
  return create.mock.calls[0][0];
}

const SITES = [
  ['a new terminal tab', () => tm.createTerminal(project, { mode: 'terminal', runClaude: true })],
  ['a resumed session', () => tm.resumeSession(project, 'sess-1', {})],
  ['a quick action with a prompt', () => tm._createTerminalWithPrompt(project, 'hello')],
];

describe.each(SITES)('%s', (_label, run) => {
  test('is attributed to its project', async () => {
    const params = await payloadOf(run);

    expect(params).toMatchObject({ projectId: 'p1', projectPath: '/p' });
  });

  test('carries the project account binding', async () => {
    setProjectAccount('p1', 'acc-1');

    const params = await payloadOf(run);

    expect(params.accountId).toBe('acc-1');
  });

  test('sends a null binding when the project is unbound', async () => {
    const params = await payloadOf(run);

    expect(params.accountId).toBeNull();
  });
});

describe('resumeSession in a worktree', () => {
  test('runs in the worktree but stays attributed to the parent project', async () => {
    const params = await payloadOf(() => tm.resumeSession(project, 'sess-1', { cwd: '/p/.worktrees/wt' }));

    // The capture log is keyed by project id and a trigger is scoped to it, so
    // the parent's id is what both consumers need — not a path-derived one.
    expect(params).toMatchObject({ cwd: '/p/.worktrees/wt', projectId: 'p1', projectPath: '/p' });
  });
});
