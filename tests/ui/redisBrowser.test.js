// Redis key browser: tree building, filtering locally or on the server, and repaints

const { buildRedisTree, leafName, formatTtl, canFilterLocally } = require('../../src/renderer/ui/panels/database/redisTree');
const { createRedisBrowser, dbIndexOf } = require('../../src/renderer/ui/panels/database/redisBrowser');

const flush = () => new Promise(r => setTimeout(r, 0));

describe('redisTree', () => {
  test('groups keys into folders on the separator', () => {
    const tree = buildRedisTree(['user:1:name', 'user:2:name', 'config'], '', ':');
    expect([...tree.children.keys()]).toEqual(['user']);
    expect(tree.keys).toEqual(['config']);
    expect(tree.keyCount).toBe(3);
    expect(tree.children.get('user').keyCount).toBe(2);
  });

  test('an empty separator gives a flat list', () => {
    const tree = buildRedisTree(['a:b', 'c:d'], '', '');
    expect(tree.children.size).toBe(0);
    expect(tree.keys).toEqual(['a:b', 'c:d']);
  });

  test('filters case-insensitively', () => {
    expect(buildRedisTree(['User:1', 'order:2'], 'user').keyCount).toBe(1);
  });

  test('leaf name follows the separator', () => {
    expect(leafName('a:b:c', ':')).toBe('c');
    expect(leafName('a.b', '.')).toBe('b');
    expect(leafName('a:b', '')).toBe('a:b');
  });

  test('formats a TTL for reading', () => {
    expect(formatTtl(42)).toBe('42s');
    expect(formatTtl(125)).toBe('2m 5s');
    expect(formatTtl(7260)).toBe('2h 1m');
  });

  test('filters locally only when the loaded list is sure to hold every match', () => {
    // complete list, any filter narrows it
    expect(canFilterLocally({ filter: 'abc', loadedPattern: '', truncated: false })).toBe(true);
    // loaded for "ab", "abc" narrows it
    expect(canFilterLocally({ filter: 'ABC', loadedPattern: 'ab', truncated: false })).toBe(true);
    // loaded for "ab", "a" is wider
    expect(canFilterLocally({ filter: 'a', loadedPattern: 'ab', truncated: false })).toBe(false);
    // partial list: only the exact pattern it was loaded for
    expect(canFilterLocally({ filter: 'abc', loadedPattern: '', truncated: true })).toBe(false);
    expect(canFilterLocally({ filter: '', loadedPattern: '', truncated: true })).toBe(true);
  });

  test('formats memory in binary units', () => {
    const { formatBytes } = require('../../src/renderer/ui/panels/database/redisTree');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(950 * 1024 * 1024)).toBe('950 MB');
    expect(formatBytes(null)).toBe('?');
  });

  test('reads the db index out of the table name', () => {
    expect(dbIndexOf('db:12')).toBe(12);
    expect(dbIndexOf('nonsense')).toBe(0);
  });
});

describe('redisCompletions', () => {
  const { redisCompletions } = require('../../src/renderer/ui/panels/database/redisCompletion');
  const keys = ['user:1', 'user:2', 'order:9', 'has space'];

  test('completes a command at the start of a line, with its signature', () => {
    const r = redisCompletions('hge', 3, keys);
    expect(r.partialStart).toBe(0);
    expect(r.suggestions.map(s => s.text)).toEqual(['HGET', 'HGETALL']);
    expect(r.suggestions[0]).toMatchObject({ type: 'keyword', detail: 'key field' });
  });

  test('completes a key where the command takes one', () => {
    const r = redisCompletions('GET us', 6, keys);
    expect(r.partialStart).toBe(4);
    expect(r.suggestions.map(s => s.text)).toEqual(['user:1', 'user:2']);
  });

  test('every position of a variadic key list takes a key', () => {
    expect(redisCompletions('DEL user:1 ord', 14, keys).suggestions.map(s => s.text)).toEqual(['order:9']);
  });

  test('offers nothing where the argument is not a key', () => {
    // SET key value: the value is free text
    expect(redisCompletions('SET user:1 us', 13, keys)).toBeNull();
    expect(redisCompletions('NOPE x', 6, keys)).toBeNull();
    expect(redisCompletions('GET ', 4, keys)).toBeNull();
  });

  test('quotes a key that holds a space, and works on the current line only', () => {
    expect(redisCompletions('GET ha', 6, keys).suggestions[0].text).toBe('"has space"');
    const text = 'GET user:1\nEXI';
    expect(redisCompletions(text, text.length, keys).suggestions.map(s => s.text)).toEqual(['EXISTS']);
  });
});

describe('redisUrl', () => {
  const { parseRedisUrl, buildRedisUrl } = require('../../src/renderer/ui/panels/database/redisUrl');

  test('reads a provider URL, TLS included', () => {
    expect(parseRedisUrl('rediss://default:s3cr%40t@eu1.upstash.io:6380/2')).toEqual({
      host: 'eu1.upstash.io', port: 6380, username: 'default', password: 's3cr@t', database: 2, tls: true,
    });
  });

  test('fills the defaults a short URL leaves out', () => {
    expect(parseRedisUrl('redis://localhost')).toEqual({ host: 'localhost', port: 6379, username: '', password: '', database: 0, tls: false });
    // Password with no user: the pre-ACL form
    expect(parseRedisUrl('redis://:pw@cache:7000')).toMatchObject({ username: '', password: 'pw', port: 7000 });
  });

  test('refuses anything that is not a redis URL', () => {
    expect(parseRedisUrl('postgres://x@y/z')).toBeNull();
    expect(parseRedisUrl('localhost:6379')).toBeNull();
    expect(parseRedisUrl('')).toBeNull();
  });

  test('builds the URL a connection card shows, without the password', () => {
    expect(buildRedisUrl({ host: 'h', port: 6380, username: 'app', database: 1, tls: true, password: 'x' })).toBe('rediss://app@h:6380/1');
    expect(buildRedisUrl({ host: 'localhost', port: 6379, database: 0 })).toBe('redis://localhost:6379/0');
  });
});

describe('createRedisBrowser', () => {
  let api, browser, container;

  function mount() {
    container.innerHTML = browser.render();
    browser.bind(container);
  }

  beforeEach(() => {
    jest.useRealTimers();
    document.body.innerHTML = '<div id="root"></div>';
    container = document.getElementById('root');
    api = {
      redis: jest.fn(async ({ action, pattern }) => {
        if (action === 'keys') {
          const all = ['app:config', 'user:1', 'user:2'];
          return { success: true, keys: all.filter(k => !pattern || k.includes(pattern)), truncated: false, total: 3 };
        }
        return { success: true, info: { key: 'user:1', type: 'string', ttl: null, pttl: null, size: 3, length: null, value: 'abc' } };
      }),
    };
    browser = createRedisBrowser({
      api,
      getActiveId: () => 'conn',
      t: (k, p) => (p ? `${k} ${JSON.stringify(p)}` : k),
      escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
      showToast: jest.fn(),
    });
  });

  test('selecting a db loads its keys into the tree', async () => {
    browser.select('db:1');
    mount();
    await flush();
    expect(api.redis).toHaveBeenCalledWith({ id: 'conn', action: 'keys', db: 1, pattern: '', withTypes: true });
    expect(container.querySelector('#redis-tree-count').textContent).toBe('3');
    expect(container.querySelectorAll('.redis-tree-folder')).toHaveLength(2);
  });

  test('filtering a complete list stays local and repaints only the tree', async () => {
    jest.useFakeTimers();
    browser.select('db:0');
    mount();
    await Promise.resolve(); await Promise.resolve();
    const input = container.querySelector('#redis-tree-filter');
    const calls = api.redis.mock.calls.length;

    input.value = 'user';
    input.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(200);

    expect(api.redis.mock.calls.length).toBe(calls);
    expect(container.querySelector('#redis-tree-count').textContent).toBe('2');
    // Same input element: the frame was not rebuilt under the caret
    expect(container.querySelector('#redis-tree-filter')).toBe(input);
  });

  test('filtering a partial list asks the server', async () => {
    api.redis.mockImplementation(async ({ pattern }) => ({ success: true, keys: pattern ? ['user:1'] : ['a', 'b'], truncated: !pattern, total: 50000 }));
    browser.select('db:0');
    mount();
    await flush();
    expect(container.querySelector('.redis-tree-notice')).not.toBeNull();

    const input = container.querySelector('#redis-tree-filter');
    input.value = 'user';
    input.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 200));
    await flush();

    expect(api.redis).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'keys', pattern: 'user' }));
    expect(container.querySelector('#redis-tree-count').textContent).toBe('1');
    expect(container.querySelector('.redis-tree-notice')).toBeNull();
  });

  test('an answer for a db that is no longer selected is dropped', async () => {
    let release;
    const answer = api.redis.getMockImplementation();
    // Hold back the key list of db:1 only
    api.redis.mockImplementation((req) => (req.action === 'keys' && req.db === 1
      ? new Promise(r => { release = r; })
      : answer(req)));
    browser.select('db:1');
    browser.select('db:2');
    mount();
    await flush();
    release({ success: true, keys: ['stale'], truncated: false, total: 1 });
    await flush();
    expect(container.querySelector('[data-redis-key="stale"]')).toBeNull();
    expect(browser._state.keys).toEqual(['app:config', 'user:1', 'user:2']);
  });

  test('shows the server overview until a key is picked, flagging what needs attention', async () => {
    api.redis.mockImplementation(async ({ action }) => (action === 'server'
      ? { success: true, server: {
        version: '7.2.4', mode: 'standalone', role: 'master', usedMemory: 950 * 1024 * 1024, maxMemory: 1024 * 1024 * 1024,
        maxMemoryPolicy: 'allkeys-lru', evictedKeys: 12, hitRate: 0.8734, clients: 3, blockedClients: 0,
        opsPerSec: 40, uptimeSeconds: 90000, aofEnabled: false, fragmentation: 1.1, peakMemory: null, expiredKeys: 5, keyspace: [],
      } }
      : { success: true, keys: [], truncated: false, total: 0 }));
    browser.select('db:0');
    mount();
    await flush();
    const detail = container.querySelector('#redis-detail-panel');
    expect(detail.querySelector('.redis-server-title').textContent).toBe('Redis 7.2.4 · standalone');
    const warned = [...detail.querySelectorAll('.redis-server-cell.warning .redis-server-label')].map(e => e.textContent);
    expect(warned).toEqual(['database.redisMemory', 'database.redisEvictedKeys']);
    expect(detail.textContent).toContain('87.3%');
    expect(detail.textContent).toContain('allkeys-lru');
  });

  test('an INFO denied by an ACL leaves the browser usable and says why', async () => {
    api.redis.mockImplementation(async ({ action }) => (action === 'server'
      ? { success: false, error: 'NOPERM this user has no permissions to run the info command' }
      : { success: true, keys: ['a'], truncated: false, total: 1 }));
    browser.select('db:0');
    mount();
    await flush();
    expect(container.querySelector('.redis-server-error').textContent).toContain('NOPERM');
    expect(container.querySelector('[data-redis-key="a"]')).not.toBeNull();
  });

  test('marks each key with its type and asks for types when listing', async () => {
    api.redis.mockImplementation(async ({ action }) => (action === 'keys'
      ? { success: true, keys: ['h', 's'], types: ['hash', 'ReJSON-RL'], truncated: false, total: 2 }
      : { success: false, error: 'x' }));
    browser.select('db:0');
    mount();
    await flush();
    expect(api.redis).toHaveBeenCalledWith(expect.objectContaining({ withTypes: true }));
    expect(container.querySelector('[data-redis-key="h"]').classList.contains('type-hash')).toBe(true);
    expect(container.querySelector('[data-redis-key="s"]').classList.contains('type-rejson-rl')).toBe(true);
  });

  test('the separator regroups the tree and is handed back to be saved', async () => {
    const saved = [];
    browser = createRedisBrowser({
      api,
      getActiveId: () => 'conn',
      t: k => k,
      escapeHtml: s => String(s),
      showToast: jest.fn(),
      getSeparator: () => '.',
      setSeparator: sep => saved.push(sep),
    });
    api.redis.mockImplementation(async () => ({ success: true, keys: ['a.b', 'a.c', 'x:y'], truncated: false, total: 3 }));
    browser.select('db:0');
    mount();
    await flush();
    expect(container.querySelector('#redis-tree-separator').value).toBe('.');
    expect([...container.querySelectorAll('.redis-tree-folder-name')].map(e => e.textContent)).toEqual(['a']);

    const select = container.querySelector('#redis-tree-separator');
    select.value = ':';
    select.dispatchEvent(new Event('change'));
    expect([...container.querySelectorAll('.redis-tree-folder-name')].map(e => e.textContent)).toEqual(['x']);
    expect(saved).toEqual([':']);
  });

  test('a partial collection says so above its items, and a stream renders its entries', async () => {
    api.redis.mockImplementation(async ({ action }) => (action === 'keys'
      ? { success: true, keys: ['st'], truncated: false, total: 1 }
      : { success: true, info: { key: 'st', type: 'stream', ttl: null, pttl: null, length: 1200, shown: 100, value: JSON.stringify([{ id: '9-0', fields: { temp: '21' } }]) } }));
    browser.select('db:0');
    mount();
    await flush();
    container.querySelector('[data-redis-key="st"]').click();
    await flush();
    expect(container.querySelector('.redis-value-partial').textContent).toContain('database.redisStreamPartial');
    expect(container.querySelector('.redis-stream-id').textContent).toBe('9-0');
    expect(container.querySelector('.redis-type-badge').textContent).toBe('STREAM');
  });

  test('toggling a folder and picking a key fill the tree and the detail', async () => {
    browser.select('db:0');
    mount();
    await flush();
    container.querySelector('[data-folder-toggle="user"]').click();
    const keyEl = container.querySelector('[data-redis-key="user:1"]');
    expect(keyEl).not.toBeNull();
    keyEl.click();
    await flush();
    expect(api.redis).toHaveBeenLastCalledWith({ id: 'conn', action: 'info', db: 0, key: 'user:1' });
    expect(container.querySelector('.redis-detail-key-name').textContent).toBe('user:1');
    expect(container.querySelector('[data-redis-key="user:1"]').classList.contains('active')).toBe(true);
  });
});
