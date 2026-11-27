/**
 * discovery.json follows the rule every JSON store in the app follows: absent
 * is a fresh start, unreadable is not. An unreadable file must never be
 * rewritten, or a "Don't show again" would be lost to one bad read.
 */

const { createDiscoveryStore } = require('../../src/renderer/services/discovery/store');

function makeStore({ read }) {
  const writes = [];
  const store = createDiscoveryStore({
    readFile: async () => read(),
    writeJSON: async (file, data) => { writes.push({ file, data }); },
    file: '/data/discovery.json',
    debounceMs: 5,
    log: { warn: () => {} },
  });
  return { store, writes };
}

const enoent = () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };

describe('discovery store', () => {
  test('an absent file is a fresh, usable store', async () => {
    const { store } = makeStore({ read: enoent });
    expect(await store.load()).toEqual({ ok: true, fresh: true });
    expect(store.isUsable()).toBe(true);
    expect(store.get()).toMatchObject({ lastShownAt: 0, rules: {}, used: {} });
  });

  // What the preload bridge actually hands the renderer: contextBridge keeps
  // an Error's message and drops `code`. Seen in the wild as "store unreadable,
  // suggestions are off" on every first launch.
  test('an absent file reported through the preload bridge (no code) is a fresh store', async () => {
    const bridged = () => { throw new Error("ENOENT: no such file or directory, open '/home/x/.claude-terminal/discovery.json'"); };
    const { store } = makeStore({ read: bridged });
    expect(await store.load()).toEqual({ ok: true, fresh: true });
    expect(store.isUsable()).toBe(true);
  });

  test('a saved file is read back', async () => {
    const saved = { version: 1, lastShownAt: 42, rules: { a: { dismissed: true } }, used: { 'tab:x': 1 } };
    const { store } = makeStore({ read: () => JSON.stringify(saved) });
    await store.load();
    expect(store.get()).toMatchObject(saved);
  });

  test('missing sections are filled in, not trusted', async () => {
    const { store } = makeStore({ read: () => JSON.stringify({ lastShownAt: 5, rules: 'oops' }) });
    await store.load();
    expect(store.get().rules).toEqual({});
    expect(store.get().used).toEqual({});
  });

  test.each([
    ['truncated JSON', () => '{"rules": {"a": {"dism'],
    ['an empty file', () => ''],
    ['an array', () => '[]'],
    ['a read error other than absence', () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }],
  ])('%s leaves the store unusable and the file untouched', async (_label, read) => {
    const { store, writes } = makeStore({ read });
    expect((await store.load()).ok).toBe(false);
    expect(store.isUsable()).toBe(false);
    store.update((s) => { s.lastShownAt = 99; });
    await store.flush();
    await new Promise(r => setTimeout(r, 20));
    expect(writes).toEqual([]);
  });

  test('updates are debounced into one atomic write of a snapshot', async () => {
    const { store, writes } = makeStore({ read: enoent });
    await store.load();
    store.update((s) => { s.lastShownAt = 1; });
    store.update((s) => { s.used['tab:x'] = 2; });
    await new Promise(r => setTimeout(r, 30));
    expect(writes).toHaveLength(1);
    expect(writes[0].file).toBe('/data/discovery.json');
    expect(writes[0].data).toMatchObject({ lastShownAt: 1, used: { 'tab:x': 2 } });
    // A snapshot, so a later mutation does not leak into a write in flight.
    store.get().lastShownAt = 7;
    expect(writes[0].data.lastShownAt).toBe(1);
  });

  test('flush writes at once', async () => {
    const { store, writes } = makeStore({ read: enoent });
    await store.load();
    store.update((s) => { s.lastShownAt = 3; });
    await store.flush();
    expect(writes).toHaveLength(1);
  });

  test('nothing is written before the file was read', async () => {
    const { store, writes } = makeStore({ read: enoent });
    store.update((s) => { s.lastShownAt = 3; });
    await store.flush();
    expect(writes).toEqual([]);
  });
});
