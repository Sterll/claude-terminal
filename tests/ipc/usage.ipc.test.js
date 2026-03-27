// Usage IPC handler tests

const mockUsageService = {
  getUsageData: jest.fn(),
  refreshUsage: jest.fn(),
  startPeriodicFetch: jest.fn(),
  stopPeriodicFetch: jest.fn(),
  onUpdate: jest.fn()
};

jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn(),
    removeHandler: jest.fn()
  }
}));

jest.mock('../../src/main/services/UsageService', () => mockUsageService);

const { ipcMain } = require('electron');
const { registerUsageHandlers, setMainWindow } = require('../../src/main/ipc/usage.ipc');

const handlers = {};

beforeAll(() => {
  ipcMain.handle.mockImplementation((channel, handler) => {
    handlers[channel] = handler;
  });
  registerUsageHandlers();
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ── get-usage-data ──

describe('get-usage-data', () => {
  test('handler is registered', () => {
    expect(handlers['get-usage-data']).toBeDefined();
  });

  test('returns cached usage data', () => {
    const mockData = {
      dailyUsage: 50,
      maxDaily: 100,
      plan: 'pro',
      lastUpdated: Date.now()
    };
    mockUsageService.getUsageData.mockReturnValue(mockData);

    const result = handlers['get-usage-data']();

    expect(result).toEqual(mockData);
    expect(mockUsageService.getUsageData).toHaveBeenCalledTimes(1);
  });

  test('returns null when no usage data available', () => {
    mockUsageService.getUsageData.mockReturnValue(null);

    const result = handlers['get-usage-data']();

    expect(result).toBeNull();
  });

  test('returns empty object when service returns empty', () => {
    mockUsageService.getUsageData.mockReturnValue({});

    const result = handlers['get-usage-data']();

    expect(result).toEqual({});
  });
});

// ── refresh-usage ──

describe('refresh-usage', () => {
  test('handler is registered', () => {
    expect(handlers['refresh-usage']).toBeDefined();
  });

  test('returns success with data on successful refresh', async () => {
    const mockData = { dailyUsage: 75, maxDaily: 100 };
    mockUsageService.refreshUsage.mockResolvedValue(mockData);

    const result = await handlers['refresh-usage']();

    expect(result).toEqual({ success: true, data: mockData });
    expect(mockUsageService.refreshUsage).toHaveBeenCalledTimes(1);
  });

  test('returns error on service failure', async () => {
    mockUsageService.refreshUsage.mockRejectedValue(new Error('OAuth token expired'));

    const result = await handlers['refresh-usage']();

    expect(result).toEqual({ success: false, error: 'OAuth token expired' });
  });

  test('returns error when API is unreachable', async () => {
    mockUsageService.refreshUsage.mockRejectedValue(new Error('Network error'));

    const result = await handlers['refresh-usage']();

    expect(result).toEqual({ success: false, error: 'Network error' });
  });

  test('handles non-Error rejection gracefully', async () => {
    mockUsageService.refreshUsage.mockRejectedValue('string error');

    // The handler uses error.message, so a string rejection will have no .message
    const result = await handlers['refresh-usage']();

    expect(result.success).toBe(false);
  });
});

// ── start-usage-monitor ──

describe('start-usage-monitor', () => {
  test('handler is registered', () => {
    expect(handlers['start-usage-monitor']).toBeDefined();
  });

  test('starts periodic fetch with provided interval', () => {
    const result = handlers['start-usage-monitor']({}, 30000);

    expect(mockUsageService.startPeriodicFetch).toHaveBeenCalledWith(30000);
    expect(result).toEqual({ success: true });
  });

  test('defaults to 60000ms when no interval provided', () => {
    const result = handlers['start-usage-monitor']({}, undefined);

    expect(mockUsageService.startPeriodicFetch).toHaveBeenCalledWith(60000);
    expect(result).toEqual({ success: true });
  });

  test('defaults to 60000ms when interval is 0 (falsy)', () => {
    const result = handlers['start-usage-monitor']({}, 0);

    expect(mockUsageService.startPeriodicFetch).toHaveBeenCalledWith(60000);
    expect(result).toEqual({ success: true });
  });

  test('uses custom interval when provided', () => {
    handlers['start-usage-monitor']({}, 120000);

    expect(mockUsageService.startPeriodicFetch).toHaveBeenCalledWith(120000);
  });
});

// ── stop-usage-monitor ──

describe('stop-usage-monitor', () => {
  test('handler is registered', () => {
    expect(handlers['stop-usage-monitor']).toBeDefined();
  });

  test('stops periodic fetch', () => {
    const result = handlers['stop-usage-monitor']();

    expect(mockUsageService.stopPeriodicFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true });
  });
});

// ── setMainWindow ──

describe('setMainWindow', () => {
  test('is exported', () => {
    expect(typeof setMainWindow).toBe('function');
  });

  test('accepts a window reference', () => {
    const mockWin = { id: 1 };
    // Should not throw
    expect(() => setMainWindow(mockWin)).not.toThrow();
  });

  test('accepts null', () => {
    expect(() => setMainWindow(null)).not.toThrow();
  });
});
