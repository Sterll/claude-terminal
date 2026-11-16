/**
 * ModelAccessService — which models an account may run, from the Models API.
 *
 * This is the only signal that tells an account admitted to Mythos apart: the
 * CLI's menu and the usage API say nothing about it. So the tests pin what the
 * picker relies on: one list per account, fetched with that account's token,
 * cached, and an outage that never invents access.
 */

// `mock`-prefixed: jest.mock factories are hoisted above other consts.
const mockTokens = new Map();
const mockBodyByToken = new Map();
const mockRequests = [];

jest.mock('https', () => ({
  get: jest.fn((opts, cb) => {
    const { EventEmitter } = require('events');
    const token = String(opts.headers.Authorization || '').replace('Bearer ', '');
    mockRequests.push({ token, path: opts.path, headers: opts.headers });
    const res = new EventEmitter();
    res.statusCode = mockBodyByToken.has(token) ? 200 : 401;
    process.nextTick(() => {
      res.emit('data', mockBodyByToken.get(token) ?? 'invalid token');
      res.emit('end');
    });
    cb(res);
    return { on: jest.fn(), destroy: jest.fn() };
  }),
}));

jest.mock('../../src/main/services/UsageService', () => ({
  readOAuthToken: jest.fn(async (accountId) => mockTokens.get(accountId) ?? null),
}));

const ModelAccess = require('../../src/main/services/ModelAccessService');

const listing = (...ids) => JSON.stringify({ data: ids.map(id => ({ type: 'model', id })) });

beforeEach(() => {
  ModelAccess._reset();
  mockTokens.clear();
  mockBodyByToken.clear();
  mockRequests.length = 0;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  console.warn.mockRestore();
  jest.useRealTimers();
});

test('lists what each account may run, asked with its own token', async () => {
  mockTokens.set('team', 'tok-team');
  mockTokens.set('max', 'tok-max');
  mockBodyByToken.set('tok-team', listing('claude-mythos-5-2', 'claude-fable-5-2'));
  mockBodyByToken.set('tok-max', listing('claude-fable-5-2'));

  expect(await ModelAccess.modelIdsFor('team')).toEqual(['claude-mythos-5-2', 'claude-fable-5-2']);
  expect(await ModelAccess.modelIdsFor('max')).toEqual(['claude-fable-5-2']);
  expect(mockRequests.map(r => r.token)).toEqual(['tok-team', 'tok-max']);
});

test('calls the Models API the way an OAuth token needs', async () => {
  mockTokens.set(null, 'tok-machine');
  mockBodyByToken.set('tok-machine', listing('claude-opus-5-5'));

  await ModelAccess.modelIdsFor(null);

  expect(mockRequests[0].path).toBe('/v1/models?limit=100');
  expect(mockRequests[0].headers).toMatchObject({
    'Authorization': 'Bearer tok-machine',
    'anthropic-beta': 'oauth-2025-04-20',
    'anthropic-version': '2023-06-01',
  });
});

test('asks once per account, concurrent callers included', async () => {
  mockTokens.set('team', 'tok-team');
  mockBodyByToken.set('tok-team', listing('claude-mythos-5-2'));

  await Promise.all([ModelAccess.modelIdsFor('team'), ModelAccess.modelIdsFor('team')]);
  await ModelAccess.modelIdsFor('team');

  expect(mockRequests).toHaveLength(1);
});

test('no token, no access: nothing is assumed', async () => {
  expect(await ModelAccess.modelIdsFor('signed-out')).toBeNull();
  expect(mockRequests).toHaveLength(0);
});

test('a refused request answers null rather than an empty list', async () => {
  mockTokens.set('team', 'tok-revoked');
  expect(await ModelAccess.modelIdsFor('team')).toBeNull();
});

test('a failure after a good answer keeps the good answer', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick'] });
  mockTokens.set('team', 'tok-team');
  mockBodyByToken.set('tok-team', listing('claude-mythos-5-2'));
  await ModelAccess.modelIdsFor('team');

  jest.advanceTimersByTime(ModelAccess.TTL_MS + 1);
  mockBodyByToken.delete('tok-team');

  expect(await ModelAccess.modelIdsFor('team')).toEqual(['claude-mythos-5-2']);
  expect(mockRequests).toHaveLength(2);
});
