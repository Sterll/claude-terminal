/**
 * @jest-environment node
 */

/**
 * Who a saved account is: the account and organisation ids a duplicate is
 * refused on.
 *
 * A sign-in reads them from the config the CLI wrote; a capture and a backfill
 * ask the API for the token's own profile, since ~/.claude.json keeps naming
 * whoever ran `claude /login` last even after an account switch. Before this,
 * "Save current account" recorded no identity at all, so connecting the same
 * account afterwards saved it a second time.
 *
 * Runs the file store (as off macOS) so the stand-in CLI, a separate process,
 * can write the credentials where the app then reads them.
 */

const fs = require('fs');
const path = require('path');

jest.mock('../../src/main/utils/paths', () => {
  const fsMock = require('fs');
  const osMock = require('os');
  const pathMock = require('path');
  const root = fsMock.mkdtempSync(pathMock.join(osMock.tmpdir(), 'ct-acct-identity-'));
  return {
    dataDir: pathMock.join(root, 'data'),
    claudeDir: pathMock.join(root, 'claude'),
    _root: root
  };
});

jest.mock('../../src/main/utils/macKeychain', () => ({
  getPassword: jest.fn(async () => null),
  setPassword: jest.fn(async () => {}),
  deletePassword: jest.fn(async () => true)
}));

const mockProfiles = new Map();
jest.mock('../../src/main/utils/oauthProfile', () => ({
  fetchOAuthIdentity: jest.fn(async (token) => mockProfiles.get(token) ?? null),
}));

const paths = require('../../src/main/utils/paths');
const { fetchOAuthIdentity } = require('../../src/main/utils/oauthProfile');
const AccountManager = require('../../src/main/services/AccountManager');

const FAKE_CLI = path.join(__dirname, '..', 'helpers', 'fake-claude-login.js');
const FAKE_ENV = ['FAKE_LOGIN_MODE', 'FAKE_LOGIN_TOKEN', 'FAKE_LOGIN_EMAIL', 'FAKE_LOGIN_ACCOUNT', 'FAKE_LOGIN_ORG'];
const configDir = () => path.join(paths._root, 'claude-config');
const indexFile = () => path.join(paths.dataDir, 'accounts', 'index.json');
const savedAccounts = () => JSON.parse(fs.readFileSync(indexFile(), 'utf8')).accounts;

const realPlatform = process.platform;

function loginAs(accessToken) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(path.join(configDir(), '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken: `refresh-${accessToken}`,
      expiresAt: Date.now() + 3600 * 1000,
      subscriptionType: 'max',
    }
  }));
}

function signIn(fake = {}) {
  for (const [key, value] of Object.entries(fake)) process.env[`FAKE_LOGIN_${key}`] = value;
  return AccountManager.startLogin({ command: process.execPath, commandArgs: [FAKE_CLI] });
}

beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  process.env.CLAUDE_CONFIG_DIR = configDir();
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(paths._root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

beforeEach(() => {
  fs.rmSync(paths.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  fs.rmSync(configDir(), { recursive: true, force: true });
  for (const key of FAKE_ENV) delete process.env[key];
  mockProfiles.clear();
  fetchOAuthIdentity.mockClear();
});

describe('captureCurrent', () => {
  test('records who the token belongs to, and names the account after the email', async () => {
    mockProfiles.set('tok-a', { accountUuid: 'acct-1', email: 'max@example.com', organizationUuid: 'org-1' });
    loginAs('tok-a');

    const account = await AccountManager.captureCurrent('');

    expect(account.name).toBe('max@example.com');
    expect(fetchOAuthIdentity).toHaveBeenCalledWith('tok-a');
    expect(savedAccounts()[0]).toMatchObject({ accountUuid: 'acct-1', organizationUuid: 'org-1', email: 'max@example.com' });
  });

  test('refuses the same account under a rotated token', async () => {
    // The fingerprint alone let this through: a refresh mints a new token.
    mockProfiles.set('tok-a', { accountUuid: 'acct-1', email: null, organizationUuid: 'org-1' });
    mockProfiles.set('tok-a2', { accountUuid: 'acct-1', email: null, organizationUuid: 'org-1' });
    loginAs('tok-a');
    await AccountManager.captureCurrent('Max');
    loginAs('tok-a2');

    await expect(AccountManager.captureCurrent('Again'))
      .rejects.toMatchObject({ code: 'ACCOUNT_DUPLICATE', accountName: 'Max' });
    expect(savedAccounts()).toHaveLength(1);
  });

  test('still captures when the API cannot say who the token is', async () => {
    loginAs('tok-offline');
    const account = await AccountManager.captureCurrent('Offline');
    expect(account.name).toBe('Offline');
    expect(savedAccounts()[0].accountUuid).toBeUndefined();
  });
});

describe('startLogin against a captured account', () => {
  test('refuses to connect an account already saved through a capture', async () => {
    mockProfiles.set('tok-a', { accountUuid: 'acct-1', email: null, organizationUuid: 'org-1' });
    loginAs('tok-a');
    await AccountManager.captureCurrent('Max');

    await expect(signIn({ MODE: 'callback', TOKEN: 'token-b', ACCOUNT: 'acct-1', ORG: 'org-1' }))
      .rejects.toMatchObject({ code: 'ACCOUNT_DUPLICATE', accountName: 'Max' });
    expect(savedAccounts()).toHaveLength(1);
  });
});

describe('startLogin with reconnectId', () => {
  const snapshotOf = (id) => JSON.parse(fs.readFileSync(path.join(paths.dataDir, 'accounts', `${id}.json`), 'utf8'));
  const ownStoreOf = (id) => JSON.parse(fs.readFileSync(
    path.join(paths.dataDir, 'accounts', 'config', id, '.credentials.json'), 'utf8'));
  const accountDirs = () => fs.readdirSync(path.join(paths.dataDir, 'accounts', 'config'));

  function reconnect(id, fake = {}) {
    for (const [key, value] of Object.entries(fake)) process.env[`FAKE_LOGIN_${key}`] = value;
    return AccountManager.startLogin({ command: process.execPath, commandArgs: [FAKE_CLI], reconnectId: id });
  }

  test('renews the saved account in place, its own store and the machine-wide one with it', async () => {
    mockProfiles.set('tok-a', { accountUuid: 'acct-1', email: null, organizationUuid: 'org-1' });
    loginAs('tok-a');
    const saved = await AccountManager.captureCurrent('Max');

    const account = await reconnect(saved.id, { MODE: 'callback', TOKEN: 'token-new', ACCOUNT: 'acct-1', ORG: 'org-1' });

    expect(account).toMatchObject({ id: saved.id, name: 'Max' });
    expect(savedAccounts()).toHaveLength(1);
    expect(snapshotOf(saved.id).claudeAiOauth.accessToken).toBe('token-new');
    expect(ownStoreOf(saved.id).claudeAiOauth.accessToken).toBe('token-new');
    // Captured, so it is the live account: the machine-wide store is its record.
    const live = JSON.parse(fs.readFileSync(path.join(configDir(), '.credentials.json'), 'utf8'));
    expect(live.claudeAiOauth.accessToken).toBe('token-new');
    // The scratch store the sign-in ran in is gone.
    expect(accountDirs()).toEqual([saved.id]);
  });

  test('refuses a sign-in that lands on another account and leaves the saved one alone', async () => {
    mockProfiles.set('tok-a', { accountUuid: 'acct-1', email: null, organizationUuid: 'org-1' });
    loginAs('tok-a');
    const saved = await AccountManager.captureCurrent('Max');

    await expect(reconnect(saved.id, { MODE: 'callback', TOKEN: 'token-other', ACCOUNT: 'acct-2', ORG: 'org-1' }))
      .rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH', accountName: 'Max' });
    expect(snapshotOf(saved.id).claudeAiOauth.accessToken).toBe('tok-a');
    expect(accountDirs()).toEqual([saved.id]);
  });

  test('refuses an account that does not exist before starting the CLI', async () => {
    await expect(reconnect('nope', { MODE: 'callback' })).rejects.toThrow(/not found/);
  });
});

describe('recordIdentity', () => {
  test('fills in an account saved without one, then stops asking', async () => {
    loginAs('tok-old');
    const account = await AccountManager.captureCurrent('Legacy');
    expect(savedAccounts()[0].accountUuid).toBeUndefined();
    mockProfiles.set('tok-now', { accountUuid: 'acct-9', email: 'legacy@example.com', organizationUuid: null });

    await expect(AccountManager.recordIdentity(account.id, 'tok-now')).resolves.toBe(true);
    expect(savedAccounts()[0]).toMatchObject({ accountUuid: 'acct-9', email: 'legacy@example.com' });
    // A user-chosen name is never replaced by the email.
    expect(savedAccounts()[0].name).toBe('Legacy');

    fetchOAuthIdentity.mockClear();
    await expect(AccountManager.recordIdentity(account.id, 'tok-now')).resolves.toBe(false);
    expect(fetchOAuthIdentity).not.toHaveBeenCalled();
  });

  test('asks once per account even when the API has no answer', async () => {
    loginAs('tok-x');
    const account = await AccountManager.captureCurrent('Unknown');
    fetchOAuthIdentity.mockClear();

    await expect(AccountManager.recordIdentity(account.id, 'tok-x')).resolves.toBe(false);
    await expect(AccountManager.recordIdentity(account.id, 'tok-x')).resolves.toBe(false);
    expect(fetchOAuthIdentity).toHaveBeenCalledTimes(1);
  });

  test('never asks about an account that is already identified', async () => {
    mockProfiles.set('tok-a', { accountUuid: 'acct-1', email: null, organizationUuid: 'org-1' });
    loginAs('tok-a');
    const account = await AccountManager.captureCurrent('Max');
    fetchOAuthIdentity.mockClear();

    await expect(AccountManager.recordIdentity(account.id, 'tok-a')).resolves.toBe(false);
    expect(fetchOAuthIdentity).not.toHaveBeenCalled();
  });
});
