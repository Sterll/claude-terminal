const {
  findPathCandidates,
  resolveCandidate,
  registerFileLinks,
} = require('../../src/renderer/ui/components/terminal/fileLinks');

const paths = (text) => findPathCandidates(text).map(c => c.path);

describe('findPathCandidates', () => {
  test('finds an absolute path in prose and drops the sentence around it', () => {
    const text = 'Conferi o pedido em /home/me/.claude/ops/state/pedido-f5-allowlist-speed.md contra';
    expect(paths(text)).toEqual(['/home/me/.claude/ops/state/pedido-f5-allowlist-speed.md']);
  });

  test('strips trailing punctuation and wrapping brackets', () => {
    expect(paths('Read(/home/x/a.js)')).toEqual(['/home/x/a.js']);
    expect(paths('see `/etc/hosts`.')).toEqual(['/etc/hosts']);
    expect(paths('done in ~/x/y.md.')).toEqual(['~/x/y.md']);
  });

  test('splits off a :line[:col] suffix', () => {
    const [c] = findPathCandidates('error at src/renderer/foo.js:12:3, fix it');
    expect(c.path).toBe('src/renderer/foo.js');
    expect(c.line).toBe(12);
    expect(c.text).toBe('src/renderer/foo.js:12:3');
  });

  test('ignores URLs and prose with slashes', () => {
    expect(paths('see https://example.com/a/b.html')).toEqual([]);
    expect(paths('and/or 90 km/h')).toEqual([]);
  });

  test('accepts Windows drive paths and dot-relative paths', () => {
    expect(paths('C:\\Users\\me\\a.txt (done)')).toEqual(['C:\\Users\\me\\a.txt']);
    expect(paths('run ./scripts/x and ../y/z')).toEqual(['./scripts/x', '../y/z']);
  });
});

describe('resolveCandidate', () => {
  test('resolves relative, home and dot segments', () => {
    expect(resolveCandidate('../a/./b.js', { cwd: '/home/u/p/src' })).toBe('/home/u/p/a/b.js');
    expect(resolveCandidate('~/x.md', { home: '/home/u' })).toBe('/home/u/x.md');
    expect(resolveCandidate('/abs/file', {})).toBe('/abs/file');
    expect(resolveCandidate('a\\b.txt', { cwd: 'C:\\p' })).toBe('C:\\p\\a\\b.txt');
  });

  test('returns null when there is nothing to resolve against', () => {
    expect(resolveCandidate('src/a.js', {})).toBeNull();
    expect(resolveCandidate('~/a.js', {})).toBeNull();
  });
});

/** Minimal stand-in for an xterm buffer holding plain ASCII rows. */
function fakeTerminal(rows, cols = 80) {
  const lines = rows.map((r) => {
    const { text, wrapped } = typeof r === 'string' ? { text: r, wrapped: false } : r;
    const padded = text.padEnd(cols, ' ');
    return {
      isWrapped: wrapped,
      length: cols,
      getCell: (x) => ({ getWidth: () => 1, getChars: () => padded[x] === ' ' ? '' : padded[x] }),
    };
  });
  const term = {
    options: {},
    buffer: { active: { getLine: (y) => lines[y] } },
    registerLinkProvider: jest.fn((p) => { term.provider = p; return { dispose: jest.fn() }; }),
  };
  return term;
}

const provide = (term, y) => new Promise(resolve => term.provider.provideLinks(y, resolve));

describe('registerFileLinks', () => {
  test('links an existing file with a pointer cursor and opens it on click', async () => {
    const term = fakeTerminal(['Conferi o pedido em /home/me/a.md contra']);
    const onOpen = jest.fn();
    registerFileLinks(term, { getCwd: () => '/home/me', onOpen, isFile: async (p) => p === '/home/me/a.md' });

    const links = await provide(term, 1);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe('/home/me/a.md');
    expect(links[0].decorations.pointerCursor).toBe(true);
    expect(links[0].range).toEqual({ start: { x: 21, y: 1 }, end: { x: 33, y: 1 } });

    links[0].activate({ button: 0 });
    expect(onOpen).toHaveBeenCalledWith('/home/me/a.md', { line: null });
  });

  test('does not link a path that is not an existing file', async () => {
    const term = fakeTerminal(['see /nope/missing.md']);
    registerFileLinks(term, { onOpen: jest.fn(), isFile: async () => false });
    expect(await provide(term, 1)).toBeUndefined();
  });

  test('follows a path across a soft-wrapped row', async () => {
    const term = fakeTerminal([{ text: 'at /home/me/lo', wrapped: false }, { text: 'ng/file.md ok', wrapped: true }], 14);
    registerFileLinks(term, { onOpen: jest.fn(), isFile: async (p) => p === '/home/me/long/file.md' });
    const [link] = await provide(term, 2);
    expect(link.text).toBe('/home/me/long/file.md');
    expect(link.range.start).toEqual({ x: 4, y: 1 });
    expect(link.range.end).toEqual({ x: 10, y: 2 });
  });

  test('routes OSC 8 file:// links to onOpen and http links to onOpenUrl', () => {
    const term = fakeTerminal(['']);
    const onOpen = jest.fn();
    const onOpenUrl = jest.fn();
    registerFileLinks(term, { onOpen, onOpenUrl, isFile: async () => false });
    term.options.linkHandler.activate({}, 'file:///home/me/a%20b.md');
    term.options.linkHandler.activate({}, 'https://example.com');
    expect(onOpen).toHaveBeenCalledWith('/home/me/a b.md', { line: null });
    expect(onOpenUrl).toHaveBeenCalledWith('https://example.com');
  });
});
