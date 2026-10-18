/**
 * The MCP `chat_respond_permission` tool denies a chat tab's pending
 * permission request, and grants one only when the user turned on
 * `mcpPermissionGrantsEnabled` in the settings.
 *
 * It used to grant unconditionally. The session calling it is asked to approve
 * "chat_respond_permission tabId=… action=allow", which says nothing of the
 * command or plan it unlocks on the other tab, so one agent allowed to use the
 * MCP tools could approve another agent's Bash. Granting is now opt-in, for
 * those who want one agent to drive the others from start to finish.
 *
 * Three things are pinned:
 *  - the tool refuses a grant before writing a trigger unless the setting is on;
 *  - the renderer refuses it again, because `tabs/triggers/` is a plain
 *    directory any local process (or an older server) can drop a file into;
 *  - `settings_set` cannot turn the setting on, or an agent would only have to
 *    flip it first. Same treatment as `skipPermissions`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('MCP chat_respond_permission tool', () => {
  let dataDir;
  let tabs;

  const triggerDir = () => path.join(dataDir, 'tabs', 'triggers');
  const triggers = () => (fs.existsSync(triggerDir()) ? fs.readdirSync(triggerDir()) : []);
  const writeSettings = (settings) =>
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings), 'utf8');

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

  it('defaults the action to deny', () => {
    const tool = tabs.tools.find(t => t.name === 'chat_respond_permission');
    expect(tool.inputSchema.properties.action.enum).toEqual(['deny', 'allow', 'always-allow']);
    expect(tool.inputSchema.required).toEqual(['tabId']);
  });

  describe('with the setting off', () => {
    it.each([
      ['absent', null],
      ['false', { mcpPermissionGrantsEnabled: false }],
      ['truthy but not true', { mcpPermissionGrantsEnabled: 'yes' }],
    ])('refuses allow and always-allow without writing a trigger (setting %s)', async (_label, settings) => {
      if (settings) writeSettings(settings);

      for (const action of ['allow', 'always-allow']) {
        const res = await tabs.handle('chat_respond_permission', { tabId: 'tab-1', action });
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toMatch(/turned off/);
      }
      expect(triggers()).toEqual([]);
    });

    it('still forwards a deny with its message', async () => {
      const pending = tabs.handle('chat_respond_permission', { tabId: 'tab-1', action: 'deny', message: 'run the tests first' });
      const trigger = await answerNextTrigger({ ok: true });
      const res = await pending;

      expect(trigger).toMatchObject({ action: 'deny', tabId: 'tab-1', message: 'run the tests first' });
      expect(res.isError).toBeFalsy();
    });

    it('denies when no action is given', async () => {
      const pending = tabs.handle('chat_respond_permission', { tabId: 'tab-1' });
      const trigger = await answerNextTrigger({ ok: true });
      await pending;

      expect(trigger.action).toBe('deny');
    });
  });

  describe('with the setting on', () => {
    beforeEach(() => writeSettings({ mcpPermissionGrantsEnabled: true }));

    it.each(['allow', 'always-allow'])('forwards %s', async (action) => {
      const pending = tabs.handle('chat_respond_permission', { tabId: 'tab-1', action });
      const trigger = await answerNextTrigger({ ok: true });
      const res = await pending;

      expect(trigger).toMatchObject({ action, tabId: 'tab-1' });
      expect(res.isError).toBeFalsy();
    });
  });

  it('rejects an unknown action', async () => {
    writeSettings({ mcpPermissionGrantsEnabled: true });
    const res = await tabs.handle('chat_respond_permission', { tabId: 'tab-1', action: 'approve' });

    expect(res.isError).toBe(true);
    expect(triggers()).toEqual([]);
  });

  it('cannot be turned on through settings_set', async () => {
    writeSettings({ mcpPermissionGrantsEnabled: false });
    const settingsTool = require('../../resources/mcp-servers/tools/settings.js');

    const res = await settingsTool.handle('settings_set', { key: 'mcpPermissionGrantsEnabled', value: true });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/read-only/);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    expect(onDisk.mcpPermissionGrantsEnabled).toBe(false);
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
  let manager, state, settings, card, clicked;

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
    settings = require('../../src/renderer/state/settings.state').settingsState;
    const { TerminalManager } = require('../../src/renderer/ui/components/TerminalManager');
    manager = new TerminalManager();
    seedPendingPermission();
  });

  afterEach(() => {
    try { state.clearAllTerminals(() => {}); } catch (_) { /* best effort */ }
  });

  describe('with the setting off (the default)', () => {
    it.each(['allow', 'always-allow'])('refuses %s and clicks nothing', (action) => {
      expect(settings.get().mcpPermissionGrantsEnabled).toBe(false);

      const res = manager.respondPermissionForTab('tab-1', { action });

      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/turned off/);
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

  describe('with the setting on', () => {
    beforeEach(() => settings.setProp('mcpPermissionGrantsEnabled', true));

    it.each(['allow', 'always-allow'])('clicks %s', (action) => {
      const res = manager.respondPermissionForTab('tab-1', { action });

      expect(res).toMatchObject({ ok: true, requestId: 'req-1', action });
      expect(clicked).toEqual([action]);
    });

    it('still denies', () => {
      const res = manager.respondPermissionForTab('tab-1', { action: 'deny' });

      expect(res.ok).toBe(true);
      expect(clicked).toEqual(['deny']);
    });
  });

  it('rejects an unknown action whatever the setting', () => {
    settings.setProp('mcpPermissionGrantsEnabled', true);

    const res = manager.respondPermissionForTab('tab-1', { action: 'approve' });

    expect(res.ok).toBe(false);
    expect(clicked).toEqual([]);
  });
});

/**
 * The same grant by another route: the CLI's approval dialog in a terminal tab
 * answers Enter with its first entry, "Yes", so `tab_send` (and the legacy
 * `terminal_send_command`) typing into that tab approves it. They refuse while
 * the dialog is on screen, unless the user opted in to agent grants.
 */
describe('typing into a terminal tab that shows an approval dialog', () => {
  let manager, state, settings, inputs, screen;

  const DIALOG = [
    '╭──────────────────────────────────────╮',
    '│ Bash command                         │',
    '│   rm -rf build                       │',
    '│ Do you want to proceed?              │',
    '│ ❯ 1. Yes                             │',
    '│   2. Yes, and don\'t ask again        │',
    '│   3. No, and tell Claude what to do  │',
    '╰──────────────────────────────────────╯',
  ];
  const PROMPT = ['╭──────────────╮', '│ >            │', '╰──────────────╯', '  ? for shortcuts'];

  const fakeTerminal = () => ({
    rows: 24,
    buffer: { active: { baseY: 0, viewportY: 0, cursorY: 0, getLine: (i) => (i < screen.length ? { translateToString: () => screen[i] } : undefined) } },
  });

  beforeEach(() => {
    jest.resetModules();
    inputs = [];
    window.electron_api = new Proxy({}, {
      get: (_t, ns) => new Proxy({}, {
        get: (_u, method) => (...args) => {
          if (ns === 'terminal' && method === 'input') inputs.push(args[0]);
          return Promise.resolve({ success: true });
        },
      }),
    });
    document.body.innerHTML = `
      <div id="terminals-tabs"></div>
      <div id="terminals-container"></div>
      <div id="empty-terminals"></div>
      <div id="terminals-filter"><span id="filter-project-name"></span></div>
    `;
    state = require('../../src/renderer/state/terminals.state');
    settings = require('../../src/renderer/state/settings.state').settingsState;
    const { TerminalManager } = require('../../src/renderer/ui/components/TerminalManager');
    manager = new TerminalManager();
    screen = DIALOG;
    state.addTerminal('t2', {
      tabId: 'tab-2',
      name: 'Claude',
      project: { id: 'p1', name: 'Test', path: '/tmp/test' },
      projectIndex: 0,
      mode: 'terminal',
      status: 'ready',
      terminal: fakeTerminal(),
    });
  });

  afterEach(() => {
    try { state.clearAllTerminals(() => {}); } catch (_) { /* best effort */ }
  });

  it('recognises the dialog, and only the dialog', () => {
    const { detectPermissionDialog } = require('../../src/renderer/ui/components/terminal/claudeSignals');
    expect(detectPermissionDialog(fakeTerminal())).toBe(true);
    screen = PROMPT;
    expect(detectPermissionDialog(fakeTerminal())).toBe(false);
    screen = ['Would you like to proceed?', '❯ 1. Yes, and auto-accept edits', '  2. No, keep planning'];
    expect(detectPermissionDialog(fakeTerminal())).toBe(true);
    expect(detectPermissionDialog(undefined)).toBe(false);
  });

  it.each(['', '1', 'yes'])('refuses to type %p while the dialog is on screen', (content) => {
    const res = manager.sendToTab('tab-2', content);

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/permission prompt/);
    expect(inputs).toEqual([]);
  });

  it('types as before once the dialog is gone', () => {
    screen = PROMPT;
    const res = manager.sendToTab('tab-2', 'npm test');

    expect(res.ok).toBe(true);
    expect(inputs).toEqual([{ id: 't2', data: 'npm test\r' }]);
  });

  it('types into the dialog when the user opted in to agent grants', () => {
    settings.setProp('mcpPermissionGrantsEnabled', true);
    const res = manager.sendToTab('tab-2', '1');

    expect(res.ok).toBe(true);
    expect(inputs).toHaveLength(1);
  });
});

describe('alwaysAllowBypassesSession over MCP', () => {
  let dataDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-mcp-bypass-'));
    process.env.CT_DATA_DIR = dataDir;
    jest.resetModules();
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('cannot be turned on through settings_set', async () => {
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ alwaysAllowBypassesSession: false }), 'utf8');
    const settingsTool = require('../../resources/mcp-servers/tools/settings.js');

    const res = await settingsTool.handle('settings_set', { key: 'alwaysAllowBypassesSession', value: true });

    expect(res.isError).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    expect(onDisk.alwaysAllowBypassesSession).toBe(false);
  });
});
