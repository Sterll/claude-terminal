// ChatService unit tests — focus on pure/testable methods
// ChatService exports a singleton instance, so we test its methods directly

// Mock electron dependencies
jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app' },
  BrowserWindow: { getAllWindows: () => [] },
}));

// Mock child_process (used by resolveRuntime/shellLookup)
jest.mock('child_process', () => ({
  exec: jest.fn(),
  execSync: jest.fn(),
  execFileSync: jest.fn(() => ''),
}));

// Mock the SDK loader (virtual because it may not be resolvable in test env)
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({}), { virtual: true });

const chatService = require('../../src/main/services/ChatService');

// ── _buildContent ──

describe('ChatService._buildContent', () => {
  test('returns plain text when no images or mentions', () => {
    const result = chatService._buildContent('Hello world', []);
    expect(result).toBe('Hello world');
  });

  test('returns plain text for empty arrays', () => {
    const result = chatService._buildContent('Hello', [], []);
    expect(result).toBe('Hello');
  });

  test('returns content blocks array with images', () => {
    const result = chatService._buildContent('Look at this', [
      { base64: 'abc123', mediaType: 'image/png' }
    ]);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'text', text: 'Look at this' });
    expect(result[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'abc123' }
    });
  });

  test('returns content blocks array with mentions', () => {
    const result = chatService._buildContent('Check this file', [], [
      { label: 'src/index.js', content: 'const x = 1;' }
    ]);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0].text).toContain('[Context: src/index.js]');
    expect(result[0].text).toContain('const x = 1;');
    expect(result[1]).toEqual({ type: 'text', text: 'Check this file' });
  });

  test('mentions come before text, images after', () => {
    const result = chatService._buildContent('Question', [
      { base64: 'img', mediaType: 'image/jpeg' }
    ], [
      { label: 'file.js', content: 'code' }
    ]);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].type).toBe('text');
    expect(result[0].text).toContain('[Context:');
    expect(result[1]).toEqual({ type: 'text', text: 'Question' });
    expect(result[2].type).toBe('image');
  });

  test('handles empty text with images', () => {
    const result = chatService._buildContent('', [
      { base64: 'img', mediaType: 'image/png' }
    ]);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('image');
  });

  test('handles multiple images', () => {
    const result = chatService._buildContent('Text', [
      { base64: 'a', mediaType: 'image/png' },
      { base64: 'b', mediaType: 'image/jpeg' },
    ]);
    expect(result).toHaveLength(3);
  });

  test('handles multiple mentions', () => {
    const result = chatService._buildContent('Question', [], [
      { label: 'a.js', content: 'aaa' },
      { label: 'b.js', content: 'bbb' },
    ]);
    expect(result).toHaveLength(3);
    expect(result[0].text).toContain('a.js');
    expect(result[1].text).toContain('b.js');
  });
});

// ── _safeSerialize ──

describe('ChatService._safeSerialize', () => {
  test('serializes plain object', () => {
    const result = chatService._safeSerialize({ foo: 'bar', count: 42 });
    expect(result).toEqual({ foo: 'bar', count: 42 });
  });

  test('strips undefined values', () => {
    const result = chatService._safeSerialize({ a: 1, b: undefined });
    expect(result).toEqual({ a: 1 });
  });

  test('handles nested objects', () => {
    const result = chatService._safeSerialize({ outer: { inner: [1, 2, 3] } });
    expect(result).toEqual({ outer: { inner: [1, 2, 3] } });
  });

  test('handles circular reference gracefully', () => {
    const obj = { a: 1 };
    obj.self = obj;
    const result = chatService._safeSerialize(obj);
    expect(result).toEqual({ _raw: expect.any(String) });
  });

  test('handles null', () => {
    const result = chatService._safeSerialize(null);
    expect(result).toBeNull();
  });

  test('handles arrays', () => {
    const result = chatService._safeSerialize([1, 'two', { three: 3 }]);
    expect(result).toEqual([1, 'two', { three: 3 }]);
  });
});

// ── chat_message trigger dispatch (_processStream) ──

describe('ChatService chat_message dispatch', () => {
  const assistant = text => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const toolUse   = ()   => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } });
  const result    = ()   => ({ type: 'result', subtype: 'success' });

  let fired;
  let sent;
  let originalSend;
  let originalLifecycle;

  beforeEach(() => {
    fired = [];
    sent = [];
    originalSend = chatService._send;
    originalLifecycle = chatService._emitLifecycle;
    chatService._send = (channel, payload) => sent.push({ channel, payload });
    chatService._emitLifecycle = () => {};
    chatService.setMessageCallback(e => fired.push(e));
  });

  afterEach(() => {
    chatService._send = originalSend;
    chatService._emitLifecycle = originalLifecycle;
    chatService.setMessageCallback(null);
  });

  const drive = async (messages) => {
    async function* stream() { for (const m of messages) yield m; }
    await chatService._processStream('sess-test', stream());
  };

  test('fires once per turn, not per streamed message', async () => {
    // A turn holds several assistant messages as soon as a tool runs in the
    // middle — firing on each one spams the automation while Claude is talking.
    await drive([assistant('Looking at it.'), toolUse(), assistant('Found it.'), result()]);

    expect(fired).toHaveLength(1);
    expect(fired[0].role).toBe('assistant');
    expect(fired[0].text).toBe('Looking at it.\n\nFound it.');
  });

  test('fires again for the next turn of the same stream', async () => {
    await drive([assistant('First.'), result(), assistant('Second.'), result()]);

    expect(fired.map(f => f.text)).toEqual(['First.', 'Second.']);
  });

  test('flushes a turn that ends without a result message', async () => {
    await drive([assistant('Done talking.')]);

    expect(fired.map(f => f.text)).toEqual(['Done talking.']);
  });

  test('does not fire for a turn with no assistant text', async () => {
    await drive([toolUse(), result()]);

    expect(fired).toHaveLength(0);
  });
});

describe('ChatService conversation context', () => {
  // What an automation needs to scope itself to one conversation: the CLI's own
  // session id (the only thing `resume` accepts) and the files that session wrote.
  const SESSION = 'sess-ctx';

  const assistant = text => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const write = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  const init = id => ({ type: 'system', subtype: 'init', session_id: id });
  const result = () => ({ type: 'result', subtype: 'success' });

  let fired;
  let originalSend;
  let originalLifecycle;

  beforeEach(() => {
    fired = [];
    originalSend = chatService._send;
    originalLifecycle = chatService._emitLifecycle;
    chatService._send = () => {};
    chatService._emitLifecycle = () => {};
    chatService.setMessageCallback(e => fired.push(e));
    chatService.sessions.set(SESSION, { cwd: 'E:/repos/api', projectId: 'api' });
  });

  afterEach(() => {
    chatService._send = originalSend;
    chatService._emitLifecycle = originalLifecycle;
    chatService.setMessageCallback(null);
    chatService.sessions.delete(SESSION);
  });

  const drive = async (messages) => {
    async function* stream() { for (const m of messages) yield m; }
    await chatService._processStream(SESSION, stream());
  };

  test('captures the SDK session id from the init message', async () => {
    // Our own `chat-…` handle is app-local; the CLI has never heard of it.
    await drive([init('sdk-1234'), assistant('Done.'), result()]);

    expect(chatService.sessions.get(SESSION).sdkSessionId).toBe('sdk-1234');
    expect(fired[0].sdkSessionId).toBe('sdk-1234');
  });

  test('records the files the turn wrote, in order and without duplicates', async () => {
    await drive([
      init('sdk-1'),
      write('Write', { file_path: 'E:/repos/api/a.js' }),
      write('Edit',  { file_path: 'E:/repos/api/b.js' }),
      write('Edit',  { file_path: 'E:/repos/api/a.js' }),
      assistant('Done.'),
      result(),
    ]);

    expect(fired[0].files).toEqual(['E:/repos/api/a.js', 'E:/repos/api/b.js']);
    expect(fired[0].filesText).toBe('- E:/repos/api/a.js\n- E:/repos/api/b.js');
  });

  test('ignores read-only tools', async () => {
    // The record answers "what did this conversation change", so a Read or a
    // Grep has no business in it — an auto-commit would stage the wrong files.
    await drive([
      write('Read', { file_path: 'E:/repos/api/read-only.js' }),
      write('Grep', { pattern: 'x' }),
      assistant('Done.'),
      result(),
    ]);

    expect(fired[0].files).toEqual([]);
    expect(fired[0].filesText).toBe('(none recorded)');
  });

  test('records notebook edits under their own input key', async () => {
    await drive([write('NotebookEdit', { notebook_path: 'E:/repos/api/n.ipynb' }), assistant('x'), result()]);

    expect(fired[0].files).toEqual(['E:/repos/api/n.ipynb']);
  });

  test('survives a tool_use with no usable path', async () => {
    await drive([write('Write', {}), write('Edit', { file_path: '' }), assistant('x'), result()]);

    expect(fired[0].files).toEqual([]);
  });

  test('accumulates across the turns of one session', async () => {
    await drive([
      write('Write', { file_path: 'E:/repos/api/a.js' }), assistant('First.'), result(),
      write('Write', { file_path: 'E:/repos/api/b.js' }), assistant('Second.'), result(),
    ]);

    // The second turn's automation sees everything the conversation touched,
    // not just the last turn — which is what scoping a commit needs.
    expect(fired[1].files).toEqual(['E:/repos/api/a.js', 'E:/repos/api/b.js']);
  });
});

// ── lifecycle status after in-band API errors (_processStream) ──

describe('ChatService lifecycle status', () => {
  const SESSION = 'sess-lifecycle';
  const assistant = text => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const okResult = () => ({ type: 'result', subtype: 'success', is_error: false });

  let lifecycle;
  let originalSend;
  let originalLifecycle;

  beforeEach(() => {
    lifecycle = [];
    originalSend = chatService._send;
    originalLifecycle = chatService._emitLifecycle;
    chatService._send = () => {};
    chatService._emitLifecycle = (event, sessionId, extra = {}) => lifecycle.push({ event, sessionId, ...extra });
  });

  afterEach(() => {
    chatService._send = originalSend;
    chatService._emitLifecycle = originalLifecycle;
  });

  const drive = async (messages) => {
    async function* stream() { for (const m of messages) yield m; }
    await chatService._processStream(SESSION, stream());
  };

  test('reports success when the stream ends after a clean result', async () => {
    await drive([assistant('Done.'), okResult()]);

    expect(lifecycle).toEqual([{ event: 'end', sessionId: SESSION, status: 'success' }]);
  });

  test('reports error when the API failed in-band (529 Overloaded)', async () => {
    // A 529 never throws: the SDK yields an assistant message tagged `error`,
    // then a result flagged is_error, and the stream ends normally. That used
    // to be reported as 'success' right after the UI displayed the error.
    await drive([
      { type: 'assistant', error: 'overloaded', message: { content: [] } },
      { type: 'result', subtype: 'success', is_error: true, api_error_status: 529 },
    ]);

    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0].status).toBe('error');
    expect(lifecycle[0].error).toContain('overloaded');
  });

  test('reports error for an error-subtype result', async () => {
    await drive([
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] },
    ]);

    expect(lifecycle[0].status).toBe('error');
    expect(lifecycle[0].error).toBe('boom');
  });

  test('a later successful turn clears an earlier in-band failure', async () => {
    // Streaming input keeps the session open across turns — the lifecycle
    // event reports the session's final outcome, not its first hiccup.
    await drive([
      { type: 'assistant', error: 'overloaded', message: { content: [] } },
      { type: 'result', subtype: 'success', is_error: true, api_error_status: 529 },
      assistant('Retried fine.'),
      okResult(),
    ]);

    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0].status).toBe('success');
  });
});

// ── CLI failure text guard ──

describe('ChatService._isCliFailureText', () => {
  test.each([
    'Not logged in · Please run /login',
    'API Error: 401 Invalid API key · Please run /login',
    'Invalid API key · Please run /login',
    'Your session has expired. Please run /login to sign in again.',
    'Voice mode requires a Claude.ai account. Please run /login to sign in.',
    'Not logged in. Run `claude auth login` to authenticate.',
    'Credit balance is too low',
    'Claude usage limit reached',
  ])('refuses CLI failure text: %s', (text) => {
    expect(chatService._isCliFailureText(text)).toBe(true);
  });

  test.each([
    'Fix /login redirect',
    'Refonte left menu',
    'Migrate auth session store',
    'Debug expired token refresh',
    'API error handling middleware',
  ])('lets a real title through: %s', (text) => {
    expect(chatService._isCliFailureText(text)).toBe(false);
  });

  test('ignores surrounding whitespace', () => {
    expect(chatService._isCliFailureText('  Not logged in · Please run /login\n')).toBe(true);
  });

  test('empty and nullish text is not a failure', () => {
    expect(chatService._isCliFailureText('')).toBe(false);
    expect(chatService._isCliFailureText('   ')).toBe(false);
    expect(chatService._isCliFailureText(null)).toBe(false);
    expect(chatService._isCliFailureText(undefined)).toBe(false);
  });
});

// ── normalizeBackgroundTasks ──
// Shapes the `background_tasks_changed` level payload for the renderer.
describe('normalizeBackgroundTasks', () => {
  const { normalizeBackgroundTasks } = require('../../src/main/services/ChatService');

  test('maps the SDK payload to the renderer shape', () => {
    expect(normalizeBackgroundTasks([
      { task_id: 't1', task_type: 'subagent', description: 'Review the auth module' },
    ])).toEqual([
      { taskId: 't1', taskType: 'subagent', description: 'Review the auth module' },
    ]);
  });

  test('drops ambient housekeeping tasks', () => {
    // The SDK asks hosts to keep these out of activity indicators; filtering
    // here means no consumer has to remember the rule.
    const out = normalizeBackgroundTasks([
      { task_id: 't1', task_type: 'shell', description: 'npm test' },
      { task_id: 't2', task_type: 'monitor', description: 'watcher', ambient: true },
    ]);
    expect(out.map(t => t.taskId)).toEqual(['t1']);
  });

  test('drops entries without a task id', () => {
    // An id-less entry could never be reconciled against a card.
    expect(normalizeBackgroundTasks([{ task_type: 'shell' }, null])).toEqual([]);
  });

  test('defaults the optional fields', () => {
    expect(normalizeBackgroundTasks([{ task_id: 't1' }])).toEqual([
      { taskId: 't1', taskType: null, description: '' },
    ]);
  });

  test('returns an empty list for a malformed payload', () => {
    // An empty set is meaningful here — it means "nothing is running" — so it
    // must never be confused with "no information".
    expect(normalizeBackgroundTasks(undefined)).toEqual([]);
    expect(normalizeBackgroundTasks(null)).toEqual([]);
    expect(normalizeBackgroundTasks('nope')).toEqual([]);

  });
});
