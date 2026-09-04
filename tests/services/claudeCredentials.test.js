/**
 * claudeCredentials — the one place that knows where the Claude CLI keeps its
 * OAuth login.
 *
 * The regression these cover: on macOS the CLI stores credentials in the login
 * Keychain and never writes ~/.claude/.credentials.json, so a reader that only
 * looks at the file finds nothing and reports "not logged in" for an account
 * that is perfectly signed in.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockKeychain = new Map();
jest.mock('keytar', () => ({
  getPassword: jest.fn(async (service, account) => mockKeychain.get(`${service}:${account}`) ?? null),
  setPassword: jest.fn(async (service, account, secret) => { mockKeychain.set(`${service}:${account}`, secret); }),
  deletePassword: jest.fn(async (service, account) => mockKeychain.delete(`${service}:${account}`))
}));

const credentials = require('../../src/main/utils/claudeCredentials');

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-creds-'));
const KEY = `${credentials.KEYCHAIN_SERVICE}:${os.userInfo().username}`;

const realPlatform = process.platform;
const setPlatform = (value) => {
  Object.defineProperty(process, 'platform', { value, configurable: true });
};

const oauth = (accessToken, expiresAt = Date.now() + 3600_000) => ({
  claudeAiOauth: { accessToken, refreshToken: `refresh-${accessToken}`, expiresAt }
});

beforeAll(() => {
  process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
});

afterAll(() => {
  setPlatform(realPlatform);
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  mockKeychain.clear();
  fs.rmSync(credentials.getCredentialsPath(), { force: true });
});

describe('on macOS', () => {
  beforeEach(() => setPlatform('darwin'));

  test('reads the Keychain when no credentials file exists', async () => {
    mockKeychain.set(KEY, JSON.stringify(oauth('sk-ant-oat01-keychain')));

    expect(fs.existsSync(credentials.getCredentialsPath())).toBe(false);
    expect(await credentials.readAccessToken()).toBe('sk-ant-oat01-keychain');
  });

  test('prefers the Keychain over a stale credentials file', async () => {
    fs.writeFileSync(credentials.getCredentialsPath(), JSON.stringify(oauth('sk-ant-oat01-file')));
    mockKeychain.set(KEY, JSON.stringify(oauth('sk-ant-oat01-keychain')));

    expect(await credentials.readAccessToken()).toBe('sk-ant-oat01-keychain');
  });

  test('falls back to the file when the Keychain entry is absent', async () => {
    fs.writeFileSync(credentials.getCredentialsPath(), JSON.stringify(oauth('sk-ant-oat01-file')));

    expect(await credentials.readAccessToken()).toBe('sk-ant-oat01-file');
  });

  test('writes the Keychain, and leaves no plaintext file behind', async () => {
    await credentials.writeCredentials(JSON.stringify(oauth('sk-ant-oat01-written')));

    expect(JSON.parse(mockKeychain.get(KEY)).claudeAiOauth.accessToken).toBe('sk-ant-oat01-written');
    expect(fs.existsSync(credentials.getCredentialsPath())).toBe(false);
  });

  test('keeps an existing credentials file in sync with the Keychain', async () => {
    fs.writeFileSync(credentials.getCredentialsPath(), JSON.stringify(oauth('sk-ant-oat01-old')));

    await credentials.writeCredentials(JSON.stringify(oauth('sk-ant-oat01-new')));

    const onDisk = JSON.parse(fs.readFileSync(credentials.getCredentialsPath(), 'utf8'));
    expect(onDisk.claudeAiOauth.accessToken).toBe('sk-ant-oat01-new');
  });
});

describe('elsewhere', () => {
  beforeEach(() => setPlatform('linux'));

  test('reads the credentials file, ignoring any Keychain entry', async () => {
    mockKeychain.set(KEY, JSON.stringify(oauth('sk-ant-oat01-keychain')));
    fs.writeFileSync(credentials.getCredentialsPath(), JSON.stringify(oauth('sk-ant-oat01-file')));

    expect(await credentials.readAccessToken()).toBe('sk-ant-oat01-file');
  });

  test('returns null when nothing is stored', async () => {
    expect(await credentials.readAccessToken()).toBeNull();
  });
});

describe('token validity', () => {
  beforeEach(() => setPlatform('darwin'));

  test('an expired token is not handed out', async () => {
    mockKeychain.set(KEY, JSON.stringify(oauth('sk-ant-oat01-expired', Date.now() - 1000)));

    expect(await credentials.readAccessToken()).toBeNull();
  });

  test('credentials without an OAuth block yield no token', async () => {
    mockKeychain.set(KEY, JSON.stringify({ mcpOAuth: { some: 'server' } }));

    expect(await credentials.readAccessToken()).toBeNull();
  });

  test('an unparseable store does not throw', async () => {
    mockKeychain.set(KEY, 'not json');
    fs.writeFileSync(credentials.getCredentialsPath(), 'not json either');

    expect(await credentials.readAccessToken()).toBeNull();
  });
});
