/**
 * `signedOut`: the usage figures' verdict that an account needs signing in
 * again, which the startup warning and the Settings rows act on.
 *
 * It has to be narrower than "no figures". An expired access token is the
 * normal state of an account nobody ran for a few hours (the CLI renews it on
 * its next run), and a store that did not answer says nothing about the
 * account at all. Only a store that answered with no token, or with the very
 * token the API refused, is signed out.
 */
const CREDENTIALS_MODULE = '../../src/main/utils/claudeCredentials';
const HOUR = 3600 * 1000;

let readCredentials;
let httpsGet;

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
  jest.doMock(CREDENTIALS_MODULE, () => ({ ...jest.requireActual(CREDENTIALS_MODULE), readCredentials }));
  jest.doMock('https', () => ({ get: httpsGet }));
  return require('../../src/main/services/UsageService');
}

afterEach(() => {
  jest.dontMock(CREDENTIALS_MODULE);
  jest.dontMock('https');
  jest.resetModules();
});

describe('signedOut', () => {
  test('a store whose access token the CLI blanked is signed out', async () => {
    const usage = load();
    readCredentials.mockResolvedValue({ claudeAiOauth: { accessToken: '', refreshToken: 'r', expiresAt: 0 } });
    await usage.fetchUsage();
    expect(usage.getUsageData().signedOut).toBe(true);
    expect(usage.getFetchState().signedOut).toBe(true);
  });

  test('an expired token is not: the CLI renews it on its next run', async () => {
    const usage = load();
    readCredentials.mockResolvedValue({ claudeAiOauth: { accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() - 1000 } });
    await usage.fetchUsage();
    expect(usage.getUsageData().signedOut).toBe(false);
  });

  test('a store that did not answer is not either', async () => {
    const usage = load();
    readCredentials.mockRejectedValue(new Error('User canceled the operation.'));
    await usage.fetchUsage();
    expect(usage.getUsageData().signedOut).toBe(false);
  });

  test('the token the API refused, still in the store on the re-read, is signed out until a new login lands', async () => {
    const usage = load([401, 401, 200]);
    readCredentials.mockResolvedValue({ claudeAiOauth: { accessToken: 'dead', expiresAt: Date.now() + HOUR } });
    await usage.fetchUsage();
    // One refusal could be a rotation in flight: not yet a verdict.
    expect(usage.getUsageData().signedOut).toBe(false);
    await usage.fetchUsage();
    expect(usage.getUsageData().signedOut).toBe(true);

    readCredentials.mockResolvedValue({ claudeAiOauth: { accessToken: 'fresh', expiresAt: Date.now() + HOUR } });
    await usage.refreshUsage(null, true);
    expect(usage.getUsageData().signedOut).toBe(false);
  });

  test('invalidating the credentials drops the verdict', async () => {
    const usage = load();
    readCredentials.mockResolvedValue({ claudeAiOauth: { accessToken: '' } });
    await usage.fetchUsage();
    expect(usage.getUsageData().signedOut).toBe(true);
    usage.invalidateCredentials(null);
    expect(usage.getUsageData().signedOut).toBe(false);
  });
});
