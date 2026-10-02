const rp = require('../../src/shared/remote-path');

describe('remote-path', () => {
  test('parse and format round trip', () => {
    const uri = 'ssh-remote://h7k2m9qa/home/yanis/api';
    const parsed = rp.parse(uri);
    expect(parsed).toEqual({ profileId: 'h7k2m9qa', path: '/home/yanis/api' });
    expect(rp.format(parsed.profileId, parsed.path)).toBe(uri);
  });

  test('round trip keeps spaces, quotes and non-ASCII verbatim', () => {
    const p = "/srv/my project/it's \"here\"/caf\u00e9/\u65e5\u672c";
    const uri = rp.format('abcd1234', p);
    expect(uri).toBe(`ssh-remote://abcd1234${p}`);
    expect(rp.parse(uri).path).toBe(p);
  });

  test('a URI without a path is the root, and format normalises', () => {
    expect(rp.parse('ssh-remote://abcd1234')).toEqual({ profileId: 'abcd1234', path: '/' });
    expect(rp.format('abcd1234', '/a//b/./c/')).toBe('ssh-remote://abcd1234/a/b/c');
  });

  test('invalid profile ids are refused', () => {
    expect(() => rp.parse('ssh-remote://ABC/x')).toThrow();
    expect(() => rp.parse('ssh-remote://short/x')).toThrow();
    expect(() => rp.format('../etc', '/x')).toThrow();
    expect(() => rp.format('abcd1234', 'relative/x')).toThrow();
  });

  test('isRemotePath is false for Windows, POSIX and relative paths', () => {
    expect(rp.isRemotePath('C:\\x')).toBe(false);
    expect(rp.isRemotePath('/home/x')).toBe(false);
    expect(rp.isRemotePath('x/y')).toBe(false);
    expect(rp.isRemotePath('')).toBe(false);
    expect(rp.isRemotePath(null)).toBe(false);
    expect(rp.isRemotePath('ssh-remote://abcd1234/x')).toBe(true);
  });

  test('join keeps the URI and normalises', () => {
    expect(rp.join('ssh-remote://abcd1234/home/y', 'src', 'a.js')).toBe('ssh-remote://abcd1234/home/y/src/a.js');
    expect(rp.join('ssh-remote://abcd1234/home/y', 'src/../lib')).toBe('ssh-remote://abcd1234/home/y/lib');
    expect(rp.join('/home/y', 'a', '..', 'b')).toBe('/home/y/b');
  });

  test('dirname, basename and extname work on URIs', () => {
    const uri = 'ssh-remote://abcd1234/home/y/src/app.test.js';
    expect(rp.dirname(uri)).toBe('ssh-remote://abcd1234/home/y/src');
    expect(rp.dirname('ssh-remote://abcd1234/')).toBe('ssh-remote://abcd1234/');
    expect(rp.dirname('ssh-remote://abcd1234/home')).toBe('ssh-remote://abcd1234/');
    expect(rp.basename(uri)).toBe('app.test.js');
    expect(rp.basename(uri, '.js')).toBe('app.test');
    expect(rp.basename('ssh-remote://abcd1234/')).toBe('');
    expect(rp.extname(uri)).toBe('.js');
    expect(rp.extname('ssh-remote://abcd1234/home/.bashrc')).toBe('');
  });

  test('relative between URIs of the same host', () => {
    expect(rp.relative('ssh-remote://abcd1234/home/y', 'ssh-remote://abcd1234/home/y/src/a.js')).toBe('src/a.js');
    expect(rp.relative('ssh-remote://abcd1234/home/y/src', 'ssh-remote://abcd1234/home/z')).toBe('../../z');
    expect(rp.relative('ssh-remote://abcd1234/a', 'ssh-remote://abcd1234/a')).toBe('');
    expect(() => rp.relative('ssh-remote://abcd1234/a', 'ssh-remote://zzzz9999/a')).toThrow();
  });

  test('normalize on URIs and plain paths', () => {
    expect(rp.normalize('ssh-remote://abcd1234/a/./b//c/../d')).toBe('ssh-remote://abcd1234/a/b/d');
    expect(rp.normalize('a/../../b')).toBe('../b');
  });

  test("a '..' escaping the root is refused, never clamped", () => {
    expect(() => rp.parse('ssh-remote://abcd1234/../etc')).toThrow(/escapes/);
    expect(() => rp.join('ssh-remote://abcd1234/home', '../../etc')).toThrow(/escapes/);
    expect(() => rp.normalize('/a/../..')).toThrow(/escapes/);
  });

  test('control characters are refused', () => {
    expect(() => rp.format('abcd1234', '/a\nb')).toThrow(/control/);
    expect(() => rp.parse('ssh-remote://abcd1234/a\u0000b')).toThrow(/control/);
    expect(() => rp.join('ssh-remote://abcd1234/a', 'b\rc')).toThrow(/control/);
    expect(() => rp.normalize('/a\u007fb')).toThrow(/control/);
    expect(() => rp.normalize('/a\u0085b')).toThrow(/control/);
  });

  test('isInside is case-sensitive, per-host and boundary-aware', () => {
    const root = 'ssh-remote://abcd1234/home/y/api';
    expect(rp.isInside(root, root)).toBe(true);
    expect(rp.isInside(`${root}/src/a.js`, root)).toBe(true);
    expect(rp.isInside('ssh-remote://abcd1234/home/y/api2', root)).toBe(false);
    expect(rp.isInside('ssh-remote://abcd1234/home/y/API/x', root)).toBe(false);
    expect(rp.isInside('ssh-remote://zzzz9999/home/y/api/x', root)).toBe(false);
    expect(rp.isInside('/home/y/api/x', root)).toBe(false);
    expect(rp.isInside('ssh-remote://abcd1234/anything', 'ssh-remote://abcd1234/')).toBe(true);
    expect(rp.isInside('ssh-remote://abcd1234/../x', root)).toBe(false);
  });
});
