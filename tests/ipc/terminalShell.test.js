/**
 * @jest-environment node
 *
 * The shell and external terminal settings of issue #255, at the IPC edge.
 *
 * Both are read by main from settings.json at the moment a tab or a window
 * opens; nothing the renderer sends then names a program. A Claude tab never
 * takes the shell, a default setting leaves `terminal-create`'s call to the
 * service exactly as it was, and a remote (SSH) path is refused before any
 * terminal application is looked up.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const mockHandlers = new Map();
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel, fn) => mockHandlers.set(channel, fn),
    on: (channel, fn) => mockHandlers.set(channel, fn),
  },
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/data' },
}));

const mockSettingsFile = require('path').join(require('os').tmpdir(), `ct-shell-settings-${process.pid}.json`);
jest.mock('../../src/main/utils/paths', () => ({
  ...jest.requireActual('../../src/main/utils/paths'),
  settingsFile: mockSettingsFile,
}));

const mockTerminalService = { create: jest.fn(() => ({ success: true, id: 1 })) };
jest.mock('../../src/main/services/TerminalService', () => mockTerminalService);
jest.mock('../../src/main/services/AccountManager', () => ({ accountEnv: jest.fn(async () => null) }));
jest.mock('../../src/main/services/TelemetryService', () => ({ sendFeaturePing: jest.fn() }));

const mockShells = {
  resolveShell: jest.fn(),
  openExternalTerminal: jest.fn(async () => ({ success: true })),
  detectShells: jest.fn(() => [{ id: 'fish', label: 'fish (/usr/bin/fish)', file: '/usr/bin/fish', args: [], env: { SECRET: 'x' } }]),
  defaultShellLabel: jest.fn(() => '/bin/bash'),
  detectExternalTerminals: jest.fn(() => [{ id: 'kitty', label: 'kitty', supportsProfile: false }]),
  defaultExternalTerminalId: jest.fn(() => 'kitty'),
  listWindowsTerminalProfiles: jest.fn(() => []),
};
jest.mock('../../src/main/utils/terminalShells', () => mockShells);

const { registerTerminalHandlers } = require('../../src/main/ipc/terminal.ipc');

const invoke = (channel, ...args) => mockHandlers.get(channel)({ sender: {} }, ...args);
const writeSettings = (obj) => fs.writeFileSync(mockSettingsFile, JSON.stringify(obj), 'utf8');

beforeAll(() => registerTerminalHandlers());
beforeEach(() => {
  jest.clearAllMocks();
  writeSettings({});
});
afterAll(() => { try { fs.unlinkSync(mockSettingsFile); } catch (_) {} });

describe('terminal-create and the shell setting', () => {
  const FISH = { file: '/usr/bin/fish', args: [], env: null, label: 'fish' };

  test('a shell tab gets the shell resolved from settings.json, not from the request', async () => {
    writeSettings({ terminalShell: 'fish' });
    mockShells.resolveShell.mockReturnValueOnce(FISH);
    await invoke('terminal-create', { cwd: os.tmpdir(), runClaude: false, shell: { file: '/tmp/evil', args: [] } });
    expect(mockShells.resolveShell).toHaveBeenCalledWith(expect.objectContaining({ terminalShell: 'fish' }));
    expect(mockTerminalService.create.mock.calls[0][0].shell).toBe(FISH);
  });

  test('the default setting leaves the call to the service as it always was', async () => {
    mockShells.resolveShell.mockReturnValueOnce(null);
    await invoke('terminal-create', { cwd: os.tmpdir(), runClaude: false });
    expect(mockTerminalService.create.mock.calls[0][0]).not.toHaveProperty('shell');
  });

  test('a Claude tab never reads it', async () => {
    writeSettings({ terminalShell: 'fish' });
    await invoke('terminal-create', { cwd: os.tmpdir(), runClaude: true });
    expect(mockShells.resolveShell).not.toHaveBeenCalled();
    expect(mockTerminalService.create.mock.calls[0][0]).not.toHaveProperty('shell');
  });

  test('an unreadable settings.json means the defaults, nothing more', async () => {
    fs.writeFileSync(mockSettingsFile, '{ truncated', 'utf8');
    mockShells.resolveShell.mockReturnValueOnce(null);
    const res = await invoke('terminal-create', { cwd: os.tmpdir(), runClaude: false });
    expect(res.success).toBe(true);
    expect(mockShells.resolveShell).toHaveBeenCalledWith({});
  });
});

describe('terminal-open-external', () => {
  test('opens the folder with the settings read in main', async () => {
    writeSettings({ externalTerminal: 'kitty' });
    const dir = path.resolve(os.tmpdir());
    await expect(invoke('terminal-open-external', { path: dir })).resolves.toEqual({ success: true });
    expect(mockShells.openExternalTerminal).toHaveBeenCalledWith(dir, expect.objectContaining({ externalTerminal: 'kitty' }));
  });

  test('refuses a remote project path with the capability reason, before anything else', async () => {
    const res = await invoke('terminal-open-external', { path: 'ssh-remote://abcd1234/home/me/app' });
    expect(res).toMatchObject({ success: false, code: 'REMOTE_UNSUPPORTED', reasonKey: 'ssh.disabled.openExternalTerminal' });
    expect(mockShells.openExternalTerminal).not.toHaveBeenCalled();
  });
});

describe('terminal-shell-options', () => {
  test('lists ids and labels only: no argv or environment leaves main', async () => {
    const res = await invoke('terminal-shell-options');
    expect(res.shells).toEqual([{ id: 'fish', label: 'fish (/usr/bin/fish)', file: '/usr/bin/fish' }]);
    expect(res.defaultExternalTerminal).toBe('kitty');
    expect(res.externalTerminals).toEqual([{ id: 'kitty', label: 'kitty', supportsProfile: false }]);
  });
});
