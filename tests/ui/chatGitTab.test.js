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

  test('the pull request\'s labels, under its checks and reviews', () => {
    const pr = summary().pr.pullRequest;
    const el = render(summary({ pr: { ...summary().pr, pullRequest: { ...pr, labels: [{ name: 'enhancement', color: 'a2eeef' }] } } }));
    expect(el.querySelector('.session-git-pr .session-git-label').textContent).toBe('enhancement');
    expect(render(summary()).querySelector('.session-git-labels')).toBeNull();
  });

  test('an open pull request says where it stands in one line; push and Fix it keep their own place', () => {
    const pr = summary().pr.pullRequest;
    const dirty = render(summary({ ahead: 0, pr: { ...summary().pr, pullRequest: { ...pr, mergeableState: 'dirty', baseRef: 'main' } } }));
    expect(dirty.querySelector('.session-git-verdict-line .session-git-verdict').textContent).toBe(t('chat.git.verdict.conflicts', { base: 'main' }));
    expect(dirty.querySelector('.session-git-verdict-line [data-action="resolve"]')).not.toBeNull();

    const unpushed = render(summary()); // one commit not pushed: the branch card has the button
    expect(unpushed.querySelector('.session-git-verdict-line .session-git-verdict').textContent).toBe(t('chat.git.verdict.unpushed', { count: 1 }));
    expect(unpushed.querySelector('.session-git-verdict-line [data-action]')).toBeNull();

    expect(render(summary({ pr: { ...summary().pr, pullRequest: { ...pr, state: 'merged' } } })).querySelector('.session-git-verdict-line')).toBeNull();
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

    test('a Git tab left open in a chat off screen reads nothing', async () => {
      api.git.sessionSummary.mockResolvedValue(running());
      const tab = createGitTab({ ...deps, isOnScreen: () => onScreen });
      await tab.probe();
      tab.show();
      onScreen = false; // another terminal tab, or another project
      await jest.advanceTimersByTimeAsync(120_000);
      tab.markStale();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(api.git.sessionSummary).toHaveBeenCalledTimes(1);
      onScreen = true;
      await jest.advanceTimersByTimeAsync(15_000);
      expect(api.git.sessionSummary).toHaveBeenCalledTimes(2);
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

  describe('the first read waits for the chat to be on screen', () => {
    let observers;
    const shown = async (isIntersecting) => {
      for (const o of observers) o.callback([{ isIntersecting }]);
      await flush();
    };

    beforeEach(() => {
      observers = [];
      global.IntersectionObserver = class {
        constructor(callback) {
          this.callback = callback;
          this.disconnect = jest.fn();
          observers.push(this);
        }

        observe() {}
      };
    });
    afterEach(() => {
      delete global.IntersectionObserver;
    });

    test('a tab restored in the background reads nothing until it is looked at', async () => {
      const tab = createGitTab(deps);
      tab.probeWhenOnScreen(document.body);
      await shown(false);
      expect(api.git.sessionSummary).not.toHaveBeenCalled();
      await shown(true);
      expect(api.git.sessionSummary).toHaveBeenCalledTimes(1);
      expect(deps.onAvailable).toHaveBeenCalledTimes(1);
      await shown(true); // just read
      expect(api.git.sessionSummary).toHaveBeenCalledTimes(1);
      tab.destroy();
      expect(observers[0].disconnect).toHaveBeenCalled();
    });

    test('back on screen, what changed while away is read at once', async () => {
      const tab = createGitTab(deps);
      tab.probeWhenOnScreen(document.body);
      await shown(true);
      tab.show();
      await shown(false);
      tab.markStale(); // the tool ran while another tab was shown
      await shown(true);
      expect(api.git.sessionSummary).toHaveBeenCalledTimes(2);
      tab.destroy();
    });

    test('without IntersectionObserver, the probe at once', async () => {
      delete global.IntersectionObserver;
      const tab = createGitTab(deps);
      tab.probeWhenOnScreen(document.body);
      await flush();
      expect(api.git.sessionSummary).toHaveBeenCalledTimes(1);
      tab.destroy();
    });
  });

  test('every read is handed over whole, for the side column', async () => {
    const onOverview = jest.fn();
    const tab = createGitTab({ ...deps, onOverview });
    await tab.probe();
    expect(onOverview).toHaveBeenCalledTimes(1);
    expect(onOverview.mock.calls[0][0]).toBe(tab.getOverview());
    expect(tab.getOverview().branch).toBe('feat/x');
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
  const okChecks = (n = 3) => ({ total: n, success: n, failure: 0, pending: 0, skipped: 0, failing: [], running: [] });
  const pull = (number, over = {}) => ({
    number, title: `PR ${number}`, state: 'open', draft: false, url: `https://github.com/acme/app/pull/${number}`,
    repo: 'acme/app', headRef: `feat/${number}`, baseRef: 'main', updatedAt: '2026-10-12T10:00:00Z',
    mergeableState: 'clean', requestedReviewers: [], checks: okChecks(), reviews: { approved: 0, changesRequested: 0, decisions: [] }, ...over,
  });
  const ws = (over = {}) => ({ ...summary(), ahead: 0, dir: '/repo/.claude/worktrees/a', label: '.claude/worktrees/a', isRoot: false, at: 2, ...over });
  const created = (pr) => ({ url: pr.url, number: pr.number, repo: pr.repo, authenticated: true, pullRequest: pr });
  // Needs you: #1 conflicts, #6 changes requested, feat/local never published.
  // Waiting: #2 a check running, #5 stacked on #2. Ready: #3. Done: #4.
  const overviewOf = (over = {}) => ({
    isRepo: true,
    mode: 'session',
    workspaces: [
      ws({ branch: 'feat/1', dir: '/wt/1', label: 'wt/1', pr: { authenticated: true, pullRequest: pull(1, { mergeableState: 'dirty', createdHere: true }) } }),
      ws({ branch: 'feat/2', dir: '/wt/2', label: 'wt/2', pr: { authenticated: true, pullRequest: pull(2, { checks: { ...okChecks(2), total: 3, pending: 1, running: [{ name: 'e2e', url: 'https://ci/e2e', step: { number: 5, total: 8, name: 'Run smoke' } }] } }) } }),
      ws({ branch: 'feat/local', dir: '/wt/local', label: 'wt/local', upstream: null, pr: { authenticated: true, pullRequest: null, createUrl: 'https://x' } }),
    ],
    createdPrs: [
      created(pull(3, { reviews: { approved: 1, changesRequested: 0, decisions: [{ user: 'linus', state: 'APPROVED' }] } })),
      created(pull(4, { state: 'merged', mergedAt: '2026-10-12T08:00:00Z' })),
      created(pull(5, { stackedOn: { number: 2, url: 'https://github.com/acme/app/pull/2' } })),
      created(pull(6, { reviews: { approved: 0, changesRequested: 1, decisions: [{ user: 'grace', state: 'CHANGES_REQUESTED', body: 'Rename it.' }] } })),
    ],
    ...over,
  });
  const keysIn = (root, group) => [...root.querySelectorAll(`.session-git-group[data-group="${group}"] .session-git-row`)].map((r) => r.dataset.key);

  test('a row per pull request, grouped by what needs the user, each with its verdict', () => {
    document.body.innerHTML = sessionHtml(overviewOf());
    expect([...document.querySelectorAll('.session-git-group[data-group]')].map((g) => g.dataset.group)).toEqual(['action', 'waiting', 'ready', 'done']);
    expect(keysIn(document, 'action')).toEqual(['https://github.com/acme/app/pull/1', 'https://github.com/acme/app/pull/6', 'branch:/wt/local']);
    expect(keysIn(document, 'waiting')).toEqual(['https://github.com/acme/app/pull/2', 'https://github.com/acme/app/pull/5']);
    const row = (n) => document.querySelector(`[data-key="https://github.com/acme/app/pull/${n}"]`);
    expect(row(1).querySelector('.session-git-verdict').textContent).toBe(t('chat.git.verdict.conflicts', { base: 'main' }));
    expect(row(2).querySelector('.session-git-verdict').textContent).toBe(t('chat.git.verdict.ciStep', { name: 'e2e', number: 5, total: 8 }));
    expect(row(5).querySelector('.session-git-verdict').textContent).toBe(t('chat.git.verdict.stacked', { number: 2 }));
    expect(row(3).querySelector('.session-git-verdict').textContent).toBe(t('chat.git.verdict.ready'));
    // One repository: no tag repeating it on every row.
    expect(document.querySelector('.session-git-repo')).toBeNull();
  });

  test('the chips count each group; done pull requests are folded into one line', () => {
    document.body.innerHTML = sessionHtml(overviewOf());
    const chips = [...document.querySelectorAll('.session-git-chip')].map((c) => [c.dataset.group, c.querySelector('.session-git-chip-count').textContent]);
    expect(chips).toEqual([['', '7'], ['action', '3'], ['waiting', '2'], ['ready', '1'], ['done', '1']]);
    expect(document.querySelector('[data-key="https://github.com/acme/app/pull/4"]')).toBeNull();
    expect(document.querySelector('.session-git-done-summary').textContent).toContain('#4');
    expect(document.querySelector('.session-git-head .session-git-count').textContent).toBe('6');
  });

  test('each row offers what its verdict asks for', () => {
    document.body.innerHTML = sessionHtml(overviewOf());
    const action = (key) => document.querySelector(`[data-key="${key}"] .session-git-row-line > .session-git-fix`)?.dataset.action || null;
    expect(action('https://github.com/acme/app/pull/1')).toBe('resolve');
    expect(action('https://github.com/acme/app/pull/6')).toBe('address-review');
    expect(action('branch:/wt/local')).toBe('push');
    expect(action('https://github.com/acme/app/pull/2')).toBeNull();
  });

  test('an unfolded row shows its labels, each in its colour; a colour that is not hex is dropped, a name is escaped', () => {
    const o = overviewOf();
    o.createdPrs[0].pullRequest.labels = [
      { name: 'bug', color: 'd73a4a' },
      { name: '<b>needs</b> design', color: 'x"; background: red' },
    ];
    document.body.innerHTML = sessionHtml(o, { view: { filter: null, expanded: new Set(['https://github.com/acme/app/pull/3']), doneOpen: false, worktreesOpen: false } });
    const row = document.querySelector('[data-key="https://github.com/acme/app/pull/3"]');
    const labels = [...row.querySelectorAll('.session-git-label')];
    expect(labels.map((l) => l.textContent)).toEqual(['bug', '<b>needs</b> design']);
    expect(labels[0].getAttribute('style')).toBe('--label-color: #d73a4a');
    expect(labels[1].hasAttribute('style')).toBe(false);
    expect(row.querySelector('.session-git-label b')).toBeNull();
    expect(row.textContent).toContain(t('chat.git.detail.labels'));
    // No labels, no line.
    expect(document.querySelector('[data-key="https://github.com/acme/app/pull/1"] .session-git-label')).toBeNull();
  });

  test('a pull request stacked on another says so, beside a verdict about something else', () => {
    const o = overviewOf();
    o.createdPrs[2].pullRequest.mergeableState = 'dirty';
    document.body.innerHTML = sessionHtml(o);
    const row = document.querySelector('[data-key="https://github.com/acme/app/pull/5"]');
    expect(row.closest('.session-git-group').dataset.group).toBe('action');
    expect(row.textContent).toContain(t('chat.git.stackedOn', { number: 2 }));
  });

  test('a fork and its upstream are told apart by owner', () => {
    const o = overviewOf();
    o.createdPrs[0].pullRequest.repo = 'upstream/app';
    document.body.innerHTML = sessionHtml(o);
    expect(document.querySelector('[data-key="https://github.com/acme/app/pull/3"] .session-git-repo').textContent).toBe('upstream');
  });

  test('shown from the side column, the row it named is unfolded, a done one with its group; a branch with no row opens the worktrees', async () => {
    document.body.innerHTML = '<div class="panel"></div>';
    const panelEl = document.querySelector('.panel');
    const api = { git: { sessionOverview: jest.fn(async () => overviewOf()) }, dialog: { openExternal: jest.fn() } };
    const tab = createGitTab({
      api, panelEl, getCwd: () => '/repo', getSessionId: () => 'sess', sessionStartedAt: 0,
      onAvailable: jest.fn(), openGitScreen: jest.fn(), openSettings: jest.fn(), showToast: jest.fn(),
    });
    await tab.probe();
    tab.show();
    const merged = 'https://github.com/acme/app/pull/4';
    tab.reveal(merged);
    const row = [...panelEl.querySelectorAll('.session-git-row')].find((el) => el.dataset.key === merged);
    expect(row.classList.contains('expanded')).toBe(true);
    expect(row.classList.contains('chat-task-flash')).toBe(true);

    tab.reveal('branch:/wt/elsewhere');
    expect(panelEl.querySelector('.session-git-worktrees').classList.contains('folded')).toBe(false);
    tab.destroy();
  });

  test('a lookup that failed is said once, above the rows; nothing at all says so', () => {
    document.body.innerHTML = sessionHtml(overviewOf({ createdPrs: [{ authenticated: false }, { authenticated: false }] }));
    expect(document.querySelectorAll('.session-git-notice')).toHaveLength(1);
    expect(document.querySelector('.session-git-notice [data-action="connect-github"]')).not.toBeNull();
    document.body.innerHTML = sessionHtml(overviewOf({ workspaces: [], createdPrs: [] }));
    expect(document.querySelector('.session-git-empty').textContent).toBe(t('chat.git.noPullRequests'));
  });

  describe('in the tab', () => {
    let panelEl;
    let api;
    let deps;
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const click = (selector) => panelEl.querySelector(selector).click();

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
        github: { prComments: jest.fn(async () => ({ success: true, authenticated: true, comments: [{ user: 'grace', path: 'src/a.js', line: 4, body: 'Here.' }] })) },
        dialog: { openExternal: jest.fn() },
      };
      deps = {
        api, panelEl, getCwd: () => '/repo', sessionStartedAt: SESSION_START, onAvailable: jest.fn(),
        openGitScreen: jest.fn(), openSettings: jest.fn(), showToast: jest.fn(), onSummary: jest.fn(),
        getSessionId: () => 'sid-12345678', fillComposer: jest.fn(),
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

    test('a row unfolds on click and stays unfolded across reads', async () => {
      const tab = createGitTab(deps);
      await tab.probe();
      tab.show();
      expect(panelEl.querySelector('.session-git-row-detail')).toBeNull();
      click('[data-key="https://github.com/acme/app/pull/2"] .session-git-row-title');
      const detail = () => panelEl.querySelector('[data-key="https://github.com/acme/app/pull/2"] .session-git-row-detail');
      expect(detail().textContent).toContain('Run smoke');
      expect(detail().textContent).toContain('wt/2');
      await tab.probe();
      expect(detail()).not.toBeNull();
      click('[data-key="https://github.com/acme/app/pull/2"] [data-action="toggle-row"].session-git-chevron');
      expect(detail()).toBeNull();
      tab.destroy();
    });

    test('a chip narrows the list to its group; the done line unfolds', async () => {
      const tab = createGitTab(deps);
      await tab.probe();
      tab.show();
      click('.session-git-chip.waiting');
      expect([...panelEl.querySelectorAll('.session-git-group[data-group]')].map((g) => g.dataset.group)).toEqual(['waiting']);
      click('.session-git-chip[data-group=""]');
      click('[data-action="toggle-done"]');
      expect(keysIn(panelEl, 'done')).toEqual(['https://github.com/acme/app/pull/4']);
      tab.destroy();
    });

    test('a row\'s link opens its own pull request, not the row', async () => {
      const tab = createGitTab(deps);
      await tab.probe();
      tab.show();
      click('[data-key="https://github.com/acme/app/pull/3"] [data-action="open-pr"]');
      expect(api.dialog.openExternal).toHaveBeenCalledWith('https://github.com/acme/app/pull/3');
      expect(panelEl.querySelector('.session-git-row-detail')).toBeNull();
      tab.destroy();
    });

    test('conflicts and a review become prompts in this session\'s composer, naming the worktree', async () => {
      const tab = createGitTab(deps);
      await tab.probe();
      tab.show();
      click('[data-key="https://github.com/acme/app/pull/1"] [data-action="resolve"]');
      expect(deps.fillComposer.mock.calls[0][0]).toContain('has conflicts with its base `main`');
      expect(deps.fillComposer.mock.calls[0][0]).toContain('checked out in `/wt/1`');

      click('[data-key="https://github.com/acme/app/pull/6"] [data-action="address-review"]');
      await flush();
      expect(api.github.prComments).toHaveBeenCalledWith({ remoteUrl: 'https://github.com/acme/app', pullNumber: 6 });
      const prompt = deps.fillComposer.mock.calls[1][0];
      expect(prompt).toContain('@grace wrote:\n> Rename it.');
      expect(prompt).toContain('`src/a.js:4`, @grace');
      expect(prompt).not.toContain('checked out'); // opened here, its worktree not shown
      tab.destroy();
    });

    test('a branch never published is published from its own worktree', async () => {
      const tab = createGitTab(deps);
      await tab.probe();
      tab.show();
      click('[data-key="branch:/wt/local"] [data-action="push"]');
      await flush();
      expect(api.git.pushBranch).toHaveBeenCalledWith({ projectPath: '/wt/local', branch: 'feat/local' });
      tab.destroy();
    });

    test('the worktrees, folded under the list, push each from its own folder', async () => {
      const tab = createGitTab(deps);
      await tab.probe();
      tab.show();
      expect(panelEl.querySelector('.session-git-wt')).toBeNull();
      click('[data-action="toggle-worktrees"]');
      expect([...panelEl.querySelectorAll('.session-git-wt-branch')].map((e) => e.textContent)).toEqual(['feat/1', 'feat/2', 'feat/local']);
      click('.session-git-wt[data-ws="2"] [data-action="push"]');
      await flush();
      expect(api.git.pushBranch).toHaveBeenCalledWith({ projectPath: '/wt/local', branch: 'feat/local' });
      tab.destroy();
    });

    test('the tab button is told how many rows need the user, only when it changes', async () => {
      const onAttention = jest.fn();
      const tab = createGitTab({ ...deps, onAttention });
      await tab.probe();
      await tab.probe();
      expect(onAttention.mock.calls).toEqual([[3]]);
      api.git.sessionOverview.mockResolvedValue(overviewOf({ workspaces: [] }));
      await tab.probe();
      expect(onAttention).toHaveBeenLastCalledWith(1);
      tab.destroy();
    });

    test('the summary hook sees every branch and pull request; getSummary reads the latest worktree', async () => {
      const tab = createGitTab(deps);
      await tab.probe();
      const seen = deps.onSummary.mock.calls.map(([s]) => [s.branch, s.pr?.pullRequest?.number || null]);
      expect(seen).toEqual([['feat/1', 1], ['feat/2', 2], ['feat/local', null], ['feat/3', 3], ['feat/4', 4], ['feat/5', 5], ['feat/6', 6]]);
      expect(tab.getSummary()).toMatchObject({ branch: 'feat/1' });
      tab.destroy();
    });

    test('a session the overview finds nothing for is drawn as the folder', async () => {
      api.git.sessionOverview.mockResolvedValue({ ...summary(), mode: 'project' });
      const tab = createGitTab(deps);
      await tab.probe();
      tab.show();
      expect(panelEl.querySelector('.session-git-row')).toBeNull();
      expect(panelEl.querySelector('.session-git-branch-name').textContent).toBe('feat/x');
      tab.destroy();
    });
  });
});
