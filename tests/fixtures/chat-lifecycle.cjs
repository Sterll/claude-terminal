'use strict';
// Runs in Node so the real ESM SDK and real child processes are exercised on every CI OS.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const source = fs.readFileSync(path.resolve(__dirname, '../../src/main/services/ChatService.js'), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function within(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { clearTimeout(timer); }
}
function load(sdkPromise, accountEnv = async () => null, listAccounts = async () => ({ defaultId: null })) {
  const module = { exports: {} };
  const mocks = {
    electron: { app: {} },
    './ModelCatalogService': { setFetcher() {} },
    './AccountManager': { accountEnv, listAccounts },
    './ChromeBridgeService': { getSessionConfig: () => null },
    './RemoteControlService': { onSessionClosed() {} },
    '../utils/sdkCli': { getSdkCliPath: () => '/unused/fake-cli' },
    '../../shared/cli-failure-text': { isCliFailureText: () => false },
    '../../shared/api-error': { isApiErrorMessage: () => false },
    '../../shared/permission-modes': { isPermissionMode: () => true },
  };
  const ctx = { module, exports: module.exports, require: name => name in mocks ? mocks[name] : require(name), process: { env: { CLAUDECODE: 'parent', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, platform: process.platform, on() {}, removeListener() {} }, AbortController, console, setTimeout, clearTimeout };
  // Seed the existing SDK/runtime caches without replacing any lifecycle method.
  vm.runInNewContext(source + '\nmodule.exports.injectSDK = value => { sdkPromise = value; resolvedRuntime = { executable: "node", pathDir: null }; };', ctx, { filename: 'ChatService.js' });
  const service = module.exports;
  service.injectSDK(sdkPromise);
  service.events = [];
  service._send = (event, data) => service.events.push({ event, data });
  service._emitEvent = service._emitLifecycle = () => {};
  return { service, env: ctx.process.env };
}
async function races() {
  for (const pause of ['sdk', 'account']) {
    const gate = deferred();
    let spawned = 0;
    const sdk = { query: () => { spawned++; throw new Error('must not spawn'); } };
    const { service, env } = load(pause === 'sdk' ? gate.promise : Promise.resolve(sdk), () => pause === 'account' ? gate.promise : Promise.resolve(null));
    const start = service.startSession({ sessionId: 'closed', cwd: os.tmpdir(), prompt: 'fixture' });
    const cancelled = assert.rejects(start, { name: 'AbortError' });
    await wait(0);
    assert(service.sessions.has('closed'));
    service.closeSession('closed');
    gate.resolve(pause === 'sdk' ? sdk : null);
    await cancelled;
    assert.equal(spawned, 0);
    assert.equal(service.sessions.size, 0);
    assert.equal(env.CLAUDECODE, 'parent');
  }
  // A pending old start must neither spawn nor erase its replacement when it settles.
  const gate = deferred();
  let accounts = 0, queries = 0, closes = 0;
  const { service } = load(Promise.resolve({ query: () => { queries++; return { close() { closes++; } }; } }), () => ++accounts === 1 ? gate.promise : Promise.resolve(null));
  service._processStream = () => {};
  const first = service.startSession({ sessionId: 'reused', cwd: os.tmpdir() });
  const cancelled = assert.rejects(first, { name: 'AbortError' });
  await wait(0);
  await service.startSession({ sessionId: 'reused', cwd: os.tmpdir() });
  const replacement = service.sessions.get('reused');
  gate.resolve(null);
  await cancelled;
  assert.equal(service.sessions.get('reused'), replacement);
  assert.equal(queries, 1);
  await service.startSession({ sessionId: 'reused', cwd: os.tmpdir() });
  assert.equal(closes, 1);
  service.closeAll();
  assert.equal(closes, 2);

  // A draining old stream must not publish messages or clear a new session's permissions.
  const oldStream = deferred();
  const fresh = load(Promise.resolve({})).service;
  const old = { abortController: new AbortController() };
  fresh.sessions.set('reused', old);
  const processing = fresh._processStream('reused', (async function* () { await oldStream.promise; yield { type: 'assistant', message: { content: [] } }; })());
  fresh.closeSession('reused');
  fresh.sessions.set('reused', {});
  fresh.pendingPermissions.set('new-permission', { sessionId: 'reused', reject() { throw new Error('new permission rejected'); } });
  oldStream.resolve();
  await processing;
  assert.equal(fresh.events.length, 0);
  assert(fresh.pendingPermissions.has('new-permission'));
  fresh.pendingPermissions.clear();
  fresh.closeAll();
  // Account lookup can settle after a close too; it must not notify the replacement.
  const accountLookup = deferred();
  const limited = load(Promise.resolve({}), undefined, () => accountLookup.promise).service;
  limited.sessions.set('reused', {});
  const failing = limited._processStream('reused', (async function* () { throw new Error('rate limit exceeded'); })());
  await wait(0);
  limited.closeSession('reused');
  limited.sessions.set('reused', {});
  accountLookup.resolve({ defaultId: 'account' });
  await failing;
  assert.equal(limited.events.length, 0);
  limited.closeAll();
  console.log('PASS pending SDK/account close, replacement ownership, active close and stale stream');
}
async function processes() {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-chat-lifecycle-'));
  const cli = path.join(dir, 'cli.cjs');
  fs.writeFileSync(cli, `process.stdin.resume();
process.on('SIGTERM', () => {});
process.stdin.on('end', () => { if (process.env.CT_STUB_MODE === 'normal') process.exit(0); });
setInterval(() => {}, 1000);
process.stderr.write('ready');
`);
  let child;
  try {
    for (const mode of ['normal', 'stubborn']) {
      const ready = deferred();
      let exited;
      const { service } = load(Promise.resolve({ query: params => sdk.query({ ...params, options: {
        ...params.options,
        pathToClaudeCodeExecutable: cli,
        spawnClaudeCodeProcess: opts => {
          child = spawn(process.execPath, [cli], { cwd: dir, env: { ...opts.env, HOME: dir, USERPROFILE: dir, CT_STUB_MODE: mode }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
          exited = once(child, 'exit');
          child.stderr.once('data', ready.resolve);
          return child;
        },
      } }) }));
      await service.startSession({ sessionId: mode, cwd: dir });
      await within(ready.promise, 10000, 'Child did not start');
      const pid = child.pid;
      service.closeSession(mode);
      await within(exited, 12000, 'Child survived close');
      assert(child.exitCode !== null || child.signalCode !== null);
      assert.equal(service.sessions.size, 0);
      service.closeAll();
      console.log(`PASS real SDK ${mode} child exited (${pid})`);
      child = null;
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
races().then(processes).catch(error => { console.error(error); process.exitCode = 1; });
