/**
 * @jest-environment node
 */
// RemoteServer WebSocket lifecycle — reconnection correctness.
//
// Covers the two defects that made a phone look connected while receiving
// nothing: the session token being revoked by an ordinary socket close, and the
// replaced socket's async 'close' handler unregistering its own replacement.

jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app' },
}));

// _sendFullInit defers this to setImmediate. Left real, it resolves after the
// test has finished — logging into a torn-down suite and keeping the worker
// alive past its teardown.
jest.mock('../../src/main/services/ModelCatalogService', () => ({
  getCatalog: jest.fn().mockResolvedValue({ primary: [], legacy: [] }),
}));

jest.mock('../../src/main/utils/paths', () => ({
  settingsFile: '/mock/settings.json',
  projectsFile: '/mock/projects.json',
}));

jest.mock('../../src/main/services/ChatService', () => ({
  getActiveSessions: jest.fn(() => []),
  setRemoteEventCallback: jest.fn(),
}));

const mockFs = {
  existsSync: jest.fn(() => false),
  readFile: jest.fn((_p, _e, cb) => cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))),
  promises: {
    readFile: jest.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  },
};
jest.mock('fs', () => mockFs);

// ── Fake http server: capture the request + upgrade handlers, never bind a port
let mockHttpHandler = null;
let mockUpgradeHandler = null;
const mockHttpServer = {
  on(event, fn) { if (event === 'upgrade') mockUpgradeHandler = fn; return this; },
  listen(_port, _host, cb) { if (cb) cb(); return this; },
  close(cb) { if (cb) cb(); },
  address: () => ({ port: 3712 }),
};
jest.mock('http', () => ({
  createServer: (handler) => { mockHttpHandler = handler; return mockHttpServer; },
}));

// ── Fake WebSocketServer: handleUpgrade hands back whatever socket we queued
let mockNextSocket = null;
jest.mock('ws', () => ({
  WebSocketServer: jest.fn(() => ({
    handleUpgrade: (_req, _sock, _head, cb) => cb(mockNextSocket),
    close: (cb) => { if (cb) cb(); },
  })),
}));

const remoteServer = require('../../src/main/services/RemoteServer');

/** Minimal duck-typed WebSocket with the surface RemoteServer touches. */
function makeSocket(name) {
  const handlers = {};
  return {
    name,
    readyState: 1,
    sent: [],
    closedWith: null,
    on(event, fn) { (handlers[event] ||= []).push(fn); return this; },
    emit(event, ...args) { (handlers[event] || []).forEach(fn => fn(...args)); },
    send(raw) { this.sent.push(JSON.parse(raw)); },
    close(code) { this.closedWith = code ?? 1000; this.readyState = 3; },
    terminate() { this.readyState = 3; },
    ping() {},
    /** Types received since the last drain, ignoring the init burst. */
    types() { return this.sent.map(m => m.type); },
  };
}

/** Drive POST /auth through the real HTTP handler and return the token. */
async function authenticate() {
  const pin = await remoteServer.generatePin();
  const body = JSON.stringify({ pin });
  const listeners = {};
  const req = {
    method: 'POST',
    url: '/auth',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on(event, fn) { listeners[event] = fn; return this; },
    destroy() {},
  };
  let payload = '';
  const res = {
    statusCode: 0,
    setHeader() {},
    writeHead(code) { this.statusCode = code; },
    end(chunk) { payload = chunk || ''; },
  };
  mockHttpHandler(req, res);
  listeners.data(body);
  await listeners.end();
  // _isPinValid awaits settings; give the promise chain a turn to settle.
  await new Promise(resolve => setImmediate(resolve));
  expect(res.statusCode).toBe(200);
  return JSON.parse(payload).token;
}

function upgrade(token, socket) {
  mockNextSocket = socket;
  mockUpgradeHandler(
    {
      url: `/ws?token=${token}`,
      headers: { host: '127.0.0.1:3712', 'user-agent': 'jest' },
      socket: { remoteAddress: '127.0.0.1' },
    },
    { destroy() {}, write() {} },
    Buffer.alloc(0),
  );
}

/**
 * _sendFullInit defers its heavy work to setImmediate, so a test that connects
 * a client and returns leaves that work pending. It then runs against a
 * torn-down suite and keeps the worker from exiting cleanly.
 */
async function flushInit() {
  for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r));
}

beforeEach(() => {
  remoteServer.start(null, 3712);
});

afterEach(async () => {
  await flushInit();
  await remoteServer.stop();
});

describe('WS reconnection with an existing token', () => {
  test('the replaced socket does not unregister its replacement', async () => {
    const token = await authenticate();

    const first = makeSocket('first');
    upgrade(token, first);

    const second = makeSocket('second');
    upgrade(token, second);

    // The old socket's 'close' fires only after the new one is registered.
    first.emit('close', 1006);

    second.sent.length = 0;
    remoteServer.setTimeData({ todayMs: 42 });

    expect(second.types()).toContain('time:update');
  });

  test('a dropped connection keeps the session token valid', async () => {
    const token = await authenticate();

    const first = makeSocket('first');
    upgrade(token, first);
    first.emit('close', 1006);

    // Reconnect with the SAME token — a phone waking from screen lock.
    const second = makeSocket('second');
    upgrade(token, second);

    expect(second.closedWith).toBeNull();

    second.sent.length = 0;
    remoteServer.setTimeData({ todayMs: 7 });
    expect(second.types()).toContain('time:update');
  });

  test('an unknown token is still rejected with 4401', async () => {
    const rogue = makeSocket('rogue');
    upgrade('not-a-real-token', rogue);
    expect(rogue.closedWith).toBe(4401);
  });

  test('disconnectClient still revokes the token', async () => {
    const token = await authenticate();
    const ws = makeSocket('victim');
    upgrade(token, ws);

    expect(remoteServer.disconnectClient(token.slice(0, 8))).toBe(true);
    expect(ws.closedWith).toBe(4403);

    // The revoked token must not buy a new socket.
    const retry = makeSocket('retry');
    upgrade(token, retry);
    expect(retry.closedWith).toBe(4401);
  });
});
