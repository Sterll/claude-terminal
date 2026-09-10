/**
 * Characterization — model, effort and permission mode are per conversation.
 *
 * CLAUDE.md states the invariant: the footer menus change the current tab only,
 * and the stored `chatModel` / `effortLevel` / `executionMode` are what a *new*
 * tab starts from, moved only through each menu's explicit "use for new
 * conversations" row. "A pick never writes them, so the last choice in one tab
 * cannot silently become every later tab's."
 *
 * That is worth a net because its failure mode is invisible. A stray
 * `setSetting` in `selectModel` breaks nothing a user would notice today — it
 * only shows up as the next tab quietly opening on a model, an effort or a
 * permission mode nobody chose for it, which for `bypassPermissions` is a
 * security regression and for a premium model is a billing one.
 *
 * So both halves are asserted: a pick writes nothing, and the default row does
 * write. A test that only checked the first would pass just as happily against
 * a build where the default row had stopped working.
 *
 * These tests pin behaviour; they do not endorse it. See the note on the
 * failed-switch rollback at the end.
 */

/** api mock: `on*` captures its callback, everything else answers from `responses`. */
function makeApiMock(listeners, calls, responses = {}) {
  const ns = (namespace) => new Proxy({}, {
    get: (_t, method) => (...args) => {
      if (typeof method === 'string' && method.startsWith('on')) {
        listeners[method] = args[0];
        return () => {};
      }
      calls.push({ namespace, method, args });
      const key = `${namespace}.${method}`;
      return Promise.resolve(key in responses ? responses[key] : { success: true, messages: [] });
    }
  });
  return new Proxy({}, { get: (_t, namespace) => ns(namespace) });
}

let uuidSeq = 0;
Object.defineProperty(global, 'crypto', {
  value: { ...(global.crypto || {}), randomUUID: () => `scope-uuid-${++uuidSeq}` },
  configurable: true,
});

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};

describe('chat session-scoped model / effort / mode (characterization)', () => {
  let listeners, calls, responses, wrapper, view, sessionId, settings;

  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)); };

  /** Open a menu and click one of its rows. */
  const openMenu = (btn) => wrapper.querySelector(btn).click();
  const rows = (sel) => Array.from(wrapper.querySelectorAll(sel));

  beforeEach(async () => {
    jest.resetModules();
    listeners = {};
    calls = [];
    responses = {};

    // Stand in for the real settings store so a write is observable and a read
    // is seedable, without touching the on-disk settings.json.
    settings = {};
    jest.doMock('../../src/renderer/state/settings.state', () => {
      const actual = jest.requireActual('../../src/renderer/state/settings.state');
      return {
        ...actual,
        getSetting: (key) => settings[key],
        setSetting: (key, value) => { settings[key] = value; },
      };
    });

    window.electron_api = makeApiMock(listeners, calls, responses);
    document.body.innerHTML = '';
    wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const { createChatView } = require('../../src/renderer/ui/components/ChatView');
    view = createChatView(wrapper, { id: 'p1', name: 'Test', path: '/tmp/test' });
    view.sendMessage('go');
    await flush();
    sessionId = view.getSessionId();
    expect(sessionId).toBeTruthy();
  });

  afterEach(() => {
    try { view?.destroy?.(); } catch (_) { /* teardown is best effort */ }
    jest.dontMock('../../src/renderer/state/settings.state');
  });

  // ── Permission mode ──
  //
  // Chosen as the primary subject because its rows are a fixed, locally-defined
  // list (src/shared/permission-modes.js), so the menu is populated without the
  // CLI having answered a model catalog first.

  describe('permission mode', () => {
    const modeRows = () => rows('.chat-mode-option');

    it('changes the running session without writing the stored default', async () => {
      openMenu('.chat-mode-btn');
      const target = modeRows().find(r => r.dataset.mode === 'acceptEdits');
      expect(target).toBeTruthy();

      target.click();
      await flush();

      // The live session moved...
      const set = calls.filter(c => c.namespace === 'chat' && c.method === 'setPermissionMode');
      expect(set).toHaveLength(1);
      expect(set[0].args[0]).toMatchObject({ sessionId, mode: 'acceptEdits' });
      expect(wrapper.querySelector('[data-permission-mode]').dataset.permissionMode).toBe('acceptEdits');

      // ...and nothing about the next tab did. This is the whole invariant.
      expect(settings.executionMode).toBeUndefined();
      expect(settings.skipPermissions).toBeUndefined();
    });

    it('writes the default only through the use-for-new-conversations row', async () => {
      openMenu('.chat-mode-btn');
      modeRows().find(r => r.dataset.mode === 'acceptEdits').click();
      await flush();
      expect(settings.executionMode).toBeUndefined();

      openMenu('.chat-mode-btn');
      wrapper.querySelector('.chat-mode-default').click();
      await flush();

      expect(settings.executionMode).toBeDefined();
      // The legacy boolean the terminal CLI launch path reads is kept in step.
      expect(settings.skipPermissions).toBe(false);
    });

    it('keeps skipPermissions in step when bypass is pinned', async () => {
      openMenu('.chat-mode-btn');
      modeRows().find(r => r.dataset.mode === 'bypassPermissions').click();
      await flush();
      // Still nothing written by the pick itself, bypass included.
      expect(settings.skipPermissions).toBeUndefined();

      openMenu('.chat-mode-btn');
      wrapper.querySelector('.chat-mode-default').click();
      await flush();

      expect(settings.skipPermissions).toBe(true);
    });

    it('starts from the stored default, and leaves it alone', async () => {
      // A fresh tab inheriting a default is the read half of the same rule.
      view.destroy();
      settings.executionMode = 'acceptEdits';
      document.body.innerHTML = '';
      wrapper = document.createElement('div');
      document.body.appendChild(wrapper);
      const { createChatView } = require('../../src/renderer/ui/components/ChatView');
      view = createChatView(wrapper, { id: 'p1', name: 'Test', path: '/tmp/test' });
      await flush();

      expect(wrapper.querySelector('[data-permission-mode]').dataset.permissionMode).toBe('acceptEdits');
      // Reading a default must not rewrite it.
      expect(settings.executionMode).toBe('acceptEdits');
    });

    it('rolls the selection back when the SDK refuses the switch', async () => {
      responses['chat.setPermissionMode'] = { success: false, error: 'nope' };
      const before = wrapper.querySelector('[data-permission-mode]').dataset.permissionMode;

      openMenu('.chat-mode-btn');
      modeRows().find(r => r.dataset.mode === 'acceptEdits').click();
      await flush();

      // The session still runs the previous mode, so the picker says so too.
      expect(wrapper.querySelector('[data-permission-mode]').dataset.permissionMode).toBe(before);
      expect(settings.executionMode).toBeUndefined();
    });

    it('ignores a mode id that is not on the list', async () => {
      const before = wrapper.querySelector('[data-permission-mode]').dataset.permissionMode;

      openMenu('.chat-mode-btn');
      // Fabricate a row the way a stale cached menu would.
      const rogue = wrapper.querySelector('.chat-mode-option').cloneNode(true);
      rogue.dataset.mode = 'thereIsNoSuchMode';
      wrapper.querySelector('.chat-mode-dropdown').appendChild(rogue);
      rogue.click();
      await flush();

      expect(wrapper.querySelector('[data-permission-mode]').dataset.permissionMode).toBe(before);
      expect(calls.some(c => c.method === 'setPermissionMode')).toBe(false);
    });
  });

  // ── Effort ──

  describe('effort', () => {
    /**
     * Unlike the mode picker, the effort button is disabled while the turn
     * streams (`effortBtn.disabled = streaming`), so the menu will not even
     * open until the turn ends. Pinned as its own test below; every effort
     * test here settles the turn first.
     */
    const endTurn = async () => {
      listeners.onDone({ sessionId, interrupted: false });
      await flush();
    };

    it('refuses to open its menu mid-turn, where the mode picker opens', () => {
      // The asymmetry is deliberate on the mode side ("switching to accept
      // edits while prompts pile up is the moment it is wanted most"), so this
      // records the contrast rather than either half alone.
      expect(wrapper.querySelector('.chat-effort-btn').disabled).toBe(true);
      openMenu('.chat-effort-btn');
      expect(rows('.chat-effort-option')).toHaveLength(0);

      openMenu('.chat-mode-btn');
      expect(rows('.chat-mode-option').length).toBeGreaterThan(0);
    });

    it('changes the running session without writing the stored default', async () => {
      await endTurn();
      openMenu('.chat-effort-btn');
      const target = rows('.chat-effort-option').find(r => r.dataset.effort === 'low');
      expect(target).toBeTruthy();

      target.click();
      await flush();

      const set = calls.filter(c => c.namespace === 'chat' && c.method === 'setEffort');
      expect(set).toHaveLength(1);
      expect(set[0].args[0]).toMatchObject({ sessionId, effort: 'low' });
      expect(settings.effortLevel).toBeUndefined();
    });

    it('writes the default only through the use-for-new-conversations row', async () => {
      await endTurn();
      openMenu('.chat-effort-btn');
      rows('.chat-effort-option').find(r => r.dataset.effort === 'low').click();
      await flush();
      expect(settings.effortLevel).toBeUndefined();

      openMenu('.chat-effort-btn');
      wrapper.querySelector('.chat-effort-default').click();
      await flush();

      expect(settings.effortLevel).toBe('low');
    });
  });

  // ── Cross-tab ──

  describe('two conversations side by side', () => {
    it('does not let one tab move the other', async () => {
      const secondWrapper = document.createElement('div');
      document.body.appendChild(secondWrapper);
      const { createChatView } = require('../../src/renderer/ui/components/ChatView');
      const second = createChatView(secondWrapper, { id: 'p1', name: 'Test', path: '/tmp/test' });
      await flush();

      const secondModeBefore = secondWrapper.querySelector('[data-permission-mode]').dataset.permissionMode;

      wrapper.querySelector('.chat-mode-btn').click();
      Array.from(wrapper.querySelectorAll('.chat-mode-option'))
        .find(r => r.dataset.mode === 'bypassPermissions').click();
      await flush();

      expect(wrapper.querySelector('[data-permission-mode]').dataset.permissionMode).toBe('bypassPermissions');
      // The neighbour is untouched, and so is what a third tab would inherit.
      expect(secondWrapper.querySelector('[data-permission-mode]').dataset.permissionMode).toBe(secondModeBefore);
      expect(settings.executionMode).toBeUndefined();

      try { second.destroy(); } catch (_) { /* teardown is best effort */ }
    });
  });
});
