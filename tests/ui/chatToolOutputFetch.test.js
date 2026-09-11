/**
 * Replayed tool cards fetch the rest of their output when expanded.
 *
 * History ships a 2 KB preview of each tool result — the whole thing would put
 * the transcript back on the IPC wire — so a resumed conversation used to show
 * the first 2 KB of a tool's output and silently drop the rest. A card that was
 * clipped now says so and reads the full text back from the session file the
 * first time the user opens it.
 */

let uuidSeq = 0;
Object.defineProperty(global, 'crypto', {
  value: { ...(global.crypto || {}), randomUUID: () => `tool-out-${++uuidSeq}` },
  configurable: true,
});

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};

const SESSION = 'sess-with-history';
const BIG = 'y'.repeat(60000);

/** The replayed turn: one Bash call whose result was clipped to 2 KB. */
function historyMessages() {
  return [
    { role: 'user', text: 'run it', uuid: 'u-0' },
    { role: 'assistant', type: 'tool_use', toolName: 'Bash', toolInput: { command: 'echo hi' }, toolUseId: 'toolu_1' },
    { role: 'tool_result', toolUseId: 'toolu_1', output: BIG.slice(0, 2000), outputTruncated: true, outputLength: BIG.length },
    { role: 'assistant', type: 'tool_use', toolName: 'Bash', toolInput: { command: 'echo small' }, toolUseId: 'toolu_2' },
    { role: 'tool_result', toolUseId: 'toolu_2', output: 'small output' },
  ];
}

/**
 * api mock: `on*` captures its callback, `chat.loadHistory` replays the turn
 * above, `chat.loadToolOutput` answers whatever the test set up.
 */
function makeApiMock(listeners, toolOutput) {
  const ns = (name) => new Proxy({}, {
    get: (_t, method) => (...args) => {
      if (typeof method === 'string' && method.startsWith('on')) {
        listeners[method] = args[0];
        return () => {};
      }
      if (name === 'chat' && method === 'loadHistory') {
        return Promise.resolve({ success: true, messages: historyMessages(), total: null, truncated: false, contextTokens: 0 });
      }
      if (name === 'chat' && method === 'loadToolOutput') {
        toolOutput.calls.push(args[0]);
        return toolOutput.reply();
      }
      return Promise.resolve({ success: true, messages: [] });
    }
  });
  return new Proxy({}, { get: (_t, name) => ns(name) });
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('expanding a replayed tool card', () => {
  let listeners, wrapper, view, toolOutput;

  const cardFor = (id) => wrapper.querySelector(`.chat-tool-card[data-tool-use-id="${id}"]`);

  beforeEach(async () => {
    jest.resetModules();
    listeners = {};
    toolOutput = {
      calls: [],
      reply: () => Promise.resolve({ success: true, output: BIG, length: BIG.length, truncated: false })
    };
    window.electron_api = makeApiMock(listeners, toolOutput);
    document.body.innerHTML = '';
    wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const { createChatView } = require('../../src/renderer/ui/components/ChatView');
    view = createChatView(wrapper, { id: 'p1', name: 'Test', path: '/tmp/test' }, { resumeSessionId: SESSION });
    // The replay is time-sliced; this turn of the loop is enough for one batch.
    await flush();
    await flush();
  });

  afterEach(() => {
    try { view?.destroy?.(); } catch (_) { /* teardown is best effort */ }
  });

  it('marks the clipped card, and only the clipped one', () => {
    expect(cardFor('toolu_1').dataset.toolOutputTruncated).toBe('1');
    expect(cardFor('toolu_1').dataset.toolOutputLength).toBe(String(BIG.length));
    expect(cardFor('toolu_1').classList.contains('expandable')).toBe(true);
    expect(cardFor('toolu_2').dataset.toolOutputTruncated).toBeUndefined();
  });

  it('asks the main process for the rest, naming the transcript it replayed', async () => {
    cardFor('toolu_1').click();
    await flush();

    expect(toolOutput.calls).toEqual([{ projectPath: '/tmp/test', sessionId: SESSION, toolUseId: 'toolu_1' }]);
    // The Bash card shows the first 30 lines of what it was given; a single
    // 60000-character line means the full text reached the formatter.
    expect(cardFor('toolu_1').querySelector('.chat-tool-output pre').textContent).toBe(BIG);
    expect(cardFor('toolu_1').classList.contains('expanded')).toBe(true);
  });

  it('does not ask twice for the same card', async () => {
    const card = cardFor('toolu_1');
    card.click();            // loads
    await flush();
    card.click();            // collapse
    card.click();            // re-expand
    await flush();

    expect(toolOutput.calls).toHaveLength(1);
  });

  it('never asks for a card whose result arrived whole', async () => {
    cardFor('toolu_2').click();
    await flush();

    expect(toolOutput.calls).toHaveLength(0);
    expect(cardFor('toolu_2').querySelector('.chat-tool-output pre').textContent).toBe('small output');
  });

  it('keeps the preview and says so when the fetch fails', async () => {
    toolOutput.reply = () => Promise.resolve({ success: false, error: 'Tool result not found' });
    cardFor('toolu_1').click();
    await flush();

    const card = cardFor('toolu_1');
    expect(card.querySelector('.chat-tool-output-notice.error')).not.toBeNull();
    expect(card.querySelector('.chat-tool-output pre').textContent).toBe(BIG.slice(0, 2000));
    expect(card.classList.contains('expanded')).toBe(true);
  });

  it('survives a rejected fetch the same way', async () => {
    toolOutput.reply = () => Promise.reject(new Error('ipc gone'));
    cardFor('toolu_1').click();
    await flush();

    const card = cardFor('toolu_1');
    expect(card.querySelector('.chat-tool-output-notice.error')).not.toBeNull();
    expect(card.querySelector('.chat-tool-output pre').textContent).toBe(BIG.slice(0, 2000));
  });

  it('says the output is still clipped when it was too large to send whole', async () => {
    toolOutput.reply = () => Promise.resolve({ success: true, output: BIG, length: BIG.length * 100, truncated: true });
    cardFor('toolu_1').click();
    await flush();

    const notice = cardFor('toolu_1').querySelector('.chat-tool-output-notice');
    expect(notice).not.toBeNull();
    expect(notice.classList.contains('error')).toBe(false);
  });
});
