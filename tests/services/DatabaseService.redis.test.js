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

// Record what a real connection would be opened with
const mockRedisOptions = [];
jest.mock('ioredis', () => jest.fn().mockImplementation((options) => {
  mockRedisOptions.push(options);
  const listeners = {};
  return {
    on: jest.fn((event, fn) => { listeners[event] = fn; }),
    // host "unreachable" fails the way a TLS client against a plain port does
    connect: jest.fn(async () => {
      if (options.host !== 'unreachable') return;
      listeners.error && listeners.error(new Error('connect ETIMEDOUT'));
      throw new Error('Connection is closed.');
    }),
    ping: jest.fn(async () => 'PONG'),
    disconnect: jest.fn(),
    options,
  };
}));

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
      on: jest.fn(),
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
      // An entry may carry `ttlMs`; without it the key never expires
      ttl: jest.fn(async (k) => (!keys()[k] ? -2 : keys()[k].ttlMs ? Math.ceil(keys()[k].ttlMs / 1000) : -1)),
      pttl: jest.fn(async (k) => (!keys()[k] ? -2 : keys()[k].ttlMs || -1)),
      get: jest.fn(async (k) => (keys()[k] ? keys()[k].value : null)),
      strlen: jest.fn(async (k) => String(keys()[k].value).length),
      hgetall: jest.fn(async (k) => keys()[k].value),
      exists: jest.fn(async (k) => (keys()[k] ? 1 : 0)),
      hlen: jest.fn(async (k) => Object.keys(keys()[k].value).length),
      // HSCAN pages of two fields, to exercise the cursor walk
      hscan: jest.fn(async (k, cursor) => {
        const flat = Object.entries(keys()[k].value).flat();
        const at = parseInt(cursor, 10);
        const next = at + 4;
        return [next >= flat.length ? '0' : String(next), flat.slice(at, next)];
      }),
      scard: jest.fn(async (k) => keys()[k].value.length),
      sscan: jest.fn(async (k) => ['0', keys()[k].value]),
      llen: jest.fn(async (k) => keys()[k].value.length),
      lrange: jest.fn(async (k, start, stop) => keys()[k].value.slice(start, stop + 1)),
      xlen: jest.fn(async (k) => keys()[k].value.length),
      xrevrange: jest.fn(async (k, _end, _start, _count, n) => [...keys()[k].value].reverse().slice(0, n)),
      call: jest.fn(async (command, k) => (String(command).toUpperCase() === 'JSON.GET' ? keys()[k].value : null)),
      pipeline: jest.fn(() => {
        const queued = [];
        return {
          type(k) { queued.push(k); return this; },
          exec: async () => queued.map(k => [null, keys()[k] ? keys()[k].type : 'none']),
        };
      }),
      set: jest.fn(async (k, v, mode, ms) => {
        data[current] = { ...keys(), [k]: { type: 'string', value: v, ...(mode === 'PX' ? { ttlMs: ms } : {}) } };
        return 'OK';
      }),
      unlink: jest.fn(async (k) => { if (!keys()[k]) return 0; delete data[current][k]; return 1; }),
      del: jest.fn(async (k) => { if (!keys()[k]) return 0; delete data[current][k]; return 1; }),
      expire: jest.fn(async (k, s) => { if (!keys()[k]) return 0; keys()[k].ttlMs = s * 1000; return 1; }),
      persist: jest.fn(async (k) => { if (!keys()[k] || !keys()[k].ttlMs) return 0; delete keys()[k].ttlMs; return 1; }),
      renamenx: jest.fn(async (k, n) => {
        if (!keys()[k]) throw new Error('ERR no such key');
        if (keys()[n]) return 0;
        data[current][n] = keys()[k];
        delete data[current][k];
        return 1;
      }),
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

describe('DatabaseService Redis connection options', () => {
  test('passes the ACL user and turns TLS on, verifying certificates by default', async () => {
    mockRedisOptions.length = 0;
    await databaseService._createRedisClient({ host: 'eu1.upstash.io', port: 6380, username: 'app', password: 'pw', database: 2, tls: true });
    expect(mockRedisOptions[0]).toMatchObject({
      host: 'eu1.upstash.io', port: 6380, username: 'app', password: 'pw', db: 2,
      tls: { servername: 'eu1.upstash.io', rejectUnauthorized: true },
    });
  });

  test('a self-signed certificate is accepted only when asked, and TLS stays off by default', async () => {
    mockRedisOptions.length = 0;
    await databaseService._createRedisClient({ host: 'h', tls: true, tlsInsecure: true });
    await databaseService._createRedisClient({ host: 'h' });
    expect(mockRedisOptions[0].tls.rejectUnauthorized).toBe(false);
    expect(mockRedisOptions[1]).toMatchObject({ tls: undefined, username: undefined });
  });

  test('a failed connect reports the socket error, with a TLS hint when TLS is the likely cause', async () => {
    await expect(databaseService._createRedisClient({ host: 'unreachable', tls: true }))
      .rejects.toThrow('connect ETIMEDOUT. The TLS handshake did not complete');
    expect(databaseService._redisConnectError(new Error('read ECONNRESET'), {}))
      .toBe('read ECONNRESET. If the server requires TLS (a rediss:// URL), turn TLS on.');
    expect(databaseService._redisConnectError(new Error('WRONGPASS invalid username-password pair'), { tls: true }))
      .toBe('WRONGPASS invalid username-password pair');
  });

  test('a detected rediss:// URL keeps its TLS and its user', () => {
    expect(databaseService._parseDatabaseUrl('rediss://app:p%40ss@cache.example.com:6380/3')).toMatchObject({
      type: 'redis', host: 'cache.example.com', port: 6380, username: 'app', password: 'p@ss', database: 3, tls: true,
    });
    expect(databaseService._parseDatabaseUrl('redis://localhost:6379').tls).toBeUndefined();
  });
});

describe('DatabaseService Redis server summary', () => {
  const INFO = [
    '# Server', 'redis_version:7.2.4', 'redis_mode:standalone', 'uptime_in_seconds:90000', '',
    '# Clients', 'connected_clients:3', 'blocked_clients:1', '',
    '# Memory', 'used_memory:1048576', 'used_memory_peak:2097152', 'maxmemory:0', 'maxmemory_policy:noeviction', 'mem_fragmentation_ratio:1.23', '',
    '# Persistence', 'aof_enabled:1', 'rdb_last_save_time:1700000000', '',
    '# Stats', 'instantaneous_ops_per_sec:42', 'keyspace_hits:90', 'keyspace_misses:10', 'evicted_keys:0', 'expired_keys:7', '',
    '# Replication', 'role:master', 'connected_slaves:2', '',
    '# Keyspace', 'db1:keys=133,expires=133,avg_ttl=1', 'db0:keys=2,expires=0,avg_ttl=0', '',
  ].join('\r\n');

  test('turns INFO into the numbers the overview compares', () => {
    expect(databaseService._redisServerSummary(INFO)).toEqual({
      version: '7.2.4', mode: 'standalone', role: 'master', connectedReplicas: 2, uptimeSeconds: 90000,
      clients: 3, blockedClients: 1, usedMemory: 1048576, peakMemory: 2097152,
      maxMemory: null, maxMemoryPolicy: 'noeviction', fragmentation: 1.23, opsPerSec: 42, hitRate: 0.9,
      evictedKeys: 0, expiredKeys: 7, rdbLastSave: 1700000000, aofEnabled: true,
      keyspace: [{ db: 0, keys: 2, expires: 0 }, { db: 1, keys: 133, expires: 133 }],
    });
  });

  test('leaves out what a managed service strips instead of inventing zeros', () => {
    const summary = databaseService._redisServerSummary('# Server\r\nredis_version:6.2.0\r\n');
    expect(summary).toMatchObject({ version: '6.2.0', usedMemory: null, hitRate: null, aofEnabled: null, keyspace: [] });
  });
});

describe('DatabaseService.redis value types', () => {
  test('a hash is read by HSCAN in pages and says how much came back', async () => {
    const value = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}`, `v${i}`]));
    const client = fakeRedis({ 0: { h: { type: 'hash', value } } });
    openConnection('c', client);
    const { info } = await databaseService.redis('c', { action: 'info', key: 'h' });
    expect(JSON.parse(info.value)).toEqual(value);
    expect(info).toMatchObject({ length: 5, shown: 5 });
    expect(client.duplicates[0].hscan).toHaveBeenCalledTimes(3);
  });

  test('a set is deduplicated and sorted, a list reports its page', async () => {
    openConnection('c', fakeRedis({ 0: {
      s: { type: 'set', value: ['b', 'a', 'b'] },
      l: { type: 'list', value: ['x', 'y'] },
    } }));
    expect((await databaseService.redis('c', { action: 'info', key: 's' })).info).toMatchObject({ value: '["a","b"]', shown: 2 });
    expect((await databaseService.redis('c', { action: 'info', key: 'l' })).info).toMatchObject({ value: '["x","y"]', shown: 2, length: 2 });
  });

  test('a stream shows its newest entries first, fields as an object', async () => {
    openConnection('c', fakeRedis({ 0: { st: { type: 'stream', value: [['1-0', ['a', '1']], ['2-0', ['b', '2', 'c', '3']]] } } }));
    const { info } = await databaseService.redis('c', { action: 'info', key: 'st' });
    expect(JSON.parse(info.value)).toEqual([{ id: '2-0', fields: { b: '2', c: '3' } }, { id: '1-0', fields: { a: '1' } }]);
    expect(info).toMatchObject({ length: 2, shown: 2 });
  });

  test('a RedisJSON document is read with JSON.GET', async () => {
    openConnection('c', fakeRedis({ 0: { j: { type: 'ReJSON-RL', value: '{"a":1}' } } }));
    const { info } = await databaseService.redis('c', { action: 'info', key: 'j' });
    expect(info).toMatchObject({ type: 'ReJSON-RL', value: '{"a":1}', size: 7 });
  });

  test('key listing can carry each key type, aligned with the sorted keys', async () => {
    openConnection('c', fakeRedis({ 0: { b: { type: 'hash', value: {} }, a: { type: 'string', value: '' } } }));
    const result = await databaseService.redis('c', { action: 'keys', withTypes: true });
    expect(result).toMatchObject({ keys: ['a', 'b'], types: ['string', 'hash'] });
    expect((await databaseService.redis('c', { action: 'keys' })).types).toBeUndefined();
  });
});

describe('DatabaseService.redis key actions', () => {
  const str = (value, extra = {}) => ({ type: 'string', value, ...extra });

  test('delete removes the key through UNLINK', async () => {
    const data = { 0: { a: str('1') } };
    const client = fakeRedis(data);
    openConnection('c', client);
    expect(await databaseService.redis('c', { action: 'delete', key: 'a' })).toEqual({ success: true, deleted: true });
    expect(data[0].a).toBeUndefined();
    expect(client.duplicates[0].unlink).toHaveBeenCalledWith('a');
  });

  test('delete falls back to DEL on a server without UNLINK', async () => {
    const data = { 0: { a: str('1') } };
    const client = fakeRedis(data);
    const realDuplicate = client.duplicate;
    client.duplicate = jest.fn((opts) => {
      const dup = realDuplicate(opts);
      dup.unlink = jest.fn(async () => { throw new Error("ERR unknown command 'unlink'"); });
      return dup;
    });
    openConnection('c', client);
    expect(await databaseService.redis('c', { action: 'delete', key: 'a' })).toEqual({ success: true, deleted: true });
    expect(data[0].a).toBeUndefined();
  });

  test('a positive expiry sets it, anything else removes it', async () => {
    const data = { 0: { a: str('1') } };
    openConnection('c', fakeRedis(data));
    const set = await databaseService.redis('c', { action: 'expire', key: 'a', seconds: 90 });
    expect(set.info).toMatchObject({ ttl: 90, pttl: 90000 });
    const removed = await databaseService.redis('c', { action: 'expire', key: 'a', seconds: 0 });
    expect(removed.info).toMatchObject({ ttl: null, pttl: null });
    // Removing an expiry that is already absent is not an error
    expect((await databaseService.redis('c', { action: 'expire', key: 'a' })).success).toBe(true);
    expect(await databaseService.redis('c', { action: 'expire', key: 'nope', seconds: 5 }))
      .toEqual({ success: false, error: 'Key "nope" does not exist' });
  });

  test('rename refuses to overwrite an existing key', async () => {
    const data = { 0: { a: str('1'), b: str('2') } };
    openConnection('c', fakeRedis(data));
    expect(await databaseService.redis('c', { action: 'rename', key: 'a', newKey: 'b' }))
      .toEqual({ success: false, error: 'Key "b" already exists' });
    expect(data[0].b.value).toBe('2');
    const moved = await databaseService.redis('c', { action: 'rename', key: 'a', newKey: 'c' });
    expect(moved.info).toMatchObject({ key: 'c', value: '1' });
  });

  test('saving a string keeps its expiry', async () => {
    const data = { 0: { a: str('old', { ttlMs: 45000 }) } };
    openConnection('c', fakeRedis(data));
    const result = await databaseService.redis('c', { action: 'setString', key: 'a', value: 'new' });
    expect(result.info).toMatchObject({ value: 'new', pttl: 45000 });
  });

  test('saving refuses a key that is not a string', async () => {
    openConnection('c', fakeRedis({ 0: { h: { type: 'hash', value: {} } } }));
    expect(await databaseService.redis('c', { action: 'setString', key: 'h', value: 'x' }))
      .toEqual({ success: false, error: 'Key "h" holds a hash, not a string' });
    expect(await databaseService.redis('c', { action: 'setString', key: 'h' }))
      .toEqual({ success: false, error: 'A string value is required' });
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

  test('a module command goes through call(), a core one through its method', async () => {
    const client = fakeRedis({ 0: { doc: { type: 'ReJSON-RL', value: '{"a":1}' }, k: { type: 'string', value: 'v' } } });
    expect((await databaseService._executeRedis(client, 'JSON.GET doc', 100)).rows).toEqual([{ result: '{"a":1}' }]);
    expect(client.call).toHaveBeenCalledWith('json.get', 'doc');
    await databaseService._executeRedis(client, 'GET k', 100);
    expect(client.get).toHaveBeenCalledWith('k');
  });

  test('refuses administrative commands and the writing members of a command family', async () => {
    const client = fakeRedis({ 0: {} });
    await expect(databaseService._executeRedis(client, 'FLUSHDB', 100)).rejects.toThrow('Redis command "FLUSHDB" is not allowed');
    await expect(databaseService._executeRedis(client, 'MEMORY PURGE', 100)).rejects.toThrow('"MEMORY PURGE" is not allowed. Allowed: MEMORY USAGE, MEMORY STATS, MEMORY HELP');
  });

  test('nested replies are shown as JSON rather than flattened', async () => {
    const client = fakeRedis({ 0: {} });
    client.xrange = jest.fn(async () => [['1-0', ['temp', '21']]]);
    const result = await databaseService._executeRedis(client, 'XRANGE s - +', 100);
    expect(result.rows).toEqual([{ value: '["1-0",["temp","21"]]' }]);
  });

  test('a key filter is matched literally, not as a glob', () => {
    expect(databaseService._redisGlobEscape('user[1]*?')).toBe('user\\[1\\]\\*\\?');
    expect(databaseService._redisGlobEscape('a\\b')).toBe('a\\\\b');
  });
});
