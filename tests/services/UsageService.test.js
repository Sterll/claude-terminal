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

  test('tab/focus refreshes do not keep opening the store for a nearly expired token', async () => {
    const usage = load();
    readCredentials.mockResolvedValue({ claudeAiOauth: { accessToken: 'still-valid', expiresAt: Date.now() + 30000 } });
    await usage.fetchUsage();
    await usage.refreshUsage();
    await usage.refreshUsage();
    expect(readCredentials).toHaveBeenCalledTimes(1);
  });

  test('an explicit refresh skips the wait and picks up a store that works again', async () => {
    const usage = load();
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
    try {
      readCredentials.mockResolvedValue(null);
      await usage.fetchUsage();
      // Still inside the first backoff window: a poll must not reopen the store.
      clock.mockReturnValue(start + 60 * 1000);
      usage.onWindowShow();
      await new Promise(resolve => setTimeout(resolve, 0));
      await usage.refreshUsage();
      expect(readCredentials).toHaveBeenCalledTimes(1);

      readCredentials.mockResolvedValue(validCreds('signed-in-again'));
      await usage.refreshUsage(null, true);
      expect(readCredentials).toHaveBeenCalledTimes(2);
      expect(httpsGet.mock.calls.at(-1)[0].headers.Authorization).toBe('Bearer signed-in-again');
    } finally { clock.mockRestore(); }
  });

  /**
   * The backoff after a store that gave back no usable token used to be
   * `Infinity`. `now + Infinity` is `Infinity`, so one unreadable store, one
   * token caught expired between two CLI rotations, or one 401 during an org
   * blip parked the account at "no token" for the rest of the process: every
   * later tick short-circuited to the cached null, and the only ways back were
   * restarting the app or happening to click the chip, which is the sole
   * caller that passes `force`. What the user saw was a usage chip that
   * stopped updating and never said why.
   *
   * These pin the two halves of the replacement: it still refuses to reopen
   * the store on the next tick, and it does recover on its own.
   */
  describe('recovery after a store that gave back no token', () => {
    const MINUTE = 60 * 1000;

    test('retries on its own once the backoff elapses', async () => {
      const usage = load();
      const start = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
      try {
        readCredentials.mockResolvedValue(null);
        await usage.fetchUsage();
        expect(readCredentials).toHaveBeenCalledTimes(1);

        // Four minutes in: still parked.
        clock.mockReturnValue(start + 4 * MINUTE);
        await usage.fetchUsage();
        expect(readCredentials).toHaveBeenCalledTimes(1);

        // Past five: the store is consulted again, with no click needed.
        clock.mockReturnValue(start + 6 * MINUTE);
        readCredentials.mockResolvedValue(validCreds('back-again'));
        await usage.fetchUsage();

        expect(readCredentials).toHaveBeenCalledTimes(2);
        expect(httpsGet.mock.calls.at(-1)[0].headers.Authorization).toBe('Bearer back-again');
      } finally { clock.mockRestore(); }
    });

    test('doubles the wait each time and caps it, so it cannot become a poll', async () => {
      const usage = load();
      const start = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
      try {
        readCredentials.mockResolvedValue(null);
        let at = start;
        // 5, 10, 20, 40, then capped at 60 minutes.
        for (const wait of [5, 10, 20, 40, 60, 60]) {
          await usage.fetchUsage();
          at += wait * MINUTE + 1000;
          clock.mockReturnValue(at);
        }
        await usage.fetchUsage();

        // Seven reads over more than three hours, not one per tick.
        expect(readCredentials).toHaveBeenCalledTimes(7);
      } finally { clock.mockRestore(); }
    });

    test('a store that works again starts the ladder over', async () => {
      const usage = load();
      const start = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
      try {
        readCredentials.mockResolvedValue(null);
        await usage.fetchUsage();
        clock.mockReturnValue(start + 6 * MINUTE);
        await usage.fetchUsage();
        clock.mockReturnValue(start + 20 * MINUTE);
        readCredentials.mockResolvedValue(validCreds('ok'));
        await usage.fetchUsage();

        // Failing again now waits five minutes, not the twenty it had climbed to.
        readCredentials.mockResolvedValue(null);
        clock.mockReturnValue(start + 30 * MINUTE);
        await usage.refreshUsage(null, true);
        const callsBefore = readCredentials.mock.calls.length;
        clock.mockReturnValue(start + 36 * MINUTE);
        await usage.fetchUsage();

        expect(readCredentials.mock.calls.length).toBe(callsBefore + 1);
      } finally { clock.mockRestore(); }
    });

    test('says when it will try again, so the chip can stop looking broken', async () => {
      const usage = load();
      const start = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
      try {
        readCredentials.mockResolvedValue(null);
        await usage.fetchUsage();

        const retryAt = usage.getUsageData().retryAt;
        expect(retryAt).not.toBeNull();
        expect(new Date(retryAt).getTime()).toBe(start + 5 * MINUTE);

        clock.mockReturnValue(start + 6 * MINUTE);
        readCredentials.mockResolvedValue(validCreds());
        await usage.fetchUsage();

        expect(usage.getUsageData().retryAt).toBeNull();
      } finally { clock.mockRestore(); }
    });

    // The chip reads getUsageData on its 30 s poll and getFetchState on an
    // explicit refresh. Only the first carried this, so the tooltip naming the
    // next attempt never showed on the path a user takes when they notice the
    // chip has stopped — which is the path this was added for.
    test('the refresh path is told the same thing the poll is', async () => {
      const usage = load();
      const start = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
      try {
        readCredentials.mockResolvedValue(null);
        await usage.fetchUsage();

        expect(usage.getFetchState().retryAt).toBe(usage.getUsageData().retryAt);
        expect(usage.getFetchState().retryAt).not.toBeNull();
      } finally { clock.mockRestore(); }
    });

    // Capping the interval bounds how often, not how long. A store that is
    // refused permanently would be reopened once an hour for as long as the
    // app is up, and on darwin each of those is a password dialog raised
    // behind the window — the timer-driven prompt the original `Infinity` was
    // there to prevent, just slower.
    test('stops reopening the store for good once the cause is clearly not transient', async () => {
      const usage = load();
      const start = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
      try {
        readCredentials.mockResolvedValue(null);
        let at = start;
        // Eight failures: 5, 10, 20, 40, 60, 60, 60, 60.
        for (const wait of [5, 10, 20, 40, 60, 60, 60, 60]) {
          await usage.fetchUsage();
          at += wait * MINUTE + 1000;
          clock.mockReturnValue(at);
        }
        const readsWhileTrying = readCredentials.mock.calls.length;
        expect(readsWhileTrying).toBe(8);

        // A day of polling later, the store has not been touched again.
        clock.mockReturnValue(at + 24 * 60 * MINUTE);
        await usage.fetchUsage();
        clock.mockReturnValue(at + 48 * 60 * MINUTE);
        await usage.fetchUsage();

        expect(readCredentials.mock.calls.length).toBe(readsWhileTrying);
        expect(usage.getUsageData().gaveUp).toBe(true);
        // Nothing is scheduled, so there is no time to name.
        expect(usage.getUsageData().retryAt).toBeNull();
      } finally { clock.mockRestore(); }
    });

    test('an explicit refresh lifts the give-up, so it is a pause not a dead end', async () => {
      const usage = load();
      const start = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
      try {
        readCredentials.mockResolvedValue(null);
        let at = start;
        for (const wait of [5, 10, 20, 40, 60, 60, 60, 60]) {
          await usage.fetchUsage();
          at += wait * MINUTE + 1000;
          clock.mockReturnValue(at);
        }
        expect(usage.getUsageData().gaveUp).toBe(true);

        readCredentials.mockResolvedValue(validCreds('after-login'));
        await usage.refreshUsage(null, true);

        expect(usage.getUsageData().gaveUp).toBe(false);
        expect(httpsGet.mock.calls.at(-1)[0].headers.Authorization).toBe('Bearer after-login');
      } finally { clock.mockRestore(); }
    });
  });

  /**
   * A token that ran out is not a store that refused. It is what an account
   * looks like once nothing has used it for a few hours, which is exactly what
   * happens to one that hit its limit: the user moves to another account, the
   * CLI stops renewing this one's token, and it expires. Treated as a refusal
   * it climbed the ladder and was given up on overnight, so going back to the
   * account the next morning left its chip on the last figure ever fetched.
   */
  describe('an expired token is not a refusal', () => {
    const MINUTE = 60 * 1000;
    const expiredCreds = () =>
      ({ claudeAiOauth: { accessToken: 'expired', refreshToken: 'r', expiresAt: Date.now() - 1000 } });

    test('rechecks on a flat interval instead of climbing the ladder', async () => {
      const usage = load();
      const start = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
      try {
        readCredentials.mockImplementation(async () => expiredCreds());
        let at = start;
        // A refusal would wait 5, 10, 20, 40, 60... and stop after eight.
        for (let i = 0; i < 12; i++) {
          await usage.fetchUsage();
          at += 5 * MINUTE + 1000;
          clock.mockReturnValue(at);
        }

        expect(readCredentials).toHaveBeenCalledTimes(12);
        expect(httpsGet).not.toHaveBeenCalled();
        expect(usage.getUsageData().gaveUp).toBe(false);
      } finally { clock.mockRestore(); }
    });

    test('still does not reopen the store on every poll', async () => {
      const usage = load();
      const start = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
      try {
        readCredentials.mockImplementation(async () => expiredCreds());
        await usage.fetchUsage();
        clock.mockReturnValue(start + 4 * MINUTE);
        await usage.fetchUsage();

        expect(readCredentials).toHaveBeenCalledTimes(1);
      } finally { clock.mockRestore(); }
    });

    test('picks up the token the CLI renewed, without a click', async () => {
      const usage = load();
      const start = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
      try {
        readCredentials.mockImplementation(async () => expiredCreds());
        // Idle long enough that a refusal would have been given up on.
        let at = start;
        for (let i = 0; i < 10; i++) {
          await usage.fetchUsage();
          at += 5 * MINUTE + 1000;
          clock.mockReturnValue(at);
        }

        readCredentials.mockResolvedValue(validCreds('renewed'));
        await usage.fetchUsage();

        expect(httpsGet.mock.calls.at(-1)[0].headers.Authorization).toBe('Bearer renewed');
        expect(usage.getUsageData().error).toBeNull();
      } finally { clock.mockRestore(); }
    });

    test('a store that refused before starts the ladder over once it answers', async () => {
      const usage = load();
      const start = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
      try {
        readCredentials.mockResolvedValue(null);
        await usage.fetchUsage();
        clock.mockReturnValue(start + 6 * MINUTE);
        await usage.fetchUsage();
        // Two refusals behind it: a third would wait twenty minutes.
        clock.mockReturnValue(start + 17 * MINUTE);
        readCredentials.mockImplementation(async () => expiredCreds());
        await usage.fetchUsage();
        const reads = readCredentials.mock.calls.length;
        expect(reads).toBe(3);

        clock.mockReturnValue(start + 23 * MINUTE);
        await usage.fetchUsage();

        expect(readCredentials.mock.calls.length).toBe(reads + 1);
      } finally { clock.mockRestore(); }
    });

    test('says the token will renew rather than asking for a login', async () => {
      const usage = load();
      readCredentials.mockImplementation(async () => expiredCreds());
      await usage.fetchUsage();

      const { error, stale } = usage.getUsageData();
      expect(stale).toBe(true);
      expect(error).toMatch(/renews/);
      expect(error).not.toMatch(/\/login/);
    });
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

/**
 * Figures past their window's reset.
 *
 * Within a window usage only goes up, so its last figure says nothing about
 * the window after it. An account that ran out at night kept reading 100% the
 * next morning, against 0% in Claude Desktop, for as long as nothing could
 * fetch a newer figure: its token had expired from disuse, and the endpoint
 * answers 429 often enough on its own.
 */
describe('figures past their reset', () => {
  const { asOfNow } = require('../../src/main/services/UsageService');
  const HOUR = 3600 * 1000;
  const NOW = Date.parse('2026-10-09T07:00:00Z');
  const sample = () => ({
    timestamp: '2026-10-08T20:00:00Z',
    buckets: [
      { id: 'session', type: 'session', label: null, labelKey: 'ui.session', utilization: 100, resetsAt: '2026-10-08T23:00:00Z' },
      { id: 'weekly', type: 'weekly', label: null, labelKey: 'ui.weekly', utilization: 40, resetsAt: '2026-10-11T06:00:00Z' },
      { id: 'scoped:Fable', type: 'scoped', label: 'Fable', labelKey: null, utilization: 0, resetsAt: null }
    ],
    extraUsage: null
  });

  test('reports a window that has reset the way the API reports an idle one', () => {
    const [session] = asOfNow(sample(), NOW).buckets;
    expect(session).toEqual({
      id: 'session', type: 'session', label: null, labelKey: 'ui.session', utilization: 0, resetsAt: null
    });
  });

  test('leaves a window that has not reset, and one with no reset time, alone', () => {
    const [, weekly, fable] = asOfNow(sample(), NOW).buckets;
    expect(weekly).toEqual(sample().buckets[1]);
    expect(fable).toEqual(sample().buckets[2]);
  });

  test('never rewrites what was fetched', () => {
    const data = sample();
    asOfNow(data, NOW);
    expect(data).toEqual(sample());
  });

  test('hands back the same object when nothing has reset', () => {
    const data = sample();
    expect(asOfNow(data, Date.parse('2026-10-08T21:00:00Z'))).toBe(data);
  });

  test('passes through figures it cannot read', () => {
    expect(asOfNow(null, NOW)).toBeNull();
    expect(asOfNow({ buckets: null }, NOW)).toEqual({ buckets: null });
  });

  describe('as served', () => {
    const CREDENTIALS_MODULE = '../../src/main/utils/claudeCredentials';

    afterEach(() => {
      jest.dontMock(CREDENTIALS_MODULE);
      jest.dontMock('https');
      jest.resetModules();
    });

    /** The account fills its session at `start`, then the endpoint starts answering 429. */
    function load(start) {
      const statuses = [200];
      jest.resetModules();
      jest.doMock(CREDENTIALS_MODULE, () => ({
        ...jest.requireActual(CREDENTIALS_MODULE),
        readCredentials: jest.fn().mockResolvedValue({
          claudeAiOauth: { accessToken: 'token-a', expiresAt: start + 24 * HOUR }
        })
      }));
      jest.doMock('https', () => ({
        get: (options, callback) => {
          const statusCode = statuses.length ? statuses.shift() : 429;
          const body = statusCode === 200
            ? JSON.stringify({
              limits: [
                { kind: 'session', percent: 100, resets_at: new Date(start + HOUR).toISOString() },
                { kind: 'weekly_all', percent: 40, resets_at: new Date(start + 72 * HOUR).toISOString() }
              ]
            })
            : JSON.stringify({ error: { type: 'rate_limit_error', message: 'Rate limited.' } });
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
        }
      }));
      return require('../../src/main/services/UsageService');
    }

    test('a full session reads empty once it has reset, even when no fetch succeeds', async () => {
      const start = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
      try {
        const usage = load(start);
        await usage.fetchUsage();
        expect(usage.getUsageData().data.buckets[0].utilization).toBe(100);

        clock.mockReturnValue(start + 2 * HOUR);
        const refreshed = await usage.refreshUsage();
        const served = usage.getUsageData();

        for (const data of [refreshed, served.data]) {
          expect(data.buckets.map(b => [b.id, b.utilization])).toEqual([['session', 0], ['weekly', 40]]);
        }
        // Still badged: nothing confirmed these figures, the clock did.
        expect(served.stale).toBe(true);
        expect(served.error).toMatch(/429/);
      } finally { clock.mockRestore(); }
    });
  });
});

/**
 * Figures reported by a chat session.
 *
 * The CLI forwards the plan's rate-limit headers on the SDK stream. Those keep
 * arriving when the usage endpoint answers 429, which it does to every caller
 * once the account's sessions hit the limit and each asks it why. The titlebar
 * used to sit on the last fetched figure meanwhile: 63% on a session the CLI
 * was refusing.
 */
describe('figures from the chat stream', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const CREDENTIALS_MODULE = '../../src/main/utils/claudeCredentials';
  const ACCOUNT_MANAGER = '../../src/main/services/AccountManager';
  const HOUR = 3600 * 1000;
  const SESSION_RESET = 1791584400;
  const WEEKLY_RESET = 1791698400;

  let dataDir;

  beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-usage-stream-')); });
  afterEach(() => {
    jest.dontMock(CREDENTIALS_MODULE);
    jest.dontMock('https');
    jest.dontMock(ACCOUNT_MANAGER);
    jest.dontMock('../../src/main/utils/paths');
    jest.resetModules();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  });

  /** The endpoint answers `statuses` in turn, then 429 for good. */
  function load(statuses = []) {
    const queue = [...statuses];
    const credentials = { claudeAiOauth: { accessToken: 'token-a', expiresAt: Date.now() + 24 * HOUR } };
    jest.resetModules();
    jest.doMock(CREDENTIALS_MODULE, () => ({
      ...jest.requireActual(CREDENTIALS_MODULE),
      readCredentials: jest.fn().mockResolvedValue(credentials)
    }));
    // A bound account's store is read through AccountManager.
    jest.doMock(ACCOUNT_MANAGER, () => ({
      credentialsForAccount: jest.fn().mockResolvedValue(credentials)
    }));
    jest.doMock('https', () => ({
      get: (options, callback) => {
        const statusCode = queue.length ? queue.shift() : 429;
        const body = statusCode === 200
          ? JSON.stringify({
            limits: [
              { kind: 'session', percent: 63, resets_at: '2099-01-01T00:00:00Z' },
              { kind: 'weekly_all', percent: 29, resets_at: '2099-01-05T00:00:00Z' },
              { kind: 'weekly_scoped', percent: 4, resets_at: null, scope: { model: { display_name: 'Fable' } } }
            ],
            extra_usage: { is_enabled: true, utilization: 100 }
          })
          : JSON.stringify({ error: { type: 'rate_limit_error', message: 'Rate limited.' } });
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
      }
    }));
    jest.doMock('../../src/main/utils/paths', () => ({
      ...jest.requireActual('../../src/main/utils/paths'),
      dataDir
    }));
    return require('../../src/main/services/UsageService');
  }

  const event = (fiveHour, sevenDay, extra = {}) => ({
    status: 'allowed',
    unifiedWindows: {
      five_hour: { utilization: fiveHour, resetsAt: SESSION_RESET },
      seven_day: { utilization: sevenDay, resetsAt: WEEKLY_RESET }
    },
    ...extra
  });
  const figures = data => data.buckets.map(b => [b.id, b.utilization]);

  test('moves the session and weekly bars, and leaves the rest as fetched', async () => {
    const usage = load([200]);
    await usage.fetchUsage('acc-team');
    const onUpdate = jest.fn();
    usage.onUpdate(onUpdate);

    expect(usage.applyRateLimitInfo('acc-team', event(0.87, 0.31))).toBe(true);

    const { data } = usage.getUsageData('acc-team');
    expect(figures(data)).toEqual([['session', 87], ['weekly', 31], ['scoped:Fable', 4]]);
    expect(data.buckets[0].resetsAt).toBe(new Date(SESSION_RESET * 1000).toISOString());
    expect(data.buckets[1].resetsAt).toBe(new Date(WEEKLY_RESET * 1000).toISOString());
    expect(data.extraUsage).toEqual({ is_enabled: true, utilization: 100 });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ buckets: data.buckets }), 'acc-team');
  });

  test('a refused window reads full, whatever the last header said', () => {
    const usage = load();
    usage.applyRateLimitInfo(null, event(0.98, 0.4, {
      status: 'rejected', rateLimitType: 'five_hour', resetsAt: SESSION_RESET
    }));
    expect(figures(usage.getUsageData(null).data)).toEqual([['session', 100], ['weekly', 40]]);
  });

  test('draws the bars before any fetch has landed', () => {
    const usage = load();
    usage.applyRateLimitInfo(null, event(0.25, 0.35));
    const { data, stale } = usage.getUsageData(null);
    expect(data.buckets).toEqual([
      { id: 'session', type: 'session', label: null, labelKey: 'ui.session', utilization: 25, resetsAt: new Date(SESSION_RESET * 1000).toISOString() },
      { id: 'weekly', type: 'weekly', label: null, labelKey: 'ui.weekly', utilization: 35, resetsAt: new Date(WEEKLY_RESET * 1000).toISOString() }
    ]);
    expect(data.extraUsage).toBeNull();
    expect(stale).toBe(false);
  });

  test('ignores an event that carries no window', () => {
    const usage = load();
    expect(usage.applyRateLimitInfo(null, { status: 'allowed' })).toBe(false);
    expect(usage.applyRateLimitInfo(null, undefined)).toBe(false);
    expect(usage.getUsageData(null).data).toBeNull();
  });

  test('lands on the account the session runs as, not the others', async () => {
    const usage = load([200, 200]);
    await usage.fetchUsage('acc-a');
    await usage.fetchUsage('acc-b');
    usage.applyRateLimitInfo('acc-b', event(0.9, 0.5));
    expect(usage.getUsageData('acc-a').data.buckets[0].utilization).toBe(63);
    expect(usage.getUsageData('acc-b').data.buckets[0].utilization).toBe(90);
  });

  test('stays current while the endpoint answers 429', async () => {
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
    try {
      const usage = load([200]);
      await usage.fetchUsage('acc-team');
      usage.applyRateLimitInfo('acc-team', event(1, 0.4, { status: 'rejected', rateLimitType: 'five_hour' }));

      clock.mockReturnValue(start + 60 * 1000);
      const refreshed = await usage.refreshUsage('acc-team');
      const served = usage.getUsageData('acc-team');
      expect(figures(refreshed).slice(0, 2)).toEqual([['session', 100], ['weekly', 40]]);
      // The endpoint failed, but the figures were confirmed a minute ago.
      expect(served.stale).toBe(false);
      expect(served.error).toMatch(/429/);

      // Once the stream has gone quiet for long enough, they are old like any other.
      clock.mockReturnValue(start + 11 * 60 * 1000);
      await usage.refreshUsage('acc-team');
      expect(usage.getUsageData('acc-team').stale).toBe(true);
    } finally { clock.mockRestore(); }
  });

  test('a failed fetch with no stream behind it is still badged at once', async () => {
    const usage = load([200]);
    await usage.fetchUsage('acc-team');
    await usage.refreshUsage('acc-team');
    expect(usage.getUsageData('acc-team').stale).toBe(true);
  });
});
