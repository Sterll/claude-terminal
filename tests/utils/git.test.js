const { parseGitStatus, parseDiffNumstat, parseWorktreeListOutput } = require('../../src/main/utils/git');

// ── parseGitStatus ──

describe('parseGitStatus', () => {
  test('returns empty categories for null input', () => {
    const result = parseGitStatus(null);
    expect(result).toEqual({ staged: [], unstaged: [], untracked: [], all: [] });
  });

  test('returns empty categories for empty string', () => {
    const result = parseGitStatus('');
    expect(result).toEqual({ staged: [], unstaged: [], untracked: [], all: [] });
  });

  test('parses staged additions', () => {
    const result = parseGitStatus('A  src/new-file.js');
    expect(result.staged).toEqual([{ type: 'added', file: 'src/new-file.js' }]);
    expect(result.unstaged).toEqual([]);
    expect(result.untracked).toEqual([]);
  });

  test('parses staged modifications', () => {
    const result = parseGitStatus('M  src/index.js');
    expect(result.staged).toEqual([{ type: 'modified', file: 'src/index.js' }]);
  });

  test('parses staged deletions', () => {
    const result = parseGitStatus('D  old-file.js');
    expect(result.staged).toEqual([{ type: 'deleted', file: 'old-file.js' }]);
  });

  test('parses staged renames', () => {
    const result = parseGitStatus('R  old.js -> new.js');
    expect(result.staged).toEqual([{ type: 'renamed', file: 'old.js -> new.js' }]);
  });

  test('parses unstaged modifications', () => {
    const result = parseGitStatus(' M src/index.js');
    expect(result.unstaged).toEqual([{ type: 'modified', file: 'src/index.js' }]);
    expect(result.staged).toEqual([]);
  });

  test('parses unstaged deletions', () => {
    const result = parseGitStatus(' D deleted-file.js');
    expect(result.unstaged).toEqual([{ type: 'deleted', file: 'deleted-file.js' }]);
  });

  test('parses untracked files', () => {
    const result = parseGitStatus('?? new-file.txt');
    expect(result.untracked).toEqual([{ type: 'untracked', file: 'new-file.txt' }]);
    expect(result.staged).toEqual([]);
    expect(result.unstaged).toEqual([]);
  });

  test('parses mixed status', () => {
    const input = [
      'A  src/new.js',
      ' M src/modified.js',
      'D  src/deleted.js',
      '?? .env',
    ].join('\n');
    const result = parseGitStatus(input);
    expect(result.staged).toHaveLength(2); // A + D
    expect(result.unstaged).toHaveLength(1); // M
    expect(result.untracked).toHaveLength(1); // ??
    expect(result.all).toHaveLength(4);
  });

  test('handles both staged and unstaged for same file', () => {
    // MM means both staged and unstaged modification
    const result = parseGitStatus('MM src/file.js');
    expect(result.staged).toHaveLength(1);
    expect(result.unstaged).toHaveLength(1);
  });

  test('skips blank lines', () => {
    const result = parseGitStatus('A  file.js\n\n?? other.js\n');
    expect(result.staged).toHaveLength(1);
    expect(result.untracked).toHaveLength(1);
  });
});

// ── parseDiffNumstat ──

describe('parseDiffNumstat', () => {
  test('returns empty map for null', () => {
    const result = parseDiffNumstat(null);
    expect(result.size).toBe(0);
  });

  test('returns empty map for empty string', () => {
    const result = parseDiffNumstat('');
    expect(result.size).toBe(0);
  });

  test('parses single file diff', () => {
    const result = parseDiffNumstat('10\t5\tsrc/index.js');
    expect(result.get('src/index.js')).toEqual({ additions: 10, deletions: 5 });
  });

  test('parses multiple files', () => {
    const input = '10\t5\tsrc/a.js\n3\t0\tsrc/b.js\n0\t20\tsrc/c.js';
    const result = parseDiffNumstat(input);
    expect(result.size).toBe(3);
    expect(result.get('src/a.js')).toEqual({ additions: 10, deletions: 5 });
    expect(result.get('src/b.js')).toEqual({ additions: 3, deletions: 0 });
    expect(result.get('src/c.js')).toEqual({ additions: 0, deletions: 20 });
  });

  test('handles binary files (- markers)', () => {
    const result = parseDiffNumstat('-\t-\timage.png');
    expect(result.get('image.png')).toEqual({ additions: 0, deletions: 0 });
  });

  test('skips blank lines', () => {
    const result = parseDiffNumstat('5\t3\tfile.js\n\n');
    expect(result.size).toBe(1);
  });
});

// ── parseWorktreeListOutput ──

describe('parseWorktreeListOutput', () => {
  test('returns empty array for null', () => {
    expect(parseWorktreeListOutput(null)).toEqual([]);
  });

  test('returns empty array for empty string', () => {
    expect(parseWorktreeListOutput('')).toEqual([]);
  });

  test('parses single main worktree', () => {
    const output = `worktree /home/user/project
HEAD abc123def456
branch refs/heads/main
`;
    const result = parseWorktreeListOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/home/user/project');
    expect(result[0].head).toBe('abc123def456');
    expect(result[0].branch).toBe('main');
    expect(result[0].isMain).toBe(true);
  });

  test('parses multiple worktrees', () => {
    const output = `worktree /home/user/project
HEAD abc123
branch refs/heads/main

worktree /home/user/project-feat
HEAD def456
branch refs/heads/feature/login
`;
    const result = parseWorktreeListOutput(output);
    expect(result).toHaveLength(2);
    expect(result[0].isMain).toBe(true);
    expect(result[0].branch).toBe('main');
    expect(result[1].branch).toBe('feature/login');
    expect(result[1].isMain).toBeUndefined();
  });

  test('parses detached HEAD', () => {
    const output = `worktree /home/user/project
HEAD abc123
detached
`;
    const result = parseWorktreeListOutput(output);
    expect(result[0].detached).toBe(true);
    expect(result[0].branch).toBeUndefined();
  });

  test('parses bare worktree', () => {
    const output = `worktree /home/user/project.git
HEAD abc123
bare
`;
    const result = parseWorktreeListOutput(output);
    expect(result[0].bare).toBe(true);
  });

  test('parses locked worktree without reason', () => {
    const output = `worktree /home/user/project-feat
HEAD abc123
branch refs/heads/feat
locked
`;
    const result = parseWorktreeListOutput(output);
    expect(result[0].locked).toBe(true);
    expect(result[0].lockReason).toBeUndefined();
  });

  test('parses locked worktree with reason', () => {
    const output = `worktree /home/user/project-feat
HEAD abc123
branch refs/heads/feat
locked reason for locking
`;
    const result = parseWorktreeListOutput(output);
    expect(result[0].locked).toBe(true);
    expect(result[0].lockReason).toBe('reason for locking');
  });

  test('parses prunable worktree', () => {
    const output = `worktree /home/user/deleted-wt
HEAD abc123
branch refs/heads/old
prunable
`;
    const result = parseWorktreeListOutput(output);
    expect(result[0].prunable).toBe(true);
  });

  test('strips refs/heads/ from branch name', () => {
    const output = `worktree /path
HEAD abc
branch refs/heads/fix/issue-42
`;
    const result = parseWorktreeListOutput(output);
    expect(result[0].branch).toBe('fix/issue-42');
  });

  test('handles output without trailing newline', () => {
    const output = `worktree /path
HEAD abc123
branch refs/heads/main`;
    const result = parseWorktreeListOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/path');
  });
});

// ── parsePorcelainZ ──

describe('parsePorcelainZ', () => {
  const { parsePorcelainZ } = require('../../src/main/utils/git');

  test('returns empty lists for null and empty input', () => {
    expect(parsePorcelainZ(null)).toEqual({ tracked: [], untracked: [] });
    expect(parsePorcelainZ('')).toEqual({ tracked: [], untracked: [] });
  });

  test('separates tracked from untracked', () => {
    const out = 'M  src/index.js\0?? notes.txt\0 D old.js\0';
    expect(parsePorcelainZ(out)).toEqual({
      tracked: ['src/index.js', 'old.js'],
      untracked: ['notes.txt'],
    });
  });

  test('keeps a path containing spaces whole', () => {
    // The old line-based parser split on newlines and trimmed, which was fine
    // here, but git would have quoted this path without -z.
    const out = '?? dir with space/my file.txt\0';
    expect(parsePorcelainZ(out).untracked).toEqual(['dir with space/my file.txt']);
  });

  test('keeps a non-ASCII path verbatim, with no quoting to undo', () => {
    const out = '?? café/résumé.txt\0';
    expect(parsePorcelainZ(out).untracked).toEqual(['café/résumé.txt']);
  });

  test('keeps a trailing space, which trim() used to eat', () => {
    const out = '?? trailing \0';
    expect(parsePorcelainZ(out).untracked).toEqual(['trailing ']);
  });

  test('survives a newline inside a filename', () => {
    const out = '?? weird\nname.txt\0M  src/index.js\0';
    expect(parsePorcelainZ(out)).toEqual({
      tracked: ['src/index.js'],
      untracked: ['weird\nname.txt'],
    });
  });

  test('consumes the original path of a rename instead of reading it as a record', () => {
    // "R  new\0old\0" - the bare second record has no status prefix, and its
    // first two characters would otherwise be mistaken for one.
    const out = 'R  src/new-name.js\0src/old-name.js\0M  other.js\0';
    expect(parsePorcelainZ(out)).toEqual({
      tracked: ['src/new-name.js', 'other.js'],
      untracked: [],
    });
  });

  test('does the same for a copy', () => {
    const out = 'C  copy.js\0source.js\0';
    expect(parsePorcelainZ(out)).toEqual({ tracked: ['copy.js'], untracked: [] });
  });
});
