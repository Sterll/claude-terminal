/** @jest-environment node */
const fs = require('fs');
const path = require('path');
const os = require('os');
const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-sync-safety-'));
jest.mock('../../src/main/utils/paths', () => ({
  dataDir: mockDir, settingsFile: mockDir + '/settings.json', projectsFile: mockDir + '/projects.json', claudeDir: mockDir + '/.claude'
}));
const { SyncEngine } = require('../../src/main/services/SyncEngine');
let engine;
beforeEach(() => {
  jest.spyOn(os, 'homedir').mockReturnValue(mockDir);
  engine = new SyncEngine();
  engine._registerHandlers();
});
afterEach(() => { engine.stop(); jest.restoreAllMocks(); });
afterAll(() => fs.rmSync(mockDir, { recursive: true, force: true }));

test('MCP sync never exports environment/header values and retains machine-local credentials', async () => {
  const handler = engine._handlers.mcp;
  const config = { db: { command: 'node', env: { CT_DB_PASS_test: 'secret-one', DATABASE_URL: 'secret-uri', PATH: '/local' }, headers: { Authorization: 'bearer-local' } } };
  const safe = handler.sanitize(config);
  expect(JSON.stringify(safe)).not.toContain('secret-');
  expect(JSON.stringify(safe)).not.toContain('bearer-local');
  const file = path.join(mockDir, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ unrelated: true, mcpServers: config }));
  await handler.write({ db: { command: 'updated', env: { CT_DB_PASS_test: '***REDACTED***', NEW_SECRET: 'legacy-leak' }, headers: { Authorization: '***REDACTED***' } } });
  const saved = JSON.parse(fs.readFileSync(file));
  expect(saved.unrelated).toBe(true);
  expect(saved.mcpServers.db.env).toEqual(config.db.env);
  expect(saved.mcpServers.db.headers).toEqual(config.db.headers);
  expect(JSON.stringify(saved)).not.toContain('REDACTED');
  expect(JSON.stringify(saved)).not.toContain('legacy-leak');
});

test('an edit arriving during a slow push is drained before idle', async () => {
  engine._started = true;
  let finish;
  const slow = new Promise(resolve => { finish = resolve; });
  engine._pushEntity = jest.fn().mockImplementationOnce(() => slow).mockResolvedValue(undefined);
  engine._pushQueue.add('settings');
  const pushing = engine._flushPushQueue();
  engine._pushQueue.add('projects');
  const concurrent = engine._flushPushQueue(); // shares the running drain
  finish();
  await Promise.all([pushing, concurrent]);
  expect(engine._pushEntity.mock.calls.map(([type]) => type)).toEqual(['settings', 'projects']);
  expect(engine.getStatus()).toMatchObject({ status: 'idle', pendingPush: 0 });
});

test('failed pushes stay queued and retry successfully', async () => {
  jest.useFakeTimers();
  engine._started = true;
  engine._pushEntity = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  engine._pushQueue.add('settings');
  await engine._flushPushQueue();
  expect(engine.getStatus()).toMatchObject({ status: 'error', pendingPush: 1 });
  await jest.advanceTimersByTimeAsync(2000);
  expect(engine.getStatus()).toMatchObject({ status: 'idle', pendingPush: 0 });
  engine.stop();
  jest.useRealTimers();
});

test('a failed initial pull retains its error state', async () => {
  engine._startWatchers = jest.fn();
  engine._fetch = jest.fn().mockRejectedValue(new Error('offline'));
  await engine.start('https://example.test', 'test-key');
  expect(engine.getStatus().status).toBe('error');
});
