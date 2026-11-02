/**
 * The split view as TerminalManager drives it.
 *
 * terminalSplitLayout.test.js pins the layout unit on its own; this suite pins
 * the places TerminalManager hands it control: the xterm key handler, which
 * must never let a split shortcut reach the shell as a control character, the
 * tab menu, closing a tab, the project filter, and the shortcut's fallback to
 * a plain terminal. As in the tabs characterization suite, no xterm is built:
 * the terminals state is seeded in the shape createTerminal leaves behind.
 */

jest.mock('../../src/renderer/services/TerminalSessionService', () => ({
  saveTerminalSessions: jest.fn(),
  loadTerminalSessions: jest.fn(),
  setSplitLayoutProvider: jest.fn(),
}));

function makeApiMock(calls) {
  const ns = (namespace) => new Proxy({}, {
    get: (_t, method) => (...args) => {
      if (typeof method === 'string' && method.startsWith('on')) return () => {};
      calls.push({ namespace, method, args });
      return Promise.resolve({ success: true, messages: [] });
    }
  });
  return new Proxy({}, { get: (_t, namespace) => ns(namespace) });
}

let uuidSeq = 0;
Object.defineProperty(global, 'crypto', {
  value: { ...(global.crypto || {}), randomUUID: () => `split-uuid-${++uuidSeq}` },
  configurable: true,
});

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};

const P1 = { id: 'p1', name: 'One', path: '/tmp/one' };
const P2 = { id: 'p2', name: 'Two', path: '/tmp/two' };

describe('split view in TerminalManager', () => {
  let manager, state, calls, settingsState, projectsState, t, container;

  const seedTab = (id, data = {}) => {
    const project = data.project || P1;
    state.addTerminal(id, {
      name: 'Tab',
      project,
      projectIndex: project === P1 ? 0 : 1,
      mode: 'terminal',
      status: 'ready',
      ...data,
    });
    const tab = document.createElement('div');
    tab.className = 'terminal-tab';
    tab.dataset.id = id;
    tab.innerHTML = '<span class="status-dot"></span><span class="tab-name">Tab</span><span class="tab-close"></span>';
    document.getElementById('terminals-tabs').appendChild(tab);
    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper';
    wrapper.dataset.id = id;
    container.appendChild(wrapper);
    return tab;
  };

  const panes = () => [...container.querySelectorAll('.terminal-wrapper.split-pane')].map((w) => w.dataset.id);

  beforeEach(() => {
    jest.resetModules();
    calls = [];
    window.electron_api = makeApiMock(calls);
    document.body.innerHTML = `
      <div id="terminals-tabs"></div>
      <div id="terminals-container"></div>
      <div id="empty-terminals"></div>
      <div id="terminals-filter"><span id="filter-project-name"></span></div>
    `;
    container = document.getElementById('terminals-container');
    state = require('../../src/renderer/state/terminals.state');
    ({ settingsState } = require('../../src/renderer/state/settings.state'));
    ({ projectsState } = require('../../src/renderer/state/projects.state'));
    ({ t } = require('../../src/renderer/i18n'));
    projectsState.set({ ...projectsState.get(), projects: [P1, P2], selectedProjectFilter: 0 });
    const { TerminalManager } = require('../../src/renderer/ui/components/TerminalManager');
    manager = new TerminalManager();
  });

  afterEach(() => {
    try { manager.destroy(); } catch (_) { /* best effort */ }
    try { state.clearAllTerminals(() => {}); } catch (_) { /* best effort */ }
    document.querySelectorAll('.context-menu').forEach((m) => m.remove());
  });

  describe('the xterm key handler', () => {
    const fakeTerminal = () => ({
      onSelectionChange: () => ({ dispose() {} }),
      getSelection: () => '',
      clearSelection() {},
      selectAll() {},
    });
    const key = (type, init) => new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });

    it('steps aside for the default split shortcuts, on every event type', () => {
      const handler = manager._createTerminalKeyHandler(fakeTerminal(), 't1');
      expect(handler(key('keydown', { key: 'D', ctrlKey: true, shiftKey: true }))).toBe(false);
      expect(handler(key('keypress', { key: 'D', ctrlKey: true, shiftKey: true }))).toBe(false);
      expect(handler(key('keydown', { key: 'S', ctrlKey: true, shiftKey: true }))).toBe(false);
    });

    it('follows a rebinding, so no ^D or ESC ^D reaches the shell', () => {
      settingsState.setProp('shortcuts', { splitRight: 'Ctrl+D', splitDown: 'Ctrl+Alt+Shift+D' });
      const handler = manager._createTerminalKeyHandler(fakeTerminal(), 't1');
      expect(handler(key('keydown', { key: 'd', ctrlKey: true }))).toBe(false);
      expect(handler(key('keydown', { key: 'D', ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false);
      expect(calls.filter((c) => c.namespace === 'terminal' && c.method === 'input')).toEqual([]);
    });

    it('forgets a Shift released after focus left the terminal, so Enter still submits', () => {
      const term = fakeTerminal();
      term.textarea = document.createElement('textarea');
      document.body.appendChild(term.textarea);
      const handler = manager._createTerminalKeyHandler(term, 't1');
      // Ctrl+Shift+D: Shift goes down here, then the split moves the focus away
      // and the keyup lands in the other pane.
      handler(key('keydown', { key: 'Shift', shiftKey: true }));
      term.textarea.dispatchEvent(new Event('blur'));
      // Back in this pane, a plain Enter is xterm's to send as a carriage return.
      expect(handler(key('keydown', { key: 'Enter' }))).toBe(true);
      expect(calls.filter((c) => c.namespace === 'terminal' && c.method === 'input')).toEqual([]);
    });

    it('leaves Ctrl+D to the shell while it is not a split shortcut', () => {
      settingsState.setProp('shortcuts', {});
      const handler = manager._createTerminalKeyHandler(fakeTerminal(), 't1');
      expect(handler(key('keydown', { key: 'd', ctrlKey: true }))).toBe(true);
    });
  });

  describe('the tab menu', () => {
    const openMenu = (tab) => {
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
      return [...document.querySelectorAll('.context-menu .context-menu-item')];
    };
    const item = (items, key) => items.find((el) => el.querySelector('.context-menu-label').textContent === t(key));

    it('offers to open a tab beside the active one', () => {
      seedTab(1);
      const tab2 = seedTab(2);
      tab2.oncontextmenu = (e) => manager._showTabContextMenu(e, 2);
      manager.setActiveTerminal(1);
      item(openMenu(tab2), 'tabs.openRight').click();
      expect(panes()).toEqual(['1', '2']);
      expect(state.getActiveTerminal()).toBe(2);
    });

    it('disables the split entries on a project console, with the reason as tooltip', () => {
      seedTab(1);
      const consoleTab = seedTab(9, { type: 'fivem' });
      consoleTab.oncontextmenu = (e) => manager._showTabContextMenu(e, 9);
      const items = openMenu(consoleTab);
      for (const k of ['tabs.openRight', 'tabs.openBelow']) {
        const el = item(items, k);
        expect(el.disabled).toBe(true);
        expect(el.title).toBe(t('terminals.splitUnsupported'));
      }
    });

    it('lists the way out once the tab is in a split', () => {
      seedTab(1);
      const tab2 = seedTab(2);
      tab2.oncontextmenu = (e) => manager._showTabContextMenu(e, 2);
      manager.setActiveTerminal(1);
      manager.splitTab(2, 'right');
      const items = openMenu(tab2);
      expect(item(items, 'tabs.removeFromSplit')).toBeTruthy();
      item(items, 'tabs.exitSplit').click();
      expect(container.classList.contains('is-split')).toBe(false);
    });
  });

  it('a pane on screen counts as shown, a hidden tab does not', () => {
    seedTab(1);
    seedTab(2);
    seedTab(3);
    manager.setActiveTerminal(1);
    manager.splitTab(2, 'right');
    expect(manager.isTerminalShown(1)).toBe(true);
    expect(manager.isTerminalShown(2)).toBe(true);
    expect(manager.isTerminalShown(3)).toBe(false);
  });

  it('closing the focused pane focuses its neighbour and goes back to a simple view', () => {
    seedTab(1);
    seedTab(2);
    seedTab(3);
    manager.setActiveTerminal(3);
    manager.setActiveTerminal(1);
    manager.splitTab(2, 'right');
    expect(state.getActiveTerminal()).toBe(2);

    manager.closeTerminal(2);

    // Not tab 3, which the activation history would have picked: it would
    // have taken the closed pane's place.
    expect(state.getActiveTerminal()).toBe(1);
    expect(container.classList.contains('is-split')).toBe(false);
    expect(panes()).toEqual([]);
  });

  it('switching project draws that project\'s view, split or not, and back', () => {
    seedTab(1);
    seedTab(2);
    seedTab(5, { project: P2 });
    manager.setActiveTerminal(1);
    manager.splitTab(2, 'right');
    expect(container.classList.contains('is-split')).toBe(true);

    projectsState.setProp('selectedProjectFilter', 1);
    manager.filterByProject(1);
    expect(state.getActiveTerminal()).toBe(5);
    expect(container.classList.contains('is-split')).toBe(false);
    expect(container.querySelectorAll('.split-handle')).toHaveLength(0);
    for (const id of [1, 2]) {
      const w = container.querySelector(`.terminal-wrapper[data-id="${id}"]`);
      expect(w.classList.contains('split-pane')).toBe(false);
      expect(w.style.getPropertyValue('--pane-left')).toBe('');
    }

    projectsState.setProp('selectedProjectFilter', 0);
    manager.filterByProject(0);
    expect(container.classList.contains('is-split')).toBe(true);
    expect(panes()).toEqual(['1', '2']);
  });

  it('the shortcut puts the last used hidden tab beside the active one', async () => {
    seedTab(1);
    seedTab(2);
    seedTab(3);
    manager.setActiveTerminal(2);
    manager.setActiveTerminal(3);
    manager.setActiveTerminal(1);
    await manager.splitActive('bottom');
    expect(panes()).toEqual(['1', '3']);
    expect(container.querySelector('.split-handle.column')).not.toBeNull();
  });

  it('with nothing to put there, the shortcut opens a plain terminal, never a Claude session', async () => {
    seedTab(1);
    manager.setActiveTerminal(1);
    manager.createTerminal = jest.fn(async (project, opts) => {
      seedTab(7, { project });
      manager.setActiveTerminal(7);
      return 7;
    });
    await manager.splitActive('right');
    expect(manager.createTerminal).toHaveBeenCalledWith(P1, expect.objectContaining({ runClaude: false }));
    expect(panes()).toEqual(['1', '7']);
  });

  it('restores a saved layout onto the restored tabs and focuses its pane', () => {
    seedTab(11);
    seedTab(12);
    manager.setActiveTerminal(11);
    manager.restoreSplitLayout('p1', { root: { dir: 'row', ratio: 0.4, a: { tab: 0 }, b: { tab: 1 } }, focused: 1 }, [11, 12]);
    expect(state.getActiveTerminal()).toBe(12);
    expect(panes()).toEqual(['11', '12']);
  });
});
