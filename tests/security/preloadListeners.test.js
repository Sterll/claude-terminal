/**
 * Two things about the preload bridge that only show with a real renderer.
 *
 * Listeners: every chat tab subscribes to the same channels, so one
 * ipcRenderer listener per subscriber raised MaxListenersExceededWarning from
 * the eleventh tab on. The preload now keeps one listener per channel and fans
 * out itself.
 *
 * Errors: contextBridge copies a thrown Error with its message only, so the
 * code an fs call failed with has to be in the message too.
 */

let mockExposed;
const mockIpcRenderer = new (require('events').EventEmitter)();
mockIpcRenderer.invoke = jest.fn();
mockIpcRenderer.send = jest.fn();
mockIpcRenderer.sendSync = jest.fn((channel) => {
  if (channel === 'renderer-bootstrap') return { homedir: '/home/u', platform: 'linux', resourcesPath: '', appRoot: '/app', sep: '/', env: {} };
  if (channel === 'renderer-fs-sync') return { ok: false, error: { message: 'Access denied: path is outside authorized project/app data', code: 'EACCES' } };
  return { ok: true, value: undefined };
});

jest.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key, value) => { mockExposed = mockExposed || {}; mockExposed[key] = value; } },
  ipcRenderer: mockIpcRenderer,
  webUtils: { getPathForFile: () => '' },
}));

let api, nodeModules;
beforeAll(() => {
  require('../../src/main/preload');
  api = mockExposed.electron_api;
  nodeModules = mockExposed.electron_nodeModules;
});

describe('channel listeners', () => {
  test('any number of subscribers share one ipcRenderer listener', () => {
    const offs = [];
    const seen = [];
    for (let i = 0; i < 25; i++) offs.push(api.chat.onMessage((payload) => seen.push([i, payload])));
    expect(mockIpcRenderer.listenerCount('chat-message')).toBe(1);

    mockIpcRenderer.emit('chat-message', {}, { sessionId: 's' });
    expect(seen).toHaveLength(25);
    expect(seen[0]).toEqual([0, { sessionId: 's' }]);
    offs.forEach(off => off());
  });

  test('unsubscribing stops delivery to that subscriber only', () => {
    const a = jest.fn(), b = jest.fn();
    const offA = api.chat.onTaskUpdate(a);
    const offB = api.chat.onTaskUpdate(b);
    offA();
    mockIpcRenderer.emit('chat-task-update', {}, 1);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith(1);
    offB();
    mockIpcRenderer.emit('chat-task-update', {}, 2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  test('the same callback subscribed twice is delivered twice, and one unsubscribe leaves the other', () => {
    const cb = jest.fn();
    const off1 = api.chat.onBackgroundTasks(cb);
    const off2 = api.chat.onBackgroundTasks(cb);
    mockIpcRenderer.emit('chat-background-tasks', {}, 'x');
    expect(cb).toHaveBeenCalledTimes(2);
    off1();
    mockIpcRenderer.emit('chat-background-tasks', {}, 'y');
    expect(cb).toHaveBeenCalledTimes(3);
    off2();
  });

  test('a subscriber that throws does not keep the next one from running', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const after = jest.fn();
    const off1 = api.issueLinks.onChanged(() => { throw new Error('boom'); });
    const off2 = api.issueLinks.onChanged(after);
    mockIpcRenderer.emit('issue-links-changed', {}, {});
    expect(after).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalled();
    off1(); off2(); spy.mockRestore();
  });

  test('a subscriber removed by an earlier one during delivery is not called', () => {
    const late = jest.fn();
    let offLate;
    const offFirst = api.chat.onMessage(() => offLate());
    offLate = api.chat.onMessage(late);
    mockIpcRenderer.emit('chat-message', {}, {});
    expect(late).not.toHaveBeenCalled();
    offFirst();
  });
});

describe('fs errors through the bridge', () => {
  test('the code is at the head of the message, since contextBridge keeps only the message', () => {
    let thrown;
    try { nodeModules.fs.readFileSync('/etc/shadow'); } catch (e) { thrown = e; }
    expect(thrown.message).toMatch(/^EACCES: Access denied/);
  });

  test('a Node message that already starts with its code is not prefixed twice', async () => {
    mockIpcRenderer.invoke.mockResolvedValueOnce({ ok: false, error: { message: "ENOENT: no such file or directory, open '/x'", code: 'ENOENT' } });
    await expect(nodeModules.fs.promises.readFile('/x', 'utf8')).rejects.toThrow(/^ENOENT: no such file or directory, open '\/x'$/);
  });
});
