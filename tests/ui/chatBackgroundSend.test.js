/**
 * A chat tab driven by an agent over MCP must leave the user's keyboard alone.
 *
 * The document has one focus and one selection. A chat tab moves both on its
 * own in three places: 100 ms after mounting it focuses its composer, sending
 * a message writes the text into that composer and puts the caret at its end
 * (a document selection, which Chromium follows with focus), and the end of a
 * turn focuses the composer again. An agent that opens tabs and sends prompts
 * (terminal_create, tab_send) triggered all three while the user was typing in
 * their own tab, so keystrokes went nowhere, or into the agent's tab.
 *
 * The user's field here is a contenteditable outside the chat, like another
 * tab's composer, with the caret in the middle of what they typed. Each case
 * also runs the user's own path (no `background`), which must keep moving
 * focus: that is what makes the background assertions mean something.
 */

function makeApi(listeners, calls) {
  return new Proxy({}, { get: (_t, ns) => new Proxy({}, {
    get: (_t, method) => (...args) => {
      if (typeof method === 'string' && method.startsWith('on')) {
        listeners[method] = args[0];
        return () => {};
      }
      calls.push({ ns, method, args });
      return Promise.resolve({ success: true, messages: [] });
    }
  }) });
}

Object.defineProperty(global, 'crypto', { value: { randomUUID: require('node:crypto').randomUUID }, configurable: true });
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};

let view, listeners, calls, wrapper, userField;

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  try { view?.destroy(); } catch (_) { /* teardown is best effort */ }
  view = null;
  jest.clearAllTimers();
  jest.useRealTimers();
});

/** The user mid-sentence in another tab: focus in their field, caret after "hel". */
function userIsTyping() {
  userField = document.createElement('div');
  userField.className = 'user-composer';
  userField.setAttribute('contenteditable', 'true');
  userField.textContent = 'hello world';
  document.body.appendChild(userField);
  userField.focus();
  const range = document.createRange();
  range.setStart(userField.firstChild, 3);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function expectUserUndisturbed() {
  expect(document.activeElement).toBe(userField);
  const sel = window.getSelection();
  expect(sel.rangeCount).toBe(1);
  expect(sel.anchorNode).toBe(userField.firstChild);
  expect(sel.anchorOffset).toBe(3);
  expect(sel.isCollapsed).toBe(true);
}

function mount(options = {}) {
  jest.resetModules();
  listeners = {};
  calls = [];
  window.electron_api = makeApi(listeners, calls);
  document.body.innerHTML = '';
  userIsTyping();
  wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper chat-wrapper';
  document.body.appendChild(wrapper);
  view = require('../../src/renderer/ui/components/ChatView')
    .createChatView(wrapper, { id: 'p', name: 'Fixture', path: '/tmp/fixture' }, options);
}

const composer = () => wrapper.querySelector('.chat-input');
const starts = () => calls.filter(c => c.ns === 'chat' && c.method === 'start');

describe('a chat tab opened by an agent', () => {
  it('does not focus its composer when it mounts', async () => {
    mount({ background: true });
    await jest.advanceTimersByTimeAsync(150);

    expectUserUndisturbed();
  });

  it('still focuses it when the user opened the tab', async () => {
    mount();
    await jest.advanceTimersByTimeAsync(150);

    expect(document.activeElement).toBe(composer());
  });

  it('sends an initial prompt without moving the caret', async () => {
    mount({ background: true, initialPrompt: 'from the agent' });
    await jest.advanceTimersByTimeAsync(150);

    expect(starts()).toHaveLength(1);
    expect(starts()[0].args[0].prompt).toBe('from the agent');
    expectUserUndisturbed();
  });
});

describe('a message an agent sends to a chat tab (tab_send)', () => {
  it('is sent without touching the user focus or caret', async () => {
    mount({ background: true });
    await jest.advanceTimersByTimeAsync(150);

    view.sendMessage('analyse auth/', [], [], { background: true });
    await jest.advanceTimersByTimeAsync(0);

    expect(starts()).toHaveLength(1);
    expect(starts()[0].args[0].prompt).toBe('analyse auth/');
    expectUserUndisturbed();
  });

  it('moves the caret when sent the ordinary way, which is why the flag exists', async () => {
    mount({ background: true });
    await jest.advanceTimersByTimeAsync(150);

    view.sendMessage('analyse auth/');

    expect(composer().contains(window.getSelection().anchorNode)).toBe(true);
  });

  it('does not pull focus back to its composer when its turn ends', async () => {
    mount({ background: true });
    await jest.advanceTimersByTimeAsync(150);
    view.sendMessage('analyse auth/', [], [], { background: true });
    await jest.advanceTimersByTimeAsync(0);
    const sessionId = view.getSessionId();

    listeners.onMessage({ sessionId, message: { type: 'result', subtype: 'success', result: 'done' } });
    await jest.advanceTimersByTimeAsync(0);

    expectUserUndisturbed();
  });

  it('still returns to the composer at the end of a turn when focus was in the chat', async () => {
    mount();
    await jest.advanceTimersByTimeAsync(150);
    view.sendMessage('mine');
    await jest.advanceTimersByTimeAsync(0);
    const sessionId = view.getSessionId();
    // The user clicked Stop's neighbour in the chat: focus is inside the tab.
    wrapper.querySelector('.chat-stop-btn').focus();

    listeners.onMessage({ sessionId, message: { type: 'result', subtype: 'success', result: 'done' } });
    await jest.advanceTimersByTimeAsync(0);

    expect(document.activeElement).toBe(composer());
  });
});
