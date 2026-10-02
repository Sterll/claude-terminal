/**
 * @jest-environment node
 *
 * The local argv of every exported git command, pinned against a snapshot
 * recorded before remote (SSH) routing was added to git.js.
 *
 * Remote routing forks *before* the local code path (design/remote-ssh.md
 * section 5.4), and the worktree commands, `countLinesOfCode` and
 * ParallelTaskService's `branch -D` were folded into a routed primitive. None of
 * that may change what a local project runs: same program, same argv, same
 * options. A drift here is a behaviour change for every local repository.
 *
 * The fixture is `tests/fixtures/gitLocalArgv.json`. It is regenerated only on
 * purpose, with `UPDATE_GIT_ARGV=1 npx jest tests/utils/gitLocalArgv.test.js`,
 * and a regeneration is a change to review like any other.
 */

jest.mock('child_process', () => ({
  execFile: jest.fn(),
  execFileSync: jest.fn(),
  exec: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const git = require('../../src/main/utils/git');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'gitLocalArgv.json');

let REPO;
let WT;

beforeAll(() => {
  REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-git-argv-'));
  fs.mkdirSync(path.join(REPO, '.git'));
  WT = path.join(REPO, 'wt');
});

afterAll(() => {
  try { fs.rmSync(REPO, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** A canned answer so every function walks its full path deterministically. */
function reply(args) {
  if (args.includes('rev-parse') && args.includes('--abbrev-ref') && args.includes('HEAD')) return 'main';
  if (args.includes('describe')) return 'v1.0.0';
  return '';
}

beforeEach(() => {
  execFile.mockReset();
  execFile.mockImplementation((cmd, args, opts, cb) => {
    setTimeout(() => cb(null, reply(args), ''), 0);
    return { kill() {}, on() {}, pid: 1 };
  });
});

function normalize(value) {
  const repoFwd = REPO.replace(/\\/g, '/');
  // Separators are folded so the fixture is the same on win32 and POSIX.
  return String(value).split(REPO).join('<REPO>').split(repoFwd).join('<REPO>').replace(/\\/g, '/');
}

/** Only git invocations: the filesystem fallback of countLinesOfCode is platform-specific. */
function recorded() {
  return execFile.mock.calls
    .filter(([file]) => file === 'git')
    .map(([file, args, opts]) => ({
      file,
      args: args.map(normalize),
      opts: {
        cwd: opts && opts.cwd !== undefined ? normalize(opts.cwd) : undefined,
        encoding: opts ? opts.encoding : undefined,
        maxBuffer: opts ? opts.maxBuffer : undefined,
        timeout: opts ? opts.timeout : undefined,
        signal: !!(opts && opts.signal),
      },
    }));
}

const CASES = [
  ['execGitResult array', (R) => git.execGitResult(R, ['status', '--porcelain'])],
  ['execGitResult string', (R) => git.execGitResult(R, 'status --porcelain', 5000)],
  ['execGit', (R) => git.execGit(R, ['log', '-1'])],
  ['spawnGit', (R) => git.spawnGit(R, ['checkout', 'main'])],
  ['spawnGit options', (R) => git.spawnGit(R, ['push'], { maxBuffer: 10, timeout: 5000 })],
  ['getBranches', (R) => git.getBranches(R)],
  ['getBranches fetch', (R) => git.getBranches(R, { skipFetch: false })],
  ['getCurrentBranch', (R) => git.getCurrentBranch(R)],
  ['checkoutBranch', (R) => git.checkoutBranch(R, 'feat/x')],
  ['getGitInfo', (R) => git.getGitInfo(R)],
  ['getGitInfoFull', (R) => git.getGitInfoFull(R)],
  ['getGitInfoFull fetch', (R) => git.getGitInfoFull(R, { skipFetch: false })],
  ['getGitStatusQuick', (R) => git.getGitStatusQuick(R)],
  ['gitPull', (R) => git.gitPull(R)],
  ['gitPush', (R) => git.gitPush(R)],
  ['gitPushBranch', (R) => git.gitPushBranch(R, 'main')],
  ['gitMerge', (R) => git.gitMerge(R, 'dev')],
  ['gitMergeAbort', (R) => git.gitMergeAbort(R)],
  ['gitMergeContinue', (R) => git.gitMergeContinue(R)],
  ['getMergeConflicts', (R) => git.getMergeConflicts(R)],
  ['isMergeInProgress', (R) => git.isMergeInProgress(R)],
  ['countLinesOfCode', (R) => git.countLinesOfCode(R)],
  ['getProjectStats', (R) => git.getProjectStats(R)],
  ['getGitStatusDetailed', (R) => git.getGitStatusDetailed(R)],
  ['gitStageFiles', (R) => git.gitStageFiles(R, ['a b.js', "it's.js"])],
  ['gitCommit', (R) => git.gitCommit(R, 'a message')],
  ['createBranch', (R) => git.createBranch(R, 'feat/y')],
  ['deleteBranch', (R) => git.deleteBranch(R, 'old')],
  ['deleteBranch force', (R) => git.deleteBranch(R, 'old', true)],
  ['getCommitHistory', (R) => git.getCommitHistory(R, { skip: 1, limit: 2, branch: 'b', allBranches: true })],
  ['getFileDiff staged', (R) => git.getFileDiff(R, 'src/a.js', true)],
  ['getFileDiffResult', (R) => git.getFileDiffResult(R, 'src/a.js')],
  ['getCommitDetail', (R) => git.getCommitDetail(R, 'abc1234')],
  ['cherryPick', (R) => git.cherryPick(R, 'abc1234')],
  ['revertCommit', (R) => git.revertCommit(R, 'abc1234')],
  ['gitUnstageFiles', (R) => git.gitUnstageFiles(R, ['a.js'])],
  ['stashApply', (R) => git.stashApply(R, 'stash@{0}')],
  ['stashDrop', (R) => git.stashDrop(R, 'stash@{1}')],
  ['gitStashSave message', (R) => git.gitStashSave(R, 'wip')],
  ['gitStashSave bare', (R) => git.gitStashSave(R, '')],
  ['getWorktrees', (R) => git.getWorktrees(R)],
  ['createWorktree newBranch', (R) => git.createWorktree(R, WT, { newBranch: 'n', startPoint: 'main' })],
  ['createWorktree branch', (R) => git.createWorktree(R, WT, { branch: 'b' })],
  ['createWorktree bare', (R) => git.createWorktree(R, WT)],
  ['removeWorktree', (R) => git.removeWorktree(R, WT)],
  ['removeWorktree force', (R) => git.removeWorktree(R, WT, true)],
  ['removeWorktree unlock', (R) => git.removeWorktree(R, WT, git.FORCE_UNLOCK)],
  ['lockWorktree reason', (R) => git.lockWorktree(R, WT, 'why')],
  ['lockWorktree', (R) => git.lockWorktree(R, WT)],
  ['unlockWorktree', (R) => git.unlockWorktree(R, WT)],
  ['pruneWorktrees', (R) => git.pruneWorktrees(R)],
  ['detectWorktree', (R) => git.detectWorktree(R)],
  ['diffWorktreeBranches', (R) => git.diffWorktreeBranches(R, 'a', 'b', 'f.js')],
  ['diffWorktreeBranchesWithStats', (R) => git.diffWorktreeBranchesWithStats(R, 'a', 'b')],
  ['resolveConflict', (R) => git.resolveConflict(R, 'f.js', 'ours')],
  ['getBranchOrphanCommitCount', (R) => git.getBranchOrphanCommitCount(R, 'b')],
  ['deleteRemoteBranch', (R) => git.deleteRemoteBranch(R, 'b')],
  ['gitFetch', (R) => git.gitFetch(R)],
  ['renameBranch', (R) => git.renameBranch(R, 'a', 'b')],
  ['gitRebase', (R) => git.gitRebase(R, 'main')],
  ['gitRebaseAbort', (R) => git.gitRebaseAbort(R)],
  ['gitRebaseContinue', (R) => git.gitRebaseContinue(R)],
  ['getFileHistory', (R) => git.getFileHistory(R, 'f.js', { skip: 0, limit: 5 })],
  ['getCommitFileDiffs', (R) => git.getCommitFileDiffs(R, 'abc1234')],
  ['getCommitFileDiff', (R) => git.getCommitFileDiff(R, 'abc1234', 'f.js')],
  ['gitBlame', (R) => git.gitBlame(R, 'f.js')],
  ['getTags', (R) => git.getTags(R)],
  ['createTag annotated', (R) => git.createTag(R, 'v1', 'msg', 'abc1234')],
  ['createTag light', (R) => git.createTag(R, 'v1')],
  ['deleteTag', (R) => git.deleteTag(R, 'v1')],
  ['pushTag', (R) => git.pushTag(R, 'v1')],
  ['pushAllTags', (R) => git.pushAllTags(R)],
  ['getRemotes', (R) => git.getRemotes(R)],
  ['gitDiscardFiles', (R) => git.gitDiscardFiles(R, ['a.js'])],
  ['stashPop', (R) => git.stashPop(R, 'stash@{0}')],
  ['stashShow', (R) => git.stashShow(R, 'stash@{0}')],
  ['gitAmendCommit message', (R) => git.gitAmendCommit(R, 'm')],
  ['gitAmendCommit bare', (R) => git.gitAmendCommit(R)],
  ['isRebaseInProgress', (R) => git.isRebaseInProgress(R)],
  ['gitReset', (R) => git.gitReset(R, 'hard', 'HEAD~2')],
  ['searchCommitHistory', (R) => git.searchCommitHistory(R, { grep: 'x', pickaxe: 'y', allBranches: true, branch: 'b' })],
  ['addRemote', (R) => git.addRemote(R, 'o', 'https://example.com/r.git')],
  ['removeRemote', (R) => git.removeRemote(R, 'o')],
];

async function runAll() {
  const out = {};
  for (const [name, fn] of CASES) {
    execFile.mockClear();
    await fn(REPO);
    out[name] = recorded();
  }
  return out;
}

test('every local git command keeps its exact argv and options', async () => {
  const actual = await runAll();
  if (process.env.UPDATE_GIT_ARGV === '1') {
    fs.writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + '\n');
  }
  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  expect(actual).toEqual(expected);
});

test("ParallelTaskService's branch deletes keep the exact execFile call they made directly", async () => {
  execFile.mockClear();
  const safeDir = `safe.directory=${REPO.replace(/\\/g, '/')}`;
  await new Promise((resolve) => git.execGitCallback(REPO, ['-c', safeDir], ['branch', '-D', 'ptask/x'], { timeout: 10000 }, resolve));
  await new Promise((resolve) => git.execGitCallback(REPO, [], ['branch', '-D', 'merge/x'], { timeout: 10000 }, resolve));
  const calls = execFile.mock.calls.map(([file, args, opts]) => [file, args, opts]);
  expect(calls).toEqual([
    ['git', ['-c', safeDir, 'branch', '-D', 'ptask/x'], { cwd: REPO, timeout: 10000 }],
    ['git', ['branch', '-D', 'merge/x'], { cwd: REPO, timeout: 10000 }],
  ]);
});
