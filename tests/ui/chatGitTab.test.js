/**
 * The chat's Git tab. What it must get right: say where the branch stands
 * without being asked twice, cost nothing while hidden, and push the way the
 * branch is set up (plain push when it tracks something, publish otherwise).
 */

'use strict';

const { createGitTab, gitTabHtml, sessionHtml, ciStatus, ciStatusText, fixPrompt } = require('../../src/renderer/ui/components/chat/gitTab');
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

  test('running checks name the step their job is on', () => {
    const pr = summary().pr.pullRequest;
    const el = render(summary({ pr: { ...summary().pr, pullRequest: { ...pr, checks: { ...pr.checks, running: [
      { name: 'e2e', url: 'https://ci/e2e', jobId: 11, step: { number: 5, total: 8, name: 'Run <smoke>' } },
      { name: 'deploy-bot', url: null, jobId: null, step: null },
    ] } } } }));
    const rows = [...el.querySelectorAll('.session-git-running li')];
    expect(rows.map((r) => r.querySelector('[data-action="open-check"]').textContent)).toEqual(['e2e', 'deploy-bot']);
    expect(rows[0].textContent).toContain('5/8 · Run <smoke>');
    expect(rows[0].querySelector('smoke')).toBeNull();
    expect(rows[1].querySelector('.session-git-muted')).toBeNull();
  });

  test('a failed Actions job of an open pull request can be handed to the session; another app\'s check cannot', () => {
    const pr = summary().pr.pullRequest;
    const failing = [{ name: 'test', url: 'https://ci/test', jobId: 42 }, { name: 'codecov', url: 'https://codecov', jobId: null }];
    const open = render(summary({ pr: { ...summary().pr, pullRequest: { ...pr, checks: { ...pr.checks, failure: 2, failing } } } }));
    const fixes = [...open.querySelectorAll('[data-action="fix-check"]')];
    expect(fixes).toHaveLength(1);
    expect(fixes[0].closest('li').textContent).toContain('test');
    expect(fixes[0].dataset).toMatchObject({ prUrl: 'https://github.com/acme/app/pull/57', index: '0' });

    const merged = render(summary({ pr: { ...summary().pr, pullRequest: { ...pr, state: 'merged', checks: { ...pr.checks, failing } } } }));
    expect(merged.querySelector('[data-action="fix-check"]')).toBeNull();
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

describe('the session\'s CI', () => {
  const pr = (over = {}) => ({ ...summary().pr.pullRequest, ...over });
  const checks = (success, failure, pending) => ({ total: success + failure + pending, success, failure, pending, skipped: 0, failing: [], running: [] });

  test('failing wins over running, running over passed, nothing without checks', () => {
    expect(ciStatus(summary())).toEqual({ state: 'failure', success: 1, failure: 1, pending: 1 });
    expect(ciStatus(summary({ pr: { pullRequest: pr({ checks: checks(2, 0, 1) }) } })).state).toBe('pending');
    expect(ciStatus(summary({ pr: { pullRequest: pr({ checks: checks(3, 0, 0) }) } })).state).toBe('success');
    expect(ciStatus(summary({ pr: { pullRequest: pr({ checks: checks(0, 0, 0) }) } }))).toBeNull();
    expect(ciStatus(summary({ pr: null }))).toBeNull();
    expect(ciStatus({ isRepo: false })).toBeNull();
  });

  test('only open pull requests count: a merged one\'s red check is history', () => {
    expect(ciStatus(summary({ pr: { pullRequest: pr({ state: 'merged' }) } }))).toBeNull();
  });

  test('a session with several worktrees adds up every pull request it shows', () => {
    const s = {
      isRepo: true,
      mode: 'session',
      workspaces: [{ pr: { pullRequest: pr({ checks: checks(1, 0, 2) }) } }, { pr: null }, { pr: { pullRequest: pr({ state: 'closed', checks: checks(0, 4, 0) }) } }],
      createdPrs: [{ pullRequest: pr({ checks: checks(2, 0, 0) }) }, { pullRequest: null }],
    };
    expect(ciStatus(s)).toEqual({ state: 'pending', success: 3, failure: 0, pending: 2 });
  });

  test('the tooltip spells the counts out, failures first', () => {
    expect(ciStatusText({ state: 'failure', success: 3, failure: 1, pending: 2 })).toBe([
      `✕ ${t('chat.git.checksFailed', { count: 1 })}`,
      `◷ ${t('chat.git.checksPending', { count: 2 })}`,
      `✓ ${t('chat.git.checksOk', { count: 3 })}`,
    ].join(' · '));
    expect(ciStatusText(null)).toBe('');
  });

  test('the fix prompt names the check, the pull request and where the branch is, then quotes the log', () => {
    const text = fixPrompt({ pr: pr({ headRef: 'feat/x', repo: 'acme/app' }), check: { name: 'test', url: 'https://ci/test' }, logs: 'FAIL tests/a.test.js\n', dir: '/repo/.claude/worktrees/a' });
    expect(text).toContain('The CI check "test" failed on pull request #57 (branch `feat/x`) of acme/app.');
    expect(text).toContain('checked out in `/repo/.claude/worktrees/a`');
    expect(text).toContain('```\nFAIL tests/a.test.js\n```');
  });

  test('a log that itself holds a fence gets a longer one; no log points at the check', () => {
    expect(fixPrompt({ pr: pr(), check: { name: 'docs' }, logs: 'see ```js``` above' })).toContain('````\nsee ```js``` above\n````');
    const none = fixPrompt({ pr: pr(), check: { name: 'test', url: 'https://ci/test' }, logs: null });
    expect(none).toContain('could not be retrieved: https://ci/test');
    expect(none).not.toContain('```');
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

  test('the CI status goes to the tab button, only when it changes', async () => {
    const onCiStatus = jest.fn();
    const tab = createGitTab({ ...deps, onCiStatus });
    await tab.probe();
    await tab.probe();
    expect(onCiStatus.mock.calls).toEqual([[{ state: 'failure', success: 1, failure: 1, pending: 1 }]]);
    api.git.sessionSummary.mockResolvedValue(summary({ pr: null }));
    await tab.probe();
    expect(onCiStatus).toHaveBeenLastCalledWith(null);
    tab.destroy();
  });

  test('Fix it hands the job\'s log to this session\'s composer', async () => {
    const pr = summary().pr.pullRequest;
    api.git.sessionSummary.mockResolvedValue(summary({ pr: { ...summary().pr, pullRequest: { ...pr, headRef: 'feat/x', repo: 'acme/app', checks: { ...pr.checks, failing: [{ name: 'test', url: 'https://ci/test', jobId: 42 }] } } } }));
    api.github = { jobLogs: jest.fn(async () => ({ success: true, logs: 'Expected 2, received 3' })) };
    const fillComposer = jest.fn();
    const tab = createGitTab({ ...deps, fillComposer });
    await tab.probe();
    tab.show();
    panelEl.querySelector('[data-action="fix-check"]').click();
    await flush();
    expect(api.github.jobLogs).toHaveBeenCalledWith('https://github.com/acme/app', 42);
    expect(fillComposer).toHaveBeenCalledTimes(1);
    expect(fillComposer.mock.calls[0][0]).toContain('The CI check "test" failed on pull request #57');
    expect(fillComposer.mock.calls[0][0]).toContain('Expected 2, received 3');
    tab.destroy();
  });

  describe('read while hidden', () => {
    const running = () => summary({ pr: { ...summary().pr, pullRequest: { ...summary().pr.pullRequest, checks: { total: 1, success: 0, failure: 0, pending: 1, skipped: 0, failing: [], running: [] } } } });
    let onScreen;

    beforeEach(() => {
      jest.useFakeTimers();
      jest.spyOn(document, 'hasFocus').mockReturnValue(true);
      onScreen = true;
    });
    afterEach(() => jest.restoreAllMocks());

    test('the session on screen follows a running check every 15 s', async () => {
      api.git.sessionSummary.mockResolvedValue(running());
      const tab = createGitTab({ ...deps, isOnScreen: () => onScreen });
      await tab.probe();
      await jest.advanceTimersByTimeAsync(15_000);
      expect(api.git.sessionSummary).toHaveBeenCalledTimes(2);
      onScreen = false; // another tab, another screen
      await jest.advanceTimersByTimeAsync(60_000);
      expect(api.git.sessionSummary).toHaveBeenCalledTimes(2);
      tab.destroy();
    });

    test('settled checks are not polled; a tool result is picked up, at most every 30 s', async () => {
      api.git.sessionSummary.mockResolvedValue(summary());
      const tab = createGitTab({ ...deps, isOnScreen: () => onScreen });
      await tab.probe();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(api.git.sessionSummary).toHaveBeenCalledTimes(1);
      tab.markStale();
      await jest.advanceTimersByTimeAsync(15_000);
      expect(api.git.sessionSummary).toHaveBeenCalledTimes(2);
      tab.markStale();
      await jest.advanceTimersByTimeAsync(15_000);
      expect(api.git.sessionSummary).toHaveBeenCalledTimes(2); // read 15 s ago
      await jest.advanceTimersByTimeAsync(15_000);
      expect(api.git.sessionSummary).toHaveBeenCalledTimes(3);
      tab.destroy();
    });

    test('an unfocused window reads nothing', async () => {
      api.git.sessionSummary.mockResolvedValue(running());
      document.hasFocus.mockReturnValue(false);
      const tab = createGitTab({ ...deps, isOnScreen: () => true });
      await tab.probe();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(api.git.sessionSummary).toHaveBeenCalledTimes(1);
      tab.destroy();
    });
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
