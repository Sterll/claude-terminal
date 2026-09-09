/**
 * Which conversation the phone shows is the user's choice, not the desktop's.
 *
 * A session:started arrives in three very different situations — this device
 * asked for it, the reconnect replay is rebuilding state, or somebody opened a
 * tab on the desktop — and only the first two may move the user.
 */

const { loadPwa } = require('./harness');

let pwa;

function started(sessionId, projectId, tabName) {
  pwa.handleMessage({ type: 'session:started', data: { sessionId, projectId, tabName: tabName || sessionId } });
}

beforeEach(() => {
  pwa = loadPwa();
  pwa.state.projects = [
    { id: 'p1', name: 'Project One', path: '/tmp/p1' },
    { id: 'p2', name: 'Project Two', path: '/tmp/p2' },
  ];
});

describe('a session opened elsewhere does not steal the screen', () => {
  test('a new desktop tab in the same project leaves the selection alone', () => {
    pwa.enterProjectHub('p1');
    started('A', 'p1');
    expect(pwa.state.selectedSessionId).toBe('A');

    pwa.switchView('chat');
    started('B', 'p1');

    expect(pwa.state.selectedSessionId).toBe('A');
    expect(pwa.state.sessions.B).toBeDefined();
  });

  test('it does not drag the user off the view they chose', () => {
    pwa.enterProjectHub('p1');
    started('A', 'p1');
    pwa.switchView('git');

    started('B', 'p1');

    expect(pwa.state.currentView).toBe('git');
  });

  test('a chat:start fired by this device is followed', () => {
    pwa.enterProjectHub('p1');
    started('A', 'p1');
    pwa.switchView('sessions');

    pwa.state._followNextSession = true;
    started('B', 'p1');

    expect(pwa.state.selectedSessionId).toBe('B');
    expect(pwa.state.currentView).toBe('chat');
  });
});

describe('reconnect replay restores the open conversation', () => {
  test('the user lands back on what they were reading, not the last replayed', () => {
    pwa.enterProjectHub('p1');
    started('A', 'p1');
    started('B', 'p1');
    pwa.openSession('B');
    expect(pwa.state.selectedSessionId).toBe('B');

    // Socket drops and comes back: hello wipes state, then every session replays.
    pwa.handleMessage({ type: 'hello', data: {} });
    expect(pwa.state.sessions).toEqual({});

    started('A', 'p1');
    started('B', 'p1');
    started('C', 'p1');

    expect(pwa.state.selectedSessionId).toBe('B');
  });

  test('a conversation closed while offline falls back to the first replayed', () => {
    pwa.enterProjectHub('p1');
    started('A', 'p1');
    pwa.openSession('A');

    pwa.handleMessage({ type: 'hello', data: {} });
    started('X', 'p1');
    started('Y', 'p1');

    expect(pwa.state.selectedSessionId).toBe('X');
  });
});

describe('sessions are not grafted onto the wrong project', () => {
  test('an event for an unknown session does not inherit the viewed project', () => {
    pwa.enterProjectHub('p1');
    started('A', 'p1');
    pwa.openSession('A');

    // A stray event with no projectId, e.g. arriving before its session:started.
    pwa.handleMessage({
      type: 'chat-message',
      data: { sessionId: 'stray', message: { type: 'result' } },
    });

    expect(pwa.state.sessions.stray.projectId).toBeNull();
    expect(pwa.state.selectedSessionId).toBe('A');
  });

  test('chat-idle attributes the session from its own payload', () => {
    pwa.enterProjectHub('p1');
    pwa.handleMessage({ type: 'chat-idle', data: { sessionId: 'Z', projectId: 'p2' } });

    expect(pwa.state.sessions.Z.projectId).toBe('p2');
  });
});
