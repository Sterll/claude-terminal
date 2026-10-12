/**
 * Adapter discovery: what the registry loads, what it skips, and what it lets
 * the renderer see.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadTrackers, describeTrackers } = require('../../src/main/issue-trackers/_registry');
const { validateTracker, requiredClientMethods, validateClient, trackerError } = require('../../src/main/issue-trackers/_contract');
const fake = require('./fake.tracker');

/** A self-contained adapter module, so the temp file needs no repo require(). */
const adapterSource = (id, overrides = '') => `
module.exports = {
  id: '${id}',
  name: 'Temp ${id}',
  auth: { type: 'apiKey' },
  capabilities: { priority: true, labels: true, estimate: false, comments: true, write: [] },
  createClient: () => ({}),
  refs: { fromText: () => [] },
  ${overrides}
};`;

describe('loadTrackers', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-trackers-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const write = (file, source) => fs.writeFileSync(path.join(dir, file), source);

  test('loads every *.tracker.js and ignores helpers and other files', () => {
    write('alpha.tracker.js', adapterSource('alpha'));
    write('_helpers.tracker.js', adapterSource('helpers'));
    write('notes.js', adapterSource('notes'));
    const { trackers, problems } = loadTrackers(dir);
    expect([...trackers.keys()]).toEqual(['alpha']);
    expect(problems).toEqual([]);
  });

  test('skips a file that throws on load and keeps the others', () => {
    write('alpha.tracker.js', adapterSource('alpha'));
    write('broken.tracker.js', 'module.exports = {');
    const { trackers, problems } = loadTrackers(dir);
    expect([...trackers.keys()]).toEqual(['alpha']);
    expect(problems).toHaveLength(1);
    expect(problems[0].file).toBe('broken.tracker.js');
  });

  test('skips an adapter that breaks the contract', () => {
    write('bad.tracker.js', adapterSource('Bad Id'));
    const { trackers, problems } = loadTrackers(dir);
    expect(trackers.size).toBe(0);
    expect(problems[0].problems.join(' ')).toMatch(/^id:/);
  });

  test('keeps the first of two adapters that claim the same id', () => {
    write('a.tracker.js', adapterSource('same'));
    write('b.tracker.js', adapterSource('same'));
    const { trackers, problems } = loadTrackers(dir);
    expect(trackers.size).toBe(1);
    expect(problems[0]).toMatchObject({ file: 'b.tracker.js' });
  });

  test('reports an unreadable directory instead of throwing', () => {
    const { trackers, problems } = loadTrackers(path.join(dir, 'missing'));
    expect(trackers.size).toBe(0);
    expect(problems).toHaveLength(1);
  });
});

describe('validateTracker', () => {
  const valid = () => ({
    id: 'acme',
    name: 'Acme',
    auth: { type: 'apiKey', helpUrl: 'https://acme.test/keys' },
    capabilities: { priority: true, labels: false, estimate: false, comments: true, write: ['state', 'priority', 'comment'] },
    createClient: () => ({}),
    refs: { fromText: () => [] },
  });

  test('accepts a complete adapter', () => {
    expect(validateTracker(valid())).toEqual([]);
    expect(validateTracker(fake)).toEqual([]);
  });

  test.each([
    ['unknown auth type', (d) => { d.auth.type = 'oauth'; }, /^auth\.type/],
    ['non-https help URL', (d) => { d.auth.helpUrl = 'http://acme.test'; }, /helpUrl/],
    ['missing capability flag', (d) => { delete d.capabilities.labels; }, /capabilities\.labels/],
    ['unknown write field', (d) => { d.capabilities.write.push('title'); }, /unknown field "title"/],
    ['writable priority without priorities', (d) => { d.capabilities.priority = false; }, /"priority" needs/],
    ['writable comments without comments', (d) => { d.capabilities.comments = false; }, /"comment" needs/],
    ['no createClient', (d) => { delete d.createClient; }, /^createClient/],
    ['no refs.fromText', (d) => { d.refs = {}; }, /^refs\.fromText/],
    ['fromToolCall that is not a function', (d) => { d.refs.fromToolCall = 'yes'; }, /fromToolCall/],
  ])('rejects %s', (_label, mutate, expected) => {
    const def = valid();
    mutate(def);
    expect(validateTracker(def).join('\n')).toMatch(expected);
  });

  test('rejects something that is not a module object', () => {
    expect(validateTracker(null)).toEqual(['module does not export an object']);
  });
});

describe('client requirements follow the declared writes', () => {
  const withWrite = (write) => ({ capabilities: { write } });

  test('a read-only tracker needs the four base methods only', () => {
    expect(requiredClientMethods(withWrite([]))).toEqual(['whoAmI', 'metadata', 'listIssues', 'getIssue']);
  });

  test('writable fields add updateIssue, comments add addComment', () => {
    expect(requiredClientMethods(withWrite(['state']))).toContain('updateIssue');
    expect(requiredClientMethods(withWrite(['comment']))).toEqual(['whoAmI', 'metadata', 'listIssues', 'getIssue', 'addComment']);
  });

  test('validateClient names each missing method', () => {
    expect(validateClient(withWrite(['comment']), { whoAmI() {}, metadata() {}, listIssues() {} }))
      .toEqual(['client.getIssue: expected a function', 'client.addComment: expected a function']);
  });
});

describe('trackerError', () => {
  test('keeps a known code and the retry delay', () => {
    const err = trackerError('RATE_LIMITED', 'Slow down', { retryAfterMs: 3000 });
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 3000, message: 'Slow down' });
  });

  test('folds an unknown code into PROVIDER', () => {
    expect(trackerError('HTTP_500', 'Boom').code).toBe('PROVIDER');
  });
});

describe('describeTrackers', () => {
  test('hands the renderer plain data only', () => {
    const [desc] = describeTrackers([fake]);
    expect(desc).toEqual({
      id: 'fake',
      name: 'Fake Tracker',
      auth: { type: 'apiKey', helpUrl: 'https://example.com/settings/tokens' },
      capabilities: { priority: false, labels: true, estimate: false, comments: true, write: ['state', 'comment'] },
    });
    expect(JSON.parse(JSON.stringify(desc))).toEqual(desc);
  });

  test('is a copy: the renderer cannot mutate an adapter through it', () => {
    const [desc] = describeTrackers([fake]);
    desc.capabilities.write.push('priority');
    expect(fake.capabilities.write).toEqual(['state', 'comment']);
  });
});
