/**
 * Terminal font size: applying the setting to open terminals and new consoles.
 *
 * Changing the size only alters xterm's glyph metrics; the container does not
 * change, so the ResizeObserver that normally pushes a new grid to the PTY
 * stays quiet. `updateAllTerminalsFontSize` has to do that push itself, and it
 * has to reach the right backend for each kind of tab:
 *
 *   - a tab opened as a terminal is keyed by its PTY id;
 *   - a tab that switched out of chat keeps its `chat-…` key and records the
 *     PTY in `termData.ptyId` (sending the tab key matched nothing);
 *   - a project-type console (WebApp, API, FiveM, Minecraft) resizes through
 *     its own IPC namespace, not `terminal`.
 *
 * New project-type consoles must also read the setting at creation, so that
 * an existing console and a reopened one end up the same size.
 */

const path = require('path');

// xterm stand-in: records the constructor options and exposes a fixed grid.
// Defined inside the factory (jest hoists mocks above other declarations) and
// read back through the mocked module below.
jest.mock('@xterm/xterm', () => ({
  Terminal: class FakeTerminal {
    constructor(options) {
      this.options = { ...options };
      this.cols = 100;
      this.rows = 30;
      this.refresh = () => {};
      this.dispose = () => {};
      // createTypeConsole wires a dozen xterm hooks (onSelectionChange, onKey,
      // attachCustomKeyEventHandler, ...); none of them matter here, so any
      // method not modelled above answers with a no-op disposable.
      return new Proxy(this, {
        get(target, key) {
          if (key in target || typeof key !== 'string' || key === 'then') return target[key];
          return () => ({ dispose() {} });
        },
      });
    }
    open() {}
    loadAddon() {}
    focus() {}
    blur() {}
  },
}));
jest.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
jest.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
// xterm is loaded lazily on first mount; hand the mocked modules straight back.
jest.mock('../../src/renderer/services/xtermLoader', () => ({
  loadXterm: async () => ({
    Terminal: require('@xterm/xterm').Terminal,
    FitAddon: require('@xterm/addon-fit').FitAddon,
  }),
  attachWebglAddon: () => {},
}));

// The console registry pulls in the whole project-type tree; a single stub
// type with a WebApp-shaped console config is all that is exercised here.
jest.mock('../../src/project-types/registry', () => ({
  get: () => ({
    getConsoleConfig: () => ({
      typeId: 'webapp', tabIcon: 'W', tabClass: 'webapp-tab', dotClass: '', wrapperClass: '',
      consoleViewSelector: '.console-view', ipcNamespace: 'webapp', scrollback: 1000, disableStdin: false,
      getExistingLogs: () => [],
    }),
    getTerminalPanels: () => [{ getWrapperHtml: () => '<div class="console-view"></div>' }],
  }),
}));

const { Terminal: FakeTerminal } = require('@xterm/xterm');

const TM_PATH = '../../src/renderer/ui/components/TerminalManager';

let TerminalManager;
let terminalsState, addTerminal, getTerminal;
let settingsState;

beforeAll(() => {
  global.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  window.electron_api = {
    ...window.electron_api,
    terminal: {
      create: jest.fn(async () => ({ success: true, id: 42 })),
      input: jest.fn(), resize: jest.fn(), kill: jest.fn(),
      onData: jest.fn(() => () => {}), onExit: jest.fn(() => () => {}),
    },
    webapp: { input: jest.fn(), resize: jest.fn() },
  };

  ({ TerminalManager } = require(TM_PATH));
  ({ terminalsState, addTerminal, getTerminal } = require('../../src/renderer/state/terminals.state'));
  ({ settingsState } = require('../../src/renderer/state/settings.state'));
});

let tm;

beforeEach(() => {
  window.electron_api.terminal.resize.mockClear();
  window.electron_api.webapp.resize.mockClear();
  terminalsState.set({ ...terminalsState.get(), terminals: new Map(), activeTerminal: null });
  document.body.innerHTML = `
    <div id="terminals-tabs"></div>
    <div id="terminals-container"></div>
    <div id="empty-terminals"></div>
    <div id="terminals-filter"></div>`;
  tm = new TerminalManager();
  tm.filterByProject = jest.fn();
  tm.setActiveTerminal = jest.fn();
  tm.setCallbacks({ onRenderProjects: jest.fn() });
});

/** The next animation frame, as tests/setup.js models it (setTimeout 0). */
const nextFrame = () => new Promise(resolve => setTimeout(resolve, 0));

function addTab(id, extra = {}) {
  const terminal = new FakeTerminal({ fontSize: 14 });
  const fitAddon = { fit: jest.fn() };
  addTerminal(id, {
    terminal, fitAddon,
    project: { id: 'p1', name: 'Proj', path: '/p' },
    projectIndex: 0, name: 'tab', status: 'ready', mode: 'terminal',
    ...extra,
  });
  return { terminal, fitAddon };
}

describe('updateAllTerminalsFontSize', () => {
  test('applies the size, refits, and resizes a tab opened as a terminal by its own id', async () => {
    const { terminal, fitAddon } = addTab(7);

    tm.updateAllTerminalsFontSize(18);
    await nextFrame();

    expect(terminal.options.fontSize).toBe(18);
    expect(fitAddon.fit).toHaveBeenCalled();
    expect(window.electron_api.terminal.resize).toHaveBeenCalledWith({ id: 7, cols: 100, rows: 30 });
  });

  test('resizes a tab that switched out of chat by its PTY id, not its tab key', async () => {
    addTab('chat-abc', { ptyId: 42 });

    tm.updateAllTerminalsFontSize(18);
    await nextFrame();

    expect(window.electron_api.terminal.resize).toHaveBeenCalledWith({ id: 42, cols: 100, rows: 30 });
    expect(window.electron_api.terminal.resize).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'chat-abc' }));
  });

  test('resizes a project-type console through its own IPC namespace', async () => {
    addTab('webapp-3-1', { ipcNamespace: 'webapp', projectIndex: 3, type: 'webapp' });

    tm.updateAllTerminalsFontSize(18);
    await nextFrame();

    expect(window.electron_api.webapp.resize).toHaveBeenCalledWith({ projectIndex: 3, cols: 100, rows: 30 });
    expect(window.electron_api.terminal.resize).not.toHaveBeenCalled();
  });

  test('skips a chat tab that has no xterm instance', async () => {
    addTerminal('chat-only', { project: { id: 'p1' }, mode: 'chat', name: 'chat' });

    expect(() => tm.updateAllTerminalsFontSize(18)).not.toThrow();
    await nextFrame();

    expect(window.electron_api.terminal.resize).not.toHaveBeenCalled();
  });

  test('applies a change back to the previous value', async () => {
    const { terminal } = addTab(7);

    tm.updateAllTerminalsFontSize(16);
    await nextFrame();
    tm.updateAllTerminalsFontSize(14);
    await nextFrame();

    // 14 → 16 → 14 at the manager level: each call applies unconditionally.
    // The panel-side comparison that once skipped the second change is
    // covered by tests/ui/settingsTerminalFontSize.test.js.
    expect(terminal.options.fontSize).toBe(14);
    expect(window.electron_api.terminal.resize).toHaveBeenCalledTimes(2);
  });
});

describe('createTypeConsole', () => {
  const project = { id: 'p-web', name: 'Site', path: path.join('C:', 'site'), type: 'webapp' };

  test('reads the saved font size, so a reopened console matches a live-updated one', async () => {
    settingsState.set({ ...settingsState.get(), terminalFontSize: 20 });

    const id = await tm.createTypeConsole(project, 0);

    const termData = getTerminal(id);
    expect(termData.terminal.options.fontSize).toBe(20);
    // Stored so the font-size updater can route the resize to `webapp.resize`.
    expect(termData.ipcNamespace).toBe('webapp');
  });

  test('falls back to the console type default when no size is saved', async () => {
    settingsState.set({ ...settingsState.get(), terminalFontSize: null });

    const id = await tm.createTypeConsole(project, 1);

    const { fontSize } = getTerminal(id).terminal.options;
    expect(typeof fontSize).toBe('number');
    expect(fontSize).toBeGreaterThan(0);
  });
});
