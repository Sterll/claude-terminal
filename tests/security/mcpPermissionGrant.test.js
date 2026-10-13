/**
 * The MCP `chat_respond_permission` tool can deny a chat tab's pending
 * permission request, never grant it.
 *
 * It used to accept `allow` and `always-allow` too. The session calling it is
 * asked to approve "chat_respond_permission tabId=… action=allow", which says
 * nothing of the command it unlocks on the other tab, so one agent allowed to
 * use the MCP tools could approve another agent's Bash. `always-allow` on a
 * card without SDK suggestions went further and switched that tab to
 * `bypassPermissions`. Same rule as `skipPermissions` being read-only in
 * settings.js: nothing reached over MCP lifts a permission.
 *
 * Both halves are pinned. The tool refuses before writing a trigger, and the
 * renderer refuses again, because `tabs/triggers/` is a plain directory that
 * any local process (or an older server) can drop a file into.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('MCP chat_respond_permission tool', () => {
  let dataDir;
  let tabs;

  const triggerDir = () => path.join(dataDir, 'tabs', 'triggers');
  const triggers = () => (fs.existsSync(triggerDir()) ? fs.readdirSync(triggerDir()) : []);

  /** Plays the renderer: answers the first trigger the tool drops. */
  async function answerNextTrigger(payload) {
    for (let i = 0; i < 100; i++) {
      const [file] = triggers();
      if (file) {
        const trigger = JSON.parse(fs.readFileSync(path.join(triggerDir(), file), 'utf8'));
        const respDir = path.join(dataDir, 'tabs', 'responses');
        fs.mkdirSync(respDir, { recursive: true });
        fs.writeFileSync(path.join(respDir, `${trigger.requestId}.json`), JSON.stringify(payload));
        return trigger;
      }
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('the tool never wrote a trigger');
  }

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-mcp-perm-'));
    process.env.CT_DATA_DIR = dataDir;
    jest.resetModules();
    tabs = require('../../resources/mcp-servers/tools/tabs.js');
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('only advertises deny', () => {
    const tool = tabs.tools.find(t => t.name === 'chat_respond_permission');
    expect(tool.inputSchema.properties.action.enum).toEqual(['deny']);
    expect(tool.inputSchema.required).toEqual(['tabId']);
  });

  it.each(['allow', 'always-allow'])('refuses %s without writing a trigger', async (action) => {
    const res = await tabs.handle('chat_respond_permission', { tabId: 'tab-1', action });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/granted by the user/);
    expect(triggers()).toEqual([]);
  });

  it('forwards a deny with its message', async () => {
    const pending = tabs.handle('chat_respond_permission', { tabId: 'tab-1', action: 'deny', message: 'run the tests first' });
    const trigger = await answerNextTrigger({ ok: true });
    const res = await pending;

    expect(trigger).toMatchObject({ action: 'deny', tabId: 'tab-1', message: 'run the tests first' });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/denied/);
  });

  it('denies when no action is given', async () => {
    const pending = tabs.handle('chat_respond_permission', { tabId: 'tab-1' });
    const trigger = await answerNextTrigger({ ok: true });
    await pending;

    expect(trigger.action).toBe('deny');
  });
});

jest.mock('../../src/renderer/ui/components/Modal', () => ({
  showConfirm: () => Promise.resolve(false),
  showModal: () => {},
  showPrompt: () => Promise.resolve(null),
  closeModal: () => {},
}));

jest.mock('../../src/renderer/services/TerminalSessionService', () => ({
  saveTerminalSessions: jest.fn(),
  loadTerminalSessions: jest.fn(),
}));

describe('TerminalManager.respondPermissionForTab', () => {
  let manager, state, card, clicked;

  /** A chat tab waiting on a permission card, as ChatView renders it. */
  function seedPendingPermission() {
    const element = document.createElement('div');
    element.innerHTML = `
      <div class="chat-perm-card" data-request-id="req-1">
        <button class="chat-perm-btn" data-action="allow"></button>
        <button class="chat-perm-btn always-allow" data-action="always-allow"></button>
        <button class="chat-perm-btn" data-action="deny"></button>
        <input class="chat-perm-feedback-input">
      </div>`;
    document.body.appendChild(element);
    card = element.querySelector('.chat-perm-card');
    clicked = [];
    card.querySelectorAll('button').forEach(b => b.addEventListener('click', () => clicked.push(b.dataset.action)));

    state.addTerminal('t1', {
      tabId: 'tab-1',
      name: 'Chat',
      project: { id: 'p1', name: 'Test', path: '/tmp/test' },
      projectIndex: 0,
      mode: 'chat',
      status: 'ready',
      element,
      pendingPermission: { requestId: 'req-1' },
    });
  }

  beforeEach(() => {
    jest.resetModules();
    window.electron_api = new Proxy({}, {
      get: () => new Proxy({}, { get: () => () => Promise.resolve({ success: true }) }),
    });
    document.body.innerHTML = `
      <div id="terminals-tabs"></div>
      <div id="terminals-container"></div>
      <div id="empty-terminals"></div>
      <div id="terminals-filter"><span id="filter-project-name"></span></div>
    `;
    state = require('../../src/renderer/state/terminals.state');
    const { TerminalManager } = require('../../src/renderer/ui/components/TerminalManager');
    manager = new TerminalManager();
    seedPendingPermission();
  });

  afterEach(() => {
    try { state.clearAllTerminals(() => {}); } catch (_) { /* best effort */ }
  });

  it.each(['allow', 'always-allow'])('refuses %s and clicks nothing', (action) => {
    const res = manager.respondPermissionForTab('tab-1', { action });

    expect(res.ok).toBe(false);
    expect(clicked).toEqual([]);
  });

  it('denies, carrying the feedback message', () => {
    const res = manager.respondPermissionForTab('tab-1', { action: 'deny', message: 'not on main' });

    expect(res).toMatchObject({ ok: true, requestId: 'req-1', action: 'deny' });
    expect(clicked).toEqual(['deny', 'deny']);
    expect(card.querySelector('.chat-perm-feedback-input').value).toBe('not on main');
  });

  it('denies when no action is given', () => {
    const res = manager.respondPermissionForTab('tab-1', {});

    expect(res.ok).toBe(true);
    expect(clicked).toEqual(['deny']);
  });
});
