/**
 * @jest-environment node
 */

/**
 * oauthProfile: who an OAuth token belongs to, from /api/oauth/profile.
 * It must never reject, since the identity is only ever a nicety.
 */

const { EventEmitter } = require('events');

jest.mock('https', () => ({ get: jest.fn() }));
const https = require('https');
const { fetchOAuthIdentity, parseProfile } = require('../../src/main/utils/oauthProfile');

/** Answer the next https.get with `status` and `body`. */
function respond(status, body) {
  https.get.mockImplementationOnce((_opts, onResponse) => {
    const req = new EventEmitter();
    req.destroy = jest.fn();
    process.nextTick(() => {
      const res = new EventEmitter();
      res.statusCode = status;
      onResponse(res);
      res.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
      res.emit('end');
    });
    return req;
  });
}

const PROFILE = {
  account: { uuid: 'acct-1', email: 'max@example.com', display_name: 'Max' },
  organization: { uuid: 'org-1', billing_type: 'stripe_subscription' },
};

beforeEach(() => https.get.mockReset());

describe('parseProfile', () => {
  test('keeps the account, its email and its organisation', () => {
    expect(parseProfile(PROFILE)).toEqual({ accountUuid: 'acct-1', email: 'max@example.com', organizationUuid: 'org-1' });
  });

  test('a body with no account id is no identity', () => {
    expect(parseProfile({ organization: { uuid: 'org-1' } })).toBeNull();
    expect(parseProfile(null)).toBeNull();
  });

  test('a missing organisation or email is null, not undefined', () => {
    expect(parseProfile({ account: { uuid: 'acct-1' } }))
      .toEqual({ accountUuid: 'acct-1', email: null, organizationUuid: null });
  });
});

describe('fetchOAuthIdentity', () => {
  test('asks with the token as a bearer', async () => {
    respond(200, PROFILE);
    await expect(fetchOAuthIdentity('tok')).resolves.toMatchObject({ accountUuid: 'acct-1' });
    const [opts] = https.get.mock.calls[0];
    expect(opts.hostname).toBe('api.anthropic.com');
    expect(opts.path).toBe('/api/oauth/profile');
    expect(opts.headers.Authorization).toBe('Bearer tok');
  });

  test('no token, no request', async () => {
    await expect(fetchOAuthIdentity(null)).resolves.toBeNull();
    expect(https.get).not.toHaveBeenCalled();
  });

  test('a refused token, a bad body or a network error all answer null', async () => {
    respond(401, { error: 'invalid' });
    await expect(fetchOAuthIdentity('tok')).resolves.toBeNull();

    respond(200, 'not json');
    await expect(fetchOAuthIdentity('tok')).resolves.toBeNull();

    https.get.mockImplementationOnce(() => {
      const req = new EventEmitter();
      process.nextTick(() => req.emit('error', new Error('ENOTFOUND')));
      return req;
    });
    await expect(fetchOAuthIdentity('tok')).resolves.toBeNull();
  });
});
