/**
 * Tabs an agent drives over MCP stay in the background.
 *
 * terminal_create, tab_send, tab_close and chat_respond_permission reach
 * TerminalManager through the `tabs/triggers` pipeline (renderer.js). They used
 * the paths a click uses, so an agent opening a tab moved the user onto it,
 * closing a tab in another project switched the project on screen, and each of
 * them could leave the keyboard focus somewhere other than the field the user
 * was typing in.
 *
 * Every case starts with the user in their own chat tab, shown project p1,
 * caret in the middle of what they typed, and checks afterwards that the
 * active tab, the shown project, `document.activeElement` and the caret are
 * exactly where they were. The click path (no `background`) is pinned too,
 * since it must keep switching to the tab it opens.
 */

// xterm stand-in whose focus() behaves like the real one: it focuses the
// helper textarea xterm mounts in its container.
jest.mock('@xterm/xterm', () => ({
  Terminal: class FakeTerminal {
    constructor(options) {
      this.options = { ...options };
      this.cols = 80;
      this.rows = 24;
      this.buffer = { active: { length: 0 } };
      this.parser = { registerOscHandler: () => ({ dispose() {} }) };
      return new Proxy(this, {
        get(target, key) {
          if (key in target || typeof key !== 'string' || key === 'then') return target[key];
          return () => ({ dispose() {} });
        },
      });
    }
    open(el) {
      this.textarea = el.ownerDocument.createElement('textarea');
      this.textarea.className = 'xterm-helper-textarea';
      el.appendChild(this.textarea);
    }
    loadAddon() {}
    focus() { this.textarea?.focus(); }
    blur() { this.textarea?.blur(); }
    dispose() {}
  },
}));
jest.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
jest.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
jest.mock('../../src/renderer/services/xtermLoader', () => ({
  loadXterm: async () => ({
    Terminal: require('@xterm/xterm').Terminal,
    FitAddon: require('@xterm/addon-fit').FitAddon,
  }),
  attachWebglAddon: () => {},
  clearGlyphAtlas: () => {},
}));

// The chat view is ChatView's business (tests/ui/chatBackgroundSend.test.js);
// here it only has to own a composer that focus() really focuses.
const mockChatViews = [];
jest.mock('../../src/renderer/ui/components/ChatView', () => ({
  createChatView: (wrapper, project, options) => {
    const composer = wrapper.ownerDocument.createElement('div');
    composer.className = 'chat-input';
    composer.setAttribute('contenteditable', 'true');
    wrapper.appendChild(composer);
    const view = {
      options,
      composer,
      sent: [],
      focus: () => composer.focus(),
      sendMessage: (...args) => { view.sent.push(args); },
      destroy: () => {},
    };
    mockChatViews.push(view);
    return view;
  },
}));

let TerminalManager;
let terminalsState, addTerminal, getActiveTerminal, setActiveTerminal, getTerminal;
let projectsState;
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
  };
  ({ TerminalManager } = require('../../src/renderer/ui/components/TerminalManager'));
  ({ terminalsState, addTerminal, getActiveTerminal, setActiveTerminal, getTerminal } = require('../../src/renderer/state/terminals.state'));
  ({ projectsState } = require('../../src/renderer/state/projects.state'));
  ({ settingsState } = require('../../src/renderer/state/settings.state'));
});

const p1 = { id: 'p1', name: 'Shown', path: '/p1', type: 'general' };
const p2 = { id: 'p2', name: 'Other', path: '/p2', type: 'general' };

let tm, userComposer;

/** A tab as the user has it: in the bar, its wrapper mounted, a composer inside. */
function seedTab(id, project, { tabId = `tab-${id}`, active = false } = {}) {
  const tab = document.createElement('div');
  tab.className = 'terminal-tab';
  tab.dataset.id = id;
  tab.innerHTML = '<span class="tab-name"></span>';
  document.getElementById('terminals-tabs').appendChild(tab);
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper chat-wrapper';
  wrapper.dataset.id = id;
  document.getElementById('terminals-container').appendChild(wrapper);
  const composer = document.createElement('div');
  composer.className = 'chat-input';
  composer.setAttribute('contenteditable', 'true');
  composer.textContent = 'hello world';
  wrapper.appendChild(composer);
  addTerminal(id, {
    project, projectIndex: project === p1 ? 0 : 1, name: project.name, mode: 'chat', status: 'ready',
    tabId, chatView: { focus: () => composer.focus(), sendMessage: jest.fn(), destroy: () => {} },
  }, { activate: false });
  if (active) {
    setActiveTerminal(id);
    tab.classList.add('active');
    wrapper.classList.add('active');
  }
  return { tab, wrapper, composer };
}

/** Focus in the user's composer, caret after "hel". */
function userTypesIn(el) {
  el.focus();
  const range = document.createRange();
  range.setStart(el.firstChild, 3);
  range.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
}

function expectUserUndisturbed() {
  expect(getActiveTerminal()).toBe('user-tab');
  expect(projectsState.get().selectedProjectFilter).toBe(0);
  expect(document.activeElement).toBe(userComposer);
  const sel = window.getSelection();
  expect(sel.anchorNode).toBe(userComposer.firstChild);
  expect(sel.anchorOffset).toBe(3);
  expect(sel.isCollapsed).toBe(true);
}

const newTabEl = (knownIds) =>
  Array.from(document.querySelectorAll('.terminal-tab')).find(t => !knownIds.includes(t.dataset.id));

beforeEach(() => {
  mockChatViews.length = 0;
  terminalsState.set({ ...terminalsState.get(), terminals: new Map(), activeTerminal: null });
  projectsState.set({ projects: [{ ...p1 }, { ...p2 }], folders: [], rootOrder: ['p1', 'p2'], selectedProjectFilter: 0 });
  settingsState.setProp('defaultTerminalMode', 'terminal');
  // The ids filterByProject and the tab code address directly.
  document.body.innerHTML = `
    <div id="terminals-filter"><span id="filter-project-name"></span></div>
    <div id="terminals-tabs"></div>
    <div id="terminals-container"></div>
    <div id="empty-terminals"></div>`;
  tm = new TerminalManager();
  tm.setCallbacks({ onRenderProjects: jest.fn() });
  // The sessions panel an empty project draws is not under test.
  tm._renderSessionsPanel = () => {};
  ({ composer: userComposer } = seedTab('user-tab', p1, { active: true }));
  userTypesIn(userComposer);
});

describe('terminal_create', () => {
  it.each(['chat', 'terminal'])('opens a %s tab of the shown project in the background', async (mode) => {
    await tm.createTerminal(p1, { mode, runClaude: true, background: true });

    expectUserUndisturbed();
    const tab = newTabEl(['user-tab']);
    expect(tab).toBeTruthy();
    // In the bar, where its status dot can be seen, but not the one on screen.
    expect(tab.style.display).not.toBe('none');
    expect(tab.classList.contains('active')).toBe(false);
    if (mode === 'chat') expect(mockChatViews[0].options.background).toBe(true);
  });

  it.each(['chat', 'terminal'])('opens a %s tab of another project without switching project', async (mode) => {
    await tm.createTerminal(p2, { mode, runClaude: true, background: true });

    expectUserUndisturbed();
    expect(newTabEl(['user-tab']).style.display).toBe('none');
  });

  it('keeps the caret where it is when the shown project had no tab yet', async () => {
    // The user is typing in a field of the project view, with no tab open.
    tm.closeTerminal('user-tab');
    projectsState.setProp('selectedProjectFilter', 0);
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.value = 'search';
    field.focus();
    field.setSelectionRange(2, 2);

    await tm.createTerminal(p1, { mode: 'chat', runClaude: true, background: true });

    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(2);
  });

  it.each(['chat', 'terminal'])('still switches to a %s tab the user opened', async (mode) => {
    await tm.createTerminal(p1, { mode, runClaude: true });

    const tab = newTabEl(['user-tab']);
    expect(String(getActiveTerminal())).toBe(tab.dataset.id);
    expect(document.querySelector(`.terminal-wrapper[data-id="${tab.dataset.id}"]`).contains(document.activeElement)).toBe(true);
  });
});

describe('tab_send', () => {
  it('hands a chat tab the message as a background send', () => {
    seedTab('agent-tab', p1, { tabId: 'agent' });

    const result = tm.sendToTab('agent', 'analyse auth/', { background: true });

    expect(result).toMatchObject({ ok: true, mode: 'chat' });
    expect(getTerminal('agent-tab').chatView.sendMessage).toHaveBeenCalledWith('analyse auth/', [], [], { background: true });
    expectUserUndisturbed();
  });
});

describe('tab_close', () => {
  it('closes the last tab of another project without switching to that project', () => {
    seedTab('agent-tab', p2, { tabId: 'agent' });

    expect(tm.closeTabByTabId('agent', { background: true })).toEqual({ ok: true, tabId: 'agent' });

    expect(getTerminal('agent-tab')).toBeUndefined();
    expectUserUndisturbed();
  });

  it('closes another tab of the shown project without touching the active one', () => {
    seedTab('agent-tab', p1, { tabId: 'agent' });

    tm.closeTabByTabId('agent', { background: true });

    expect(document.querySelector('.terminal-tab[data-id="agent-tab"]')).toBeNull();
    expectUserUndisturbed();
  });
});

describe('chat_respond_permission', () => {
  it('denies with a message without leaving focus in the feedback field', () => {
    const { wrapper } = seedTab('agent-tab', p1, { tabId: 'agent' });
    getTerminal('agent-tab').pendingPermission = { requestId: 'perm-1' };
    // The card ChatView draws: the first deny click opens and focuses the
    // feedback field, the second sends.
    const card = document.createElement('div');
    card.className = 'chat-perm-card';
    card.dataset.requestId = 'perm-1';
    card.innerHTML = `
      <button class="chat-perm-btn" data-action="deny"></button>
      <div class="chat-perm-feedback" style="display:none"><input class="chat-perm-feedback-input"></div>`;
    wrapper.appendChild(card);
    let sent = null;
    card.querySelector('.chat-perm-btn').addEventListener('click', () => {
      const row = card.querySelector('.chat-perm-feedback');
      if (row.style.display === 'none') {
        row.style.display = '';
        row.querySelector('input').focus();
      } else {
        sent = row.querySelector('input').value;
      }
    });

    const result = tm.respondPermissionForTab('agent', { action: 'deny', message: 'not that file' });

    expect(result).toMatchObject({ ok: true, action: 'deny' });
    expect(sent).toBe('not that file');
    expectUserUndisturbed();
  });
});
