/**
 * execGit's string form splits on spaces and does not honour quotes, so
 * `blame --porcelain "${filePath}"` sent git a path that literally started with
 * a double quote. Nothing errored visibly: blame, file history and per-file
 * commit diffs simply returned empty for every file, and on Windows tag
 * creation failed outright because `"` is not a legal filename character.
 *
 * These assert the argv, which is the only level at which the defect is
 * visible - the parsers downstream were happy either way.
 */

jest.mock('child_process', () => ({
  execFile: jest.fn(),
  execFileSync: jest.fn(),
  exec: jest.fn()
}));

const path = require('path');
const { execFile } = require('child_process');
const git = require('../../src/main/utils/git');

// A directory that really exists: execGitResult bails early otherwise.
const REPO = path.resolve(__dirname, '..', '..');

/** argv of the nth git call, from the command verb onwards. */
function gitArgs(verb, callIndex = 0) {
  const args = execFile.mock.calls[callIndex][1];
  return args.slice(args.indexOf(verb));
}

beforeEach(() => {
  execFile.mockReset();
  // Asynchronously, the way execFile really behaves: execGitResult reads the
  // timeout handle inside the callback, and a synchronous call hits its TDZ.
  execFile.mockImplementation((cmd, args, opts, cb) => { setTimeout(() => cb(null, '', ''), 0); return { kill() {}, on() {} }; });
});

describe('file-scoped commands', () => {
  test('blame passes the path as its own argument, unquoted', async () => {
    await git.gitBlame(REPO, 'src/main.js');
    expect(gitArgs('blame')).toEqual(['blame', '--porcelain', '--', 'src/main.js']);
  });

  test('blame survives a path containing spaces', async () => {
    await git.gitBlame(REPO, 'dir with space/my file.js');
    expect(gitArgs('blame')).toEqual(['blame', '--porcelain', '--', 'dir with space/my file.js']);
  });

  test('file history passes the path after a -- separator', async () => {
    await git.getFileHistory(REPO, 'src/main.js', { skip: 0, limit: 30 });
    expect(gitArgs('log')).toEqual([
      'log', '--skip=0', '-n', '30', '--pretty=format:%H|%an|%aI|%s', '--', 'src/main.js'
    ]);
  });

  test('commit file diff passes both revisions and the path separately', async () => {
    await git.getCommitFileDiff(REPO, 'abc1234', 'dir with space/my file.js');
    expect(gitArgs('diff')).toEqual([
      'diff', 'abc1234~1', 'abc1234', '--', 'dir with space/my file.js'
    ]);
  });
});

describe('format strings', () => {
  test('commit history sends an unquoted --format', async () => {
    await git.getCommitHistory(REPO, { skip: 10, limit: 20 });
    const args = gitArgs('log');
    expect(args.slice(0, 3)).toEqual(['log', '--skip=10', '-20']);
    expect(args[3].startsWith('--format=')).toBe(true);
    expect(args[3]).not.toContain('"');
  });

  test('commit history appends --all and the branch as separate arguments', async () => {
    await git.getCommitHistory(REPO, { skip: 0, limit: 5, branch: 'feature/x', allBranches: true });
    const args = gitArgs('log');
    expect(args).toContain('--all');
    expect(args[args.length - 1]).toBe('feature/x');
  });
});

describe('tags', () => {
  test('a lightweight tag name carries no quotes', async () => {
    await git.createTag(REPO, 'v1.0.0');
    expect(gitArgs('tag')).toEqual(['tag', 'v1.0.0']);
  });

  test('an annotated tag keeps a multi-word message in one argument', async () => {
    await git.createTag(REPO, 'v1.0.0', 'my release notes');
    expect(gitArgs('tag')).toEqual(['tag', '-a', 'v1.0.0', '-m', 'my release notes']);
  });

  test('a commit hash is appended, not glued to the message', async () => {
    await git.createTag(REPO, 'v1.0.0', 'notes here', 'abc1234');
    expect(gitArgs('tag')).toEqual(['tag', '-a', 'v1.0.0', '-m', 'notes here', 'abc1234']);
  });

  test('delete targets the real tag name', async () => {
    await git.deleteTag(REPO, 'v1.0.0');
    expect(gitArgs('tag')).toEqual(['tag', '-d', 'v1.0.0']);
  });

  test('push targets the real tag name', async () => {
    await git.pushTag(REPO, 'v1.0.0');
    expect(gitArgs('push')).toEqual(['push', 'origin', 'v1.0.0']);
  });
});

describe('the string form', () => {
  test('still works for a fixed command with no interpolation', async () => {
    await git.getCurrentBranch(REPO);
    expect(gitArgs('rev-parse')).toEqual(['rev-parse', '--abbrev-ref', 'HEAD']);
  });

  test('refuses a quoted string instead of running the wrong command', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await git.execGitResult(REPO, 'blame --porcelain "src/main.js"');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('badargs');
    expect(execFile).not.toHaveBeenCalled();

    console.error.mockRestore();
  });
});
