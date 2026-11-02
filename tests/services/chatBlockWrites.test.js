/** @jest-environment node */
/**
 * "Refuse file writes outside the project" (chatBlockWritesOutsideCwd).
 *
 * Off by default. On, a chat session gets
 * permissions.blockWritesOutsideWorkingDirectories in the SDK's flag
 * settings layer (CLI 2.1.314+), which the SDK hands to the CLI as inline
 * `--settings` JSON, so a remote CLI receives it the same way. Checked
 * against the real CLI 2.1.316 when it was added: in bypass mode a Write
 * outside the working directory is refused, one inside goes through, and
 * EnterWorktree leaves the toolset.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const SERVICES_DIR = path.resolve(__dirname, '../../src/main/services');
const SOURCE = fs.readFileSync(path.join(SERVICES_DIR, 'ChatService.js'), 'utf8');

let dir;
let settingsFile;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-block-writes-'));
  settingsFile = path.join(dir, 'settings.json');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const writeAppSettings = (settings) => fs.writeFileSync(settingsFile, JSON.stringify(settings));

/** ChatService with the SDK mocked and settings.json pointed at the test's file. */
function load() {
  const module = { exports: {} };
  const stream = {
    [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: async () => ({ done: true }) }; },
    initializationResult: () => Promise.resolve({ models: [] }),
    interrupt() {},
    close() {},
  };
  const query = jest.fn(() => stream);
  const mocks = {
    electron: { app: { isPackaged: false, getAppPath: () => '/mock/app' }, BrowserWindow: { getAllWindows: () => [] } },
    './ModelCatalogService': { setFetcher() {}, setCliVersion() {}, ingestInitResult() {} },
    './AccountManager': { accountEnv: jest.fn(async () => null), listAccounts: jest.fn(async () => ({ accounts: [] })) },
    './ChromeBridgeService': { getSessionConfig: () => null },
    './RemoteControlService': { onSessionClosed() {} },
    './CostService': { noteSessionAccount() {} },
    '../utils/sdkCli': { getSdkCliPath: () => '/fake/claude', getSdkCliVersion: () => null },
    '../utils/paths': { settingsFile },
  };
  const ctx = {
    module, exports: module.exports,
    require: (name) => {
      if (name in mocks) return mocks[name];
      if (name.startsWith('.')) return require(path.resolve(SERVICES_DIR, name));
      return require(name);
    },
    process: { env: { PATH: '/bin', HOME: '/home/local' }, platform: process.platform, on() {}, removeListener() {} },
    AbortController, console: { ...console, error() {}, warn() {}, log() {} },
    setTimeout, clearTimeout, setImmediate, Buffer,
  };
  vm.runInNewContext(
    `${SOURCE}\nmodule.exports.__inject = (sdk) => { sdkPromise = Promise.resolve(sdk); resolvedRuntime = { executable: 'node', pathDir: null }; };`,
    ctx, { filename: 'ChatService.js' }
  );
  module.exports.__inject({ query });
  const service = module.exports;
  service._send = () => {};
  service._emitEvent = () => {};
  service._emitLifecycle = () => {};
  return { service, query };
}

async function optionsFor(appSettings, start = {}) {
  if (appSettings) writeAppSettings(appSettings);
  const { service, query } = load();
  await service.startSession({ cwd: dir, prompt: 'hi', sessionId: 's1', ...start });
  return query.mock.calls[0][0].options;
}

const BLOCK = { permissions: { blockWritesOutsideWorkingDirectories: true } };

test('on: the session gets the CLI setting in its flag layer', async () => {
  expect((await optionsFor({ chatBlockWritesOutsideCwd: true })).settings).toEqual(BLOCK);
});

test('off, unset, not exactly true, or no settings file: nothing is added', async () => {
  for (const settings of [{ chatBlockWritesOutsideCwd: false }, {}, { chatBlockWritesOutsideCwd: 'true' }, null]) {
    fs.rmSync(settingsFile, { force: true });
    expect(await optionsFor(settings)).not.toHaveProperty('settings');
  }
});

test("it sits beside the context handoff's compaction window, neither replacing the other", async () => {
  const options = await optionsFor({ chatBlockWritesOutsideCwd: true }, { autoCompactWindow: 550000 });
  expect(options.settings).toEqual({ autoCompactWindow: 550000, ...BLOCK });
});

test('whatever the permission mode, bypass included', async () => {
  const options = await optionsFor({ chatBlockWritesOutsideCwd: true }, { permissionMode: 'bypassPermissions' });
  expect(options.permissionMode).toBe('bypassPermissions');
  expect(options.settings).toEqual(BLOCK);
});
