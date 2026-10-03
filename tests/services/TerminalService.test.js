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
