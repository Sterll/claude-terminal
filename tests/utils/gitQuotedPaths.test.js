/**
 * `git status --porcelain` quotes a path holding whitespace or an unusual
 * character, C-style. The parsers took the field as is, so a file named
 * `sub tract.js` was listed by the Git panel as `"src/sub tract.js"`, quotes
 * included, and staging it asked git for a path that does not exist. Found by
 * creating that file from the Files screen of a remote project and trying to
 * commit it; local projects had the same problem.
 */

const { parseGitStatus, parseDiffNumstat, unquoteGitPath } = require('../../src/main/utils/git');

describe('unquoteGitPath', () => {
  test('leaves an unquoted path alone', () => {
    expect(unquoteGitPath('src/plain.js')).toBe('src/plain.js');
    expect(unquoteGitPath('"')).toBe('"');
  });

  test('drops the quotes and decodes escapes and octal UTF-8 bytes', () => {
    expect(unquoteGitPath('"src/sub tract.js"')).toBe('src/sub tract.js');
    expect(unquoteGitPath('"caf\\303\\251.md"')).toBe('café.md');
    expect(unquoteGitPath('"q\\"uote\\\\x"')).toBe('q"uote\\x');
    expect(unquoteGitPath('"tab\\there"')).toBe('tab\there');
  });
});

describe('parseGitStatus', () => {
  test('lists quoted paths without their quotes', () => {
    const files = parseGitStatus([
      '?? "src/sub tract.js"',
      ' M "caf\\303\\251.md"',
      ' M plain.js',
    ].join('\n'));
    expect(files.untracked.map((f) => f.file)).toEqual(['src/sub tract.js']);
    expect(files.unstaged.map((f) => f.file)).toEqual(['café.md', 'plain.js']);
  });

  test('a rename keeps its old -> new shape, each side unquoted', () => {
    const files = parseGitStatus('R  "a b.txt" -> "c d.txt"\nR  old.txt -> new name.txt');
    expect(files.staged.map((f) => f.file)).toEqual(['a b.txt -> c d.txt', 'old.txt -> new name.txt']);
  });
});

test('parseDiffNumstat keys a quoted path by its real name', () => {
  const map = parseDiffNumstat('3\t1\t"caf\\303\\251.md"\n2\t0\tsrc/sub tract.js');
  expect(map.get('café.md')).toEqual({ additions: 3, deletions: 1 });
  expect(map.get('src/sub tract.js')).toEqual({ additions: 2, deletions: 0 });
});
