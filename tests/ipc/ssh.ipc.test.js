/**
 * @jest-environment node
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const mockHandlers = new Map();
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel, fn) => mockHandlers.set(channel, fn),
    on: (channel, fn) => mockHandlers.set(channel, fn),
  },
  dialog: { showOpenDialog: jest.fn(async () => ({ canceled: false, filePaths: ['/home/y/.ssh/id_ed25519'] })) },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));

const MOCK_PROFILE = { id: 'abcd1234', host: 'build.example.com', user: 'yanis', port: 22 };
let mockRunnerExec = null;

const mockService = {
  listProfiles: jest.fn(async () => [MOCK_PROFILE]),
  getAllStatuses: jest.fn(() => []),
  saveProfile: jest.fn(async (p) => ({ ...p, id: 'abcd1234' })),
  deleteProfile: jest.fn(async () => true),
  testProfile: jest.fn(async () => ({ ok: true })),
  connect: jest.fn(async (profileId) => ({ profileId, state: 'connected' })),
  disconnect: jest.fn((profileId) => ({ profileId, state: 'idle' })),
  getStatus: jest.fn((profileId) => ({ profileId, state: 'idle' })),
  onOnline: jest.fn(),
  getProfile: jest.fn(async (id) => (id === MOCK_PROFILE.id ? MOCK_PROFILE : null)),
  exec: jest.fn(async () => ({ ok: true, code: 0, stdout: Buffer.from('Initialized'), stderr: Buffer.alloc(0) })),
  oneShot: jest.fn(async () => ({ ok: true, code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })),
  runner: jest.fn(() => ({ exec: (script, opts) => mockRunnerExec(script, opts) })),
  verifyCommand: jest.fn(async () => ({ file: '/usr/bin/ssh', args: ['-o', 'StrictHostKeyChecking=ask', '--', 'build.example.com', 'exit'], destination: 'yanis@build.example.com' })),
};
jest.mock('../../src/main/services/SshHostService', () => mockService);
const mockTerminalService = { create: jest.fn(() => ({ success: true, id: 42 })) };
jest.mock('../../src/main/services/TerminalService', () => mockTerminalService);

const { registerSshHandlers, isAllowedCloneUrl } = require('../../src/main/ipc/ssh.ipc');
const { SshLane } = require('../../src/main/utils/sshChannel');
const { findSh, toShPath, FAKE_SSH } = require('../helpers/fake-ssh');

const event = {
  sender: { id: 1, once: () => {}, removeListener: () => {}, isDestroyed: () => false, send: jest.fn() },
};
const invoke = (channel, ...args) => mockHandlers.get(channel)(event, ...args);

beforeAll(() => registerSshHandlers());
beforeEach(() => {
  jest.clearAllMocks();
  mockRunnerExec = async () => ({ ok: true, code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
});

describe('ssh.ipc never takes a destination from the renderer', () => {
  const smuggled = { host: 'evil.example.com', user: 'root', port: 2222, args: ['-oProxyCommand=calc'], sshBinary: 'C:\\evil.exe' };

  test.each([
    ['ssh-connect', 'connect'],
    ['ssh-disconnect', 'disconnect'],
    ['ssh-profile-test', 'testProfile'],
    ['ssh-profile-delete', 'deleteProfile'],
    ['ssh-status', 'getStatus'],
    ['ssh-verify-host', 'verifyCommand'],
  ])('%s passes the profile id and nothing else', async (channel, method) => {
    await invoke(channel, { profileId: 'abcd1234', ...smuggled });
    expect(mockService[method]).toHaveBeenCalledWith('abcd1234');
  });

  test('handlers destructure no host, user or port from their parameters', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/main/ipc/ssh.ipc.js'), 'utf8');
    const params = [...src.matchAll(/async \(_?event, \{([^}]*)\}/g)].map((m) => m[1]);
    expect(params.length).toBeGreaterThan(5);
    for (const p of params) expect(p).not.toMatch(/\b(host|user|port|sshConfigAlias|proxyJump|identityFile|args)\b/);
  });

  test('verify host runs the argv main built, in a local PTY, and returns its id', async () => {
    const res = await invoke('ssh-verify-host', { profileId: 'abcd1234', command: { file: 'C:\evil.exe', args: ['/c', 'calc'] } });
    expect(res).toMatchObject({ success: true, id: 42, destination: 'yanis@build.example.com' });
    const [opts] = mockTerminalService.create.mock.calls[0];
    expect(opts.command).toEqual({ file: '/usr/bin/ssh', args: ['-o', 'StrictHostKeyChecking=ask', '--', 'build.example.com', 'exit'] });
    expect(opts.cwd).toBe(os.homedir());
  });

  test('verify host with an unknown profile starts nothing', async () => {
    mockService.verifyCommand.mockRejectedValueOnce(Object.assign(new Error('unknown'), { code: 'REMOTE_PROFILE_UNKNOWN' }));
    const res = await invoke('ssh-verify-host', { profileId: 'zzzz9999' });
    expect(res).toMatchObject({ success: false, code: 'REMOTE_PROFILE_UNKNOWN' });
    expect(mockTerminalService.create).not.toHaveBeenCalled();
  });

  test('browse with an unknown profile is refused', async () => {
    const res = await invoke('ssh-browse', { profileId: 'zzzz9999', path: '/srv' });
    expect(res).toMatchObject({ success: false, code: 'REMOTE_PROFILE_UNKNOWN' });
    expect(mockService.runner).not.toHaveBeenCalled();
  });

  test('mkdir and init refuse relative paths and the root', async () => {
    expect(await invoke('ssh-mkdir', { profileId: 'abcd1234', path: 'relative' })).toMatchObject({ success: false, code: 'REMOTE_PATH_INVALID' });
    expect(await invoke('ssh-init', { profileId: 'abcd1234', path: '/' })).toMatchObject({ success: false, code: 'REMOTE_PATH_INVALID' });
    expect(mockService.exec).not.toHaveBeenCalled();
  });

  test('init runs git init in the given directory as a write', async () => {
    const res = await invoke('ssh-init', { profileId: 'abcd1234', path: "/srv/it's new" });
    expect(res.success).toBe(true);
    const [profileId, script, opts] = mockService.exec.mock.calls[0];
    expect(profileId).toBe('abcd1234');
    expect(script).toContain("cd -- '/srv/it'\\''s new' && ");
    expect(script).toContain("exec git -c protocol.ext.allow=never 'init'");
    expect(opts).toMatchObject({ write: true });
  });

  test('a host that does not connect makes writes fail with the state', async () => {
    mockService.connect.mockResolvedValueOnce({ profileId: 'abcd1234', state: 'authFailed' });
    const res = await invoke('ssh-mkdir', { profileId: 'abcd1234', path: '/srv/x' });
    expect(res).toMatchObject({ success: false, code: 'REMOTE_DISCONNECTED' });
  });
});

describe('ssh-clone', () => {
  test.each([
    'ext::sh -c calc',
    'file:///etc',
    '--upload-pack=calc',
    'http://insecure.example.com/r.git',
    'https://example.com/r.git --config=x',
    'git@host:-oProxyCommand=calc',
    '',
  ])('refuses %j', (url) => {
    expect(isAllowedCloneUrl(url)).toBe(false);
  });

  test('accepts https and scp-style git@ URLs', () => {
    expect(isAllowedCloneUrl('https://github.com/Sterll/claude-terminal.git')).toBe(true);
    expect(isAllowedCloneUrl('git@github.com:Sterll/claude-terminal.git')).toBe(true);
  });

  test('clones with a one-shot exec, never the local token, into a new directory', async () => {
    const res = await invoke('ssh-clone', { profileId: 'abcd1234', url: 'https://github.com/Sterll/claude-terminal.git', path: '/srv/ct' });
    expect(res).toMatchObject({ success: true, path: '/srv/ct' });
    const [profileId, script] = mockService.oneShot.mock.calls[0];
    expect(profileId).toBe('abcd1234');
    expect(script).toContain("if [ -e '/srv/ct' ]; then");
    expect(script).toContain("clone --progress -- 'https://github.com/Sterll/claude-terminal.git' '/srv/ct'");
    expect(script).not.toMatch(/x-access-token|Authorization/i);
  });

  test('a refused URL never reaches the host', async () => {
    const res = await invoke('ssh-clone', { profileId: 'abcd1234', url: 'ext::sh', path: '/srv/ct' });
    expect(res.success).toBe(false);
    expect(mockService.oneShot).not.toHaveBeenCalled();
  });
});

const SH = findSh();
(SH ? describe : describe.skip)('ssh-browse against a real sh', () => {
  jest.setTimeout(30000);
  let tmp, lane;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-browse-'));
    fs.mkdirSync(path.join(tmp, 'projects'));
    fs.mkdirSync(path.join(tmp, '.config'));
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'do not list me');
    fs.writeFileSync(path.join(tmp, 'notes.md'), '# notes');
    lane = new SshLane({ command: process.execPath, args: [FAKE_SSH], env: { ...process.env, FAKE_SSH_SH: SH } });
    await lane.open();
  });

  afterAll(() => {
    lane.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('returns directories only, never files or contents', async () => {
    mockRunnerExec = (script, opts) => lane.request(script, opts);
    const res = await invoke('ssh-browse', { profileId: 'abcd1234', path: toShPath(tmp) });
    expect(res.success).toBe(true);
    expect(res.entries.map((e) => e.name).sort()).toEqual(['.config', 'projects']);
    expect(res.entries.every((e) => e.type === 'directory')).toBe(true);
    expect(JSON.stringify(res)).not.toContain('do not list me');
    expect(JSON.stringify(res)).not.toContain('secret.txt');
    expect(res.parent).toBe(res.path.slice(0, res.path.lastIndexOf('/')) || '/');
  });
});
