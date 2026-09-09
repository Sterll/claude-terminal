/**
 * The chat's shared chrome must describe the conversation on screen.
 *
 * The thinking indicator and the composer are single DOM elements reused by
 * every conversation. Before this was scoped, a background session drove both:
 * it flipped the visible composer back to "send" mid-turn, and it left a spinner
 * that could never be cleared because _setThinking() ignores unselected
 * sessions. That is what "you see the old conversation writing" looked like.
 */

const { loadPwa, teardownPwa, interruptVisible, thinkingVisible } = require('./harness');

let pwa;

/** Register a session the way the desktop's replay would, without side effects. */
function seed(pwa, sessionId, projectId) {
  pwa.state.sessions[sessionId] = pwa._makeSession(sessionId, projectId, sessionId, []);
  return pwa.state.sessions[sessionId];
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

describe('composer state is per conversation', () => {
  test('a background session does not steal the visible composer', () => {
    seed(pwa, 'A', 'p1');
    seed(pwa, 'B', 'p1');

    pwa.openSession('B');
    pwa.setInputState('B', 'sending');
    expect(interruptVisible()).toBe(true);

    // A finishes while the user is reading B. B is still running.
    pwa.setInputState('A', 'idle');

    expect(interruptVisible()).toBe(true);
    expect(pwa.state.sessions.B.running).toBe(true);
    expect(pwa.state.sessions.A.running).toBe(false);
  });

  test('switching restores the target session own state', () => {
    seed(pwa, 'A', 'p1');
    seed(pwa, 'B', 'p1');

    pwa.setInputState('A', 'sending');
    pwa.openSession('A');
    expect(interruptVisible()).toBe(true);

    pwa.openSession('B');
    expect(interruptVisible()).toBe(false);

    pwa.openSession('A');
    expect(interruptVisible()).toBe(true);
  });

  test('a chat:start with no session yet still drives the composer', () => {
    pwa.setInputState(null, 'sending');
    expect(interruptVisible()).toBe(true);
  });
});

describe('thinking indicator is per conversation', () => {
  test('it does not survive a switch to another conversation', () => {
    seed(pwa, 'A', 'p1');
    seed(pwa, 'B', 'p1');

    pwa.openSession('A');
    pwa._setThinking('A', true);
    expect(thinkingVisible()).toBe(true);

    pwa.openSession('B');
    expect(thinkingVisible()).toBe(false);
  });

  test('a spinner left by an unselected session cannot get stuck', () => {
    seed(pwa, 'A', 'p1');
    seed(pwa, 'B', 'p1');

    pwa.openSession('A');
    pwa._setThinking('A', true);
    pwa.openSession('B');

    // A finishes off-screen. Coming back to it must show it as settled.
    pwa._setThinking('A', false);
    pwa.openSession('A');

    expect(thinkingVisible()).toBe(false);
  });

  test('coming back to a still-thinking session shows the spinner again', () => {
    seed(pwa, 'A', 'p1');
    seed(pwa, 'B', 'p1');

    pwa.openSession('A');
    pwa._setThinking('A', true);
    pwa.openSession('B');
    pwa.openSession('A');

    expect(thinkingVisible()).toBe(true);
  });
});

describe('the session picker rebuilds the whole body', () => {
  test('changing the select syncs composer and spinner', () => {
    seed(pwa, 'A', 'p1');
    const b = seed(pwa, 'B', 'p1');
    b.running = true;
    b.thinking = true;

    pwa.openSession('A');
    expect(interruptVisible()).toBe(false);

    const select = document.getElementById('session-select');
    select.value = 'B';
    select.dispatchEvent(new window.Event('change'));

    expect(pwa.state.selectedSessionId).toBe('B');
    expect(interruptVisible()).toBe(true);
    expect(thinkingVisible()).toBe(true);
  });
});
