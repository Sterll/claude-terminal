/** @jest-environment node */
/**
 * What every caller is told about a GitHub login that is missing or that
 * GitHub refused. A 401 used to come back as an "API error: 401" on an empty
 * list, or GitHub's bare "Bad credentials", and an outage signed the user out;
 * now a refused token reads as `expired` everywhere, is dropped from the
 * store, and nothing else drops it. Network faked at `https`, the credential
 * store at keytar.
 */

'use strict';

const { EventEmitter } = require('events');

const mockStore = new Map();
jest.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
jest.mock('keytar', () => ({
  getPassword: jest.fn(async (service, account) => mockStore.get(`${service}/${account}`) || null),
  setPassword: jest.fn(async (service, account, value) => { mockStore.set(`${service}/${account}`, value); }),
  deletePassword: jest.fn(async (service, account) => mockStore.delete(`${service}/${account}`)),
}));
jest.mock('https', () => ({ request: jest.fn() }));

const https = require('https');
const keytar = require('keytar');
const github = require('../../src/main/services/GitHubAuthService');

const KEY = 'claude-terminal/github-token';
const flush = () => new Promise(r => setImmediate(r));

/** Answer the next request with `body` and `status`, as GitHub would. */
function answer(body, status = 200) {
  https.request.mockImplementationOnce((options, onResponse) => {
    const req = new EventEmitter();
    req.options = options;
    req.setTimeout = () => {};
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = status;
      res.headers = {};
      res.resume = () => {};
      onResponse(res);
      res.emit('data', JSON.stringify(body));
      res.emit('end');
    };
    return req;
  });
}

beforeEach(async () => {
  https.request.mockReset();
  keytar.deletePassword.mockClear();
  mockStore.clear();
  // A fresh start: "Connect", not "Reconnect".
  await github.deleteToken();
  keytar.deletePassword.mockClear();
  mockStore.set(KEY, 'gho_live');
});

describe('a token GitHub refused', () => {
  test('a read that meets a 401 says expired, not an API error, and the token is dropped', async () => {
    answer({ message: 'Bad credentials' }, 401);
    const res = await github.getPullRequestsForBranch('acme', 'app', 'acme', 'feat');
    expect(res).toMatchObject({ authenticated: false, expired: true, pullRequests: [] });
    expect(res.error).toBeUndefined();
    await flush();
    expect(mockStore.has(KEY)).toBe(false);
    expect(github.isTokenRejected()).toBe(true);

    // Every later read, with no token left, still says why.
    await expect(github.getIssues('acme', 'app')).resolves.toMatchObject({ authenticated: false, expired: true });
    expect(https.request).toHaveBeenCalledTimes(1);
  });

  test('a write that meets a 401 carries a code, not only "Bad credentials"', async () => {
    answer({ message: 'Bad credentials' }, 401);
    const res = await github.mergePullRequest('acme', 'app', 4);
    expect(res).toMatchObject({ success: false, code: 'GITHUB_TOKEN_EXPIRED', expired: true });
  });

  test('without any token, a write says not connected', async () => {
    mockStore.clear();
    await expect(github.createIssue('acme', 'app', 'Title')).resolves.toMatchObject({ success: false, code: 'GITHUB_NOT_CONNECTED' });
    await expect(github.getPullRequests('acme', 'app')).resolves.toEqual({ authenticated: false, pullRequests: [] });
  });

  test('reconnecting clears it, and so does disconnecting', async () => {
    answer({}, 401);
    await github.getCheckRuns('acme', 'app', 'sha');
    await flush();
    await github.setToken('gho_new');
    expect(github.isTokenRejected()).toBe(false);

    answer({}, 401);
    await github.getCheckRuns('acme', 'app', 'sha');
    await flush();
    expect(github.isTokenRejected()).toBe(true);
    await github.deleteToken();
    expect(github.isTokenRejected()).toBe(false);
    await expect(github.getIssues('acme', 'app')).resolves.toEqual({ authenticated: false, issues: [] });
  });

  test('a refusal of an older token does not drop the one stored since', async () => {
    https.request.mockImplementationOnce((options, onResponse) => {
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.write = () => {};
      req.destroy = () => {};
      req.end = () => {
        // The user reconnects while this request, sent with the old token, is in flight.
        mockStore.set(KEY, 'gho_fresh');
        const res = new EventEmitter();
        res.statusCode = 401;
        res.headers = {};
        onResponse(res);
        res.emit('data', '{}');
        res.emit('end');
      };
      return req;
    });
    await github.getIssues('acme', 'app');
    await flush();
    expect(mockStore.get(KEY)).toBe('gho_fresh');
  });
});

describe('the auth status', () => {
  test('a 401 is expired, and drops the token', async () => {
    answer({ message: 'Bad credentials' }, 401);
    await expect(github.getAuthStatus()).resolves.toEqual({ authenticated: false, expired: true });
    await flush();
    expect(mockStore.has(KEY)).toBe(false);
  });

  test.each([403, 500, 503])('a %i keeps the token: an outage or a rate limit says nothing about it', async (status) => {
    answer({ message: 'nope' }, status);
    const res = await github.getAuthStatus();
    expect(res).toMatchObject({ authenticated: false, error: `API error: ${status}` });
    await flush();
    expect(mockStore.get(KEY)).toBe('gho_live');
    expect(keytar.deletePassword).not.toHaveBeenCalled();
  });

  test('a 200 is the user', async () => {
    answer({ login: 'octo', name: 'Octo Cat', avatar_url: 'https://a' });
    await expect(github.getAuthStatus()).resolves.toMatchObject({ authenticated: true, login: 'octo' });
  });
});

describe('the device flow', () => {
  const deviceCode = (code) => answer({ device_code: code, user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5 });

  test('a cancelled sign-in stops polling at once, and stores nothing', async () => {
    deviceCode('dev-1');
    await github.startDeviceFlow();
    const poll = github.pollForToken('dev-1', 5);
    expect(github.cancelDeviceFlow()).toBe(true);
    await expect(poll).rejects.toMatchObject({ code: 'GITHUB_AUTH_CANCELLED' });
    expect(https.request).toHaveBeenCalledTimes(1); // the start, no poll request
  });

  test('a second sign-in supersedes the first one', async () => {
    deviceCode('dev-1');
    await github.startDeviceFlow();
    const first = github.pollForToken('dev-1', 5);
    deviceCode('dev-2');
    await github.startDeviceFlow();
    await expect(first).rejects.toMatchObject({ code: 'GITHUB_AUTH_CANCELLED' });
    github.cancelDeviceFlow();
  });

  test('an authorized code gives the token', async () => {
    deviceCode('dev-3');
    await github.startDeviceFlow();
    answer({ error: 'authorization_pending' });
    answer({ access_token: 'gho_device' });
    await expect(github.pollForToken('dev-3', 0.01)).resolves.toBe('gho_device');
    expect(github.cancelDeviceFlow()).toBe(false); // nothing left to poll
  });
});
