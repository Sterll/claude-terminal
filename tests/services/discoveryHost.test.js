/**
 * The host side of the feature suggestions: how "a bad moment" is read off
 * the app, how a suggestion is drawn (a toast with two buttons, never a
 * modal), and how "Show me" reaches the navigation the renderer registered.
 */

const Discovery = require('../../src/renderer/services/discovery');
const Toast = require('../../src/renderer/ui/components/Toast');

function terminals(...entries) {
  return new Map(entries.map((e, i) => [i + 1, e]));
}

const focusedDoc = () => {
  const doc = document;
  return { hidden: false, hasFocus: () => true, querySelector: doc.querySelector.bind(doc), querySelectorAll: doc.querySelectorAll.bind(doc) };
};

afterEach(() => {
  document.body.innerHTML = '';
  jest.useRealTimers();
});

describe('busyReason', () => {
  test('free when every Claude tab is ready', () => {
    expect(Discovery.busyReason({ terminals: terminals({ status: 'ready' }, { status: 'ready', isBasic: true }), doc: focusedDoc() })).toBe(null);
  });

  test('a turn running in any tab, even a background one', () => {
    expect(Discovery.busyReason({ terminals: terminals({ status: 'ready' }, { status: 'working' }), doc: focusedDoc() })).toBe('turn');
  });

  test('a card waiting for an answer', () => {
    expect(Discovery.busyReason({ terminals: terminals({ status: 'ready', attention: 'input' }), doc: focusedDoc() })).toBe('waiting');
  });

  test('a plain shell running a command is not a Claude turn', () => {
    expect(Discovery.busyReason({ terminals: terminals({ status: 'working', isBasic: true }), doc: focusedDoc() })).toBe(null);
  });

  test('a modal on screen', () => {
    document.body.innerHTML = '<div class="modal-overlay active" id="modal-overlay"></div>';
    expect(Discovery.busyReason({ terminals: terminals(), doc: focusedDoc() })).toBe('modal');
  });

  test('a closed modal does not count', () => {
    document.body.innerHTML = '<div class="modal-overlay" id="modal-overlay"></div>';
    expect(Discovery.busyReason({ terminals: terminals(), doc: focusedDoc() })).toBe(null);
  });

  test('the window in the background', () => {
    expect(Discovery.busyReason({ terminals: terminals(), doc: { ...focusedDoc(), hasFocus: () => false } })).toBe('unfocused');
    expect(Discovery.busyReason({ terminals: terminals(), doc: { ...focusedDoc(), hidden: true } })).toBe('unfocused');
  });
});

describe('maxClaudeTabsPerProject', () => {
  test('counts Claude tabs per project, worktree tabs under their parent', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    const map = terminals(
      { project: a }, { project: a, mode: 'chat' }, { project: { id: 'wt' }, parentProjectId: 'a' },
      { project: b }, { project: a, isBasic: true }, { project: a, type: 'file' }, { project: a, type: 'fivem' },
    );
    expect(Discovery.maxClaudeTabsPerProject(map)).toBe(3);
  });

  test('zero with no tabs', () => {
    expect(Discovery.maxClaudeTabsPerProject(new Map())).toBe(0);
  });
});

describe('the suggestion card', () => {
  const t = (key, params) => (params && Object.keys(params).length ? `${key}:${JSON.stringify(params)}` : key);

  function present(action = { type: 'tab', tab: 'database' }) {
    const handlers = { onAction: jest.fn(), onDismiss: jest.fn(), onHide: jest.fn() };
    const present = Discovery.makePresenter({ t, showToast: Toast.showToast });
    present({ id: 'database', titleKey: 'k.title', bodyKey: 'k.body', params: { file: 'app.db' }, actionLabelKey: 'discovery.showMe', action }, handlers);
    return { handlers, el: document.querySelector('.toast.toast-suggestion') };
  }

  test('is a toast, not a modal, with both buttons on their own row', () => {
    const { el } = present();
    expect(el).not.toBeNull();
    expect(document.querySelector('.modal-overlay.active')).toBeNull();
    expect(el.querySelector('.toast-title').textContent).toBe('k.title:{"file":"app.db"}');
    const buttons = el.querySelectorAll('.toast-actions .toast-action');
    expect([...buttons].map(b => b.textContent)).toEqual(['discovery.showMe', 'discovery.dontShowAgain']);
  });

  test('"Show me" records the action and runs the host navigation', () => {
    const onOpenTab = jest.fn();
    Discovery.setCallbacks({ onOpenTab });
    const { el, handlers } = present();
    el.querySelector('.toast-action:not(.toast-action--secondary)').click();
    expect(handlers.onAction).toHaveBeenCalledTimes(1);
    expect(onOpenTab).toHaveBeenCalledWith('database');
    expect(handlers.onHide).toHaveBeenCalledTimes(1);
  });

  test('"Don\'t show again" records the dismissal and closes', () => {
    const { el, handlers } = present();
    el.querySelector('.toast-action--secondary').click();
    expect(handlers.onDismiss).toHaveBeenCalledTimes(1);
    expect(handlers.onAction).not.toHaveBeenCalled();
    expect(handlers.onHide).toHaveBeenCalledTimes(1);
  });

  test('the close button only closes', () => {
    const { el, handlers } = present();
    el.querySelector('.toast-close').click();
    expect(handlers.onDismiss).not.toHaveBeenCalled();
    expect(handlers.onAction).not.toHaveBeenCalled();
    expect(handlers.onHide).toHaveBeenCalledTimes(1);
  });

  test('a setting action reaches the settings callback with its anchor', () => {
    const onOpenSetting = jest.fn();
    Discovery.setCallbacks({ onOpenSetting });
    const { el } = present({ type: 'setting', tab: 'claude', anchor: 'context-handoff-toggle' });
    el.querySelector('.toast-action:not(.toast-action--secondary)').click();
    expect(onOpenSetting).toHaveBeenCalledWith({ tab: 'claude', anchor: 'context-handoff-toggle' });
  });

  test('a tab action can flash the control it is about', () => {
    jest.useFakeTimers();
    document.body.innerHTML = '<button id="btn-generate-commit"></button>';
    Discovery.setCallbacks({ onOpenTab: jest.fn() });
    Discovery.runAction({ type: 'tab', tab: 'git', highlight: '#btn-generate-commit' });
    jest.advanceTimersByTime(400);
    expect(document.getElementById('btn-generate-commit').classList.contains('discovery-highlight')).toBe(true);
    jest.advanceTimersByTime(3000);
    expect(document.getElementById('btn-generate-commit').classList.contains('discovery-highlight')).toBe(false);
  });
});

describe('Toast: the second button is additive', () => {
  test('a toast without it keeps its single inline action', () => {
    const onAction = jest.fn();
    const el = Toast.showToast({ message: 'Saved', action: 'Undo', onAction, duration: 0 });
    expect(el.querySelector('.toast-actions')).toBeNull();
    el.querySelector('.toast-action').click();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  test('onHide fires once, whatever closes the toast', () => {
    const onHide = jest.fn();
    const el = Toast.showToast({ message: 'x', duration: 0, onHide, dedupe: false });
    Toast.hideToast(el);
    Toast.hideToast(el);
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});

describe('report and markUsed before init', () => {
  test('are harmless no-ops', () => {
    expect(() => Discovery.report('tabs:changed', { maxClaudeTabs: 9 })).not.toThrow();
    expect(() => Discovery.markUsed('tab:control-tower')).not.toThrow();
  });
});
