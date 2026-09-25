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

  test('reads the db index out of the table name', () => {
    expect(dbIndexOf('db:12')).toBe(12);
    expect(dbIndexOf('nonsense')).toBe(0);
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
    expect(api.redis).toHaveBeenCalledWith({ id: 'conn', action: 'keys', db: 1, pattern: '' });
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
    api.redis.mockImplementationOnce(() => new Promise(r => { release = r; }));
    browser.select('db:1');
    browser.select('db:2');
    mount();
    await flush();
    release({ success: true, keys: ['stale'], truncated: false, total: 1 });
    await flush();
    expect(container.querySelector('[data-redis-key="stale"]')).toBeNull();
    expect(browser._state.keys).toEqual(['app:config', 'user:1', 'user:2']);
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
