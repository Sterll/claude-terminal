/**
 * @jest-environment node
 */

// What a late-joining phone gets replayed.
//
// Every text fragment the model emits is its own content_block_delta, so the
// raw buffer measured packets rather than conversation: one turn filled it and
// the replay started mid-message, where the client has no message_start to
// reset its block state against.

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

let mockBridge = null;
let mockActiveSessions = [];
jest.mock('../../src/main/services/ChatService', () => ({
  getActiveSessions: jest.fn(() => mockActiveSessions),
  setRemoteEventCallback: jest.fn((cb) => { mockBridge = cb; }),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  readFile: jest.fn((_p, _e, cb) => cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))),
  promises: {
    readFile: jest.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  },
}));

let mockHttpHandler = null;
let mockUpgradeHandler = null;
const mockHttpServer = {
  on(event, fn) { if (event === 'upgrade') mockUpgradeHandler = fn; return this; },
  listen(_p, _h, cb) { if (cb) cb(); return this; },
  close(cb) { if (cb) cb(); },
  address: () => ({ port: 3712 }),
};
jest.mock('http', () => ({
  createServer: (handler) => { mockHttpHandler = handler; return mockHttpServer; },
}));

let mockNextSocket = null;
jest.mock('ws', () => ({
  WebSocketServer: jest.fn(() => ({
    handleUpgrade: (_r, _s, _h, cb) => cb(mockNextSocket),
    close: (cb) => { if (cb) cb(); },
  })),
}));

const remoteServer = require('../../src/main/services/RemoteServer');

function makeSocket() {
  return {
    readyState: 1,
    sent: [],
    closedWith: null,
    on() { return this; },
    send(raw) { this.sent.push(JSON.parse(raw)); },
    close(code) { this.closedWith = code ?? 1000; },
    terminate() {},
    ping() {},
  };
}

async function authenticate() {
  const pin = await remoteServer.generatePin();
  const listeners = {};
  const req = {
    method: 'POST', url: '/auth', headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on(e, fn) { listeners[e] = fn; return this; },
    destroy() {},
  };
  let payload = '';
  const res = { setHeader() {}, writeHead() {}, end(c) { payload = c || ''; } };
  mockHttpHandler(req, res);
  listeners.data(JSON.stringify({ pin }));
  await listeners.end();
  await new Promise(r => setImmediate(r));
  return JSON.parse(payload).token;
}

/** Connect a client and return everything the server replayed to it. */
async function connectAndDrain() {
  const token = await authenticate();
  const ws = makeSocket();
  mockNextSocket = ws;
  mockUpgradeHandler(
    { url: `/ws?token=${token}`, headers: { host: '127.0.0.1:3712' }, socket: { remoteAddress: '127.0.0.1' } },
    { destroy() {}, write() {} },
    Buffer.alloc(0),
  );
  // _sendProjectsAndSessions is deferred to the next tick.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  return ws.sent;
}

/** A stream_event as ChatService emits it. */
function streamEvent(sessionId, event) {
  return ['chat-message', { sessionId, message: { type: 'stream_event', event } }];
}

function textDelta(sessionId, index, text) {
  return streamEvent(sessionId, { type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
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
  mockActiveSessions = [];
  remoteServer.start(null, 3712);
});

afterEach(async () => {
  await flushInit();
  await remoteServer.stop();
});

describe('stream deltas are folded before buffering', () => {
  test('a turn of fragments replays as one delta with the full text', async () => {
    remoteServer.broadcastSessionStarted({ sessionId: 'S', projectId: 'p1', tabName: 'Chat' });
    mockBridge(...streamEvent('S', { type: 'message_start' }));
    for (const ch of 'hello world') mockBridge(...textDelta('S', 0, ch));

    const replayed = await connectAndDrain();
    const deltas = replayed.filter(m =>
      m.type === 'chat-message' && m.data.message.event?.type === 'content_block_delta');

    expect(deltas).toHaveLength(1);
    expect(deltas[0].data.message.event.delta.text).toBe('hello world');
  });

  test('deltas for different blocks are kept apart', async () => {
    remoteServer.broadcastSessionStarted({ sessionId: 'S', projectId: 'p1', tabName: 'Chat' });
    mockBridge(...textDelta('S', 0, 'first'));
    mockBridge(...textDelta('S', 1, 'second'));
    mockBridge(...textDelta('S', 0, '-again'));

    const replayed = await connectAndDrain();
    const texts = replayed
      .filter(m => m.type === 'chat-message' && m.data.message.event?.type === 'content_block_delta')
      .map(m => m.data.message.event.delta.text);

    expect(texts).toEqual(['first', 'second', '-again']);
  });

  test('a tool input json delta folds the same way', async () => {
    remoteServer.broadcastSessionStarted({ sessionId: 'S', projectId: 'p1', tabName: 'Chat' });
    mockBridge(...streamEvent('S', {
      type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"a":' },
    }));
    mockBridge(...streamEvent('S', {
      type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '1}' },
    }));

    const replayed = await connectAndDrain();
    const deltas = replayed.filter(m =>
      m.type === 'chat-message' && m.data.message.event?.type === 'content_block_delta');

    expect(deltas).toHaveLength(1);
    expect(deltas[0].data.message.event.delta.partial_json).toBe('{"a":1}');
  });

  test('live broadcasts are never folded — only the replay buffer is', async () => {
    const token = await authenticate();
    const ws = makeSocket();
    mockNextSocket = ws;
    mockUpgradeHandler(
      { url: `/ws?token=${token}`, headers: { host: '127.0.0.1:3712' }, socket: { remoteAddress: '127.0.0.1' } },
      { destroy() {}, write() {} }, Buffer.alloc(0),
    );
    await new Promise(r => setImmediate(r));
    ws.sent.length = 0;

    mockBridge(...textDelta('S', 0, 'a'));
    mockBridge(...textDelta('S', 0, 'b'));

    const texts = ws.sent
      .filter(m => m.type === 'chat-message')
      .map(m => m.data.message.event.delta.text);
    expect(texts).toEqual(['a', 'b']);
  });
});

describe('replay is bracketed', () => {
  test('the client is told when the burst starts and ends', async () => {
    remoteServer.broadcastSessionStarted({ sessionId: 'S', projectId: 'p1', tabName: 'Chat' });
    mockBridge(...textDelta('S', 0, 'hi'));

    const replayed = await connectAndDrain().then(all => all.map(m => m.type));

    expect(replayed).toContain('replay:start');
    expect(replayed).toContain('replay:end');
    expect(replayed.indexOf('replay:start')).toBeLessThan(replayed.indexOf('replay:end'));
  });
});

describe('trimming stops at a turn boundary', () => {
  test('the replay never begins in the middle of a message', async () => {
    remoteServer.broadcastSessionStarted({ sessionId: 'S', projectId: 'p1', tabName: 'Chat' });

    // Far more turns than the buffer holds, each one a message_start followed by
    // a tool block whose input the client can only parse from its start.
    for (let turn = 0; turn < 700; turn++) {
      mockBridge(...streamEvent('S', { type: 'message_start' }));
      mockBridge(...streamEvent('S', {
        type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `t${turn}`, name: 'Bash' },
      }));
      mockBridge(...streamEvent('S', { type: 'content_block_stop', index: 0 }));
    }

    const replayed = await connectAndDrain();
    const chat = replayed.filter(m => m.type === 'chat-message');

    expect(chat.length).toBeGreaterThan(0);
    expect(chat[0].data.message.event.type).toBe('message_start');
  });
});

describe('a finished session keeps its transcript for a while', () => {
  // The cleanup interval is created by start(), so the clock has to be faked
  // before the server is. setImmediate stays real — connectAndDrain awaits it.
  function restartWithFakeClock() {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    remoteServer.start(null, 3712);
    remoteServer.broadcastSessionStarted({ sessionId: 'S', projectId: 'p1', tabName: 'Chat' });
    mockBridge(...textDelta('S', 0, 'answer'));
    mockActiveSessions = []; // the turn ended
  }

  test('it is not dropped the moment it stops being active', async () => {
    await remoteServer.stop();
    restartWithFakeClock();
    try {
      jest.advanceTimersByTime(10 * 60 * 1000); // two cleanup ticks
      jest.useRealTimers();
      const replayed = await connectAndDrain();
      expect(replayed.some(m => m.type === 'chat-message')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('it is eventually reclaimed', async () => {
    await remoteServer.stop();
    restartWithFakeClock();
    try {
      jest.advanceTimersByTime(45 * 60 * 1000);
      jest.useRealTimers();
      const replayed = await connectAndDrain();
      expect(replayed.some(m => m.type === 'chat-message')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});
