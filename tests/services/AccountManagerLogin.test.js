/**
 * @jest-environment node
 */

/**
 * AccountManager.startLogin: connecting an account through `claude auth login`
 * rather than capturing the machine-wide login.
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
  const root = fsMock.mkdtempSync(pathMock.join(osMock.tmpdir(), 'ct-acct-login-'));
  return {
    dataDir: pathMock.join(root, 'data'),
    claudeDir: pathMock.join(root, 'claude'),
    _root: root
  };
});

// Never reached on the file store; mocked so nothing can touch the real keychain.
jest.mock('../../src/main/utils/macKeychain', () => ({
  getPassword: jest.fn(async () => null),
  setPassword: jest.fn(async () => {}),
  deletePassword: jest.fn(async () => true)
}));

const paths = require('../../src/main/utils/paths');
const AccountManager = require('../../src/main/services/AccountManager');
const { SECURESTORAGE_ENV } = require('../../src/main/utils/claudeCredentials');

const FAKE_CLI = path.join(__dirname, '..', 'helpers', 'fake-claude-login.js');
const accountsDir = () => path.join(paths.dataDir, 'accounts');
const machineStore = () => path.join(paths._root, 'claude-config', '.credentials.json');

const realPlatform = process.platform;
const FAKE_ENV = ['FAKE_LOGIN_MODE', 'FAKE_LOGIN_TOKEN', 'FAKE_LOGIN_EMAIL', 'FAKE_LOGIN_ACCOUNT', 'FAKE_LOGIN_ORG'];

beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  // The machine-wide store, which a sign-in must leave alone.
  process.env.CLAUDE_CONFIG_DIR = path.join(paths._root, 'claude-config');
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(paths._root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

beforeEach(() => {
  fs.rmSync(paths.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  for (const key of FAKE_ENV) delete process.env[key];
});

/**
 * Sign in through the stand-in CLI.
 * @param {Object} fake - FAKE_LOGIN_* values, without the prefix
 * @param {(url: string) => void} [onUrl]
 */
function signIn(fake = {}, { name, onUrl, onInvalidCode } = {}) {
  for (const [key, value] of Object.entries(fake)) process.env[`FAKE_LOGIN_${key}`] = value;
  return AccountManager.startLogin({
    command: process.execPath,
    commandArgs: [FAKE_CLI],
    name,
    onUrl,
    onInvalidCode,
  });
}

/** Resolves on the URL, then pastes `code`. */
function pasting(code) {
  return (url) => {
    expect(url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize/);
    AccountManager.submitLoginCode(code);
  };
}

const storeDirs = () => {
  const dir = path.join(accountsDir(), 'config');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};
const scratchDirs = () => (fs.existsSync(accountsDir()) ? fs.readdirSync(accountsDir()) : [])
  .filter(name => name.startsWith('login-'));

describe('startLogin', () => {
  test('creates an account on a store of its own, named after its email', async () => {
    const account = await signIn({ EMAIL: 'max@example.com' }, { onUrl: pasting('abc#state') });

    expect(account.name).toBe('max@example.com');
    const list = await AccountManager.listAccounts();
    expect(list.accounts.map(a => a.id)).toEqual([account.id]);

    // Spawns for this account read the store the CLI signed into.
    const env = await AccountManager.accountEnv(account.id);
    expect(env).toEqual({ [SECURESTORAGE_ENV]: AccountManager.accountConfigDir(account.id) });
    const snapshot = JSON.parse(fs.readFileSync(path.join(accountsDir(), `${account.id}.json`), 'utf8'));
    expect(snapshot.claudeAiOauth.accessToken).toBe('fresh-token');
  });

  test('leaves the machine-wide login and the default alone', async () => {
    const account = await signIn({ MODE: 'callback' });

    expect(fs.existsSync(machineStore())).toBe(false);
    const list = await AccountManager.listAccounts();
    expect(list.defaultId).toBeNull();
    expect(list.liveId).toBeNull();
    expect(await AccountManager.ownsLiveStore(account.id)).toBe(false);
  });

  test('takes the name it is given over the email', async () => {
    const account = await signIn({ MODE: 'callback' }, { name: '  Team  ' });
    expect(account.name).toBe('Team');
  });

  test('throws the scratch config away once the identity is read', async () => {
    await signIn({ MODE: 'callback' });
    expect(scratchDirs()).toEqual([]);
  });

  test('refuses the same account and organisation twice, and drops the second store', async () => {
    const first = await signIn({ MODE: 'callback', TOKEN: 'token-a', ACCOUNT: 'acct-1', ORG: 'org-1' }, { name: 'Max' });
    await expect(signIn({ MODE: 'callback', TOKEN: 'token-b', ACCOUNT: 'acct-1', ORG: 'org-1' }))
      .rejects.toThrow('This account is already saved as "Max".');

    expect((await AccountManager.listAccounts()).accounts).toHaveLength(1);
    expect(storeDirs()).toEqual([first.id]);
  });

  test('accepts the same person in another organisation', async () => {
    await signIn({ MODE: 'callback', TOKEN: 'token-a', ACCOUNT: 'acct-1', ORG: 'personal' });
    await signIn({ MODE: 'callback', TOKEN: 'token-b', ACCOUNT: 'acct-1', ORG: 'team' });
    expect((await AccountManager.listAccounts()).accounts).toHaveLength(2);
  });

  test('a failed sign-in leaves no account and no store behind', async () => {
    await expect(signIn({}, { onUrl: pasting('bad#state') }))
      .rejects.toMatchObject({ code: 'LOGIN_FAILED' });

    expect((await AccountManager.listAccounts()).accounts).toEqual([]);
    expect(storeDirs()).toEqual([]);
    expect(scratchDirs()).toEqual([]);
  });

  test('a sign-in that wrote no credentials is not an account', async () => {
    await expect(signIn({ MODE: 'empty' })).rejects.toThrow(/no usable credentials/);
    expect(storeDirs()).toEqual([]);
  });

  test('a refused code can be followed by a good one', async () => {
    const refusals = [];
    const account = await signIn({}, {
      onUrl: pasting('missing-state'),
      onInvalidCode: () => {
        refusals.push(true);
        AccountManager.submitLoginCode('good#state');
      },
    });
    expect(refusals).toHaveLength(1);
    expect(account.id).toBeTruthy();
  });

  test('cancelling stops the CLI and cleans up', async () => {
    const pending = signIn({ MODE: 'hang' }, { onUrl: () => AccountManager.cancelLogin() });
    await expect(pending).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' });
    expect(storeDirs()).toEqual([]);
    expect(AccountManager.submitLoginCode('late#state')).toBe(false);
  });

  test('starting a sign-in cancels the one in progress', async () => {
    let first;
    const urlShown = new Promise((resolve) => {
      first = signIn({ MODE: 'hang' }, { onUrl: resolve });
    });
    await urlShown;
    // The second run reads FAKE_LOGIN_MODE when it starts.
    const second = signIn({ MODE: 'callback' });
    await expect(first).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' });
    await expect(second).resolves.toMatchObject({ name: 'someone@example.com' });
  });
});
