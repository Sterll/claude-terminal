/**
 * @jest-environment node
 *
 * Remote (SSH) projects fail closed in the main process until their own
 * slices land (design/remote-ssh.md section 3.2).
 *
 * TerminalService falls back to the home directory when a cwd does not exist,
 * and an ssh-remote:// URI never exists locally: without a guard, opening a
 * terminal on a remote project would start a local shell in ~ under the remote
 * project's name. The chat would start the local CLI the same way. Both IPC
 * handlers refuse a URI, and leave every local call exactly as it was.
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

const mockTerminalService = { create: jest.fn(() => ({ success: true, id: 1 })), write: jest.fn(), resize: jest.fn(), kill: jest.fn() };
jest.mock('../../src/main/services/TerminalService', () => mockTerminalService);
jest.mock('../../src/main/services/AccountManager', () => ({ accountEnv: jest.fn(async () => null) }));
jest.mock('../../src/main/services/TelemetryService', () => ({ sendFeaturePing: jest.fn() }));
const mockChatService = { startSession: jest.fn(async () => 'chat-1') };
jest.mock('../../src/main/services/ChatService', () => mockChatService);
jest.mock('../../src/main/services/ModelCatalogService', () => ({ onChange: jest.fn() }));

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
  test('refuses a remote cwd without spawning anything', async () => {
    const res = await invoke('terminal-create', { cwd: URI, projectId: 'r1', projectPath: URI });
    expect(res).toMatchObject({ success: false });
    expect(res.error).toMatch(/remote projects/);
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
