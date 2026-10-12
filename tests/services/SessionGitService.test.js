/**
 * The chat's Git tab, against real repositories: an upstream, a fork that is
 * ahead of it, and a feature branch pushed to the fork - the shape this repo is
 * developed in. GitHub is the only thing faked.
 *
 * The case that matters most is the base: a branch that tracks the fork is
 * measured against the fork's main. Measured against origin/main (upstream) it
 * would list every commit the fork has that upstream does not.
 */

'use strict';

jest.mock('../../src/main/services/GitHubAuthService', () => ({
  parseGitHubRemote: (url) => {
    const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url || '');
    return m ? { owner: m[1], repo: m[2] } : null;
  },
  getPullRequestsForBranch: jest.fn(),
  getCheckRuns: jest.fn(),
  getPullRequestReviews: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const github = require('../../src/main/services/GitHubAuthService');
const { summary, _internals } = require('../../src/main/services/SessionGitService');

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const commit = (cwd, file, msg) => {
  fs.writeFileSync(path.join(cwd, file), `${msg}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', msg);
};

let dir;
let work;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-session-git-'));
  const seed = path.join(dir, 'seed');
  git(dir, 'init', '-q', '-b', 'main', seed);
  commit(seed, 'a.txt', 'A on main');
  git(dir, 'init', '-q', '--bare', '-b', 'main', path.join(dir, 'upstream.git'));
  git(dir, 'init', '-q', '--bare', '-b', 'main', path.join(dir, 'fork.git'));
  git(seed, 'push', '-q', path.join(dir, 'upstream.git'), 'main');
  commit(seed, 'b.txt', 'B only on the fork');
  git(seed, 'push', '-q', path.join(dir, 'fork.git'), 'main');

  work = path.join(dir, 'work');
  git(dir, 'clone', '-q', '-o', 'fork', path.join(dir, 'fork.git'), work);
  git(work, 'remote', 'add', 'origin', path.join(dir, 'upstream.git'));
  git(work, 'fetch', '-q', 'origin');
  git(work, 'checkout', '-q', '-b', 'feat/x', 'fork/main');
  commit(work, 'c.txt', 'C on the branch');
  commit(work, 'd.txt', 'D on the branch');
  git(work, 'push', '-q', '-u', 'fork', 'feat/x');
  commit(work, 'e.txt', 'E not pushed yet');
  fs.writeFileSync(path.join(work, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(work, 'new.txt'), 'untracked\n');
  fs.writeFileSync(path.join(work, 'c.txt'), 'staged\n');
  git(work, 'add', 'c.txt');
  // Remote URLs as GitHub would have them; nothing fetches from here on.
  git(work, 'remote', 'set-url', 'fork', 'https://github.com/bleleve/claude-terminal.git');
  git(work, 'remote', 'set-url', 'origin', 'git@github.com:Sterll/claude-terminal.git');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

beforeEach(() => {
  github.getPullRequestsForBranch.mockReset().mockResolvedValue({ authenticated: true, pullRequests: [] });
  github.getCheckRuns.mockReset().mockResolvedValue({ checkRuns: [] });
  github.getPullRequestReviews.mockReset().mockResolvedValue({ reviews: [] });
});

test('a folder that is not a repository says so', async () => {
  await expect(summary(dir)).resolves.toEqual({ isRepo: false });
  await expect(summary('')).resolves.toEqual({ isRepo: false });
});

test('a branch tracking the fork is measured against the fork\'s main', async () => {
  const s = await summary(work, { withPullRequest: false });
  expect(s).toMatchObject({
    isRepo: true,
    branch: 'feat/x',
    detached: false,
    worktree: false,
    upstream: 'fork/feat/x',
    remote: 'fork',
    ahead: 1,
    behind: 0,
    base: 'fork/main',
    onBase: false,
  });
  expect(s.commits.map((c) => c.subject)).toEqual(['E not pushed yet', 'D on the branch', 'C on the branch']);
  expect(s.commits[0]).toMatchObject({ author: 'Ada', short: expect.stringMatching(/^[0-9a-f]{7,}$/) });
});

test('uncommitted work is counted by kind', async () => {
  const s = await summary(work, { withPullRequest: false });
  expect(s.dirty).toEqual({ staged: 1, unstaged: 1, untracked: 1, conflicts: 0 });
});

test('the pull request is looked up on the fork, under the fork\'s owner', async () => {
  github.getPullRequestsForBranch.mockImplementation(async (owner) => ({
    authenticated: true,
    pullRequests: owner === 'bleleve'
      ? [{ number: 57, title: 'ENG-142: session tab', state: 'open', draft: false, url: 'https://github.com/bleleve/claude-terminal/pull/57', headSha: 'abc123' }]
      : [],
  }));
  github.getCheckRuns.mockResolvedValue({ checkRuns: [
    { name: 'lint', status: 'completed', conclusion: 'success' },
    { name: 'test', status: 'completed', conclusion: 'failure', url: 'https://ci/test' },
    { name: 'e2e', status: 'in_progress', conclusion: null },
    { name: 'docs', status: 'completed', conclusion: 'skipped' },
  ] });
  github.getPullRequestReviews.mockResolvedValue({ reviews: [
    { user: 'yanis', state: 'CHANGES_REQUESTED' },
    { user: 'yanis', state: 'APPROVED' },
    { user: 'yanis', state: 'COMMENTED' },
    { user: 'grace', state: 'COMMENTED' },
  ] });

  const s = await summary(work);
  expect(github.getPullRequestsForBranch).toHaveBeenCalledWith('bleleve', 'claude-terminal', 'bleleve', 'feat/x');
  expect(github.getCheckRuns).toHaveBeenCalledWith('bleleve', 'claude-terminal', 'abc123');
  expect(s.pr.authenticated).toBe(true);
  expect(s.pr.pullRequest).toMatchObject({
    number: 57,
    repo: 'bleleve/claude-terminal',
    checks: { total: 4, success: 1, failure: 1, pending: 1, skipped: 1, failing: [{ name: 'test', url: 'https://ci/test' }] },
    reviews: { approved: 1, changesRequested: 0 },
  });
  expect(s.pr.pullRequest.reviews.decisions).toEqual([{ user: 'yanis', state: 'APPROVED' }, { user: 'grace', state: 'COMMENTED' }]);
});

test('without a pull request, it offers the compare page on the fork', async () => {
  const s = await summary(work);
  expect(github.getPullRequestsForBranch).toHaveBeenCalledTimes(2); // the fork, then origin
  expect(s.pr).toEqual({
    authenticated: true,
    pullRequest: null,
    createUrl: 'https://github.com/bleleve/claude-terminal/compare/main...feat%2Fx?expand=1',
  });
});

test('an organization behind SAML SSO is named, with the page that authorizes the token', async () => {
  const sso = { url: 'https://github.com/orgs/Sterll/sso?authorization_request=a1', org: 'Sterll' };
  github.getPullRequestsForBranch.mockImplementation(async (owner) => (owner === 'Sterll'
    ? { authenticated: true, pullRequests: [], ssoRequired: sso }
    : { authenticated: true, pullRequests: [] }));
  const s = await summary(work);
  expect(s.pr).toMatchObject({ authenticated: true, pullRequest: null, ssoRequired: { ...sso, repo: 'Sterll/claude-terminal' } });
});

test('a repository GitHub hides, or a failed lookup, is said rather than read as "no pull request"', async () => {
  github.getPullRequestsForBranch.mockResolvedValueOnce({ authenticated: true, pullRequests: [], notFound: true });
  expect((await summary(work)).pr).toMatchObject({ pullRequest: null, unreachable: 'bleleve/claude-terminal' });
  github.getPullRequestsForBranch.mockReset().mockResolvedValue({ authenticated: true, pullRequests: [], error: 'API error: 502' });
  expect((await summary(work)).pr).toMatchObject({ pullRequest: null, error: 'API error: 502', repo: 'bleleve/claude-terminal' });
});

test('a pull request found on one repository wins over another that could not be searched', async () => {
  github.getPullRequestsForBranch.mockImplementation(async (owner) => (owner === 'bleleve'
    ? { authenticated: true, pullRequests: [{ number: 57, title: 'x', state: 'merged', url: 'https://github.com/bleleve/claude-terminal/pull/57', headSha: null }] }
    : { authenticated: true, pullRequests: [], ssoRequired: { url: 'https://github.com/orgs/Sterll/sso', org: 'Sterll' } }));
  const s = await summary(work);
  expect(s.pr.pullRequest).toMatchObject({ number: 57, state: 'merged' });
  expect(s.pr.ssoRequired).toBeUndefined();
});

test('without a GitHub login, it says so instead of guessing', async () => {
  github.getPullRequestsForBranch.mockResolvedValue({ authenticated: false, pullRequests: [] });
  const s = await summary(work);
  expect(s.pr).toMatchObject({ authenticated: false });
});

test('on the base branch: recent commits, no pull request lookup', async () => {
  const main = path.join(dir, 'main-wt');
  git(work, 'worktree', 'add', '-q', main, 'main');
  const s = await summary(main);
  expect(s).toMatchObject({ branch: 'main', onBase: true, worktree: true, pr: null });
  expect(s.commits.map((c) => c.subject)).toEqual(['B only on the fork', 'A on main']);
  expect(github.getPullRequestsForBranch).not.toHaveBeenCalled();
});

test('a detached HEAD has no branch and no upstream', async () => {
  const detached = path.join(dir, 'detached-wt');
  git(work, 'worktree', 'add', '-q', '--detach', detached, 'HEAD~1');
  const s = await summary(detached);
  expect(s).toMatchObject({ detached: true, branch: null, upstream: null, ahead: 0, behind: 0 });
});

describe('helpers', () => {
  test('remote hosts from https and ssh URLs', () => {
    expect(_internals.remoteHost('https://github.example.com/a/b.git')).toBe('github.example.com');
    expect(_internals.remoteHost('git@github.com:a/b.git')).toBe('github.com');
    expect(_internals.remoteHost('/local/path')).toBeNull();
  });

  test('a plain comment does not override a reviewer\'s decision', () => {
    expect(_internals.summarizeReviews([{ user: 'a', state: 'APPROVED' }, { user: 'a', state: 'COMMENTED' }]).approved).toBe(1);
  });
});

test('a branch not published yet is measured against the closest base, not origin by default', async () => {
  const wt = path.join(dir, 'unpublished-wt');
  git(work, 'worktree', 'add', '-q', '--no-track', '-b', 'ada/eng-151', wt, 'fork/main');
  commit(wt, 'f.txt', 'F on an unpublished branch');
  const s = await summary(wt, { withPullRequest: false });
  expect(s.upstream).toBeNull();
  expect(s.base).toBe('fork/main');
  expect(s.commits.map((c) => c.subject)).toEqual(['F on an unpublished branch']);
});
