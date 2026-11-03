/**
 * OSC 7501, the Program Status Protocol Claude Code speaks to a terminal that
 * answers its probe (see src/renderer/ui/components/terminal/programStatus.js).
 *
 * Three things have to hold. The probe is answered with the bytes the CLI
 * matches, through the PTY. The title TerminalManager reads keeps its spinner
 * and sparkle, which the CLI drops from its own title once it is answered.
 * And the status moves a tab's attention flag only when it is that tab's one
 * source: below the hooks, above the screen, first on a remote tab.
 */

jest.mock('../../src/renderer/services/TerminalSessionService', () => ({
  saveTerminalSessions: jest.fn(),
  loadTerminalSessions: jest.fn(),
}));

let mockProvider = 'scraping';
jest.mock('../../src/renderer/events', () => ({ getActiveProvider: () => mockProvider }));

const {
  PROBE_REPLY,
  parseProgramStatus,
  attentionOf,
  attentionSource,
  attachProgramStatus,
} = require('../../src/renderer/ui/components/terminal/programStatus');

const OSC = (data) => `\x1b]7501;${data}\x1b\\`;

/** The xterm surface attachProgramStatus uses, driven by hand. */
function fakeTerminal() {
  const term = {
    titleListener: null,
    oscHandlers: new Map(),
    sent: [],
    onTitleChange(fn) { term.titleListener = fn; return { dispose() { term.titleListener = null; } }; },
    parser: { registerOscHandler(code, fn) { term.oscHandlers.set(code, fn); return { dispose() { term.oscHandlers.delete(code); } }; } },
    input(data, wasUserInput) { term.sent.push({ data, wasUserInput }); },
    dispose() {},
    title(t) { term.titleListener?.(t); },
    status(data) { return term.oscHandlers.get(7501)?.(data); },
  };
  return term;
}

describe('parseProgramStatus', () => {
  test('reads the fields the CLI writes, in any order', () => {
    expect(parseProgramStatus('state=blocked:app=claude-code:kind=permission:progress=40:msg=permission prompt'))
      .toEqual({ state: 'blocked', app: 'claude-code', id: undefined, kind: 'permission' });
    expect(parseProgramStatus('app=claude-code:id=t1:state=working'))
      .toEqual({ state: 'working', app: 'claude-code', id: 't1', kind: null });
  });

  test('the probe, and what is not a status', () => {
    expect(parseProgramStatus('?')).toEqual({ probe: true });
    for (const data of ['', 'app=claude-code', 'garbage', 'x'.repeat(5000), null]) {
      expect(parseProgramStatus(data)).toBeNull();
    }
  });
});

describe('attentionOf', () => {
  test.each([
    [{ state: 'blocked', kind: 'permission' }, 'input'],
    [{ state: 'blocked', kind: 'question' }, 'input'],
    [{ state: 'blocked', kind: 'auth' }, 'error'],
    [{ state: 'error' }, 'error'],
    // A dialog the user opened in that very tab is not something to call them back for.
    [{ state: 'blocked', kind: null }, null],
    [{ state: 'working' }, null],
    [{ state: 'done' }, null],
    [{ state: 'idle' }, null],
    [null, null],
  ])('%j -> %s', (status, flag) => expect(attentionOf(status)).toBe(flag));
});

describe('attentionSource: exactly one per tab', () => {
  test.each([
    [{ hooksActive: true, remote: false, programStatus: false }, 'hooks'],
    [{ hooksActive: true, remote: false, programStatus: true }, 'hooks'],
    [{ hooksActive: false, remote: false, programStatus: true }, 'osc'],
    [{ hooksActive: false, remote: false, programStatus: false }, 'screen'],
    // A remote CLI never reaches the local hook server.
    [{ hooksActive: true, remote: true, programStatus: true }, 'osc'],
    [{ hooksActive: true, remote: true, programStatus: false }, 'screen'],
  ])('%j -> %s', (input, source) => expect(attentionSource(input)).toBe(source));
});

describe('attachProgramStatus', () => {
  let term, titles, statuses;
  beforeEach(() => {
    term = fakeTerminal();
    titles = [];
    statuses = [];
    attachProgramStatus(term, { onTitle: (t) => titles.push(t), onStatus: (s) => statuses.push(s) });
  });

  test('answers the probe through the PTY, as the terminal and not as the user', () => {
    term.status('?');
    expect(term.sent).toEqual([{ data: '\x1b]7501;?\x1b\\', wasUserInput: false }]);
    expect(PROBE_REPLY).toBe('\x1b]7501;?\x1b\\');
    expect(statuses).toEqual([]);
  });

  test('hands titles on untouched while the session does not speak the protocol', () => {
    term.title('◐ Fixing the tests');
    term.title('◐ Fixing the tests');
    term.title('bash');
    expect(titles).toEqual(['◐ Fixing the tests', 'bash']);
  });

  test("rebuilds the prefix the CLI drops once answered, from the session's state", () => {
    term.title('Fixing the tests'); // what an answered CLI sets: no prefix
    term.status('state=idle:app=claude-code');
    term.status('state=working:app=claude-code:msg=Bash');
    term.title('Bash npm test');
    term.status('state=blocked:app=claude-code:kind=permission');
    term.status('state=done:app=claude-code');

    expect(titles).toEqual([
      'Fixing the tests',
      '✳ Fixing the tests',
      '◐ Fixing the tests',
      '◐ Bash npm test',
      '✳ Bash npm test',
    ]);
    expect(statuses.map(s => s.state)).toEqual(['idle', 'working', 'blocked', 'done']);
  });

  test('an empty title still reads as Claude Code, so the ready state is seen at startup', () => {
    term.status('state=idle:app=claude-code');
    expect(titles).toEqual(['✳ Claude Code']);
  });

  test('a prefix the CLI did leave is not doubled', () => {
    term.title('✳ Old title');
    term.status('state=working:app=claude-code');
    expect(titles[titles.length - 1]).toBe('◐ Old title');
  });

  test('ignores background tasks and other programs', () => {
    term.status('state=working:app=claude-code:id=task-1:title=Explore');
    term.status('state=clear:id=task-1');
    term.status('state=blocked:app=other-tool:kind=permission');
    expect(statuses).toEqual([]);
    expect(titles).toEqual([]);
  });

  test("the clear written on exit hands the title back as it is, app or not", () => {
    term.title('Claude Code');
    term.status('state=working:app=claude-code');
    term.status('state=clear');
    term.title('user@host: ~');

    expect(statuses[statuses.length - 1]).toBeNull();
    expect(titles.slice(-2)).toEqual(['Claude Code', 'user@host: ~']);
    // A second clear, with nothing active, says nothing.
    term.status('state=clear');
    expect(statuses.filter(s => s === null)).toHaveLength(1);
  });
});

describe('against a real xterm parser', () => {
  // The bytes the CLI sends, ST- and BEL-terminated, through xterm's own OSC
  // parser, and the reply leaving through onData like any terminal answer.
  const write = (term, data) => new Promise(resolve => term.write(data, resolve));

  test('probe and status, end to end', async () => {
    // xterm measures its font on a canvas jsdom does not implement; the parser does not need it.
    const getContext = window.HTMLCanvasElement.prototype.getContext;
    window.HTMLCanvasElement.prototype.getContext = () => null;
    const { Terminal } = require('@xterm/xterm');
    const term = new Terminal({ allowProposedApi: true });
    const out = [];
    term.onData(d => out.push(d));
    const titles = [];
    const statuses = [];
    attachProgramStatus(term, { onTitle: t => titles.push(t), onStatus: s => statuses.push(s) });

    await write(term, OSC('?'));
    expect(out).toEqual([PROBE_REPLY]);

    await write(term, '\x1b]0;Reviewing the diff\x07');
    await write(term, '\x1b]7501;state=working:app=claude-code\x07');
    await write(term, OSC('state=blocked:app=claude-code:kind=question:msg=input needed'));

    expect(statuses.map(s => [s.state, s.kind])).toEqual([['working', null], ['blocked', 'question']]);
    expect(titles).toEqual(['Reviewing the diff', '◐ Reviewing the diff', '✳ Reviewing the diff']);
    term.dispose();
    window.HTMLCanvasElement.prototype.getContext = getContext;
  });
});

describe('TerminalManager: the source of a PTY tab', () => {
  let manager, state;
  const LOCAL = { id: 'p1', name: 'Local', path: '/tmp/test' };
  const REMOTE = { id: 'r1', name: 'Box', path: 'ssh-remote://abcd1234/home/u/api', remote: { profileId: 'abcd1234', path: '/home/u/api', hostLabel: 'box' } };

  /** A dialog on screen, which the screen reader would flag as `input`. */
  const dialogScreen = (term) => Object.assign(term, {
    rows: 3,
    buffer: { active: { viewportY: 0, baseY: 0, cursorY: 0, getLine: (i) => ({ translateToString: () => [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'][i] || '' }) } },
  });

  const seed = (id, project) => {
    const term = dialogScreen(fakeTerminal());
    state.addTerminal(id, { name: 'Tab', project, projectIndex: 0, mode: 'terminal', status: 'working', terminal: term });
    const tab = document.createElement('div');
    tab.className = 'terminal-tab';
    tab.dataset.id = id;
    tab.innerHTML = '<span class="status-dot"></span><span class="tab-name">Tab</span>';
    document.getElementById('terminals-tabs').appendChild(tab);
    const titles = [];
    manager._attachProgramStatus(id, term, (t) => titles.push(t));
    return { term, titles };
  };
  const attention = (id) => state.getTerminal(id).attention || null;

  beforeEach(() => {
    jest.resetModules();
    mockProvider = 'scraping';
    window.electron_api = new Proxy({}, { get: () => new Proxy({}, { get: () => () => Promise.resolve({ success: true }) }) });
    document.body.innerHTML = '<div id="terminals-tabs"></div><div id="terminals-container"></div><div id="empty-terminals"></div><div id="terminals-filter"><span id="filter-project-name"></span></div>';
    state = require('../../src/renderer/state/terminals.state');
    const { TerminalManager } = require('../../src/renderer/ui/components/TerminalManager');
    manager = new TerminalManager();
    manager._callbacks.onRenderProjects = () => {};
  });

  afterEach(() => {
    try { state.clearAllTerminals(() => {}); } catch (_) { /* best effort */ }
  });

  test('hooks off: the status sets the flag, and the screen stops having a say', () => {
    const { term } = seed('t1', LOCAL);
    expect(manager._attentionSourceOf('t1')).toBe('screen');

    term.status('state=blocked:app=claude-code:kind=permission');
    expect(manager._attentionSourceOf('t1')).toBe('osc');
    expect(attention('t1')).toBe('input');

    term.status('state=working:app=claude-code');
    expect(attention('t1')).toBeNull();
    // The dialog still on screen would say `input`; it is not the source any more.
    manager._declareReady('t1');
    expect(attention('t1')).toBeNull();

    term.status('state=error:app=claude-code');
    expect(attention('t1')).toBe('error');
  });

  test('hooks on: a local tab is left to the hooks, whatever it announces', () => {
    mockProvider = 'hooks';
    const { term } = seed('t1', LOCAL);
    manager.setTerminalAttention('t1', 'input'); // what the hooks said

    term.status('state=working:app=claude-code');
    expect(manager._attentionSourceOf('t1')).toBe('hooks');
    expect(attention('t1')).toBe('input');
  });

  test('a remote (SSH) tab takes the status even with hooks on, its CLI never reaching them', () => {
    mockProvider = 'hooks';
    const { term, titles } = seed('r', REMOTE);
    expect(manager._attentionSourceOf('r')).toBe('screen');

    // The probe goes back down the same PTY, which is the ssh process.
    term.status('?');
    expect(term.sent).toEqual([{ data: PROBE_REPLY, wasUserInput: false }]);

    term.status('state=blocked:app=claude-code:kind=question');
    expect(manager._attentionSourceOf('r')).toBe('osc');
    expect(attention('r')).toBe('input');
    expect(titles).toEqual(['✳ Claude Code']);

    term.status('state=working:app=claude-code');
    expect(attention('r')).toBeNull();
  });

  test('when the CLI clears on exit, the screen takes over again and the flag goes', () => {
    const { term } = seed('t1', LOCAL);
    term.status('state=blocked:app=claude-code:kind=permission');
    expect(attention('t1')).toBe('input');

    term.status('state=clear');
    expect(manager._attentionSourceOf('t1')).toBe('screen');
    expect(attention('t1')).toBeNull();
  });

  test('a closed tab forgets its status', () => {
    const { term } = seed('t1', LOCAL);
    term.status('state=idle:app=claude-code');
    expect(manager._programStatus.has('t1')).toBe(true);
    manager.closeTerminal('t1');
    expect(manager._programStatus.has('t1')).toBe(false);
  });
});
