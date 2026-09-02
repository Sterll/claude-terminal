/**
 * AccountManager — multi-account Claude OAuth switching.
 *
 * The store is platform-dependent: the macOS login Keychain on darwin,
 * ~/.claude/.credentials.json everywhere else. Both paths are covered here.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../src/main/utils/paths', () => {
  const fsMock = require('fs');
  const osMock = require('os');
  const pathMock = require('path');
  const root = fsMock.mkdtempSync(pathMock.join(osMock.tmpdir(), 'ct-accounts-'));
  return {
    dataDir: pathMock.join(root, 'data'),
    claudeDir: pathMock.join(root, 'claude'),
    _root: root
  };
});

// In-memory Keychain. keytar is a native module; the real one would hit the
// developer's actual login keychain.
const mockKeychain = new Map();
jest.mock('keytar', () => ({
  getPassword: jest.fn(async (service, account) => mockKeychain.get(`${service}:${account}`) ?? null),
  setPassword: jest.fn(async (service, account, secret) => { mockKeychain.set(`${service}:${account}`, secret); }),
  deletePassword: jest.fn(async (service, account) => mockKeychain.delete(`${service}:${account}`))
}));

const paths = require('../../src/main/utils/paths');
const AccountManager = require('../../src/main/services/AccountManager');

const MOCK_KEY = `Claude Code-credentials:${os.userInfo().username}`;

const realPlatform = process.platform;
const setPlatform = (value) => {
  Object.defineProperty(process, 'platform', { value, configurable: true });
};

// `login` identifies the /login session the tokens came from. Passing it
// explicitly models the CLI refreshing an account in place; omitting it yields
// a brand new, unrelated account. Mirrors the real payload: the access and
// refresh tokens both rotate, `refreshTokenExpiresAt` stays anchored to the
// original login.
const loginStamp = (login) => 1900000000000
  + [...login].reduce((sum, c) => sum + c.charCodeAt(0), 0);

const creds = (accessToken, subscriptionType = 'max', login = accessToken) => ({
  claudeAiOauth: {
    accessToken,
    refreshToken: `refresh-${accessToken}`,
    expiresAt: 1893456000000,
    refreshTokenExpiresAt: loginStamp(login),
    subscriptionType
  }
});

const credentialsFile = () => path.join(paths._root, 'claude-config', '.credentials.json');
const readCredentialsFile = () => JSON.parse(fs.readFileSync(credentialsFile(), 'utf8'));

beforeAll(() => {
  // Never let writeCredentialsFile() touch the real ~/.claude.
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

describe('macOS Keychain store', () => {
  test('sees credentials that only exist in the Keychain', async () => {
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-max')));

    const list = await AccountManager.listAccounts();

    // The regression: with no ~/.claude/.credentials.json this used to report
    // false, which greyed out the "Save current account" button on macOS.
    expect(list.hasCredentials).toBe(true);
    expect(fs.existsSync(credentialsFile())).toBe(false);
  });

  test('reports no credentials when the Keychain is empty and no file exists', async () => {
    const list = await AccountManager.listAccounts();
    expect(list.hasCredentials).toBe(false);
    expect(list.accounts).toEqual([]);
  });

  test('captures the Keychain entry as a named account', async () => {
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-max')));

    const account = await AccountManager.captureCurrent('Max 20x');

    expect(account.name).toBe('Max 20x');
    const list = await AccountManager.listAccounts();
    expect(list.accounts).toHaveLength(1);
    expect(list.activeId).toBe(account.id);
  });

  test('refuses to capture the same token twice', async () => {
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-max')));
    await AccountManager.captureCurrent('Max 20x');

    await expect(AccountManager.captureCurrent('Duplicate'))
      .rejects.toThrow(/already saved as "Max 20x"/);
  });

  test('switching writes the Keychain and leaves no plaintext file behind', async () => {
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-max')));
    const max = await AccountManager.captureCurrent('Max 20x');

    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-team', 'team')));
    await AccountManager.captureCurrent('Team');

    await AccountManager.switchTo(max.id);

    expect(JSON.parse(mockKeychain.get(MOCK_KEY)).claudeAiOauth.accessToken).toBe('tok-max');
    expect(fs.existsSync(credentialsFile())).toBe(false);
  });

  test('switching preserves a token the CLI rotated on the outgoing account', async () => {
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-max')));
    const max = await AccountManager.captureCurrent('Max 20x');

    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-team', 'team')));
    const team = await AccountManager.captureCurrent('Team');

    // The CLI refreshes Team's token behind our back.
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-team-v2', 'team', 'tok-team')));

    await AccountManager.switchTo(max.id);
    await AccountManager.switchTo(team.id);

    // Without the syncActiveFromDisk() call in switchTo(), this would restore
    // the stale tok-team snapshot and force a re-login.
    expect(JSON.parse(mockKeychain.get(MOCK_KEY)).claudeAiOauth.accessToken).toBe('tok-team-v2');
  });

  test('round-trips between two accounts', async () => {
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-max')));
    const max = await AccountManager.captureCurrent('Max 20x');
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-team', 'team')));
    const team = await AccountManager.captureCurrent('Team');

    await AccountManager.switchTo(max.id);
    expect((await AccountManager.listAccounts()).activeId).toBe(max.id);
    expect(JSON.parse(mockKeychain.get(MOCK_KEY)).claudeAiOauth.subscriptionType).toBe('max');

    await AccountManager.switchTo(team.id);
    expect((await AccountManager.listAccounts()).activeId).toBe(team.id);
    expect(JSON.parse(mockKeychain.get(MOCK_KEY)).claudeAiOauth.subscriptionType).toBe('team');
  });

  test('falls back to the file when the Keychain is empty', async () => {
    fs.mkdirSync(path.dirname(credentialsFile()), { recursive: true });
    fs.writeFileSync(credentialsFile(), JSON.stringify(creds('tok-from-file')));

    expect((await AccountManager.listAccounts()).hasCredentials).toBe(true);
  });

  test('keeps the file in sync when one already exists', async () => {
    fs.mkdirSync(path.dirname(credentialsFile()), { recursive: true });
    fs.writeFileSync(credentialsFile(), JSON.stringify(creds('tok-max')));
    const max = await AccountManager.captureCurrent('Max 20x');

    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-team', 'team')));
    await AccountManager.captureCurrent('Team');
    await AccountManager.switchTo(max.id);

    expect(readCredentialsFile().claudeAiOauth.accessToken).toBe('tok-max');
  });
});

describe('file store (Windows / Linux)', () => {
  beforeEach(() => setPlatform('linux'));

  test('captures and switches through the credentials file', async () => {
    fs.mkdirSync(path.dirname(credentialsFile()), { recursive: true });
    fs.writeFileSync(credentialsFile(), JSON.stringify(creds('tok-max')));
    const max = await AccountManager.captureCurrent('Max 20x');

    fs.writeFileSync(credentialsFile(), JSON.stringify(creds('tok-team', 'team')));
    await AccountManager.captureCurrent('Team');

    await AccountManager.switchTo(max.id);

    expect(readCredentialsFile().claudeAiOauth.accessToken).toBe('tok-max');
    // The Keychain must stay untouched off darwin.
    expect(mockKeychain.size).toBe(0);
  });

  test('creates the credentials file when the directory is missing', async () => {
    fs.mkdirSync(path.dirname(credentialsFile()), { recursive: true });
    fs.writeFileSync(credentialsFile(), JSON.stringify(creds('tok-max')));
    const max = await AccountManager.captureCurrent('Max 20x');

    fs.rmSync(path.join(paths._root, 'claude-config'), { recursive: true, force: true });
    await AccountManager.switchTo(max.id);

    expect(readCredentialsFile().claudeAiOauth.accessToken).toBe('tok-max');
  });
});

describe('syncActiveFromDisk', () => {
  test('matches on fingerprint even when activeId points elsewhere', async () => {
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-max')));
    const max = await AccountManager.captureCurrent('Max 20x');
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-team', 'team')));
    const team = await AccountManager.captureCurrent('Team');

    // activeId is Team, but the live store holds Max's untouched token.
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-max')));
    const synced = await AccountManager.syncActiveFromDisk();

    expect(synced.id).toBe(max.id);
    expect(synced.id).not.toBe(team.id);
  });

  test('falls back to activeId once a refresh invalidates the fingerprint', async () => {
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-team', 'team')));
    const team = await AccountManager.captureCurrent('Team');

    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-team-v2', 'team', 'tok-team')));
    const synced = await AccountManager.syncActiveFromDisk();

    expect(synced.id).toBe(team.id);
    // The stored fingerprint tracks the new token, so the next call matches
    // exactly rather than relying on the fallback again.
    const list = await AccountManager.listAccounts();
    expect(list.activeId).toBe(team.id);
  });

  test('follows a rotation that keeps the same refresh token', async () => {
    const rotated = creds('tok-team-v2', 'team');
    rotated.claudeAiOauth.refreshToken = 'refresh-tok-team';

    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-team', 'team')));
    const team = await AccountManager.captureCurrent('Team');

    mockKeychain.set(MOCK_KEY, JSON.stringify(rotated));
    expect((await AccountManager.syncActiveFromDisk()).id).toBe(team.id);
  });

  test('ignores a live store belonging to a never-captured account', async () => {
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-team', 'team')));
    await AccountManager.captureCurrent('Team');

    // A manual `claude /login` onto an account this app has never seen. It is
    // nobody's, so attributing it to activeId would destroy Team's snapshot.
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-solo', 'pro')));

    expect(await AccountManager.syncActiveFromDisk()).toBeNull();
  });

  test('is a no-op when no credentials exist at all', async () => {
    expect(await AccountManager.syncActiveFromDisk()).toBeNull();
  });
});

describe('snapshot integrity across a switch', () => {
  const snapshotOf = (id) => JSON.parse(
    fs.readFileSync(path.join(paths.dataDir, 'accounts', `${id}.json`), 'utf8')
  );

  test('switching away after an uncaptured /login leaves the outgoing snapshot intact', async () => {
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-a')));
    const a = await AccountManager.captureCurrent('Account A');
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-b', 'team')));
    const b = await AccountManager.captureCurrent('Account B');
    await AccountManager.switchTo(a.id);

    // The user runs `claude /login` onto a third account, never captures it,
    // then switches to B. A is the outgoing account.
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-c', 'pro')));
    await AccountManager.switchTo(b.id);

    expect(JSON.parse(mockKeychain.get(MOCK_KEY)).claudeAiOauth.accessToken).toBe('tok-b');
    // A must still be A — both its snapshot and the fingerprint that identifies it.
    expect(snapshotOf(a.id).claudeAiOauth.accessToken).toBe('tok-a');
    const stored = (await AccountManager.listAccounts()).accounts.find(x => x.id === a.id);
    expect(stored.fingerprint).toBe(
      require('crypto').createHash('sha256').update('tok-a').digest('hex').slice(0, 16)
    );

    // And switching back really returns account A, not the stranger.
    await AccountManager.switchTo(a.id);
    expect(JSON.parse(mockKeychain.get(MOCK_KEY)).claudeAiOauth.accessToken).toBe('tok-a');
  });

  test('still refreshes the outgoing snapshot when the CLI rotated its token', async () => {
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-a')));
    const a = await AccountManager.captureCurrent('Account A');
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-b', 'team')));
    const b = await AccountManager.captureCurrent('Account B');
    await AccountManager.switchTo(a.id);

    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-a-v2', 'max', 'tok-a')));
    await AccountManager.switchTo(b.id);

    expect(snapshotOf(a.id).claudeAiOauth.accessToken).toBe('tok-a-v2');
  });
});

describe('errors', () => {
  test('capture without credentials tells the user to log in', async () => {
    await expect(AccountManager.captureCurrent('Nope'))
      .rejects.toThrow(/Run \/login in a terminal first/);
  });

  test('switching to an unknown account throws', async () => {
    await expect(AccountManager.switchTo('does-not-exist'))
      .rejects.toThrow(/not found/);
  });

  test('switching to an account whose snapshot was deleted throws by name', async () => {
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-max')));
    const max = await AccountManager.captureCurrent('Max 20x');
    fs.rmSync(path.join(paths.dataDir, 'accounts', `${max.id}.json`));

    await expect(AccountManager.switchTo(max.id))
      .rejects.toThrow(/Stored credentials missing for "Max 20x"/);
  });

  test('rename and remove work through the index', async () => {
    mockKeychain.set(MOCK_KEY, JSON.stringify(creds('tok-max')));
    const max = await AccountManager.captureCurrent('Max 20x');

    expect((await AccountManager.renameAccount(max.id, 'Perso')).name).toBe('Perso');
    await AccountManager.removeAccount(max.id);

    expect((await AccountManager.listAccounts()).accounts).toEqual([]);
    expect(fs.existsSync(path.join(paths.dataDir, 'accounts', `${max.id}.json`))).toBe(false);
  });
});
