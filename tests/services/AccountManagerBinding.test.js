/**
 * AccountManager — per-project bindings.
 *
 * Covers what changes once a project can pin itself to an account: the
 * defaultId / liveId split, per-account credential directories, and the
 * environment overlay a spawn inherits.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

jest.mock('../../src/main/utils/paths', () => {
  const fsMock = require('fs');
  const osMock = require('os');
  const pathMock = require('path');
  const root = fsMock.mkdtempSync(pathMock.join(osMock.tmpdir(), 'ct-acct-bind-'));
  return {
    dataDir: pathMock.join(root, 'data'),
    claudeDir: pathMock.join(root, 'claude'),
    _root: root
  };
});

// The real keytar would hit the developer's login keychain.
const mockKeychain = new Map();
jest.mock('keytar', () => ({
  getPassword: jest.fn(async (service, account) => mockKeychain.get(`${service}:${account}`) ?? null),
  setPassword: jest.fn(async (service, account, secret) => { mockKeychain.set(`${service}:${account}`, secret); }),
  deletePassword: jest.fn(async (service, account) => mockKeychain.delete(`${service}:${account}`))
}));

const paths = require('../../src/main/utils/paths');
const AccountManager = require('../../src/main/services/AccountManager');
const { SECURESTORAGE_ENV, keychainServiceForDir } = require('../../src/main/utils/claudeCredentials');

const MACHINE_KEY = `Claude Code-credentials:${os.userInfo().username}`;

const realPlatform = process.platform;
const setPlatform = (value) => {
  Object.defineProperty(process, 'platform', { value, configurable: true });
};

const creds = (accessToken, subscriptionType = 'max') => ({
  claudeAiOauth: {
    accessToken,
    refreshToken: `refresh-${accessToken}`,
    expiresAt: 1893456000000,
    refreshTokenExpiresAt: 1900000000000,
    subscriptionType
  }
});

const seedPath = (id) => path.join(paths.dataDir, 'accounts', 'config', id, '.credentials.json');
const namespacedKey = (dir) => `${keychainServiceForDir(dir)}:${os.userInfo().username}`;

beforeAll(() => {
  process.env.CLAUDE_CONFIG_DIR = path.join(paths._root, 'claude-config');
});

afterAll(() => {
  setPlatform(realPlatform);
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(paths._root, { recursive: true, force: true });
});

beforeEach(() => {
  mockKeychain.clear();
  fs.rmSync(path.join(paths.dataDir, 'accounts'), { recursive: true, force: true });
  fs.rmSync(path.join(paths._root, 'claude-config'), { recursive: true, force: true });
  setPlatform('darwin');
});

const capture = async (name, token, plan = 'max') => {
  mockKeychain.set(MACHINE_KEY, JSON.stringify(creds(token, plan)));
  return AccountManager.captureCurrent(name);
};

describe('default vs live', () => {
  test('the first captured account becomes the default', async () => {
    const max = await capture('Max 20x', 'tok-max');
    const list = await AccountManager.listAccounts();
    expect(list.defaultId).toBe(max.id);
    expect(list.liveId).toBe(max.id);
  });

  test('a later capture does not steal the default', async () => {
    const max = await capture('Max 20x', 'tok-max');
    const team = await capture('Team', 'tok-team', 'team');

    const list = await AccountManager.listAccounts();
    expect(list.defaultId).toBe(max.id);
    // It is what `claude /login` last wrote, though.
    expect(list.liveId).toBe(team.id);
  });

  test('setDefault puts the account in the machine-wide store', async () => {
    const max = await capture('Max 20x', 'tok-max');
    const team = await capture('Team', 'tok-team', 'team');

    await AccountManager.setDefault(max.id);

    // Unbound work reads the machine-wide store, so a default that only moved
    // a pointer would be a default nothing actually used.
    expect(JSON.parse(mockKeychain.get(MACHINE_KEY)).claudeAiOauth.subscriptionType).toBe('max');
    const list = await AccountManager.listAccounts();
    expect(list.defaultId).toBe(max.id);
    expect(list.liveId).toBe(max.id);
    expect(team.id).not.toBe(list.defaultId);
  });

  test('setDefault rejects an unknown account', async () => {
    await expect(AccountManager.setDefault('nope')).rejects.toThrow(/not found/);
  });
});

describe('index migration', () => {
  test('an activeId index becomes both defaultId and liveId', async () => {
    const max = await capture('Max 20x', 'tok-max');

    // Rewrite the index in the pre-binding shape.
    const indexFile = path.join(paths.dataDir, 'accounts', 'index.json');
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    delete index.defaultId;
    delete index.liveId;
    index.activeId = max.id;
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));

    const list = await AccountManager.listAccounts();
    expect(list.defaultId).toBe(max.id);
    expect(list.liveId).toBe(max.id);
  });
});

describe('colour', () => {
  test('updateAccount patches one field without blanking the other', async () => {
    const max = await capture('Max 20x', 'tok-max');

    await AccountManager.updateAccount(max.id, { color: '#ff5733' });
    expect((await AccountManager.updateAccount(max.id, { name: 'Perso' })).color).toBe('#ff5733');

    const stored = (await AccountManager.listAccounts()).accounts[0];
    expect(stored.name).toBe('Perso');
    expect(stored.color).toBe('#ff5733');
  });

  test('a colour can be cleared', async () => {
    const max = await capture('Max 20x', 'tok-max');
    await AccountManager.updateAccount(max.id, { color: '#ff5733' });
    expect((await AccountManager.updateAccount(max.id, { color: null })).color).toBeNull();
  });
});

describe('per-account credential store', () => {
  test('capture seeds the account directory', async () => {
    const max = await capture('Max 20x', 'tok-max');
    expect(fs.existsSync(seedPath(max.id))).toBe(true);
    expect(JSON.parse(fs.readFileSync(seedPath(max.id), 'utf8')).claudeAiOauth.accessToken).toBe('tok-max');
  });

  test('accountEnv points a spawn at that directory', async () => {
    const max = await capture('Max 20x', 'tok-max');

    const env = await AccountManager.accountEnv(max.id);
    expect(env[SECURESTORAGE_ENV]).toBe(AccountManager.accountConfigDir(max.id));
  });

  test('each account gets a distinct directory, and so a distinct keychain entry', async () => {
    const max = await capture('Max 20x', 'tok-max');
    const team = await capture('Team', 'tok-team', 'team');

    const dirMax = AccountManager.accountConfigDir(max.id);
    const dirTeam = AccountManager.accountConfigDir(team.id);
    expect(dirMax).not.toBe(dirTeam);
    // This is what stops a refresh in one account clobbering the other.
    expect(keychainServiceForDir(dirMax)).not.toBe(keychainServiceForDir(dirTeam));
    expect(keychainServiceForDir(dirMax)).not.toBe('Claude Code-credentials');
  });

  test('the keychain service matches the CLI derivation', async () => {
    const dir = AccountManager.accountConfigDir('abc123');
    const expected = crypto.createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8);
    expect(keychainServiceForDir(dir)).toBe(`Claude Code-credentials-${expected}`);
  });

  test('no binding means no overlay, so unbound work keeps the machine login', async () => {
    await capture('Max 20x', 'tok-max');
    // Deliberately no fallback to the default: it is what keeps
    // `claude /login`, and therefore capturing an account, working.
    expect(await AccountManager.accountEnv(null)).toBeNull();
  });

  test('an unknown account yields no overlay rather than a broken spawn', async () => {
    expect(await AccountManager.accountEnv('nope')).toBeNull();
  });

  test('the seed is dropped once the CLI has written the keychain entry', async () => {
    const max = await capture('Max 20x', 'tok-max');
    const dir = AccountManager.accountConfigDir(max.id);
    expect(fs.existsSync(seedPath(max.id))).toBe(true);

    // The CLI refreshes and writes to its namespaced entry.
    mockKeychain.set(namespacedKey(dir), JSON.stringify(creds('tok-max-v2')));
    await AccountManager.ensureAccountStore(max.id);

    expect(fs.existsSync(seedPath(max.id))).toBe(false);
  });

  test('a refresh in a bound account leaves the machine-wide store alone', async () => {
    const max = await capture('Max 20x', 'tok-max');
    const team = await capture('Team', 'tok-team', 'team');
    await AccountManager.setDefault(max.id);

    mockKeychain.set(namespacedKey(AccountManager.accountConfigDir(team.id)), JSON.stringify(creds('tok-team-v2', 'team')));
    await AccountManager.ensureAccountStore(team.id);

    expect(JSON.parse(mockKeychain.get(MACHINE_KEY)).claudeAiOauth.subscriptionType).toBe('max');
  });

  test('removing an account takes its store with it', async () => {
    const max = await capture('Max 20x', 'tok-max');
    await capture('Team', 'tok-team', 'team');
    const dir = AccountManager.accountConfigDir(max.id);
    mockKeychain.set(namespacedKey(dir), JSON.stringify(creds('tok-max')));

    await AccountManager.removeAccount(max.id);

    expect(fs.existsSync(dir)).toBe(false);
    expect(mockKeychain.has(namespacedKey(dir))).toBe(false);
  });

  test('removing the default hands the role to a surviving account', async () => {
    const max = await capture('Max 20x', 'tok-max');
    const team = await capture('Team', 'tok-team', 'team');
    await AccountManager.setDefault(max.id);

    await AccountManager.removeAccount(max.id);

    expect((await AccountManager.listAccounts()).defaultId).toBe(team.id);
  });
});

describe('file store platforms', () => {
  beforeEach(() => setPlatform('linux'));

  test('the seed alone provisions the directory when there is no keychain', async () => {
    const credPath = path.join(paths._root, 'claude-config', '.credentials.json');
    fs.mkdirSync(path.dirname(credPath), { recursive: true });
    fs.writeFileSync(credPath, JSON.stringify(creds('tok-max')));

    const max = await AccountManager.captureCurrent('Max 20x');
    const env = await AccountManager.accountEnv(max.id);

    expect(env[SECURESTORAGE_ENV]).toBe(AccountManager.accountConfigDir(max.id));
    // No keychain to take over, so the seed has to stay.
    expect(fs.existsSync(seedPath(max.id))).toBe(true);
  });
});
