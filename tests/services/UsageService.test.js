/**
 * Guards the usage bucket parsing.
 *
 * The titlebar used to read one fixed key per limit — `five_hour`, `seven_day`,
 * `seven_day_sonnet`. The per-model key went null when the scoped weekly limit
 * moved off Sonnet, and nothing caught it: the bar simply showed "Sonnet --%"
 * against an empty gauge for as long as it took someone to notice. These tests
 * pin the shape we read now, so the next model rename is a data change rather
 * than a silent blank bar.
 */

const { readBuckets } = require('../../src/main/services/UsageService');

/** A response captured from /api/oauth/usage, trimmed to the fields we read. */
const LIVE_RESPONSE = {
  five_hour: { utilization: 16.0, resets_at: '2026-09-03T11:50:00Z' },
  seven_day: { utilization: 6.0, resets_at: '2026-09-08T00:00:00Z' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  nimbus_quill: { utilization: 0.0, resets_at: null },
  limits: [
    {
      kind: 'session', group: 'session', percent: 16, severity: 'normal',
      resets_at: '2026-09-03T11:50:00Z', scope: null, is_active: true
    },
    {
      kind: 'weekly_all', group: 'weekly', percent: 6, severity: 'normal',
      resets_at: '2026-09-08T00:00:00Z', scope: null, is_active: false
    },
    {
      kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal',
      resets_at: null, scope: { model: { id: null, display_name: 'Fable' } }, is_active: false
    }
  ]
};

describe('readBuckets', () => {
  test('reads the three buckets a live response describes', () => {
    expect(readBuckets(LIVE_RESPONSE)).toEqual([
      { id: 'session', type: 'session', label: null, labelKey: 'ui.session', utilization: 16, resetsAt: '2026-09-03T11:50:00Z' },
      { id: 'weekly', type: 'weekly', label: null, labelKey: 'ui.weekly', utilization: 6, resetsAt: '2026-09-08T00:00:00Z' },
      { id: 'scoped:Fable', type: 'scoped', label: 'Fable', labelKey: null, utilization: 0, resetsAt: null }
    ]);
  });

  test('takes the scoped label from the API, not from a hardcoded model name', () => {
    const renamed = {
      ...LIVE_RESPONSE,
      limits: [{ kind: 'weekly_scoped', percent: 42, resets_at: null, scope: { model: { display_name: 'Mythos' } } }]
    };
    expect(readBuckets(renamed)).toEqual([
      { id: 'scoped:Mythos', type: 'scoped', label: 'Mythos', labelKey: null, utilization: 42, resetsAt: null }
    ]);
  });

  test('renders every scoped limit when a plan exposes more than one', () => {
    const twoModels = {
      ...LIVE_RESPONSE,
      limits: [
        { kind: 'weekly_scoped', percent: 10, resets_at: null, scope: { model: { display_name: 'Fable' } } },
        { kind: 'weekly_scoped', percent: 20, resets_at: null, scope: { model: { display_name: 'Opus' } } }
      ]
    };
    expect(readBuckets(twoModels).map(b => b.label)).toEqual(['Fable', 'Opus']);
  });

  test('keeps only the plan-wide buckets when a plan has no scoped limit', () => {
    const noScope = { ...LIVE_RESPONSE, limits: LIVE_RESPONSE.limits.slice(0, 2) };
    expect(readBuckets(noScope).map(b => b.id)).toEqual(['session', 'weekly']);
  });

  test('drops a scoped limit the server did not name rather than showing a blank bar', () => {
    const unnamed = {
      ...LIVE_RESPONSE,
      limits: [...LIVE_RESPONSE.limits.slice(0, 2), { kind: 'weekly_scoped', percent: 5, scope: null }]
    };
    expect(readBuckets(unnamed).map(b => b.id)).toEqual(['session', 'weekly']);
  });

  test('ignores a limit with no percent instead of rendering NaN', () => {
    const broken = { limits: [{ kind: 'session', resets_at: null, scope: null }] , five_hour: null, seven_day: null };
    expect(readBuckets(broken)).toEqual([]);
  });

  test('falls back to the legacy keys when the response has no limits array', () => {
    const legacy = {
      five_hour: { utilization: 30, resets_at: '2026-09-03T11:50:00Z' },
      seven_day: { utilization: 12, resets_at: '2026-09-08T00:00:00Z' }
    };
    expect(readBuckets(legacy).map(b => ({ id: b.id, utilization: b.utilization })))
      .toEqual([{ id: 'session', utilization: 30 }, { id: 'weekly', utilization: 12 }]);
  });

  test('falls back rather than blanking the bar when limits is present but unusable', () => {
    const empty = { ...LIVE_RESPONSE, limits: [] };
    expect(readBuckets(empty).map(b => b.id)).toEqual(['session', 'weekly']);
  });

  test('survives an empty or malformed response', () => {
    expect(readBuckets({})).toEqual([]);
    expect(readBuckets(null)).toEqual([]);
    expect(readBuckets({ limits: null })).toEqual([]);
  });
});

/**
 * Guards the OAuth token cache.
 *
 * On macOS the machine-wide credentials live in the login Keychain, in an item
 * created by the Claude CLI whose ACL does not list this app, so every read of
 * the store is a system password prompt. The renderer polls usage once a
 * minute; the cache used to hold the token for 30 seconds, so it expired before
 * every single tick and the prompts piled up behind the window. These tests pin
 * the read count.
 */
describe('OAuth token cache', () => {
  const CREDENTIALS_MODULE = '../../src/main/utils/claudeCredentials';
  const HOUR = 3600 * 1000;

  let readCredentials;
  let httpsGet;

  /** Load a fresh UsageService over a mocked credential store and https. */
  function load(statuses = [200]) {
    const queue = [...statuses];
    readCredentials = jest.fn();
    httpsGet = jest.fn((options, callback) => {
      const statusCode = queue.length > 1 ? queue.shift() : (queue[0] ?? 200);
      const body = statusCode === 200 ? JSON.stringify({ limits: [] }) : 'unauthorized';
      const res = {
        statusCode,
        on: (event, fn) => {
          if (event === 'data') fn(body);
          if (event === 'end') fn();
          return res;
        }
      };
      callback(res);
      return { on: jest.fn(), destroy: jest.fn() };
    });

    jest.resetModules();
    // Only the store read is faked; tokenFromCredentials stays real, since the
    // expiry rule it applies is part of what these tests exercise.
    jest.doMock(CREDENTIALS_MODULE, () => ({
      ...jest.requireActual(CREDENTIALS_MODULE),
      readCredentials
    }));
    jest.doMock('https', () => ({ get: httpsGet }));
    return require('../../src/main/services/UsageService');
  }

  const validCreds = (accessToken = 'token-a') =>
    ({ claudeAiOauth: { accessToken, expiresAt: Date.now() + HOUR } });

  afterEach(() => {
    jest.dontMock(CREDENTIALS_MODULE);
    jest.dontMock('https');
    jest.resetModules();
  });

  test('reads the credential store once across repeated polls', async () => {
    const usage = load();
    readCredentials.mockResolvedValue(validCreds());

    await usage.fetchUsage();
    await usage.fetchUsage();
    await usage.fetchUsage();

    expect(readCredentials).toHaveBeenCalledTimes(1);
    expect(httpsGet).toHaveBeenCalledTimes(3);
  });

  test('does not ask again on the next poll when the store is unreadable', async () => {
    const usage = load();
    readCredentials.mockRejectedValue(new Error('User canceled the operation.'));

    expect(await usage.fetchUsage()).toBeNull();
    expect(await usage.fetchUsage()).toBeNull();

    expect(readCredentials).toHaveBeenCalledTimes(1);
    expect(httpsGet).not.toHaveBeenCalled();
  });

  test('does not ask again on the next poll when the stored token has expired', async () => {
    const usage = load();
    readCredentials.mockResolvedValue({
      claudeAiOauth: { accessToken: 'stale', expiresAt: Date.now() - 1000 }
    });

    await usage.fetchUsage();
    await usage.fetchUsage();

    expect(readCredentials).toHaveBeenCalledTimes(1);
    expect(httpsGet).not.toHaveBeenCalled();
  });

  test('re-reads once when the API refuses the token, then stops', async () => {
    const usage = load([401]);
    readCredentials.mockResolvedValue(validCreds());

    await usage.fetchUsage(); // reads the store, gets a 401
    await usage.fetchUsage(); // re-reads once in case the CLI rotated it
    await usage.fetchUsage(); // store still holds the refused token: no read

    expect(readCredentials).toHaveBeenCalledTimes(2);
    expect(httpsGet).toHaveBeenCalledTimes(1);
  });

  test('picks up a token the CLI rotated after the API refused the old one', async () => {
    const usage = load([401, 200]);
    readCredentials
      .mockResolvedValueOnce(validCreds('token-a'))
      .mockResolvedValue(validCreds('token-b'));

    await usage.fetchUsage();
    await usage.fetchUsage();

    expect(httpsGet).toHaveBeenCalledTimes(2);
    expect(httpsGet.mock.calls[0][0].headers.Authorization).toBe('Bearer token-a');
    expect(httpsGet.mock.calls[1][0].headers.Authorization).toBe('Bearer token-b');
  });

  test('re-reads the store after an account switch', async () => {
    const usage = load();
    readCredentials.mockResolvedValue(validCreds());

    await usage.fetchUsage();
    usage.invalidateCredentials();
    await usage.fetchUsage();

    expect(readCredentials).toHaveBeenCalledTimes(2);
  });

  test('retries a refused token when the refresh is explicitly forced', async () => {
    const usage = load([401, 200]);
    readCredentials.mockResolvedValue(validCreds());

    await usage.fetchUsage();          // 401: the token is marked refused
    await usage.fetchUsage();          // re-read gives the same token: no request
    await usage.fetchUsage();          // backed off: no read either
    expect(httpsGet).toHaveBeenCalledTimes(1);
    expect(readCredentials).toHaveBeenCalledTimes(2);

    // The gesture exists to re-examine the store, so it must get past a
    // refusal that may well have outlived its cause.
    expect(await usage.refreshUsage(null, true)).not.toBeNull();
    expect(httpsGet).toHaveBeenCalledTimes(2);
  });
});

/**
 * Guards against the service wedging on a credential store that never answers.
 *
 * On darwin a Keychain read blocks until its authorization dialog is answered,
 * and that dialog is raised behind the window. The awaits were unbounded, so
 * one pending dialog left `isFetching` true for the rest of the session: every
 * later poll short-circuited to the cached figures, and since no fetch ever
 * completed-and-failed, nothing was flagged. The titlebar showed hours-old
 * numbers as current until the app came to the front and the dialog cleared —
 * which is what clicking the bar did.
 */
describe('a credential store that does not answer', () => {
  const CREDENTIALS_MODULE = '../../src/main/utils/claudeCredentials';

  let readCredentials;
  let httpsGet;
  let resolveRead;

  function load() {
    readCredentials = jest.fn(() => new Promise((resolve) => { resolveRead = resolve; }));
    httpsGet = jest.fn((options, callback) => {
      const res = {
        statusCode: 200,
        on: (event, fn) => {
          if (event === 'data') fn(JSON.stringify({ limits: [] }));
          if (event === 'end') fn();
          return res;
        }
      };
      callback(res);
      return { on: jest.fn(), destroy: jest.fn() };
    });

    jest.resetModules();
    jest.doMock(CREDENTIALS_MODULE, () => ({
      ...jest.requireActual(CREDENTIALS_MODULE),
      readCredentials
    }));
    jest.doMock('https', () => ({ get: httpsGet }));
    return require('../../src/main/services/UsageService');
  }

  beforeEach(() => { jest.useFakeTimers(); });

  afterEach(() => {
    jest.useRealTimers();
    jest.dontMock(CREDENTIALS_MODULE);
    jest.dontMock('https');
    jest.resetModules();
  });

  /** Let the pending microtasks run while the clock is faked. */
  const settle = () => Promise.resolve().then(() => Promise.resolve());

  test('gives up on the read instead of hanging the fetch', async () => {
    const usage = load();

    const pending = usage.fetchUsage();
    await settle();
    expect(httpsGet).not.toHaveBeenCalled();

    jest.advanceTimersByTime(9000);
    expect(await pending).toBeNull();
    expect(usage.getFetchState(null).stale).toBe(true);
  });

  test('does not queue a second read — one prompt at a time', async () => {
    const usage = load();

    const first = usage.fetchUsage();
    await settle();
    jest.advanceTimersByTime(9000);
    await first;

    // The next tick finds the same read still in flight.
    const second = usage.fetchUsage();
    await settle();
    jest.advanceTimersByTime(9000);
    await second;

    expect(readCredentials).toHaveBeenCalledTimes(1);
  });

  test('uses the token once the read finally lands', async () => {
    const usage = load();

    const first = usage.fetchUsage();
    await settle();
    jest.advanceTimersByTime(9000);
    expect(await first).toBeNull();

    // The dialog is answered: the read completes and seeds the cache, even
    // though the caller that started it has long since given up.
    resolveRead({ claudeAiOauth: { accessToken: 'token-a', expiresAt: Date.now() + 3600 * 1000 } });
    await settle();

    const data = await usage.fetchUsage();
    expect(data).not.toBeNull();
    expect(httpsGet).toHaveBeenCalledTimes(1);
    expect(usage.getFetchState(null).stale).toBe(false);
  });
});

/**
 * Figures that stopped being refreshed read as stale.
 *
 * `isStale` only ever meant "the last fetch attempt failed". Polling that
 * silently stopped — window hidden, a read that never came back — left no error
 * behind, so arbitrarily old numbers were reported as current.
 */
describe('staleness by age', () => {
  const CREDENTIALS_MODULE = '../../src/main/utils/claudeCredentials';

  afterEach(() => {
    jest.useRealTimers();
    jest.dontMock(CREDENTIALS_MODULE);
    jest.dontMock('https');
    jest.resetModules();
  });

  test('a successful fetch goes stale once it is old enough', async () => {
    jest.resetModules();
    jest.doMock(CREDENTIALS_MODULE, () => ({
      ...jest.requireActual(CREDENTIALS_MODULE),
      readCredentials: jest.fn().mockResolvedValue({
        claudeAiOauth: { accessToken: 'token-a', expiresAt: Date.now() + 24 * 3600 * 1000 }
      })
    }));
    jest.doMock('https', () => ({
      get: (options, callback) => {
        const res = {
          statusCode: 200,
          on: (event, fn) => {
            if (event === 'data') fn(JSON.stringify({ limits: [] }));
            if (event === 'end') fn();
            return res;
          }
        };
        callback(res);
        return { on: jest.fn(), destroy: jest.fn() };
      }
    }));
    const usage = require('../../src/main/services/UsageService');

    await usage.fetchUsage();
    expect(usage.getUsageData(null).stale).toBe(false);

    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60 * 1000;
    try {
      expect(usage.getUsageData(null).stale).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });
});
