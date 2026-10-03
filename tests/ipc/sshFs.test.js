/**
 * @jest-environment node
 *
 * The `ssh.fs` IPC (design/remote-ssh.md section 5.5): every remote path is
 * authorised in main, whatever the renderer checked, and the transfers keep
 * their promised shape.
 *
 *  - containment: inside a registered project after POSIX normalisation, and
 *    for writes after canonicalising the parent with `cd -P` (a symlinked
 *    directory pointing out of the project is caught by a real sh);
 *  - the remote blocklist: no write to ~/.ssh, the rc files or the CLI's
 *    credentials, no read of ~/.ssh, even inside a project; the project's
 *    private memory directory on the host is the one grant outside a root;
 *  - one request per directory listing and per content search;
 *  - writes are atomic (temp file then mv) and fail fast while reconnecting;
 *  - media previews land in remote-cache/<projectId>/media, size capped, and
 *    the renderer CSP is left exactly as it was.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn(), on: jest.fn() },
  dialog: {},
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));
jest.mock('../../src/main/services/SshHostService', () => ({}));
jest.mock('../../src/main/services/TerminalService', () => ({}));

const { createSshFs, MEDIA_MAX_BYTES } = require('../../src/main/ipc/ssh.ipc');
const { createTargetResolver } = require('../../src/main/utils/projectTarget');
const { SshLane } = require('../../src/main/utils/sshChannel');
const remotePath = require('../../src/shared/remote-path');
const { findSh, toShPath, FAKE_SSH } = require('../helpers/fake-ssh');

const PID = 'abcd1234';
const PROFILE = { id: PID, host: 'build.example.com', user: 'y' };
const HOME = '/home/y';
const uri = (p) => remotePath.format(PID, p);

/** A host service whose channel is a scripted function; counts requests. */
function makeService({ state = 'connected', home = HOME, exec } = {}) {
  const calls = [];
  const service = {
    state,
    getStatus: jest.fn(() => ({ profileId: PID, state: service.state, capabilities: service.state === 'idle' ? null : { home, claudeConfigDir: '' } })),
    connect: jest.fn(async () => ({ profileId: PID, state: 'connected', capabilities: { home } })),
    runner: jest.fn(() => ({
      exec: async (script, opts = {}) => {
        calls.push({ script, opts });
        return exec ? exec(script, opts) : { ok: true, code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
      oneShot: async (script, opts = {}) => {
        calls.push({ script, opts, oneShot: true });
        return exec ? exec(script, opts) : { ok: true, code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    })),
  };
  return { service, calls };
}

function makeFs({ projects, service, cacheRoot = () => path.join(os.tmpdir(), 'ct-sshfs-cache-unused') }) {
  const resolver = createTargetResolver({
    getProfile: async (id) => (id === PID ? PROFILE : null),
    loadProjects: async () => projects,
  });
  return createSshFs({ service, resolveTarget: resolver.resolveTarget, loadProjects: async () => projects, cacheRoot });
}

const ok = (stdout = '') => ({ ok: true, code: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });

describe('containment and the blocklist (no host needed)', () => {
  const projects = [
    { id: 'p-api', name: 'api', path: uri('/home/y/api'), remote: { profileId: PID, path: '/home/y/api' } },
    { id: 'p-home', name: 'home', path: uri('/home/y'), remote: { profileId: PID, path: '/home/y' } },
  ];

  test('a path outside every registered project is refused before the host is asked', async () => {
    const { service, calls } = makeService();
    const sshFs = makeFs({ projects, service });
    await expect(sshFs.run({ op: 'readFile', path: uri('/etc/passwd') })).rejects.toMatchObject({ code: 'REMOTE_PATH_NOT_IN_PROJECT' });
    await expect(sshFs.run({ op: 'stat', path: uri('/home/other/x') })).rejects.toMatchObject({ code: 'REMOTE_PATH_NOT_IN_PROJECT' });
    expect(calls).toHaveLength(0);
  });

  test('a `..` that escapes is refused, and one that normalises out of the project too', async () => {
    const { service, calls } = makeService();
    const sshFs = makeFs({ projects: [projects[0]], service });
    await expect(sshFs.run({ op: 'stat', path: `ssh-remote://${PID}/../../etc/passwd` })).rejects.toMatchObject({ code: 'REMOTE_PATH_ESCAPE' });
    await expect(sshFs.run({ op: 'readFile', path: `ssh-remote://${PID}/home/y/api/../secrets.txt` })).rejects.toMatchObject({ code: 'REMOTE_PATH_NOT_IN_PROJECT' });
    await expect(sshFs.run({ op: 'stat', path: '/home/y/api/x' })).rejects.toMatchObject({ code: 'REMOTE_PATH_INVALID' });
    expect(calls).toHaveLength(0);
  });

  test.each([
    ['/home/y/.ssh/authorized_keys'],
    ['/home/y/.ssh'],
    ['/home/y/.bashrc'],
    ['/home/y/.zshrc'],
    ['/home/y/.profile'],
    ['/home/y/.config/fish/config.fish'],
    ['/home/y/.claude/.credentials.json'],
  ])('a write to %s is refused even inside a project', async (p) => {
    const { service, calls } = makeService();
    const sshFs = makeFs({ projects, service });
    await expect(sshFs.run({ op: 'writeFile', path: uri(p), data: 'x' })).rejects.toMatchObject({ code: 'REMOTE_PATH_BLOCKED' });
    expect(calls).toHaveLength(0);
  });

  test('any read of ~/.ssh and of the credentials is refused; other dotfiles read fine', async () => {
    const { service, calls } = makeService({ exec: (script) => (script.includes('ct_canon') ? ok(`${HOME}\n/home/y\t\n\n/home/y\t/.bashrc\n\n`) : ok('5\nhello')) });
    const sshFs = makeFs({ projects, service });
    for (const op of ['readFile', 'stat', 'readdir', 'cacheMedia']) {
      await expect(sshFs.run({ op, path: uri('/home/y/.ssh/id_ed25519') })).rejects.toMatchObject({ code: 'REMOTE_PATH_BLOCKED' });
    }
    await expect(sshFs.run({ op: 'readdir', path: uri('/home/y/.ssh') })).rejects.toMatchObject({ code: 'REMOTE_PATH_BLOCKED' });
    await expect(sshFs.run({ op: 'readFile', path: uri('/home/y/.claude/.credentials.json') })).rejects.toMatchObject({ code: 'REMOTE_PATH_BLOCKED' });
    expect(calls).toHaveLength(0);
    const res = await sshFs.run({ op: 'readFile', path: uri('/home/y/.bashrc') });
    expect(res.data).toBe('hello');
  });

  test('a read through a symlink that resolves into ~/.ssh is refused', async () => {
    // canonicalize answers: home, then the parent and the file itself (a link into ~/.ssh).
    const { service } = makeService({ exec: (script) => (script.includes('ct_canon') ? ok(`${HOME}\n/home/y/api\t\n\n/home/y/api\t/key\n/home/y/.ssh/id_ed25519\n`) : ok('3\nkey')) });
    const sshFs = makeFs({ projects: [projects[0]], service });
    await expect(sshFs.run({ op: 'readFile', path: uri('/home/y/api/key') })).rejects.toMatchObject({ code: 'REMOTE_PATH_BLOCKED' });
  });

  test("the project's private memory on the host is allowed, its transcripts are not", async () => {
    const { service } = makeService({
      exec: (script) => {
        if (script.includes('ct_canon')) {
          const dir = '/home/y/.claude/projects/-home-y-api';
          return ok(`${HOME}\n${dir}/memory\t\n\n${dir}/memory\t\n\n${dir}/memory\t/MEMORY.md\n\n`);
        }
        return ok('');
      },
    });
    const sshFs = makeFs({ projects: [projects[0]], service });
    const memoryFile = uri('/home/y/.claude/projects/-home-y-api/memory/MEMORY.md');
    await expect(sshFs.run({ op: 'writeFile', path: memoryFile, data: '# notes' })).resolves.toEqual({ bytes: 7 });
    await expect(sshFs.authorize(uri('/home/y/.claude/projects/-home-y-api/CLAUDE.md'), 'write')).resolves.toMatchObject({ project: { id: 'p-api' } });
    await expect(sshFs.run({ op: 'readFile', path: uri('/home/y/.claude/projects/-home-y-api/abc.jsonl') })).rejects.toMatchObject({ code: 'REMOTE_PATH_NOT_IN_PROJECT' });
    // Another project's memory is not this one's grant.
    await expect(sshFs.run({ op: 'readFile', path: uri('/home/y/.claude/projects/-home-y-web/memory/MEMORY.md') })).rejects.toMatchObject({ code: 'REMOTE_PATH_NOT_IN_PROJECT' });
  });

  test('privatePaths names the private CLAUDE.md and memory directory on the host', async () => {
    const { service, calls } = makeService();
    const sshFs = makeFs({ projects: [projects[0]], service });
    await expect(sshFs.run({ op: 'privatePaths', path: projects[0].path })).resolves.toEqual({
      sessionsDir: uri('/home/y/.claude/projects/-home-y-api'),
      claudeMd: uri('/home/y/.claude/projects/-home-y-api/CLAUDE.md'),
      memoryDir: uri('/home/y/.claude/projects/-home-y-api/memory'),
    });
    expect(calls).toHaveLength(0);
  });

  test('copy and move between two hosts are refused', async () => {
    const other = 'zzzz9999';
    const { service } = makeService();
    const resolver = createTargetResolver({
      getProfile: async (id) => ({ id }),
      loadProjects: async () => [projects[0], { id: 'p2', path: remotePath.format(other, '/srv/app') }],
    });
    const sshFs = createSshFs({ service, resolveTarget: resolver.resolveTarget, loadProjects: async () => [] });
    service.getStatus.mockImplementation((id) => ({ profileId: id, state: 'connected', capabilities: { home: HOME } }));
    await expect(sshFs.run({ op: 'copy', from: uri('/home/y/api/a'), to: remotePath.format(other, '/srv/app/a') })).rejects.toMatchObject({ code: 'REMOTE_CROSS_HOST' });
  });
});

describe('request counts and failure modes', () => {
  const projects = [{ id: 'p-api', path: uri('/home/y/api'), remote: { profileId: PID, path: '/home/y/api' } }];

  test('readdir returns name, type, size and mtime in a single request', async () => {
    const listing = Buffer.concat([
      Buffer.from('f/a.txt\0d/src\0\0'),
      Buffer.from('5 1700000000\n4096 1700000100\n'),
    ]);
    const { service, calls } = makeService({ exec: () => ({ ok: true, code: 0, stdout: listing, stderr: Buffer.alloc(0) }) });
    const sshFs = makeFs({ projects, service });
    const entries = await sshFs.run({ op: 'readdir', path: uri('/home/y/api') });
    expect(calls).toHaveLength(1);
    expect(entries).toEqual([
      { name: 'a.txt', type: 'file', symlink: false, size: 5, mtimeMs: 1700000000000 },
      { name: 'src', type: 'directory', symlink: false, size: 4096, mtimeMs: 1700000100000 },
    ]);
  });

  test('a content search is one remote grep, never a read per file', async () => {
    const { service, calls } = makeService({ exec: () => ok('src/a.js:3:const needle = 1\nREADME.md:1:# needle\n') });
    const sshFs = makeFs({ projects, service });
    const res = await sshFs.run({ op: 'grep', path: uri('/home/y/api'), pattern: 'needle' });
    expect(calls).toHaveLength(1);
    expect(calls[0].script).toContain('git grep');
    expect(res.matches).toEqual([
      { file: 'src/a.js', line: 3, text: 'const needle = 1' },
      { file: 'README.md', line: 1, text: '# needle' },
    ]);
  });

  test('a write fails fast with `disconnected` while the host reconnects, and nothing is sent', async () => {
    const { service, calls } = makeService({ state: 'reconnecting' });
    const sshFs = makeFs({ projects, service });
    const started = Date.now();
    await expect(sshFs.run({ op: 'writeFile', path: uri('/home/y/api/a.txt'), data: 'x' }))
      .rejects.toMatchObject({ code: 'REMOTE_DISCONNECTED', reason: 'disconnected' });
    for (const op of ['mkdir', 'rm']) {
      await expect(sshFs.run({ op, path: uri('/home/y/api/d') })).rejects.toMatchObject({ reason: 'disconnected' });
    }
    expect(Date.now() - started).toBeLessThan(1000);
    expect(calls).toHaveLength(0);
    expect(service.connect).not.toHaveBeenCalled();
  });

  test('a read connects an idle host, never one stopped on an auth or host key failure', async () => {
    const { service } = makeService({ state: 'idle', exec: () => ok('f\n5 1700000000\n') });
    const sshFs = makeFs({ projects, service });
    await expect(sshFs.run({ op: 'stat', path: uri('/home/y/api/a.txt') })).resolves.toMatchObject({ isFile: true });
    expect(service.connect).toHaveBeenCalledTimes(1);

    service.connect.mockClear();
    service.getStatus.mockImplementation(() => ({ profileId: PID, state: 'authFailed', capabilities: null }));
    await expect(sshFs.run({ op: 'stat', path: uri('/home/y/api/a.txt') })).rejects.toMatchObject({ code: 'REMOTE_DISCONNECTED', state: 'authFailed' });
    expect(service.connect).not.toHaveBeenCalled();
  });

  test('the write itself is a temp file renamed into place, sent as a write', async () => {
    const { service, calls } = makeService({
      exec: (script) => (script.includes('ct_canon') ? ok(`${HOME}\n/home/y/api\t\n\n/home/y/api\t\n\n/home/y/api\t/a.txt\n\n`) : ok('')),
    });
    const sshFs = makeFs({ projects, service });
    await sshFs.run({ op: 'writeFile', path: uri('/home/y/api/a.txt'), data: 'hello' });
    expect(calls).toHaveLength(2);
    expect(calls[0].opts).toMatchObject({ write: true }); // the canonical check fails fast too
    const write = calls[1];
    expect(write.opts).toMatchObject({ write: true });
    expect(Buffer.from(write.opts.input).toString()).toBe('hello');
    expect(write.script).toMatch(/t='\/home\/y\/api\/a\.txt\.ct-tmp-[0-9a-f]+'/);
    expect(write.script).toContain('cat >"$t" && mv -f -- "$t" "$f"');
  });

  test('removing the project root is refused', async () => {
    const { service } = makeService();
    const sshFs = makeFs({ projects, service });
    await expect(sshFs.run({ op: 'rm', path: uri('/home/y/api'), recursive: true })).rejects.toMatchObject({ code: 'EPERM' });
  });

  test('an unknown op is refused', async () => {
    const { service } = makeService();
    const sshFs = makeFs({ projects, service });
    await expect(sshFs.run({ op: 'exec', path: uri('/home/y/api') })).rejects.toMatchObject({ code: 'EINVAL' });
  });
});

describe('media cache', () => {
  const projects = [{ id: 'p-api', path: uri('/home/y/api'), remote: { profileId: PID, path: '/home/y/api' } }];
  let cache;
  beforeEach(() => { cache = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-media-')); });
  afterEach(() => fs.rmSync(cache, { recursive: true, force: true }));

  test('a file over the cap is refused before anything is downloaded', async () => {
    const big = MEDIA_MAX_BYTES + 1;
    const { service, calls } = makeService({ exec: (script) => (script.includes("printf '%s\\n' \"$t\"") ? ok(`f\n${big} 1700000000\n`) : ok('')) });
    const sshFs = makeFs({ projects, service, cacheRoot: () => cache });
    await expect(sshFs.run({ op: 'cacheMedia', path: uri('/home/y/api/video.mp4') })).rejects.toMatchObject({ code: 'ETOOLARGE' });
    expect(calls).toHaveLength(1); // the stat, nothing more
    expect(fs.readdirSync(cache)).toEqual([]);
  });

  test('a preview is downloaded once into remote-cache/<projectId>/media', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const { service, calls } = makeService({
      exec: (script) => {
        if (script.includes('ct_canon')) return ok(`${HOME}\n/home/y/api/img\t\n\n/home/y/api/img\t/logo.png\n\n`);
        if (script.includes("printf '%s\\n' \"$t\"")) return ok(`f\n${png.length} 1700000000\n`);
        return { ok: true, code: 0, stdout: Buffer.concat([Buffer.from(`${png.length}\n`), png]), stderr: Buffer.alloc(0) };
      },
    });
    const sshFs = makeFs({ projects, service, cacheRoot: () => cache });
    const first = await sshFs.run({ op: 'cacheMedia', path: uri('/home/y/api/img/logo.png') });
    expect(first.cached).toBe(false);
    expect(path.dirname(first.localPath)).toBe(path.join(cache, 'p-api', 'media'));
    expect(fs.readFileSync(first.localPath)).toEqual(png);
    const before = calls.length;
    const second = await sshFs.run({ op: 'cacheMedia', path: uri('/home/y/api/img/logo.png') });
    expect(second).toMatchObject({ localPath: first.localPath, cached: true });
    // The stat and the symlink check run again; the download does not.
    expect(calls.length - before).toBe(2);
  });

  test('the renderer CSP is not modified', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)[1];
    expect(csp).toBe("default-src 'self'; script-src 'self' 'unsafe-eval'; img-src 'self' data: blob: https:; connect-src 'self' https://api.github.com https://api.anthropic.com https://registry.modelcontextprotocol.io https://skills.sh https://telemetry.claudeterminal.dev https://claude-terminal-hub.claudeterminal.workers.dev; style-src 'self' 'unsafe-inline'; frame-src ct-preview:");
  });
});

const SH = findSh();
(SH ? describe : describe.skip)('against a real sh', () => {
  jest.setTimeout(30000);
  let tmp, root, outside, lane, sshFs, projects;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-sshfs-'));
    fs.mkdirSync(path.join(tmp, 'project', 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'outside'));
    fs.writeFileSync(path.join(tmp, 'project', 'src', 'a.txt'), 'hello');
    // A directory link out of the project: a junction on Windows (no
    // privilege needed), a plain symlink elsewhere. Git for Windows' sh
    // resolves both through `cd -P`.
    fs.symlinkSync(path.join(tmp, 'outside'), path.join(tmp, 'project', 'link'), 'junction');
    root = toShPath(path.join(tmp, 'project'));
    outside = path.join(tmp, 'outside');
    lane = new SshLane({ command: process.execPath, args: [FAKE_SSH], env: { ...process.env, FAKE_SSH_SH: SH } });
    await lane.open();
    projects = [{ id: 'p-real', path: uri(root), remote: { profileId: PID, path: root } }];
    const service = {
      getStatus: () => ({ profileId: PID, state: 'connected', capabilities: { home: toShPath(tmp) } }),
      connect: async () => ({ state: 'connected' }),
      runner: () => ({ exec: (script, opts = {}) => lane.request(script, opts), oneShot: (script, opts = {}) => lane.request(script, opts) }),
    };
    sshFs = makeFs({ projects, service });
  });

  afterAll(() => {
    lane.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a write whose canonical parent resolves outside the project is refused, and nothing is written', async () => {
    await expect(sshFs.run({ op: 'writeFile', path: uri(`${root}/link/evil.txt`), data: 'x' }))
      .rejects.toMatchObject({ code: 'REMOTE_PATH_OUTSIDE_PROJECT' });
    await expect(sshFs.run({ op: 'mkdir', path: uri(`${root}/link/new/deeper`) }))
      .rejects.toMatchObject({ code: 'REMOTE_PATH_OUTSIDE_PROJECT' });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test('a write inside the project lands atomically and reads back', async () => {
    await sshFs.run({ op: 'writeFile', path: uri(`${root}/src/b.txt`), data: "it's été" });
    expect(fs.readFileSync(path.join(tmp, 'project', 'src', 'b.txt'), 'utf8')).toBe("it's été");
    expect(fs.readdirSync(path.join(tmp, 'project', 'src')).filter((n) => n.includes('.ct-tmp-'))).toEqual([]);
    const read = await sshFs.run({ op: 'readFile', path: uri(`${root}/src/b.txt`) });
    expect(read).toMatchObject({ data: "it's été", truncated: false });
  });

  test('a new nested directory inside the project is created', async () => {
    await sshFs.run({ op: 'mkdir', path: uri(`${root}/src/x/y`) });
    expect(fs.statSync(path.join(tmp, 'project', 'src', 'x', 'y')).isDirectory()).toBe(true);
  });
});
