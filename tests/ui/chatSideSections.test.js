/**
 * The side column's Branches and Tickets, wired into a real chat view: each
 * section, and its icon on the collapsed strip, appears once its tab has
 * something to show, and not before. A folder that is not a repository and a
 * machine with no tracker connected keep the column as it was.
 */

'use strict';

/** api mock: the namespaces given, `on*` returning an unsubscribe, everything else a bare success. */
function makeApiMock(overrides) {
  const ns = (name) => new Proxy({}, {
    get: (_t, method) => {
      if (overrides[name]?.[method]) return overrides[name][method];
      return (...args) => {
        if (typeof method === 'string' && method.startsWith('on')) return () => {};
        void args;
        return Promise.resolve({ success: true, messages: [] });
      };
    },
  });
  return new Proxy({}, { get: (_t, name) => ns(name) });
}

let uuidSeq = 0;
Object.defineProperty(global, 'crypto', {
  value: { ...(global.crypto || {}), randomUUID: () => `uuid-${++uuidSeq}` },
  configurable: true,
});

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

const repo = {
  isRepo: true, root: '/tmp/test', branch: 'feat/x', head: 'abc1234', upstream: 'origin/feat/x', ahead: 2, behind: 0,
  onBase: false, dirty: { staged: 0, unstaged: 1, untracked: 0, conflicts: 0 }, commits: [{ sha: 'a' }],
  pr: { authenticated: true, pullRequest: null, createUrl: 'https://x' },
};

describe('the side column\'s Branches and Tickets', () => {
  let wrapper;
  let view;

  function open(overrides) {
    jest.resetModules();
    window.electron_api = makeApiMock(overrides);
    document.body.innerHTML = '';
    document.body.className = '';
    localStorage.clear();
    wrapper = document.createElement('div');
    document.body.appendChild(wrapper);
    const { createChatView } = require('../../src/renderer/ui/components/ChatView');
    view = createChatView(wrapper, { id: 'p1', name: 'Test', path: '/tmp/test' });
  }

  afterEach(() => {
    try { view?.destroy?.(); } catch (_) { /* teardown is best effort */ }
  });

  const section = (name) => wrapper.querySelector(`.chat-side-${name}`);
  const signal = (name) => wrapper.querySelector(`.chat-side-rail-${name}`);

  test('a repository shows its branch, and a branch that needs the user says so on the strip', async () => {
    open({ git: { sessionSummary: jest.fn(async () => repo) } });
    await flush();
    expect(section('git').hidden).toBe(false);
    expect(section('git').querySelector('.chat-side-count').textContent).toBe('1');
    expect(signal('git').hidden).toBe(false);
    // Two commits not pushed: the Git tab's verdict asks for a push.
    expect(signal('git').classList.contains('attention')).toBe(true);
    expect(wrapper.querySelector('.chat-view').classList.contains('has-git')).toBe(true);
  });

  test('no repository, no tracker: neither section, neither icon', async () => {
    open({
      git: { sessionSummary: jest.fn(async () => ({ isRepo: false })) },
      issueTrackers: {
        providers: jest.fn(async () => ({ ok: true, providers: [] })),
        connections: jest.fn(async () => ({ ok: true, connections: [] })),
      },
    });
    await flush();
    expect(section('git').hidden).toBe(true);
    expect(signal('git').hidden).toBe(true);
    expect(section('tickets').hidden).toBe(true);
    expect(signal('tickets').hidden).toBe(true);
  });

  test('a connected tracker shows the section, with a dot while a detected ticket waits', async () => {
    open({
      git: { sessionSummary: jest.fn(async () => ({ isRepo: false })) },
      issueTrackers: {
        providers: jest.fn(async () => ({ ok: true, providers: [{ id: 'fake', name: 'Fake' }] })),
        connections: jest.fn(async () => ({ ok: true, connections: [{ id: 'c1', provider: 'fake', available: true }] })),
      },
      issueLinks: {
        get: jest.fn(async () => ({
          ok: true,
          links: [
            { ref: 'fake:A-1', connectionId: 'c1', title: 'One', source: 'manual', status: 'linked', at: 1 },
            { ref: 'fake:A-2', connectionId: 'c1', title: 'Two', source: 'branch', status: 'suggested', at: 2 },
          ],
        })),
        onChanged: () => () => {},
      },
    });
    await flush();
    expect(section('tickets').hidden).toBe(false);
    expect(section('tickets').querySelector('.chat-side-count').textContent).toBe('1');
    expect(signal('tickets').hidden).toBe(false);
    expect(signal('tickets').classList.contains('behind')).toBe(true);
  });
});
