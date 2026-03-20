const { ApiProvider } = require('../../src/renderer/core/ApiProvider');

describe('ApiProvider', () => {
  const mockApi = {
    terminal: { create: jest.fn(), kill: jest.fn() },
    git: { status: jest.fn() },
    chat: { createSession: jest.fn() },
    dialog: { selectFolder: jest.fn() },
    mcp: { start: jest.fn() },
  };

  const mockNode = {
    fs: { existsSync: jest.fn() },
    path: require('path'),
    os: { homedir: () => '/mock/home' },
    process: { platform: 'win32' },
  };

  test('exposes IPC namespaces via getters', () => {
    const provider = new ApiProvider(mockApi, mockNode);
    expect(provider.terminal).toBe(mockApi.terminal);
    expect(provider.git).toBe(mockApi.git);
    expect(provider.chat).toBe(mockApi.chat);
    expect(provider.dialog).toBe(mockApi.dialog);
    expect(provider.mcp).toBe(mockApi.mcp);
  });

  test('get() returns namespace by name', () => {
    const provider = new ApiProvider(mockApi, mockNode);
    expect(provider.get('terminal')).toBe(mockApi.terminal);
    expect(provider.get('git')).toBe(mockApi.git);
  });

  test('get() returns undefined for unknown namespace', () => {
    const provider = new ApiProvider(mockApi, mockNode);
    expect(provider.get('nonexistent')).toBeUndefined();
  });

  test('exposes Node.js modules', () => {
    const provider = new ApiProvider(mockApi, mockNode);
    expect(provider.fs).toBe(mockNode.fs);
    expect(provider.path).toBe(mockNode.path);
    expect(provider.os).toBe(mockNode.os);
    expect(provider.process).toBe(mockNode.process);
  });

  test('falls back to window globals if constructor args are falsy', () => {
    // window.electron_api and window.electron_nodeModules are set in tests/setup.js
    const provider = new ApiProvider(null, null);
    expect(provider.terminal).toBe(window.electron_api.terminal);
    expect(provider.fs).toBe(window.electron_nodeModules.fs);
  });
});
