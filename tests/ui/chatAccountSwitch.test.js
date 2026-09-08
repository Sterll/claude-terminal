/**
 * Account switch after a usage limit — what the restart carries.
 *
 * The rule is "whatever the CLI never wrote down", and two different things can
 * fall under it.
 *
 * A message the CLI never answered: the offer leaves the composer usable, so a
 * follow-up can be sent while it is on screen and still be unanswered when the
 * switch aborts the process. Main hands those back.
 *
 * The turn that opened the tab, but only when a limit was refused before the
 * SDK's init message — no CLI session existed, so no session file holds it, and
 * it exists nowhere but the bubble on screen.
 *
 * Once a real session id exists the opposite holds for anything acknowledged:
 * it is already on disk, and sending it again would post the same message
 * twice.
 */

jest.mock('../../src/renderer/ui/components/AccountSwitchModal', () => ({
  showAccountSwitchModal: jest.fn(async () => 'acc-team'),
}));

/**
 * api mock: `on*` captures its callback, everything else records the call and
 * answers from `responses` (keyed `namespace.method`) or with a bare success.
 */
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

// jsdom ships no crypto.randomUUID; the send path tags each user message with one.
let uuidSeq = 0;
Object.defineProperty(global, 'crypto', {
  value: { ...(global.crypto || {}), randomUUID: () => `uuid-${++uuidSeq}` },
  configurable: true,
});

describe('chat account switch', () => {
  let listeners, calls, wrapper, view, sessionId, responses;

  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

  /** The options of the last chat.start — the restart the switch fired. */
  const lastStart = () => [...calls].reverse().find(c => c.namespace === 'chat' && c.method === 'start')?.args[0];

  /** Give the tab a real CLI session id, the way the SDK's first message does. */
  const giveSessionId = () => listeners.onMessage({
    sessionId,
    message: {
      type: 'assistant', session_id: 'real-uuid-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    },
  });

  const hitLimit = async () => {
    listeners.onAccountLimit({
      sessionId, error: 'Usage limit reached', activeAccountId: 'acc-max', projectId: null,
    });
    await flush();
  };

  beforeEach(async () => {
    jest.resetModules();
    listeners = {};
    calls = [];
    responses = {};
    window.electron_api = makeApiMock(listeners, calls, responses);
    document.body.innerHTML = '';
    wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const { createChatView } = require('../../src/renderer/ui/components/ChatView');
    view = createChatView(wrapper, { id: 'p1', name: 'Test', path: '/tmp/test' });
    view.sendMessage('contexte Salim');
    await flush();
    sessionId = view.getSessionId();
    expect(sessionId).toBeTruthy();
    expect(lastStart().prompt).toBe('contexte Salim');
  });

  afterEach(() => {
    try { view?.destroy?.(); } catch (_) { /* teardown is best effort */ }
  });

  it('resumes without resending once the SDK has given a session id', async () => {
    giveSessionId();

    await hitLimit();

    const restart = lastStart();
    expect(restart.accountId).toBe('acc-team');
    expect(restart.resumeSessionId).toBe('real-uuid-1');
    // The resumed transcript already holds it; sending it again would double it.
    expect(restart.prompt).toBe('');
  });

  it('resends a message that never got its turn, alongside the resume', async () => {
    giveSessionId();
    responses['chat.prepareSwitchAccount'] = {
      success: true,
      context: {
        cwd: '/tmp/test', projectId: 'p1', accountId: 'acc-max',
        pendingUserMessages: [{
          text: 'et maintenant les tests', images: [], mentions: [], userMessageUuid: 'uuid-9',
        }],
      },
    };

    await hitLimit();

    const restart = lastStart();
    expect(restart.resumeSessionId).toBe('real-uuid-1');
    expect(restart.prompt).toBe('et maintenant les tests');
    // Same uuid so the bubble already on screen is the one that gets recorded.
    expect(restart.userMessageUuid).toBe('uuid-9');
  });

  it('resends the opening turn when no session was ever written', async () => {
    // A limit refused before the SDK's init message: nothing on disk to resume,
    // so without this the prompt dies with the account that refused it.
    await hitLimit();

    const restart = lastStart();
    expect(restart.accountId).toBe('acc-team');
    expect(restart.resumeSessionId).toBeNull();
    expect(restart.prompt).toBe('contexte Salim');
  });

  it('prefers the unanswered message over the opening turn', async () => {
    // Both could apply. The queued one is the one the CLI never got to.
    responses['chat.prepareSwitchAccount'] = {
      success: true,
      context: {
        cwd: '/tmp/test', projectId: 'p1', accountId: 'acc-max',
        pendingUserMessages: [{
          text: 'en fait, annule', images: [], mentions: [], userMessageUuid: 'uuid-10',
        }],
      },
    };

    await hitLimit();

    expect(lastStart().prompt).toBe('en fait, annule');
  });

  it('sends the messages queued behind the first one too', async () => {
    giveSessionId();
    responses['chat.prepareSwitchAccount'] = {
      success: true,
      context: {
        cwd: '/tmp/test', projectId: 'p1', accountId: 'acc-max',
        pendingUserMessages: [
          { text: 'first', images: [], mentions: [], userMessageUuid: 'uuid-1a' },
          { text: 'second', images: [], mentions: [], userMessageUuid: 'uuid-1b' },
        ],
      },
    };

    await hitLimit();

    // A restart carries one prompt; the rest go back on the new session rather
    // than being dropped for being second.
    expect(lastStart().prompt).toBe('first');
    const sends = calls.filter(c => c.namespace === 'chat' && c.method === 'send');
    expect(sends.map(c => c.args[0].text)).toEqual(['second']);
  });
});
