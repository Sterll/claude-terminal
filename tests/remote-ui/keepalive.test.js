/**
 * A phone's socket dies half-open far more often than it closes cleanly: the
 * NAT entry expires and neither end is told. readyState stays OPEN, wsSend()
 * reports success, and everything the user does falls on the floor while the
 * status dot stays green. Only an unanswered round trip exposes it.
 */

const { loadPwa, teardownPwa } = require('./harness');

let pwa;
let sockets;

/** Replace WebSocket with a controllable fake, capturing every instance. */
function installFakeSocket() {
  sockets = [];
  function FakeSocket() {
    this.readyState = 1; // pretend the handshake already succeeded
    this.sent = [];
    this.closed = false;
    sockets.push(this);
  }
  FakeSocket.prototype.send = function (raw) { this.sent.push(JSON.parse(raw)); };
  FakeSocket.prototype.close = function () { this.closed = true; this.readyState = 3; };
  FakeSocket.OPEN = 1;
  window.WebSocket = FakeSocket;
}

/** Types sent since the socket opened. */
function sentTypes(ws) { return ws.sent.map(m => m.type); }

beforeEach(() => {
  jest.useFakeTimers();
  pwa = loadPwa({ token: 'tok' });
  installFakeSocket();
  pwa.conn.token = 'tok';
  pwa.conn.state = 'connected';
});

afterEach(() => {
  teardownPwa(pwa);
  jest.useRealTimers();
});

describe('heartbeat', () => {
  test('pings on an interval and survives a socket that answers', () => {
    const ws = { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, close() {} };
    pwa.conn.ws = ws;
    pwa._startHeartbeat();

    jest.advanceTimersByTime(25_000);
    expect(sentTypes(ws)).toEqual(['ping']);

    pwa.handleMessage({ type: 'pong', data: {} });
    jest.advanceTimersByTime(25_000);
    expect(sentTypes(ws)).toEqual(['ping', 'ping']);
    expect(ws.closed).toBeUndefined();
  });

  test('an unanswered ping drops the socket instead of trusting it', () => {
    let closed = false;
    const ws = { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, close() { closed = true; } };
    pwa.conn.ws = ws;
    pwa._startHeartbeat();

    jest.advanceTimersByTime(25_000); // ping goes out
    jest.advanceTimersByTime(25_000); // still no pong

    expect(closed).toBe(true);
    expect(pwa.conn.ws).toBeNull();
    expect(pwa.conn.retryTimer).not.toBeNull();
  });
});

describe('waking from the background', () => {
  test('a closed socket reconnects at once rather than waiting out the backoff', () => {
    installFakeSocket();
    pwa.conn.ws = null;
    pwa.conn.retryCount = 5; // deep in the exponential backoff
    pwa.conn.retryTimer = setTimeout(() => {}, 30_000);

    document.dispatchEvent(new window.Event('visibilitychange'));

    expect(pwa.conn.retryCount).toBe(0);
    expect(sockets.length).toBe(1);
  });

  test('an open socket is probed, and dropped if the probe goes unanswered', () => {
    let closed = false;
    const ws = { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, close() { closed = true; } };
    pwa.conn.ws = ws;

    document.dispatchEvent(new window.Event('visibilitychange'));
    expect(sentTypes(ws)).toEqual(['ping']);

    jest.advanceTimersByTime(8_000);
    expect(closed).toBe(true);
  });

  test('a probe that is answered keeps the socket', () => {
    let closed = false;
    const ws = { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, close() { closed = true; } };
    pwa.conn.ws = ws;

    document.dispatchEvent(new window.Event('visibilitychange'));
    pwa.handleMessage({ type: 'pong', data: {} });
    jest.advanceTimersByTime(8_000);

    expect(closed).toBe(false);
    expect(pwa.conn.ws).toBe(ws);
  });

  test('nothing is attempted while the user is still on the auth screen', () => {
    installFakeSocket();
    pwa.conn.state = 'auth';
    pwa.conn.ws = null;

    document.dispatchEvent(new window.Event('visibilitychange'));

    expect(sockets.length).toBe(0);
  });
});

describe('git actions cannot hang forever', () => {
  test('a reply that never comes re-enables the buttons', () => {
    pwa.state.projects = [{ id: 'p1', name: 'P', path: '/tmp/p1' }];
    pwa.state.selectedProjectId = 'p1';
    pwa.conn.ws = { readyState: 1, send() {}, close() {} };

    pwa.gitPull();
    expect(document.getElementById('btn-git-pull').classList.contains('busy')).toBe(true);

    jest.advanceTimersByTime(30_000);

    expect(document.getElementById('btn-git-pull').classList.contains('busy')).toBe(false);
  });

  test('a reply that does come cancels the deadline', () => {
    pwa.state.projects = [{ id: 'p1', name: 'P', path: '/tmp/p1' }];
    pwa.state.selectedProjectId = 'p1';
    pwa.conn.ws = { readyState: 1, send() {}, close() {} };

    pwa.gitPull();
    pwa.onGitResult('pull', { success: true });
    jest.advanceTimersByTime(60_000);

    expect(document.getElementById('btn-git-pull').classList.contains('busy')).toBe(false);
  });
});
