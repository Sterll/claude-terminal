// Where a project's transcripts live.
//
// Claude Code re-files a transcript when the session's cwd changes, so a session
// that enters a worktree leaves the project's directory. These tests pin the
// layout discovery that puts it back in the project's listing.

const realOs = require('os');
const fs = require('fs');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(realOs.tmpdir(), 'ct-session-dirs-'));

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => global.__CT_TMP_HOME__
}));

global.__CT_TMP_HOME__ = TMP_HOME;

const {
  encodeProjectPath,
  getProjectSessionsDir,
  commonGitDir,
  linkedWorktreePaths,
  listProjectSessionDirs,
  invalidateSessionDirs,
} = require('../../src/shared/session-dirs');

const REPO = path.join(TMP_HOME, 'repo');

function projectsRoot() {
  return path.join(TMP_HOME, '.claude', 'projects');
}

/** Register a linked worktree the way `git worktree add` does. */
function addWorktree(name, worktreePath) {
  const entry = path.join(REPO, '.git', 'worktrees', name);
  fs.mkdirSync(entry, { recursive: true });
  fs.writeFileSync(path.join(entry, 'gitdir'), `${path.join(worktreePath, '.git')}\n`);
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${entry}\n`);
}

/** Give a cwd a transcript directory holding one session. */
function seedTranscripts(cwd) {
  const dir = getProjectSessionsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.jsonl'), '{}\n');
  return dir;
}

beforeEach(() => {
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.rmSync(projectsRoot(), { recursive: true, force: true });
  fs.mkdirSync(path.join(REPO, '.git'), { recursive: true });
  fs.mkdirSync(projectsRoot(), { recursive: true });
  invalidateSessionDirs();
});

describe('encodeProjectPath', () => {
  test('replaces every non-alphanumeric character', () => {
    expect(encodeProjectPath('/a/b.c d')).toBe('-a-b-c-d');
  });

  test('truncates and hashes paths beyond 200 characters', () => {
    const long = '/' + 'x'.repeat(300);
    const encoded = encodeProjectPath(long);
    expect(encoded.length).toBeGreaterThan(200);
    expect(encoded.slice(0, 200)).toBe('-' + 'x'.repeat(199));
    expect(encodeProjectPath(long)).toBe(encoded);
  });
});

describe('commonGitDir', () => {
  test('is .git itself in the main checkout', () => {
    expect(commonGitDir(REPO)).toBe(path.join(REPO, '.git'));
  });

  test('resolves back to the repository from inside a worktree', () => {
    const wt = path.join(REPO, '.claude', 'worktrees', 'feature');
    addWorktree('feature', wt);
    expect(commonGitDir(wt)).toBe(path.join(REPO, '.git'));
  });

  test('is null outside a repository', () => {
    expect(commonGitDir(path.join(TMP_HOME, 'not-a-repo'))).toBeNull();
  });
});

describe('linkedWorktreePaths', () => {
  test('finds worktrees wherever they are checked out', () => {
    const inside = path.join(REPO, '.claude', 'worktrees', 'feature');
    const outside = path.join(TMP_HOME, 'elsewhere', 'hotfix');
    addWorktree('feature', inside);
    addWorktree('hotfix', outside);
    expect(linkedWorktreePaths(REPO).sort()).toEqual([inside, outside].sort());
  });

  test('is empty for a repository without worktrees', () => {
    expect(linkedWorktreePaths(REPO)).toEqual([]);
  });

  test('skips a half-pruned entry rather than throwing', () => {
    fs.mkdirSync(path.join(REPO, '.git', 'worktrees', 'ghost'), { recursive: true });
    expect(linkedWorktreePaths(REPO)).toEqual([]);
  });
});

describe('listProjectSessionDirs', () => {
  test('puts the project first and carries the cwd of each worktree', () => {
    const wt = path.join(REPO, '.claude', 'worktrees', 'feature');
    addWorktree('feature', wt);

    const dirs = listProjectSessionDirs(REPO);
    expect(dirs[0]).toEqual({
      dir: getProjectSessionsDir(REPO), cwd: REPO, worktree: null, missing: false
    });
    expect(dirs).toContainEqual({
      dir: getProjectSessionsDir(wt), cwd: wt, worktree: 'feature', missing: false
    });
  });

  test('still finds the transcripts of a removed worktree', () => {
    // `git worktree remove` deletes the checkout and the .git/worktrees entry.
    // The conversations that ran there are not deleted with it.
    const wt = path.join(REPO, '.claude', 'worktrees', 'gone');
    const dir = seedTranscripts(wt);
    invalidateSessionDirs();

    const orphan = listProjectSessionDirs(REPO).find(source => source.dir === dir);
    expect(orphan).toEqual({ dir, cwd: null, worktree: 'gone', missing: true });
  });

  test('does not claim a sibling project whose name extends this one', () => {
    // `<repo>-old` encodes to a directory name starting with `<repo>`, and a
    // prefix match alone would fold its sessions into this project's listing.
    seedTranscripts(REPO + '-old');
    invalidateSessionDirs();

    expect(listProjectSessionDirs(REPO)).toHaveLength(1);
  });

  test('lists a live worktree once, not also as a removed one', () => {
    const wt = path.join(REPO, '.claude', 'worktrees', 'feature');
    addWorktree('feature', wt);
    seedTranscripts(wt);
    invalidateSessionDirs();

    const dirs = listProjectSessionDirs(REPO);
    const forWorktree = dirs.filter(source => source.dir === getProjectSessionsDir(wt));
    expect(forWorktree).toHaveLength(1);
    expect(forWorktree[0].missing).toBe(false);
  });

  test('a project outside any repository is just its own directory', () => {
    const plain = path.join(TMP_HOME, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    expect(listProjectSessionDirs(plain)).toEqual([
      { dir: getProjectSessionsDir(plain), cwd: plain, worktree: null, missing: false }
    ]);
  });
});
