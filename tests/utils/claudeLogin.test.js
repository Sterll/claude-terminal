/**
 * @jest-environment node
 */

/**
 * claudeLogin: driving `claude auth login` over pipes.
 *
 * The CLI is replaced by tests/helpers/fake-claude-login.js, which prints the
 * same lines and reads codes from stdin the same way, so the parsing and the
 * process handling run for real.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runLogin, loginEnv, findLoginUrl, stripTerminalCodes } = require('../../src/main/utils/claudeLogin');

const FAKE_CLI = path.join(__dirname, '..', 'helpers', 'fake-claude-login.js');
const LOGIN_URL = 'https://claude.ai/oauth/authorize?code=true&client_id=test&state=abc123';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-login-'));
  fs.mkdirSync(path.join(root, 'store'));
  fs.mkdirSync(path.join(root, 'config'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function start(overrides = {}, callbacks = {}) {
  const env = {
    ...loginEnv(process.env, { storeDir: path.join(root, 'store'), configDir: path.join(root, 'config') }),
    ...overrides,
  };
  return runLogin({ command: process.execPath, commandArgs: [FAKE_CLI], env, ...callbacks });
}

const urlSeen = () => {
  let resolveUrl;
  const seen = new Promise((resolve) => { resolveUrl = resolve; });
  return { seen, onUrl: resolveUrl };
};

describe('findLoginUrl', () => {
  test('unwraps the OSC 8 hyperlink the CLI prints', () => {
    const printed = `Opening browser to sign in…\nIf the browser didn't open, visit: \x1b]8;;${LOGIN_URL}\x07${LOGIN_URL}\x1b]8;;\x07\nPaste code here if prompted > `;
    expect(findLoginUrl(printed)).toBe(LOGIN_URL);
  });

  test('waits for the end of the line rather than open half a URL', () => {
    expect(findLoginUrl(`visit: ${LOGIN_URL.slice(0, 30)}`)).toBeNull();
    expect(findLoginUrl(`visit: ${LOGIN_URL}\r\n`)).toBe(LOGIN_URL);
  });

  test('strips colours as well as hyperlinks', () => {
    expect(stripTerminalCodes('\x1b[31mLogin failed\x1b[0m')).toBe('Login failed');
  });
});

describe('loginEnv', () => {
  test('points the store and the config at the given directories', () => {
    const env = loginEnv({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/home/me/.claude' }, { storeDir: '/s', configDir: '/c' });
    expect(env).toMatchObject({ PATH: '/bin', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/s', CLAUDE_CONFIG_DIR: '/c' });
  });

  test('drops what would send the new token elsewhere or bypass the login', () => {
    const base = {
      ANTHROPIC_BASE_URL: 'https://proxy.example',
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_AUTH_TOKEN: 't',
      CLAUDE_CODE_OAUTH_TOKEN: 'o',
    };
    const env = loginEnv(base, { storeDir: '/s', configDir: '/c' });
    for (const key of Object.keys(base)) expect(env).not.toHaveProperty(key);
    expect(base.ANTHROPIC_BASE_URL).toBe('https://proxy.example');
  });
});

describe('runLogin', () => {
  test('hands over the URL, then succeeds on a pasted code', async () => {
    const { seen, onUrl } = urlSeen();
    const login = start({}, { onUrl });
    expect(await seen).toBe(LOGIN_URL);
    expect(login.submitCode('  abc#state  ')).toBe(true);
    await expect(login.result).resolves.toBeUndefined();
    const stored = JSON.parse(fs.readFileSync(path.join(root, 'store', '.credentials.json'), 'utf8'));
    expect(stored.claudeAiOauth.accessToken).toBe('fresh-token');
  });

  test('succeeds without a code when the browser redirect reaches the CLI', async () => {
    await expect(start({ FAKE_LOGIN_MODE: 'callback' }).result).resolves.toBeUndefined();
  });

  test('reports a refused code and keeps waiting for another', async () => {
    const { seen, onUrl } = urlSeen();
    let refused;
    const refusal = new Promise((resolve) => { refused = resolve; });
    const login = start({}, { onUrl, onInvalidCode: refused });
    await seen;
    login.submitCode('no-state-part');
    await refusal;
    login.submitCode('good#state');
    await expect(login.result).resolves.toBeUndefined();
  });

  test('fails with what the CLI said', async () => {
    const { seen, onUrl } = urlSeen();
    const login = start({}, { onUrl });
    await seen;
    login.submitCode('bad#state');
    await expect(login.result).rejects.toMatchObject({
      code: 'LOGIN_FAILED',
      message: 'Login failed: Token exchange failed',
    });
    expect(login.submitCode('late#state')).toBe(false);
  });

  test('cancel stops the CLI', async () => {
    const { seen, onUrl } = urlSeen();
    const login = start({ FAKE_LOGIN_MODE: 'hang' }, { onUrl });
    await seen;
    login.cancel();
    await expect(login.result).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' });
  });

  test('gives up after the timeout', async () => {
    const login = runLogin({
      command: process.execPath,
      commandArgs: [FAKE_CLI],
      env: { ...loginEnv(process.env, { storeDir: path.join(root, 'store'), configDir: path.join(root, 'config') }), FAKE_LOGIN_MODE: 'hang' },
      timeoutMs: 300,
    });
    await expect(login.result).rejects.toMatchObject({ code: 'LOGIN_TIMEOUT' });
  });

  test('reports a binary that cannot be started', async () => {
    const login = runLogin({ command: path.join(root, 'no-such-claude'), env: process.env });
    await expect(login.result).rejects.toMatchObject({ code: 'LOGIN_SPAWN_FAILED' });
  });

  test('runs the CLI under the environment it was given', async () => {
    const envFile = path.join(root, 'env.json');
    await start({ FAKE_LOGIN_MODE: 'callback', FAKE_LOGIN_ENV_FILE: envFile }).result;
    const seenEnv = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    expect(seenEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(path.join(root, 'store'));
    expect(seenEnv.CLAUDE_CONFIG_DIR).toBe(path.join(root, 'config'));
  });
});
