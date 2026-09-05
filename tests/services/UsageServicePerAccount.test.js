/**
 * UsageService — per-account figures.
 *
 * Projects pick their own account, so usage is no longer one set of numbers.
 * These pin the parts that would silently report the wrong account: cache
 * isolation, per-account limit de-duplication, and which credential store a
 * token is read from.
 */

// One fake response per token, so a request proves which account was queried.
// `mock`-prefixed: jest.mock factories are hoisted above other consts.
const mockBodyByToken = new Map();
const mockRequestedTokens = [];

jest.mock('https', () => ({
  get: jest.fn((opts, cb) => {
    const { EventEmitter } = require('events');
    const token = String(opts.headers.Authorization || '').replace('Bearer ', '');
    mockRequestedTokens.push(token);
    const res = new EventEmitter();
    res.statusCode = mockBodyByToken.has(token) ? 200 : 401;
    process.nextTick(() => {
      res.emit('data', mockBodyByToken.get(token) ?? 'no such token');
      res.emit('end');
    });
    cb(res);
    return { on: jest.fn(), destroy: jest.fn() };
  })
}));

jest.mock('../../src/main/utils/claudeCredentials', () => ({
  readAccessToken: jest.fn(async () => 'tok-machine'),
  readCredentialsForDir: jest.fn(async (dir) => ({
    claudeAiOauth: { accessToken: `tok-${dir.split('/').pop()}`, expiresAt: 4102444800000 }
  })),
  tokenFromCredentials: jest.fn((creds) => creds?.claudeAiOauth?.accessToken ?? null)
}));

jest.mock('../../src/main/services/AccountManager', () => ({
  accountConfigDir: (id) => `/tmp/accounts/config/${id}`
}));

jest.mock('../../src/main/windows/MainWindow', () => ({ isMainWindowVisible: () => true }), { virtual: true });

const UsageService = require('../../src/main/services/UsageService');

const usageBody = (utilization, resetsAt = '2026-10-01T00:00:00Z') => JSON.stringify({
  five_hour: { utilization, resets_at: resetsAt }
});

beforeEach(() => {
  mockBodyByToken.clear();
  mockRequestedTokens.length = 0;
  UsageService.invalidateCredentials();
  UsageService.onUpdate(null);
  UsageService.onLimit(null);
});

describe('per-account isolation', () => {
  test('each account keeps its own figures', async () => {
    mockBodyByToken.set('tok-acct-max', usageBody(0.10));
    mockBodyByToken.set('tok-acct-team', usageBody(0.80));

    await UsageService.fetchUsage('acct-max');
    await UsageService.fetchUsage('acct-team');

    // The whole point: one account's numbers must never answer for another.
    expect(UsageService.getUsageData('acct-max').data.buckets[0].utilization).toBe(0.10);
    expect(UsageService.getUsageData('acct-team').data.buckets[0].utilization).toBe(0.80);
  });

  test('a bound account is read from its own credential directory', async () => {
    mockBodyByToken.set('tok-acct-team', usageBody(0.42));

    await UsageService.fetchUsage('acct-team');

    // Not the machine-wide login: the figures have to come from the store the
    // account's own CLI authenticates against.
    expect(mockRequestedTokens).toEqual(['tok-acct-team']);
  });

  test('no account id means the machine-wide login', async () => {
    mockBodyByToken.set('tok-machine', usageBody(0.33));

    await UsageService.fetchUsage(null);

    expect(mockRequestedTokens).toEqual(['tok-machine']);
    expect(UsageService.getUsageData().data.buckets[0].utilization).toBe(0.33);
  });

  test('an account with no data does not inherit another one', async () => {
    mockBodyByToken.set('tok-acct-max', usageBody(0.55));
    await UsageService.fetchUsage('acct-max');

    expect(UsageService.getUsageData('acct-team').data).toBeNull();
  });

  test('a failed fetch marks only that account stale', async () => {
    mockBodyByToken.set('tok-acct-max', usageBody(0.20));
    await UsageService.fetchUsage('acct-max');
    await UsageService.fetchUsage('acct-team'); // 401, no body registered

    expect(UsageService.getFetchState('acct-max').stale).toBe(false);
    expect(UsageService.getFetchState('acct-team').stale).toBe(true);
  });
});

describe('limit notifications', () => {
  test('two accounts crossing the same bucket both notify', async () => {
    const alerts = [];
    UsageService.onLimit(a => alerts.push(a));
    mockBodyByToken.set('tok-acct-max', usageBody(0.97));
    mockBodyByToken.set('tok-acct-team', usageBody(0.98));

    await UsageService.fetchUsage('acct-max');
    await UsageService.fetchUsage('acct-team');

    // A shared de-dupe key let the first account swallow the second's alert:
    // same bucket id, same reset window.
    expect(alerts.map(a => a.accountId)).toEqual(['acct-max', 'acct-team']);
  });

  test('the same account does not notify twice in one window', async () => {
    const alerts = [];
    UsageService.onLimit(a => alerts.push(a));
    mockBodyByToken.set('tok-acct-max', usageBody(0.97));

    await UsageService.fetchUsage('acct-max');
    await UsageService.fetchUsage('acct-max');

    expect(alerts).toHaveLength(1);
  });

  test('a new reset window notifies again', async () => {
    const alerts = [];
    UsageService.onLimit(a => alerts.push(a));

    mockBodyByToken.set('tok-acct-max', usageBody(0.97, '2026-10-01T00:00:00Z'));
    await UsageService.fetchUsage('acct-max');
    mockBodyByToken.set('tok-acct-max', usageBody(0.99, '2026-10-02T00:00:00Z'));
    await UsageService.fetchUsage('acct-max');

    expect(alerts).toHaveLength(2);
  });
});

describe('invalidation', () => {
  test('clears one account and leaves the others', async () => {
    mockBodyByToken.set('tok-acct-max', usageBody(0.10));
    mockBodyByToken.set('tok-acct-team', usageBody(0.80));
    await UsageService.fetchUsage('acct-max');
    await UsageService.fetchUsage('acct-team');

    UsageService.invalidateCredentials('acct-max');

    expect(UsageService.getUsageData('acct-max').data).toBeNull();
    expect(UsageService.getUsageData('acct-team').data.buckets[0].utilization).toBe(0.80);
  });

  test('with no argument it clears every account', async () => {
    mockBodyByToken.set('tok-acct-max', usageBody(0.10));
    mockBodyByToken.set('tok-acct-team', usageBody(0.80));
    await UsageService.fetchUsage('acct-max');
    await UsageService.fetchUsage('acct-team');

    UsageService.invalidateCredentials();

    expect(UsageService.getUsageData('acct-max').data).toBeNull();
    expect(UsageService.getUsageData('acct-team').data).toBeNull();
  });
});

describe('focus', () => {
  test('the focused account is what the poller refreshes', async () => {
    mockBodyByToken.set('tok-acct-team', usageBody(0.44));

    UsageService.setFocusedAccount('acct-team');
    expect(UsageService.getFocusedAccount()).toBe('acct-team');

    // Switching focus fetches immediately rather than leaving the previous
    // account's numbers up until the next tick.
    await new Promise(r => setTimeout(r, 10));
    expect(mockRequestedTokens).toContain('tok-acct-team');

    UsageService.setFocusedAccount(null);
    expect(UsageService.getFocusedAccount()).toBeNull();
  });
});
