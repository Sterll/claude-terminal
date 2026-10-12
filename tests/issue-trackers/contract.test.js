/**
 * The issue tracker contract, run against every adapter the registry ships
 * plus the fake one in this directory.
 *
 * This is what lets someone add a provider without knowing the rest of the
 * app: if their adapter passes here, the list, the board and the session views
 * can draw it. Each adapter brings a fixture (`fixtures/<id>.fixture.js`) that
 * stands in for the network; see `fixtures/fake.fixture.js` for its shape.
 *
 * The checks are about shapes and error codes, not filter semantics: whether a
 * provider's query language honours a filter is the adapter's own unit test.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const registry = require('../../src/main/issue-trackers/_registry');
const { validateTracker, validateClient } = require('../../src/main/issue-trackers/_contract');
const {
  sanitizeIssue,
  sanitizeIssueDetail,
  sanitizeMetadata,
  sanitizePerson,
  sanitizeComment,
  normalizeQuery,
} = require('../../src/shared/issue-trackers');
const fake = require('./fake.tracker');

const adapters = [fake, ...registry.getAll()];

describe.each(adapters.map((def) => [def.id, def]))('%s adapter', (id, def) => {
  const fixtureFile = path.join(__dirname, 'fixtures', `${id}.fixture.js`);
  let fixture;
  let fetchCalls;
  let client;
  let metadata;
  let issues;

  const countingFetch = (...args) => {
    fetchCalls += 1;
    return fixture.fetch(...args);
  };

  beforeAll(() => {
    if (fs.existsSync(fixtureFile)) fixture = require(fixtureFile);
  });

  beforeEach(() => {
    fetchCalls = 0;
  });

  test('ships a contract fixture', () => {
    expect(fixture).toBeDefined();
    expect(typeof fixture.secret).toBe('string');
    expect(typeof fixture.fetch).toBe('function');
    expect(typeof fixture.unknownKey).toBe('string');
  });

  test('passes the static contract', () => {
    expect(validateTracker(def)).toEqual([]);
  });

  test('createClient does no I/O and exposes every required method', () => {
    client = def.createClient({ secret: fixture.secret, fetch: countingFetch });
    expect(fetchCalls).toBe(0);
    expect(validateClient(def, client)).toEqual([]);
  });

  test('whoAmI names a user and a workspace', async () => {
    const me = await client.whoAmI();
    expect(sanitizePerson(me.user)).not.toBeNull();
    expect(typeof me.workspace?.name).toBe('string');
  });

  test('a wrong secret is rejected with AUTH', async () => {
    const bad = def.createClient({ secret: `${fixture.secret}-wrong`, fetch: countingFetch });
    await expect(bad.whoAmI()).rejects.toMatchObject({ code: 'AUTH' });
  });

  test('metadata is clean and has at least one state', async () => {
    const res = sanitizeMetadata(await client.metadata());
    expect(res.problems).toEqual([]);
    expect(res.metadata.states.length).toBeGreaterThan(0);
    metadata = res.metadata;
  });

  test('listIssues returns clean issues that respect the declared capabilities', async () => {
    const page = await client.listIssues(normalizeQuery({}), null);
    expect(Array.isArray(page.issues)).toBe(true);
    expect(page.issues.length).toBeGreaterThan(0);
    expect(page.next === null || typeof page.next === 'string').toBe(true);

    const stateIds = new Set(metadata.states.map((s) => s.id));
    issues = page.issues.map((raw) => {
      const { issue, problems } = sanitizeIssue(raw, id);
      expect(problems).toEqual([]);
      expect(issue).not.toBeNull();
      if (issue.state.id) expect(stateIds.has(issue.state.id)).toBe(true);
      if (!def.capabilities.priority) expect(issue.priority).toBeNull();
      if (!def.capabilities.labels) expect(issue.labels).toEqual([]);
      if (!def.capabilities.estimate) expect(issue.estimate).toBeNull();
      return issue;
    });
  });

  test('getIssue returns a clean detail', async () => {
    const { issue, problems } = sanitizeIssueDetail(await client.getIssue(issues[0].key), id);
    expect(problems).toEqual([]);
    expect(issue.key).toBe(issues[0].key);
    if (!def.capabilities.comments) expect(issue.comments).toEqual([]);
  });

  test('getIssue rejects an unknown key with NOT_FOUND', async () => {
    await expect(client.getIssue(fixture.unknownKey)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('refs.fromText finds a real key and no version strings', () => {
    const key = issues[0].key;
    expect(def.refs.fromText(`Fixes ${key} before the release.`, metadata.keys)).toContain(key);
    expect(def.refs.fromText('UTF-8, ISO-8601, SHA-256 and RFC-2119', metadata.keys)).toEqual([]);
  });

  test('refs.fromToolCall ignores tools that are not its own', () => {
    if (!def.refs.fromToolCall) return;
    expect(def.refs.fromToolCall({ name: 'Bash', input: { command: 'git status' }, result: '' })).toEqual([]);
    expect(def.refs.fromToolCall({ name: 'Read', input: { file_path: '/tmp/ENG-1.md' }, result: '' })).toEqual([]);
  });

  test('updateIssue returns a clean issue', async () => {
    const write = def.capabilities.write;
    if (!write.includes('state')) return;
    const target = issues[0];
    const other = metadata.states.find((s) => s.id !== target.state.id);
    const { issue, problems } = sanitizeIssue(await client.updateIssue(target.key, { stateId: other.id }), id);
    expect(problems).toEqual([]);
    expect(issue.key).toBe(target.key);
  });

  test('addComment returns a clean comment', async () => {
    if (!def.capabilities.write.includes('comment')) return;
    const { comment, problems } = sanitizeComment(await client.addComment(issues[0].key, 'Linked from Claude Terminal.'));
    expect(problems).toEqual([]);
    expect(comment.body).toBe('Linked from Claude Terminal.');
  });
});
