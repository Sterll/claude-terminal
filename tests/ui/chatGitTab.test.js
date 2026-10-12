/**
 * The chat's Git tab. What it must get right: say where the branch stands
 * without being asked twice, cost nothing while hidden, and push the way the
 * branch is set up (plain push when it tracks something, publish otherwise).
 */

'use strict';

const { createGitTab, gitTabHtml, sessionHtml } = require('../../src/renderer/ui/components/chat/gitTab');
const { t } = require('../../src/renderer/i18n');

const SESSION_START = Date.parse('2026-10-09T08:00:00Z');

const summary = (over = {}) => ({
  isRepo: true,
  root: '/repo',
  branch: 'feat/x',
  detached: false,
  head: 'abc1234',
  worktree: false,
  upstream: 'fork/feat/x',
  remote: 'fork',
  ahead: 1,
  behind: 0,
  base: 'fork/main',
  onBase: false,
  dirty: { staged: 1, unstaged: 1, untracked: 1, conflicts: 0 },
  commits: [
    { sha: 'e'.repeat(40), short: 'eeeeeee', subject: 'E not pushed yet', author: 'Ada', date: '2026-10-09T09:00:00Z' },
    { sha: 'c'.repeat(40), short: 'ccccccc', subject: 'C <b>before</b>', author: 'Ada', date: '2026-10-08T09:00:00Z' },
  ],
  pr: {
    authenticated: true,
    createUrl: 'https://github.com/acme/app/compare/main...feat%2Fx?expand=1',
    pullRequest: {
      number: 57, title: 'ENG-142: session tab', state: 'open', draft: false, url: 'https://github.com/acme/app/pull/57',
      checks: { total: 3, success: 1, failure: 1, pending: 1, skipped: 0, failing: [{ name: 'test', url: 'https://ci/test' }] },
      reviews: { approved: 1, changesRequested: 0, decisions: [] },
    },
  },
  ...over,
});

describe('gitTabHtml', () => {
  const render = (s, opts) => {
    document.body.innerHTML = gitTabHtml(s, { sessionStartedAt: SESSION_START, ...opts });
    return document.body;
  };

  test('branch, drift against its upstream, and uncommitted work', () => {
    const el = render(summary());
    expect(el.querySelector('.session-git-branch-name').textContent).toBe('feat/x');
    expect(el.textContent).toContain(t('chat.git.onBase', { base: 'fork/main' }));
    expect(el.querySelector('.session-git-drift').textContent).toMatch(/↑ 1\s+↓ 0\s+fork\/feat\/x/);
    expect(el.textContent).toContain(t('chat.git.dirty', { count: 3 }));
    expect(el.querySelector('[data-action="push"]').textContent).toBe(t('chat.git.push'));
  });

  test('nothing to push: no push button; never published: publish', () => {
    expect(render(summary({ ahead: 0 })).querySelector('[data-action="push"]')).toBeNull();
    expect(render(summary({ upstream: null, ahead: 0 })).querySelector('[data-action="push"]').textContent).toBe(t('chat.git.publish'));
    expect(render(summary({ upstream: null })).textContent).toContain(t('chat.git.unpublished'));
  });

  test('commits made since the session opened are marked, text is escaped', () => {
    const el = render(summary());
    const rows = el.querySelectorAll('.session-git-commit');
    expect(rows[0].textContent).toContain(t('chat.git.thisSession'));
    expect(rows[1].textContent).not.toContain(t('chat.git.thisSession'));
    expect(el.querySelector('.session-git-commit b')).toBeNull();
  });

  test('the pull request: state, checks, reviews, failing checks', () => {
    const el = render(summary());
    expect(el.querySelector('.session-git-pr-title').textContent).toContain('#57');
    expect(el.querySelector('.session-git-pill.state.open').textContent).toBe(t('chat.git.prOpen'));
    expect(el.textContent).toContain(t('chat.git.checksFailed', { count: 1 }));
    expect(el.textContent).toContain(t('chat.git.approved', { count: 1 }));
    expect(el.querySelector('[data-action="open-check"]').textContent).toBe('test');
  });

  test('the PR title can be decorated (chips) without losing escaping elsewhere', () => {
    const el = render(summary(), { decoratePrTitle: (title) => `<span class="chip">${title.slice(0, 7)}</span>` });
    expect(el.querySelector('.session-git-pr-text .chip').textContent).toBe('ENG-142');
  });

  test.each([
    ['no pull request yet', { pr: { authenticated: true, pullRequest: null, createUrl: 'https://x' } }, 'create-pr', 'chat.git.prNone', undefined],
    ['no GitHub login', { pr: { authenticated: false, createUrl: 'https://x' } }, 'connect-github', 'chat.git.prLoginNeeded', undefined],
    ['on the base branch', { onBase: true, pr: null }, null, 'chat.git.prOnBase', undefined],
    ['not a GitHub repository', { pr: null }, null, 'chat.git.prNoGitHub', undefined],
    // An organization's SAML SSO answers 403: not "no pull request", but "authorize first".
    ['an organization behind SSO', { pr: { authenticated: true, pullRequest: null, createUrl: 'https://x', ssoRequired: { url: 'https://github.com/orgs/acme/sso?authorization_request=a1', org: 'acme', repo: 'acme/app' } } }, 'authorize-sso', 'chat.git.prSsoBlocked', { org: 'acme' }],
    ['a repository GitHub does not show', { pr: { authenticated: true, pullRequest: null, createUrl: 'https://x', unreachable: 'acme/app' } }, null, 'chat.git.prUnreachable', { repo: 'acme/app' }],
    ['a lookup that failed', { pr: { authenticated: true, pullRequest: null, createUrl: 'https://x', error: 'API error: 502', repo: 'acme/app' } }, null, 'chat.git.prLookupFailed', { error: 'API error: 502' }],
  ])('%s', (_label, over, action, key, params) => {
    const el = render(summary(over));
    expect(el.textContent).toContain(t(key, params));
    if (key !== 'chat.git.prNone') expect(el.textContent).not.toContain(t('chat.git.prNone'));
    if (action) expect(el.querySelector(`[data-action="${action}"]`)).not.toBeNull();
  });
});

describe('createGitTab', () => {
  let panelEl;
  let api;
  let deps;

  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    jest.useRealTimers();
    document.body.innerHTML = '<div class="panel"></div>';
    panelEl = document.querySelector('.panel');
    api = {
      git: {
        sessionSummary: jest.fn(async () => summary()),
        push: jest.fn(async () => ({ success: true })),
        pushBranch: jest.fn(async () => ({ success: true })),
      },
      dialog: { openExternal: jest.fn() },
    };
    deps = {
      api,
      panelEl,
      getCwd: () => '/repo',
      sessionStartedAt: SESSION_START,
      onAvailable: jest.fn(),
      openGitScreen: jest.fn(),
      openSettings: jest.fn(),
      showToast: jest.fn(),
    };
  });

  test('the probe reveals the tab only for a repository, and draws nothing while hidden', async () => {
    const tab = createGitTab(deps);
    await tab.probe();
    expect(api.git.sessionSummary).toHaveBeenCalledWith({ projectPath: '/repo' });
    expect(deps.onAvailable).toHaveBeenCalledTimes(1);
    expect(panelEl.innerHTML).toBe('');

    api.git.sessionSummary.mockResolvedValueOnce({ isRepo: false });
    const other = createGitTab({ ...deps, onAvailable: jest.fn() });
    await other.probe();
    expect(other.getSummary()).toEqual({ isRepo: false });
  });

  test('showing draws the last summary at once and re-reads only when stale', async () => {
    const tab = createGitTab(deps);
    await tab.probe();
    tab.show();
    expect(panelEl.querySelector('.session-git-branch-name').textContent).toBe('feat/x');
    expect(api.git.sessionSummary).toHaveBeenCalledTimes(1); // fresh enough
    tab.destroy();
  });

  test('a tool result re-reads soon while shown, never while hidden', async () => {
    jest.useFakeTimers();
    const tab = createGitTab(deps);
    tab.markStale();
    await jest.advanceTimersByTimeAsync(5000);
    expect(api.git.sessionSummary).not.toHaveBeenCalled();

    tab.show(); // stale: loads now
    await jest.advanceTimersByTimeAsync(0);
    expect(api.git.sessionSummary).toHaveBeenCalledTimes(1);
    tab.markStale();
    tab.markStale();
    await jest.advanceTimersByTimeAsync(1600);
    expect(api.git.sessionSummary).toHaveBeenCalledTimes(2); // debounced into one
    tab.hide();
    tab.destroy();
  });

  test('push uses plain push for a tracked branch, publishes an untracked one', async () => {
    const tab = createGitTab(deps);
    await tab.probe();
    tab.show();
    panelEl.querySelector('[data-action="push"]').click();
    await flush();
    expect(api.git.push).toHaveBeenCalledWith({ projectPath: '/repo' });
    expect(deps.showToast).toHaveBeenCalledWith({ type: 'success', title: t('chat.git.pushed') });

    api.git.sessionSummary.mockResolvedValue(summary({ upstream: null }));
    panelEl.querySelector('[data-action="refresh"]').click();
    await flush();
    panelEl.querySelector('[data-action="push"]').click();
    await flush();
    expect(api.git.pushBranch).toHaveBeenCalledWith({ projectPath: '/repo', branch: 'feat/x' });
    tab.destroy();
  });

  test('a failed push says why', async () => {
    api.git.push.mockResolvedValueOnce({ success: false, error: 'rejected: non-fast-forward' });
    const tab = createGitTab(deps);
    await tab.probe();
    tab.show();
    panelEl.querySelector('[data-action="push"]').click();
    await flush();
    expect(deps.showToast).toHaveBeenCalledWith({ type: 'error', title: t('chat.git.pushFailed'), message: 'rejected: non-fast-forward' });
    tab.destroy();
  });

  test('links open outside the app, navigation goes through the callbacks', async () => {
    const tab = createGitTab(deps);
    await tab.probe();
    tab.show();
    panelEl.querySelector('[data-action="open-pr"]').click();
    panelEl.querySelector('[data-action="open-check"]').click();
    panelEl.querySelector('[data-action="open-git"]').click();
    expect(api.dialog.openExternal.mock.calls.map((c) => c[0])).toEqual(['https://github.com/acme/app/pull/57', 'https://ci/test']);
    expect(deps.openGitScreen).toHaveBeenCalled();
    tab.destroy();
  });

  test('the SSO button opens the page GitHub named, nothing else', async () => {
    const url = 'https://github.com/orgs/acme/sso?authorization_request=a1';
    api.git.sessionSummary.mockResolvedValue(summary({ pr: { authenticated: true, pullRequest: null, createUrl: 'https://x', ssoRequired: { url, org: 'acme', repo: 'acme/app' } } }));
    const tab = createGitTab(deps);
    await tab.probe();
    tab.show();
    expect(panelEl.querySelector('[data-action="create-pr"]')).toBeNull();
    panelEl.querySelector('[data-action="authorize-sso"]').click();
    expect(api.dialog.openExternal.mock.calls).toEqual([[url]]);
    tab.destroy();
  });

  test('a summary that arrives after destroy is dropped', async () => {
    let release;
    api.git.sessionSummary.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const tab = createGitTab(deps);
    const pending = tab.probe();
    tab.destroy();
    release(summary());
    await pending;
    expect(deps.onAvailable).not.toHaveBeenCalled();
  });
});

describe('a session that worked in its own worktrees', () => {
  const ws = (over = {}) => ({ ...summary(), dir: '/repo/.claude/worktrees/a', label: '.claude/worktrees/a', isRoot: false, at: 2, ...over });
  const overviewOf = (over = {}) => ({
    isRepo: true,
    mode: 'session',
    workspaces: [
      ws({ branch: 'feat/a', pr: { ...summary().pr, pullRequest: { ...summary().pr.pullRequest, number: 7, url: 'https://github.com/acme/app/pull/7', createdHere: true } } }),
      ws({ dir: '/repo/.claude/worktrees/b', label: '.claude/worktrees/b', branch: 'feat/b', removed: true, upstream: null, ahead: 0, dirty: undefined, commits: undefined, base: undefined, onBase: undefined, pr: { authenticated: true, pullRequest: null, createUrl: 'https://x' } }),
    ],
    createdPrs: [{ url: 'https://github.com/acme/app/pull/9', number: 9, repo: 'acme/app', authenticated: true, pullRequest: { ...summary().pr.pullRequest, number: 9, title: 'Elsewhere', url: 'https://github.com/acme/app/pull/9', headRef: 'feat/z' } }],
    ...over,
  });

  test('a card per worktree with its own branch and pull request, then the ones no card carries', () => {
    document.body.innerHTML = sessionHtml(overviewOf());
    const cards = [...document.querySelectorAll('[data-ws]')];
    expect(cards.map((c) => c.querySelector('.session-git-branch-name').textContent)).toEqual(['feat/a', 'feat/b']);
    expect(cards[0].querySelector('.session-git-place').textContent).toBe('.claude/worktrees/a');
    expect(cards[0].textContent).toContain(t('chat.git.createdHere'));
    expect(cards[0].querySelector('[data-action="open-pr"]').dataset.url).toBe('https://github.com/acme/app/pull/7');
    expect(cards[1].textContent).toContain(t('chat.git.removedWorktree'));
    expect(cards[1].querySelector('[data-action="push"]')).toBeNull(); // nothing on disk to push
    expect(document.querySelector('[data-created="0"] .session-git-pr-text').textContent).toBe('Elsewhere');
  });

  test('the project folder is named when the session worked there', () => {
    document.body.innerHTML = sessionHtml(overviewOf({ workspaces: [ws({ label: null, isRoot: true, dir: '/repo' })], createdPrs: [] }));
    expect(document.querySelector('.session-git-place').textContent).toBe(t('chat.git.projectFolder'));
    expect(document.querySelector('[data-created]')).toBeNull();
  });

  describe('in the tab', () => {
    let panelEl;
    let api;
    let deps;
    const flush = () => new Promise((r) => setTimeout(r, 0));

    beforeEach(() => {
      document.body.innerHTML = '<div class="panel"></div>';
      panelEl = document.querySelector('.panel');
      api = {
        git: {
          sessionSummary: jest.fn(async () => summary()),
          sessionOverview: jest.fn(async () => overviewOf()),
          push: jest.fn(async () => ({ success: true })),
          pushBranch: jest.fn(async () => ({ success: true })),
        },
        dialog: { openExternal: jest.fn() },
      };
      deps = {
        api, panelEl, getCwd: () => '/repo', sessionStartedAt: SESSION_START, onAvailable: jest.fn(),
        openGitScreen: jest.fn(), openSettings: jest.fn(), showToast: jest.fn(), onSummary: jest.fn(),
      };
    });

    test('with the CLI session id it reads the session, without it the folder', async () => {
      let sid = null;
      const tab = createGitTab({ ...deps, getSessionId: () => sid });
      await tab.probe();
      expect(api.git.sessionSummary).toHaveBeenCalledWith({ projectPath: '/repo' });
      expect(api.git.sessionOverview).not.toHaveBeenCalled();
      sid = 'bfad60ea-7522-4ae7-b996-8808fb848f8d';
      await tab.probe();
      expect(api.git.sessionOverview).toHaveBeenCalledWith({ projectPath: '/repo', sessionId: sid });
      tab.destroy();
    });

    test('each card acts on its own worktree; links open their own URL', async () => {
      const tab = createGitTab({ ...deps, getSessionId: () => 'sid-12345678' });
      await tab.probe();
      tab.show();
      panelEl.querySelector('[data-ws="0"] [data-action="push"]').click();
      await flush();
      expect(api.git.push).toHaveBeenCalledWith({ projectPath: '/repo/.claude/worktrees/a' });
      panelEl.querySelector('[data-created="0"] [data-action="open-pr"]').click();
      expect(api.dialog.openExternal).toHaveBeenCalledWith('https://github.com/acme/app/pull/9');
      tab.destroy();
    });

    test('the summary hook sees every branch and pull request; getSummary reads the latest worktree', async () => {
      const tab = createGitTab({ ...deps, getSessionId: () => 'sid-12345678' });
      await tab.probe();
      const seen = deps.onSummary.mock.calls.map(([s]) => [s.branch, s.pr?.pullRequest?.number || null]);
      expect(seen).toEqual([['feat/a', 7], ['feat/b', null], ['feat/z', 9]]);
      expect(tab.getSummary()).toMatchObject({ branch: 'feat/a' });
      tab.destroy();
    });

    test('a session the overview finds nothing for is drawn as the folder', async () => {
      api.git.sessionOverview.mockResolvedValue({ ...summary(), mode: 'project' });
      const tab = createGitTab({ ...deps, getSessionId: () => 'sid-12345678' });
      await tab.probe();
      tab.show();
      expect(panelEl.querySelector('[data-ws]')).toBeNull();
      expect(panelEl.querySelector('.session-git-branch-name').textContent).toBe('feat/x');
      tab.destroy();
    });
  });
});
