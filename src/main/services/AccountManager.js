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
const crypto = require('crypto');
const { dataDir } = require('../utils/paths');
// The live store is platform-dependent (Keychain on darwin, file elsewhere);
// claudeCredentials owns that choice so every reader agrees on it.
const {
  readCredentials,
  writeCredentials,
  readCredentialsForDir,
  writeSeedForDir,
  pruneSeedForDir,
  deleteCredentialsForDir,
} = require('../utils/claudeCredentials');

const accountsDir = path.join(dataDir, 'accounts');
const indexFile = path.join(accountsDir, 'index.json');
const storesDir = path.join(accountsDir, 'config');

/**
 * The credential directory handed to a CLI spawned for this account, via
 * CLAUDE_SECURESTORAGE_CONFIG_DIR. Its path is what namespaces the account's
 * Keychain entry, so it must stay stable for the life of the account.
 */
function accountConfigDir(id) {
  return path.join(storesDir, id);
}

function ensureDir() {
  // 0700: these files hold OAuth tokens in plaintext.
  if (!fs.existsSync(accountsDir)) fs.mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
}

function emptyIndex() {
  return { accounts: [], defaultId: null, liveId: null };
}

/**
 * Read the index, migrating the pre-binding shape on the way.
 *
 * `activeId` used to mean "the account currently swapped into the machine-wide
 * store". Accounts are now picked per project, so the surviving notion is
 * `defaultId`: the account used by projects with no binding of their own.
 */
function readIndex() {
  ensureDir();
  if (!fs.existsSync(indexFile)) return emptyIndex();
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
  } catch {
    return emptyIndex();
  }
  // The old activeId carried both meanings at once: the fallback for new work
  // and the owner of the machine-wide store. They split here.
  if (index.defaultId === undefined) index.defaultId = index.activeId ?? null;
  if (index.liveId === undefined) index.liveId = index.activeId ?? null;
  delete index.activeId;
  if (!Array.isArray(index.accounts)) index.accounts = [];
  return index;
}

function writeIndex(index) {
  ensureDir();
  const tmp = `${indexFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  fs.renameSync(tmp, indexFile);
}

/**
 * Read whatever credentials the Claude CLI is currently using.
 */
async function readCurrentCredentials() {
  return readCredentials();
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
  await writeCredentials(JSON.stringify(await mergeWithLiveStore(creds), null, 2));
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
    color: account.color || null,
    fingerprint: account.fingerprint,
    createdAt: account.createdAt,
    lastUsedAt: account.lastUsedAt || null
  };
}

/**
 * List the stored accounts.
 *
 * `defaultId` is a stored pointer — the account projects fall back to — and no
 * longer describes what sits in the machine-wide store. `liveId` still reports
 * which account the machine-wide login belongs to, since that is the one
 * `claude /login` last wrote and the one a capture would pick up.
 */
async function listAccounts() {
  const index = readIndex();
  const currentFp = fingerprintCredentials(await readCurrentCredentials());
  const live = currentFp ? index.accounts.find(a => a.fingerprint === currentFp) : null;
  return {
    accounts: index.accounts.map(summarize),
    defaultId: index.defaultId,
    // Fall back to the stored pointer: a refresh moves the access token the
    // fingerprint hashes, and that alone should not orphan the live account.
    liveId: live?.id ?? index.liveId ?? null,
    hasCredentials: currentFp !== null
  };
}

/**
 * Point unbound projects at this account. Unlike the old switchTo(), nothing
 * is written to any credential store — spawns resolve their account at launch.
 */
function setDefault(id) {
  const index = readIndex();
  if (id !== null && !index.accounts.some(a => a.id === id)) {
    throw new Error(`Account ${id} not found.`);
  }
  index.defaultId = id;
  writeIndex(index);
  return { defaultId: id };
}

/**
 * Make sure a spawn for this account will find credentials, seeding the
 * directory from the stored snapshot the first time. Returns the directory, or
 * null when the account cannot be resolved — the caller then falls back to the
 * machine-wide login rather than spawning with no credentials at all.
 * @param {string} id
 * @returns {Promise<string|null>}
 */
async function ensureAccountStore(id) {
  const index = readIndex();
  if (!index.accounts.some(a => a.id === id)) return null;
  const dir = accountConfigDir(id);

  if (await readCredentialsForDir(dir)) {
    // Already provisioned; drop the seed if the Keychain has taken over.
    await pruneSeedForDir(dir);
    return dir;
  }

  const snapshot = readSnapshot(id);
  if (!snapshot) return null;
  writeSeedForDir(dir, snapshot);
  return dir;
}

/**
 * Resolve the credential directory for a project, honouring its binding and
 * falling back to the default account.
 * @param {string|null} accountId - The project's binding, if any
 * @returns {Promise<string|null>}
 */
async function resolveStoreDir(accountId) {
  const id = accountId || readIndex().defaultId;
  if (!id) return null;
  return ensureAccountStore(id);
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
    color: null,
    fingerprint,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString()
  };

  const stored = accountCredentials(creds);
  fs.writeFileSync(accountFile(id), JSON.stringify(stored, null, 2), { mode: 0o600 });
  index.accounts.push(account);
  // The first account captured becomes the fallback for unbound projects;
  // later ones do not steal that role behind the user's back.
  if (!index.defaultId) index.defaultId = id;
  index.liveId = id;
  writeIndex(index);

  writeSeedForDir(accountConfigDir(id), stored);
  return summarize(account);
}

/**
 * Point the machine-wide credential store at this account's snapshot.
 *
 * Off the normal path now that spawns resolve their own account: kept for the
 * `claude` CLI run outside the app, which reads only the machine-wide store.
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
  index.liveId = id;
  writeIndex(index);
  return summarize(account);
}

/**
 * Refresh the stored snapshot of whichever account owns the machine-wide
 * store, so backups stay usable after the CLI rotates its tokens.
 *
 * Matching prefers the fingerprint, which is exact when it hits. It stops
 * matching once the CLI refreshes the access token it hashes, so `liveId`
 * — the account last written to that store — is the fallback.
 *
 * That fallback is only taken when the live credentials are provably a
 * rotation of that account's snapshot. Without the check, a manual
 * `claude /login` onto a never-captured account would be attributed to the
 * previous one, overwriting a good snapshot — and its fingerprint — with a
 * stranger's tokens. Bailing out instead just skips the refresh.
 *
 * Bound accounts do not go through here: the CLI refreshes them inside their
 * own store, which stays authoritative on its own.
 */
async function syncActiveFromDisk() {
  const creds = await readCurrentCredentials();
  if (!creds) return null;
  const fp = fingerprintCredentials(creds);
  if (!fp) return null;

  const index = readIndex();
  let match = index.accounts.find(a => a.fingerprint === fp);
  if (!match) {
    const live = index.accounts.find(a => a.id === index.liveId);
    if (live && isRotationOf(creds, readSnapshot(live.id))) match = live;
  }
  if (!match) return null;

  fs.writeFileSync(accountFile(match.id), JSON.stringify(accountCredentials(creds), null, 2), { mode: 0o600 });
  match.fingerprint = fp;
  match.lastUsedAt = new Date().toISOString();
  index.liveId = match.id;
  writeIndex(index);
  return summarize(match);
}

/**
 * Update the mutable, user-facing fields of an account. Only the keys present
 * are touched, so a colour change cannot blank a name.
 * @param {string} id
 * @param {{name?: string, color?: string|null}} patch
 */
function updateAccount(id, patch = {}) {
  const index = readIndex();
  const account = index.accounts.find(a => a.id === id);
  if (!account) throw new Error(`Account ${id} not found.`);
  if (patch.name !== undefined) account.name = patch.name.trim() || account.name;
  if (patch.color !== undefined) account.color = patch.color || null;
  writeIndex(index);
  return summarize(account);
}

function renameAccount(id, name) {
  return updateAccount(id, { name });
}

/**
 * Forget an account: snapshot, index entry and its credential store.
 *
 * Callers are expected to have cleared any project bindings first — the
 * renderer blocks the deletion while projects still point here rather than
 * silently moving them to another account.
 */
async function removeAccount(id) {
  const index = readIndex();
  const idx = index.accounts.findIndex(a => a.id === id);
  if (idx === -1) throw new Error(`Account ${id} not found.`);
  const file = accountFile(id);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  index.accounts.splice(idx, 1);
  if (index.defaultId === id) index.defaultId = index.accounts[0]?.id ?? null;
  if (index.liveId === id) index.liveId = null;
  writeIndex(index);
  await deleteCredentialsForDir(accountConfigDir(id));
  return { removed: id, defaultId: index.defaultId };
}

module.exports = {
  listAccounts,
  captureCurrent,
  switchTo,
  setDefault,
  syncActiveFromDisk,
  updateAccount,
  renameAccount,
  removeAccount,
  accountConfigDir,
  ensureAccountStore,
  resolveStoreDir
};
