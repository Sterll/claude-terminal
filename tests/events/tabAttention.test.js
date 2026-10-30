/**
 * A terminal-mode tab waiting on the user, read off the hooks.
 *
 * The CLI in a PTY announces nothing structured, so with hooks on they are the
 * only thing that knows a prompt is on screen: an approval the permission mode
 * does not settle itself, or a tool whose call is a question (AskUserQuestion,
 * ExitPlanMode). Whatever the session does next means the user answered.
 *
 * Routing is by session id, like the tab status: an event no tab owns flags
 * nothing.
 */

const mockSetAttention = jest.fn();
jest.mock('../../src/renderer/ui/components/TerminalManager', () => ({
  updateTerminalStatus: jest.fn(),
  setTerminalAttention: (...args) => mockSetAttention(...args),
}));

const HooksProvider = require('../../src/renderer/events/HooksProvider');
const { addTerminal, clearAllTerminals } = require('../../src/renderer/state/terminals.state');
const { projectsState } = require('../../src/renderer/state/projects.state');
const { settingsState } = require('../../src/renderer/state/settings.state');
const SessionRouter = require('../../src/renderer/events/SessionRouter');
const events = require('../../src/renderer/events');

describe('terminal tab attention from hooks', () => {
  beforeAll(() => {
    clearAllTerminals();
    SessionRouter.reset();
    settingsState.set({ ...settingsState.get(), hooksEnabled: true });
    projectsState.set({ ...projectsState.get(), projects: [{ id: 'p1', name: 'p1', path: '/w/p1' }] });
    addTerminal(1, {
      id: 1,
      tabId: 'tab_1',
      project: { id: 'p1', name: 'p1', path: '/w/p1' },
      mode: 'terminal',
      isBasic: false,
      status: 'ready',
      claudeSessionId: 'sess-1'
    });

    window.electron_api.hooks = {
      onEvent: (cb) => { window.__hookCb = cb; return () => {}; },
      resolvePermission: () => {}
    };
    events.setNotificationFn(() => true);
    events.initClaudeEvents();
  });

  afterAll(() => {
    HooksProvider.stop();
    events.setNotificationFn(null);
    delete window.__hookCb;
    clearAllTerminals();
  });

  beforeEach(() => mockSetAttention.mockClear());

  const fire = (hook, stdin, session = 'sess-1') =>
    window.__hookCb({ hook, cwd: '/w/p1', stdin: { session_id: session, ...stdin } });
  const lastFlag = () => mockSetAttention.mock.calls.at(-1);

  it('flags the tab on an approval the mode leaves to the user', () => {
    fire('PreToolUse', { tool_name: 'Bash' });
    fire('PermissionRequest', { tool_name: 'Bash', permission_mode: 'default', _requestId: 'r1' });

    expect(lastFlag()).toEqual([1, 'input']);
  });

  it('clears it once the approved tool has run', () => {
    fire('PermissionRequest', { tool_name: 'Bash', permission_mode: 'default', _requestId: 'r2' });
    fire('PostToolUse', { tool_name: 'Bash' });

    expect(lastFlag()).toEqual([1, null]);
  });

  it('does not flag a request the mode answers itself', () => {
    fire('PermissionRequest', { tool_name: 'Edit', permission_mode: 'acceptEdits', _requestId: 'r3' });

    expect(mockSetAttention).not.toHaveBeenCalledWith(1, 'input');
  });

  it('flags a question, and keeps it through the working status of that same call', () => {
    fire('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } });

    expect(lastFlag()).toEqual([1, 'input']);
  });

  it('clears it when the session moves on to another tool, or the turn ends', () => {
    fire('PreToolUse', { tool_name: 'ExitPlanMode' });
    fire('PreToolUse', { tool_name: 'Read' });
    expect(lastFlag()).toEqual([1, null]);

    fire('PermissionRequest', { tool_name: 'Bash', permission_mode: 'default', _requestId: 'r4' });
    fire('Stop', {});
    expect(lastFlag()).toEqual([1, null]);
  });

  it('clears it when the user types a new prompt', () => {
    fire('PermissionRequest', { tool_name: 'Bash', permission_mode: 'default', _requestId: 'r5' });
    fire('UserPromptSubmit', { prompt: 'never mind' });

    expect(lastFlag()).toEqual([1, null]);
  });

  it('flags nothing for a session no tab owns', () => {
    fire('PermissionRequest', { tool_name: 'Bash', permission_mode: 'default', _requestId: 'r6' }, 'sess-elsewhere');

    expect(mockSetAttention).not.toHaveBeenCalled();
  });
});
