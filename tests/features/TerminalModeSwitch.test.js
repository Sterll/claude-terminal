/**
 * Tab id vs PTY id after a chat <-> terminal mode switch.
 *
 * A tab opened as a terminal is keyed in `terminalsState` by its PTY id, so the
 * two are the same value and most of TerminalManager treats them as one. A tab
 * that reached terminal mode by switching out of chat keeps its `chat-…` key and
 * records the PTY separately in `termData.ptyId`.
 *
 * Everything that addresses the PTY has to translate. Before this, several
 * places sent the tab id straight to the main process, where it matched no
 * terminal at all: closing a switched tab left `claude` running, and the output
 * handler recorded activity under an id nothing reads.
 */

const path = require('path');

// xterm's WebGL addon probes navigator/UA at require time and the type-console
// registry pulls in the whole project-type tree; neither is exercised here.
jest.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));

const TM_PATH = '../../src/renderer/ui/components/TerminalManager';

let TerminalManager;
let terminalsState, addTerminal, getTerminal;
let killed;

beforeAll(() => {
  window.electron_api = {
    ...window.electron_api,
    terminal: {
      create: jest.fn(async () => ({ success: true, id: 42 })),
      input: jest.fn(),
      resize: jest.fn(),
      kill: jest.fn(({ id }) => killed.push(id)),
      onData: jest.fn(() => () => {}),
      onExit: jest.fn(() => () => {}),
    },
  };

  ({ TerminalManager } = require(TM_PATH));
  ({ terminalsState, addTerminal, getTerminal } = require('../../src/renderer/state/terminals.state'));
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
  // filterByProject and the project-list repaint reach far outside this unit.
  tm.filterByProject = jest.fn();
  tm.setCallbacks({ onRenderProjects: jest.fn() });
});

/**
 * A tab in terminal mode. `ptyId` is what a mode switch records; omitting it
 * models a tab that was opened as a terminal, where the key is the PTY id.
 */
function addTerminalTab(id, { ptyId } = {}) {
  document.getElementById('terminals-tabs').innerHTML +=
    `<div class="terminal-tab" data-id="${id}"></div>`;
  document.getElementById('terminals-container').innerHTML +=
    `<div class="terminal-wrapper" data-id="${id}"></div>`;
  addTerminal(id, {
    terminal: { dispose: jest.fn(), blur: jest.fn(), focus: jest.fn() },
    fitAddon: { fit: jest.fn() },
    project: { id: 'p1', name: 'Proj', path: '/p' },
    projectIndex: 0,
    name: 'tab',
    status: 'ready',
    mode: 'terminal',
    isBasic: false,
    tabId: `t-${id}`,
    ...(ptyId !== undefined ? { ptyId } : {}),
  });
}

describe('closeTerminal kills the right PTY', () => {
  test('a tab opened as a terminal is killed by its own id', () => {
    addTerminalTab(7);

    tm.closeTerminal(7);

    expect(killed).toEqual([7]);
  });

  test('a tab that switched out of chat is killed by its ptyId, not its tab id', () => {
    addTerminalTab('chat-abc', { ptyId: 42 });

    tm.closeTerminal('chat-abc');

    // The regression: `kill({ id: 'chat-abc' })` matched nothing in
    // TerminalService, so the `claude` process outlived the tab.
    expect(killed).toEqual([42]);
  });

  test('the tab and its wrapper go either way', () => {
    addTerminalTab('chat-abc', { ptyId: 42 });

    tm.closeTerminal('chat-abc');

    expect(document.querySelector('.terminal-tab[data-id="chat-abc"]')).toBeNull();
    expect(document.querySelector('.terminal-wrapper[data-id="chat-abc"]')).toBeNull();
    expect(getTerminal('chat-abc')).toBeUndefined();
  });
});

describe('_ptyTarget', () => {
  test('is the identity for a tab that never switched', () => {
    addTerminalTab(7);
    expect(tm._ptyTarget(7)).toBe(7);
  });

  test('resolves a switched tab to its PTY', () => {
    addTerminalTab('chat-abc', { ptyId: 42 });
    expect(tm._ptyTarget('chat-abc')).toBe(42);
  });

  test('falls back to the id it was given for an unknown tab', () => {
    expect(tm._ptyTarget('gone')).toBe('gone');
  });
});

describe('_registerTerminalHandler', () => {
  test('keys the handler by PTY but records activity under the tab', () => {
    addTerminalTab('chat-abc', { ptyId: 42 });
    const onData = jest.fn();

    tm._registerTerminalHandler(42, onData, jest.fn(), 'chat-abc');
    // The main process reports output under the PTY id.
    tm._terminalDataHandlers.get(42)({ id: 42, data: 'hello' });

    expect(onData).toHaveBeenCalled();
    // Read back under the tab id — `_finalizeReady` looks it up that way, and
    // registering under the PTY id alone left it permanently unset.
    expect(tm._lastTerminalData.has('chat-abc')).toBe(true);
    expect(getTerminal('chat-abc').outputBuffer.map(c => c.text)).toContain('hello');
  });

  test('tabId defaults to the PTY id for unswitched tabs', () => {
    addTerminalTab(7);

    tm._registerTerminalHandler(7, jest.fn(), jest.fn());
    tm._terminalDataHandlers.get(7)({ id: 7, data: 'hi' });

    expect(tm._lastTerminalData.has(7)).toBe(true);
  });
});

describe('setActiveTerminal', () => {
  test('survives a tab left with no xterm by a failed switch', () => {
    addTerminalTab('chat-abc', { ptyId: null });
    // What the chat->terminal error path stores when the PTY refuses to spawn.
    Object.assign(getTerminal('chat-abc'), { terminal: null, fitAddon: null, status: 'error' });

    // Threw `Cannot read properties of null (reading 'fit')` before the guard,
    // which killed the click handler the mode toggle rides on.
    expect(() => tm.setActiveTerminal('chat-abc')).not.toThrow();
  });
});

describe('getStatusForTab', () => {
  test('reports the PTY of a switched tab rather than null', () => {
    addTerminalTab('chat-abc', { ptyId: 42 });

    expect(tm.getStatusForTab('t-chat-abc').ptyId).toBe(42);
  });

  test('reports no PTY for a chat tab', () => {
    addTerminalTab('chat-xyz');
    Object.assign(getTerminal('chat-xyz'), { mode: 'chat', terminal: null, fitAddon: null });

    expect(tm.getStatusForTab('t-chat-xyz').ptyId).toBeNull();
  });
});
