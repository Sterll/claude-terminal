/**
 * Characterization — TerminalManager's tab lifecycle.
 *
 * 4,800 lines with no dedicated test of its own until now. CLAUDE.md says this
 * file "should be split"; this is the net that has to exist first.
 *
 * The centrepiece is the custom-name lock. A tab gets renamed from four
 * different directions — the AI namer, an OSC title from the PTY, a slash
 * command hook, and the user typing one — and only the last of those is
 * allowed to win. The regression it guards against is documented in the
 * method's own comment, and its failure mode is a user's chosen tab name
 * quietly reverting a few seconds later, which no other test would notice.
 *
 * The lock exists at two levels and both are pinned: in `updateTerminalTabName`
 * (an auto rename returns early on a locked tab) and again in
 * `_setSessionCustomName` (an auto rename never clobbers a custom entry in the
 * persisted names file). Either one alone would leave a hole.
 *
 * No xterm instance is constructed for the terminal-mode tabs: those tests seed
 * the terminals state directly, which is the same shape `createTerminal` leaves
 * behind and keeps the suite off a canvas jsdom does not have.
 */

const confirmAnswers = [];
const confirmCalls = [];
jest.mock('../../src/renderer/ui/components/Modal', () => ({
  showConfirm: (opts) => {
    confirmCalls.push(opts);
    return Promise.resolve(confirmAnswers.length ? confirmAnswers.shift() : false);
  },
  showModal: () => {},
  showPrompt: () => Promise.resolve(null),
  closeModal: () => {},
}));

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
  value: { ...(global.crypto || {}), randomUUID: () => `tm-uuid-${++uuidSeq}` },
  configurable: true,
});

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};

describe('TerminalManager tabs (characterization)', () => {
  let listeners, calls, manager, state, tabsContainer;

  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

  /**
   * A tab as `createTerminal` leaves it: an entry in the terminals state plus
   * the two DOM nodes every lookup in this file addresses by `data-id`.
   */
  const seedTab = (id, data = {}) => {
    state.addTerminal(id, {
      name: data.name || 'Tab',
      project: { id: 'p1', name: 'Test', path: '/tmp/test' },
      projectIndex: 0,
      mode: 'terminal',
      status: 'ready',
      ...data,
    });
    const tab = document.createElement('div');
    tab.className = 'terminal-tab';
    tab.dataset.id = id;
    tab.innerHTML = '<span class="tab-name"></span><span class="tab-close"></span>';
    tab.querySelector('.tab-name').textContent = data.name || 'Tab';
    tabsContainer.appendChild(tab);

    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper';
    wrapper.dataset.id = id;
    document.getElementById('terminals-container').appendChild(wrapper);
    return tab;
  };

  const tabNameOf = (id) =>
    document.querySelector(`.terminal-tab[data-id="${id}"] .tab-name`)?.textContent;
  const tabIdsInOrder = () =>
    Array.from(tabsContainer.querySelectorAll('.terminal-tab')).map(t => t.dataset.id);

  beforeEach(() => {
    jest.resetModules();
    listeners = {};
    calls = [];
    confirmAnswers.length = 0;
    confirmCalls.length = 0;
    window.electron_api = makeApiMock(listeners, calls);

    // The ids TerminalManager addresses directly. closeTerminal() re-runs the
    // project filter on its way out, and that reads the last three.
    document.body.innerHTML = `
      <div id="terminals-tabs"></div>
      <div id="terminals-container"></div>
      <div id="empty-terminals"></div>
      <div id="terminals-filter"><span id="filter-project-name"></span></div>
    `;
    tabsContainer = document.getElementById('terminals-tabs');

    state = require('../../src/renderer/state/terminals.state');
    const { TerminalManager } = require('../../src/renderer/ui/components/TerminalManager');
    manager = new TerminalManager();
  });

  afterEach(() => {
    try { state.clearAllTerminals(() => {}); } catch (_) { /* teardown is best effort */ }
  });

  // ── The custom-name lock ──

  describe('custom tab names', () => {
    it('lets an auto rename through on a tab the user has not named', async () => {
      seedTab('t1', { name: 'Test' });

      await manager.updateTerminalTabName('t1', 'Refactoring the parser');

      expect(state.getTerminal('t1').name).toBe('Refactoring the parser');
      expect(tabNameOf('t1')).toBe('Refactoring the parser');
      // The lock is not taken by an auto rename.
      expect(state.getTerminal('t1').nameCustom).toBeFalsy();
    });

    it('locks the tab when the user renames it', async () => {
      seedTab('t1', { name: 'Test' });

      await manager.updateTerminalTabName('t1', 'My tab', { custom: true });

      expect(state.getTerminal('t1').name).toBe('My tab');
      expect(state.getTerminal('t1').nameCustom).toBe(true);
    });

    it('refuses every later auto rename on a locked tab', async () => {
      // The documented regression: the AI namer, an OSC title and a slash
      // command all arrive later and all used to win.
      seedTab('t1', { name: 'Test' });
      await manager.updateTerminalTabName('t1', 'My tab', { custom: true });

      await manager.updateTerminalTabName('t1', 'Auto name from the CLI');
      await manager.updateTerminalTabName('t1', 'A pty title');

      expect(state.getTerminal('t1').name).toBe('My tab');
      expect(tabNameOf('t1')).toBe('My tab');
    });

    it('still lets the user rename a locked tab again', async () => {
      seedTab('t1', { name: 'Test' });
      await manager.updateTerminalTabName('t1', 'First choice', { custom: true });

      await manager.updateTerminalTabName('t1', 'Second choice', { custom: true });

      expect(state.getTerminal('t1').name).toBe('Second choice');
      expect(state.getTerminal('t1').nameCustom).toBe(true);
    });

    it('lets a custom rename to the same name through, so it can take the lock', async () => {
      // A tab auto-named "Parser" that the user then explicitly renames to
      // "Parser" is asking for the lock, not for a no-op.
      seedTab('t1', { name: 'Parser' });

      await manager.updateTerminalTabName('t1', 'Parser', { custom: true });

      expect(state.getTerminal('t1').nameCustom).toBe(true);
    });

    it('drops a no-op auto rename rather than re-broadcasting it', async () => {
      // PTY title scraping re-emits the same name continuously.
      seedTab('t1', { name: 'Same', claudeSessionId: 'sess-1' });

      await manager.updateTerminalTabName('t1', 'Same');

      expect(calls.some(c => c.namespace === 'remote' && c.method === 'notifyTabRenamed')).toBe(false);
    });

    it('broadcasts a rename that does change the name', async () => {
      seedTab('t1', { name: 'Before', claudeSessionId: 'sess-1' });

      await manager.updateTerminalTabName('t1', 'After');

      const notified = calls.filter(c => c.namespace === 'remote' && c.method === 'notifyTabRenamed');
      expect(notified).toHaveLength(1);
      expect(notified[0].args[0]).toEqual({ sessionId: 'sess-1', tabName: 'After' });
    });

    it('keeps the persisted session name locked too', async () => {
      // The second layer: even reaching _setSessionCustomName directly, an auto
      // rename must not clobber a custom entry.
      await manager._setSessionCustomName('sess-1', 'Chosen', { custom: true });
      await manager._setSessionCustomName('sess-1', 'Generated', { custom: false });

      expect(await manager._loadSessionNames()).toMatchObject({
        'sess-1': { name: 'Chosen', custom: true },
      });
    });

    it('does nothing at all for a tab that no longer exists', async () => {
      await expect(manager.updateTerminalTabName('gone', 'Anything')).resolves.toBeUndefined();
    });
  });

  // ── Closing ──

  describe('closing a tab', () => {
    it('asks before the close button throws a session away', async () => {
      seedTab('t1', { name: 'Live session' });
      const close = jest.fn();

      confirmAnswers.push(true);
      await manager._confirmCloseTab('t1', close);

      expect(confirmCalls).toHaveLength(1);
      expect(confirmCalls[0].danger).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('keeps the tab when the answer is no', async () => {
      seedTab('t1');
      const close = jest.fn();

      confirmAnswers.push(false);
      await manager._confirmCloseTab('t1', close);

      expect(close).not.toHaveBeenCalled();
      expect(state.getTerminal('t1')).toBeTruthy();
    });

    it('names the tab as the DOM shows it, not as the state holds it', async () => {
      // A tab titled from Claude's output only has its current name in the DOM.
      seedTab('t1', { name: 'stale state name' });
      document.querySelector('.terminal-tab[data-id="t1"] .tab-name').textContent = 'what the user sees';

      confirmAnswers.push(false);
      await manager._confirmCloseTab('t1', jest.fn());

      expect(JSON.stringify(confirmCalls[0])).toContain('what the user sees');
    });

    it('ignores a second close click while the dialog is up', async () => {
      seedTab('t1');
      const close = jest.fn();
      confirmAnswers.push(true);

      const first = manager._confirmCloseTab('t1', close);
      // The dialog is modal; a second overlay would be answered by the same key.
      await manager._confirmCloseTab('t1', close);
      await first;

      expect(confirmCalls).toHaveLength(1);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('does not close a tab that vanished while the user was deciding', async () => {
      seedTab('t1');
      const close = jest.fn();
      confirmAnswers.push(true);

      const pending = manager._confirmCloseTab('t1', close);
      // A PTY exit or a project close removes it from under the dialog.
      state.removeTerminal('t1');
      await pending;

      expect(close).not.toHaveBeenCalled();
    });

    it('kills the PTY and drops both DOM nodes for a terminal tab', () => {
      seedTab('t1', { ptyId: 'pty-9' });

      manager.closeTerminal('t1');

      const kills = calls.filter(c => c.namespace === 'terminal' && c.method === 'kill');
      expect(kills).toHaveLength(1);
      expect(kills[0].args[0]).toEqual({ id: 'pty-9' });
      expect(state.getTerminal('t1')).toBeUndefined();
      expect(document.querySelector('.terminal-tab[data-id="t1"]')).toBeNull();
      expect(document.querySelector('.terminal-wrapper[data-id="t1"]')).toBeNull();
    });

    it('destroys the chat view instead of killing a PTY for a chat tab', () => {
      const chatView = { destroy: jest.fn() };
      seedTab('t1', { mode: 'chat', chatView });

      manager.closeTerminal('t1');

      expect(chatView.destroy).toHaveBeenCalledTimes(1);
      expect(calls.some(c => c.namespace === 'terminal' && c.method === 'kill')).toBe(false);
      expect(state.getTerminal('t1')).toBeUndefined();
    });

    it('kills the PTY a switched tab actually owns, not the tab id', () => {
      // A tab that switched out of chat mode owns its PTY under a different key;
      // killing `id` would leave `claude` running.
      seedTab('t1', { ptyId: 'pty-after-switch' });

      manager.closeTerminal('t1');

      expect(calls.find(c => c.method === 'kill').args[0]).toEqual({ id: 'pty-after-switch' });
    });
  });

  // ── Reordering ──

  describe('reordering tabs by drag', () => {
    /** dragstart on `from`, then drop on `to`. clientX picks the side. */
    const dragOnto = (fromTab, toTab, clientX) => {
      const dataTransfer = { effectAllowed: '', dropEffect: '', setData: () => {}, getData: () => fromTab.dataset.id };
      const start = new Event('dragstart', { bubbles: true });
      start.dataTransfer = dataTransfer;
      fromTab.dispatchEvent(start);

      const drop = new Event('drop', { bubbles: true });
      drop.dataTransfer = dataTransfer;
      drop.clientX = clientX;
      toTab.dispatchEvent(drop);
    };

    const setup = () => {
      const a = seedTab('t1', { name: 'A' });
      const b = seedTab('t2', { name: 'B' });
      const c = seedTab('t3', { name: 'C' });
      [a, b, c].forEach(tab => manager._setupTabDragDrop(tab));
      return { a, b, c };
    };

    it('moves a tab before its target when dropped on the left half', () => {
      const { a, c } = setup();
      expect(tabIdsInOrder()).toEqual(['t1', 't2', 't3']);

      // jsdom has no layout, so every rect is zero-sized and midX is 0; a
      // negative clientX is the left half of that rect.
      dragOnto(a, c, -1);

      expect(tabIdsInOrder()).toEqual(['t2', 't1', 't3']);
    });

    it('moves a tab after its target when dropped on the right half', () => {
      const { a, b } = setup();

      dragOnto(a, b, 1);

      expect(tabIdsInOrder()).toEqual(['t2', 't1', 't3']);
    });

    it('refuses to drop across the pinned boundary', () => {
      const { a, c } = setup();
      c.classList.add('pinned-tab');

      dragOnto(a, c, -1);

      expect(tabIdsInOrder()).toEqual(['t1', 't2', 't3']);
    });

    it('does nothing when a tab is dropped on itself', () => {
      const { a } = setup();

      dragOnto(a, a, -1);

      expect(tabIdsInOrder()).toEqual(['t1', 't2', 't3']);
    });

    it('clears the drag marks on dragend', () => {
      const { a, b } = setup();
      const start = new Event('dragstart', { bubbles: true });
      start.dataTransfer = { effectAllowed: '', setData: () => {} };
      a.dispatchEvent(start);
      expect(a.classList.contains('dragging')).toBe(true);
      b.classList.add('drag-over-left');

      a.dispatchEvent(new Event('dragend', { bubbles: true }));

      expect(a.classList.contains('dragging')).toBe(false);
      expect(b.classList.contains('drag-over-left')).toBe(false);
    });
  });

  // ── Terminal / chat toggle ──

  describe('switching a tab between terminal and chat', () => {
    it('turns a terminal tab into a chat tab, carrying the session across', async () => {
      seedTab('t1', { ptyId: 'pty-1', claudeSessionId: 'sess-live' });

      await manager.switchTerminalMode('t1');

      const td = state.getTerminal('t1');
      expect(td.mode).toBe('chat');
      expect(td.chatView).toBeTruthy();
      // The PTY is gone and its id with it, so a later close cannot kill an id
      // main may since have recycled.
      expect(calls.some(c => c.namespace === 'terminal' && c.method === 'kill')).toBe(true);
      expect(td.ptyId).toBeNull();
      expect(td.terminal).toBeNull();

      const wrapper = document.querySelector('.terminal-wrapper[data-id="t1"]');
      expect(wrapper.classList.contains('chat-wrapper')).toBe(true);
      expect(document.querySelector('.terminal-tab[data-id="t1"]').classList.contains('chat-mode')).toBe(true);

      td.chatView.destroy();
    });

    it('resumes the CLI session the terminal was on', async () => {
      seedTab('t1', { ptyId: 'pty-1', claudeSessionId: 'sess-live' });

      await manager.switchTerminalMode('t1');
      // The switch itself starts nothing: a ChatView opens its session on the
      // first send, so the resume is only observable once a turn is sent.
      expect(calls.some(c => c.namespace === 'chat' && c.method === 'start')).toBe(false);

      state.getTerminal('t1').chatView.sendMessage('carry on');
      await flush();

      // The conversation continues rather than opening blank.
      const starts = calls.filter(c => c.namespace === 'chat' && c.method === 'start');
      expect(starts).toHaveLength(1);
      expect(starts[0].args[0].resumeSessionId).toBe('sess-live');

      state.getTerminal('t1').chatView?.destroy();
    });

    it('refuses to switch a basic tab', async () => {
      seedTab('t1', { isBasic: true });

      await manager.switchTerminalMode('t1');

      expect(state.getTerminal('t1').mode).toBe('terminal');
    });

    it('refuses to switch a tab with no wrapper or tab node', async () => {
      state.addTerminal('orphan', { name: 'Orphan', mode: 'terminal', project: { id: 'p1', path: '/tmp/test' } });

      await manager.switchTerminalMode('orphan');

      expect(state.getTerminal('orphan').mode).toBe('terminal');
    });

    it('ignores a second click while a switch is already running', async () => {
      seedTab('t1', { ptyId: 'pty-1' });

      const first = manager.switchTerminalMode('t1');
      // A second click during the awaited leg would tear down a half-built tab.
      await manager.switchTerminalMode('t1');
      await first;

      expect(state.getTerminal('t1').mode).toBe('chat');
      expect(calls.filter(c => c.namespace === 'terminal' && c.method === 'kill')).toHaveLength(1);

      state.getTerminal('t1').chatView?.destroy();
    });

    it('does nothing for a terminal id that does not exist', async () => {
      await expect(manager.switchTerminalMode('nope')).resolves.toBeUndefined();
    });
  });
});
