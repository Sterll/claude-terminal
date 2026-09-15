/**
 * A permission notification must mean the user actually has a decision to make.
 *
 * The PermissionRequest hook is an extension point, not the prompt: the CLI fires
 * it on every permission decision, including the ones a mode like bypassPermissions
 * has already answered. Notifying on those put an Allow/Deny toast on screen while
 * the conversation carried on behind it, with two buttons that changed nothing.
 *
 * Each case runs in its own project because the consumer dedups notifications per
 * project over a 5s window — sharing one project would make later cases pass for
 * the wrong reason.
 */

const HooksProvider = require('../../src/renderer/events/HooksProvider');
const { addTerminal, clearAllTerminals } = require('../../src/renderer/state/terminals.state');
const { projectsState } = require('../../src/renderer/state/projects.state');
const { settingsState } = require('../../src/renderer/state/settings.state');
const SessionRouter = require('../../src/renderer/events/SessionRouter');
const events = require('../../src/renderer/events');

const CASES = ['asks', 'bypass', 'dontask', 'edits', 'dedup'];

describe('PermissionRequest notification', () => {
  let shown;
  let resolved;

  beforeAll(() => {
    clearAllTerminals();
    SessionRouter.reset();
    settingsState.set({ ...settingsState.get(), hooksEnabled: true });

    projectsState.set({
      ...projectsState.get(),
      projects: CASES.map(id => ({ id, name: id, path: `/w/${id}` }))
    });
    CASES.forEach((id, i) => {
      addTerminal(i + 1, {
        id: i + 1,
        tabId: `tab_${i + 1}`,
        project: { id, name: id, path: `/w/${id}` },
        mode: 'terminal',
        isBasic: false,
        status: 'ready',
        claudeSessionId: `sess-${id}`
      });
    });

    window.electron_api.hooks = {
      onEvent: (cb) => { window.__hookCb = cb; return () => {}; },
      resolvePermission: (id, decision) => { resolved.push({ id, decision }); }
    };

    events.setNotificationFn((type, title, body) => {
      shown.push({ type, title, body });
      return true;
    });
    // Wired once: initClaudeEvents has no matching teardown, so calling it per
    // test would stack consumers and multiply every notification.
    events.initClaudeEvents();
  });

  afterAll(() => {
    HooksProvider.stop();
    events.setNotificationFn(null);
    delete window.__hookCb;
    clearAllTerminals();
  });

  beforeEach(() => {
    shown = [];
    resolved = [];
  });

  function firePermission(project, permissionMode, tool = 'Edit') {
    window.__hookCb({
      hook: 'PermissionRequest',
      cwd: `/w/${project}`,
      stdin: {
        session_id: `sess-${project}`,
        tool_name: tool,
        tool_input: { file_path: `/w/${project}/a.js` },
        permission_mode: permissionMode,
        _requestId: `req-${project}-${tool}`
      }
    });
  }

  it('notifies when the mode really is going to ask', () => {
    firePermission('asks', 'default');

    expect(shown).toHaveLength(1);
    expect(shown[0].type).toBe('permission');
    expect(resolved).toHaveLength(0);
  });

  it('stays quiet in bypassPermissions — the CLI never prompts there', () => {
    firePermission('bypass', 'bypassPermissions');

    expect(shown).toHaveLength(0);
    // Answered at once so the hook handler is not held for its full 30s.
    expect(resolved).toEqual([{ id: 'req-bypass-Edit', decision: 'allow' }]);
  });

  it('stays quiet in dontAsk', () => {
    firePermission('dontask', 'dontAsk');

    expect(shown).toHaveLength(0);
    expect(resolved).toHaveLength(1);
  });

  it('in acceptEdits, skips edits but still notifies for anything else', () => {
    firePermission('edits', 'acceptEdits', 'Write');
    expect(shown).toHaveLength(0);

    firePermission('edits', 'acceptEdits', 'Bash');
    expect(shown).toHaveLength(1);
    expect(shown[0].body).toContain('Bash');
  });

  it('does not spend the project dedup slot on a bypassed request', () => {
    // A bypassed request must not shadow a genuine one arriving right behind it,
    // which is what happens if the mode check runs after shouldNotify().
    firePermission('dedup', 'bypassPermissions');
    firePermission('dedup', 'default', 'Bash');

    expect(shown).toHaveLength(1);
  });
});
