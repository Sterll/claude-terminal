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
const crypto = require('crypto');

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
  return tokenFromCredentials(await readCredentials());
}

/**
 * The usable access token in a credentials payload, or null when it is absent
 * or expired. Kept here so every store — machine-wide or per-account — applies
 * the same expiry rule.
 * @param {Object|null} creds
 * @returns {string|null}
 */
function tokenFromCredentials(creds) {
  const oauth = creds?.claudeAiOauth;
  if (!oauth?.accessToken) return null;
  if (oauth.expiresAt && Date.now() > oauth.expiresAt) return null;
  return oauth.accessToken;
}

// ── Per-account credential stores ───────────────────────────────────────────
//
// A project can be pinned to a specific account, so a spawned CLI must not read
// the machine-wide login. `CLAUDE_SECURESTORAGE_CONFIG_DIR` scopes *only* the
// credential store: `projects/`, `sessions/`, `.claude.json`, `skills/` and the
// rest stay shared in ~/.claude, which is what keeps session history and MCP
// config usable whichever account a project runs on.
//
// The CLI derives its Keychain service name from that directory —
// `Claude Code-credentials-${sha256(NFC(dir)).slice(0, 8)}` — so each account
// lands in its own Keychain entry and a token refresh can never clobber another
// account. The seed file below only bootstraps a directory the CLI has never
// used; from the first refresh onwards the Keychain entry is the record.

const SECURESTORAGE_ENV = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';

/**
 * Mirror of the CLI's Keychain service derivation for a credential directory.
 * @param {string} dir
 * @returns {string}
 */
function keychainServiceForDir(dir) {
  const hash = crypto.createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${hash}`;
}

function seedPathForDir(dir) {
  return path.join(dir, '.credentials.json');
}

/**
 * Read the credentials a spawned CLI would use for this directory: the
 * namespaced Keychain entry first, then the bootstrap seed.
 * @param {string} dir
 * @returns {Promise<Object|null>}
 */
async function readCredentialsForDir(dir) {
  if (useKeychain()) {
    try {
      const raw = await keytar.getPassword(keychainServiceForDir(dir), keychainAccount());
      if (raw) return JSON.parse(raw);
    } catch (_) {
      // Denied or unreadable — the seed below may still bootstrap the account.
    }
  }
  try {
    return JSON.parse(fs.readFileSync(seedPathForDir(dir), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Bootstrap a credential directory so the next spawn can authenticate.
 * @param {string} dir
 * @param {Object} creds
 */
function writeSeedForDir(dir, creds) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const seed = seedPathForDir(dir);
  const tmp = `${seed}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, seed);
}

/**
 * Drop the plaintext seed once the Keychain entry has taken over, so a stale
 * copy of the tokens does not linger on disk.
 * @param {string} dir
 * @returns {Promise<boolean>} true when the seed was removed
 */
async function pruneSeedForDir(dir) {
  if (!useKeychain()) return false;
  const seed = seedPathForDir(dir);
  if (!fs.existsSync(seed)) return false;
  try {
    const raw = await keytar.getPassword(keychainServiceForDir(dir), keychainAccount());
    if (!raw) return false;
  } catch (_) {
    return false;
  }
  fs.unlinkSync(seed);
  return true;
}

/**
 * Forget a credential directory entirely — Keychain entry and seed.
 * @param {string} dir
 */
async function deleteCredentialsForDir(dir) {
  if (useKeychain()) {
    try {
      await keytar.deletePassword(keychainServiceForDir(dir), keychainAccount());
    } catch (_) {
      // Nothing stored, or the Keychain refused — the directory still goes.
    }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // Best effort.
  }
}

module.exports = {
  KEYCHAIN_SERVICE,
  SECURESTORAGE_ENV,
  getCredentialsPath,
  useKeychain,
  readCredentials,
  writeCredentials,
  readAccessToken,
  tokenFromCredentials,
  keychainServiceForDir,
  readCredentialsForDir,
  writeSeedForDir,
  pruneSeedForDir,
  deleteCredentialsForDir,
};
