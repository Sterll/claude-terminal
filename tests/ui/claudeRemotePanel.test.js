/**
 * Connectivity → claude.ai — the list of shared conversations.
 *
 * Two things this screen has to get right, and both hang off the same lookup:
 * naming the conversation (its tab's name, not just its project), and getting
 * back to it. The link is the ChatService session id, which lives on the chat
 * view — `termData.claudeSessionId` is overwritten with the SDK's own session
 * UUID as soon as the first message lands, so a lookup that trusts it finds
 * nothing for any conversation old enough to be worth sharing.
 */

jest.mock('../../src/renderer/ui/components/TerminalManager', () => ({
  setActiveTerminal: jest.fn(),
  filterByProject: jest.fn(),
}));

const TerminalManager = require('../../src/renderer/ui/components/TerminalManager');
const { clearAllTerminals, addTerminal } = require('../../src/renderer/state/terminals.state');
const panel = require('../../src/renderer/ui/panels/ClaudeRemotePanel');

/** One shared session, as RemoteControlService.listSessions() reports it. */
function session(overrides = {}) {
  return {
    sessionId: 'chat-9',
    ccrSessionId: 'cse_abc',
    cwd: '/repo/background-agents',
    projectId: null,
    branch: 'feat/invocation-only',
    state: 'running',
    startedAt: Date.now(),
    ...overrides,
  };
}

function makeApi(sessions) {
  return {
    remoteControl: {
      listSessions: jest.fn(async () => ({ success: true, sessions })),
      getStatus: jest.fn(async () => ({ success: true, status: { supported: true, enabled: true } })),
      disableSession: jest.fn(async () => ({ success: true })),
      onSessionStatus: jest.fn(() => () => {}),
    },
    dialog: { openExternal: jest.fn() },
  };
}

/** Mount the screen and let its first refresh settle. */
async function mount(api) {
  document.body.innerHTML = panel.buildHtml();
  panel.setupHandlers({ api });
  await new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * A live chat tab, the way TerminalManager holds one: the ChatService session
 * id reachable only through the chat view, `claudeSessionId` already replaced
 * by the SDK's own UUID.
 */
function openChatTab({ id = 'chat-tab-1', name = 'Fix remote control', sessionId = 'chat-9' } = {}) {
  addTerminal(id, {
    name,
    mode: 'chat',
    claudeSessionId: 'b6f0c2e4-1111-2222-3333-444455556666',
    chatView: { getSessionId: () => sessionId },
    project: { name: 'background-agents' },
  });
}

beforeEach(() => {
  clearAllTerminals();
  jest.clearAllMocks();
});

afterEach(async () => {
  // goToTab re-asserts the activation on the next frame; let that land here
  // rather than in the next test's assertions.
  await new Promise(resolve => setTimeout(resolve, 0));
  panel.cleanup();
  document.body.innerHTML = '';
});

describe('shared sessions list', () => {
  test('names the row after the tab, not just its project', async () => {
    openChatTab();
    await mount(makeApi([session()]));

    expect(document.querySelector('.crp-row-title').textContent).toBe('Fix remote control');
    // The project keeps its place, one line down, alongside branch and age.
    const meta = document.querySelector('.crp-row-meta').textContent;
    expect(meta).toContain('background-agents');
    expect(meta).toContain('feat/invocation-only');
  });

  test('falls back to the project when the tab has no name of its own', async () => {
    openChatTab({ name: '' });
    await mount(makeApi([session()]));

    expect(document.querySelector('.crp-row-title').textContent).toBe('background-agents');
    // ...and does not then repeat it on the meta line.
    expect(document.querySelector('.crp-row-meta').textContent).not.toContain('background-agents');
  });
});

describe('go to tab', () => {
  test('activates the tab that owns the session', async () => {
    openChatTab();
    await mount(makeApi([session()]));

    document.querySelector('[data-action="goto"]').click();
    expect(TerminalManager.setActiveTerminal).toHaveBeenCalledWith('chat-tab-1');
  });

  test('still finds a tab whose session id has not been overwritten yet', async () => {
    addTerminal('chat-tab-2', { name: 'Just started', mode: 'chat', claudeSessionId: 'chat-9' });
    await mount(makeApi([session()]));

    document.querySelector('[data-action="goto"]').click();
    expect(TerminalManager.setActiveTerminal).toHaveBeenCalledWith('chat-tab-2');
  });

  test('offers nothing to click when the tab is gone', async () => {
    await mount(makeApi([session()]));

    const btn = document.querySelector('[data-action="goto"]');
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(TerminalManager.setActiveTerminal).not.toHaveBeenCalled();
  });
});
