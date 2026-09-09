/**
 * renderChatMessages() rebuilds the entire transcript, which is what makes both
 * the scroll anchor and the tool-card expansion fragile: any state kept only in
 * the DOM is destroyed on the next event.
 */

const { loadPwa, teardownPwa } = require('./harness');

let pwa;

/** jsdom reports zero for every layout box, so fake the geometry we read. */
function stubGeometry(container, { scrollHeight, clientHeight }) {
  Object.defineProperty(container, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: clientHeight, configurable: true });
}

function seed(sessionId) {
  const s = pwa._makeSession(sessionId, 'p1', sessionId, []);
  pwa.state.sessions[sessionId] = s;
  return s;
}

beforeEach(() => {
  pwa = loadPwa();
  pwa.state.projects = [{ id: 'p1', name: 'Project One', path: '/tmp/p1' }];
  pwa.state.selectedProjectId = 'p1';
  pwa.switchView('chat');
});

afterEach(() => {
  teardownPwa(pwa);
});

describe('scroll anchoring', () => {
  test('a reader at the tail keeps following the stream', () => {
    const session = seed('A');
    session.messages.push({ role: 'assistant', content: 'hello' });
    pwa.openSession('A');

    const container = document.getElementById('chat-messages');
    stubGeometry(container, { scrollHeight: 1000, clientHeight: 400 });
    container.scrollTop = 600; // pinned to the bottom

    session.messages.push({ role: 'assistant', content: 'more' });
    pwa.renderChatMessages();

    expect(container.scrollTop).toBe(container.scrollHeight);
  });

  test('a reader scrolled up is not dragged to the bottom', () => {
    const session = seed('A');
    session.messages.push({ role: 'assistant', content: 'hello' });
    pwa.openSession('A');

    const container = document.getElementById('chat-messages');
    stubGeometry(container, { scrollHeight: 1000, clientHeight: 400 });
    container.scrollTop = 100; // reading back through the history

    session.messages.push({ role: 'assistant', content: 'more' });
    pwa.renderChatMessages();

    expect(container.scrollTop).toBe(100);
  });
});

describe('tool card expansion', () => {
  test('an expanded card survives the next event', () => {
    const session = seed('A');
    session.messages.push({
      role: 'tool', toolId: 't1', toolName: 'Bash', content: 'Bash',
      toolInput: { command: 'ls -la' }, toolOutput: 'a\nb', status: 'complete',
    });
    pwa.openSession('A');

    const card = document.querySelector('.tool-card');
    card.click();
    expect(card.classList.contains('expanded')).toBe(true);

    // Anything else arriving rebuilds the transcript.
    session.messages.push({ role: 'assistant', content: 'done' });
    pwa.renderChatMessages();

    const rebuilt = document.querySelector('.tool-card');
    expect(rebuilt.classList.contains('expanded')).toBe(true);
    // The command is syntax-highlighted, so assert on the block, not the raw string.
    expect(rebuilt.querySelector('.tool-expand-content .tool-code')).not.toBeNull();
  });

  test('collapsing it sticks too', () => {
    const session = seed('A');
    session.messages.push({
      role: 'tool', toolId: 't1', toolName: 'Bash', content: 'Bash',
      toolInput: { command: 'ls' }, status: 'complete',
    });
    pwa.openSession('A');

    const card = document.querySelector('.tool-card');
    card.click();
    card.click();

    pwa.renderChatMessages();
    expect(document.querySelector('.tool-card').classList.contains('expanded')).toBe(false);
  });
});

describe('replay batching', () => {
  test('nothing is drawn until the burst is over', () => {
    seed('A');
    pwa.openSession('A');
    const container = document.getElementById('chat-messages');

    pwa.handleMessage({ type: 'replay:start', data: { sessions: 1 } });
    for (let i = 0; i < 50; i++) {
      pwa.handleMessage({
        type: 'chat-message',
        data: {
          sessionId: 'A',
          message: { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        },
      });
    }
    pwa.state.sessions.A.messages.push({ role: 'assistant', content: 'replayed' });
    expect(container.textContent).not.toContain('replayed');

    pwa.handleMessage({ type: 'replay:end', data: {} });
    expect(container.textContent).toContain('replayed');
  });

  test('a replay cut short by a dead socket still releases the UI', () => {
    jest.useFakeTimers();
    seed('A');
    pwa.openSession('A');

    pwa.handleMessage({ type: 'replay:start', data: { sessions: 3 } });
    pwa.state.sessions.A.messages.push({ role: 'assistant', content: 'stranded' });

    jest.advanceTimersByTime(15_000);

    expect(document.getElementById('chat-messages').textContent).toContain('stranded');
    jest.useRealTimers();
  });
});
