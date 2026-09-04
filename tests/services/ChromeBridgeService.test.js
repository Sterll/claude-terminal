// ChromeBridgeService unit tests — "Claude in Chrome" browser integration.
//
// Strategy: point the service at a real temp directory (via a fake homedir and
// a mocked paths module) and let it do real file I/O. The behaviour that
// matters here is all filesystem shaped — which manifest gets written, which
// one is adopted, which one is left alone — so a virtual fs would mostly be
// testing the mock.

const fs = require('fs');
const path = require('path');
const os = require('os');

// The service destructures `dataDir`/`settingsFile` from paths at require time,
// so the temp home has to exist and be fixed before the require below — hence a
// single root for the file, wiped between tests rather than recreated.
const mockTmpHome = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ct-chrome-'));
const mockDataDir = path.join(mockTmpHome, '.claude-terminal');
const mockSettingsFile = path.join(mockDataDir, 'settings.json');

// The service derives every browser path from os.homedir() at call time.
jest.mock('os', () => {
  const realOs = jest.requireActual('os');
  return { ...realOs, homedir: jest.fn(() => realOs.homedir()) };
});

jest.mock('../../src/main/utils/paths', () => ({
  dataDir: mockDataDir,
  settingsFile: mockSettingsFile
}));

// The Windows branch shells out to `reg`; nothing here should touch the registry.
jest.mock('child_process', () => ({
  execFile: jest.fn((cmd, args, cb) => cb && cb(null, '', ''))
}));

// sdkCli pulls in electron; the tests only care about the path it returns.
jest.mock('../../src/main/utils/sdkCli', () => ({
  getSdkCliPath: jest.fn(() => global.__ctCliPath)
}));

const { getSdkCliPath } = require('../../src/main/utils/sdkCli');
const service = require('../../src/main/services/ChromeBridgeService');
const { HOST_NAME, EXTENSION_ID, MCP_SERVER_NAME } = service;

// macOS layout is used throughout so the assertions are identical on every CI
// runner; the Windows-specific branches are exercised explicitly.
const ORIGINAL_PLATFORM = process.platform;
function setPlatform(value) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

/** Native messaging dir Chrome would read on macOS. */
function chromeHostDir() {
  return path.join(mockTmpHome, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
}

/** Make a browser look installed: the service only wires up browsers it finds. */
function installBrowser(...segments) {
  fs.mkdirSync(path.join(mockTmpHome, ...segments), { recursive: true });
}

function installChrome() {
  installBrowser('Library', 'Application Support', 'Google', 'Chrome');
}

function installBrave() {
  installBrowser('Library', 'Application Support', 'BraveSoftware', 'Brave-Browser');
}

/** Profile dir we plant the extension in. */
function chromeProfileDir(profile = 'Default') {
  return path.join(mockTmpHome, 'Library', 'Application Support', 'Google', 'Chrome', profile);
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${HOST_NAME}.json`), 'utf8'));
}

beforeEach(() => {
  // Wipe everything the previous test planted, keeping the root path stable.
  for (const entry of fs.readdirSync(mockTmpHome)) {
    fs.rmSync(path.join(mockTmpHome, entry), { recursive: true, force: true });
  }
  fs.mkdirSync(mockDataDir, { recursive: true });

  // An executable stand-in for the bundled Claude Code binary.
  const cli = path.join(mockTmpHome, 'claude');
  fs.writeFileSync(cli, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(cli, 0o755);
  global.__ctCliPath = cli;
  getSdkCliPath.mockImplementation(() => global.__ctCliPath);

  os.homedir.mockReturnValue(mockTmpHome);
  setPlatform('darwin');

  // The singleton memoises detection and host installation across calls.
  service._detection = null;
  service._detectionAt = 0;
  service._hostReady = null;
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
});

afterAll(() => {
  fs.rmSync(mockTmpHome, { recursive: true, force: true });
});

describe('ChromeBridgeService — enablement', () => {
  test('is disabled when settings.json is absent', () => {
    expect(service.isEnabled()).toBe(false);
  });

  test('is disabled unless the flag is explicitly true', () => {
    writeJson(mockSettingsFile, { chromeBridgeEnabled: false });
    expect(service.isEnabled()).toBe(false);
    writeJson(mockSettingsFile, {});
    expect(service.isEnabled()).toBe(false);
    // A truthy non-boolean must not count — the setting is written by a checkbox.
    writeJson(mockSettingsFile, { chromeBridgeEnabled: 'yes' });
    expect(service.isEnabled()).toBe(false);
  });

  test('is enabled when the flag is true', () => {
    writeJson(mockSettingsFile, { chromeBridgeEnabled: true });
    expect(service.isEnabled()).toBe(true);
  });

  test('survives a corrupt settings file', () => {
    fs.writeFileSync(mockSettingsFile, '{ not json', 'utf8');
    expect(service.isEnabled()).toBe(false);
  });
});

describe('ChromeBridgeService — extension detection', () => {
  test('reports the browser hosting the extension', async () => {
    fs.mkdirSync(path.join(chromeProfileDir(), 'Extensions', EXTENSION_ID), { recursive: true });
    const res = await service.detectExtension(true);
    expect(res).toEqual({ installed: true, browser: 'chrome', label: 'Google Chrome' });
  });

  test('finds the extension in a secondary profile', async () => {
    fs.mkdirSync(path.join(chromeProfileDir('Profile 3'), 'Extensions', EXTENSION_ID), { recursive: true });
    const res = await service.detectExtension(true);
    expect(res.installed).toBe(true);
  });

  test('ignores directories that are not Chrome profiles', async () => {
    fs.mkdirSync(path.join(chromeProfileDir('ShaderCache'), 'Extensions', EXTENSION_ID), { recursive: true });
    const res = await service.detectExtension(true);
    expect(res.installed).toBe(false);
  });

  test('reports absent when no browser has it', async () => {
    fs.mkdirSync(path.join(chromeProfileDir(), 'Extensions', 'someotherextension'), { recursive: true });
    const res = await service.detectExtension(true);
    expect(res).toEqual({ installed: false, browser: null, label: null });
  });

  test('caches results until forced', async () => {
    expect((await service.detectExtension(true)).installed).toBe(false);
    fs.mkdirSync(path.join(chromeProfileDir(), 'Extensions', EXTENSION_ID), { recursive: true });
    expect((await service.detectExtension()).installed).toBe(false);
    expect((await service.detectExtension(true)).installed).toBe(true);
  });
});

describe('ChromeBridgeService — native host installation', () => {
  test('installs a manifest and an executable wrapper when none exists', async () => {
    installChrome();
    const res = await service.ensureNativeHost();

    expect(res.ok).toBe(true);
    expect(res.adopted).toEqual([]);
    expect(res.installed).toContain('chrome');

    const manifest = readManifest(chromeHostDir());
    expect(manifest.name).toBe(HOST_NAME);
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${EXTENSION_ID}/`]);

    // Chrome execs the manifest's `path` directly, so it has to exist and run.
    expect(fs.existsSync(manifest.path)).toBe(true);
    expect(fs.readFileSync(manifest.path, 'utf8')).toContain('--chrome-native-host');
    fs.accessSync(manifest.path, fs.constants.X_OK);
  });

  test('adopts a working Claude Code manifest instead of overwriting it', async () => {
    // The host name is fixed by the extension, so both apps compete for one
    // file. Clobbering it would break the other install.
    const foreignHost = path.join(mockTmpHome, 'foreign-host');
    fs.writeFileSync(foreignHost, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(foreignHost, 0o755);
    const existing = {
      name: HOST_NAME,
      description: 'Claude Code Browser Extension Native Host',
      path: foreignHost,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
    };
    installChrome();
    writeJson(path.join(chromeHostDir(), `${HOST_NAME}.json`), existing);

    const res = await service.ensureNativeHost();

    expect(res.ok).toBe(true);
    expect(res.adopted).toEqual(['chrome']);
    expect(res.installed).toEqual([]);
    expect(readManifest(chromeHostDir())).toEqual(existing);
    // Nothing of ours was written either.
    expect(fs.existsSync(service._wrapperPath())).toBe(false);
  });

  test('replaces a manifest whose target no longer exists', async () => {
    installChrome();
    writeJson(path.join(chromeHostDir(), `${HOST_NAME}.json`), {
      name: HOST_NAME,
      path: path.join(mockTmpHome, 'uninstalled', 'claude'),
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
    });

    const res = await service.ensureNativeHost();

    expect(res.installed).toEqual(['chrome']);
    expect(readManifest(chromeHostDir()).path).toBe(service._wrapperPath());
  });

  test('replaces a manifest that does not allow the extension', async () => {
    installChrome();
    writeJson(path.join(chromeHostDir(), `${HOST_NAME}.json`), {
      name: HOST_NAME,
      path: global.__ctCliPath,
      type: 'stdio',
      allowed_origins: ['chrome-extension://unrelatedextensionid/']
    });

    const res = await service.ensureNativeHost();

    expect(res.installed).toEqual(['chrome']);
    expect(readManifest(chromeHostDir()).allowed_origins)
      .toEqual([`chrome-extension://${EXTENSION_ID}/`]);
  });

  test('fails cleanly when the bundled binary is missing', async () => {
    installChrome();
    global.__ctCliPath = null;
    const res = await service.ensureNativeHost();
    expect(res).toMatchObject({ ok: false, error: 'sdk-cli-missing' });
  });

  test('reports no-browser-found when no Chromium browser is present', async () => {
    const res = await service.ensureNativeHost();
    expect(res).toMatchObject({ ok: false, error: 'no-browser-found' });
  });

  test('leaves alone the config directories of browsers that are not installed', async () => {
    installChrome();
    await service.ensureNativeHost();
    // Creating a Vivaldi config dir on a machine with no Vivaldi is litter
    // nothing will ever read.
    const vivaldi = path.join(mockTmpHome, 'Library', 'Application Support', 'Vivaldi');
    expect(fs.existsSync(vivaldi)).toBe(false);
  });

  test('installs for a second browser even when the first was adopted', async () => {
    // Per-browser decision: a manifest Claude Code left in Chrome says nothing
    // about Brave, which still needs ours.
    installChrome();
    installBrave();
    const foreignHost = path.join(mockTmpHome, 'foreign-host');
    fs.writeFileSync(foreignHost, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(foreignHost, 0o755);
    writeJson(path.join(chromeHostDir(), `${HOST_NAME}.json`), {
      name: HOST_NAME,
      path: foreignHost,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
    });

    const res = await service.ensureNativeHost();

    expect(res.adopted).toEqual(['chrome']);
    expect(res.installed).toEqual(['brave']);
    const braveDir = path.join(mockTmpHome, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts');
    expect(readManifest(braveDir).path).toBe(service._wrapperPath());
  });

  test('is memoised across calls', async () => {
    installChrome();
    const first = await service.ensureNativeHost();
    fs.rmSync(path.join(chromeHostDir(), `${HOST_NAME}.json`));
    const second = await service.ensureNativeHost();
    expect(second).toBe(first);
    // Forcing redoes the work.
    const third = await service.ensureNativeHost(true);
    expect(third.ok).toBe(true);
    expect(fs.existsSync(path.join(chromeHostDir(), `${HOST_NAME}.json`))).toBe(true);
  });

  test('writes a .bat wrapper on Windows', async () => {
    setPlatform('win32');
    process.env.LOCALAPPDATA = path.join(mockTmpHome, 'AppData', 'Local');
    fs.mkdirSync(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data'), { recursive: true });
    const res = await service.ensureNativeHost();
    expect(res.ok).toBe(true);
    expect(service._wrapperPath().endsWith('.bat')).toBe(true);
    expect(fs.readFileSync(service._wrapperPath(), 'utf8')).toContain('--chrome-native-host');
  });
});

describe('ChromeBridgeService — native host removal', () => {
  test('removes a manifest we installed', async () => {
    installChrome();
    await service.ensureNativeHost();
    expect(fs.existsSync(path.join(chromeHostDir(), `${HOST_NAME}.json`))).toBe(true);

    const res = await service.removeNativeHost();

    expect(res.removed).toContain('chrome');
    expect(fs.existsSync(path.join(chromeHostDir(), `${HOST_NAME}.json`))).toBe(false);
  });

  test('keeps a manifest owned by Claude Code', async () => {
    // Disabling our toggle must not disable the other install.
    installChrome();
    writeJson(path.join(chromeHostDir(), `${HOST_NAME}.json`), {
      name: HOST_NAME,
      path: path.join(mockTmpHome, '.claude', 'chrome', 'chrome-native-host'),
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
    });

    const res = await service.removeNativeHost();

    expect(res.removed).toEqual([]);
    expect(res.kept).toContain('chrome');
    expect(fs.existsSync(path.join(chromeHostDir(), `${HOST_NAME}.json`))).toBe(true);
  });

  test('drops the Windows registry keys along with the manifest', async () => {
    const { execFile } = require('child_process');
    setPlatform('win32');
    process.env.LOCALAPPDATA = path.join(mockTmpHome, 'AppData', 'Local');
    fs.mkdirSync(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data'), { recursive: true });
    await service.ensureNativeHost();
    execFile.mockClear();

    const res = await service.removeNativeHost();

    expect(res.removed).toContain('windows');
    // A key outliving its manifest would point Chrome at a missing file.
    const deletes = execFile.mock.calls.filter(c => c[1][0] === 'delete');
    expect(deletes.length).toBeGreaterThan(0);
  });

  test('is a no-op when nothing is installed', async () => {
    await expect(service.removeNativeHost()).resolves.toEqual({ removed: [], kept: [] });
  });
});

describe('ChromeBridgeService — session wiring', () => {
  test('contributes nothing while disabled', () => {
    writeJson(mockSettingsFile, { chromeBridgeEnabled: false });
    expect(service.getSessionConfig()).toBeNull();
  });

  test('contributes the MCP server and a system prompt when enabled', () => {
    writeJson(mockSettingsFile, { chromeBridgeEnabled: true });
    const cfg = service.getSessionConfig();

    expect(cfg.mcpServers[MCP_SERVER_NAME]).toEqual({
      type: 'stdio',
      command: global.__ctCliPath,
      args: ['--claude-in-chrome-mcp']
    });
    // The ordering constraint is the one thing the tool descriptions don't state.
    expect(cfg.systemPrompt).toContain('tabs_context_mcp');
  });

  test('contributes nothing when the bundled binary is missing', () => {
    writeJson(mockSettingsFile, { chromeBridgeEnabled: true });
    global.__ctCliPath = null;
    expect(service.getSessionConfig()).toBeNull();
  });

  test('contributes nothing on an unsupported platform', () => {
    writeJson(mockSettingsFile, { chromeBridgeEnabled: true });
    setPlatform('aix');
    expect(service.getSessionConfig()).toBeNull();
  });
});

describe('ChromeBridgeService — status', () => {
  test('surfaces a missing extension without claiming the host works', async () => {
    writeJson(mockSettingsFile, { chromeBridgeEnabled: false });
    const st = await service.getStatus(true);
    expect(st).toMatchObject({
      supported: true,
      enabled: false,
      cliAvailable: true,
      extensionInstalled: false,
      hostInstalled: false
    });
  });

  test('reports the browser and host once everything is in place', async () => {
    writeJson(mockSettingsFile, { chromeBridgeEnabled: true });
    fs.mkdirSync(path.join(chromeProfileDir(), 'Extensions', EXTENSION_ID), { recursive: true });

    const st = await service.getStatus(true);

    expect(st).toMatchObject({
      supported: true,
      enabled: true,
      extensionInstalled: true,
      browser: 'chrome',
      browserLabel: 'Google Chrome',
      hostInstalled: true
    });
  });

  test('reports unsupported platforms without touching the disk', async () => {
    setPlatform('aix');
    const st = await service.getStatus(true);
    expect(st.supported).toBe(false);
    expect(st.extensionInstalled).toBe(false);
  });
});
