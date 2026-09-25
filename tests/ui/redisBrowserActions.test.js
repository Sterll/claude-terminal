// Redis key browser: copy, delete, edit, rename, expiry, and the live TTL

const { createRedisBrowser, editableValue, remainingMs } = require('../../src/renderer/ui/panels/database/redisBrowser');

const flush = () => new Promise(r => setTimeout(r, 0));

describe('editableValue', () => {
  test('pretty-prints JSON and remembers whether it was minified', () => {
    expect(editableValue('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', json: true, compact: true });
    expect(editableValue('{\n  "a": 1\n}')).toMatchObject({ json: true, compact: false });
  });

  test('leaves scalars and text alone', () => {
    expect(editableValue('42')).toEqual({ text: '42', json: false, compact: false });
    expect(editableValue('hello')).toEqual({ text: 'hello', json: false, compact: false });
    expect(editableValue(null).text).toBe('');
  });
});

describe('remainingMs', () => {
  test('counts down from the PTTL read at fetch time', () => {
    expect(remainingMs({ pttl: 5000, fetchedAt: 1000 }, 3000)).toBe(3000);
    expect(remainingMs({ pttl: null, fetchedAt: 1000 }, 3000)).toBeNull();
  });
});

describe('createRedisBrowser key actions', () => {
  let api, browser, container, confirmAnswer, copied, counts, keys;

  const store = () => ({
    'user:1': { type: 'string', value: '{"name":"a","n":1}', pttl: null },
    'user:2': { type: 'string', value: 'plain', pttl: 2000 },
  });

  function infoOf(key) {
    const k = keys[key];
    return { key, type: k.type, value: k.value, pttl: k.pttl, ttl: k.pttl ? Math.ceil(k.pttl / 1000) : null, size: k.value.length, length: null };
  }

  async function openKey(key) {
    container.innerHTML = browser.render();
    browser.bind(container);
    await flush();
    container.querySelector('[data-folder-toggle="user"]').click();
    container.querySelector(`[data-redis-key="${key}"]`).click();
    await flush();
  }

  const action = (name) => container.querySelector(`[data-redis-action="${name}"]`);

  beforeEach(() => {
    jest.useRealTimers();
    keys = store();
    confirmAnswer = true;
    copied = [];
    counts = [];
    document.body.innerHTML = '<div id="root"></div>';
    container = document.getElementById('root');
    api = {
      redis: jest.fn(async (req) => {
        switch (req.action) {
          case 'keys': return { success: true, keys: Object.keys(keys).sort(), truncated: false, total: Object.keys(keys).length };
          case 'info': return keys[req.key] ? { success: true, info: infoOf(req.key) } : { success: false, error: `Key "${req.key}" does not exist` };
          case 'delete': delete keys[req.key]; return { success: true, deleted: true };
          case 'setString': keys[req.key].value = req.value; return { success: true, info: infoOf(req.key) };
          case 'rename': keys[req.newKey] = keys[req.key]; delete keys[req.key]; return { success: true, info: infoOf(req.newKey) };
          case 'expire': keys[req.key].pttl = req.seconds ? req.seconds * 1000 : null; return { success: true, info: infoOf(req.key) };
        }
        return { success: false, error: 'unexpected' };
      }),
    };
    browser = createRedisBrowser({
      api,
      getActiveId: () => 'conn',
      t: (k, p) => (p ? `${k} ${JSON.stringify(p)}` : k),
      escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
      showToast: jest.fn(),
      copyText: async (text) => { copied.push(text); return true; },
      onKeyCountChange: (db, delta) => counts.push([db, delta]),
      modal: { ...require('../../src/renderer/ui/components/Modal'), showConfirm: async () => confirmAnswer },
    });
    browser.select('db:0');
  });

  afterEach(() => {
    browser.destroy();
    jest.useRealTimers();
  });

  test('copies the key name and the raw value', async () => {
    await openKey('user:1');
    action('copy-key').click();
    action('copy-value').click();
    await flush();
    expect(copied).toEqual(['user:1', '{"name":"a","n":1}']);
  });

  test('delete asks first, then drops the key from the tree and the count', async () => {
    await openKey('user:1');
    confirmAnswer = false;
    action('delete').click();
    await flush();
    expect(api.redis).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'delete' }));

    confirmAnswer = true;
    action('delete').click();
    await flush(); await flush();
    expect(api.redis).toHaveBeenCalledWith({ id: 'conn', db: 0, action: 'delete', key: 'user:1' });
    expect(container.querySelector('[data-redis-key="user:1"]')).toBeNull();
    expect(counts).toEqual([['db:0', -1]]);
  });

  test('editing minified JSON shows it pretty and saves it minified', async () => {
    await openKey('user:1');
    action('edit').click();
    const editor = container.querySelector('#redis-value-editor');
    expect(editor.value).toBe('{\n  "name": "a",\n  "n": 1\n}');
    editor.value = '{\n  "name": "b",\n  "n": 1\n}';
    action('edit-save').click();
    await flush(); await flush();
    expect(api.redis).toHaveBeenCalledWith(expect.objectContaining({ action: 'setString', key: 'user:1', value: '{"name":"b","n":1}' }));
    expect(container.querySelector('#redis-value-editor')).toBeNull();
  });

  test('escape leaves the editor without saving', async () => {
    await openKey('user:1');
    action('edit').click();
    container.querySelector('#redis-value-editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(container.querySelector('#redis-value-editor')).toBeNull();
    expect(api.redis).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'setString' }));
  });

  test('the TTL counts down and the key is marked expired when it runs out', async () => {
    await openKey('user:2');
    jest.useFakeTimers();
    browser.destroy(); // restart the countdown under fake timers
    browser.bind(container);
    const label = () => container.querySelector('#redis-ttl-text').textContent;
    expect(label()).toMatch(/^2s/);
    // Fake timers move Date.now() too: 1.5 s elapsed of a 2 s TTL
    browser._state.info.fetchedAt = Date.now() - 500;
    jest.advanceTimersByTime(1000);
    expect(label()).toMatch(/^1s/);
    jest.advanceTimersByTime(1000);
    expect(label()).toBe('database.redisExpired');
    expect(container.querySelector('.redis-detail.expired')).not.toBeNull();
    expect(container.querySelector('[data-redis-key="user:2"]').classList.contains('gone')).toBe(true);
    expect(action('delete').disabled).toBe(true);
  });

  test('a key that vanished before it was opened says so instead of erroring', async () => {
    await openKey('user:1');
    delete keys['user:2'];
    container.querySelector('[data-redis-key="user:2"]').click();
    await flush();
    expect(container.querySelector('#redis-detail-panel').textContent).toContain('database.redisKeyGone');
    expect(container.querySelector('[data-redis-key="user:2"]').classList.contains('gone')).toBe(true);
  });

  test('rename goes through a prompt and follows the key', async () => {
    await openKey('user:1');
    action('rename').click();
    const input = document.getElementById('redis-rename-modal-input');
    expect(input.value).toBe('user:1');
    input.value = 'user:9';
    document.querySelector('#redis-rename-modal [data-action="save"]').click();
    await flush(); await flush();
    expect(api.redis).toHaveBeenCalledWith(expect.objectContaining({ action: 'rename', key: 'user:1', newKey: 'user:9' }));
    expect(container.querySelector('[data-redis-key="user:9"]').classList.contains('active')).toBe(true);
    expect(container.querySelector('.redis-detail-key-name').textContent).toBe('user:9');
  });

  test('an empty expiry removes it', async () => {
    await openKey('user:2');
    action('ttl').click();
    const input = document.getElementById('redis-ttl-modal-input');
    input.value = '';
    document.querySelector('#redis-ttl-modal [data-action="save"]').click();
    await flush(); await flush();
    expect(api.redis).toHaveBeenCalledWith(expect.objectContaining({ action: 'expire', key: 'user:2', seconds: 0 }));
    expect(container.querySelector('#redis-ttl-text').textContent).toBe('database.redisNoExpiry');
  });
});
