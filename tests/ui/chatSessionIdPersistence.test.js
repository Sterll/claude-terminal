/**
 * A chat tab keeps the CLI's session id it resumes on.
 *
 * `termData.claudeSessionId` is what a restart resumes. A chat view reports its
 * own ChatService id (`chat-<ts>-<rand>`) when a session starts, and that id
 * used to overwrite the CLI's. A fresh tab got the CLI's back with its first
 * message, but a tab woken from idle sleep (or restored, or switched from
 * terminal mode) resumes under the very id the view already knew, so nothing
 * wrote it back: the next restart resumed an id with no transcript and the tab
 * opened on an empty "Conversation resumed".
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
  return new Proxy({}, { get: () => ns() });
}

let uuidSeq = 0;
Object.defineProperty(global, 'crypto', {
  value: { ...(global.crypto || {}), randomUUID: () => `persist-uuid-${++uuidSeq}` },
  configurable: true,
});

if (!Element.prototype.scrollIntoView)Element.prototype.scrollIntoView = function () {};

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)); };

describe('noteChatSessionStart', () => {
  let terminals, noteChatSessionStart;

  beforeEach(() => {
    jest.resetModules();
    window.electron_api = makeApiMock({});
    terminals = require('../../src/renderer/state/terminals.state');
    ({ noteChatSessionStart } = require('../../src/renderer/ui/components/TerminalManager'));
  });

  test('gives a tab with no conversation yet the ChatService id', () => {
    terminals.addTerminal('t1', { mode: 'chat', project: { id: 'p1' } });
    noteChatSessionStart('t1', 'chat-1-abc');
    expect(terminals.getTerminal('t1').claudeSessionId).toBe('chat-1-abc');
  });

  test('never replaces the CLI id a tab already holds', () => {
    terminals.addTerminal('t1', { mode: 'chat', project: { id: 'p1' }, claudeSessionId: '51af0abb-cli' });
    noteChatSessionStart('t1', 'chat-2-def');
    expect(terminals.getTerminal('t1').claudeSessionId).toBe('51af0abb-cli');
  });
});

describe('ChatView writes the CLI id back to its tab', () => {
  let listeners, terminals, view;

  beforeEach(() => {
    jest.resetModules();
    listeners = {};
    window.electron_api = makeApiMock(listeners);
    document.body.innerHTML = '';
    terminals = require('../../src/renderer/state/terminals.state');
  });

  afterEach(() => {
    try { view?.destroy?.(); } catch (_) { /* best effort */ }
  });

  test('even when the CLI reports the id the view already knew', async () => {
    terminals.addTerminal('t1', { mode: 'chat', project: { id: 'p1' }, claudeSessionId: 'cli-A' });
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const { createChatView } = require('../../src/renderer/ui/components/ChatView');
    view = createChatView(wrapper, { id: 'p1', name: 'Test', path: '/tmp/test' }, {
      terminalId: 't1',
      resumeSessionId: 'cli-A',
      // What TerminalManager did before the fix: the tab loses its CLI id.
      onSessionStart: (sid) => terminals.updateTerminal('t1', { claudeSessionId: sid }),
    });
    await flush();

    const emit = (message) => listeners.onMessage({ sessionId: view.getSessionId(), message });

    view.sendMessage('first');
    await flush();
    emit({ type: 'assistant', session_id: 'cli-A', message: { content: [{ type: 'text', text: 'one' }] } });
    expect(terminals.getTerminal('t1').claudeSessionId).toBe('cli-A');

    // A second start under the same CLI id, as a wake from idle sleep does
    terminals.updateTerminal('t1', { claudeSessionId: 'chat-stand-in' });
    emit({ type: 'assistant', session_id: 'cli-A', message: { content: [{ type: 'text', text: 'two' }] } });
    expect(terminals.getTerminal('t1').claudeSessionId).toBe('cli-A');
  });
});
