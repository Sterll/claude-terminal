/**
 * The renderer side of repositories in sub-folders: which folder projects
 * have some, which one the git surfaces work on, and that a pick reaches
 * every surface.
 */

const REPOS = [
  { name: 'api', path: '/x/api', branch: 'main', upstream: null, ahead: 0, behind: 0, changes: 2 },
  { name: 'web', path: '/x/web', branch: 'dev', upstream: null, ahead: 1, behind: 0, changes: 0 },
];

let git;
let nestedRepos;

beforeEach(() => {
  jest.resetModules();
  localStorage.clear();
  git = {
    statusQuick: jest.fn(async () => ({ isGitRepo: false })),
    nestedRepos: jest.fn(async () => ({ ok: true, repos: REPOS })),
  };
  window.electron_api = { ...(window.electron_api || {}), git };
  nestedRepos = require('../../src/renderer/utils/nestedRepos');
});

const project = { id: 'p1', path: '/x' };

test('a folder whose root is not a repository lists its sub-folder repositories', async () => {
  expect(await nestedRepos.listNestedRepos(project)).toEqual(REPOS);
  expect(git.nestedRepos).toHaveBeenCalledWith({ projectPath: '/x' });
});

test('a project that is a repository has none, and main is not asked to look', async () => {
  git.statusQuick.mockResolvedValue({ isGitRepo: true });
  expect(await nestedRepos.listNestedRepos(project)).toEqual([]);
  expect(git.nestedRepos).not.toHaveBeenCalled();
  expect(nestedRepos.getSelectedRepoPath('p1')).toBeNull();
});

test('a host that is away is not an answer: nothing is cached, the next look asks again', async () => {
  git.statusQuick.mockResolvedValueOnce({ isGitRepo: false, disconnected: true });
  expect(await nestedRepos.listNestedRepos(project)).toEqual([]);
  expect(git.nestedRepos).not.toHaveBeenCalled();
  expect(await nestedRepos.listNestedRepos(project)).toEqual(REPOS);
});

test('the listing is cached and shared by concurrent callers', async () => {
  const [a, b] = await Promise.all([nestedRepos.listNestedRepos(project), nestedRepos.listNestedRepos(project)]);
  expect(a).toBe(b);
  await nestedRepos.listNestedRepos(project);
  expect(git.nestedRepos).toHaveBeenCalledTimes(1);
  await nestedRepos.listNestedRepos(project, { force: true });
  expect(git.nestedRepos).toHaveBeenCalledTimes(2);
});

test('the first repository is used until another is picked, and the pick is told and remembered', async () => {
  await nestedRepos.listNestedRepos(project);
  expect(nestedRepos.getSelectedRepoPath('p1')).toBe('/x/api');

  const seen = [];
  const off = nestedRepos.onSelectionChange((id, p) => seen.push([id, p]));
  nestedRepos.selectRepo('p1', '/x/web');
  nestedRepos.selectRepo('p1', '/x/web');
  off();
  expect(seen).toEqual([['p1', '/x/web']]);
  expect(nestedRepos.getSelectedRepoPath('p1')).toBe('/x/web');

  jest.resetModules();
  const reloaded = require('../../src/renderer/utils/nestedRepos');
  await reloaded.listNestedRepos(project);
  expect(reloaded.getSelectedRepoPath('p1')).toBe('/x/web');
});

test('a picked repository that is gone falls back to the first one', async () => {
  nestedRepos.selectRepo('p1', '/x/removed');
  await nestedRepos.listNestedRepos(project);
  expect(nestedRepos.getSelectedRepo('p1').path).toBe('/x/api');
});

test('a stale listing stays readable while it is asked for again', async () => {
  await nestedRepos.listNestedRepos(project);
  nestedRepos.invalidateNestedRepos('p1');
  let release;
  git.nestedRepos.mockImplementationOnce(() => new Promise((r) => { release = r; }));
  const pending = nestedRepos.listNestedRepos(project);
  await new Promise((r) => setTimeout(r, 0));
  expect(nestedRepos.getSelectedRepoPath('p1')).toBe('/x/api');
  release({ ok: true, repos: [REPOS[1]] });
  expect(await pending).toEqual([REPOS[1]]);
  expect(nestedRepos.getSelectedRepoPath('p1')).toBe('/x/web');
});
