/**
 * What happens to a terminal when the emulator will not load.
 *
 * xterm used to be a top-level require(), so by the time `createTerminal()` ran
 * it was either there or the whole bundle had failed. It is now a chunk fetched
 * on demand, and that fetch is started before the PTY spawn and awaited after
 * it — which introduces a window where main has a live `claude` process and the
 * renderer has nothing to draw it with.
 *
 * The rule is that the PTY goes with the window: a failed load must kill it
 * rather than leave a process nobody can see or close. That is what this pins.
 *
 * The failure itself is free here: dynamic import() is unavailable under Jest
 * without --experimental-vm-modules, so `loadXterm()` rejects on its own and
 * nothing has to be stubbed to produce the case.
 */

const TM_PATH = '../../src/renderer/ui/components/TerminalManager';

let TerminalManager;
let terminalsState, getTerminal;
let killed;

beforeAll(() => {
  window.electron_api = {
    ...window.electron_api,
    terminal: {
      create: jest.fn(async () => ({ success: true, id: 77 })),
      input: jest.fn(),
      resize: jest.fn(),
      kill: jest.fn(({ id }) => killed.push(id)),
      onData: jest.fn(() => () => {}),
      onExit: jest.fn(() => () => {}),
    },
  };

  ({ TerminalManager } = require(TM_PATH));
  ({ terminalsState, getTerminal } = require('../../src/renderer/state/terminals.state'));
});

let tm;

beforeEach(() => {
  killed = [];
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

const project = { id: 'p1', name: 'Proj', path: '/p' };

describe('createTerminal when the emulator chunk fails', () => {
  it('returns null instead of a half-built tab', async () => {
    await expect(tm.createTerminal(project, { runClaude: false })).resolves.toBeNull();
  });

  it('kills the PTY it had already spawned', async () => {
    await tm.createTerminal(project, { runClaude: false });

    // The regression this guards: main keeps the process, the renderer forgets
    // it, and nothing can reach it again short of a restart.
    expect(killed).toEqual([77]);
  });

  it('leaves no tab, no wrapper and no terminal state behind', async () => {
    await tm.createTerminal(project, { runClaude: false });

    expect(document.querySelectorAll('#terminals-tabs .terminal-tab')).toHaveLength(0);
    expect(document.querySelectorAll('#terminals-container .terminal-wrapper')).toHaveLength(0);
    expect(getTerminal(77)).toBeUndefined();
  });

  it('does not reject — the click handler that called it must survive', async () => {
    await expect(tm.createTerminal(project, { runClaude: false })).resolves.toBeDefined();
  });
});

describe('_awaitXterm', () => {
  it('passes the module through when the load succeeds', async () => {
    const xterm = { Terminal: function () {}, FitAddon: function () {} };

    await expect(tm._awaitXterm(Promise.resolve(xterm), 5)).resolves.toBe(xterm);
    expect(killed).toEqual([]);
  });

  it('leaves the PTY alone when there is none to kill', async () => {
    await expect(tm._awaitXterm(Promise.reject(new Error('no chunk')), null)).resolves.toBeNull();
    expect(killed).toEqual([]);
  });

  it('survives a kill that itself throws', async () => {
    window.electron_api.terminal.kill.mockImplementationOnce(() => { throw new Error('gone'); });

    await expect(tm._awaitXterm(Promise.reject(new Error('no chunk')), 9)).resolves.toBeNull();
  });
});
