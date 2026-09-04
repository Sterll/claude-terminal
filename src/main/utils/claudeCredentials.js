/**
 * Claude credential store
 *
 * The Claude CLI keeps its OAuth credentials in a platform-dependent place: the
 * macOS login Keychain on darwin, ~/.claude/.credentials.json everywhere else.
 * Same JSON payload, different container.
 *
 * Everything that needs the live login reads it through here, so a second reader
 * cannot quietly go looking in the wrong store — which is exactly how the usage
 * panel went blank on macOS, where the file it read has never existed.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

let keytar = null;
try {
  keytar = require('keytar');
} catch (_) {
  // Native module unavailable (electron-rebuild failed) — file store only.
}

function getCredentialsPath() {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(claudeDir, '.credentials.json');
}

function useKeychain() {
  return process.platform === 'darwin' && keytar !== null;
}

function keychainAccount() {
  return os.userInfo().username;
}

function readCredentialsFile() {
  const credPath = getCredentialsPath();
  if (!fs.existsSync(credPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(credPath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeCredentialsFile(payload) {
  const credPath = getCredentialsPath();
  const claudeDir = path.dirname(credPath);
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
  const tmp = `${credPath}.tmp`;
  fs.writeFileSync(tmp, payload, { mode: 0o600 });
  fs.renameSync(tmp, credPath);
}

/**
 * Read whatever credentials the Claude CLI is currently using.
 * Keychain first on macOS, with the file as a fallback for setups that opted
 * out of it (e.g. CLAUDE_CONFIG_DIR pointing at a portable config).
 * @returns {Promise<Object|null>}
 */
async function readCredentials() {
  if (useKeychain()) {
    try {
      const raw = await keytar.getPassword(KEYCHAIN_SERVICE, keychainAccount());
      if (raw) return JSON.parse(raw);
    } catch (_) {
      // Keychain access denied or entry unreadable — fall through to the file.
    }
  }
  return readCredentialsFile();
}

/**
 * Write credentials to every store the CLI might read on this platform, so a
 * swap takes effect whichever one it picks.
 * @param {string} payload - Serialized credentials JSON
 */
async function writeCredentials(payload) {
  let wrote = false;
  if (useKeychain()) {
    await keytar.setPassword(KEYCHAIN_SERVICE, keychainAccount(), payload);
    wrote = true;
  }
  // Only touch the file if it already exists (or if it is the only store) —
  // creating it on macOS would leave a plaintext copy the CLI never asked for.
  if (!wrote || fs.existsSync(getCredentialsPath())) {
    writeCredentialsFile(payload);
  }
}

/**
 * The Claude OAuth access token from the live store, or null when it is absent
 * or expired.
 * @returns {Promise<string|null>}
 */
async function readAccessToken() {
  const creds = await readCredentials();
  const oauth = creds?.claudeAiOauth;
  if (!oauth?.accessToken) return null;
  if (oauth.expiresAt && Date.now() > oauth.expiresAt) return null;
  return oauth.accessToken;
}

module.exports = {
  KEYCHAIN_SERVICE,
  getCredentialsPath,
  useKeychain,
  readCredentials,
  writeCredentials,
  readAccessToken,
};
