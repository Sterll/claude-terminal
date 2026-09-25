/** @jest-environment node */
// DatabaseService Redis behaviour: which database a connection lists and browses

jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => require('os').tmpdir() }
}));
jest.mock('keytar', () => ({
  setPassword: jest.fn(), getPassword: jest.fn().mockResolvedValue(''), deletePassword: jest.fn()
}), { virtual: true });
const mockDataDir = require('path').join(require('os').tmpdir(), 'claude-terminal-redis-test-' + Date.now());
jest.mock('../../src/main/utils/paths', () => ({ dataDir: mockDataDir }));

const databaseService = require('../../src/main/services/DatabaseService');

/**
 * In-memory stand-in for an ioredis client. Every client made from one store
 * (the original and its duplicates) sees the same data, each through its own
 * selected db, which is exactly the property the service now relies on.
 */
function fakeRedis(data, { db = 0, infoFails = false, scanBatches = null } = {}) {
  const make = (index) => {
    let current = index;
    const keys = () => data[current] || {};
    const client = {
      options: { db: index },
      selects: [],
      duplicates: [],
      connect: jest.fn(async () => {}),
      disconnect: jest.fn(),
      duplicate: jest.fn((opts) => {
        const dup = make(opts.db);
        client.duplicates.push(dup);
        return dup;
      }),
      select: jest.fn(async (n) => { client.selects.push(n); current = n; return 'OK'; }),
      info: jest.fn(async () => {
        if (infoFails) throw new Error('NOPERM');
        const lines = Object.entries(data)
          .filter(([, k]) => Object.keys(k).length > 0)
          .map(([i, k]) => `db${i}:keys=${Object.keys(k).length},expires=0,avg_ttl=0`);
        return ['# Keyspace', ...lines, ''].join('\r\n');
      }),
      dbsize: jest.fn(async () => Object.keys(keys()).length),
      // One batch by default; `scanBatches` replays given batches, duplicates included
      scan: jest.fn(async (cursor) => {
        if (!scanBatches) return ['0', Object.keys(keys())];
        const i = parseInt(cursor, 10);
        return [i + 1 >= scanBatches.length ? '0' : String(i + 1), scanBatches[i]];
      }),
      type: jest.fn(async (k) => (keys()[k] ? keys()[k].type : 'none')),
      ttl: jest.fn(async () => -1),
      pttl: jest.fn(async () => -1),
      get: jest.fn(async (k) => (keys()[k] ? keys()[k].value : null)),
      strlen: jest.fn(async (k) => String(keys()[k].value).length),
      hgetall: jest.fn(async (k) => keys()[k].value),
      set: jest.fn(async (k, v) => { data[current] = { ...keys(), [k]: { type: 'string', value: v } }; return 'OK'; }),
    };
    return client;
  };
  return make(db);
}

describe('DatabaseService Redis schema', () => {
  test('lists the configured db even while it holds no keys', async () => {
    // Every key in a TTL-only cache can be expired at the moment the list is read
    const client = fakeRedis({}, { db: 1 });
    const tables = await databaseService._getRedisSchema(client, { database: 1 });
    expect(tables.map(t => t.name)).toEqual(['db:1']);
    expect(tables[0]).toMatchObject({ isDefault: true, keyCount: 0 });
  });

  test('never invents a db:0 the connection was not configured for', async () => {
    const client = fakeRedis({ 1: { a: { type: 'string', value: 'x' } } }, { db: 1 });
    const tables = await databaseService._getRedisSchema(client, { database: 1 });
    expect(tables.map(t => t.name)).toEqual(['db:1']);
    expect(tables[0].keyCount).toBe(1);
  });

  test('keeps other populated dbs, sorted, and marks only the configured one', async () => {
    const client = fakeRedis({
      3: { c: { type: 'string', value: '1' } },
      0: { a: { type: 'string', value: '1' } },
    }, { db: 1 });
    const tables = await databaseService._getRedisSchema(client, { database: '1' });
    expect(tables.map(t => [t.name, !!t.isDefault])).toEqual([['db:0', false], ['db:1', true], ['db:3', false]]);
  });

  test('still lists the configured db when INFO is denied', async () => {
    const client = fakeRedis({ 2: { a: { type: 'string', value: '1' } } }, { db: 2, infoFails: true });
    const tables = await databaseService._getRedisSchema(client, { database: 2 });
    expect(tables).toEqual([expect.objectContaining({ name: 'db:2', keyCount: 1, isDefault: true })]);
  });

  test('reads the db index whether stored as a number or a string', () => {
    expect(databaseService._redisDbIndex({ database: 1 })).toBe(1);
    expect(databaseService._redisDbIndex({ database: '4' })).toBe(4);
    expect(databaseService._redisDbIndex({ database: '' })).toBe(0);
    expect(databaseService._redisDbIndex({})).toBe(0);
  });
});

/** Register a fake client as an open connection, the way connect() would. */
function openConnection(id, client, config = {}) {
  databaseService.connections.set(id, { config: { type: 'redis', ...config }, client, status: 'connected', lastUsed: Date.now() });
}

afterEach(() => { databaseService.connections.clear(); });

describe('DatabaseService Redis browsing', () => {
  test('browsing another db does not move the shared connection', async () => {
    const data = {
      1: { mine: { type: 'string', value: 'configured' } },
      2: { other: { type: 'string', value: 'elsewhere' } },
    };
    const client = fakeRedis(data, { db: 1 });
    openConnection('c', client, { database: 1 });

    const listed = await databaseService.redis('c', { action: 'keys', db: 2 });
    expect(listed.keys).toEqual(['other']);
    expect(client.selects).toEqual([]);

    // A command typed afterwards still runs against the configured db
    const got = await databaseService._executeRedis(client, 'GET mine', 100);
    expect(got.rows).toEqual([{ result: 'configured' }]);
    await databaseService._closeClient('redis', client);
  });

  test('reuses one client per browsed db and closes it with the connection', async () => {
    const client = fakeRedis({ 2: { k: { type: 'string', value: 'v' } } }, { db: 0 });
    openConnection('c', client);
    await databaseService.redis('c', { action: 'keys', db: 2 });
    await databaseService.redis('c', { action: 'info', db: 2, key: 'k' });
    expect(client.duplicate).toHaveBeenCalledTimes(1);

    const dup = client.duplicates[0];
    await databaseService._closeClient('redis', client);
    await new Promise(r => setImmediate(r));
    expect(dup.disconnect).toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalled();
  });
});

describe('DatabaseService.redis key listing', () => {
  test('stops at the limit and says the list is partial', async () => {
    const keys = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${String(i).padStart(2, '0')}`, { type: 'string', value: 'v' }]));
    openConnection('c', fakeRedis({ 0: keys }));
    const result = await databaseService.redis('c', { action: 'keys', limit: 10 });
    expect(result).toMatchObject({ success: true, truncated: true, total: 30 });
    expect(result.keys).toHaveLength(10);
  });

  test('a list that fits is complete, sorted, and free of the duplicates SCAN may return', async () => {
    const data = { 0: { b: { type: 'string', value: '1' }, a: { type: 'string', value: '1' } } };
    openConnection('c', fakeRedis(data, { scanBatches: [['b', 'a'], ['a']] }));
    const result = await databaseService.redis('c', { action: 'keys' });
    expect(result).toMatchObject({ success: true, keys: ['a', 'b'], truncated: false });
  });

  test('uses the configured db when the request names none', async () => {
    const client = fakeRedis({ 3: { here: { type: 'string', value: '1' } } }, { db: 3 });
    openConnection('c', client, { database: 3 });
    expect((await databaseService.redis('c', { action: 'keys' })).keys).toEqual(['here']);
    // Its own client even for the configured db: a SELECT typed in the query tab moves the main one
    expect(client.duplicate).toHaveBeenCalledWith(expect.objectContaining({ db: 3 }));
  });

  test('the server-side filter ignores case and matches glob characters literally', () => {
    expect(databaseService._redisCaselessGlob('Ab1')).toBe('[aA][bB]1');
    expect(databaseService._redisCaselessGlob('x*[?')).toBe('[xX]\\*\\[\\?');
  });
});

describe('DatabaseService.redis key detail', () => {
  test('carries a key holding spaces and a newline intact', async () => {
    const key = ' spaced key\nline ';
    openConnection('c', fakeRedis({ 0: { [key]: { type: 'string', value: 'v' } } }));
    const result = await databaseService.redis('c', { action: 'info', key });
    expect(result).toMatchObject({ success: true, info: { key, type: 'string', value: 'v', ttl: null } });
  });

  test('reports a missing key as an error, not a crash', async () => {
    openConnection('c', fakeRedis({ 0: {} }));
    const result = await databaseService.redis('c', { action: 'info', key: 'gone' });
    expect(result).toEqual({ success: false, error: 'Key "gone" does not exist' });
  });

  test('refuses to run against a connection that is not Redis', async () => {
    databaseService.connections.set('pg', { config: { type: 'postgresql' }, client: {}, lastUsed: 0 });
    expect(await databaseService.redis('pg', { action: 'keys' })).toMatchObject({ success: false });
    expect(await databaseService.redis('nope', { action: 'keys' })).toEqual({ success: false, error: 'Not connected' });
  });
});

describe('DatabaseService Redis commands', () => {
  test('quoted arguments stay one argument', () => {
    expect(databaseService._tokenizeRedisCommand('SET greeting "hello world"')).toEqual(['SET', 'greeting', 'hello world']);
    expect(databaseService._tokenizeRedisCommand("SET k 'a \"b\" c'")).toEqual(['SET', 'k', 'a "b" c']);
    expect(databaseService._tokenizeRedisCommand('SET k "line\\nbreak"')).toEqual(['SET', 'k', 'line\nbreak']);
    expect(databaseService._tokenizeRedisCommand('  GET   key  ')).toEqual(['GET', 'key']);
    expect(() => databaseService._tokenizeRedisCommand('SET k "open')).toThrow(/Unbalanced/);
  });

  test('SET with a quoted value stores the whole value', async () => {
    const data = { 0: {} };
    const client = fakeRedis(data);
    await databaseService._executeRedis(client, 'SET greeting "hello world"', 100);
    expect(client.set).toHaveBeenCalledWith('greeting', 'hello world');
  });

  test('HGETALL returns field/value rows instead of [object Object]', async () => {
    const client = fakeRedis({ 0: { h: { type: 'hash', value: { name: 'yanis', role: 'dev' } } } });
    const result = await databaseService._executeRedis(client, 'HGETALL h', 100);
    expect(result.columns).toEqual(['field', 'value']);
    expect(result.rows).toEqual([{ field: 'name', value: 'yanis' }, { field: 'role', value: 'dev' }]);
  });

  test('a key filter is matched literally, not as a glob', () => {
    expect(databaseService._redisGlobEscape('user[1]*?')).toBe('user\\[1\\]\\*\\?');
    expect(databaseService._redisGlobEscape('a\\b')).toBe('a\\\\b');
  });
});
