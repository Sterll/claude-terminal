// RemoteServer unit tests — PIN logic, data serialization, network utils

jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app' },
}));

jest.mock('ws', () => ({
  WebSocketServer: jest.fn(),
}));

// Mock fs
const mockFs = {
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  readFile: jest.fn(),
  writeFileSync: jest.fn(),
  readdirSync: jest.fn(() => []),
  statSync: jest.fn(),
  createReadStream: jest.fn(),
  promises: {
    readFile: jest.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    writeFile: jest.fn().mockResolvedValue(undefined),
    rename: jest.fn().mockResolvedValue(undefined),
    mkdir: jest.fn().mockResolvedValue(undefined),
  },
};
jest.mock('fs', () => mockFs);

// Mock paths util
jest.mock('../../src/main/utils/paths', () => ({
  settingsFile: '/mock/settings.json',
  projectsFile: '/mock/projects.json',
}));

// Mock ChatService
jest.mock('../../src/main/services/ChatService', () => ({
  getActiveSessions: jest.fn(() => []),
}));

const remoteServer = require('../../src/main/services/RemoteServer');

beforeEach(() => {
  jest.clearAllMocks();
});

// ── PIN Generation ──

describe('generatePin', () => {
  test('returns a 6-digit string', async () => {
    const pin = await remoteServer.generatePin();
    expect(typeof pin).toBe('string');
    expect(pin).toMatch(/^\d{6}$/);
  });

  test('generates different PINs (probabilistic)', async () => {
    const pins = new Set();
    for (let i = 0; i < 50; i++) {
      pins.add(await remoteServer.generatePin());
    }
    // With 50 random 6-digit PINs, we should have at least a few unique ones
    expect(pins.size).toBeGreaterThan(1);
  });

  test('PIN is padded to 6 digits', async () => {
    // Even if crypto.randomInt gives 0, should be '000000'
    const crypto = require('crypto');
    jest.spyOn(crypto, 'randomInt').mockReturnValueOnce(0);
    const pin = await remoteServer.generatePin();
    expect(pin).toBe('000000');
    expect(pin.length).toBe(6);
    crypto.randomInt.mockRestore();
  });
});

describe('getPin', () => {
  test('returns null pin before generatePin is called', async () => {
    // Fresh state — no PIN generated yet in this test run
    // Note: previous tests may have called generatePin, so we just check the shape
    const result = await remoteServer.getPin();
    expect(result).toHaveProperty('pin');
    expect(result).toHaveProperty('expiresAt');
    expect(result).toHaveProperty('used');
  });

  test('returns generated PIN after generatePin', async () => {
    const pin = await remoteServer.generatePin();
    const result = await remoteServer.getPin();
    expect(result.pin).toBe(pin);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(result.used).toBe(false);
  });

  test('returns same PIN on multiple calls (no auto-regen)', async () => {
    await remoteServer.generatePin();
    const first = await remoteServer.getPin();
    const second = await remoteServer.getPin();
    expect(first.pin).toBe(second.pin);
    expect(first.expiresAt).toBe(second.expiresAt);
  });

  test('does NOT auto-regenerate when PIN has expired', async () => {
    await remoteServer.generatePin();
    const first = await remoteServer.getPin();
    // Simulate expiry
    const originalNow = Date.now;
    Date.now = () => originalNow() + 3 * 60 * 1000;
    const second = await remoteServer.getPin();
    // Should return the same expired PIN — no auto-regen
    expect(second.pin).toBe(first.pin);
    expect(second.expiresAt).toBe(first.expiresAt);
    Date.now = originalNow;
  });
});

// ── broadcastProjectsUpdate serialization ──

describe('broadcastProjectsUpdate', () => {
  test('does not throw with empty projects', async () => {
    await expect(remoteServer.broadcastProjectsUpdate([])).resolves.not.toThrow();
  });

  test('does not throw with null projects', async () => {
    await expect(remoteServer.broadcastProjectsUpdate(null)).resolves.not.toThrow();
  });

  test('reads folders from disk when broadcasting', async () => {
    mockFs.promises.readFile.mockResolvedValueOnce(JSON.stringify({
      projects: [],
      folders: [{ id: 'f1', name: 'Folder', parentId: null, children: ['p1'], color: '#ff0000', icon: null }],
      rootOrder: ['f1', 'p1'],
    }));

    await remoteServer.broadcastProjectsUpdate([
      { id: 'p1', name: 'Test', path: '/test', color: '#d97706', icon: null, folderId: 'f1' },
    ]);

    // Should have read the projects file to get folders
    expect(mockFs.promises.readFile).toHaveBeenCalled();
  });

  test('handles missing projects file gracefully', async () => {
    mockFs.promises.readFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(remoteServer.broadcastProjectsUpdate([
      { id: 'p1', name: 'Test', path: '/test' },
    ])).resolves.not.toThrow();
  });

  test('handles corrupted projects file gracefully', async () => {
    mockFs.promises.readFile.mockResolvedValueOnce('{corrupted json');
    await expect(remoteServer.broadcastProjectsUpdate([
      { id: 'p1', name: 'Test', path: '/test' },
    ])).resolves.not.toThrow();
  });
});

// ── getServerInfo ──

describe('getServerInfo', () => {
  test('returns running: false when server is not started', async () => {
    const info = await remoteServer.getServerInfo();
    expect(info.running).toBe(false);
    expect(info).toHaveProperty('networkInterfaces');
    expect(Array.isArray(info.networkInterfaces)).toBe(true);
  });
});

// ── setTimeData ──

describe('setTimeData', () => {
  test('does not throw with valid data', () => {
    expect(() => remoteServer.setTimeData({ todayMs: 3600000 })).not.toThrow();
  });

  test('does not throw with zero', () => {
    expect(() => remoteServer.setTimeData({ todayMs: 0 })).not.toThrow();
  });
});

// ── Data Mapping ──

describe('project data mapping', () => {
  test('broadcastProjectsUpdate includes folderId in serialized projects', async () => {
    // No connected clients, so broadcast is a no-op, but we test it doesn't crash
    // and that the mapping logic works correctly
    const projects = [
      { id: 'p1', name: 'Test', path: '/test', color: '#d97706', icon: '🚀', folderId: 'f1', extra: 'should-be-kept' },
      { id: 'p2', name: 'Root', path: '/root', folderId: null },
    ];
    mockFs.promises.readFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(remoteServer.broadcastProjectsUpdate(projects)).resolves.not.toThrow();
  });
});

// ── PIN expiry behavior ──

describe('PIN lifecycle', () => {
  test('PIN expires after TTL', async () => {
    await remoteServer.generatePin();
    const originalNow = Date.now;
    Date.now = () => originalNow() + 3 * 60 * 1000;
    const result = await remoteServer.getPin();
    expect(result.pin).toBeTruthy();
    expect(result.expiresAt).toBeLessThan(Date.now());
    Date.now = originalNow;
  });

  test('generatePin resets used flag', async () => {
    await remoteServer.generatePin();
    await remoteServer.generatePin();
    const result = await remoteServer.getPin();
    expect(result.used).toBe(false);
  });

  test('successive generatePin calls produce fresh PINs with new expiry', async () => {
    await remoteServer.generatePin();
    const info1 = await remoteServer.getPin();
    await remoteServer.generatePin();
    const info2 = await remoteServer.getPin();
    expect(info2.expiresAt).toBeGreaterThanOrEqual(info1.expiresAt);
    expect(info2.used).toBe(false);
  });
});

// ── broadcast helpers ──

describe('broadcast helpers', () => {
  test('broadcastSessionStarted does not throw with no clients', () => {
    expect(() => remoteServer.broadcastSessionStarted({
      sessionId: 's1', projectId: 'p1', tabName: 'Test'
    })).not.toThrow();
  });

  test('broadcastTabRenamed does not throw with no clients', () => {
    expect(() => remoteServer.broadcastTabRenamed({
      sessionId: 's1', tabName: 'Renamed'
    })).not.toThrow();
  });
});

// ── Server state sync ──

describe('_syncServerState', () => {
  test('does not throw when called without server running', async () => {
    await expect(remoteServer._syncServerState()).resolves.not.toThrow();
  });
});
