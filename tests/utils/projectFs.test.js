/**
 * The renderer's file-system facade for local and remote project paths.
 *
 * A local path must get the very objects callers always used, so nothing
 * about a local project moves. An ssh-remote:// URI gets an adapter with the
 * same method names over the async `ssh.fs` IPC, POSIX path rules, and never
 * the synchronous bridge.
 */

const projectFs = require('../../src/renderer/utils/projectFs');

const PID = 'abcd1234';
const ROOT = `ssh-remote://${PID}/home/y/api`;

let sshFs;
beforeEach(() => {
  sshFs = jest.fn(async () => ({ success: true, value: null }));
  window.electron_api = { ...window.electron_api, ssh: { fs: sshFs } };
});

describe('local paths keep the objects they always had', () => {
  test('fsFor and pathFor hand back the preload\'s own fs.promises and path', () => {
    expect(projectFs.fsFor('C:\\work\\app\\a.js')).toBe(window.electron_nodeModules.fs.promises);
    expect(projectFs.fsFor('/home/me/app/a.js')).toBe(window.electron_nodeModules.fs.promises);
    expect(projectFs.pathFor('C:\\work\\app')).toBe(window.electron_nodeModules.path);
  });

  test('local helpers never call ssh.fs', async () => {
    window.electron_nodeModules.fs.promises.access.mockResolvedValueOnce(undefined);
    await expect(projectFs.exists('/home/me/app/a.js')).resolves.toBe(true);
    await expect(projectFs.mediaPath('C:\\x\\a.png')).resolves.toBe('C:\\x\\a.png');
    expect(sshFs).not.toHaveBeenCalled();
  });

  test('a local project leaves tool paths alone', () => {
    expect(projectFs.toProjectUri('/etc/hosts', { path: '/home/me/app' })).toBe('/etc/hosts');
    expect(projectFs.toProjectUri('/home/y/api/a.js', { path: ROOT })).toBe(`${ROOT}/a.js`);
    expect(projectFs.toProjectUri(`${ROOT}/a.js`, { path: ROOT })).toBe(`${ROOT}/a.js`);
    expect(projectFs.toProjectUri('relative.js', { path: ROOT })).toBe('relative.js');
  });
});

describe('remote URIs go through ssh.fs', () => {
  test('readdir with file types is one request and keeps sizes and mtimes', async () => {
    sshFs.mockResolvedValueOnce({ success: true, value: [
      { name: 'src', type: 'directory', symlink: false, size: 4096, mtimeMs: 1 },
      { name: 'a.txt', type: 'file', symlink: false, size: 5, mtimeMs: 2 },
    ] });
    const entries = await projectFs.fsFor(ROOT).readdir(ROOT, { withFileTypes: true });
    expect(sshFs).toHaveBeenCalledTimes(1);
    expect(sshFs).toHaveBeenCalledWith({ op: 'readdir', path: ROOT });
    expect(entries.map(e => [e.name, e.isDirectory(), e.isFile(), e.size])).toEqual([['src', true, false, 4096], ['a.txt', false, true, 5]]);
  });

  test('readFile returns text, and refuses to hand back a silently cut file', async () => {
    sshFs.mockResolvedValueOnce({ success: true, value: { data: 'hello', size: 5, truncated: false } });
    await expect(projectFs.remoteFsPromises.readFile(`${ROOT}/a.txt`, 'utf8')).resolves.toBe('hello');
    expect(sshFs).toHaveBeenLastCalledWith({ op: 'readFile', path: `${ROOT}/a.txt`, encoding: 'utf8', maxBytes: undefined });
    sshFs.mockResolvedValueOnce({ success: true, value: { data: 'x', size: 9e9, truncated: true } });
    await expect(projectFs.remoteFsPromises.readFile(`${ROOT}/big.log`, 'utf8')).rejects.toMatchObject({ code: 'EFBIG' });
  });

  test('a failure carries main\'s code and reason', async () => {
    sshFs.mockResolvedValueOnce({ success: false, error: 'Host is not connected (reconnecting)', code: 'REMOTE_DISCONNECTED', reason: 'disconnected' });
    await expect(projectFs.remoteFsPromises.writeFile(`${ROOT}/a.txt`, 'x')).rejects.toMatchObject({ code: 'REMOTE_DISCONNECTED', reason: 'disconnected' });
  });

  test('rm with force ignores a missing file; unlink, rename, copy map to their ops', async () => {
    sshFs.mockResolvedValueOnce({ success: false, code: 'ENOENT', error: 'ENOENT' });
    await expect(projectFs.remoteFsPromises.rm(`${ROOT}/gone`, { recursive: true, force: true })).resolves.toBeUndefined();
    await projectFs.remoteFsPromises.unlink(`${ROOT}/a`);
    await projectFs.remoteFsPromises.rename(`${ROOT}/a`, `${ROOT}/b`);
    await projectFs.copyRecursive(`${ROOT}/dir`, `${ROOT}/dir2`);
    expect(sshFs.mock.calls.map(c => c[0])).toEqual([
      { op: 'rm', path: `${ROOT}/gone`, recursive: true },
      { op: 'rm', path: `${ROOT}/a`, recursive: false },
      { op: 'rename', from: `${ROOT}/a`, to: `${ROOT}/b` },
      { op: 'copy', from: `${ROOT}/dir`, to: `${ROOT}/dir2` },
    ]);
  });

  test('exists answers false rather than throwing', async () => {
    sshFs.mockResolvedValueOnce({ success: false, code: 'ENOENT' });
    await expect(projectFs.exists(`${ROOT}/nope`)).resolves.toBe(false);
  });

  test('listFiles, grep and mediaPath are single requests', async () => {
    sshFs.mockResolvedValueOnce({ success: true, value: { files: ['a.txt'], truncated: false } });
    await expect(projectFs.listFiles(ROOT)).resolves.toEqual({ files: ['a.txt'], truncated: false });
    sshFs.mockResolvedValueOnce({ success: true, value: { matches: [], truncated: false } });
    await projectFs.grep(ROOT, 'needle');
    sshFs.mockResolvedValueOnce({ success: true, value: { localPath: 'C:\\cache\\p\\media\\k-a.png' } });
    await expect(projectFs.mediaPath(`${ROOT}/a.png`)).resolves.toBe('C:\\cache\\p\\media\\k-a.png');
    expect(sshFs.mock.calls.map(c => c[0].op)).toEqual(['listFiles', 'grep', 'cacheMedia']);
  });

  test('the synchronous bridge is never touched for a URI', async () => {
    const syncFns = Object.keys(window.electron_nodeModules.fs).filter(k => k.endsWith('Sync'));
    sshFs.mockResolvedValue({ success: true, value: { data: '', size: 0, truncated: false } });
    await projectFs.fsFor(ROOT).readFile(`${ROOT}/a`, 'utf8');
    for (const k of syncFns) expect(window.electron_nodeModules.fs[k]).not.toHaveBeenCalled();
  });
});

describe('POSIX path rules on URIs', () => {
  const p = projectFs.pathFor(ROOT);
  test('join, dirname, basename, relative and resolve stay POSIX and keep the URI', () => {
    expect(p.sep).toBe('/');
    expect(p.join(ROOT, 'src', 'a.js')).toBe(`${ROOT}/src/a.js`);
    expect(p.dirname(`${ROOT}/src/a.js`)).toBe(`${ROOT}/src`);
    expect(p.basename(`${ROOT}/src/a.js`)).toBe('a.js');
    expect(p.extname(`${ROOT}/src/a.js`)).toBe('.js');
    expect(p.relative(ROOT, `${ROOT}/src/a.js`)).toBe('src/a.js');
    expect(p.resolve(`${ROOT}/src/../b.js`)).toBe(`${ROOT}/b.js`);
  });

  test('sameSide: both local, or both on one host', () => {
    expect(projectFs.sameSide('C:\\a', 'C:\\b')).toBe(true);
    expect(projectFs.sameSide(`${ROOT}/a`, `${ROOT}/b`)).toBe(true);
    expect(projectFs.sameSide('C:\\a', `${ROOT}/b`)).toBe(false);
    expect(projectFs.sameSide(`${ROOT}/a`, 'ssh-remote://zzzz9999/b')).toBe(false);
  });
});
