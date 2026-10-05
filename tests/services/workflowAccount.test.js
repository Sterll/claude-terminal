/** @jest-environment node */
/**
 * Which Claude account an automation runs as.
 *
 * A Claude step carries an `account` property: '' is the default account (the
 * machine-wide login, which is what every run used before the choice
 * existed), PROJECT_ACCOUNT is the target project's binding, anything else an
 * account id. These tests pin the three halves of that: the task compiler
 * carries the choice into the graph, the Claude node resolves it against
 * projects.json, and runSinglePrompt applies the account's credential store —
 * refusing, rather than quietly falling back, an account that is gone.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { normalizeSimple, compileTask, PROJECT_ACCOUNT } = require('../../src/shared/simple-task');

let home;
let boundDir;
let unboundDir;

function writeProjects() {
  fs.mkdirSync(path.join(home, '.claude-terminal'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude-terminal', 'projects.json'), JSON.stringify({
    projects: [
      { id: 'bound', name: 'Bound', path: boundDir, type: 'general', accountId: 'acc-work' },
      { id: 'unbound', name: 'Unbound', path: unboundDir, type: 'general' },
    ],
  }));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-wf-account-'));
  boundDir = path.join(home, 'bound');
  unboundDir = path.join(home, 'unbound');
  fs.mkdirSync(path.join(boundDir, 'sub'), { recursive: true });
  fs.mkdirSync(unboundDir, { recursive: true });
  jest.spyOn(os, 'homedir').mockReturnValue(home);
  writeProjects();
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the task compiler', () => {
  test('a task saved before the choice existed runs on the default account', () => {
    expect(normalizeSimple({ prompt: 'x' }).account).toBe('');
  });

  test('the choice reaches the Claude node of the generated graph', () => {
    const wf = compileTask({ name: 'T', simple: { prompt: 'x', account: PROJECT_ACCOUNT } });
    const claude = wf.graph.nodes.find(n => n.type === 'workflow/claude');
    expect(claude.properties.account).toBe(PROJECT_ACCOUNT);
    expect(wf.steps.find(s => s.type === 'claude').account).toBe(PROJECT_ACCOUNT);
  });
});

describe('the Claude node', () => {
  const claude = () => require('../../src/main/workflow-nodes/claude.node.js');
  const vars = (extra = {}) => new Map([['ctx', {}], ...Object.entries(extra)]);

  async function accountFor(config, v = vars()) {
    const chatService = { runSinglePrompt: jest.fn(async () => ({ output: 'ok', success: true })) };
    await claude().run({ mode: 'prompt', prompt: 'hi', ...config }, v, null, { chatService });
    return chatService.runSinglePrompt.mock.calls[0][0].accountId;
  }

  test('the default account is the machine-wide login', async () => {
    expect(await accountFor({ projectId: 'bound', account: '' })).toBeNull();
    expect(await accountFor({ projectId: 'bound' })).toBeNull();
  });

  test("the project's account follows the project's binding", async () => {
    expect(await accountFor({ projectId: 'bound', account: PROJECT_ACCOUNT })).toBe('acc-work');
    expect(await accountFor({ cwd: boundDir, account: PROJECT_ACCOUNT })).toBe('acc-work');
  });

  test('a subfolder belongs to the project above it', async () => {
    expect(await accountFor({ cwd: path.join(boundDir, 'sub'), account: PROJECT_ACCOUNT })).toBe('acc-work');
  });

  test('"run where it fired" uses the binding of the project that fired', async () => {
    const v = vars({ trigger: { projectPath: boundDir } });
    expect(await accountFor({ cwd: '$trigger.projectPath', account: PROJECT_ACCOUNT }, v)).toBe('acc-work');
  });

  test('an unbound project falls back to the default account', async () => {
    expect(await accountFor({ projectId: 'unbound', account: PROJECT_ACCOUNT })).toBeNull();
  });

  test('a named account is passed through as is', async () => {
    expect(await accountFor({ projectId: 'unbound', account: 'acc-perso' })).toBe('acc-perso');
  });

  test('a project folder that went missing still resolves to that project, not to $HOME', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    fs.rmSync(boundDir, { recursive: true, force: true });
    expect(await accountFor({ projectId: 'bound', cwd: boundDir, account: PROJECT_ACCOUNT })).toBe('acc-work');
  });
});

describe('runSinglePrompt', () => {
  const SERVICES_DIR = path.resolve(__dirname, '../../src/main/services');
  const SOURCE = fs.readFileSync(path.join(SERVICES_DIR, 'ChatService.js'), 'utf8');

  /** ChatService with the SDK and AccountManager mocked; returns the options handed to query(). */
  function load(accountManager, { messages = [{ type: 'result', result: 'done' }], costService = { recordAutomationRun: jest.fn(async () => null) } } = {}) {
    const module = { exports: {} };
    const query = jest.fn(() => ({ async *[Symbol.asyncIterator]() { for (const m of messages) yield m; } }));
    const mocks = {
      electron: { app: { isPackaged: false, getAppPath: () => '/mock/app' }, BrowserWindow: { getAllWindows: () => [] } },
      './ModelCatalogService': { setFetcher() {}, setCliVersion() {} },
      './AccountManager': accountManager,
      './CostService': costService,
      './ChromeBridgeService': { getSessionConfig: () => null },
      './RemoteControlService': { onSessionClosed() {} },
      '../utils/sdkCli': { getSdkCliPath: () => '/fake/claude', getSdkCliVersion: () => null },
    };
    const ctx = {
      module, exports: module.exports,
      require: (name) => {
        if (name in mocks) return mocks[name];
        if (name.startsWith('.')) return require(path.resolve(SERVICES_DIR, name));
        return require(name);
      },
      process: { env: { PATH: '/bin' }, platform: process.platform, on() {}, removeListener() {} },
      AbortController, console: { ...console, error() {}, warn() {}, log() {} },
      setTimeout, clearTimeout, setImmediate, Buffer,
    };
    vm.runInNewContext(
      `${SOURCE}\nmodule.exports.__inject = (sdk) => { sdkPromise = Promise.resolve(sdk); resolvedRuntime = { executable: 'node', pathDir: null }; };`,
      ctx, { filename: 'ChatService.js' }
    );
    module.exports.__inject({ query });
    return { service: module.exports, query };
  }

  const accounts = [{ id: 'acc-work', name: 'Work' }];

  test('an automation step reports its account, is priced, then its session is deleted', async () => {
    const { encodeProjectPath } = require('../../src/shared/session-dirs');
    const sessionId = 'aaaa-1111';
    const base = path.join(home, '.claude', 'projects', encodeProjectPath(boundDir));
    fs.mkdirSync(path.join(base, sessionId, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(base, `${sessionId}.jsonl`), '{}\n');
    fs.writeFileSync(path.join(base, sessionId, 'subagents', 'agent-1.jsonl'), '{}\n');

    const am = { listAccounts: jest.fn(async () => ({ accounts, liveId: 'acc-live' })), accountEnv: jest.fn(), ownsLiveStore: jest.fn() };
    const costService = { recordAutomationRun: jest.fn(async () => null) };
    const { service } = load(am, {
      messages: [{ type: 'system', subtype: 'init', session_id: sessionId }, { type: 'result', result: 'done' }],
      costService,
    });
    const noteAccount = jest.fn();
    await service.runSinglePrompt({
      cwd: boundDir, prompt: 'x',
      automation: { workflowId: 'wf-1', workflowName: 'Recap', runId: 'run-1', noteAccount },
    });

    // No account named: the run spent whichever account holds the machine-wide login.
    expect(noteAccount).toHaveBeenCalledWith('acc-live');
    expect(costService.recordAutomationRun).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 'wf-1', runId: 'run-1', accountId: 'acc-live',
      files: [path.join(base, `${sessionId}.jsonl`), path.join(base, sessionId, 'subagents', 'agent-1.jsonl')],
    }));
    expect(fs.existsSync(path.join(base, `${sessionId}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(base, sessionId))).toBe(false);
  });

  test('a node tested from the editor belongs to no automation: nothing is priced', async () => {
    const am = { listAccounts: jest.fn(), accountEnv: jest.fn(), ownsLiveStore: jest.fn() };
    const costService = { recordAutomationRun: jest.fn() };
    const { service } = load(am, {
      messages: [{ type: 'system', subtype: 'init', session_id: 'bbbb-2222' }, { type: 'result', result: 'done' }],
      costService,
    });
    await service.runSinglePrompt({ cwd: boundDir, prompt: 'x' });
    expect(costService.recordAutomationRun).not.toHaveBeenCalled();
    expect(am.listAccounts).not.toHaveBeenCalled();
  });

  test('no account: the machine-wide login, AccountManager untouched', async () => {
    const am = { listAccounts: jest.fn(), accountEnv: jest.fn(), ownsLiveStore: jest.fn() };
    const { service, query } = load(am);
    await service.runSinglePrompt({ cwd: home, prompt: 'x' });
    expect(am.accountEnv).not.toHaveBeenCalled();
    expect(query.mock.calls[0][0].options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
  });

  test("an account with its own store: the step gets that store's overlay", async () => {
    const am = {
      listAccounts: jest.fn(async () => ({ accounts })),
      accountEnv: jest.fn(async () => ({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '/stores/acc-work' })),
      ownsLiveStore: jest.fn(async () => false),
    };
    const { service, query } = load(am);
    await service.runSinglePrompt({ cwd: home, prompt: 'x', accountId: 'acc-work' });
    expect(query.mock.calls[0][0].options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/stores/acc-work');
  });

  test('the account holding the machine-wide login: no overlay, and no error', async () => {
    const am = {
      listAccounts: jest.fn(async () => ({ accounts })),
      accountEnv: jest.fn(async () => null),
      ownsLiveStore: jest.fn(async () => true),
    };
    const { service, query } = load(am);
    await service.runSinglePrompt({ cwd: home, prompt: 'x', accountId: 'acc-work' });
    expect(query).toHaveBeenCalled();
    expect(query.mock.calls[0][0].options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
  });

  test('a deleted account is refused instead of spending the machine-wide one', async () => {
    const am = { listAccounts: jest.fn(async () => ({ accounts })), accountEnv: jest.fn(), ownsLiveStore: jest.fn() };
    const { service, query } = load(am);
    await expect(service.runSinglePrompt({ cwd: home, prompt: 'x', accountId: 'acc-gone' })).rejects.toThrow(/no longer exists/);
    expect(query).not.toHaveBeenCalled();
  });

  test('an account whose credentials cannot be loaded is refused too', async () => {
    const am = {
      listAccounts: jest.fn(async () => ({ accounts })),
      accountEnv: jest.fn(async () => null),
      ownsLiveStore: jest.fn(async () => false),
    };
    const { service, query } = load(am);
    await expect(service.runSinglePrompt({ cwd: home, prompt: 'x', accountId: 'acc-work' })).rejects.toThrow(/No usable credentials for Claude account "Work"/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('the legacy agent step', () => {
  // `agent` has no node file, so it runs through WorkflowRunner's own
  // runAgentStep, which used to carry a hand-kept effort list without xhigh.
  test('passes every effort the shared list knows, xhigh included', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const WorkflowRunner = require('../../src/main/services/WorkflowRunner');
    const { EFFORT_VALUES } = require('../../src/shared/model-options');
    for (const effort of EFFORT_VALUES.filter(Boolean)) {
      const chatService = { runSinglePrompt: jest.fn(async () => ({ output: 'ok', success: true })) };
      const runner = new WorkflowRunner({ sendFn: () => {}, chatService, waitCallbacks: new Map() });
      const res = await runner.testStep({ id: 's1', type: 'agent', prompt: 'hi', effort }, { project: boundDir });
      expect(res.success).toBe(true);
      expect(chatService.runSinglePrompt.mock.calls[0][0].effort).toBe(effort);
    }
  });
});
