/**
 * A session's pull requests as rows with one verdict each (chat/sessionPrs.js).
 * What it must get right: the first rule that applies wins, so a red check
 * is never hidden behind a pending review; what needs the user is counted
 * and listed first; and the prompts hand Claude what it needs to act.
 */

'use strict';

const {
  prVerdict, branchVerdict, rowsOf, groupRows, attentionCount, noticesOf, repoLabeller, verdictText,
  conflictsPrompt, behindPrompt, reviewPrompt,
} = require('../../src/renderer/ui/components/chat/sessionPrs');
const { t } = require('../../src/renderer/i18n');

const checks = (success, failure = 0, pending = 0, extra = {}) => ({
  total: success + failure + pending, success, failure, pending, skipped: 0, failing: [], running: [], ...extra,
});
const reviews = (decisions = []) => ({
  approved: decisions.filter((d) => d.state === 'APPROVED').length,
  changesRequested: decisions.filter((d) => d.state === 'CHANGES_REQUESTED').length,
  decisions,
});
const pull = (number, over = {}) => ({
  number,
  title: `PR ${number}`,
  state: 'open',
  draft: false,
  url: `https://github.com/acme/app/pull/${number}`,
  repo: 'acme/app',
  headRef: `feat/${number}`,
  baseRef: 'main',
  updatedAt: '2026-10-12T10:00:00Z',
  mergeableState: 'clean',
  requestedReviewers: [],
  checks: checks(3),
  reviews: reviews(),
  ...over,
});
const ws = (over = {}) => ({
  isRepo: true, branch: 'feat/x', upstream: 'origin/feat/x', ahead: 0, behind: 0, onBase: false, base: 'origin/main',
  dirty: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }, commits: [{ short: 'abc1234', subject: 'x' }],
  dir: '/repo/.claude/worktrees/x', label: '.claude/worktrees/x', isRoot: false, pr: null, ...over,
});
const code = (pr, w) => {
  const v = prVerdict(pr, w);
  return `${v.group}/${v.code}`;
};

describe('a pull request\'s verdict: the first rule that applies', () => {
  test.each([
    ['merged', pull(1, { state: 'merged', mergeableState: null }), null, 'done/merged'],
    ['closed', pull(1, { state: 'closed', checks: checks(0, 2) }), null, 'done/closed'],
    // Every check and review is about the pushed head: commits not pushed come first.
    ['commits not pushed, over conflicts and a red check', pull(1, { mergeableState: 'dirty', checks: checks(1, 1) }), ws({ ahead: 2 }), 'action/unpushed'],
    ['a removed worktree has nothing left to push', pull(1), ws({ ahead: 2, removed: true }), 'ready/ready'],
    ['conflicts with the base', pull(1, { mergeableState: 'dirty' }), null, 'action/conflicts'],
    ['a red check, over changes requested', pull(1, { checks: checks(2, 1), reviews: reviews([{ user: 'a', state: 'CHANGES_REQUESTED' }]) }), null, 'action/ciFailed'],
    ['changes requested', pull(1, { reviews: reviews([{ user: 'a', state: 'CHANGES_REQUESTED' }]) }), null, 'action/changesRequested'],
    ['behind a base that must be merged in first', pull(1, { mergeableState: 'behind' }), null, 'action/behind'],
    // A stacked one waits on the one below, even while its own checks run.
    ['stacked on another open one', pull(2, { stackedOn: { number: 1, url: 'u' }, checks: checks(1, 0, 2) }), null, 'waiting/stacked'],
    ['checks running', pull(1, { checks: checks(1, 0, 2) }), null, 'waiting/ciRunning'],
    ['a draft', pull(1, { draft: true, mergeableState: 'draft' }), null, 'waiting/draft'],
    ['a review requested, even when it could merge', pull(1, { requestedReviewers: ['grace'] }), null, 'waiting/reviewRequested'],
    ['blocked without an approval: a review is required', pull(1, { mergeableState: 'blocked' }), null, 'waiting/reviewRequired'],
    ['blocked although approved: the branch rules', pull(1, { mergeableState: 'blocked', reviews: reviews([{ user: 'a', state: 'APPROVED' }]) }), null, 'waiting/blocked'],
    ['GitHub still computing', pull(1, { mergeableState: 'unknown' }), null, 'waiting/computing'],
    ['clean', pull(1), null, 'ready/ready'],
    ['unstable: a check that is not required failed earlier, now green', pull(1, { mergeableState: 'unstable' }), null, 'ready/ready'],
    ['mergeability unknown to us, approved', pull(1, { mergeableState: null, reviews: reviews([{ user: 'a', state: 'APPROVED' }]) }), null, 'ready/ready'],
    ['mergeability unknown to us, nothing else said', pull(1, { mergeableState: null }), null, 'waiting/open'],
  ])('%s', (_label, pr, w, expected) => {
    expect(code(pr, w)).toBe(expected);
  });

  test('the verdict carries what its text needs', () => {
    expect(prVerdict(pull(1, { mergeableState: 'dirty', baseRef: 'develop' })).params).toEqual({ base: 'develop' });
    expect(prVerdict(pull(1, { checks: checks(2, 1, 0, { failing: [{ name: 'test', jobId: 4 }] }) })).params).toEqual({ count: 1, name: 'test' });
    const running = checks(1, 0, 2, { running: [{ name: 'lint', step: null }, { name: 'e2e', step: { number: 5, total: 8 } }] });
    expect(prVerdict(pull(1, { checks: running })).params).toEqual({ count: 2, name: 'e2e', step: { number: 5, total: 8 } });
    expect(prVerdict(pull(1, { state: 'merged', mergedAt: '2026-10-12T08:00:00Z' })).params).toEqual({ at: '2026-10-12T08:00:00Z' });
  });
});

describe('a worktree without a pull request', () => {
  test.each([
    ['never published', ws({ upstream: null }), 'unpublished'],
    ['commits not pushed', ws({ ahead: 3 }), 'unpushed'],
    ['pushed, no pull request yet', ws({ pr: { authenticated: true, pullRequest: null, createUrl: 'https://x' } }), 'noPr'],
  ])('%s', (_label, w, expected) => {
    expect(branchVerdict(w).code).toBe(expected);
    expect(branchVerdict(w).group).toBe('action');
  });

  test.each([
    ['the base itself', ws({ onBase: true, upstream: null })],
    ['a branch with no commit of its own', ws({ upstream: null, commits: [] })],
    ['a removed worktree', ws({ removed: true, upstream: null })],
    // A lookup that failed is not "no pull request": the notice says why instead.
    ['a lookup that failed', ws({ pr: { authenticated: true, pullRequest: null, createUrl: 'https://x', error: 'API error: 502' } })],
    ['no GitHub login', ws({ pr: { authenticated: false, createUrl: 'https://x' } })],
  ])('nothing to do: %s', (_label, w) => {
    expect(branchVerdict(w)).toBeNull();
  });
});

const sessionOf = () => ({
  isRepo: true,
  mode: 'session',
  workspaces: [
    ws({ branch: 'feat/1', dir: '/wt/1', pr: { authenticated: true, pullRequest: pull(1, { mergeableState: 'dirty', createdHere: true }) } }),
    ws({ branch: 'feat/local', dir: '/wt/local', upstream: null, pr: { authenticated: true, pullRequest: null, createUrl: 'https://x' } }),
    ws({ branch: 'main', dir: '/repo', onBase: true }),
  ],
  createdPrs: [
    { url: pull(3).url, number: 3, repo: 'acme/app', authenticated: true, pullRequest: pull(3) },
    { url: pull(4).url, number: 4, repo: 'acme/app', authenticated: true, pullRequest: pull(4, { checks: checks(1, 1), updatedAt: '2026-10-12T12:00:00Z' }) },
    { url: pull(5).url, number: 5, repo: 'acme/app', authenticated: true, pullRequest: pull(5, { checks: checks(1, 1), updatedAt: '2026-10-12T09:00:00Z' }) },
    { url: 'https://github.com/acme/app/pull/6', number: 6, repo: 'acme/app', authenticated: true, pullRequest: null, error: 'API error: 502' },
  ],
});

describe('rows and groups', () => {
  test('a row per pull request and per worktree that needs one, each acting in its own worktree', () => {
    const rows = rowsOf(sessionOf());
    expect(rows.map((r) => [r.kind, r.pr?.number || r.ws.branch, r.wsIndex, r.verdict.code])).toEqual([
      ['pr', 1, 0, 'conflicts'],
      ['branch', 'feat/local', 1, 'unpublished'],
      ['pr', 3, null, 'ready'],
      ['pr', 4, null, 'ciFailed'],
      ['pr', 5, null, 'ciFailed'],
    ]);
    expect(rows.filter((r) => r.createdHere).map((r) => r.pr.number)).toEqual([1, 3, 4, 5]);
  });

  test('the folder alone is one worktree; not a repository, no rows', () => {
    const folder = { ...ws({ ahead: 1 }), mode: 'project', pr: { authenticated: true, pullRequest: pull(8) } };
    expect(rowsOf(folder).map((r) => [r.pr.number, r.wsIndex, r.verdict.code])).toEqual([[8, 0, 'unpushed']]);
    expect(rowsOf({ isRepo: false })).toEqual([]);
  });

  test('inside a group, the most pressing first, then the latest updated', () => {
    const groups = groupRows(rowsOf(sessionOf()));
    expect(groups.action.map((r) => r.pr?.number || r.ws.branch)).toEqual([1, 4, 5, 'feat/local']);
    expect(groups.ready.map((r) => r.pr.number)).toEqual([3]);
    expect(groups.waiting).toEqual([]);
  });

  test('a stacked pull request comes right under the one it sits on, when they wait together', () => {
    const s = { isRepo: true, mode: 'session', workspaces: [], createdPrs: [
      pull(67, { stackedOn: { number: 66 }, updatedAt: '2026-10-12T12:00:00Z' }),
      pull(65, { checks: checks(1, 0, 1) }),
      pull(66, { requestedReviewers: ['grace'] }),
      pull(69, { stackedOn: { number: 61 } }), // its parent is elsewhere: stays where its verdict puts it
      pull(61, { mergeableState: 'dirty' }),
    ].map((pr) => ({ authenticated: true, pullRequest: pr })) };
    expect(groupRows(rowsOf(s)).waiting.map((r) => r.pr.number)).toEqual([65, 69, 66, 67]);
  });

  test('the tab counts what needs the user', () => {
    expect(attentionCount(sessionOf())).toBe(4);
    expect(attentionCount({ isRepo: false })).toBe(0);
  });

  test('a lookup that failed is said once per cause, above the rows', () => {
    const s = sessionOf();
    s.workspaces.push(ws({ branch: 'feat/9', pr: { authenticated: true, pullRequest: null, error: 'API error: 502', repo: 'acme/app' } }));
    s.workspaces.push(ws({ branch: 'feat/10', pr: { authenticated: false } }), ws({ branch: 'feat/11', pr: { authenticated: false } }));
    s.createdPrs.push({ authenticated: true, pullRequest: null, ssoRequired: { org: 'Sterll', url: 'https://github.com/orgs/Sterll/sso' } });
    expect(noticesOf(s)).toEqual([
      { kind: 'error', error: 'API error: 502' },
      { kind: 'login' },
      { kind: 'sso', org: 'Sterll', url: 'https://github.com/orgs/Sterll/sso' },
    ]);
  });

  test('the repository is named only when there are several, by owner for a fork and its upstream', () => {
    const rowsFor = (...repos) => repos.map((repo, i) => ({ pr: pull(i, { repo }) }));
    expect(repoLabeller(rowsFor('acme/app', 'acme/app'))('acme/app')).toBe('');
    expect(repoLabeller(rowsFor('bleleve/claude-terminal', 'Sterll/claude-terminal'))('Sterll/claude-terminal')).toBe('Sterll');
    expect(repoLabeller(rowsFor('acme/app', 'acme/docs'))('acme/docs')).toBe('acme/docs');
  });
});

describe('what a verdict says', () => {
  test('one failed check is named, several are counted; a running job says its step', () => {
    expect(verdictText(prVerdict(pull(1, { checks: checks(2, 1, 0, { failing: [{ name: 'test' }] }) })))).toBe(t('chat.git.verdict.ciFailedOne', { name: 'test' }));
    expect(verdictText(prVerdict(pull(1, { checks: checks(2, 2, 0, { failing: [{ name: 'a' }, { name: 'b' }] }) })))).toBe(t('chat.git.verdict.ciFailedMany', { count: 2 }));
    const running = checks(0, 0, 1, { running: [{ name: 'e2e', step: { number: 5, total: 8 } }] });
    expect(verdictText(prVerdict(pull(1, { checks: running })))).toBe(t('chat.git.verdict.ciStep', { name: 'e2e', number: 5, total: 8 }));
    expect(verdictText(prVerdict(pull(1, { checks: checks(0, 0, 3) })))).toBe(t('chat.git.checksPending', { count: 3 }));
  });

  test('who is asked, and what it waits on', () => {
    expect(verdictText(prVerdict(pull(1, { requestedReviewers: ['grace', 'core-team'] })))).toBe(t('chat.git.verdict.reviewRequested', { users: 'grace, core-team' }));
    expect(verdictText(prVerdict(pull(2, { stackedOn: { number: 1 } })))).toBe(t('chat.git.verdict.stacked', { number: 1 }));
    expect(verdictText(prVerdict(pull(1, { state: 'merged', updatedAt: null })))).toBe(t('chat.git.prMerged'));
  });
});

describe('prompts for the composer', () => {
  const pr = pull(57, { headRef: 'feat/x', baseRef: 'main', repo: 'acme/app' });

  test('conflicts and a base behind are merged in, never rebased: the branch is already pushed', () => {
    const conflicts = conflictsPrompt({ pr, dir: '/wt/x' });
    expect(conflicts).toContain('Pull request #57 (branch `feat/x`) of acme/app has conflicts with its base `main`.');
    expect(conflicts).toContain('checked out in `/wt/x`');
    expect(conflicts).toContain('merge it into the branch, resolve the conflicts');
    expect(behindPrompt({ pr })).toContain('is behind its base `main`');
    expect(behindPrompt({ pr })).not.toContain('checked out');
    expect(`${conflicts}${behindPrompt({ pr })}`).not.toMatch(/rebase/i);
  });

  test('a review: what each reviewer wrote, then the comments on the code in file order', () => {
    const reviewed = { ...pr, reviews: reviews([
      { user: 'grace', state: 'CHANGES_REQUESTED', body: 'Two things.\nSee inline.' },
      { user: 'ada', state: 'CHANGES_REQUESTED', body: '' },
      { user: 'linus', state: 'APPROVED' },
    ]) };
    const text = reviewPrompt({ pr: reviewed, comments: [
      { user: 'grace', path: 'src/b.js', line: 3, body: 'Rename this.', createdAt: '2026-10-12T10:00:00Z' },
      { user: 'grace', path: 'src/a.js', line: 40, body: 'Off by one?\nCheck the bound.', createdAt: '2026-10-12T10:01:00Z' },
    ] });
    expect(text).toContain('@grace wrote:\n> Two things.\n> See inline.');
    expect(text).toContain('@ada requested changes without a summary.');
    expect(text).not.toContain('linus');
    expect(text.indexOf('src/a.js:40')).toBeLessThan(text.indexOf('src/b.js:3'));
    expect(text).toContain('- `src/a.js:40`, @grace:\n  > Off by one?\n  > Check the bound.');
    expect(text.trimEnd().endsWith('Address this feedback, then push.')).toBe(true);
  });

  test('only the latest comments go in, and comments that could not be read point at the pull request', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ user: 'g', path: `f${String(i).padStart(2, '0')}.js`, line: 1, body: `c${i}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() }));
    const text = reviewPrompt({ pr, comments: many });
    expect(text).toContain('`f39.js:1`');
    expect(text).toContain('`f10.js:1`');
    expect(text).not.toContain('`f09.js:1`');
    expect(reviewPrompt({ pr, comments: null })).toContain('could not be retrieved: https://github.com/acme/app/pull/57');
  });
});
