const { createCache } = require('../../src/main/utils/httpCache');

describe('createCache', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns an object with getCached, setCache, invalidateCache', () => {
    const cache = createCache();
    expect(typeof cache.getCached).toBe('function');
    expect(typeof cache.setCache).toBe('function');
    expect(typeof cache.invalidateCache).toBe('function');
  });

  test('each createCache() returns an independent instance', () => {
    const cache1 = createCache();
    const cache2 = createCache();
    cache1.setCache('key', 'value1', 60000);
    expect(cache1.getCached('key')).toBe('value1');
    expect(cache2.getCached('key')).toBeNull();
  });
});

describe('setCache + getCached', () => {
  let cache;

  beforeEach(() => {
    jest.useFakeTimers();
    cache = createCache();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('stores and retrieves a string value', () => {
    cache.setCache('key1', 'hello', 5000);
    expect(cache.getCached('key1')).toBe('hello');
  });

  test('stores and retrieves an object value', () => {
    const data = { name: 'test', count: 42 };
    cache.setCache('obj', data, 5000);
    expect(cache.getCached('obj')).toEqual({ name: 'test', count: 42 });
  });

  test('stores and retrieves an array value', () => {
    cache.setCache('arr', [1, 2, 3], 5000);
    expect(cache.getCached('arr')).toEqual([1, 2, 3]);
  });

  test('stores null as a value', () => {
    cache.setCache('nullable', null, 5000);
    // null is falsy, so getCached returns null for both "no entry" and "stored null"
    // but the entry does exist — the function checks Date.now() < expiresAt
    // Since data is null, it will still pass the condition but return null
    expect(cache.getCached('nullable')).toBeNull();
  });

  test('returns null for non-existent key', () => {
    expect(cache.getCached('nonexistent')).toBeNull();
  });

  test('overwrites existing entry with same key', () => {
    cache.setCache('key', 'first', 5000);
    cache.setCache('key', 'second', 5000);
    expect(cache.getCached('key')).toBe('second');
  });

  test('returns value before TTL expires', () => {
    cache.setCache('ttl-key', 'data', 1000);
    jest.advanceTimersByTime(999);
    expect(cache.getCached('ttl-key')).toBe('data');
  });

  test('returns null after TTL expires', () => {
    cache.setCache('ttl-key', 'data', 1000);
    jest.advanceTimersByTime(1001);
    expect(cache.getCached('ttl-key')).toBeNull();
  });

  test('returns null exactly at TTL boundary', () => {
    cache.setCache('boundary', 'data', 1000);
    jest.advanceTimersByTime(1000);
    // Date.now() === expiresAt means NOT less than, so it should expire
    expect(cache.getCached('boundary')).toBeNull();
  });

  test('expired entry is deleted from cache on get', () => {
    cache.setCache('expire-me', 'val', 500);
    jest.advanceTimersByTime(501);
    // First get returns null and deletes entry
    expect(cache.getCached('expire-me')).toBeNull();
    // Set a new value — if entry was deleted, this should work cleanly
    cache.setCache('expire-me', 'new-val', 5000);
    expect(cache.getCached('expire-me')).toBe('new-val');
  });

  test('multiple keys with different TTLs expire independently', () => {
    cache.setCache('short', 'a', 1000);
    cache.setCache('long', 'b', 5000);
    jest.advanceTimersByTime(1001);
    expect(cache.getCached('short')).toBeNull();
    expect(cache.getCached('long')).toBe('b');
  });

  test('handles very large TTL values', () => {
    cache.setCache('long-lived', 'data', 999999999);
    jest.advanceTimersByTime(100000);
    expect(cache.getCached('long-lived')).toBe('data');
  });

  test('handles zero TTL (expires immediately)', () => {
    cache.setCache('instant', 'data', 0);
    // Date.now() === expiresAt (Date.now() + 0), so not less than → null
    expect(cache.getCached('instant')).toBeNull();
  });
});

describe('invalidateCache', () => {
  let cache;

  beforeEach(() => {
    jest.useFakeTimers();
    cache = createCache();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('removes entries matching exact prefix', () => {
    cache.setCache('api:users', 'data1', 5000);
    cache.setCache('api:posts', 'data2', 5000);
    cache.setCache('other:key', 'data3', 5000);
    cache.invalidateCache('api:');
    expect(cache.getCached('api:users')).toBeNull();
    expect(cache.getCached('api:posts')).toBeNull();
    expect(cache.getCached('other:key')).toBe('data3');
  });

  test('removes nothing when prefix matches nothing', () => {
    cache.setCache('key1', 'val1', 5000);
    cache.invalidateCache('nonexistent:');
    expect(cache.getCached('key1')).toBe('val1');
  });

  test('removes all entries when prefix is empty string', () => {
    cache.setCache('a', 'val1', 5000);
    cache.setCache('b', 'val2', 5000);
    cache.invalidateCache('');
    expect(cache.getCached('a')).toBeNull();
    expect(cache.getCached('b')).toBeNull();
  });

  test('removes single entry when prefix matches exactly one key', () => {
    cache.setCache('unique-key', 'val', 5000);
    cache.setCache('other-key', 'val2', 5000);
    cache.invalidateCache('unique-key');
    expect(cache.getCached('unique-key')).toBeNull();
    expect(cache.getCached('other-key')).toBe('val2');
  });

  test('handles invalidation on empty cache without error', () => {
    expect(() => cache.invalidateCache('any:')).not.toThrow();
  });
});
