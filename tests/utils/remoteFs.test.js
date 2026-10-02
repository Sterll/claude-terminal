/**
 * @jest-environment node
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { SshLane } = require('../../src/main/utils/sshChannel');
const { createRemoteFs, isBlockedRemotePath, PUT_LIMIT } = require('../../src/main/utils/remoteFs');
const { findSh, toShPath, FAKE_SSH } = require('../helpers/fake-ssh');

describe('isBlockedRemotePath', () => {
  const home = '/home/y';
  test('credentials and ~/.ssh are blocked for reads and writes', () => {
    for (const access of ['read', 'write']) {
      expect(isBlockedRemotePath('/home/y/.ssh/id_ed25519', home, access)).toBe(true);
      expect(isBlockedRemotePath('/home/y/.ssh', home, access)).toBe(true);
      expect(isBlockedRemotePath('/home/y/.claude/.credentials.json', home, access)).toBe(true);
    }
  });

  test('shell rc files are blocked for writes only', () => {
    expect(isBlockedRemotePath('/home/y/.bashrc', home, 'write')).toBe(true);
    expect(isBlockedRemotePath('/home/y/.config/fish/config.fish', home, 'write')).toBe(true);
    expect(isBlockedRemotePath('/home/y/.bashrc', home, 'read')).toBe(false);
  });

  test('ordinary project files are not blocked', () => {
    expect(isBlockedRemotePath('/home/y/api/src/index.js', home, 'write')).toBe(false);
    expect(isBlockedRemotePath('/home/y/.sshfoo', home, 'write')).toBe(false);
  });
});

const SH = findSh();
const describeSh = SH ? describe : describe.skip;

describeSh('remoteFs over a real channel', () => {
  jest.setTimeout(30000);
  let tmp, root, lane, lane2, rfs;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-rfs-'));
    root = toShPath(tmp);
    fs.writeFileSync(path.join(tmp, 'a b.txt'), 'hello');
    fs.writeFileSync(path.join(tmp, "it's.md"), '# title\nneedle here\n');
    fs.writeFileSync(path.join(tmp, '.hidden'), 'x');
    fs.mkdirSync(path.join(tmp, 'sub dir'));
    fs.mkdirSync(path.join(tmp, '.git-like'));
    fs.writeFileSync(path.join(tmp, 'sub dir', 'deep.txt'), 'NEEDLE again');
    const make = () => new SshLane({ command: process.execPath, args: [FAKE_SSH], env: { ...process.env, FAKE_SSH_SH: SH } });
    lane = make();
    lane2 = make();
    await Promise.all([lane.open(), lane2.open()]);
    rfs = createRemoteFs({
      exec: (script, opts) => lane.request(script, opts),
      oneShot: (script, opts) => lane2.request(script, { ...opts, maxBuffer: 1024 * 1024 }),
    });
  });

  afterAll(() => {
    lane.close();
    lane2.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('readdir returns names, types, sizes and mtimes in one round trip', async () => {
    const entries = await rfs.readdir(root);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(Object.keys(byName).sort()).toEqual(['.git-like', '.hidden', 'a b.txt', "it's.md", 'sub dir'].sort());
    expect(byName['a b.txt']).toMatchObject({ type: 'file', size: 5, symlink: false });
    expect(byName['sub dir'].type).toBe('directory');
    expect(byName['a b.txt'].mtimeMs).toBeGreaterThan(0);
  });

  test('readdir of a missing directory is ENOENT, of a file ENOTDIR', async () => {
    await expect(rfs.readdir(`${root}/nope`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(rfs.readdir(`${root}/a b.txt`)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  test('listDirectories returns directories only, with the canonical path', async () => {
    const listing = await rfs.listDirectories(`${root}/sub dir/..`);
    expect(listing.path.toLowerCase()).toBe(root.toLowerCase());
    expect(listing.entries.map((e) => e.name).sort()).toEqual(['.git-like', 'sub dir']);
    expect(listing.entries.every((e) => e.type === 'directory')).toBe(true);
  });

  test('stat distinguishes files, directories and missing paths', async () => {
    expect(await rfs.stat(`${root}/a b.txt`)).toMatchObject({ type: 'file', size: 5, isFile: true });
    expect(await rfs.stat(`${root}/sub dir`)).toMatchObject({ isDirectory: true });
    await expect(rfs.stat(`${root}/missing`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await rfs.exists(`${root}/missing`)).toBe(false);
  });

  test('readFile caps the bytes and reports truncation; readRange reads a slice', async () => {
    const full = await rfs.readFile(`${root}/it's.md`);
    expect(full.data.toString()).toBe('# title\nneedle here\n');
    expect(full.truncated).toBe(false);
    const capped = await rfs.readFile(`${root}/it's.md`, { maxBytes: 4 });
    expect(capped).toMatchObject({ size: 20, truncated: true });
    expect(capped.data.toString()).toBe('# ti');
    expect((await rfs.readRange(`${root}/it's.md`, 8, 6)).toString()).toBe('needle');
    await expect(rfs.readFile(`${root}/sub dir`)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  test('writeFile is byte-exact inline and through a one-shot exec, and replaces atomically', async () => {
    const small = crypto.randomBytes(1000);
    await rfs.writeFile(`${root}/written.bin`, small);
    expect(fs.readFileSync(path.join(tmp, 'written.bin')).equals(small)).toBe(true);
    await rfs.writeFile(`${root}/written.bin`, 'replaced');
    expect(fs.readFileSync(path.join(tmp, 'written.bin'), 'utf8')).toBe('replaced');
    const big = crypto.randomBytes(PUT_LIMIT + 1000);
    await rfs.writeFile(`${root}/big.bin`, big);
    expect(fs.readFileSync(path.join(tmp, 'big.bin')).equals(big)).toBe(true);
    expect(fs.readdirSync(tmp).some((n) => n.includes('.ct-tmp-'))).toBe(false);
    await expect(rfs.writeFile(`${root}/no such dir/x.txt`, 'x')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('mkdir, rename, copy and rm', async () => {
    await rfs.mkdir(`${root}/made/deeper`);
    expect(fs.statSync(path.join(tmp, 'made', 'deeper')).isDirectory()).toBe(true);
    await rfs.writeFile(`${root}/made/f.txt`, 'f');
    await rfs.rename(`${root}/made/f.txt`, `${root}/made/g.txt`);
    expect(fs.existsSync(path.join(tmp, 'made', 'g.txt'))).toBe(true);
    await rfs.copy(`${root}/made/g.txt`, `${root}/made/h.txt`);
    await expect(rfs.copy(`${root}/made/g.txt`, `${root}/made/h.txt`)).rejects.toMatchObject({ code: 'EEXIST' });
    await rfs.rm(`${root}/made`, { recursive: true });
    expect(fs.existsSync(path.join(tmp, 'made'))).toBe(false);
    await expect(rfs.rm('/')).rejects.toMatchObject({ code: 'EPERM' });
  });

  test('listFiles and grep work outside a git work tree', async () => {
    const { files } = await rfs.listFiles(root);
    expect(files).toEqual(expect.arrayContaining(['a b.txt', "it's.md", 'sub dir/deep.txt']));
    const { matches } = await rfs.grep(root, 'needle');
    expect(matches.map((m) => m.file).sort()).toEqual(["it's.md", 'sub dir/deep.txt']);
    expect(matches.find((m) => m.file === "it's.md")).toMatchObject({ line: 2 });
  });

  test('relative paths and control characters are refused locally', async () => {
    await expect(rfs.stat('relative/x')).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(rfs.stat(`${root}/a\nb`)).rejects.toThrow(/control character/);
  });

  test('a transport failure is EREMOTE with its reason', async () => {
    const dead = createRemoteFs({ exec: async () => ({ ok: false, reason: 'disconnected', code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }) });
    await expect(dead.stat('/x')).rejects.toMatchObject({ code: 'EREMOTE', reason: 'disconnected' });
  });
});
