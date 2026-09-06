/**
 * Background tasks drawer — the duration each row reports.
 *
 * ChatView holds two same-named duration helpers: `fmtDur` counts seconds,
 * `utils/format`'s export counts milliseconds. The drawer computes seconds, so
 * handing them to the millisecond one read every task as "0m" until it had run
 * for the better part of a day.
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

let uuidSeq = 0;
Object.defineProperty(global, 'crypto', {
  value: { ...(global.crypto || {}), randomUUID: () => `uuid-${++uuidSeq}` },
  configurable: true,
});

describe('background tasks drawer', () => {
  let listeners, wrapper, view, sessionId, store, now;

  /** The clock both the store and the drawer read. */
  const advance = (ms) => { now += ms; };

  // State notifies its subscribers on the next frame, so the drawer has not
  // re-rendered yet when the store call returns.
  const flush = () => new Promise(r => setTimeout(r, 0));

  const timeOf = (taskId) =>
    wrapper.querySelector(`.chat-task-row[data-task-id="${taskId}"] .chat-task-row-time`)?.textContent;

  const start = async (taskId, extra = {}) => {
    store.taskStarted({ taskId, sessionId, taskType: 'shell', description: `task ${taskId}`, ...extra });
    await flush();
  };

  beforeEach(async () => {
    jest.resetModules();
    listeners = {};
    window.electron_api = makeApiMock(listeners);
    document.body.innerHTML = '';
    wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const { createChatView } = require('../../src/renderer/ui/components/ChatView');
    view = createChatView(wrapper, { id: 'p1', name: 'Test', path: '/tmp/test' });
    // A real send opens the session, so the tasks below carry the id the
    // drawer filters on instead of bypassing that guard.
    view.sendMessage('go');
    await new Promise(r => setTimeout(r, 0));
    sessionId = view.getSessionId();
    expect(sessionId).toBeTruthy();

    // Same module instance the drawer resolved, since both requires follow the
    // same resetModules.
    store = require('../../src/renderer/state/backgroundTasks.state');
    now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    Date.now.mockRestore?.();
    try { store?.reset(); } catch (_) { /* teardown is best effort */ }
    try { view?.destroy?.(); } catch (_) { /* teardown is best effort */ }
  });

  it('opens on the first task and counts it in seconds', async () => {
    await start('t1');

    expect(wrapper.querySelector('.chat-tasks-drawer').hidden).toBe(false);
    expect(timeOf('t1')).toBe('0s');
  });

  it('reports a running task in minutes and seconds, not "0m"', async () => {
    await start('t1');
    advance(95_000);
    await start('t2'); // a second task re-renders the drawer off the moved clock

    expect(timeOf('t1')).toBe('1m 35s');
  });

  it('freezes a finished task at the time it actually took', async () => {
    await start('t1');
    advance(100_000);
    store.taskEnded({ taskId: 't1', sessionId, status: 'completed' });
    await flush();

    expect(timeOf('t1')).toBe('1m 40s');

    // Still the elapsed span, not a clock that keeps running after the end.
    advance(60_000);
    await start('t2');
    expect(timeOf('t1')).toBe('1m 40s');
  });

  it('reports hours for a long run', async () => {
    await start('t1');
    advance(2 * 3_600_000 + 5 * 60_000);
    await start('t2');

    expect(timeOf('t1')).toBe('2h 5m');
  });

  it('leaves another session\'s tasks out', async () => {
    store.taskStarted({ taskId: 'other', sessionId: 'someone-else', description: 'not mine' });
    await start('t1');

    expect(timeOf('other')).toBeUndefined();
    expect(timeOf('t1')).toBe('0s');
  });
});
