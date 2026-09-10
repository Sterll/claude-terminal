/**
 * Characterization — interrupting a turn, and the compaction indicator.
 *
 * Two lifecycles that are only ever exercised by hand today, and both of which
 * a split of ChatView.js would have to carry across intact:
 *
 *  - Stop mid-turn. The click sets a local `isAborting` flag and asks main to
 *    interrupt; the marker is stamped when the *reply* comes back, not when the
 *    button is pressed. Anything that reorders those two ends up with either no
 *    marker or a marker on a turn that finished normally.
 *
 *  - Compaction. `status/compacting` puts an indicator up, `compact_boundary`
 *    takes it down and leaves a system notice in its place. The indicator is a
 *    perpetual-animation element, so one left behind is a spinner that never
 *    stops — the exact class of bug IdleAnimationPauser exists to bound.
 *
 * No fake timers and no wall-clock assertions: every transition below is driven
 * by a message, which is how the component actually receives them.
 */

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
  value: { ...(global.crypto || {}), randomUUID: () => `stream-uuid-${++uuidSeq}` },
  configurable: true,
});

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};

describe('chat streaming lifecycle (characterization)', () => {
  let listeners, calls, wrapper, view, sessionId;

  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)); };
  const emit = (message) => listeners.onMessage({ sessionId, message });
  const streamEvent = (event) => emit({ type: 'stream_event', event });

  const compacting = () => wrapper.querySelector('.chat-compacting-indicator');
  const marker = () => wrapper.querySelector('.chat-interrupted-marker');

  beforeEach(async () => {
    jest.resetModules();
    listeners = {};
    calls = [];
    window.electron_api = makeApiMock(listeners, calls);
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
  });

  // ── Interrupt ──

  describe('interrupting a turn', () => {
    it('asks main to interrupt the session the tab is on', () => {
      wrapper.querySelector('.chat-stop-btn').click();

      const interrupts = calls.filter(c => c.namespace === 'chat' && c.method === 'interrupt');
      expect(interrupts).toHaveLength(1);
      expect(interrupts[0].args[0]).toEqual({ sessionId });
    });

    it('stamps the marker only once the turn actually reports back', () => {
      wrapper.querySelector('.chat-stop-btn').click();
      // The request is in flight; the transcript says nothing yet.
      expect(marker()).toBeNull();

      listeners.onDone({ sessionId, interrupted: true });

      expect(marker()).toBeTruthy();
    });

    it('treats a locally-aborted turn as interrupted even when done says otherwise', () => {
      // `interrupted || isAborting` — main does not always echo the flag back,
      // so the local intent is what carries the marker.
      wrapper.querySelector('.chat-stop-btn').click();
      listeners.onDone({ sessionId, interrupted: false });

      expect(marker()).toBeTruthy();
    });

    it('leaves no marker on a turn that ended by itself', () => {
      listeners.onDone({ sessionId, interrupted: false });

      expect(marker()).toBeNull();
    });

    it('closes the running tool cards when the turn is cut short', () => {
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_0', name: 'Bash' } });
      streamEvent({ type: 'content_block_stop', index: 0 });
      const status = wrapper.querySelector('.chat-tool-card .chat-tool-status');
      expect(status.classList.contains('running')).toBe(true);

      wrapper.querySelector('.chat-stop-btn').click();
      listeners.onDone({ sessionId, interrupted: true });

      // Not left spinning: an unresolved card is indistinguishable from a hung one.
      expect(status.classList.contains('running')).toBe(false);
      expect(status.classList.contains('complete')).toBe(true);
    });

    it('clears the abort flag, so the next turn is not marked too', () => {
      wrapper.querySelector('.chat-stop-btn').click();
      listeners.onDone({ sessionId, interrupted: true });
      expect(wrapper.querySelectorAll('.chat-interrupted-marker')).toHaveLength(1);

      listeners.onDone({ sessionId, interrupted: false });

      expect(wrapper.querySelectorAll('.chat-interrupted-marker')).toHaveLength(1);
    });

    it('does nothing for a done addressed to another session', () => {
      wrapper.querySelector('.chat-stop-btn').click();
      listeners.onDone({ sessionId: 'someone-else', interrupted: true });

      expect(marker()).toBeNull();
    });
  });

  // ── Compaction ──

  describe('the compaction indicator', () => {
    const startCompacting = () => emit({ type: 'system', subtype: 'status', status: 'compacting' });
    const boundary = (meta) => emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: meta });

    it('goes up when the CLI says it is compacting', () => {
      startCompacting();

      expect(compacting()).toBeTruthy();
      expect(compacting().querySelector('.chat-compacting-label')).toBeTruthy();
    });

    it('never stacks two indicators', () => {
      startCompacting();
      startCompacting();

      expect(wrapper.querySelectorAll('.chat-compacting-indicator')).toHaveLength(1);
    });

    it('comes down at the boundary and leaves a notice behind', () => {
      startCompacting();
      boundary({ pre_tokens: 120000 });

      expect(compacting()).toBeNull();
      const notice = wrapper.querySelector('.chat-system-notice');
      expect(notice).toBeTruthy();
      // The pre-compaction figure is what makes the notice worth reading.
      expect(notice.textContent.replace(/[^0-9]/g, '')).toContain('120000');
    });

    it('still comes down when the boundary reports no figures', () => {
      // Older CLIs send a bare boundary; the indicator must not survive it.
      startCompacting();
      boundary(undefined);

      expect(compacting()).toBeNull();
      expect(wrapper.querySelector('.chat-system-notice')).toBeTruthy();
    });

    it('handles a boundary that arrives without a preceding compacting status', () => {
      boundary({ pre_tokens: 1000 });

      expect(compacting()).toBeNull();
      expect(wrapper.querySelector('.chat-system-notice')).toBeTruthy();
    });

    it('ignores compaction traffic for another session', () => {
      listeners.onMessage({ sessionId: 'someone-else', message: { type: 'system', subtype: 'status', status: 'compacting' } });

      expect(compacting()).toBeNull();
    });
  });
});
