/**
 * A session that needs the user has to say so outside its own transcript.
 *
 * Two cases were invisible from anywhere but the tab itself. A session waiting
 * on a permission, question or plan only turned its 8px dot a slightly
 * different orange from "working". A turn that failed ended exactly like one
 * that succeeded: the error banner went into the transcript and the tab went
 * green. The `attention` flag on a tab is what the tab strip, the project list
 * and the project bar now draw from, and these are the rules that set and
 * clear it.
 */

jest.mock('../../src/renderer/services/TerminalSessionService', () => ({
  saveTerminalSessions: jest.fn(),
  loadTerminalSessions: jest.fn(),
}));

/** api mock: `on*` captures its callback, everything else records and succeeds. */
function makeApiMock(listeners, calls) {
  const ns = (namespace) => new Proxy({}, {
    get: (_t, method) => (...args) => {
      if (typeof method === 'string' && method.startsWith('on')) {
        listeners[method] = args[0];
        return () => {};
      }
      calls.push({ namespace, method, args });
      return Promise.resolve({ success: true, messages: [] });
    }
  });
  return new Proxy({}, { get: (_t, namespace) => ns(namespace) });
}

let uuidSeq = 0;
Object.defineProperty(global, 'crypto', {
  value: { ...(global.crypto || {}), randomUUID: () => `attn-uuid-${++uuidSeq}` },
  configurable: true,
});

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};

describe('tab attention (TerminalManager)', () => {
  let manager, state, projectsState, rendered;

  const seedTab = (id, data = {}) => {
    state.addTerminal(id, {
      name: 'Tab',
      project: { id: 'p1', name: 'Test', path: '/tmp/test' },
      projectIndex: 0,
      mode: 'chat',
      status: 'ready',
      ...data,
    });
    const tab = document.createElement('div');
    tab.className = 'terminal-tab status-ready';
    tab.dataset.id = id;
    tab.innerHTML = '<span class="status-dot"></span><span class="tab-name">Tab</span>';
    document.getElementById('terminals-tabs').appendChild(tab);
    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper';
    wrapper.dataset.id = id;
    document.getElementById('terminals-container').appendChild(wrapper);
    return tab;
  };

  const attention = (id) => state.getTerminal(id).attention || null;

  beforeEach(() => {
    jest.resetModules();
    window.electron_api = makeApiMock({}, []);
    document.body.innerHTML = `
      <div id="terminals-tabs"></div>
      <div id="terminals-container"></div>
      <div id="empty-terminals"></div>
      <div id="terminals-filter"><span id="filter-project-name"></span></div>
    `;
    state = require('../../src/renderer/state/terminals.state');
    ({ projectsState } = require('../../src/renderer/state/projects.state'));
    projectsState.set({ ...projectsState.get(), projects: [{ id: 'p1', name: 'Test', path: '/tmp/test' }] });
    const { TerminalManager } = require('../../src/renderer/ui/components/TerminalManager');
    manager = new TerminalManager();
    rendered = 0;
    manager._callbacks.onRenderProjects = () => { rendered++; };
  });

  afterEach(() => {
    try { state.clearAllTerminals(() => {}); } catch (_) { /* best effort */ }
  });

  it('flags a chat tab waiting on an answer, and draws it on the tab', () => {
    const tab = seedTab('t1');
    manager._updateChatTerminalStatus('t1', 'working', 'thinking');
    manager._updateChatTerminalStatus('t1', 'working', 'waiting');

    expect(attention('t1')).toBe('input');
    expect(tab.classList.contains('attention-input')).toBe(true);
    expect(tab.querySelector('.status-dot').title).toBe('Waiting for your answer');
    // The project list re-renders off the change.
    expect(rendered).toBeGreaterThan(0);
  });

  it('drops the wait once the session carries on', () => {
    const tab = seedTab('t1');
    manager._updateChatTerminalStatus('t1', 'working', 'waiting');
    manager._updateChatTerminalStatus('t1', 'working', 'thinking');

    expect(attention('t1')).toBeNull();
    expect(tab.classList.contains('attention-input')).toBe(false);
    expect(tab.querySelector('.status-dot').hasAttribute('title')).toBe(false);
  });

  it('keeps a failed turn ready for the next message, flagged as an error', () => {
    const tab = seedTab('t1');
    manager._updateChatTerminalStatus('t1', 'working', 'thinking');
    manager._updateChatTerminalStatus('t1', 'ready', 'error');

    // `ready` is what MCP tab_wait reads as "the prompt is free".
    expect(state.getTerminal('t1').status).toBe('ready');
    expect(attention('t1')).toBe('error');
    expect(tab.classList.contains('attention-error')).toBe(true);
  });

  it('keeps the error through a plain ready, and drops it on the next turn', () => {
    seedTab('t1');
    manager._updateChatTerminalStatus('t1', 'ready', 'error');
    manager._updateChatTerminalStatus('t1', 'ready');
    expect(attention('t1')).toBe('error');

    manager._updateChatTerminalStatus('t1', 'working', 'thinking');
    expect(attention('t1')).toBeNull();
  });

  it('clears an error when the user opens the tab, but not a pending answer', () => {
    seedTab('t1');
    seedTab('t2');
    seedTab('t3');
    manager.setActiveTerminal('t1');
    manager._updateChatTerminalStatus('t2', 'ready', 'error');
    manager._updateChatTerminalStatus('t3', 'working', 'waiting');

    manager.setActiveTerminal('t2');
    manager.setActiveTerminal('t3');

    expect(attention('t2')).toBeNull();
    expect(attention('t3')).toBe('input');
  });

  it('counts waiting and failed sessions per project', () => {
    seedTab('t1');
    seedTab('t2');
    seedTab('t3');
    manager._updateChatTerminalStatus('t1', 'working', 'waiting');
    manager._updateChatTerminalStatus('t2', 'ready', 'error');

    expect(manager.getTerminalStatsForProject(0)).toEqual({ total: 3, working: 1, input: 1, error: 1 });
  });

  // With hooks off (the default), a PTY tab's wait is read off its screen
  // when the turn stops. The xterm buffer is faked: only what the dialog test
  // reads of it.
  const screen = (lines) => ({
    rows: lines.length,
    buffer: { active: { viewportY: 0, baseY: 0, cursorY: 0, getLine: (i) => (i < lines.length ? { translateToString: () => lines[i] } : undefined) } },
  });

  it('reads a terminal tab\'s approval dialog off its screen when the turn stops', () => {
    const tab = seedTab('t1', { mode: 'terminal', status: 'working', terminal: screen([
      ' Bash command',
      '   npm run db:migrate',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No, and tell Claude what to do differently',
    ]) });

    manager._declareReady('t1');

    expect(attention('t1')).toBe('input');
    expect(tab.classList.contains('attention-input')).toBe(true);
  });

  it('drops it when the turn stops on anything else', () => {
    seedTab('t1', { mode: 'terminal', status: 'working', terminal: screen(['✳ Done for 12s', '> ']) });
    manager.setTerminalAttention('t1', 'input');

    manager._declareReady('t1');

    expect(attention('t1')).toBeNull();
  });

  it('ignores a tab that is gone', () => {
    expect(() => manager.setTerminalAttention('nope', 'input')).not.toThrow();
    expect(rendered).toBe(0);
  });
});

describe('chat status reaching the tab (ChatView)', () => {
  let listeners, calls, wrapper, view, sessionId, statuses;

  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)); };
  const last = () => statuses[statuses.length - 1];

  beforeEach(async () => {
    jest.resetModules();
    listeners = {};
    calls = [];
    statuses = [];
    window.electron_api = makeApiMock(listeners, calls);
    document.body.innerHTML = '';
    wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const { createChatView } = require('../../src/renderer/ui/components/ChatView');
    view = createChatView(wrapper, { id: 'p1', name: 'Test', path: '/tmp/test' }, {
      onStatusChange: (status, substatus) => statuses.push([status, substatus]),
    });
    view.sendMessage('go');
    await flush();
    sessionId = view.getSessionId();
    expect(sessionId).toBeTruthy();
  });

  afterEach(() => {
    try { view?.destroy?.(); } catch (_) { /* best effort */ }
  });

  it('ends a turn that errored on `error`, not on `ready`', () => {
    listeners.onError({ sessionId, error: 'API Error: 500' });

    expect(last()).toEqual(['ready', 'error']);
    expect(wrapper.querySelector('.chat-status-dot').classList.contains('error')).toBe(true);
  });

  it('ends a turn whose result is an error on `error`', () => {
    listeners.onMessage({ sessionId, message: { type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['boom'] } });

    expect(last()).toEqual(['ready', 'error']);
  });

  it('ends a clean turn on plain `ready`', () => {
    listeners.onDone({ sessionId, interrupted: false });

    expect(last()).toEqual(['ready', undefined]);
  });

  it('starts the next turn clean', async () => {
    listeners.onError({ sessionId, error: 'API Error: 500' });
    view.sendMessage('again');
    await flush();
    listeners.onDone({ sessionId, interrupted: false });

    expect(last()).toEqual(['ready', undefined]);
  });

  it('says it is waiting while a permission card is up', () => {
    listeners.onPermissionRequest({ sessionId, requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } });

    expect(last()).toEqual(['working', 'waiting']);
  });
});
