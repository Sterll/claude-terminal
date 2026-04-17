const path = require('path');
const { parseDroppedPathsPayload } = require('../../src/renderer/utils/dropPaths');

function makeFs(existingFiles = [], directories = []) {
  const fileSet = new Set(existingFiles.map(p => path.normalize(p)));
  const dirSet = new Set(directories.map(p => path.normalize(p)));
  return {
    statSync: jest.fn((p) => {
      const normalized = path.normalize(p);
      if (dirSet.has(normalized)) return { isDirectory: () => true };
      if (fileSet.has(normalized)) return { isDirectory: () => false };
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }),
  };
}

describe('parseDroppedPathsPayload', () => {
  test('returns null for non-path text', () => {
    const fs = makeFs();
    expect(parseDroppedPathsPayload('hello world', { fs, path })).toBeNull();
    expect(parseDroppedPathsPayload('', { fs, path })).toBeNull();
    expect(parseDroppedPathsPayload(null, { fs, path })).toBeNull();
  });

  test('parses Unix absolute paths and converts to project-relative', () => {
    const fs = makeFs(['/proj/src/foo.js', '/proj/src/bar.ts']);
    const payload = '/proj/src/foo.js\n/proj/src/bar.ts';
    const result = parseDroppedPathsPayload(payload, { fs, path, projectRoot: '/proj' });
    expect(result).not.toBeNull();
    expect(result.missing).toEqual([]);
    expect(result.directories).toEqual([]);
    expect(result.files.map(f => f.path)).toEqual(['src/foo.js', 'src/bar.ts']);
    expect(result.files[0].fullPath).toBe(path.normalize('/proj/src/foo.js'));
  });

  test('handles Windows paths with backslashes', () => {
    const winPath = 'C:\\proj\\src\\main.js';
    const fs = makeFs([winPath]);
    const result = parseDroppedPathsPayload(winPath, {
      fs,
      path,
      projectRoot: 'C:\\proj',
    });
    expect(result).not.toBeNull();
    expect(result.files).toHaveLength(1);
    // Relative path uses forward slashes regardless of OS
    expect(result.files[0].path).not.toContain('\\');
  });

  test('collects missing files without throwing', () => {
    const fs = makeFs(['/proj/a.js']);
    const result = parseDroppedPathsPayload('/proj/a.js\n/proj/missing.js', {
      fs,
      path,
      projectRoot: '/proj',
    });
    expect(result.files).toHaveLength(1);
    expect(result.missing).toEqual(['/proj/missing.js']);
  });

  test('separates directories from files', () => {
    const fs = makeFs(['/proj/a.js'], ['/proj/folder']);
    const result = parseDroppedPathsPayload('/proj/a.js\n/proj/folder', {
      fs,
      path,
      projectRoot: '/proj',
    });
    expect(result.files).toHaveLength(1);
    expect(result.directories).toEqual([path.normalize('/proj/folder')]);
  });

  test('falls back to absolute path when outside project root', () => {
    const fs = makeFs(['/other/thing.js']);
    const result = parseDroppedPathsPayload('/other/thing.js', {
      fs,
      path,
      projectRoot: '/proj',
    });
    expect(result.files).toHaveLength(1);
    // Not starting with ".." since we replaced it with absolute
    expect(result.files[0].path.startsWith('..')).toBe(false);
  });

  test('ignores empty lines and trims whitespace', () => {
    const fs = makeFs(['/proj/a.js', '/proj/b.js']);
    const result = parseDroppedPathsPayload('  /proj/a.js  \n\n  /proj/b.js', {
      fs,
      path,
      projectRoot: '/proj',
    });
    expect(result.files.map(f => f.path)).toEqual(['a.js', 'b.js']);
  });

  test('rejects payload when any line is not a path', () => {
    const fs = makeFs(['/proj/a.js']);
    const result = parseDroppedPathsPayload('/proj/a.js\nhello', {
      fs,
      path,
      projectRoot: '/proj',
    });
    expect(result).toBeNull();
  });
});
