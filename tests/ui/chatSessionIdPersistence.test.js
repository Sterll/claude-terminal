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
 *
 * The tab's name has the same problem one step earlier: a fresh tab is named
 * from its first prompt while it still holds the handle, so the name was filed
 * under the handle and the sessions list, which only knows CLI ids, lost it.
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

describe('ChatView tells its tab which id the CLI id replaces', () => {
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

  test('once, with the handle a fresh tab held', async () => {
    terminals.addTerminal('t1', { mode: 'chat', project: { id: 'p1' } });
    const { noteChatSessionStart } = require('../../src/renderer/ui/components/TerminalManager');
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const { createChatView } = require('../../src/renderer/ui/components/ChatView');
    const onCliSessionId = jest.fn();
    view = createChatView(wrapper, { id: 'p1', name: 'Test', path: '/tmp/test' }, {
      terminalId: 't1',
      onSessionStart: (sid) => noteChatSessionStart('t1', sid),
      onCliSessionId,
    });
    await flush();

    view.sendMessage('first');
    await flush();
    const handle = terminals.getTerminal('t1').claudeSessionId;
    expect(handle).toMatch(/^chat-/);

    const emit = (message) => listeners.onMessage({ sessionId: view.getSessionId(), message });
    emit({ type: 'assistant', session_id: 'cli-A', message: { content: [{ type: 'text', text: 'one' }] } });
    emit({ type: 'assistant', session_id: 'cli-A', message: { content: [{ type: 'text', text: 'two' }] } });

    expect(onCliSessionId).toHaveBeenCalledTimes(1);
    expect(onCliSessionId).toHaveBeenCalledWith('cli-A', handle);
  });
});

describe('_carrySessionName', () => {
  let tm, written;

  /** A TerminalManager over a fake session-names.json. */
  const withNamesOnDisk = (names) => {
    jest.resetModules();
    window.electron_api = makeApiMock({});
    const { TerminalManager } = require('../../src/renderer/ui/components/TerminalManager');
    tm = new TerminalManager();
    tm._namesCache = null;
    tm._fsp = {
      readFile: jest.fn(async () => JSON.stringify(names)),
      writeFile: jest.fn(async (_path, data) => { written = JSON.parse(data); }),
    };
    return tm;
  };

  beforeEach(() => { written = null; });

  test('moves the name filed under the handle to the CLI id', async () => {
    withNamesOnDisk({ 'chat-1-abc': { name: 'Sessions vides', custom: false } });

    await tm._carrySessionName('chat-1-abc', 'cli-A');

    expect(written).toEqual({ 'cli-A': { name: 'Sessions vides', custom: false } });
  });

  test('a name the user chose replaces an auto name already on the CLI id', async () => {
    withNamesOnDisk({
      'chat-1-abc': { name: 'Design Ripple', custom: true },
      'cli-A': { name: 'Ripple tokens', custom: false },
    });

    await tm._carrySessionName('chat-1-abc', 'cli-A');

    expect(written).toEqual({ 'cli-A': { name: 'Design Ripple', custom: true } });
  });

  test('never replaces a name the user chose on the CLI id', async () => {
    withNamesOnDisk({
      'chat-1-abc': { name: 'Ripple tokens', custom: false },
      'cli-A': { name: 'Design Ripple', custom: true },
    });

    await tm._carrySessionName('chat-1-abc', 'cli-A');

    expect(written).toEqual({ 'cli-A': { name: 'Design Ripple', custom: true } });
  });

  test('leaves a CLI id replaced by another (/clear) with its own name', async () => {
    withNamesOnDisk({ 'cli-A': { name: 'First conversation', custom: false } });

    await tm._carrySessionName('cli-A', 'cli-B');

    expect(tm._fsp.writeFile).not.toHaveBeenCalled();
  });

  test('writes nothing when the handle has no name', async () => {
    withNamesOnDisk({ 'cli-A': { name: 'Other', custom: false } });

    await tm._carrySessionName('chat-1-abc', 'cli-B');
    await tm._carrySessionName(null, 'cli-B');

    expect(tm._fsp.writeFile).not.toHaveBeenCalled();
  });
});
