/**
 * Task bar (chat todo widget) — the SDK's TaskCreate/TaskUpdate accumulator.
 *
 * TaskCreate answers in prose ("Task #1 created successfully: ..."), so the id every
 * later TaskUpdate addresses is only available there. Reading it wrong leaves the task
 * filed under its tool_use_id and the bar frozen at 0/N for the whole session.
 */

/** api mock: `on*` captures its callback, everything else resolves to a bare success. */
function makeApiMock(listeners) {
  const ns = () => new Proxy({}, {
    get: (_t, method) => (...args) => {
      if (typeof method === 'string' && method.startsWith('on')) {
        listeners[method] = args[0];
        return () => {};
      }
      return Promise.resolve({ success: true, messages: [] });
    }
  });
  return new Proxy({}, { get: () => ns() });
}

// jsdom ships no crypto.randomUUID; the send path tags each user message with one.
let uuidSeq = 0;
Object.defineProperty(global, 'crypto', {
  value: { ...(global.crypto || {}), randomUUID: () => `uuid-${++uuidSeq}` },
  configurable: true,
});

describe('chat task bar', () => {
  let listeners, wrapper, view, sessionId;

  /** Feed one SDK message through the same path the main process uses. */
  const emit = (message) => listeners.onMessage({ sessionId, message });

  const assistant = (content) => emit({ type: 'assistant', message: { role: 'assistant', content } });
  const toolResult = (toolUseId, text) => emit({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] }
  });

  const createTask = (toolUseId, subject, id) => {
    assistant([{ type: 'tool_use', id: toolUseId, name: 'TaskCreate', input: { subject } }]);
    toolResult(toolUseId, `Task #${id} created successfully: ${subject}`);
  };

  const count = () => wrapper.querySelector('.chat-todo .td-count')?.textContent;
  const rows = () => Array.from(wrapper.querySelectorAll('.chat-todo .td-row'));

  beforeEach(async () => {
    jest.resetModules();
    listeners = {};
    window.electron_api = makeApiMock(listeners);
    document.body.innerHTML = '';
    wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const { createChatView } = require('../../src/renderer/ui/components/ChatView');
    view = createChatView(wrapper, { id: 'p1', name: 'Test', path: '/tmp/test' });
    // A real send opens the session, so the messages below carry the id the
    // component filters on instead of bypassing that guard.
    view.sendMessage('go');
    await new Promise(r => setTimeout(r, 0));
    sessionId = view.getSessionId();
    expect(sessionId).toBeTruthy();
  });

  afterEach(() => {
    try { view?.destroy?.(); } catch (_) { /* teardown is best effort */ }
  });

  it('ticks a task off when TaskUpdate completes it', () => {
    createTask('toolu_a', 'First task', 1);
    createTask('toolu_b', 'Second task', 2);
    expect(count()).toBe('0/2');

    assistant([{ type: 'tool_use', id: 'toolu_u1', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }]);

    expect(count()).toBe('1/2');
    expect(rows()[0].classList.contains('td-completed')).toBe(true);
  });

  it('shows the active task while it runs', () => {
    createTask('toolu_a', 'Build the thing', 1);
    assistant([{ type: 'tool_use', id: 'toolu_u1', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } }]);

    expect(rows()[0].classList.contains('td-in_progress')).toBe(true);
  });

  it('keeps one row per task when the create is seen twice', () => {
    // The stream reports a tool_use at content_block_stop and the assistant message
    // repeats it — the second pass must update the row, not add another one.
    const block = { type: 'tool_use', id: 'toolu_a', name: 'TaskCreate', input: { subject: 'Only once' } };
    assistant([block]);
    assistant([block]);
    toolResult('toolu_a', 'Task #1 created successfully: Only once');

    expect(rows()).toHaveLength(1);
    expect(count()).toBe('0/1');
  });

  it('replays an update that arrives before the create is promoted', () => {
    // Out-of-order delivery: the update lands while the create's result is in flight.
    assistant([{ type: 'tool_use', id: 'toolu_a', name: 'TaskCreate', input: { subject: 'Racy task' } }]);
    assistant([{ type: 'tool_use', id: 'toolu_u1', name: 'TaskUpdate', input: { taskId: '7', status: 'completed' } }]);
    expect(count()).toBe('0/1');

    toolResult('toolu_a', 'Task #7 created successfully: Racy task');

    expect(count()).toBe('1/1');
  });

  it('still promotes when the result comes back as JSON', () => {
    assistant([{ type: 'tool_use', id: 'toolu_a', name: 'TaskCreate', input: { subject: 'JSON task' } }]);
    toolResult('toolu_a', JSON.stringify({ task: { id: 42 } }));
    assistant([{ type: 'tool_use', id: 'toolu_u1', name: 'TaskUpdate', input: { taskId: 42, status: 'completed' } }]);

    expect(count()).toBe('1/1');
  });

  it('drops the bar once every task is deleted', () => {
    createTask('toolu_a', 'Doomed', 1);
    assistant([{ type: 'tool_use', id: 'toolu_u1', name: 'TaskUpdate', input: { taskId: '1', status: 'deleted' } }]);

    expect(wrapper.querySelector('.chat-todo')).toBeNull();
  });

  it('renders a TodoWrite snapshot', () => {
    assistant([{
      type: 'tool_use', id: 'toolu_t', name: 'TodoWrite',
      input: { todos: [
        { content: 'One', status: 'completed' },
        { content: 'Two', status: 'in_progress', activeForm: 'Doing two' },
      ] }
    }]);

    expect(count()).toBe('1/2');
    expect(rows()[1].textContent).toContain('Doing two');
  });
});
