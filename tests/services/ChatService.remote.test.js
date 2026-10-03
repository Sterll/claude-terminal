/**
 * @jest-environment node
 *
 * Chat sessions of remote (SSH) projects (design/remote-ssh.md section 5.2).
 *
 * `ChatService.startSession` keeps calling `sdk.query()` for a remote project
 * and only adds the SDK's `spawnClaudeCodeProcess` hook, which spawns ssh
 * instead of the local binary. These tests drive the real startSession with
 * the SDK mocked:
 *
 * - a local session's options are pinned field by field, so the remote branch
 *   provably leaves them alone;
 * - a remote session gets the hook, the local home as cwd, no Claude in
 *   Chrome server, no account overlay, and no catalog ingestion;
 * - the hook spawns ssh (never the command the SDK computed) and pipes the
 *   child's stderr into the session's diagnostics;
 * - ssh's own failures become sentences about the host, and a lost connection
 *   is `connection_lost` so the tab can resume.
 *
 * The SDK is an ESM module loaded with `import()`, which Jest cannot mock
 * without --experimental-vm-modules, so ChatService's source is evaluated in a
 * vm context with its SDK cache seeded, the way tests/fixtures/chat-lifecycle.cjs
 * does it.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { EventEmitter } = require('events');

const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args) => mockSpawn(...args),
}));

const SERVICES_DIR = path.resolve(__dirname, '../../src/main/services');
const SOURCE = fs.readFileSync(path.join(SERVICES_DIR, 'ChatService.js'), 'utf8');

const CHROME = {
  mcpServers: { 'claude-in-chrome': { type: 'stdio', command: 'C:\\app\\claude.exe', args: ['--claude-in-chrome-mcp'] } },
  systemPrompt: 'Chrome tools are available.',
};

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.kill = jest.fn();
  return child;
}

/**
 * Load ChatService with its collaborators mocked and the SDK replaced by
 * `query`. Relative requires resolve against src/main/services, so the real
 * sshClaudeSpawn (with child_process mocked above) is the one in use.
 */
function loadChatService(query, { accountOverlay = null } = {}) {
  const module = { exports: {} };
  const mocks = {
    electron: { app: { isPackaged: false, getAppPath: () => '/mock/app' }, BrowserWindow: { getAllWindows: () => [] } },
    './ModelCatalogService': { setFetcher() {}, setCliVersion() {}, ingestInitResult: jest.fn() },
    './AccountManager': { accountEnv: jest.fn(async () => accountOverlay), listAccounts: jest.fn(async () => ({ defaultId: null })) },
    './ChromeBridgeService': { getSessionConfig: jest.fn(() => CHROME) },
    './RemoteControlService': { onSessionClosed() {} },
    '../utils/sdkCli': { getSdkCliPath: () => '/fake/claude', getSdkCliVersion: () => null },
    './CostService': { noteSessionAccount: jest.fn() },
  };
  const env = { CLAUDECODE: 'parent', PATH: '/local/bin', HOME: '/home/local', ANTHROPIC_API_KEY: 'sk-local' };
  const ctxRequire = (name) => {
    if (name in mocks) return mocks[name];
    if (name.startsWith('.')) return require(path.resolve(SERVICES_DIR, name));
    return require(name);
  };
  const ctx = {
    module,
    exports: module.exports,
    require: ctxRequire,
    process: { env, platform: process.platform, on() {}, removeListener() {} },
    AbortController,
    console: { ...console, error: () => {}, warn: () => {}, log: () => {} },
    setTimeout,
    clearTimeout,
    setImmediate,
    Buffer,
  };
  vm.runInNewContext(
    `${SOURCE}\nmodule.exports.__inject = (sdk) => { sdkPromise = Promise.resolve(sdk); resolvedRuntime = { executable: 'node', pathDir: null }; };`,
    ctx,
    { filename: 'ChatService.js' }
  );
  const service = module.exports;
  service.__inject({ query });
  const events = [];
  service._send = (channel, data) => events.push({ channel, data });
  service._emitEvent = () => {};
  service._emitLifecycle = () => {};
  return { service, mocks, events, env };
}

/** A query stream that never yields, unless told to fail. */
function pendingStream() {
  let fail;
  const failed = new Promise((_, reject) => { fail = reject; });
  failed.catch(() => {});
  const stream = {
    [Symbol.asyncIterator]() {
      return { next: () => failed, return: async () => ({ done: true }) };
    },
    initializationResult: jest.fn(() => Promise.resolve({ models: [] })),
    interrupt: jest.fn(),
    close: jest.fn(),
  };
  return { stream, fail: (err) => fail(err) };
}

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

/** A query stream that yields the CLI's init message, then never anything else. */
function initStream(cliSessionId) {
  let sent = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (sent) return new Promise(() => {});
          sent = true;
          return Promise.resolve({ done: false, value: { type: 'system', subtype: 'init', session_id: cliSessionId } });
        },
        return: async () => ({ done: true }),
      };
    },
    initializationResult: jest.fn(() => Promise.resolve({ models: [] })),
    interrupt: jest.fn(),
    close: jest.fn(),
  };
}

const LAUNCH = {
  profileId: 'abcd1234',
  profile: { id: 'abcd1234', host: 'build.example.com', user: 'yanis', port: 22 },
  command: '/usr/bin/ssh',
  prefixArgs: [],
  env: null,
  capabilities: null,
  controlDir: null,
  platform: 'linux',
};
const REMOTE = {
  profileId: 'abcd1234',
  host: 'yanis@build.example.com',
  remotePath: '/home/yanis/api',
  projectId: 'r1',
  launch: LAUNCH,
  claude: '/home/yanis/.local/bin/claude',
  loginPath: '/home/yanis/.local/bin:/usr/bin:/bin',
  warnings: [],
};
const URI = 'ssh-remote://abcd1234/home/yanis/api';

beforeEach(() => mockSpawn.mockReset());

describe('local sessions are unchanged', () => {
  test('the options object is exactly what it was', async () => {
    const { stream } = pendingStream();
    const query = jest.fn(() => stream);
    const { service, mocks } = loadChatService(query);
    await service.startSession({ cwd: '/work/app', projectId: 'p1', prompt: 'hi', sessionId: 's-local' });

    expect(query).toHaveBeenCalledTimes(1);
    const { options } = query.mock.calls[0][0];
    // Functions compare by type, everything else by value.
    expect(options).toEqual({
      cwd: '/work/app',
      abortController: expect.any(AbortController),
      includePartialMessages: true,
      permissionMode: 'default',
      executable: 'node',
      env: { PATH: '/local/bin', HOME: '/home/local', ANTHROPIC_API_KEY: 'sk-local' },
      pathToClaudeCodeExecutable: '/fake/claude',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Chrome tools are available.' },
      settingSources: ['user', 'project', 'local'],
      canUseTool: expect.any(Function),
      onElicitation: expect.any(Function),
      stderr: expect.any(Function),
      promptSuggestions: true,
      enableFileCheckpointing: true,
      forwardSubagentText: true,
      agentProgressSummaries: true,
      mcpServers: CHROME.mcpServers,
    });
    expect(options).not.toHaveProperty('spawnClaudeCodeProcess');
    expect(mocks['./AccountManager'].accountEnv).toHaveBeenCalledWith(null);
    await flush();
    expect(mocks['./ModelCatalogService'].ingestInitResult).toHaveBeenCalled();
    expect(service.sessions.get('s-local')).not.toHaveProperty('remote');
  });

  test('an account overlay still reaches a local session', async () => {
    const { stream } = pendingStream();
    const query = jest.fn(() => stream);
    const { service } = loadChatService(query, { accountOverlay: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/acc/1' } });
    await service.startSession({ cwd: '/work/app', accountId: 'acc-1', prompt: 'hi', sessionId: 's-acc' });
    expect(query.mock.calls[0][0].options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/acc/1');
  });
});

describe('remote sessions', () => {
  async function startRemote(overrides = {}) {
    const pending = pendingStream();
    let child = null;
    const query = jest.fn(({ options }) => {
      // The SDK spawns as soon as the query starts
      child = options.spawnClaudeCodeProcess({
        command: 'C:\\app\\node_modules\\claude.exe',
        args: ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--model', 'opus'],
        cwd: os.homedir(),
        env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '0.3.260', PATH: '/local/bin', HOME: '/home/local', ANTHROPIC_API_KEY: 'sk-local', CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
        signal: undefined,
      });
      return pending.stream;
    });
    mockSpawn.mockImplementation(() => fakeChild());
    const harness = loadChatService(query);
    await harness.service.startSession({ cwd: URI, projectId: 'r1', accountId: null, prompt: 'hi', sessionId: 's-remote', remote: { ...REMOTE, ...overrides } });
    return { ...harness, query, pending, child: () => child };
  }

  test('only a remote session carries spawnClaudeCodeProcess, with the local home as cwd', async () => {
    const { query } = await startRemote();
    const { options } = query.mock.calls[0][0];
    expect(typeof options.spawnClaudeCodeProcess).toBe('function');
    expect(options.cwd).toBe(os.homedir());
    expect(options.cwd).not.toBe(URI);
  });

  test('no Claude in Chrome server, no account overlay, no catalog ingestion', async () => {
    const { query, mocks } = await startRemote();
    const { options } = query.mock.calls[0][0];
    expect(options).not.toHaveProperty('mcpServers');
    expect(options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
    expect(mocks['./ChromeBridgeService'].getSessionConfig).not.toHaveBeenCalled();
    expect(mocks['./AccountManager'].accountEnv).not.toHaveBeenCalled();
    await flush();
    expect(mocks['./ModelCatalogService'].ingestInitResult).not.toHaveBeenCalled();
  });

  test('the hook spawns ssh in batch mode and never the command or cwd the SDK computed', async () => {
    await startRemote();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args, opts] = mockSpawn.mock.calls[0];
    expect(command).toBe('/usr/bin/ssh');
    expect(args).toEqual(expect.arrayContaining(['-T', '-o', 'BatchMode=yes', '--', 'build.example.com']));
    // `--` sits right before the destination, and one remote command follows it
    expect(args.slice(-3, -1)).toEqual(['--', 'build.example.com']);
    const remoteCommand = args[args.length - 1];
    expect(remoteCommand.startsWith('/bin/sh -c ')).toBe(true);
    expect(remoteCommand).not.toContain('claude.exe');
    expect(remoteCommand).toContain('/home/yanis/api');
    expect(remoteCommand).toContain('/home/yanis/.local/bin/claude');
    expect(remoteCommand).not.toContain('sk-local');
    expect(remoteCommand).not.toContain('tok');
    expect(remoteCommand).not.toContain('/local/bin');
    expect(opts.cwd).toBe(os.homedir());
    expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  test("the child's stderr reaches the session's diagnostics", async () => {
    const { service, child } = await startRemote();
    child().stderr.emit('data', Buffer.from('client_loop: send disconnect: Broken pipe\n'));
    expect(service.sessions.get('s-remote')._stderr).toContain('Broken pipe');
    expect(service.sessions.get('s-remote').remote).toEqual({ profileId: 'abcd1234', host: 'yanis@build.example.com' });
  });

  test('ssh exiting 255 on a network failure is connection_lost', async () => {
    const { pending, child, events } = await startRemote();
    child().stderr.emit('data', Buffer.from('Connection to build.example.com closed by remote host.\n'));
    pending.fail(new Error('Claude Code process exited with code 255'));
    await flush();
    const error = events.find(e => e.channel === 'chat-error');
    expect(error.data).toMatchObject({ sessionId: 's-remote', errorType: 'connection_lost' });
    expect(error.data.error).toBe('The connection to yanis@build.example.com was lost.');
  });

  test('an authentication failure is reported, but not as a connection to wait for', async () => {
    const { pending, child, events } = await startRemote();
    child().stderr.emit('data', Buffer.from('yanis@build.example.com: Permission denied (publickey).\n'));
    pending.fail(new Error('Claude Code process exited with code 255'));
    await flush();
    const error = events.find(e => e.channel === 'chat-error');
    expect(error.data.errorType).toBe('generic');
    expect(error.data.error).toMatch(/^Authentication to yanis@build\.example\.com failed/);
  });

  test('exit 127 says Claude Code is not installed on the host', async () => {
    const { pending, events } = await startRemote();
    pending.fail(new Error('Claude Code process exited with code 127'));
    await flush();
    const error = events.find(e => e.channel === 'chat-error');
    expect(error.data.error).toMatch(/^Claude Code is not installed on yanis@build\.example\.com\./);
  });

  test('any other exit is the CLI\'s, humanized as before', async () => {
    const { pending, child, events } = await startRemote();
    child().stderr.emit('data', Buffer.from('API Error: Connection refused\n'));
    pending.fail(new Error('Claude Code process exited with code 1'));
    await flush();
    const error = events.find(e => e.channel === 'chat-error');
    expect(error.data.errorType).toBe('generic');
    expect(error.data.error).toMatch(/^Claude Code process crashed \(exit code 1\)/);
  });
});

describe('limits of a remote session', () => {
  test('a usage limit is shown as the error it is: there is no local account to switch to', async () => {
    const pending = pendingStream();
    let child = null;
    const query = jest.fn(({ options }) => {
      child = options.spawnClaudeCodeProcess({ command: 'x', args: ['--verbose'], env: {} });
      return pending.stream;
    });
    mockSpawn.mockImplementation(() => fakeChild());
    const { service, events } = loadChatService(query);
    await service.startSession({ cwd: URI, prompt: 'hi', sessionId: 's-limit', remote: REMOTE });
    child.stderr.emit('data', Buffer.from('API Error: 429 rate limit reached\n'));
    pending.fail(new Error('Claude Code process exited with code 1'));
    await flush();
    expect(events.some(e => e.channel === 'chat-account-limit')).toBe(false);
    expect(events.find(e => e.channel === 'chat-error').data.errorType).toBe('generic');
  });
});

describe('the cost report and remote sessions', () => {
  test('a local session records the account it runs on at init, as before', async () => {
    const query = jest.fn(() => initStream('cli-local-1'));
    const { service, mocks } = loadChatService(query);
    await service.startSession({ cwd: '/work/app', projectId: 'p1', prompt: 'hi', sessionId: 's-cost-local' });
    await flush();
    expect(mocks['./CostService'].noteSessionAccount).toHaveBeenCalledWith('cli-local-1', null);
  });

  test('a remote session records nothing: its transcript is on the host', async () => {
    const query = jest.fn(({ options }) => {
      options.spawnClaudeCodeProcess({ command: 'x', args: ['--verbose'], env: {} });
      return initStream('cli-remote-1');
    });
    mockSpawn.mockImplementation(() => fakeChild());
    const { service, mocks } = loadChatService(query);
    await service.startSession({ cwd: URI, projectId: 'r1', prompt: 'hi', sessionId: 's-cost-remote', remote: REMOTE });
    await flush();
    expect(service.sessions.get('s-cost-remote').sdkSessionId).toBe('cli-remote-1');
    expect(mocks['./CostService'].noteSessionAccount).not.toHaveBeenCalled();
  });
});

describe('workflow prompts refuse a remote project', () => {
  test('runSinglePrompt throws before any SDK call', async () => {
    const query = jest.fn();
    const { service } = loadChatService(query);
    await expect(service.runSinglePrompt({ cwd: URI, prompt: 'x' })).rejects.toThrow(/Remote projects are not supported/);
    expect(query).not.toHaveBeenCalled();
  });

  test('skill and agent generation refuses a remote project before any SDK call', async () => {
    const query = jest.fn();
    const { service } = loadChatService(query);
    const result = await service.generateSkillOrAgent({ type: 'skill', description: 'x', cwd: URI, genId: 'gen-1' });
    expect(result).toMatchObject({ success: false, type: 'skill', genId: 'gen-1' });
    expect(result.error).toMatch(/remote project/);
    expect(query).not.toHaveBeenCalled();
  });

  test('CLAUDE.md suggestions are not applied to a URI', async () => {
    const { service } = loadChatService(jest.fn());
    expect(service.applyClaudeMdSections(URI, [{ section: '## X', content: 'y' }])).toMatchObject({ success: false });
    await expect(service.analyzeSessionForClaudeMd([{ role: 'user', content: 'x' }], URI)).resolves.toEqual({ suggestions: [], claudeMdExists: false });
  });
});
