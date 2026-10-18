/**
 * @jest-environment node
 *
 * findNestedRepos: the repositories in the sub-folders of a project folder
 * that is not one itself (x/a, x/b... each with its own .git). Run against
 * real repositories, locally and through a real sh the way the remote driver
 * runs a script, so both paths must agree. Skipped where git (or sh, for the
 * remote half) is not installed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const git = require('../../src/main/utils/git');
const remotePath = require('../../src/shared/remote-path');
const { findSh, toShPath } = require('../helpers/fake-ssh');

const PROFILE = 'abcd1234';

describe('parseStatusBranchLine', () => {
  const parse = git.parseStatusBranchLine;

  test.each([
    ['## main', { branch: 'main', upstream: null, ahead: 0, behind: 0, gone: false }],
    ['## main...origin/main', { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, gone: false }],
    ['## feat/x...origin/feat/x [ahead 2, behind 3]', { branch: 'feat/x', upstream: 'origin/feat/x', ahead: 2, behind: 3, gone: false }],
    ['## dev...origin/dev [behind 1]', { branch: 'dev', upstream: 'origin/dev', ahead: 0, behind: 1, gone: false }],
    ['## old...origin/old [gone]', { branch: 'old', upstream: 'origin/old', ahead: 0, behind: 0, gone: true }],
    ['## No commits yet on main', { branch: 'main', upstream: null, ahead: 0, behind: 0, gone: false }],
    ['## HEAD (no branch)', { branch: null, upstream: null, ahead: 0, behind: 0, gone: false }],
    ['', { branch: null, upstream: null, ahead: 0, behind: 0, gone: false }],
  ])('%s', (line, expected) => {
    expect(parse(line)).toEqual(expected);
  });
});

let GIT_OK = false;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); GIT_OK = true; } catch { /* no git */ }
const SH = findSh();
const describeGit = GIT_OK ? describe : describe.skip;
const describeSh = GIT_OK && SH ? describe : describe.skip;

function gitIn(dir, ...args) {
  return execFileSync('git', ['-c', `safe.directory=${dir.replace(/\\/g, '/')}`, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo(dir, { commit = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'config', 'user.email', 't@example.com');
  gitIn(dir, 'config', 'user.name', 'T');
  if (commit) {
    fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-q', '-m', 'init');
  }
}

/**
 * x/
 *   api/          repository, 3 pending changes (inner/ shows as untracked), its own inner/ repository
 *   web/          repository, clean, on branch feat/ui
 *   tools/cli/    repository two levels down
 *   empty/        repository with no commit yet
 *   docs/         plain folder
 *   node_modules/pkg/  repository, never listed
 *   .cache/r/     hidden, never listed
 *   deep/a/b/     three levels down, past the limit
 */
function buildTree(root) {
  makeRepo(path.join(root, 'api'));
  fs.writeFileSync(path.join(root, 'api', 'README.md'), 'changed\n');
  fs.writeFileSync(path.join(root, 'api', 'new.txt'), 'new\n');
  makeRepo(path.join(root, 'api', 'inner'));
  makeRepo(path.join(root, 'web'));
  gitIn(path.join(root, 'web'), 'checkout', '-q', '-b', 'feat/ui');
  makeRepo(path.join(root, 'tools', 'cli'));
  makeRepo(path.join(root, 'empty'), { commit: false });
  fs.mkdirSync(path.join(root, 'docs'));
  makeRepo(path.join(root, 'node_modules', 'pkg'));
  makeRepo(path.join(root, '.cache', 'r'));
  makeRepo(path.join(root, 'deep', 'a', 'b'));
}

const EXPECTED = [
  { name: 'api', branch: 'main', changes: 3 },
  { name: 'empty', branch: 'main', changes: 0 },
  { name: 'tools/cli', branch: 'main', changes: 0 },
  { name: 'web', branch: 'feat/ui', changes: 0 },
];

describeGit('findNestedRepos on a local folder', () => {
  let root;

  beforeAll(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ct-nested-')));
    buildTree(root);
  });

  afterAll(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('lists the outermost repositories two levels down, skipping dependencies and hidden folders', async () => {
    const res = await git.findNestedRepos(root);
    expect(res.ok).toBe(true);
    expect(res.repos.map(({ name, branch, changes }) => ({ name, branch, changes }))).toEqual(EXPECTED);
    expect(res.repos.find((r) => r.name === 'tools/cli').path).toBe(path.join(root, 'tools', 'cli'));
    for (const r of res.repos) expect(r).toMatchObject({ upstream: null, ahead: 0, behind: 0 });
  });

  test('a missing folder is nodir, not an empty list that looks like an answer', async () => {
    expect(await git.findNestedRepos(path.join(root, 'gone'))).toMatchObject({ ok: false, reason: 'nodir', repos: [] });
  });
});

describeSh('findNestedRepos on a remote folder, through a real sh', () => {
  let root;

  beforeAll(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ct-nested-remote-')));
    buildTree(root);
    git._remoteInternals.reset();
    git._remoteInternals.setExecutor({
      resolve: async (uri) => {
        const { profileId, path: p } = remotePath.parse(uri);
        return { kind: 'remote', profileId, remotePath: p, uri };
      },
      exec: async (_target, script) => {
        const r = spawnSync(SH, ['-s'], { input: Buffer.from(`${script}\n`), encoding: 'buffer', env: { ...process.env, LC_ALL: 'C' } });
        return { ok: r.status === 0, code: r.status, stdout: r.stdout, stderr: r.stderr };
      },
      isConnected: () => true,
    });
  });

  afterAll(() => {
    git._remoteInternals.setExecutor(null);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('one request answers what the local walk answers, with URIs for paths', async () => {
    const uri = remotePath.format(PROFILE, toShPath(root));
    const res = await git.findNestedRepos(uri);
    expect(res.ok).toBe(true);
    expect(res.repos.map(({ name, branch, changes }) => ({ name, branch, changes }))).toEqual(EXPECTED);
    expect(res.repos.find((r) => r.name === 'tools/cli').path).toBe(remotePath.join(uri, 'tools', 'cli'));
  });
});
