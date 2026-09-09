/**
 * What the tab says when the CLI refuses a turn for a limit.
 *
 * One code covers several walls — `rate_limit` is the 429 for a five-hour
 * limit, a weekly limit and a spend cap alike — so the code alone cannot be
 * turned into a sentence. Only the CLI's own text says which limit was hit,
 * when it lifts, and what to do about it.
 *
 * And whatever it says, the offer to switch account has to survive being
 * closed: the account that ran out is still the one the tab is on.
 */

// `mock`-prefixed so the factory may close over it (jest hoists the mock above
// the declarations).
const mockSwitchModal = jest.fn(async () => null);
jest.mock('../../src/renderer/ui/components/AccountSwitchModal', () => ({
  showAccountSwitchModal: (...args) => mockSwitchModal(...args),
}));

function makeApiMock(listeners, calls, responses = {}) {
  const ns = (namespace) => new Proxy({}, {
    get: (_t, method) => (...args) => {
      if (typeof method === 'string' && method.startsWith('on')) {
        listeners[method] = args[0];
        return () => {};
      }
      calls.push({ namespace, method, args });
      return Promise.resolve(responses[`${namespace}.${method}`] || { success: true, messages: [] });
    }
  });
  return new Proxy({}, { get: (_t, namespace) => ns(namespace) });
}

let uuidSeq = 0;
Object.defineProperty(global, 'crypto', {
  value: { ...(global.crypto || {}), randomUUID: () => `uuid-${++uuidSeq}` },
  configurable: true,
});

const SPEND_CAP = "You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit · your session limit resets 3:10pm (Europe/Paris)";

describe('chat limit error', () => {
  let listeners, calls, wrapper, view, sessionId;

  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };
  const errors = () => [...document.querySelectorAll('.chat-error-content')].map(el => el.textContent);

  beforeEach(async () => {
    jest.resetModules();
    mockSwitchModal.mockClear();
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
  });

  afterEach(() => {
    try { view?.destroy?.(); } catch (_) { /* teardown is best effort */ }
  });

  it('keeps the sentence the CLI wrote instead of generic rate-limit advice', () => {
    listeners.onMessage({
      sessionId,
      message: {
        type: 'assistant',
        error: 'rate_limit',
        message: { role: 'assistant', content: [{ type: 'text', text: SPEND_CAP }] },
      },
    });

    // "Please wait a moment before sending another message" is advice that does
    // nothing for a spend cap, and it hides both the reset time and the way out.
    expect(errors()).toEqual([SPEND_CAP]);
  });

  it('falls back to our own phrasing when the frame carries no text', () => {
    listeners.onMessage({
      sessionId,
      message: { type: 'assistant', error: 'rate_limit', message: { role: 'assistant', content: [] } },
    });

    expect(errors()).toEqual(['Rate limit reached. Please wait a moment before sending another message.']);
  });

  it('leaves a way back to the switch when the offer is closed', async () => {
    listeners.onAccountLimit({
      sessionId, error: SPEND_CAP, activeAccountId: 'acc-max', projectId: null,
    });
    await flush();

    expect(mockSwitchModal).toHaveBeenCalledTimes(1);
    // Closing it used to end there: the only way back to the offer was to spend
    // another turn hitting the same wall.
    const action = document.querySelector('.chat-msg-error .chat-error-action');
    expect(action).toBeTruthy();

    action.click();
    await flush();
    expect(mockSwitchModal).toHaveBeenCalledTimes(2);
  });
});
