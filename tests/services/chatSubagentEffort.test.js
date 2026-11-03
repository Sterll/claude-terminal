/** @jest-environment node */
/**
 * The effort subagents run at (CLAUDE_CODE_SUBAGENT_EFFORT, CLI 2.1.316+).
 *
 * One chat setting, `chatSubagentEffort`, read by ChatService from the app's
 * settings.json at each session start; a workflow Claude step can name its
 * own level, and otherwise inherits that setting. It reaches the CLI as an
 * environment variable, which is why the remote env allowlist carries it.
 * Unset means the variable is not set at all, so subagents keep inheriting
 * the session's effort, as they did before the setting existed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const {
  SUBAGENT_EFFORT_ENV, SUBAGENT_EFFORT_LEVELS, normalizeSubagentEffort, withSubagentEffort,
} = require('../../src/shared/model-options');

const SERVICES_DIR = path.resolve(__dirname, '../../src/main/services');
const SOURCE = fs.readFileSync(path.join(SERVICES_DIR, 'ChatService.js'), 'utf8');

let dir;
let settingsFile;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-subagent-effort-'));
  settingsFile = path.join(dir, 'settings.json');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const writeAppSettings = (settings) => fs.writeFileSync(settingsFile, JSON.stringify(settings));

/** ChatService with the SDK mocked and settings.json pointed at the test's file. */
function load({ messages = null } = {}) {
  const module = { exports: {} };
  const stream = messages
    ? { async *[Symbol.asyncIterator]() { for (const m of messages) yield m; } }
    : {
      [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: async () => ({ done: true }) }; },
      initializationResult: () => Promise.resolve({ models: [] }),
      interrupt() {},
      close() {},
    };
  const query = jest.fn(() => stream);
  const mocks = {
    electron: { app: { isPackaged: false, getAppPath: () => '/mock/app' }, BrowserWindow: { getAllWindows: () => [] } },
    './ModelCatalogService': { setFetcher() {}, setCliVersion() {}, ingestInitResult() {} },
    './AccountManager': { accountEnv: jest.fn(async () => null), listAccounts: jest.fn(async () => ({ accounts: [] })), ownsLiveStore: jest.fn() },
    './ChromeBridgeService': { getSessionConfig: () => null },
    './RemoteControlService': { onSessionClosed() {} },
    './CostService': { noteSessionAccount() {}, recordAutomationRun: jest.fn(async () => null) },
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

const envOf = (query) => query.mock.calls[0][0].options.env;

describe('the shared helpers', () => {
  test('only the five level names count; anything else means not set', () => {
    expect(SUBAGENT_EFFORT_ENV).toBe('CLAUDE_CODE_SUBAGENT_EFFORT');
    for (const level of SUBAGENT_EFFORT_LEVELS) expect(normalizeSubagentEffort(level)).toBe(level);
    for (const junk of ['', null, undefined, 'inherit', 'HIGH', 'ultracode', 3, 'low; rm -rf /']) {
      expect(normalizeSubagentEffort(junk)).toBeNull();
    }
  });

  test('a level is added to a copy of the environment; no level leaves it as it was', () => {
    const env = { PATH: '/bin' };
    expect(withSubagentEffort(env, 'low')).toEqual({ PATH: '/bin', CLAUDE_CODE_SUBAGENT_EFFORT: 'low' });
    expect(env).toEqual({ PATH: '/bin' });
    expect(withSubagentEffort(env, '')).toBe(env);
    // A variable the user exported themselves is theirs, not ours to remove.
    const exported = { CLAUDE_CODE_SUBAGENT_EFFORT: 'max' };
    expect(withSubagentEffort(exported, null)).toBe(exported);
  });
});

describe('chat sessions', () => {
  test('the chat setting reaches the CLI as CLAUDE_CODE_SUBAGENT_EFFORT', async () => {
    writeAppSettings({ chatSubagentEffort: 'low' });
    const { service, query } = load();
    await service.startSession({ cwd: dir, prompt: 'hi', sessionId: 's1' });
    expect(envOf(query).CLAUDE_CODE_SUBAGENT_EFFORT).toBe('low');
  });

  test('unset, junk or no settings file: the variable is not set, subagents inherit the session', async () => {
    for (const settings of [{}, { chatSubagentEffort: '' }, { chatSubagentEffort: 'turbo' }, null]) {
      if (settings) writeAppSettings(settings); else fs.rmSync(settingsFile, { force: true });
      const { service, query } = load();
      await service.startSession({ cwd: dir, prompt: 'hi', sessionId: 's2' });
      expect(envOf(query)).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_EFFORT');
    }
  });

  test('an unreadable settings.json is survived, never thrown at the session start', async () => {
    fs.writeFileSync(settingsFile, '{ not json');
    const { service, query } = load();
    await service.startSession({ cwd: dir, prompt: 'hi', sessionId: 's3' });
    expect(envOf(query)).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_EFFORT');
  });
});

describe('workflow Claude steps', () => {
  const done = [{ type: 'result', result: 'done' }];

  test("the step's own level wins over the chat setting", async () => {
    writeAppSettings({ chatSubagentEffort: 'low' });
    const { service, query } = load({ messages: done });
    await service.runSinglePrompt({ cwd: dir, prompt: 'x', subagentEffort: 'xhigh' });
    expect(envOf(query).CLAUDE_CODE_SUBAGENT_EFFORT).toBe('xhigh');
  });

  test('a step left on inherit gets the chat setting', async () => {
    writeAppSettings({ chatSubagentEffort: 'medium' });
    const { service, query } = load({ messages: done });
    await service.runSinglePrompt({ cwd: dir, prompt: 'x', subagentEffort: '' });
    expect(envOf(query).CLAUDE_CODE_SUBAGENT_EFFORT).toBe('medium');
  });

  test('neither set: nothing is set', async () => {
    const { service, query } = load({ messages: done });
    await service.runSinglePrompt({ cwd: dir, prompt: 'x' });
    expect(envOf(query)).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_EFFORT');
  });

  test('the Claude node hands its level to runSinglePrompt, and drops one it does not know', async () => {
    const node = require('../../src/main/workflow-nodes/claude.node.js');
    expect(node.props.subagentEffort).toBe('');
    const levelFor = async (subagentEffort) => {
      const chatService = { runSinglePrompt: jest.fn(async () => ({ output: 'ok', success: true })) };
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      await node.run({ mode: 'prompt', prompt: 'hi', cwd: dir, subagentEffort }, new Map([['ctx', {}]]), null, { chatService });
      return chatService.runSinglePrompt.mock.calls[0][0].subagentEffort;
    };
    expect(await levelFor('high')).toBe('high');
    expect(await levelFor('')).toBeNull();
    expect(await levelFor(undefined)).toBeNull();
    expect(await levelFor('bogus')).toBeNull();
  });
});

describe('remote (SSH) chats', () => {
  test('the variable is on the remote env allowlist, so the host CLI gets it', () => {
    const { ENV_ALLOWLIST, buildRemoteChatScript } = require('../../src/main/utils/sshClaudeSpawn');
    expect(ENV_ALLOWLIST).toContain('CLAUDE_CODE_SUBAGENT_EFFORT');
    const script = buildRemoteChatScript({
      remotePath: '/home/u/app', claude: 'claude', args: ['--verbose'],
      env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_CODE_SUBAGENT_EFFORT: 'low', ANTHROPIC_API_KEY: 'sk-local' },
    });
    expect(script).toContain('CLAUDE_CODE_SUBAGENT_EFFORT=');
    expect(script).toContain('low');
    expect(script).not.toContain('sk-local');
  });
});
