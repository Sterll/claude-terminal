/**
 * @jest-environment node
 *
 * git.ipc.js for remote (SSH) projects (design/remote-ssh.md sections 4.1
 * and 5.4).
 *
 * - A `projectPath` that is an ssh-remote:// URI is resolved once, before the
 *   handler: an unknown profile or a path outside every registered project is
 *   refused, in the handler's own result shape, before git.js and therefore
 *   before any ssh process is reached.
 * - `git-worktree-list` hands back URI-wrapped paths and never grants them to
 *   the renderer's fs bridge (a local project's worktrees still are).
 * - `git-clone` into a remote destination clones on the host and never fetches
 *   the local GitHub token, so it can be in neither argv nor env there.
 * - Commit-message generation reads every untracked file head in one request.
 */

const mockHandlers = new Map();
jest.mock('electron', () => ({
  ipcMain: { handle: (channel, fn) => mockHandlers.set(channel, fn), on: jest.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/data' },
  dialog: {},
}));

jest.mock('child_process', () => ({
  execFile: jest.fn(),
  execFileSync: jest.fn(),
  exec: jest.fn(),
  spawn: jest.fn(),
}));

const mockResolveTarget = jest.fn();
const mockResolveBrowseTarget = jest.fn();
jest.mock('../../src/main/utils/projectTarget', () => ({
  resolveTarget: (...a) => mockResolveTarget(...a),
  resolveBrowseTarget: (...a) => mockResolveBrowseTarget(...a),
  noteWorktreeRoots: jest.fn(),
}));

const mockSsh = {
  exec: jest.fn(),
  oneShot: jest.fn(),
  connect: jest.fn(async () => ({ state: 'connected' })),
  getStatus: jest.fn(() => ({ state: 'connected' })),
  runner: jest.fn(),
};
jest.mock('../../src/main/services/SshHostService', () => mockSsh);

const mockGitHub = { getTokenForGit: jest.fn(async () => 'ghp_SECRET_TOKEN'), parseGitHubRemote: jest.fn(() => ({ owner: 'a', repo: 'b' })) };
jest.mock('../../src/main/services/GitHubAuthService', () => mockGitHub);
jest.mock('../../src/main/services/TelemetryService', () => ({ sendFeaturePing: jest.fn() }));

const mockSecurity = { permitted: jest.fn(() => true), grant: jest.fn() };
jest.mock('../../src/main/utils/rendererSecurity', () => mockSecurity);

const mockGenerateCommitMessage = jest.fn(async () => ({ message: 'feat: x', source: 'heuristic' }));
jest.mock('../../src/main/utils/commitMessageGenerator', () => ({
  generateCommitMessage: (...a) => mockGenerateCommitMessage(...a),
  generateMultiCommitMessages: jest.fn(async () => []),
  generateSessionRecap: jest.fn(),
  groupFiles: jest.fn(() => []),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const git = require('../../src/main/utils/git');
const { registerGitHandlers } = require('../../src/main/ipc/git.ipc');

const URI = 'ssh-remote://abcd1234/home/u/api';
const TARGET = { kind: 'remote', profileId: 'abcd1234', profile: { id: 'abcd1234' }, remotePath: '/home/u/api', uri: URI, projectRoot: '/home/u/api', host: 'u@h' };

const sender = { id: 1, once: jest.fn(), removeListener: jest.fn(), isDestroyed: () => false, send: jest.fn() };
const invoke = (channel, ...args) => mockHandlers.get(channel)({ sender }, ...args);

function ok(stdout = '', code = 0) {
  return { ok: code === 0, code, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
}

beforeAll(() => registerGitHandlers());
beforeEach(() => {
  jest.clearAllMocks();
  git._remoteInternals.reset();
  mockSsh.connect.mockImplementation(async () => ({ state: 'connected' }));
  mockSsh.getStatus.mockImplementation(() => ({ state: 'connected' }));
});

function expectNothingSpawned() {
  expect(mockSsh.exec).not.toHaveBeenCalled();
  expect(mockSsh.oneShot).not.toHaveBeenCalled();
  expect(mockSsh.connect).not.toHaveBeenCalled();
  expect(childProcess.spawn).not.toHaveBeenCalled();
  expect(childProcess.execFile).not.toHaveBeenCalled();
}

describe('remote project paths are validated before any handler', () => {
  const refusals = [
    ['an unknown profile', { code: 'REMOTE_PROFILE_UNKNOWN', message: 'No SSH host profile with this id is configured on this machine' }],
    ['a path outside every registered project', { code: 'REMOTE_PATH_NOT_IN_PROJECT', message: 'Remote path is not inside a registered remote project' }],
  ];

  test.each(refusals)('%s is refused in each handler\'s own shape, before any ssh spawn', async (_name, err) => {
    mockResolveTarget.mockImplementation(async () => { throw Object.assign(new Error(err.message), { code: err.code }); });
    const uri = 'ssh-remote://zzzz9999/etc';

    expect(await invoke('git-status-detailed', { projectPath: uri })).toEqual({ error: err.message, success: false, refused: true });
    expect(await invoke('git-info', uri)).toEqual({ error: true, message: err.message, refused: true });
    expect(await invoke('git-info-full', uri)).toMatchObject({ error: true, refused: true });
    expect(await invoke('project-stats', uri)).toMatchObject({ error: true, refused: true });
    expect(await invoke('git-current-branch', { projectPath: uri })).toBeNull();
    expect(await invoke('git-merge-in-progress', { projectPath: uri })).toBe(false);
    expect(await invoke('git-rebase-in-progress', { projectPath: uri })).toBe(false);
    expect(await invoke('git-branch-orphan-commits', { projectPath: uri, branch: 'x' })).toBe(0);
    expect(await invoke('git-worktree-detect', { projectPath: uri })).toEqual({ isWorktree: false });
    expect(await invoke('git-commit', { projectPath: uri, message: 'x' })).toMatchObject({ success: false, refused: true });
    expect(await invoke('git-push', { projectPath: uri })).toMatchObject({ success: false, refused: true });
    expect(await invoke('git-worktree-create', { projectPath: uri, worktreePath: uri + '-x', newBranch: 'x' })).toMatchObject({ success: false, refused: true });
    expect(await invoke('git-generate-commit-message', { projectPath: uri, files: [{ path: 'a', status: '?' }], useAi: false }))
      .toMatchObject({ success: false, refused: true });

    expect(mockResolveTarget).toHaveBeenCalledWith(uri);
    expectNothingSpawned();
  });

  test('a registered remote path reaches its host through the channel', async () => {
    mockResolveTarget.mockResolvedValue(TARGET);
    mockSsh.exec.mockImplementation(async (_id, script) => ok(script.includes("'status'") ? ' M a.js\n' : ''));
    const res = await invoke('git-status-detailed', { projectPath: URI });
    expect(res).toMatchObject({ success: true, files: [{ path: 'a.js', status: 'M' }] });
    expect(mockSsh.exec).toHaveBeenCalled();
    expect(mockSsh.exec.mock.calls.every(([id]) => id === 'abcd1234')).toBe(true);
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  test('a local path is not resolved at all', async () => {
    childProcess.execFile.mockImplementation((cmd, args, opts, cb) => { setTimeout(() => cb(null, 'main', ''), 0); return { kill() {}, on() {} }; });
    await invoke('git-current-branch', { projectPath: __dirname });
    expect(mockResolveTarget).not.toHaveBeenCalled();
    expect(childProcess.execFile).toHaveBeenCalled();
  });
});

describe('git-worktree-list', () => {
  test('remote worktrees come back as URIs and are never granted', async () => {
    mockResolveTarget.mockResolvedValue(TARGET);
    mockSsh.exec.mockResolvedValue(ok('worktree /home/u/api\nHEAD 1\nbranch refs/heads/main\n\nworktree /home/u/api-feat\nHEAD 2\nbranch refs/heads/feat\n'));
    const res = await invoke('git-worktree-list', { projectPath: URI });
    expect(res.success).toBe(true);
    expect(res.worktrees.map((t) => t.path)).toEqual([URI, 'ssh-remote://abcd1234/home/u/api-feat']);
    expect(mockSecurity.grant).not.toHaveBeenCalled();
    expect(mockSecurity.permitted).not.toHaveBeenCalled();
  });

  test('a local project still grants its worktrees, as before', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-wt-list-'));
    try {
      childProcess.execFile.mockImplementation((cmd, args, opts, cb) => {
        setTimeout(() => cb(null, `worktree ${repo}\nHEAD 1\nbranch refs/heads/main\n\nworktree ${repo}-feat\nHEAD 2\n`, ''), 0);
        return { kill() {}, on() {} };
      });
      const res = await invoke('git-worktree-list', { projectPath: repo });
      expect(res.worktrees.map((t) => t.path)).toEqual([repo, `${repo}-feat`]);
      expect(mockSecurity.grant).toHaveBeenCalledWith(`${repo}-feat`);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('git-clone into a remote destination', () => {
  beforeEach(() => {
    mockResolveBrowseTarget.mockImplementation(async (profileId, p) => ({ kind: 'remote', browse: true, profileId, remotePath: p }));
    mockSsh.oneShot.mockResolvedValue({ ok: true, code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  });

  test('clones on the host and never fetches the local GitHub token', async () => {
    const res = await invoke('git-clone', { repoUrl: 'https://github.com/a/b.git', targetPath: 'ssh-remote://abcd1234/home/u/b' });
    expect(res).toEqual({ success: true, path: 'ssh-remote://abcd1234/home/u/b' });
    expect(mockGitHub.getTokenForGit).not.toHaveBeenCalled();
    expect(mockSsh.oneShot).toHaveBeenCalledTimes(1);
    const [profileId, script, options] = mockSsh.oneShot.mock.calls[0];
    expect(profileId).toBe('abcd1234');
    expect(script).toContain("clone --progress -- 'https://github.com/a/b.git' '/home/u/b'");
    expect(script).not.toContain('ghp_');
    expect(script).not.toMatch(/x-access-token|Authorization|extraheader/i);
    expect(options).not.toHaveProperty('env');
    expect(mockSecurity.permitted).not.toHaveBeenCalled();
  });

  test('the URL allowlist still applies', async () => {
    for (const repoUrl of ['file:///etc', 'ext::sh -c id', '--upload-pack=x', 'http://example.com/r.git']) {
      const res = await invoke('git-clone', { repoUrl, targetPath: 'ssh-remote://abcd1234/home/u/b' });
      expect(res.success).toBe(false);
    }
    expect(mockSsh.oneShot).not.toHaveBeenCalled();
  });
});

describe('commit message context for a remote work tree', () => {
  test('untracked file heads come back in one request, formatted like the local ones', async () => {
    mockResolveTarget.mockResolvedValue(TARGET);
    mockSsh.exec.mockImplementation(async (_id, script) => {
      if (script.includes("'diff' 'HEAD'")) return ok('diff --git a/a.js b/a.js\n+x');
      return ok('F 0 11 11\nhello\nworld\nD 1\nL 2 600000\n');
    });
    const files = [
      { path: 'a.js', status: 'M' },
      { path: 'new.js', status: '?' },
      { path: 'dir/', status: '?' },
      { path: 'big.bin', status: '?' },
    ];
    const res = await invoke('git-generate-commit-message', { projectPath: URI, files, useAi: false });
    expect(res.success).toBe(true);
    expect(mockSsh.exec).toHaveBeenCalledTimes(2);
    const diffContent = mockGenerateCommitMessage.mock.calls[0][1];
    expect(diffContent).toContain('diff --git a/a.js b/a.js');
    expect(diffContent).toContain('--- New file: new.js\n+++ new.js\n+hello\n+world');
    expect(diffContent).toContain('--- New directory: dir//');
    expect(diffContent).toContain('--- New file: big.bin (586KB, binary or large)');
  });
});
