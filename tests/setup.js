// Mock window.electron_nodeModules (used by paths.js, settings.state.js, etc.)
global.window = global.window || {};
window.electron_nodeModules = {
  path: require('path'),
  fs: {
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    mkdirSync: jest.fn(),
    copyFileSync: jest.fn(),
    renameSync: jest.fn(),
    unlinkSync: jest.fn(),
    promises: {
      readFile: jest.fn(),
      writeFile: jest.fn(),
      access: jest.fn(),
      mkdir: jest.fn(),
      copyFile: jest.fn(),
      rename: jest.fn(),
      unlink: jest.fn(),
    }
  },
  os: { homedir: () => '/mock/home' },
  process: { resourcesPath: '/mock/resources' },
  __dirname: '/mock/app'
};

// Mock window.electron_api
window.electron_api = {
  tray: { updateAccentColor: jest.fn() },
  terminal: { onExit: jest.fn(() => () => {}) }
};

// Mock requestAnimationFrame (used by State._notify)
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
