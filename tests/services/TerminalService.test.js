/**
 * A PTY socket error must not be able to kill the app.
 *
 * node-pty installs its own 'error' handler on the terminal's socket, returns
 * early for EAGAIN and EIO, and for anything else rethrows — unless the
 * terminal carries a second 'error' listener (`listeners('error').length < 2`,
 * its own handler being the first). Nothing registered one, so a read error on
 * the master fd of a shell that had just exited became an uncaught exception
 * in the main process.
 *
 * On macOS that is worse than a crash with a stack: the throw lands while
 * node-pty's exit callback is still queued on an N-API ThreadSafeFunction, and
 * that dispatch then fails with a C++ Napi::Error nothing catches. The process
 * aborts through libc++abi having printed no JavaScript at all — which is
 * exactly how it surfaced, as a CI runtime smoke that died with one line of
 * libc++abi and nothing else.
 *
 * The fake PTY below reproduces node-pty's rule rather than asserting on the
 * listener count directly, so this test fails if the service stops registering
 * the listener for any reason.
 */

// Not `{ virtual: true }`: electron is installed, and a virtual mock is keyed
// on the bare name rather than the resolved path. Jest's resolver cache is
// shared by every test file in a worker and keyed on the requiring file, so
// once a module required electron here, the next file in the worker resolved
// that same require to this file's virtual id, missed its own mock and loaded
// the real electron, which downloads its binary on first require.
jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/data' },
}));

// `--rc` is decided there, and loading it pulls in the Remote Control bridge.
jest.mock('../../src/main/services/RemoteControlService', () => ({
  launchesTerminalsConnected: () => false,
}));

// Which claude a tab launches; a claude on the PATH unless a test says otherwise.
const mockClaudeLaunch = { value: { source: 'path', file: null, env: null } };
jest.mock('../../src/main/utils/claudeCode', () => ({
  resolveTerminalClaude: () => mockClaudeLaunch.value,
}));

const spawned = [];

jest.mock('node-pty', () => ({
  spawn: jest.fn(() => {
    const listeners = { error: [] };
    const pty = {
      pid: 1234,
      // node-pty's Terminal proxies .on() straight to the socket, where its own
      // error handler already sits — hence the extra listener below.
      on: (event, listener) => { (listeners[event] = listeners[event] || []).push(listener); },
      onData: jest.fn(() => ({ dispose() {} })),
      onExit: jest.fn(() => ({ dispose() {} })),
      write: jest.fn(),
      resize: jest.fn(),
      kill: jest.fn(),
      /** node-pty's own socket 'error' handler, verbatim in behaviour. */
      emitSocketError(error) {
        if (error.code && error.code.includes('EAGAIN')) return;
        if (error.code && error.code.includes('EIO')) return;
        // +1 for node-pty's own handler, which is registered before ours.
        if (listeners.error.length + 1 < 2) throw error;
        for (const listener of listeners.error) listener(error);
      },
    };
    spawned.push(pty);
    return pty;
  }),
}));

const terminalService = require('../../src/main/services/TerminalService');

beforeEach(() => {
  spawned.length = 0;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const id of [...terminalService.terminals.keys()]) terminalService.terminals.delete(id);
  jest.restoreAllMocks();
});

describe('TerminalService.create', () => {
  it('registers an error listener, so node-pty cannot rethrow a socket error', () => {
    const result = terminalService.create({ cwd: null });
    expect(result.success).toBe(true);

    const error = Object.assign(new Error('read EBADF'), { code: 'EBADF' });
    expect(() => spawned[0].emitSocketError(error)).not.toThrow();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('socket error'),
      'read EBADF'
    );
  });

  it('still lets node-pty swallow the errors it handles itself', () => {
    terminalService.create({ cwd: null });

    const eio = Object.assign(new Error('read EIO'), { code: 'EIO' });
    expect(() => spawned[0].emitSocketError(eio)).not.toThrow();
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe('TerminalService.create command override (main-process callers only)', () => {
  const pty = require('node-pty');

  it('runs the given program instead of the shell', () => {
    const result = terminalService.create({ cwd: null, command: { file: '/usr/bin/ssh', args: ['-o', 'StrictHostKeyChecking=ask', '--', 'build.example.com', 'exit'] } });
    expect(result.success).toBe(true);
    const [file, args] = pty.spawn.mock.calls[pty.spawn.mock.calls.length - 1];
    expect(file).toBe('/usr/bin/ssh');
    expect(args).toEqual(['-o', 'StrictHostKeyChecking=ask', '--', 'build.example.com', 'exit']);
  });

  it('without it, the shell argv is what it always was', () => {
    terminalService.create({ cwd: null });
    const [file, args] = pty.spawn.mock.calls[pty.spawn.mock.calls.length - 1];
    if (process.platform === 'win32') {
      expect(file).toBe('powershell.exe');
      expect(args).toEqual(['-NoLogo', '-NoProfile']);
    } else {
      expect(file).toBe(process.env.SHELL || '/bin/bash');
      expect(args).toEqual([]);
    }
  });
});

describe('TerminalService.create with a terminal-only Claude command', () => {
  const pty = require('node-pty');
  const realPlatform = process.platform;
  const setPlatform = (value) => Object.defineProperty(process, 'platform', { value, configurable: true });

  afterEach(() => {
    setPlatform(realPlatform);
    jest.useRealTimers();
  });

  it('appends the command to the claude argv on Windows', () => {
    setPlatform('win32');
    const result = terminalService.create({ cwd: null, runClaude: true, claudeCommand: '/design-login' });

    expect(result.success).toBe(true);
    const [shell, args] = pty.spawn.mock.calls.at(-1);
    expect(shell).toBe('cmd.exe');
    expect(args).toEqual(expect.arrayContaining(['/c', 'claude', '/design-login']));
    expect(args.at(-1)).toBe('/design-login');
  });

  it('types the command after claude on POSIX', () => {
    setPlatform('linux');
    jest.useFakeTimers();
    terminalService.create({ cwd: null, runClaude: true, claudeCommand: '/plugin install foo@bar' });
    jest.runAllTimers();

    expect(spawned[0].write).toHaveBeenCalledWith(expect.stringMatching(/^claude.* \/plugin install foo@bar\r$/));
  });

  it('refuses a command outside the allowlist, before spawning anything', () => {
    setPlatform('win32');
    const calls = pty.spawn.mock.calls.length;
    const result = terminalService.create({ cwd: null, runClaude: true, claudeCommand: '/model opus' });

    expect(result.success).toBe(false);
    expect(pty.spawn.mock.calls.length).toBe(calls);
  });

  it('refuses an argument a shell would read as more than a word', () => {
    setPlatform('win32');
    for (const claudeCommand of ['/login & calc', '/plugin install "x"', '/login %PATH%', '/login a|b', '/login $(id)']) {
      expect(terminalService.create({ cwd: null, runClaude: true, claudeCommand }).success).toBe(false);
    }
  });

  it('refuses a command for a plain shell', () => {
    expect(terminalService.create({ cwd: null, runClaude: false, claudeCommand: '/login' }).success).toBe(false);
  });
});

describe('TerminalService.create without Claude Code on the PATH', () => {
  const pty = require('node-pty');
  const realPlatform = process.platform;
  const setPlatform = (value) => Object.defineProperty(process, 'platform', { value, configurable: true });
  const bundled = { source: 'bundled', file: 'C:\\Program Files\\Claude Terminal\\resources\\claude.exe', env: { DISABLE_AUTOUPDATER: '1' } };

  afterEach(() => {
    setPlatform(realPlatform);
    mockClaudeLaunch.value = { source: 'path', file: null, env: null };
    jest.useRealTimers();
  });

  it('runs the SDK binary directly on Windows, with its updater off', () => {
    setPlatform('win32');
    mockClaudeLaunch.value = bundled;
    terminalService.create({ cwd: null, runClaude: true, resumeSessionId: '0f1e2d3c-aaaa' });

    const [file, args, options] = pty.spawn.mock.calls.at(-1);
    expect(file).toBe(bundled.file);
    expect(args).toEqual(['--resume', '0f1e2d3c-aaaa']);
    expect(options.env.DISABLE_AUTOUPDATER).toBe('1');
  });

  it('keeps an account overlay on top of the launch environment', () => {
    setPlatform('win32');
    mockClaudeLaunch.value = bundled;
    terminalService.create({ cwd: null, runClaude: true, accountEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/acc' } });

    const options = pty.spawn.mock.calls.at(-1)[2];
    expect(options.env).toMatchObject({ DISABLE_AUTOUPDATER: '1', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/acc' });
  });

  it('runs an npm shim found off the PATH through cmd.exe', () => {
    setPlatform('win32');
    mockClaudeLaunch.value = { source: 'install', file: 'C:\\Users\\A B\\AppData\\Roaming\\npm\\claude.cmd', env: null };
    terminalService.create({ cwd: null, runClaude: true });

    const [file, args, options] = pty.spawn.mock.calls.at(-1);
    expect(file).toBe('cmd.exe');
    expect(args).toEqual(['/c', 'C:\\Users\\A B\\AppData\\Roaming\\npm\\claude.cmd']);
    expect(options.env).toBe(process.env);
  });

  it('types the binary path, quoted, on POSIX', () => {
    setPlatform('linux');
    jest.useFakeTimers();
    mockClaudeLaunch.value = { source: 'install', file: "/home/o'neil/.local/bin/claude", env: null };
    terminalService.create({ cwd: null, runClaude: true, claudeCommand: '/login' });
    jest.runAllTimers();

    expect(spawned.at(-1).write).toHaveBeenCalledWith("'/home/o'\\''neil/.local/bin/claude' /login\r");
  });

  it('leaves a plain shell alone', () => {
    mockClaudeLaunch.value = bundled;
    terminalService.create({ cwd: null, runClaude: false });
    const options = pty.spawn.mock.calls.at(-1)[2];
    expect(options.env).toBe(process.env);
  });
});
