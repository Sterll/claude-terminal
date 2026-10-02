/**
 * @jest-environment node
 *
 * Remote (SSH) projects fail closed in the main process until their own
 * slices land (design/remote-ssh.md section 3.2).
 *
 * TerminalService falls back to the home directory when a cwd does not exist,
 * and an ssh-remote:// URI never exists locally: without a guard, opening a
 * terminal on a remote project would start a local shell in ~ under the remote
 * project's name. Terminals now run over ssh, so `terminal-create` resolves a
 * URI to its host in main (and refuses anything it cannot resolve); the chat
 * still refuses a URI. Every local call is left exactly as it was.
 *
 * TerminalService's `command` override is the other half of this slice: the
 * "Verify host" PTY. It is reachable from main only.
 */

const mockHandlers = new Map();
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel, fn) => mockHandlers.set(channel, fn),
    on: (channel, fn) => mockHandlers.set(channel, fn),
  },
  BrowserWindow: { getAllWindows: () => [] },
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/data' },
}));

const mockTerminalService = {
  create: jest.fn(() => ({ success: true, id: 1 })), write: jest.fn(), resize: jest.fn(), kill: jest.fn(),
  respawn: jest.fn(() => ({ success: true, id: 7 })), remoteContext: jest.fn(() => null), has: jest.fn(() => false),
};
jest.mock('../../src/main/services/TerminalService', () => mockTerminalService);
jest.mock('../../src/main/services/AccountManager', () => ({ accountEnv: jest.fn(async () => null) }));
jest.mock('../../src/main/services/TelemetryService', () => ({ sendFeaturePing: jest.fn() }));
const mockChatService = { startSession: jest.fn(async () => 'chat-1') };
jest.mock('../../src/main/services/ChatService', () => mockChatService);
jest.mock('../../src/main/services/ModelCatalogService', () => ({ onChange: jest.fn() }));
const mockResolveTarget = jest.fn();
jest.mock('../../src/main/utils/projectTarget', () => ({ resolveTarget: (...a) => mockResolveTarget(...a) }));
const mockSsh = { ptyLaunch: jest.fn(), killTmuxSession: jest.fn(async () => true) };
jest.mock('../../src/main/services/SshHostService', () => mockSsh);

const { registerTerminalHandlers } = require('../../src/main/ipc/terminal.ipc');
const { registerChatHandlers } = require('../../src/main/ipc/chat.ipc');

beforeAll(() => {
  registerTerminalHandlers();
  registerChatHandlers();
});
beforeEach(() => jest.clearAllMocks());

const invoke = (channel, ...args) => mockHandlers.get(channel)({ sender: {} }, ...args);
const URI = 'ssh-remote://abcd1234/home/yanis/api';

describe('terminal-create', () => {
  const PROFILE = { id: 'abcd1234', host: 'build.example.com' };
  const LAUNCH = { profileId: 'abcd1234', profile: PROFILE, command: '/usr/bin/ssh', prefixArgs: [], env: null, capabilities: null, controlDir: null, platform: 'linux' };

  test('resolves a remote cwd in main and spawns over ssh, with no account overlay', async () => {
    mockResolveTarget.mockResolvedValueOnce({ kind: 'remote', profileId: 'abcd1234', remotePath: '/home/yanis/api', uri: URI });
    mockSsh.ptyLaunch.mockResolvedValueOnce(LAUNCH);
    const AccountManager = require('../../src/main/services/AccountManager');
    await invoke('terminal-create', { cwd: URI, runClaude: false, projectId: 'r1', projectPath: URI, accountId: 'acc-1', sessionKey: 'tab_r1_1' });
    expect(mockResolveTarget).toHaveBeenCalledWith(URI);
    expect(mockSsh.ptyLaunch).toHaveBeenCalledWith('abcd1234');
    expect(AccountManager.accountEnv).not.toHaveBeenCalled();
    const params = mockTerminalService.create.mock.calls[0][0];
    expect(params).not.toHaveProperty('accountEnv');
    expect(params.remote).toMatchObject({ ...LAUNCH, remotePath: '/home/yanis/api', uri: URI, sessionKey: 'tab_r1_1' });
  });

  test('refuses a URI that is not inside a registered remote project', async () => {
    mockResolveTarget.mockRejectedValueOnce(Object.assign(new Error('Remote path is not inside a registered remote project'), { code: 'REMOTE_PATH_NOT_IN_PROJECT' }));
    const res = await invoke('terminal-create', { cwd: 'ssh-remote://abcd1234/etc', projectId: 'r1', projectPath: URI });
    expect(res).toMatchObject({ success: false });
    expect(mockTerminalService.create).not.toHaveBeenCalled();
  });

  test('refuses a remote project path even with a local cwd', async () => {
    const res = await invoke('terminal-create', { cwd: 'C:\\code', projectId: 'r1', projectPath: URI });
    expect(res.success).toBe(false);
    expect(mockTerminalService.create).not.toHaveBeenCalled();
  });

  test('a local terminal is created with the same arguments as before', async () => {
    await invoke('terminal-create', { cwd: 'C:\\code\\app', runClaude: true, skipPermissions: false, projectId: 'p1', projectPath: 'C:\\code\\app' });
    expect(mockTerminalService.create).toHaveBeenCalledWith({
      cwd: 'C:\\code\\app', runClaude: true, skipPermissions: false, resumeSessionId: undefined, projectId: 'p1', projectPath: 'C:\\code\\app', accountEnv: null,
    });
  });

  test('the renderer cannot pass a command to run', async () => {
    await invoke('terminal-create', { cwd: 'C:\\code', command: { file: 'calc.exe', args: [] } });
    expect(mockTerminalService.create.mock.calls[0][0]).not.toHaveProperty('command');
  });

  test('the renderer cannot pass a remote launch context of its own', async () => {
    await invoke('terminal-create', { cwd: 'C:\\code', remote: { command: 'calc.exe', profile: PROFILE, remotePath: '/' } });
    expect(mockTerminalService.create.mock.calls[0][0]).not.toHaveProperty('remote');
  });
});

describe('terminal-respawn and terminal-kill (remote tabs)', () => {
  const LAUNCH = { profileId: 'abcd1234', profile: { id: 'abcd1234', host: 'h' }, command: '/usr/bin/ssh', prefixArgs: [], env: null, capabilities: null, controlDir: null, platform: 'linux' };

  test('a respawn resolves the host again from the path the tab was opened with', async () => {
    mockTerminalService.remoteContext.mockReturnValueOnce({ uri: URI, cwd: URI, projectPath: URI, profileId: 'abcd1234' });
    mockResolveTarget.mockResolvedValueOnce({ kind: 'remote', profileId: 'abcd1234', remotePath: '/home/yanis/api', uri: URI });
    mockSsh.ptyLaunch.mockResolvedValueOnce(LAUNCH);
    const res = await invoke('terminal-respawn', { id: 7, resumeSessionId: '0f1e2d3c-aaaa' });
    expect(res).toEqual({ success: true, id: 7 });
    expect(mockResolveTarget).toHaveBeenCalledWith(URI);
    expect(mockTerminalService.respawn).toHaveBeenCalledWith(7, { remote: expect.objectContaining({ ...LAUNCH, remotePath: '/home/yanis/api' }), resumeSessionId: '0f1e2d3c-aaaa' });
  });

  test('a local or unknown terminal cannot be respawned', async () => {
    const res = await invoke('terminal-respawn', { id: 3 });
    expect(res.success).toBe(false);
    expect(mockTerminalService.respawn).not.toHaveBeenCalled();
  });

  test('closing a remote tab ends its tmux session; closing a local one does nothing more', async () => {
    mockTerminalService.remoteContext.mockReturnValueOnce({ profileId: 'abcd1234', tmuxSession: 'ct-tab_r1_1' });
    mockHandlers.get('terminal-kill')({ sender: {} }, { id: 7 });
    expect(mockTerminalService.kill).toHaveBeenCalledWith(7);
    expect(mockSsh.killTmuxSession).toHaveBeenCalledWith('abcd1234', 'ct-tab_r1_1');

    mockSsh.killTmuxSession.mockClear();
    mockHandlers.get('terminal-kill')({ sender: {} }, { id: 8 });
    expect(mockTerminalService.kill).toHaveBeenCalledWith(8);
    expect(mockSsh.killTmuxSession).not.toHaveBeenCalled();
  });
});

describe('chat-start', () => {
  test('refuses a remote cwd', async () => {
    const res = await invoke('chat-start', { cwd: URI, prompt: 'hi' });
    expect(res.success).toBe(false);
    expect(mockChatService.startSession).not.toHaveBeenCalled();
  });

  test('a local session starts as before', async () => {
    const params = { cwd: 'C:\\code\\app', prompt: 'hi' };
    const res = await invoke('chat-start', params);
    expect(res).toEqual({ success: true, sessionId: 'chat-1' });
    expect(mockChatService.startSession).toHaveBeenCalledWith(params);
  });
});
