/**
 * Model and effort belong to the conversation, not to the app. The desktop
 * treats them that way; the PWA drives the same sessions and held one global
 * pair, so the menu could claim Opus for a conversation still running Sonnet
 * purely because Opus was the last thing picked somewhere else.
 */

const { loadPwa, teardownPwa } = require('./harness');

let pwa;
let sent;

/** Capture outbound frames and pretend the socket accepted them. */
function captureSocket(accept = true) {
  sent = [];
  pwa.conn.ws = {
    readyState: accept ? 1 : 3,
    send(raw) { sent.push(JSON.parse(raw)); },
    close() {},
  };
}

function seed(sessionId) {
  pwa.state.sessions[sessionId] = pwa._makeSession(sessionId, 'p1', sessionId, []);
  return pwa.state.sessions[sessionId];
}

beforeEach(() => {
  pwa = loadPwa();
  pwa.state.projects = [{ id: 'p1', name: 'Project One', path: '/tmp/p1' }];
  pwa.state.selectedProjectId = 'p1';
  pwa.switchView('chat');
  captureSocket();
});

afterEach(() => {
  teardownPwa(pwa);
});

describe('a pick applies to the open conversation only', () => {
  test('switching back shows each conversation its own model', () => {
    seed('A');
    seed('B');

    pwa.openSession('A');
    pwa._selectModel('claude-opus-5');

    pwa.openSession('B');
    expect(pwa._currentModel()).not.toBe('claude-opus-5');

    pwa.openSession('A');
    expect(pwa._currentModel()).toBe('claude-opus-5');
  });

  test('it does not become the default for new conversations', () => {
    seed('A');
    pwa.openSession('A');
    const before = pwa.state.defaultModel;

    pwa._selectModel('claude-opus-5');

    expect(pwa.state.defaultModel).toBe(before);
  });

  test('the desktop is told which session changed', () => {
    seed('A');
    pwa.openSession('A');
    sent.length = 0;

    pwa._selectEffort('low');

    expect(sent).toEqual([expect.objectContaining({
      type: 'settings:update',
      data: { sessionId: 'A', effort: 'low' },
    })]);
  });

  test('a change that never left the device is not shown as applied', () => {
    const session = seed('A');
    pwa.openSession('A');
    captureSocket(false); // socket down

    pwa._selectModel('claude-opus-5');

    expect(session.model).toBeNull();
    expect(pwa._currentModel()).not.toBe('claude-opus-5');
  });
});

describe('with no conversation open', () => {
  test('a pick sets the default the next one starts from', () => {
    pwa.state.selectedSessionId = null;

    pwa._selectModel('claude-haiku-4-5-20251001');

    expect(pwa.state.defaultModel).toBe('claude-haiku-4-5-20251001');
    expect(sent).toEqual([]);
  });

  test('hello carries the desktop defaults, not a session override', () => {
    const session = seed('A');
    session.model = 'claude-opus-5';
    pwa.openSession('A');

    pwa.handleMessage({ type: 'hello', data: { chatModel: 'claude-sonnet-5' } });

    expect(pwa.state.defaultModel).toBe('claude-sonnet-5');
  });
});
