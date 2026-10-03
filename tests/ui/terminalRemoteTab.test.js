/**
 * Remote (SSH) terminal tabs in the renderer (design/remote-ssh.md 5.1).
 *
 * - A remote tab carries its host badge and holds its host while open.
 * - A lost connection (main's `terminal-disconnected`) leaves the tab in
 *   place under a "connection lost" overlay, and the tab respawns by itself
 *   once its host is connected again: a Claude tab with `--resume`, a shell
 *   without. An auth or host key failure never respawns on its own, and
 *   automatic respawns stop after a few in a row; the Reconnect button always
 *   works.
 * - Tabs belong to projects by id once a remote project is involved: a local
 *   project at /home/u/app and a remote one at /home/u/app on some host do not
 *   share tabs.
 * - With hooks on, remote tabs still produce events, through the scraping
 *   provider: their CLI never reaches the local hook server.
 */

jest.mock('../../src/renderer/services/TerminalSessionService', () => ({
  saveTerminalSessions: jest.fn(),
  loadTerminalSessions: jest.fn(),
  takeRemoteTabs: jest.fn(() => null),
}));

const { createRemoteTabs, AUTO_RESPAWN_LIMIT } = require('../../src/renderer/ui/components/terminal/remoteTab');

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

const REMOTE = {
  id: 'r1',
  name: 'api',
  type: 'general',
  path: 'ssh-remote://abcd1234/home/u/app',
  remote: { profileId: 'abcd1234', path: '/home/u/app', hostLabel: 'u@build' },
};
const LOCAL = { id: 'l1', name: 'app', type: 'standalone', path: '/home/u/app' };

describe('remote tab unit', () => {
  let state, listeners, api, held, released, terminals, toasts, closed, timers, clock, connectCalls, nudges;

  function make() {
    return createRemoteTabs({
      api,
      getTerminal: (id) => terminals.get(id),
      ptyIdOf: (td, tabId) => td?.ptyId ?? tabId,
      hosts: {
        getProjectHost: (project) => (project.remote ? { profileId: 'abcd1234', hostLabel: 'u@build', state } : null),
        holdHost: (id) => { held.push(id); return () => released.push(id); },
        connectHost: (id) => { connectCalls.push(id); return Promise.resolve(null); },
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        nudge: () => { nudges++; },
      },
      badge: {
        buildHostBadgeHtml: (project) => `<span class="remote-host-badge state-${state}">${project.remote.hostLabel}</span>`,
        onHostBadgeClick: jest.fn(),
        stateLabel: (s) => `label:${s}`,
      },
      t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
      toast: (opts) => toasts.push(opts),
      onCloseTab: (id) => closed.push(id),
      now: () => clock,
      setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
      clearTimer: (h) => { const i = timers.indexOf(h); if (i !== -1) timers.splice(i, 1); },
    });
  }

  const setHost = (next) => { state = next; for (const fn of [...listeners]) fn(); };
  const runTimers = () => { const due = timers.splice(0); for (const h of due) h.fn(); };

  function tabDom(id) {
    const tab = document.createElement('div');
    tab.className = 'terminal-tab';
    tab.innerHTML = '<span class="status-dot"></span><span class="tab-name">api</span>';
    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper';
    document.body.append(tab, wrapper);
    terminals.set(id, { terminal: { write: jest.fn(), cols: 100, rows: 40, buffer: { active: { length: 1 } } }, claudeSessionId: 'sess-123', project: REMOTE });
    return { tab, wrapper };
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    state = 'connected';
    listeners = new Set();
    held = [];
    released = [];
    terminals = new Map();
    toasts = [];
    closed = [];
    timers = [];
    clock = 1000000;
    connectCalls = [];
    nudges = 0;
    api = { terminal: { respawn: jest.fn(async ({ id }) => ({ success: true, id })), resize: jest.fn() } };
  });

  test('a local project is never attached', () => {
    const tabs = make();
    expect(tabs.attach(1, { project: LOCAL, tabEl: document.createElement('div') })).toBe(false);
    expect(tabs.isRemoteTab(1)).toBe(false);
    expect(held).toEqual([]);
  });

  test('a remote tab shows its host badge, holds its host, and lets it go when closed', () => {
    const tabs = make();
    const { tab, wrapper } = tabDom(1);
    expect(tabs.attach(1, { project: REMOTE, tabEl: tab, wrapperEl: wrapper })).toBe(true);
    expect(tab.classList.contains('remote-tab')).toBe(true);
    const badge = tab.querySelector('.tab-remote-host');
    expect(badge.nextElementSibling.classList.contains('tab-name')).toBe(true);
    expect(badge.textContent).toBe('u@build');
    expect(held).toEqual(['abcd1234']);

    setHost('reconnecting');
    expect(tab.querySelector('.remote-host-badge').className).toContain('state-reconnecting');

    tabs.detach(1);
    expect(released).toEqual(['abcd1234']);
    expect(listeners.size).toBe(0);
  });

  test('a lost connection shows the overlay and respawns a Claude tab with --resume once the host is back', async () => {
    const tabs = make();
    const { tab, wrapper } = tabDom(1);
    tabs.attach(1, { project: REMOTE, tabEl: tab, wrapperEl: wrapper, isClaude: true });
    setHost('reconnecting');

    tabs.onDisconnected(1, { kind: 'network' });
    expect(tabs.isDisconnected(1)).toBe(true);
    expect(tab.classList.contains('remote-disconnected')).toBe(true);
    expect(wrapper.querySelector('.terminal-remote-overlay')).not.toBeNull();
    expect(wrapper.querySelector('.terminal-remote-title').textContent).toContain('ssh.terminal.lost');
    expect(nudges).toBe(1);
    expect(api.terminal.respawn).not.toHaveBeenCalled();

    setHost('connected');
    expect(timers).toHaveLength(1);
    runTimers();
    await flush();
    expect(api.terminal.respawn).toHaveBeenCalledWith({ id: 1, resumeSessionId: 'sess-123' });
    expect(tabs.isDisconnected(1)).toBe(false);
    expect(wrapper.querySelector('.terminal-remote-overlay')).toBeNull();
    expect(tab.classList.contains('remote-disconnected')).toBe(false);
    expect(api.terminal.resize).toHaveBeenCalledWith({ id: 1, cols: 100, rows: 40 });
    expect(terminals.get(1).terminal.write).toHaveBeenCalledWith(expect.stringContaining('ssh.terminal.reconnected'));
  });

  test('a shell tab respawns without a session id, through the PTY id of a switched tab', async () => {
    const tabs = make();
    const { tab, wrapper } = tabDom('tab-a');
    terminals.get('tab-a').ptyId = 42;
    tabs.attach('tab-a', { project: REMOTE, tabEl: tab, wrapperEl: wrapper, isClaude: false });
    tabs.onDisconnected('tab-a', { kind: 'timeout' });
    runTimers();
    await flush();
    expect(api.terminal.respawn).toHaveBeenCalledWith({ id: 42, resumeSessionId: null });
  });

  test('an idle host is asked to connect, since a tab of it is open', () => {
    const tabs = make();
    const { tab, wrapper } = tabDom(1);
    state = 'idle';
    tabs.attach(1, { project: REMOTE, tabEl: tab, wrapperEl: wrapper });
    tabs.onDisconnected(1, { kind: 'network' });
    expect(connectCalls).toEqual(['abcd1234']);
    expect(timers).toHaveLength(0);
  });

  test('an authentication or host key failure never respawns on its own; Reconnect does', async () => {
    const tabs = make();
    const { tab, wrapper } = tabDom(1);
    tabs.attach(1, { project: REMOTE, tabEl: tab, wrapperEl: wrapper });
    tabs.onDisconnected(1, { kind: 'auth' });
    setHost('connected');
    expect(timers).toHaveLength(0);
    expect(api.terminal.respawn).not.toHaveBeenCalled();
    expect(wrapper.querySelector('.terminal-remote-detail').textContent).toContain('ssh.terminal.needsUser');

    wrapper.querySelector('[data-action="reconnect"]').click();
    await flush();
    expect(api.terminal.respawn).toHaveBeenCalledTimes(1);
  });

  test(`automatic respawns stop after ${AUTO_RESPAWN_LIMIT} in a row`, async () => {
    const tabs = make();
    const { tab, wrapper } = tabDom(1);
    tabs.attach(1, { project: REMOTE, tabEl: tab, wrapperEl: wrapper });
    for (let i = 0; i < AUTO_RESPAWN_LIMIT; i++) {
      tabs.onDisconnected(1, { kind: 'network' });
      runTimers();
      await flush();
    }
    expect(api.terminal.respawn).toHaveBeenCalledTimes(AUTO_RESPAWN_LIMIT);
    tabs.onDisconnected(1, { kind: 'network' });
    expect(timers).toHaveLength(0);
    expect(wrapper.querySelector('.terminal-remote-detail').textContent).toBe('ssh.terminal.gaveUp');
  });

  test('a respawn that fails keeps the overlay and shows why', async () => {
    api.terminal.respawn.mockResolvedValueOnce({ success: false, error: 'No OpenSSH client was found on this machine' });
    const tabs = make();
    const { tab, wrapper } = tabDom(1);
    tabs.attach(1, { project: REMOTE, tabEl: tab, wrapperEl: wrapper });
    tabs.onDisconnected(1, { kind: 'network' });
    runTimers();
    await flush();
    expect(tabs.isDisconnected(1)).toBe(true);
    const error = wrapper.querySelector('.terminal-remote-error');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('No OpenSSH client');
  });

  test('a drop that lands before the respawn answers keeps the tab disconnected', async () => {
    let answer;
    api.terminal.respawn.mockImplementationOnce(() => new Promise((r) => { answer = r; }));
    const tabs = make();
    const { tab, wrapper } = tabDom(1);
    tabs.attach(1, { project: REMOTE, tabEl: tab, wrapperEl: wrapper });
    tabs.onDisconnected(1, { kind: 'network' });
    runTimers();
    tabs.onDisconnected(1, { kind: 'dns' });
    answer({ success: true, id: 1 });
    await flush();
    expect(tabs.isDisconnected(1)).toBe(true);
    expect(wrapper.querySelector('.terminal-remote-overlay')).not.toBeNull();
  });

  test('the Close button closes the tab', () => {
    const tabs = make();
    const { tab, wrapper } = tabDom(1);
    tabs.attach(1, { project: REMOTE, tabEl: tab, wrapperEl: wrapper });
    tabs.onDisconnected(1, { kind: 'auth' });
    wrapper.querySelector('[data-action="close"]').click();
    expect(closed).toEqual([1]);
  });

  test('the resume watchdog counts from the host being connected', () => {
    const tabs = make();
    const { tab, wrapper } = tabDom(1);
    state = 'connecting';
    tabs.attach(1, { project: REMOTE, tabEl: tab, wrapperEl: wrapper, isClaude: true });
    const onStale = jest.fn();
    tabs.armResumeWatchdog(1, { delayMs: 20000, hasOutput: () => false, onStale });
    expect(timers).toHaveLength(0);
    setHost('connected');
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(20000);
    runTimers();
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  test('a remote Claude tab ending with 127 says claude is missing on the host', () => {
    const tabs = make();
    const { tab, wrapper } = tabDom(1);
    tabs.attach(1, { project: REMOTE, tabEl: tab, wrapperEl: wrapper, isClaude: true });
    tabs.onExit(1, { exitCode: 127 });
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain('ssh.terminal.claudeMissing');
  });
});

// ── TerminalManager ──

function makeApiMock(listeners, calls) {
  const ns = (namespace) => new Proxy({}, {
    get: (_t, method) => (...args) => {
      if (typeof method === 'string' && method.startsWith('on')) {
        listeners[`${namespace}.${method}`] = args[0];
        return () => {};
      }
      calls.push({ namespace, method, args });
      if (namespace === 'terminal' && method === 'create') return Promise.resolve({ success: true, id: 77 });
      return Promise.resolve({ success: true });
    },
  });
  return new Proxy({}, { get: (_t, namespace) => ns(namespace) });
}

describe('TerminalManager with remote projects', () => {
  let listeners, calls, manager, terminalsState, projectsState;

  const seedTab = (id, project, extra = {}) => {
    terminalsState.addTerminal(id, { name: 'Tab', project, projectIndex: 0, mode: 'terminal', status: 'ready', ...extra });
    const tab = document.createElement('div');
    tab.className = 'terminal-tab';
    tab.dataset.id = id;
    tab.innerHTML = '<span class="tab-name">Tab</span><span class="tab-close"></span>';
    document.getElementById('terminals-tabs').appendChild(tab);
    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper';
    wrapper.dataset.id = id;
    document.getElementById('terminals-container').appendChild(wrapper);
    return { tab, wrapper };
  };

  beforeEach(() => {
    jest.resetModules();
    listeners = {};
    calls = [];
    window.electron_api = makeApiMock(listeners, calls);
    document.body.innerHTML = `
      <div id="terminals-tabs"></div>
      <div id="terminals-container"></div>
      <div id="empty-terminals"></div>
      <div id="terminals-filter"><span id="filter-project-name"></span></div>`;
    terminalsState = require('../../src/renderer/state/terminals.state');
    ({ projectsState } = require('../../src/renderer/state/projects.state'));
    projectsState.set({ ...projectsState.get(), projects: [LOCAL, REMOTE], rootOrder: ['l1', 'r1'] });
    const { TerminalManager } = require('../../src/renderer/ui/components/TerminalManager');
    manager = new TerminalManager();
    manager.setCallbacks({ onRenderProjects: jest.fn() });
  });

  afterEach(() => {
    try { terminalsState.clearAllTerminals(() => {}); } catch (_) { /* best effort */ }
  });

  test('a local project at /home/u/app and a remote one at /home/u/app do not share tabs', () => {
    seedTab('t-local', LOCAL);
    seedTab('t-remote', REMOTE, { projectIndex: 1 });
    expect(manager.countTerminalsForProject(0)).toBe(1);
    expect(manager.countTerminalsForProject(1)).toBe(1);

    manager.filterByProject(1);
    const shown = (id) => document.querySelector(`.terminal-tab[data-id="${id}"]`).style.display !== 'none';
    expect(shown('t-remote')).toBe(true);
    expect(shown('t-local')).toBe(false);

    manager.filterByProject(0);
    expect(shown('t-local')).toBe(true);
    expect(shown('t-remote')).toBe(false);
  });

  test('a remote terminal is no longer refused, and names its ssh session; a local one sends nothing new', async () => {
    try { await manager.createTerminal(REMOTE, { mode: 'terminal', runClaude: false }); } catch (_) { /* xterm cannot load in jsdom */ }
    const remoteCreate = calls.find((c) => c.namespace === 'terminal' && c.method === 'create').args[0];
    expect(remoteCreate).toMatchObject({ cwd: REMOTE.path, projectId: 'r1', projectPath: REMOTE.path, runClaude: false });
    expect(remoteCreate.sessionKey).toMatch(/^tab_r1_/);

    calls.length = 0;
    try { await manager.createTerminal(LOCAL, { mode: 'terminal', runClaude: false }); } catch (_) { /* xterm */ }
    const localCreate = calls.find((c) => c.namespace === 'terminal' && c.method === 'create').args[0];
    expect(localCreate).not.toHaveProperty('sessionKey');
  });

  test('a restored remote tab reattaches under its saved session key', async () => {
    try { await manager.createTerminal(REMOTE, { mode: 'terminal', runClaude: false, remoteSessionKey: 'tab_r1_saved' }); } catch (_) { /* xterm */ }
    const params = calls.find((c) => c.namespace === 'terminal' && c.method === 'create').args[0];
    expect(params.sessionKey).toBe('tab_r1_saved');
  });

  test('terminal-disconnected reaches the remote tab that owns the PTY', () => {
    const { tab, wrapper } = seedTab('t-remote', REMOTE, { ptyId: 9 });
    manager._remoteTabs.attach('t-remote', { project: REMOTE, tabEl: tab, wrapperEl: wrapper });
    manager._initIpcDispatcher();
    listeners['terminal.onDisconnected']({ id: 9, exitCode: 255, kind: 'network' });
    expect(manager._remoteTabs.isDisconnected('t-remote')).toBe(true);
    expect(wrapper.querySelector('.terminal-remote-overlay')).not.toBeNull();

    // Closing it detaches it and kills the (waiting) PTY under its own id.
    manager.closeTerminal('t-remote');
    expect(manager._remoteTabs.isRemoteTab('t-remote')).toBe(false);
    expect(calls.some((c) => c.namespace === 'terminal' && c.method === 'kill' && c.args[0].id === 9)).toBe(true);
  });

  test('a new chat tab of a remote project carries the host badge; a local one does not', async () => {
    // Terminal tabs had it and a tab switched from terminal kept it, but a
    // chat opened as a chat showed no host at all in the tab strip.
    try { await manager._createChatTerminal(REMOTE, {}); } catch (_) { /* the chat view needs more DOM */ }
    const remoteTab = document.querySelector('.terminal-tab.chat-mode');
    expect(remoteTab.classList.contains('remote-tab')).toBe(true);
    expect(remoteTab.querySelector('.tab-remote-host .remote-host-badge')).not.toBeNull();
    expect(manager._remoteTabs.isRemoteTab(remoteTab.dataset.id)).toBe(true);
    remoteTab.remove();

    try { await manager._createChatTerminal(LOCAL, {}); } catch (_) { /* the chat view needs more DOM */ }
    const localTab = document.querySelector('.terminal-tab.chat-mode');
    expect(localTab.classList.contains('remote-tab')).toBe(false);
    expect(localTab.querySelector('.tab-remote-host')).toBeNull();
    expect(manager._remoteTabs.isRemoteTab(localTab.dataset.id)).toBe(false);
  });

  test('a remote tab is no longer refused a switch to chat: chat runs on the host too', async () => {
    seedTab('t-remote', REMOTE, { isBasic: false });
    const refuse = jest.spyOn(require('../../src/renderer/ui/components/RemoteHostBadge'), 'refuseForRemote');
    try { await manager.switchTerminalMode('t-remote'); } catch (_) { /* the chat view needs more DOM than the seed */ }
    expect(refuse).not.toHaveBeenCalledWith(REMOTE, 'chat');
    refuse.mockRestore();
  });
});

// ── Events ──

describe('events for remote tabs with hooks on', () => {
  let scrape, seen, off, events;

  beforeEach(() => {
    jest.resetModules();
    scrape = null;
    jest.doMock('../../src/renderer/ui/components/TerminalManager', () => ({
      setScrapingCallback: (cb) => { scrape = cb; },
    }));
    window.electron_api = {
      ...window.electron_api,
      hooks: { onEvent: (cb) => { window.__hookCb = cb; return () => {}; } },
      terminal: { onExit: () => () => {} },
    };
    const { projectsState } = require('../../src/renderer/state/projects.state');
    projectsState.set({ ...projectsState.get(), projects: [REMOTE] });
    const terminals = require('../../src/renderer/state/terminals.state');
    terminals.clearAllTerminals(() => {});
    terminals.addTerminal('t-remote', { project: REMOTE, mode: 'terminal', status: 'ready' });
    terminals.addTerminal('t-local', { project: LOCAL, mode: 'terminal', status: 'ready' });
    const { eventBus } = require('../../src/renderer/events/ClaudeEventBus');
    seen = [];
    off = eventBus.on('*', (e) => seen.push(e));
    events = require('../../src/renderer/events');
    events.switchProvider('hooks');
  });

  afterEach(() => {
    off();
    events.switchProvider('scraping');
    jest.dontMock('../../src/renderer/ui/components/TerminalManager');
    delete window.__hookCb;
  });

  test('the scraping provider speaks for remote tabs, and only for them', () => {
    const { EVENT_TYPES } = require('../../src/renderer/events/ClaudeEventBus');
    expect(events.getActiveProvider()).toBe('hooks');
    expect(typeof scrape).toBe('function');

    scrape('t-local', 'working', {});
    expect(seen).toHaveLength(0);

    scrape('t-remote', 'working', { tool: 'Bash' });
    const working = seen.find((e) => e.type === EVENT_TYPES.CLAUDE_WORKING);
    expect(working).toMatchObject({ source: 'scraping', projectId: 'r1' });
    expect(seen.some((e) => e.type === EVENT_TYPES.SESSION_START && e.projectId === 'r1')).toBe(true);
  });

  test('a local hook event is never attributed to a remote project at the same path', () => {
    window.__hookCb({ hook: 'PreToolUse', stdin: { session_id: 's', tool_name: 'Bash' }, cwd: '/home/u/app' });
    window.__hookCb({ hook: 'PreToolUse', stdin: { session_id: 's', tool_name: 'Bash' }, cwd: REMOTE.path });
    expect(seen.filter((e) => e.source === 'hooks')).toHaveLength(0);
  });

  test('switching hooks off stops the remote-only scraping and starts the full one', () => {
    events.switchProvider('scraping');
    scrape('t-local', 'working', {});
    expect(seen.some((e) => e.source === 'scraping')).toBe(true);
  });
});
