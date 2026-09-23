/**
 * The "Enhanced" badge survives the pruner rebuilding its message.
 *
 * A user message carrying an enhanced prompt is marked `data-serializable`
 * like every other prose turn, so past `serializeAfter` the pruner holds it as
 * markup and rebuilds it from `outerHTML`. The badge used to carry a listener
 * bound to itself, which does not come back from that — leaving a dead toggle
 * and the original prompt permanently unreachable, invisible until someone
 * scrolled far enough up to click it.
 *
 * Asserted against the real delegated handler ChatView installs, not a copy of
 * it: a copy would keep passing if the branch were removed from the component.
 */

function makeApiMock(listeners) {
  const ns = () => new Proxy({}, {
    get: (_t, method) => (...args) => {
      if (typeof method === 'string' && method.startsWith('on')) {
        listeners[method] = args[0];
        return () => {};
      }
      return Promise.resolve({ success: true, messages: [] });
    }
  });
  return new Proxy({}, { get: ns });
}

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};

/** Exactly what appendUserMessage emits for an enhanced prompt. */
const ENHANCED_MARKUP = [
  '<span class="chat-msg-enhanced-badge" title="original">Enhanced</span>',
  '<div class="chat-msg-original" style="display:none">',
  '<div class="chat-msg-original-label">Original prompt</div>',
  '<div class="chat-msg-content">write me a haiku</div>',
  '</div>',
  '<div class="chat-msg-content">Please write me a haiku about autumn.</div>',
].join('');

describe('the enhanced-prompt badge is delegated, not bound', () => {
  let wrapper, view, messagesEl;

  beforeEach(() => {
    jest.resetModules();
    window.electron_api = makeApiMock({});
    document.body.innerHTML = '';
    wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const { createChatView } = require('../../src/renderer/ui/components/ChatView');
    view = createChatView(wrapper, { id: 'p1', name: 'Test', path: '/tmp/test' });
    messagesEl = wrapper.querySelector('.chat-messages');
    expect(messagesEl).toBeTruthy();
  });

  afterEach(() => {
    try { view?.destroy?.(); } catch (_) { /* teardown is best effort */ }
  });

  /** Put an enhanced user message in the transcript and hand it back. */
  function addEnhancedMessage() {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-user';
    el.dataset.serializable = '1';
    el.innerHTML = ENHANCED_MARKUP;
    messagesEl.appendChild(el);
    return el;
  }

  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  test('clicking the badge reveals the original prompt', () => {
    const msg = addEnhancedMessage();

    expect(msg.querySelector('.chat-msg-original').style.display).toBe('none');
    click(msg.querySelector('.chat-msg-enhanced-badge'));
    expect(msg.querySelector('.chat-msg-original').style.display).toBe('');
  });

  test('clicking it again hides it', () => {
    const msg = addEnhancedMessage();
    const badge = msg.querySelector('.chat-msg-enhanced-badge');

    click(badge);
    click(badge);
    expect(msg.querySelector('.chat-msg-original').style.display).toBe('none');
  });

  // The regression. Rebuilding from `outerHTML` is exactly what the pruner
  // does to a flattened entry, and it is where a per-element listener is lost.
  test('it still works on a message rebuilt from its own markup', () => {
    const original = addEnhancedMessage();
    const html = original.outerHTML;
    original.remove();

    const template = document.createElement('template');
    template.innerHTML = html;
    const rebuilt = template.content.firstElementChild;
    messagesEl.appendChild(rebuilt);

    click(rebuilt.querySelector('.chat-msg-enhanced-badge'));
    expect(rebuilt.querySelector('.chat-msg-original').style.display).toBe('');
  });

  test('a rebuilt message carries no listener of its own', () => {
    const msg = addEnhancedMessage();
    const spy = jest.spyOn(msg.querySelector('.chat-msg-enhanced-badge'), 'addEventListener');

    // Nothing in the component may reach back to bind one after the fact.
    messagesEl.appendChild(msg);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
