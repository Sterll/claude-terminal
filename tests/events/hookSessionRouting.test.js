/**
 * Hook events must reach the tab that produced them.
 *
 * A hook payload only says *where* Claude ran (cwd) and *which* Claude it was
 * (session_id). Routing on cwd alone made every session of a project land on one
 * arbitrary tab, so an idle tab pulsed 'working' whenever a chat tab, a workflow
 * node or a `claude` outside the app touched the same folder.
 */

const SessionRouter = require('../../src/renderer/events/SessionRouter');
const HooksProvider = require('../../src/renderer/events/HooksProvider');
const { eventBus, EVENT_TYPES } = require('../../src/renderer/events/ClaudeEventBus');
const { addTerminal, clearAllTerminals } = require('../../src/renderer/state/terminals.state');
const { projectsState } = require('../../src/renderer/state/projects.state');

function tab(id, { projectId, mode = 'terminal', claudeSessionId = null, isBasic = false } = {}) {
  return {
    id,
    tabId: `tab_${id}`,
    project: { id: projectId, name: projectId, path: `/w/${projectId}` },
    mode,
    isBasic,
    status: 'ready',
    claudeSessionId
  };
}

function setProjects(projects) {
  projectsState.set({ ...projectsState.get(), projects });
}

describe('SessionRouter', () => {
  beforeEach(() => {
    clearAllTerminals();
    SessionRouter.reset();
  });

  it('gives the session to the tab that carries its id, chat tabs included', () => {
    addTerminal(1, tab(1, { projectId: 'p1' }));
    addTerminal(2, tab(2, { projectId: 'p1', mode: 'chat', claudeSessionId: 'sess-chat' }));

    expect(SessionRouter.resolve('sess-chat', { projectId: 'p1', adopt: true })).toBe(2);
  });

  it('refuses to adopt when several terminal tabs could be the one', () => {
    addTerminal(1, tab(1, { projectId: 'p1' }));
    addTerminal(2, tab(2, { projectId: 'p1' }));

    expect(SessionRouter.resolve('sess-unknown', { projectId: 'p1', adopt: true })).toBeNull();
  });

  it('adopts the last-focused tab when one is nominated', () => {
    addTerminal(1, tab(1, { projectId: 'p1' }));
    addTerminal(2, tab(2, { projectId: 'p1' }));

    expect(SessionRouter.resolve('sess-a', { projectId: 'p1', adopt: true, prefer: 1 })).toBe(1);
    // and stays there without the hint on later events
    expect(SessionRouter.resolve('sess-a', { projectId: 'p1' })).toBe(1);
  });

  it('adopts the only candidate, and never that same tab twice', () => {
    addTerminal(1, tab(1, { projectId: 'p1' }));

    expect(SessionRouter.resolve('sess-a', { projectId: 'p1', adopt: true })).toBe(1);
    // A second Claude in the same folder — a workflow node, an external CLI —
    // must not inherit the tab that is already busy with someone else.
    expect(SessionRouter.resolve('sess-b', { projectId: 'p1', adopt: true })).toBeNull();
  });

  it('frees the tab once its session ends', () => {
    addTerminal(1, tab(1, { projectId: 'p1' }));

    expect(SessionRouter.resolve('sess-a', { projectId: 'p1', adopt: true })).toBe(1);
    SessionRouter.release('sess-a');
    expect(SessionRouter.resolve('sess-b', { projectId: 'p1', adopt: true })).toBe(1);
  });

  it('drops an unknown session rather than guessing', () => {
    addTerminal(1, tab(1, { projectId: 'p1' }));

    expect(SessionRouter.resolve('sess-unknown', { projectId: 'p1' })).toBeNull();
  });

  it('ignores basic shell tabs and other projects', () => {
    addTerminal(1, tab(1, { projectId: 'p1', isBasic: true }));
    addTerminal(2, tab(2, { projectId: 'p2' }));

    expect(SessionRouter.resolve('sess-a', { projectId: 'p1', adopt: true })).toBeNull();
  });

  it('repairs a binding once the real owner announces itself', () => {
    addTerminal(1, tab(1, { projectId: 'p1' }));
    expect(SessionRouter.resolve('sess-a', { projectId: 'p1', adopt: true })).toBe(1);

    // The SDK hands the chat tab its id a beat later.
    addTerminal(2, tab(2, { projectId: 'p1', mode: 'chat', claudeSessionId: 'sess-a' }));
    expect(SessionRouter.resolve('sess-a', { projectId: 'p1' })).toBe(2);
  });
});

describe('HooksProvider event routing', () => {
  let emit;
  let seen;

  beforeEach(() => {
    clearAllTerminals();
    SessionRouter.reset();
    seen = [];
    emit = eventBus.on('*', (e) => seen.push(e));

    window.electron_api.hooks = {
      onEvent: (cb) => { window.__hookCb = cb; return () => {}; }
    };
    HooksProvider.start();
  });

  afterEach(() => {
    emit();
    HooksProvider.stop();
    delete window.__hookCb;
  });

  function fire(raw) {
    window.__hookCb(raw);
  }

  it('carries the session id through to consumers', () => {
    setProjects([{ id: 'p1', name: 'p1', path: '/w/api' }]);
    addTerminal(1, tab(1, { projectId: 'p1' }));

    fire({ hook: 'PreToolUse', stdin: { session_id: 'sess-a', tool_name: 'Bash' }, cwd: '/w/api' });

    const working = seen.find(e => e.type === EVENT_TYPES.CLAUDE_WORKING);
    expect(working).toBeDefined();
    expect(working.sessionId).toBe('sess-a');
    expect(working.projectId).toBe('p1');
  });

  it('matches on whole path segments, not on a shared prefix', () => {
    setProjects([
      { id: 'api', name: 'api', path: '/w/api' },
      { id: 'api-legacy', name: 'api-legacy', path: '/w/api-legacy' }
    ]);
    addTerminal(1, tab(1, { projectId: 'api' }));
    addTerminal(2, tab(2, { projectId: 'api-legacy' }));

    fire({ hook: 'PreToolUse', stdin: { session_id: 'sess-a', tool_name: 'Bash' }, cwd: '/w/api-legacy/src' });

    const working = seen.find(e => e.type === EVENT_TYPES.CLAUDE_WORKING);
    expect(working.projectId).toBe('api-legacy');
  });

  it('gives a nested project its own events instead of its parent\'s', () => {
    setProjects([
      { id: 'mono', name: 'mono', path: '/w/mono' },
      { id: 'pkg', name: 'pkg', path: '/w/mono/packages/ui' }
    ]);
    addTerminal(1, tab(1, { projectId: 'mono' }));
    addTerminal(2, tab(2, { projectId: 'pkg' }));

    fire({ hook: 'PreToolUse', stdin: { session_id: 'sess-a', tool_name: 'Read' }, cwd: '/w/mono/packages/ui' });

    const working = seen.find(e => e.type === EVENT_TYPES.CLAUDE_WORKING);
    expect(working.projectId).toBe('pkg');
  });
});
