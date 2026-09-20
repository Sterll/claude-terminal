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

jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/data' },
}), { virtual: true });

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
