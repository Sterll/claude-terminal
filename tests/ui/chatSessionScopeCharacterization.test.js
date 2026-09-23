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
    const endTurn = async () => {
      listeners.onDone({ sessionId, interrupted: false });
      await flush();
    };

    it('opens its menu mid-turn, like the mode picker beside it', async () => {
      // This used to be the opposite assertion: `effortBtn.disabled = streaming`
      // left the model and effort buttons dead for the whole turn, next to a
      // composer that queues the next message and a mode picker that stays
      // live. Three controls in one footer, two of which answered and one of
      // which did not, with nothing saying why.
      expect(wrapper.querySelector('.chat-effort-btn').disabled).toBe(false);
      openMenu('.chat-effort-btn');
      expect(rows('.chat-effort-option').length).toBeGreaterThan(0);

      openMenu('.chat-mode-btn');
      expect(rows('.chat-mode-option').length).toBeGreaterThan(0);
    });

    it('holds a mid-turn pick back until the turn ends, then pushes it once', async () => {
      openMenu('.chat-effort-btn');
      rows('.chat-effort-option').find(r => r.dataset.effort === 'low').click();
      await flush();

      // The label is this conversation's setting and moves at once; the SDK
      // must not hear about it while it is still answering.
      expect(wrapper.querySelector('.chat-effort-label').textContent.toLowerCase()).toContain('low');
      expect(calls.filter(c => c.method === 'setEffort')).toHaveLength(0);
      expect(wrapper.querySelector('.chat-view.selection-pending')).not.toBeNull();

      await endTurn();

      const pushed = calls.filter(c => c.method === 'setEffort');
      expect(pushed).toHaveLength(1);
      expect(pushed[0].args[0]).toMatchObject({ effort: 'low' });
      expect(wrapper.querySelector('.chat-view.selection-pending')).toBeNull();
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

  // ── What "held until the turn ends" has to mean ──
  //
  // Parking the pick is only half of it. The composer keeps queueing while the
  // pick sits there, and the label keeps moving while the session does not, so
  // the two of them have to stay in step with what the SDK is actually running.

  describe('a pick parked mid-turn', () => {
    const endTurn = async () => {
      listeners.onDone({ sessionId, interrupted: false });
      await flush();
    };
    const pickEffort = async (id) => {
      openMenu('.chat-effort-btn');
      rows('.chat-effort-option').find(r => r.dataset.effort === id).click();
      await flush();
    };

    it('lets the message queued behind it go only once it has been pushed', async () => {
      await pickEffort('low');
      view.sendMessage('next');
      await flush();

      // `api.chat.send` reaches the CLI's queue immediately, so sending now is
      // sending a message the next turn runs under the *old* effort — which is
      // the one thing the parking exists to prevent.
      expect(calls.filter(c => c.method === 'send')).toHaveLength(0);

      await endTurn();

      const order = calls
        .filter(c => c.method === 'setEffort' || c.method === 'send')
        .map(c => c.method);
      expect(order).toEqual(['setEffort', 'send']);
    });

    it('still sends that message when the switch itself fails', async () => {
      responses['chat.setEffort'] = { success: false, error: 'nope' };
      await pickEffort('low');
      view.sendMessage('next');
      await flush();
      await endTurn();

      // Losing what the user typed is worse than running it on the effort the
      // session never left.
      expect(calls.filter(c => c.method === 'send')).toHaveLength(1);
    });

    it('is replaced, not stacked, when the user changes their mind again', async () => {
      await pickEffort('low');
      await pickEffort('high');
      await endTurn();

      const pushed = calls.filter(c => c.method === 'setEffort');
      expect(pushed).toHaveLength(1);
      expect(pushed[0].args[0]).toMatchObject({ effort: 'high' });
    });

    it('reverts to what the session runs, not to a pick that never reached it', async () => {
      const original = wrapper.querySelector('.chat-effort-label').textContent;
      responses['chat.setEffort'] = { success: false, error: 'nope' };

      await pickEffort('low');
      await pickEffort('high');
      await endTurn();

      // The first pick was overwritten before it was ever pushed, so the
      // session never ran it and the footer must not fall back to it.
      expect(wrapper.querySelector('.chat-effort-label').textContent).toBe(original);
    });

    it('marks only the chip it belongs to', async () => {
      await pickEffort('low');

      expect(wrapper.querySelector('.chat-effort-label').classList.contains('selection-pending')).toBe(true);
      // The model beside it has not moved and must not read as provisional.
      expect(wrapper.querySelector('.chat-model-label').classList.contains('selection-pending')).toBe(false);
    });

    it('leaves the model tooltip intact once the turn is over', async () => {
      const before = wrapper.querySelector('.chat-model-btn').title;
      await pickEffort('low');
      await endTurn();

      // syncModelTier owns this string (it carries the premium hint); the
      // pending marker used to blank it for the life of the tab, because no
      // turn-end path calls syncModelTier.
      expect(wrapper.querySelector('.chat-model-btn').title).toBe(before);
    });
  });

  // ── A catalog arriving after the tab opened ──
  //
  // Main pushes the model catalog once the CLI answers, so a tab that opened
  // against the offline fallback stops naming the previous CLI's model. That
  // repaint may not turn into a change of the conversation: the push never
  // talks to the SDK, so anything it moves in the footer is a footer that now
  // disagrees with the session — and it would arrive without going through the
  // parking a mid-turn pick goes through.

  describe('a catalog pushed after the tab opened', () => {
    /** The shape `chat-model-catalog-changed` delivers. */
    const push = (primary, recommended) => {
      listeners.onModelCatalogChanged({
        success: true, primary, legacy: [], recommended, source: 'cli',
      });
    };

    const ROW = (value, displayName, levels) => ({
      value,
      displayName,
      supportsEffort: true,
      supportedEffortLevels: levels,
    });

    it('does not re-derive the model of a session that is already running', async () => {
      const before = wrapper.querySelector('.chat-model-label').textContent;

      // Deliberately not Opus 5.5: the offline fallback tier already leads
      // with it, so a push naming it would leave the label where it was and
      // the assertion would hold with or without the guard.
      push([ROW('claude-sonnet-5', 'Sonnet 5', ['low', 'medium', 'high', 'max'])], 'claude-sonnet-5');
      await flush();

      // The SDK was handed a model at start and nothing here told it otherwise.
      expect(wrapper.querySelector('.chat-model-label').textContent).toBe(before);
      expect(calls.filter(c => c.method === 'setModel')).toHaveLength(0);
    });

    it('does not rewrite the effort of a session that is already running', async () => {
      openMenu('.chat-effort-btn');
      rows('.chat-effort-option').find(r => r.dataset.effort === 'low').click();
      await flush();
      listeners.onDone({ sessionId, interrupted: false });
      await flush();

      const before = wrapper.querySelector('.chat-effort-label').textContent;
      const callsBefore = calls.filter(c => c.method === 'setEffort').length;

      // A ladder that no longer offers the level this conversation is on.
      push([ROW('claude-opus-5-5', 'Opus 5.5', ['high', 'max'])], 'claude-opus-5-5');
      await flush();

      expect(wrapper.querySelector('.chat-effort-label').textContent).toBe(before);
      expect(calls.filter(c => c.method === 'setEffort')).toHaveLength(callsBefore);
    });

    it('still corrects a tab that has not started a session yet', async () => {
      // The case the push exists for: this one opened before the CLI answered,
      // so its chip is whatever the offline fallback resolved to.
      const freshWrapper = document.createElement('div');
      document.body.appendChild(freshWrapper);
      const { createChatView } = require('../../src/renderer/ui/components/ChatView');
      const fresh = createChatView(freshWrapper, { id: 'p1', name: 'Test', path: '/tmp/test' });
      await flush();

      push([ROW('claude-sonnet-5', 'Sonnet 5', ['low', 'medium', 'high', 'max'])], 'claude-sonnet-5');
      await flush();

      expect(freshWrapper.querySelector('.chat-model-label').textContent).toContain('Sonnet 5');

      try { fresh.destroy(); } catch (_) { /* teardown is best effort */ }
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
