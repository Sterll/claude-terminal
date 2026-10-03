/**
 * Chat tabs of remote (SSH) projects (design/remote-ssh.md section 5.2).
 *
 * The CLI of a remote chat runs on the host, resolved in main from the
 * project's URI. What the tab itself owes the user:
 *
 * - its start carries the project id and no account (the host has its own
 *   login), and nothing about the host: main resolves that;
 * - a bar with the host badge and what a remote chat does without;
 * - when the session dies with the connection, a banner, then a resume with
 *   the CLI session id once the host is connected again;
 * - a local path is never handed to the remote CLI: such an attachment is
 *   refused with a toast;
 * - a local tab is left exactly as it was.
 */

function makeApiMock(listeners, calls, responses = {}) {
  const ns = (namespace) => new Proxy({}, {
    get: (_t, method) => (...args) => {
      if (typeof method === 'string' && method.startsWith('on')) {
        listeners[method] = args[0];
        return () => {};
      }
      calls.push({ namespace, method, args });
      const answer = responses[`${namespace}.${method}`];
      return Promise.resolve(typeof answer === 'function' ? answer(...args) : (answer || { success: true, messages: [] }));
    }
  });
  return new Proxy({}, { get: (_t, key) => key === 'getPathForFile' ? (file) => file.nativePath || '' : ns(key) });
}

let uuidSeq = 0;
Object.defineProperty(global, 'crypto', {
  value: { ...(global.crypto || {}), randomUUID: () => `remote-uuid-${++uuidSeq}` },
  configurable: true,
});
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};

const toasts = [];
jest.mock('../../src/renderer/ui/components/Toast', () => ({
  showToast: (opts) => toasts.push(opts),
  hideToast: () => {},
}));

const URI = 'ssh-remote://abcd1234/home/yanis/api';
const REMOTE = {
  id: 'r1', name: 'api', type: 'general', path: URI,
  remote: { profileId: 'abcd1234', path: '/home/yanis/api', hostLabel: 'yanis@build' },
};
const LOCAL = { id: 'p1', name: 'Test', path: '/tmp/test' };

describe('remote chat tabs', () => {
  let listeners, calls, wrapper, view, hosts;

  const flush = async () => { for (let i = 0; i < 25; i++) await new Promise(r => setTimeout(r, 0)); };
  const starts = () => calls.filter(c => c.namespace === 'chat' && c.method === 'start').map(c => c.args[0]);

  function setHostState(state) {
    hosts.applyHostStatus({ profileId: 'abcd1234', state, detail: null, retryAt: null, capabilities: null });
  }

  async function open(project) {
    view = require('../../src/renderer/ui/components/ChatView').createChatView(wrapper, project);
    await flush();
    return view;
  }

  beforeEach(() => {
    jest.resetModules();
    toasts.length = 0;
    listeners = {};
    calls = [];
    window.electron_api = makeApiMock(listeners, calls, {
      'chat.start': (params) => ({ success: true, sessionId: params.sessionId, remote: params.cwd === URI ? { host: 'yanis@build', profileId: 'abcd1234', warnings: [] } : undefined }),
    });
    document.body.innerHTML = '';
    window.getSelection().removeAllRanges();
    wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    hosts = require('../../src/renderer/state/remoteHosts.state');
    hosts.remoteHostsState.set({
      profiles: [{ id: 'abcd1234', host: 'build', user: 'yanis' }],
      statuses: { abcd1234: { profileId: 'abcd1234', state: 'connected', detail: null, retryAt: null, capabilities: null } },
      loaded: true,
      error: null,
    });
  });

  afterEach(() => {
    try { view?.destroy?.(); } catch (_) { /* best effort */ }
    jest.useRealTimers();
  });

  test('the start sends the URI and the project id, and no account', async () => {
    await open(REMOTE);
    view.sendMessage('hello host');
    await flush();
    const [params] = starts();
    expect(params).toMatchObject({ cwd: URI, projectId: 'r1', prompt: 'hello host' });
    expect(params.accountId == null).toBe(true);
    expect(params).not.toHaveProperty('remote');
  });

  test('the tab carries the host badge and says what a remote chat does without', async () => {
    await open(REMOTE);
    const bar = wrapper.querySelector('.chat-remote-bar');
    expect(bar).not.toBeNull();
    expect(bar.querySelector('.remote-host-badge').getAttribute('data-host-state')).toBe('connected');
    expect(bar.querySelector('.chat-remote-note').textContent).toMatch(/MCP/);
    expect(bar.querySelector('.chat-remote-banner').hidden).toBe(true);
  });

  test('warnings main returned with the session are shown', async () => {
    window.electron_api = makeApiMock(listeners, calls, {
      'chat.start': (params) => ({ success: true, sessionId: params.sessionId, remote: { host: 'yanis@build', warnings: ['Claude Code on yanis@build is version 2.1.1, older than the 2.1.260 this app is built against.'] } }),
    });
    await open(REMOTE);
    view.sendMessage('go');
    await flush();
    expect(wrapper.querySelector('.chat-remote-warnings').hidden).toBe(false);
    expect(wrapper.querySelector('.chat-remote-warning').textContent).toContain('2.1.260');
  });

  test('a lost connection shows a banner, and the session resumes with the CLI session id once the host is back', async () => {
    await open(REMOTE);
    view.sendMessage('long task');
    await flush();
    const sessionId = view.getSessionId();
    listeners.onMessage({
      sessionId,
      message: { type: 'assistant', session_id: 'cli-uuid-1', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } },
    });
    await flush();

    setHostState('reconnecting');
    await flush();
    listeners.onError({ sessionId, error: 'The connection to yanis@build was lost.', errorType: 'connection_lost' });
    await flush();
    const banner = wrapper.querySelector('.chat-remote-banner');
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('yanis@build');
    expect(starts()).toHaveLength(1);

    setHostState('connected');
    await new Promise(r => setTimeout(r, 1700));
    await flush();
    const restarts = starts();
    expect(restarts).toHaveLength(2);
    expect(restarts[1]).toMatchObject({ cwd: URI, projectId: 'r1', resumeSessionId: 'cli-uuid-1', sessionId, forkSession: false });
    expect(wrapper.querySelector('.chat-remote-banner').hidden).toBe(true);
  });

  test('a remote CLI that is not logged in says to log in on the host, not locally', async () => {
    // What a logged-out remote CLI really answers (seen against a real host).
    const authFailure = (sessionId) => ({
      sessionId,
      message: { type: 'assistant', error: 'authentication_failed', session_id: 'cli-uuid-3', message: { role: 'assistant', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } },
    });
    await open(REMOTE);
    view.sendMessage('hi');
    await flush();
    listeners.onMessage(authFailure(view.getSessionId()));
    await flush();
    const remoteText = wrapper.querySelector('.chat-msg-error .chat-error-content').textContent;
    expect(remoteText).toContain('yanis@build');
    expect(remoteText).toContain('/login');
    expect(remoteText).not.toMatch(/running "claude" in a terminal/);
    view.destroy();

    wrapper.innerHTML = '';
    await open(LOCAL);
    view.sendMessage('hi');
    await flush();
    listeners.onMessage(authFailure(view.getSessionId()));
    await flush();
    expect(wrapper.querySelector('.chat-msg-error .chat-error-content').textContent).toMatch(/running "claude" in a terminal/);
  });

  test('the Reconnect button asks for the host and resumes', async () => {
    window.electron_api = makeApiMock(listeners, calls, {
      'chat.start': (params) => ({ success: true, sessionId: params.sessionId }),
      'ssh.connect': () => ({ success: true, status: { profileId: 'abcd1234', state: 'connected', detail: null, retryAt: null, capabilities: null } }),
    });
    await open(REMOTE);
    view.sendMessage('go');
    await flush();
    const sessionId = view.getSessionId();
    listeners.onMessage({ sessionId, message: { type: 'assistant', session_id: 'cli-uuid-2', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } });
    setHostState('authFailed');
    await flush();
    listeners.onError({ sessionId, error: 'lost', errorType: 'connection_lost' });
    await flush();
    expect(starts()).toHaveLength(1);

    wrapper.querySelector('.chat-remote-reconnect').click();
    await flush();
    expect(calls.some(c => c.namespace === 'ssh' && c.method === 'connect' && c.args[0] === 'abcd1234')).toBe(true);
    expect(starts()).toHaveLength(2);
    expect(starts()[1].resumeSessionId).toBe('cli-uuid-2');
  });

  test('a local path attachment is refused with a toast', async () => {
    await open(REMOTE);
    const input = wrapper.querySelector('.chat-file-input');
    const big = new File(['x'], 'huge.log', { type: 'text/plain' });
    Object.defineProperty(big, 'size', { value: 50 * 1024 * 1024 });
    Object.defineProperty(big, 'path', { value: 'C:\\logs\\huge.log' });
    Object.defineProperty(input, 'files', { value: [big], configurable: true });
    input.dispatchEvent(new Event('change'));
    await flush();
    expect(wrapper.querySelectorAll('.chat-inline-chip')).toHaveLength(0);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain('huge.log');
  });

  test('a local tab is left exactly as it was', async () => {
    await open(LOCAL);
    expect(wrapper.querySelector('.chat-remote-bar')).toBeNull();
    expect(wrapper.querySelector('.chat-view').classList.contains('chat-remote')).toBe(false);
    view.sendMessage('hi');
    await flush();
    const [params] = starts();
    expect(params).toMatchObject({ cwd: '/tmp/test', projectId: 'p1' });
    expect(params).toHaveProperty('accountId');

    // ...and its oversize file still goes over as a path, as before
    const input = wrapper.querySelector('.chat-file-input');
    const big = new File(['x'], 'huge.log', { type: 'text/plain' });
    Object.defineProperty(big, 'size', { value: 50 * 1024 * 1024 });
    Object.defineProperty(big, 'path', { value: '/tmp/test/huge.log' });
    Object.defineProperty(input, 'files', { value: [big], configurable: true });
    input.dispatchEvent(new Event('change'));
    await flush();
    expect(toasts).toHaveLength(0);
  });

  test('closing the tab releases the host and removes the bar', async () => {
    await open(REMOTE);
    expect(wrapper.querySelector('.chat-remote-bar')).not.toBeNull();
    view.destroy();
    expect(wrapper.querySelector('.chat-remote-bar')).toBeNull();
    view = null;
  });
});
