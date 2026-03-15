// Hooks IPC handler tests

const mockHooksService = {
  installHooks: jest.fn(),
  removeHooks: jest.fn(),
  areHooksInstalled: jest.fn(),
  verifyAndRepairHooks: jest.fn()
};

const mockHookEventServer = {
  start: jest.fn(),
  stop: jest.fn(),
  resolvePendingPermission: jest.fn()
};

const mockSendFeaturePing = jest.fn();

const mockBrowserWindow = {
  fromWebContents: jest.fn()
};

jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn(),
    on: jest.fn(),
    removeHandler: jest.fn()
  },
  BrowserWindow: {
    fromWebContents: (...args) => mockBrowserWindow.fromWebContents(...args)
  }
}));

jest.mock('../../src/main/services/HooksService', () => mockHooksService);
jest.mock('../../src/main/services/HookEventServer', () => mockHookEventServer);
jest.mock('../../src/main/services/TelemetryService', () => ({
  sendFeaturePing: (...args) => mockSendFeaturePing(...args)
}));

const { ipcMain } = require('electron');
const { registerHooksHandlers } = require('../../src/main/ipc/hooks.ipc');

// Collect registered handlers
const handlers = {};
const listeners = {};

beforeAll(() => {
  ipcMain.handle.mockImplementation((channel, handler) => {
    handlers[channel] = handler;
  });
  ipcMain.on.mockImplementation((channel, handler) => {
    listeners[channel] = handler;
  });
  registerHooksHandlers();
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ── hooks-install ──

describe('hooks-install', () => {
  const mockEvent = { sender: { id: 1 } };
  const mockWin = { id: 1, webContents: { id: 1 } };

  test('handler is registered', () => {
    expect(handlers['hooks-install']).toBeDefined();
  });

  test('calls HooksService.installHooks and returns result', () => {
    mockHooksService.installHooks.mockReturnValue({ success: true });
    mockBrowserWindow.fromWebContents.mockReturnValue(mockWin);

    const result = handlers['hooks-install'](mockEvent);

    expect(mockHooksService.installHooks).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true });
  });

  test('starts event server on success', () => {
    mockHooksService.installHooks.mockReturnValue({ success: true });
    mockBrowserWindow.fromWebContents.mockReturnValue(mockWin);

    handlers['hooks-install'](mockEvent);

    expect(mockHookEventServer.start).toHaveBeenCalledWith(mockWin);
    expect(mockSendFeaturePing).toHaveBeenCalledWith('hooks:install');
  });

  test('does not start event server on failure', () => {
    mockHooksService.installHooks.mockReturnValue({ success: false, error: 'File not found' });

    const result = handlers['hooks-install'](mockEvent);

    expect(result).toEqual({ success: false, error: 'File not found' });
    expect(mockHookEventServer.start).not.toHaveBeenCalled();
    expect(mockSendFeaturePing).not.toHaveBeenCalled();
  });

  test('propagates thrown errors from service', () => {
    mockHooksService.installHooks.mockImplementation(() => {
      throw new Error('Permission denied');
    });

    expect(() => handlers['hooks-install'](mockEvent)).toThrow('Permission denied');
  });
});

// ── hooks-remove ──

describe('hooks-remove', () => {
  test('handler is registered', () => {
    expect(handlers['hooks-remove']).toBeDefined();
  });

  test('calls HooksService.removeHooks and returns result', () => {
    mockHooksService.removeHooks.mockReturnValue({ success: true });

    const result = handlers['hooks-remove']();

    expect(mockHooksService.removeHooks).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true });
  });

  test('stops event server on success', () => {
    mockHooksService.removeHooks.mockReturnValue({ success: true });

    handlers['hooks-remove']();

    expect(mockHookEventServer.stop).toHaveBeenCalledTimes(1);
  });

  test('does not stop event server on failure', () => {
    mockHooksService.removeHooks.mockReturnValue({ success: false, error: 'Could not remove' });

    handlers['hooks-remove']();

    expect(mockHookEventServer.stop).not.toHaveBeenCalled();
  });

  test('propagates thrown errors from service', () => {
    mockHooksService.removeHooks.mockImplementation(() => {
      throw new Error('Unexpected error');
    });

    expect(() => handlers['hooks-remove']()).toThrow('Unexpected error');
  });
});

// ── hooks-status ──

describe('hooks-status', () => {
  test('handler is registered', () => {
    expect(handlers['hooks-status']).toBeDefined();
  });

  test('returns true when hooks are installed', () => {
    mockHooksService.areHooksInstalled.mockReturnValue(true);

    const result = handlers['hooks-status']();

    expect(result).toBe(true);
  });

  test('returns false when hooks are not installed', () => {
    mockHooksService.areHooksInstalled.mockReturnValue(false);

    const result = handlers['hooks-status']();

    expect(result).toBe(false);
  });

  test('returns detailed status object', () => {
    const status = { installed: true, valid: true, version: '1.0' };
    mockHooksService.areHooksInstalled.mockReturnValue(status);

    const result = handlers['hooks-status']();

    expect(result).toEqual(status);
  });
});

// ── hooks-verify ──

describe('hooks-verify', () => {
  test('handler is registered', () => {
    expect(handlers['hooks-verify']).toBeDefined();
  });

  test('returns valid verification result', () => {
    mockHooksService.verifyAndRepairHooks.mockReturnValue({ valid: true, repaired: false });

    const result = handlers['hooks-verify']();

    expect(result).toEqual({ valid: true, repaired: false });
  });

  test('returns repaired result when hooks were fixed', () => {
    mockHooksService.verifyAndRepairHooks.mockReturnValue({ valid: true, repaired: true, issues: ['missing hook'] });

    const result = handlers['hooks-verify']();

    expect(result.repaired).toBe(true);
    expect(result.issues).toContain('missing hook');
  });

  test('returns invalid result when hooks are broken', () => {
    mockHooksService.verifyAndRepairHooks.mockReturnValue({ valid: false, error: 'Corrupted settings' });

    const result = handlers['hooks-verify']();

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Corrupted settings');
  });

  test('propagates thrown errors from service', () => {
    mockHooksService.verifyAndRepairHooks.mockImplementation(() => {
      throw new Error('Cannot read settings');
    });

    expect(() => handlers['hooks-verify']()).toThrow('Cannot read settings');
  });
});

// ── hooks-resolve-permission ──

describe('hooks-resolve-permission', () => {
  test('listener is registered with ipcMain.on', () => {
    expect(listeners['hooks-resolve-permission']).toBeDefined();
  });

  test('calls resolvePendingPermission with requestId and decision', () => {
    mockHookEventServer.resolvePendingPermission.mockReturnValue(true);

    listeners['hooks-resolve-permission']({}, { requestId: 'req-123', decision: 'deny' });

    expect(mockHookEventServer.resolvePendingPermission).toHaveBeenCalledWith('req-123', 'deny');
  });

  test('defaults decision to allow when not provided', () => {
    mockHookEventServer.resolvePendingPermission.mockReturnValue(true);

    listeners['hooks-resolve-permission']({}, { requestId: 'req-456' });

    expect(mockHookEventServer.resolvePendingPermission).toHaveBeenCalledWith('req-456', 'allow');
  });

  test('does nothing when requestId is missing', () => {
    listeners['hooks-resolve-permission']({}, {});

    expect(mockHookEventServer.resolvePendingPermission).not.toHaveBeenCalled();
  });

  test('does nothing when requestId is empty', () => {
    listeners['hooks-resolve-permission']({}, { requestId: '' });

    expect(mockHookEventServer.resolvePendingPermission).not.toHaveBeenCalled();
  });
});
