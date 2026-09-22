/**
 * The bridge between UsageService and the MCP usage tools.
 *
 * `resources/mcp-servers/tools/usage.js` reads `CT_DATA_DIR/usage.json` and
 * requests a re-fetch by dropping a file in `CT_DATA_DIR/usage/triggers/`.
 * Both ends of that contract were missing: nothing wrote the file, so
 * `usage_get` answered "No usage data available" on every install, and nothing
 * watched the directory, so `usage_refresh` reported a refresh that never
 * happened and left its request files behind.
 *
 * The figures live in an in-memory Map in the main process and the MCP server
 * is a separate process, so a file is the only way across. These tests pin
 * that it is written, that it carries the shape the tool reads, and that a
 * dropped trigger actually causes a fetch.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CREDENTIALS_MODULE = '../../src/main/utils/claudeCredentials';
const HOUR = 3600 * 1000;

let dataDir;
let readCredentials;
let httpsGet;

/** A service whose data directory is a throwaway, over a mocked store and API. */
function load(limits = [{ kind: 'session', percent: 42, resets_at: '2026-01-01T00:00:00Z' }]) {
  readCredentials = jest.fn().mockResolvedValue({
    claudeAiOauth: { accessToken: 'token-a', expiresAt: Date.now() + HOUR }
  });
  httpsGet = jest.fn((options, callback) => {
    const body = JSON.stringify({ limits });
    const res = {
      statusCode: 200,
      on: (event, fn) => {
        if (event === 'data') fn(body);
        if (event === 'end') fn();
        return res;
      }
    };
    callback(res);
    return { on: jest.fn(), destroy: jest.fn() };
  });

  jest.resetModules();
  jest.doMock(CREDENTIALS_MODULE, () => ({
    ...jest.requireActual(CREDENTIALS_MODULE),
    readCredentials
  }));
  jest.doMock('https', () => ({ get: httpsGet }));
  jest.doMock('../../src/main/utils/paths', () => ({
    ...jest.requireActual('../../src/main/utils/paths'),
    dataDir
  }));
  return require('../../src/main/services/UsageService');
}

const mirrorPath = () => path.join(dataDir, 'usage.json');
const readMirror = () => JSON.parse(fs.readFileSync(mirrorPath(), 'utf8'));

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-usage-mirror-'));
});

afterEach(() => {
  jest.dontMock(CREDENTIALS_MODULE);
  jest.dontMock('https');
  jest.dontMock('../../src/main/utils/paths');
  jest.resetModules();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
});

describe('usage.json', () => {
  test('is written after a successful fetch', async () => {
    const usage = load();
    expect(fs.existsSync(mirrorPath())).toBe(false);

    await usage.fetchUsage();

    expect(fs.existsSync(mirrorPath())).toBe(true);
  });

  test('carries the buckets the MCP tool renders, not token counts', async () => {
    const usage = load([
      { kind: 'session', percent: 42, resets_at: '2026-01-01T00:00:00Z' },
      { kind: 'weekly_all', percent: 7, resets_at: '2026-01-05T00:00:00Z' },
    ]);
    await usage.fetchUsage();

    const written = readMirror();
    expect(written.buckets).toHaveLength(2);
    expect(written.buckets[0]).toMatchObject({ type: 'session', utilization: 42 });
    expect(written.buckets[1]).toMatchObject({ type: 'weekly', utilization: 7 });
    expect(written.lastFetch).toEqual(expect.any(String));
    expect(written.stale).toBe(false);
  });

  test('says so when the figures stopped being confirmed', async () => {
    const usage = load();
    await usage.fetchUsage();
    expect(readMirror().stale).toBe(false);

    // Nothing usable in the store: the fetch fails and serves what it had.
    usage.invalidateCredentials();
    readCredentials.mockResolvedValue(null);
    await usage.fetchUsage();

    const written = readMirror();
    expect(written.stale).toBe(true);
    expect(written.error).toEqual(expect.any(String));
  });

  test('a read-only data directory does not fail the fetch', async () => {
    const usage = load();
    const spy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });
    try {
      await expect(usage.fetchUsage()).resolves.not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the refresh trigger directory', () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 150));

  test('a dropped request causes a fetch and is consumed', async () => {
    const usage = load();
    await usage.fetchUsage();
    const callsBefore = httpsGet.mock.calls.length;

    usage.startRefreshWatch();
    const dir = path.join(dataDir, 'usage', 'triggers');
    const file = path.join(dir, `refresh_${Date.now()}.json`);
    fs.writeFileSync(file, '{}');
    await settle();

    expect(httpsGet.mock.calls.length).toBeGreaterThan(callsBefore);
    // Left behind, it would fire again on the next directory event.
    expect(fs.existsSync(file)).toBe(false);
    usage.stopRefreshWatch();
  });

  test('a file that is not a refresh request is ignored', async () => {
    const usage = load();
    await usage.fetchUsage();
    const callsBefore = httpsGet.mock.calls.length;

    usage.startRefreshWatch();
    const dir = path.join(dataDir, 'usage', 'triggers');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    await settle();

    expect(httpsGet.mock.calls.length).toBe(callsBefore);
    usage.stopRefreshWatch();
  });

  test('starting twice keeps one watcher, and stopping is idempotent', () => {
    const usage = load();
    usage.startRefreshWatch();
    usage.startRefreshWatch();
    expect(() => { usage.stopRefreshWatch(); usage.stopRefreshWatch(); }).not.toThrow();
  });
});
