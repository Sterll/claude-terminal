/**
 * The side column's Branches. What it must get right: every branch the
 * session worked on, once, under the same key the Git tab uses; the ones that
 * need the user first; the pull request chip coloured by the tab's verdict;
 * and a click that goes where it says (the tab for a row, GitHub for a chip).
 */

'use strict';

const { createSideGit, branchRowsOf } = require('../../src/renderer/ui/components/chat/sideGit');
const { rowsOf } = require('../../src/renderer/ui/components/chat/sessionPrs');
const { t } = require('../../src/renderer/i18n');

const okChecks = (n = 3) => ({ total: n, success: n, failure: 0, pending: 0, skipped: 0, failing: [], running: [] });
const pull = (number, over = {}) => ({
  number, title: `PR ${number}`, state: 'open', draft: false, url: `https://github.com/acme/app/pull/${number}`,
  repo: 'acme/app', headRef: `feat/${number}`, baseRef: 'main', updatedAt: '2026-10-12T10:00:00Z',
  mergeableState: 'clean', requestedReviewers: [], checks: okChecks(), reviews: { approved: 1, changesRequested: 0, decisions: [] }, ...over,
});
const ws = (over = {}) => ({
  isRepo: true, branch: 'feat/x', head: 'abc1234', upstream: 'origin/feat/x', ahead: 0, behind: 0, onBase: false,
  dirty: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }, commits: [{ sha: 'a' }],
  dir: '/repo/.claude/worktrees/x', label: '.claude/worktrees/x', isRoot: false, at: 1, pr: { authenticated: true, pullRequest: null }, ...over,
});
const created = (pr) => ({ url: pr.url, number: pr.number, repo: pr.repo, authenticated: true, pullRequest: pr });

// #1 ready, #2 a failed check (needs you), feat/clean nothing to say, a removed
// worktree whose #3 merged, and #4 opened from elsewhere, waiting on review.
const overview = () => ({
  isRepo: true,
  mode: 'session',
  workspaces: [
    ws({ branch: 'feat/1', dir: '/wt/1', pr: { authenticated: true, pullRequest: pull(1) } }),
    ws({
      branch: 'feat/2', dir: '/wt/2', ahead: 0, behind: 2, dirty: { staged: 1, unstaged: 1, untracked: 0, conflicts: 0 },
      pr: { authenticated: true, pullRequest: pull(2, { checks: { ...okChecks(2), total: 3, failure: 1, failing: [{ name: 'test' }] } }) },
    }),
    ws({ branch: 'feat/clean', dir: '/wt/clean', commits: [], pr: { authenticated: true, pullRequest: null } }),
    { dir: '/wt/old', at: 0, branch: 'chore/old', removed: true, isRoot: false, label: 'wt/old', pr: { authenticated: true, pullRequest: pull(3, { state: 'merged', mergedAt: '2026-10-12T08:00:00Z' }) } },
  ],
  createdPrs: [
    created(pull(4, { mergeableState: 'blocked', reviews: { approved: 0, changesRequested: 0, decisions: [] } })),
    // Also a worktree's: listed once.
    created(pull(1)),
  ],
});

describe('branchRowsOf', () => {
  test('every branch once, what needs the user first, what is done last', () => {
    const rows = branchRowsOf(overview());
    expect(rows.map((r) => r.branch)).toEqual(['feat/2', 'feat/4', 'feat/1', 'feat/clean', 'chore/old']);
    expect(rows.map((r) => r.verdict?.group || null)).toEqual(['action', 'waiting', 'ready', null, 'done']);
  });

  test('a row carries the Git tab\'s own key, so the tab can point at it', () => {
    const tabKeys = new Set(rowsOf(overview()).map((r) => r.key));
    for (const row of branchRowsOf(overview()).filter((r) => r.verdict)) expect(tabKeys.has(row.key)).toBe(true);
  });

  test('a session that never left the folder is the folder\'s branch; no repository, no rows', () => {
    const folder = { ...ws({ branch: 'main', onBase: true, commits: [] }), mode: undefined, dir: undefined, label: undefined };
    const rows = branchRowsOf(folder);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ branch: 'main', verdict: null });
    expect(branchRowsOf({ isRepo: false })).toEqual([]);
    expect(branchRowsOf(null)).toEqual([]);
  });
});

describe('createSideGit', () => {
  let bodyEl;
  let deps;
  let side;
  const row = (branch) => [...bodyEl.querySelectorAll('.chat-side-branch')].find((el) => el.querySelector('.chat-side-branch-name').textContent === branch);

  beforeEach(() => {
    document.body.innerHTML = '<div class="body"></div>';
    bodyEl = document.querySelector('.body');
    deps = { bodyEl, onOpen: jest.fn(), onOpenTab: jest.fn(), openExternal: jest.fn() };
    side = createSideGit(deps);
  });

  afterEach(() => side.destroy());

  test('counts the branches and the ones that need the user', () => {
    expect(side.stats(overview())).toEqual({ count: 5, attention: 1 });
    expect(side.stats({ isRepo: false })).toEqual({ count: 0, attention: 0 });
  });

  test('a row says where the branch is and where it stands', () => {
    side.render(overview());
    const failing = row('feat/2');
    expect(failing.querySelector('.chat-side-pr').className).toBe('chat-side-pr action');
    expect(failing.querySelector('.chat-side-pr').textContent).toBe('#2');
    const meta = failing.querySelector('.chat-side-branch-meta').textContent.replace(/\s+/g, ' ').trim();
    expect(meta).toContain(t('chat.side.worktree'));
    expect(meta).toContain('↓2');
    expect(meta).toContain('±2');
    expect(failing.querySelector('.chat-side-verdict.action').textContent).toBe(t('chat.git.verdict.ciFailedOne', { name: 'test' }));

    expect(row('chore/old').classList.contains('removed')).toBe(true);
    expect(row('chore/old').textContent).toContain(t('chat.git.removedWorktree'));
    expect(row('chore/old').querySelector('.chat-side-pr').className).toBe('chat-side-pr done');
    // Nothing to do and no pull request: the branch alone, no chip, no verdict.
    expect(row('feat/clean').querySelector('.chat-side-pr')).toBeNull();
    expect(row('feat/clean').querySelector('.chat-side-verdict')).toBeNull();
  });

  test('the project folder is named as such, and text from git is escaped', () => {
    side.render({ ...ws({ branch: 'feat/<img src=x onerror=alert(1)>', isRoot: true }), dir: '/repo' });
    expect(bodyEl.querySelector('img')).toBeNull();
    expect(bodyEl.querySelector('.chat-side-branch-name').textContent).toBe('feat/<img src=x onerror=alert(1)>');
    expect(bodyEl.querySelector('.chat-side-branch-meta').textContent).toContain(t('chat.git.projectFolder'));
  });

  test('a row opens the Git tab on it, the chip opens the pull request, the footer the tab', () => {
    side.render(overview());
    row('feat/2').querySelector('.chat-side-branch-name').click();
    expect(deps.onOpen).toHaveBeenCalledWith('https://github.com/acme/app/pull/2');

    row('feat/1').querySelector('.chat-side-pr').click();
    expect(deps.openExternal).toHaveBeenCalledWith('https://github.com/acme/app/pull/1');
    expect(deps.onOpen).toHaveBeenCalledTimes(1);

    row('feat/clean').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(deps.onOpen).toHaveBeenLastCalledWith('branch:/wt/clean');

    bodyEl.querySelector('[data-action="open-tab"]').click();
    expect(deps.onOpenTab).toHaveBeenCalledTimes(1);
  });
});
