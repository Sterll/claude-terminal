/**
 * Context handoff: past the threshold set in the chat settings, the session
 * writes a handoff summary as one more turn, and the tab carries on in a new
 * session that opens on it.
 *
 * What has to hold: it never fires mid-turn nor below the threshold; the
 * summary request goes to the old session; the old session is closed and the
 * next message opens a new one (no resume) carrying the summary; a message
 * typed while the summary is being written opens that session itself rather
 * than landing in the old one; a stopped summary leaves the tab where it was.
 */

const {
  normalizeHandoffThreshold,
  autoCompactWindowFor,
  buildHandoffRequest,
  parseHandoffRequest,
  buildHandoffSeed,
  parseHandoffSeed,
  DEFAULT_HANDOFF_THRESHOLD,
  MIN_HANDOFF_THRESHOLD,
} = require('../../src/renderer/ui/components/chat/contextHandoff');

describe('context handoff prompts', () => {
  it('normalizes the threshold', () => {
    expect(normalizeHandoffThreshold(800000)).toBe(800000);
    expect(normalizeHandoffThreshold('junk')).toBe(DEFAULT_HANDOFF_THRESHOLD);
    expect(normalizeHandoffThreshold(0)).toBe(DEFAULT_HANDOFF_THRESHOLD);
    expect(normalizeHandoffThreshold(1000)).toBe(MIN_HANDOFF_THRESHOLD);
  });

  it('puts the CLI compaction a margin above the threshold, inside what the CLI accepts', () => {
    expect(autoCompactWindowFor(500000)).toBe(550000);
    expect(autoCompactWindowFor(MIN_HANDOFF_THRESHOLD)).toBe(100000);
    expect(autoCompactWindowFor(950000)).toBe(1000000);
  });

  it('recognizes its own request, and nothing else', () => {
    expect(parseHandoffRequest(buildHandoffRequest(612345))).toEqual({ tokens: 612345 });
    expect(parseHandoffRequest('please summarize <context-handoff-request />')).toBeNull();
    expect(parseHandoffRequest(undefined)).toBeNull();
  });

  it('round-trips a seed, with the typed text first', () => {
    const prompt = buildHandoffSeed({
      text: 'next step please',
      summary: '## Goal\nShip it.\n\n## Next steps\n- Test',
      previousSessionId: 'abc-123',
      tokens: 512000,
    });
    // First, so the session list titles the conversation by what was typed
    expect(prompt.startsWith('next step please\n\n<context-handoff ')).toBe(true);
    expect(parseHandoffSeed(prompt)).toEqual({
      text: 'next step please',
      summary: '## Goal\nShip it.\n\n## Next steps\n- Test',
      previousSessionId: 'abc-123',
      tokens: 512000,
    });
  });

  it('keeps an id to what an id is made of', () => {
    const prompt = buildHandoffSeed({ summary: 's', previousSessionId: 'x" onload="y', tokens: 1 });
    expect(prompt).toContain('previous-session="xonloady"');
    expect(parseHandoffSeed(prompt).text).toBe('');
  });

  it('does not mistake an ordinary message for a seed', () => {
    expect(parseHandoffSeed('hello')).toBeNull();
    expect(parseHandoffSeed('<context-handoff previous-session="a" tokens="1">\nno closing tag')).toBeNull();
  });
});

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
  value: { ...(global.crypto || {}), randomUUID: () => `uuid-${++uuidSeq}` },
  configurable: true,
});

describe('chat context handoff', () => {
  let listeners, calls, wrapper, view, settings;

  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };
  const callsOf = (method) => calls.filter(c => c.namespace === 'chat' && c.method === method);
  const lastStart = () => callsOf('start').at(-1)?.args[0];
  const requests = () => callsOf('send').filter(c => parseHandoffRequest(c.args[0].text));
  const notices = () => [...wrapper.querySelectorAll('.chat-system-notice-text')].map(el => el.textContent);

  /** One turn: an assistant frame carrying the window's occupancy, then its result. */
  const turn = async (contextTokens, result = 'done') => {
    const sid = view.getSessionId();
    listeners.onMessage({
      sessionId: sid,
      message: {
        type: 'assistant', session_id: 'real-uuid-1',
        message: { role: 'assistant', content: [{ type: 'text', text: result }], usage: { input_tokens: 10, cache_read_input_tokens: contextTokens } },
      },
    });
    listeners.onMessage({ sessionId: sid, message: { type: 'result', subtype: 'success', result } });
    await flush();
  };

  beforeEach(async () => {
    jest.resetModules();
    listeners = {};
    calls = [];
    window.electron_api = makeApiMock(listeners, calls);
    document.body.innerHTML = '';
    wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    settings = require('../../src/renderer/state/settings.state');
    settings.setSetting('contextHandoffEnabled', true);
    settings.setSetting('contextHandoffThreshold', 500000);
    const { createChatView } = require('../../src/renderer/ui/components/ChatView');
    view = createChatView(wrapper, { id: 'p1', name: 'Test', path: '/tmp/test' });
    view.sendMessage('build the thing');
    await flush();
  });

  afterEach(() => {
    try { view?.destroy?.(); } catch (_) { /* best effort */ }
  });

  it('hands the CLI a compaction window a margin above the threshold', async () => {
    // The opening start, made in beforeEach with the handoff on
    expect(lastStart().autoCompactWindow).toBe(550000);
  });

  it('leaves the CLI its own compaction window when the handoff is off', async () => {
    settings.setSetting('contextHandoffEnabled', false);
    const { createChatView } = require('../../src/renderer/ui/components/ChatView');
    const other = createChatView(document.createElement('div'), { id: 'p2', name: 'Other', path: '/tmp/other' });
    other.sendMessage('hello');
    await flush();
    expect(lastStart().autoCompactWindow).toBeNull();
    other.destroy();
  });

  it("shows a subagent's own context on its card, apart from the main gauge", async () => {
    const sid = view.getSessionId();
    listeners.onMessage({ sessionId: sid, message: { type: 'stream_event', event: { type: 'message_start', message: {} } } });
    listeners.onMessage({ sessionId: sid, message: { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_agent', name: 'Agent' } } } });
    listeners.onMessage({
      sessionId: sid,
      message: {
        type: 'assistant', parent_tool_use_id: 'toolu_agent', session_id: 'real-uuid-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'reading' }], usage: { input_tokens: 5, cache_read_input_tokens: 600000 } },
      },
    });
    await flush();
    const badge = wrapper.querySelector('.chat-subagent-card .chat-subagent-context');
    expect(badge?.textContent).toBe('600k');
    // Its window is not the conversation's: no handoff off a subagent's size
    listeners.onMessage({ sessionId: sid, message: { type: 'result', subtype: 'success', result: 'ok' } });
    await flush();
    expect(requests()).toHaveLength(0);
  });

  it('does nothing below the threshold', async () => {
    await turn(300000);
    expect(requests()).toHaveLength(0);
  });

  it('does nothing when the setting is off', async () => {
    settings.setSetting('contextHandoffEnabled', false);
    await turn(600000);
    expect(requests()).toHaveLength(0);
  });

  it('asks the old session for a summary, then opens a new session on it', async () => {
    const oldSession = view.getSessionId();
    await turn(600000);

    expect(requests()).toHaveLength(1);
    expect(requests()[0].args[0].sessionId).toBe(oldSession);
    // Not a bubble: the user never typed it
    expect(wrapper.querySelectorAll('.chat-msg-user')).toHaveLength(1);

    await turn(600500, '## Goal\nBuild the thing.');
    expect(callsOf('close').map(c => c.args[0].sessionId)).toContain(oldSession);
    expect(view.getSessionId()).toBeNull();
    expect(wrapper.querySelector('.chat-handoff-divider')).not.toBeNull();

    view.sendMessage('now test it');
    await flush();
    const start = lastStart();
    expect(start.resumeSessionId).toBeUndefined();
    const seed = parseHandoffSeed(start.prompt);
    expect(seed).toEqual({ text: 'now test it', summary: '## Goal\nBuild the thing.', previousSessionId: 'real-uuid-1', tokens: 600010 });
    expect(view.getSessionId()).not.toBe(oldSession);
    // The bubble shows what was typed, not the summary
    expect(wrapper.querySelectorAll('.chat-msg-user')[1].textContent).toContain('now test it');
    expect(wrapper.querySelectorAll('.chat-msg-user')[1].textContent).not.toContain('Build the thing');
  });

  it('opens the new session with a message typed while the summary was being written', async () => {
    await turn(600000);
    const startsBefore = callsOf('start').length;
    view.sendMessage('typed meanwhile');
    await flush();
    // Held: not sent to the session that is about to be closed
    expect(callsOf('send').some(c => c.args[0].text === 'typed meanwhile')).toBe(false);

    await turn(600500, 'the summary');
    expect(callsOf('start')).toHaveLength(startsBefore + 1);
    const seed = parseHandoffSeed(lastStart().prompt);
    expect(seed.text).toBe('typed meanwhile');
    expect(seed.summary).toBe('the summary');
  });

  it('stays on the session, and does not try again, when the summary is stopped', async () => {
    const oldSession = view.getSessionId();
    await turn(600000);
    view.sendMessage('typed meanwhile');
    await flush();

    listeners.onDone({ sessionId: oldSession, interrupted: true });
    await flush();
    expect(view.getSessionId()).toBe(oldSession);
    expect(callsOf('close')).toHaveLength(0);
    expect(notices().some(n => n.includes('chat.handoffFailed') || /handoff/i.test(n))).toBe(true);
    // What was typed meanwhile goes to the session that is still there
    expect(callsOf('send').some(c => c.args[0].text === 'typed meanwhile' && c.args[0].sessionId === oldSession)).toBe(true);

    await turn(700000);
    expect(requests()).toHaveLength(1);
  });

  it('waits while a message is queued behind the turn', async () => {
    // A follow-up typed during the turn is in the CLI's queue: closing the
    // session now would drop it.
    listeners.onMessage({ sessionId: view.getSessionId(), message: { type: 'stream_event', event: { type: 'message_start', message: {} } } });
    view.sendMessage('queued follow-up');
    await flush();
    await turn(600000);
    expect(requests()).toHaveLength(0);
  });
});
