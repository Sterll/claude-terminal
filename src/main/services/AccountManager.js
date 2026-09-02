/**
 * AccountManager
 * Manages multiple Claude OAuth accounts by snapshotting the CLI's live
 * credential store into ~/.claude-terminal/accounts/ and swapping the active
 * credentials on demand.
 *
 * The live store is platform-dependent: the macOS login Keychain on darwin,
 * ~/.claude/.credentials.json everywhere else.
 *
 * Login flow stays unchanged: user runs `claude /login` once in a terminal,
 * then captures the resulting credentials as a named account.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { dataDir } = require('../utils/paths');

// On macOS the Claude CLI keeps its OAuth credentials in the login Keychain
// rather than in ~/.claude/.credentials.json. Same JSON payload, different
// container — so the store is picked per platform.
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

let keytar = null;
try {
  keytar = require('keytar');
} catch (_) {
  // Native module unavailable (electron-rebuild failed) — file store only.
}

const accountsDir = path.join(dataDir, 'accounts');
const indexFile = path.join(accountsDir, 'index.json');

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

function ensureDir() {
  // 0700: these files hold OAuth tokens in plaintext.
  if (!fs.existsSync(accountsDir)) fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
}

function readIndex() {
  ensureDir();
  if (!fs.existsSync(indexFile)) return { accounts: [], activeId: null };
  try {
    return JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
  } catch {
    return { accounts: [], activeId: null };
  }
}

function writeIndex(index) {
  ensureDir();
  const tmp = `${indexFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  fs.renameSync(tmp, indexFile);
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
 */
async function readCurrentCredentials() {
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
 * Reduce live credentials to the part that identifies a Claude account.
 *
 * The store holds more than the Claude login: `mcpOAuth` carries the OAuth
 * tokens of every connected MCP server. Those belong to the machine, not to
 * the account, so a snapshot has no business keeping a plaintext copy of them.
 *
 * Credentials in an unrecognised shape are stored whole — better a superset
 * than a snapshot that cannot restore the login.
 */
function accountCredentials(creds) {
  return creds?.claudeAiOauth ? { claudeAiOauth: creds.claudeAiOauth } : creds;
}

/**
 * Overlay a snapshot's Claude login onto the live store, keeping every other
 * key the CLI put there. Swapping the store wholesale would roll `mcpOAuth`
 * back to whenever the account was captured, silently signing the user out of
 * their MCP servers.
 */
async function mergeWithLiveStore(creds) {
  if (!creds?.claudeAiOauth) return creds;
  const live = await readCurrentCredentials();
  if (!live || typeof live !== 'object') return creds;
  return { ...live, claudeAiOauth: creds.claudeAiOauth };
}

/**
 * Write credentials back to every store the CLI might read on this platform,
 * so the swap takes effect whichever one it picks.
 */
async function writeCurrentCredentials(creds) {
  const payload = JSON.stringify(await mergeWithLiveStore(creds), null, 2);
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

function fingerprintCredentials(creds) {
  if (!creds) return null;
  const token = creds?.claudeAiOauth?.accessToken || creds?.accessToken;
  if (!token) return null;
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function accountFile(id) {
  return path.join(accountsDir, `${id}.json`);
}

function readSnapshot(id) {
  const file = accountFile(id);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Decide whether live credentials are the same account as a stored snapshot
 * whose access token no longer matches — i.e. the CLI refreshed it in place.
 *
 * The access token is what the fingerprint hashes, so it is useless here. The
 * refresh token survives an access-token refresh, and `refreshTokenExpiresAt`
 * is anchored to the original login, so it survives a refresh-token rotation
 * too. Both are per-login values: a different account never matches.
 *
 * Returning false is always safe — the caller then leaves the snapshot alone.
 */
function isRotationOf(live, snapshot) {
  const a = live?.claudeAiOauth || live;
  const b = snapshot?.claudeAiOauth || snapshot;
  if (!a || !b) return false;
  if (a.refreshToken && a.refreshToken === b.refreshToken) return true;
  if (a.refreshTokenExpiresAt && a.refreshTokenExpiresAt === b.refreshTokenExpiresAt) return true;
  return false;
}

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

function summarize(account) {
  return {
    id: account.id,
    name: account.name,
    fingerprint: account.fingerprint,
    createdAt: account.createdAt,
    lastUsedAt: account.lastUsedAt || null
  };
}

/**
 * List all stored accounts with the currently active one flagged.
 */
async function listAccounts() {
  const index = readIndex();
  const currentFp = fingerprintCredentials(await readCurrentCredentials());
  let activeId = index.activeId;
  if (currentFp) {
    const match = index.accounts.find(a => a.fingerprint === currentFp);
    if (match) activeId = match.id;
  } else {
    activeId = null;
  }
  return {
    accounts: index.accounts.map(summarize),
    activeId,
    hasCredentials: currentFp !== null
  };
}

/**
 * Capture the current ~/.claude/.credentials.json as a new named account.
 * Throws if no credentials exist or if an account with the same token is already stored.
 */
async function captureCurrent(name) {
  const creds = await readCurrentCredentials();
  if (!creds) throw new Error('No credentials found. Run /login in a terminal first.');
  const fingerprint = fingerprintCredentials(creds);
  if (!fingerprint) throw new Error('Credentials file has no usable access token.');

  const index = readIndex();
  const existing = index.accounts.find(a => a.fingerprint === fingerprint);
  if (existing) {
    throw new Error(`This account is already saved as "${existing.name}".`);
  }

  const id = generateId();
  const account = {
    id,
    name: name?.trim() || `Account ${index.accounts.length + 1}`,
    fingerprint,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString()
  };

  fs.writeFileSync(accountFile(id), JSON.stringify(accountCredentials(creds), null, 2), { mode: 0o600 });
  index.accounts.push(account);
  index.activeId = id;
  writeIndex(index);
  return summarize(account);
}

/**
 * Point the live credential store (Keychain on macOS, file elsewhere) at the
 * stored snapshot for this account. Returns the swapped account summary.
 */
async function switchTo(id) {
  const name = readIndex().accounts.find(a => a.id === id)?.name;
  if (!name) throw new Error(`Account ${id} not found.`);

  const file = accountFile(id);
  if (!fs.existsSync(file)) {
    throw new Error(`Stored credentials missing for "${name}". Re-capture required.`);
  }

  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    throw new Error(`Stored credentials for "${name}" are corrupted. Re-capture required.`);
  }

  // Refresh the outgoing account's snapshot before overwriting the live store —
  // the CLI rotates tokens behind our back, and a stale snapshot means a
  // forced re-login the next time we switch back to it.
  await syncActiveFromDisk();
  await writeCurrentCredentials(snapshot);

  // Re-read: syncActiveFromDisk() writes the index too.
  const index = readIndex();
  const account = index.accounts.find(a => a.id === id);
  if (!account) throw new Error(`Account ${id} not found.`);
  account.lastUsedAt = new Date().toISOString();
  index.activeId = id;
  writeIndex(index);
  return summarize(account);
}

/**
 * Refresh the stored snapshot of the active account from the live credential
 * store, so backups stay usable after the CLI rotates its tokens.
 *
 * Matching prefers the fingerprint, which is exact when it hits. It stops
 * matching once the CLI refreshes the access token it hashes, so `activeId`
 * — the account we last swapped in — is the fallback.
 *
 * That fallback is only taken when the live credentials are provably a
 * rotation of the active account's snapshot. Without the check, a manual
 * `claude /login` onto a never-captured account would be attributed to the
 * previously active one, overwriting a good snapshot — and its fingerprint —
 * with a stranger's tokens. Bailing out instead just skips the refresh.
 */
async function syncActiveFromDisk() {
  const creds = await readCurrentCredentials();
  if (!creds) return null;
  const fp = fingerprintCredentials(creds);
  if (!fp) return null;

  const index = readIndex();
  let match = index.accounts.find(a => a.fingerprint === fp);
  if (!match) {
    const active = index.accounts.find(a => a.id === index.activeId);
    if (active && isRotationOf(creds, readSnapshot(active.id))) match = active;
  }
  if (!match) return null;

  fs.writeFileSync(accountFile(match.id), JSON.stringify(accountCredentials(creds), null, 2), { mode: 0o600 });
  match.fingerprint = fp;
  match.lastUsedAt = new Date().toISOString();
  index.activeId = match.id;
  writeIndex(index);
  return summarize(match);
}

function renameAccount(id, name) {
  const index = readIndex();
  const account = index.accounts.find(a => a.id === id);
  if (!account) throw new Error(`Account ${id} not found.`);
  account.name = name.trim() || account.name;
  writeIndex(index);
  return summarize(account);
}

function removeAccount(id) {
  const index = readIndex();
  const idx = index.accounts.findIndex(a => a.id === id);
  if (idx === -1) throw new Error(`Account ${id} not found.`);
  const file = accountFile(id);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  index.accounts.splice(idx, 1);
  if (index.activeId === id) index.activeId = null;
  writeIndex(index);
  return { removed: id };
}

module.exports = {
  listAccounts,
  captureCurrent,
  switchTo,
  syncActiveFromDisk,
  renameAccount,
  removeAccount
};
