/**
 * A session's own worktrees, against real repositories. The project folder
 * sits on an unrelated branch (as it does when sessions work in worktrees),
 * which is exactly what every session's Git tab used to show. GitHub and the
 * transcript reader are faked.
 */

'use strict';

jest.mock('../../src/main/services/GitHubAuthService', () => ({
  parseGitHubRemote: (url) => {
    const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url || '');
    return m ? { owner: m[1], repo: m[2] } : null;
  },
  getPullRequestsForBranch: jest.fn(),
  getPullRequest: jest.fn(),
  getCheckRuns: jest.fn(),
  getPullRequestReviews: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const github = require('../../src/main/services/GitHubAuthService');
const { overview, _internals } = require('../../src/main/services/SessionGitService');

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const commit = (cwd, file, msg) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), `${msg}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', msg);
};

let dir;
let proj;
let wtA;
let wtB;
let other;

beforeAll(() => {
  // Native realpath, as the code uses: on Windows it expands 8.3 short names (RUNNER~1).
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ct-session-overview-')));
  const seed = path.join(dir, 'seed');
  git(dir, 'init', '-q', '-b', 'main', seed);
  commit(seed, 'a.txt', 'A on main');
  git(dir, 'init', '-q', '--bare', '-b', 'main', path.join(dir, 'origin.git'));
  git(seed, 'push', '-q', path.join(dir, 'origin.git'), 'main');

  proj = path.join(dir, 'proj');
  git(dir, 'clone', '-q', path.join(dir, 'origin.git'), proj);
  git(proj, 'checkout', '-q', '-b', 'docs/unrelated');
  commit(proj, 'docs.md', 'docs on the folder branch');

  wtA = path.join(proj, '.claude', 'worktrees', 'a');
  git(proj, 'worktree', 'add', '-q', '-b', 'feat/a', wtA, 'origin/main');
  commit(wtA, 'src/a.js', 'work on a');

  // A worktree the session used, removed since: only its branch is left.
  wtB = path.join(proj, '.claude', 'worktrees', 'b');
  git(proj, 'worktree', 'add', '-q', '-b', 'feat/b', wtB, 'origin/main');
  git(proj, 'worktree', 'remove', wtB);

  other = path.join(dir, 'other');
  git(dir, 'init', '-q', '-b', 'main', other);
  commit(other, 'x.txt', 'another repository');

  git(proj, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git');
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

beforeEach(() => {
  _internals.topCache.clear();
  github.getPullRequestsForBranch.mockReset().mockResolvedValue({ authenticated: true, pullRequests: [] });
  github.getPullRequest.mockReset().mockResolvedValue({ authenticated: true, pullRequest: null, notFound: true });
  github.getCheckRuns.mockReset().mockResolvedValue({ checkRuns: [] });
  github.getPullRequestReviews.mockReset().mockResolvedValue({ reviews: [] });
});

const activityOf = (dirs, prs = [], edits = []) => ({ read: jest.fn(async () => ({ dirs, prs, edits })) });
const d = (p, at, kinds, branch = null) => ({ dir: p, at, kinds, branch });

test('without a session id, the project folder as before', async () => {
  const o = await overview({ projectPath: proj });
  expect(o).toMatchObject({ isRepo: true, mode: 'project', branch: 'docs/unrelated' });
});

test('a session that never left the folder is the folder', async () => {
  const o = await overview({ projectPath: proj, sessionId: 's1' }, { activity: activityOf([d(proj, 1, ['cwd'])]) });
  expect(o).toMatchObject({ mode: 'project', branch: 'docs/unrelated' });
});

test('the worktrees it used, not the folder\'s branch, and nothing from another repository', async () => {
  const activity = activityOf([
    d(path.join(other), 9, ['edit']),
    d(path.join(wtA, 'src'), 5, ['cwd']),
    d(proj, 1, ['cwd']),
  ]);
  const o = await overview({ projectPath: proj, sessionId: 's1' }, { activity });
  expect(activity.read).toHaveBeenCalledWith(proj, 's1');
  expect(o.mode).toBe('session');
  expect(o.workspaces.map((w) => [w.label, w.branch])).toEqual([[path.join('.claude', 'worktrees', 'a'), 'feat/a']]);
  expect(o.workspaces[0]).toMatchObject({ isRoot: false, dir: fs.realpathSync.native(wtA) });
});

test('notes written in the folder do not tie the session to its branch', async () => {
  // Untracked files, as a session's analyses and notes are: the folder's
  // branch (and its pull request) is not this session's work.
  fs.mkdirSync(path.join(proj, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'notes', 'recette.md'), 'notes\n');
  const o = await overview({ projectPath: proj, sessionId: 's1' }, { activity: activityOf(
    [d(path.join(proj, 'notes'), 7, ['edit']), d(wtA, 5, ['enter', 'cwd'], 'feat/a')],
    [],
    [{ file: path.join(proj, 'notes', 'recette.md'), at: 7 }],
  ) });
  expect(o.workspaces.map((w) => w.branch)).toEqual(['feat/a']);
});

test('the folder counts once the session changed a tracked file there, newest first', async () => {
  const o = await overview({ projectPath: proj, sessionId: 's1' }, { activity: activityOf(
    [d(proj, 7, ['edit']), d(wtA, 5, ['enter', 'cwd'], 'feat/a')],
    [],
    [{ file: path.join(proj, 'docs.md'), at: 7 }],
  ) });
  expect(o.workspaces.map((w) => [w.label, w.branch, w.isRoot])).toEqual([
    [null, 'docs/unrelated', true],
    [path.join('.claude', 'worktrees', 'a'), 'feat/a', false],
  ]);
});

test('a removed worktree keeps its branch and that branch\'s pull request', async () => {
  github.getPullRequestsForBranch.mockImplementation(async (owner, repo, headOwner, branch) => ({
    authenticated: true,
    pullRequests: branch === 'feat/b' ? [{ number: 12, title: 'b', state: 'merged', url: 'https://github.com/acme/app/pull/12', headSha: null }] : [],
  }));
  // As the transcript wrote it: on macOS the temp folder is /var/…, really /private/var/….
  const asWritten = wtB.replace(fs.realpathSync.native(os.tmpdir()), os.tmpdir());
  const o = await overview({ projectPath: proj, sessionId: 's1' }, { activity: activityOf([d(asWritten, 4, ['enter', 'cwd'], 'feat/b')]) });
  expect(o.workspaces).toEqual([expect.objectContaining({ removed: true, branch: 'feat/b', label: path.join('.claude', 'worktrees', 'b') })]);
  expect(o.workspaces[0].pr.pullRequest).toMatchObject({ number: 12, state: 'merged' });
  expect(github.getPullRequestsForBranch).toHaveBeenCalledWith('acme', 'app', 'acme', 'feat/b');
});

test('the pull requests it opened: marked on their card, the others listed with their state', async () => {
  github.getPullRequestsForBranch.mockImplementation(async (owner, repo, headOwner, branch) => ({
    authenticated: true,
    pullRequests: branch === 'feat/a' ? [{ number: 7, title: 'a', state: 'open', url: 'https://github.com/acme/app/pull/7', headSha: 'aaa' }] : [],
  }));
  github.getPullRequest.mockResolvedValue({ authenticated: true, pullRequest: { number: 9, title: 'elsewhere', state: 'open', url: 'https://github.com/acme/app/pull/9', headSha: 'bbb', headRef: 'feat/z' } });
  github.getCheckRuns.mockResolvedValue({ checkRuns: [{ name: 'ci', status: 'completed', conclusion: 'success' }] });
  const pr = (n) => ({ host: 'github.com', owner: 'acme', repo: 'app', number: n, url: `https://github.com/acme/app/pull/${n}`, at: n });
  const o = await overview({ projectPath: proj, sessionId: 's1' }, { activity: activityOf([d(wtA, 5, ['cwd'])], [pr(7), pr(9)]) });

  expect(o.workspaces[0].pr.pullRequest).toMatchObject({ number: 7, createdHere: true });
  expect(o.createdPrs).toEqual([expect.objectContaining({ number: 9, repo: 'acme/app', pullRequest: expect.objectContaining({ number: 9, checks: expect.objectContaining({ success: 1 }) }) })]);
  expect(github.getPullRequest).toHaveBeenCalledTimes(1);
  expect(github.getPullRequest).toHaveBeenCalledWith('acme', 'app', 9);
});

test('a pull request it opened that GitHub will not show says why', async () => {
  github.getPullRequest.mockResolvedValue({ authenticated: true, pullRequest: null, ssoRequired: { url: 'https://github.com/orgs/acme/sso?authorization_request=x', org: 'acme' } });
  const pr = { host: 'github.com', owner: 'acme', repo: 'app', number: 3, url: 'https://github.com/acme/app/pull/3', at: 1 };
  const o = await overview({ projectPath: proj, sessionId: 's1' }, { activity: activityOf([], [pr]) });
  expect(o).toMatchObject({ mode: 'session', workspaces: [] });
  expect(o.createdPrs[0]).toMatchObject({ number: 3, pullRequest: null, ssoRequired: { org: 'acme', repo: 'acme/app' } });
});
