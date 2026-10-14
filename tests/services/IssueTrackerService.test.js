/**
 * Issue tracker connections. What matters here is where the key goes: into the
 * credential store, never into issue-trackers.json and never back out to the
 * renderer. And, like every JSON store in the app, an unreadable file is left
 * alone rather than answered with an empty list.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { setImmediate: realImmediate } = require('timers');
const { createIssueTrackerService, maskKey } = require('../../src/main/services/IssueTrackerService');
const { describeTrackers } = require('../../src/main/issue-trackers/_registry');
const fake = require('../issue-trackers/fake.tracker');
const fixture = require('../issue-trackers/fixtures/fake.fixture');

// A second workspace, so two connections can coexist in one store.
const other = {
  ...fake,
  id: 'fake-two',
  name: 'Fake Two',
  createClient: (opts) => {
    const client = fake.createClient(opts);
    return { ...client, whoAmI: async () => ({ ...(await client.whoAmI()), workspace: { id: 'acme-two', name: 'acme two', url: 'https://example.com/acme-two' } }) };
  },
};

function memorySecrets() {
  const map = new Map();
  return {
    map,
    get: async (account) => map.get(account) ?? null,
    set: async (account, value) => { map.set(account, value); },
    delete: async (account) => map.delete(account),
  };
}

const registry = {
  get: (id) => ({ fake, 'fake-two': other })[id] || null,
  describe: () => describeTrackers([fake, other]),
};

let dir;
let storePath;
let secrets;
let fetch;
let service;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-issue-trackers-'));
  storePath = path.join(dir, 'issue-trackers.json');
  secrets = memorySecrets();
  fetch = jest.fn(fixture.fetch);
  service = createIssueTrackerService({ storePath, secrets, registry, fetch, now: () => '2026-10-09T09:00:00.000Z' });
});

afterEach(() => {
  try { fs.chmodSync(dir, 0o700); } catch { /* already writable */ }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const readStore = () => JSON.parse(fs.readFileSync(storePath, 'utf8'));

describe('connect', () => {
  test('checks the key with the provider and records who it belongs to', async () => {
    const conn = await service.connect('fake', `  ${fixture.secret}\n`);
    expect(conn).toMatchObject({
      provider: 'fake',
      providerName: 'Fake Tracker',
      workspace: { id: 'acme', name: 'acme', url: 'https://example.com/acme' },
      user: { id: 'u1', name: 'Ada Lovelace', avatarUrl: 'https://example.com/ada.png' },
      connectedAt: '2026-10-09T09:00:00.000Z',
      available: true,
    });
    expect(conn.id).toMatch(/^fake-[0-9a-f]{12}$/);
    expect(secrets.map.get(`issue-tracker:${conn.id}`)).toBe(fixture.secret);
  });

  test('the key never reaches the file, and only a masked form reaches the caller', async () => {
    const conn = await service.connect('fake', fixture.secret);
    expect(fs.readFileSync(storePath, 'utf8')).not.toContain(fixture.secret);
    expect(JSON.stringify(conn)).not.toContain(fixture.secret);
    const [listed] = await service.listConnections();
    expect(JSON.stringify(listed)).not.toContain(fixture.secret);
    expect(listed.maskedKey).toBe(maskKey(fixture.secret));
  });

  test('a rejected key stores nothing', async () => {
    await expect(service.connect('fake', 'wrong-secret')).rejects.toMatchObject({ code: 'AUTH' });
    expect(fs.existsSync(storePath)).toBe(false);
    expect(secrets.map.size).toBe(0);
  });

  test('an empty key is refused without a request', async () => {
    await expect(service.connect('fake', '   ')).rejects.toMatchObject({ code: 'AUTH' });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('an unknown provider is refused', async () => {
    await expect(service.connect('jira', 'x')).rejects.toMatchObject({ code: 'PROVIDER' });
  });

  test('reconnecting the same workspace replaces the key instead of adding a twin', async () => {
    const first = await service.connect('fake', fixture.secret);
    const second = await service.connect('fake', fixture.secret);
    expect(second.id).toBe(first.id);
    expect(readStore().connections).toHaveLength(1);
  });

  test('concurrent connects do not lose each other', async () => {
    const [a, b] = await Promise.all([service.connect('fake', fixture.secret), service.connect('fake-two', fixture.secret)]);
    expect(readStore().connections.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
  });

  test('an unreadable store is left alone and no key is stored', async () => {
    fs.writeFileSync(storePath, '{"version":1,"connections":[{"id":"fake-1"');
    await expect(service.connect('fake', fixture.secret)).rejects.toThrow(/Refusing to modify issue-trackers\.json/);
    expect(fs.readFileSync(storePath, 'utf8')).toBe('{"version":1,"connections":[{"id":"fake-1"');
    expect(secrets.map.size).toBe(0);
  });

  (process.platform === 'win32' ? test.skip : test)('a failed write takes the new key back out of the credential store', async () => {
    fs.chmodSync(dir, 0o500);
    await expect(service.connect('fake', fixture.secret)).rejects.toThrow();
    expect(secrets.map.size).toBe(0);
  });
});

test('every store write keeps the previous file as .bak', async () => {
  const conn = await service.connect('fake', fixture.secret);
  expect(fs.existsSync(`${storePath}.bak`)).toBe(false); // nothing to back up on the first write
  await service.disconnect(conn.id);
  expect(JSON.parse(fs.readFileSync(`${storePath}.bak`, 'utf8')).connections.map((c) => c.id)).toEqual([conn.id]);
  expect(readStore().connections).toEqual([]);
});

describe('disconnect', () => {
  test('removes the connection and its key', async () => {
    const conn = await service.connect('fake', fixture.secret);
    await service.disconnect(conn.id);
    expect(readStore().connections).toEqual([]);
    expect(secrets.map.size).toBe(0);
  });

  test('an unknown id is a no-op', async () => {
    const conn = await service.connect('fake', fixture.secret);
    await service.disconnect('fake-unknown');
    expect(readStore().connections.map((c) => c.id)).toEqual([conn.id]);
  });
});

describe('test', () => {
  test('re-checks the stored key', async () => {
    const conn = await service.connect('fake', fixture.secret);
    await expect(service.test(conn.id)).resolves.toMatchObject({ id: conn.id, workspace: { name: 'acme' } });
  });

  test('a key removed from the credential store is reported as AUTH', async () => {
    const conn = await service.connect('fake', fixture.secret);
    secrets.map.clear();
    await expect(service.test(conn.id)).rejects.toMatchObject({ code: 'AUTH' });
  });

  test('a key that now belongs to another workspace is refused', async () => {
    const conn = await service.connect('fake', fixture.secret);
    const store = readStore();
    store.connections[0].workspace.id = 'someone-else';
    fs.writeFileSync(storePath, JSON.stringify(store));
    await expect(service.test(conn.id)).rejects.toMatchObject({ code: 'AUTH' });
  });
});

describe('client', () => {
  test('is built once per connection and talks to the provider', async () => {
    const conn = await service.connect('fake', fixture.secret);
    const client = await service.client(conn.id);
    expect(await service.client(conn.id)).toBe(client);
    const me = await client.whoAmI();
    expect(me.workspace.name).toBe('acme');
  });

  test('an unknown connection is NOT_FOUND', async () => {
    await expect(service.client('fake-unknown')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('listProviders and listConnections', () => {
  test('providers are plain data', () => {
    expect(service.listProviders().map((p) => p.id)).toEqual(['fake', 'fake-two']);
  });

  test('no file means no connections', async () => {
    await expect(service.listConnections()).resolves.toEqual([]);
  });

  test('a connection whose adapter is gone is listed as unavailable', async () => {
    fs.writeFileSync(storePath, JSON.stringify({
      version: 1,
      connections: [{ id: 'jira-1', provider: 'jira', workspace: { id: 'w', name: 'W', url: null }, user: { id: 'u', name: 'U', avatarUrl: null } }],
    }));
    const [conn] = await service.listConnections();
    expect(conn).toMatchObject({ id: 'jira-1', providerName: 'jira', available: false });
  });

  test('the credential store is read once per connection for its mask, again after a reconnect', async () => {
    const conn = await service.connect('fake', fixture.secret);
    // A fresh process: nothing cached yet.
    const fresh = createIssueTrackerService({ storePath, secrets, registry, fetch });
    const get = jest.spyOn(secrets, 'get');
    await fresh.listConnections();
    await fresh.listConnections();
    expect(get.mock.calls.filter(([account]) => account === `issue-tracker:${conn.id}`)).toHaveLength(1);

    await fresh.connect('fake', fixture.secret);
    get.mockClear();
    await fresh.listConnections();
    expect(get).not.toHaveBeenCalled(); // the reconnect re-read it
  });

  test('a credential store that fails costs the mask, and is asked again next time', async () => {
    const conn = await service.connect('fake', fixture.secret);
    const fresh = createIssueTrackerService({ storePath, secrets, registry, fetch });
    jest.spyOn(secrets, 'get').mockRejectedValueOnce(new Error('locked'));
    expect((await fresh.listConnections())[0].maskedKey).toBeNull();
    expect((await fresh.listConnections())[0]).toMatchObject({ id: conn.id, maskedKey: maskKey(fixture.secret) });
  });
});

test('a slow provider holds no other store write behind it', async () => {
  const conn = await service.connect('fake', fixture.secret);
  let release;
  const slow = { ...fake, id: 'fake-two', createClient: () => ({ whoAmI: () => new Promise((r) => { release = r; }) }) };
  const blocking = createIssueTrackerService({ storePath, secrets, registry: { get: (id) => ({ fake, 'fake-two': slow })[id] || null, describe: () => [] }, fetch });
  const pending = blocking.connect('fake-two', 'any-key-long-enough');
  await new Promise((r) => realImmediate(r));
  await expect(blocking.disconnect(conn.id)).resolves.toBeUndefined(); // not queued behind the request
  release({ user: { id: 'u2', name: 'Grace' }, workspace: { id: 'w2', name: 'w2' } });
  await pending;
  expect(readStore().connections.map((c) => c.provider)).toEqual(['fake-two']);
});

test('maskKey shows the last four characters only, and nothing of a short key', () => {
  expect(maskKey('api_abcdefghijklmnop1234')).toBe('••••1234');
  expect(maskKey('abcdefghijklm')).toBe('••••'); // 13 characters: four would be most of it
  expect(maskKey('short')).toBe('••••');
  expect(maskKey(null)).toBeNull();
});

describe('reading tickets', () => {
  let conn;
  beforeEach(async () => {
    conn = await service.connect('fake', fixture.secret);
    fetch.mockClear();
  });

  test('metadata is sanitised and cached until it is asked to refresh', async () => {
    const spy = jest.spyOn(await service.client(conn.id), 'metadata');
    const first = await service.metadata(conn.id);
    expect(first.facets.map((f) => f.id)).toEqual(['repository']);
    expect(first.states.map((st) => st.category)).toEqual(['todo', 'done']);
    await service.metadata(conn.id);
    expect(spy).toHaveBeenCalledTimes(1);
    await service.metadata(conn.id, { refresh: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('the metadata cache expires', async () => {
    let now = 0;
    const timed = createIssueTrackerService({ storePath, secrets, registry, fetch, clock: () => now });
    const spy = jest.spyOn(await timed.client(conn.id), 'metadata');
    await timed.metadata(conn.id);
    now = 11 * 60 * 1000;
    await timed.metadata(conn.id);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('listIssues normalises the query and returns sanitised issues with refs', async () => {
    const spy = jest.spyOn(await service.client(conn.id), 'listIssues');
    const page = await service.listIssues(conn.id, { text: 'crash', bogus: true, limit: 5000 }, null);
    expect(page.issues.map((i) => i.ref)).toEqual(['fake:#1']);
    expect(page.next).toBeNull();
    expect(spy.mock.calls[0][0]).toMatchObject({ text: 'crash', limit: 100 });
    expect(spy.mock.calls[0][0]).not.toHaveProperty('bogus');
  });

  test('an issue the sanitiser cannot use is dropped and logged', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = { ...fake, createClient: () => ({ listIssues: async () => ({ issues: [{ key: 'X-1' }, { key: 'X-2', title: 'ok', state: { name: 'Todo', category: 'todo' } }], next: 42 }) }) };
    const odd = createIssueTrackerService({ storePath, secrets, registry: { ...registry, get: () => broken }, fetch });
    const page = await odd.listIssues(conn.id, {}, null);
    expect(page.issues.map((i) => i.key)).toEqual(['X-2']);
    expect(page.next).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('issues: 3 problem(s), first: title: missing'));
    warn.mockRestore();
  });

  test('getIssue returns the sanitised detail', async () => {
    const issue = await service.getIssue(conn.id, '#1');
    expect(issue).toMatchObject({ ref: 'fake:#1', description: 'Body of #1' });
    expect(issue.children.map((c) => c.key)).toEqual(['#4']);
    expect((await service.getIssue(conn.id, '#3')).comments).toHaveLength(1);
  });

  test('getIssue keeps the provider error code', async () => {
    await expect(service.getIssue(conn.id, fixture.unknownKey)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('disconnecting drops the cached metadata and client', async () => {
    await service.metadata(conn.id);
    await service.disconnect(conn.id);
    await expect(service.metadata(conn.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('writing tickets', () => {
  let conn;
  beforeEach(async () => {
    conn = await service.connect('fake', fixture.secret);
    fetch.mockClear();
  });

  test('updateIssue changes the state and returns the sanitised issue', async () => {
    const issue = await service.updateIssue(conn.id, '#1', { stateId: 'closed' });
    expect(issue).toMatchObject({ ref: 'fake:#1', state: { id: 'closed', category: 'done' } });
  });

  test('a field the adapter does not declare writable is refused before any request', async () => {
    const spy = jest.spyOn(await service.client(conn.id), 'updateIssue');
    await expect(service.updateIssue(conn.id, '#1', { assigneeId: null })).rejects.toThrow(/does not allow changing the assignee/);
    await expect(service.updateIssue(conn.id, '#1', { priority: 2 })).rejects.toThrow(/does not allow changing the priority/);
    expect(spy).not.toHaveBeenCalled();
  });

  test('null unassigns, a priority must be on the scale', async () => {
    // A tracker that declares assignees and priorities writable: the service checks the values first.
    const writable = { ...fake, capabilities: { ...fake.capabilities, priority: true, write: ['state', 'assignee', 'priority', 'comment'] } };
    const rw = createIssueTrackerService({ storePath, secrets, registry: { ...registry, get: () => writable }, fetch });
    const client = await rw.client(conn.id);
    const update = jest.spyOn(client, 'updateIssue').mockImplementation(async (key) => (await client.listIssues({ text: key, limit: 1, stateCategories: [], stateIds: [], assigneeIds: [], labelIds: [], facets: {} })).issues[0]);
    await rw.updateIssue(conn.id, '#1', { assigneeId: null });
    expect(update).toHaveBeenLastCalledWith('#1', { assigneeId: null });
    await expect(rw.updateIssue(conn.id, '#1', { priority: 7 })).rejects.toMatchObject({ code: 'PROVIDER' });
    expect(update).toHaveBeenCalledTimes(1);
  });

  test('an empty patch is refused', async () => {
    await expect(service.updateIssue(conn.id, '#1', { title: 'nope' })).rejects.toThrow('Nothing to update');
  });

  test('addComment posts trimmed markdown and refuses an empty one', async () => {
    const comment = await service.addComment(conn.id, '#1', '  **Done** in #57\n');
    expect(comment).toMatchObject({ body: '**Done** in #57', author: { name: 'Ada Lovelace' } });
    await expect(service.addComment(conn.id, '#1', '   ')).rejects.toThrow('The comment is empty');
  });
});
