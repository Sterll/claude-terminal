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
  SECURESTORAGE_ENV,
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
 * How far `refreshTokenExpiresAt` may move between two rotations of one login
 * and still be recognised as that login.
 *
 * The field is not the fixed anchor it looks like: the CLI recomputes it on
 * every refresh as `Date.now() + expires_in`, so each rotation lands a network
 * round-trip later than the last rather than byte-identical. Requiring exact
 * equality therefore never matched a real rotation — 874 ms apart in the case
 * that produced this constant — which silently froze every snapshot at capture
 * time. A separate `/login` re-anchors the whole 30-day window instead, putting
 * it hours or days away. A minute sits far outside the drift and far inside the
 * gap.
 */
const ROTATION_DRIFT_MS = 60 * 1000;

/**
 * Decide whether live credentials are the same account as a stored snapshot
 * whose access token no longer matches — i.e. the CLI refreshed it in place.
 *
 * The access token is what the fingerprint hashes, so it is useless here. The
 * refresh token survives an access-token refresh, and `refreshTokenExpiresAt`
 * tracks the original login closely enough to survive a refresh-token rotation
 * too. Both are per-login values: a different account never matches.
 *
 * Returning false is always safe — the caller then leaves the snapshot alone.
 */
function isRotationOf(live, snapshot) {
  const a = live?.claudeAiOauth || live;
  const b = snapshot?.claudeAiOauth || snapshot;
  if (!a || !b) return false;
  if (a.refreshToken && a.refreshToken === b.refreshToken) return true;
  if (a.refreshTokenExpiresAt && b.refreshTokenExpiresAt
      && Math.abs(a.refreshTokenExpiresAt - b.refreshTokenExpiresAt) <= ROTATION_DRIFT_MS) {
    return true;
  }
  return false;
}

/**
 * Which stored account the machine-wide store currently holds, or null when it
 * holds nobody this app has captured.
 *
 * The fingerprint is exact when it hits, but it hashes the access token, so it
 * stops matching the moment the CLI refreshes. `liveId` — the account last
 * written to that store — is the fallback, taken only when the live credentials
 * are provably a rotation of that account's snapshot. Without that check a
 * manual `claude /login` onto a never-captured account would be attributed to
 * the previous one.
 *
 * @param {Object} index
 * @param {Object|null} creds
 */
function matchLiveAccount(index, creds) {
  const fp = fingerprintCredentials(creds);
  if (!fp) return null;
  const exact = index.accounts.find(a => a.fingerprint === fp);
  if (exact) return exact;
  const live = index.accounts.find(a => a.id === index.liveId);
  if (live && isRotationOf(creds, readSnapshot(live.id))) return live;
  return null;
}

/**
 * Whether a credential payload can still authenticate, or at least renew.
 *
 * The CLI blanks its own store — `accessToken: ''`, `refreshToken: ''`,
 * `expiresAt: 0` — when a refresh is refused, which is what a signed-out
 * account looks like on disk. That payload parses as a perfectly good object,
 * so "did the read return something" is not the question worth asking of it.
 *
 * @param {Object|null} creds
 */
function isUsableStore(creds) {
  const oauth = creds?.claudeAiOauth || creds;
  if (!oauth || typeof oauth !== 'object') return false;
  if (oauth.refreshToken) return true;
  return Boolean(oauth.accessToken) && (!oauth.expiresAt || Date.now() < oauth.expiresAt);
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
 * Make this the account for everything that is not pinned to one of its own.
 *
 * Only bound projects get a private credential store; unbound work — and the
 * `claude` CLI run outside the app — reads the machine-wide one. So the
 * default is not merely a pointer: it is also what that store must hold.
 * Keeping it a pointer alone would let the UI claim a default that no unbound
 * session actually used.
 *
 * It also leaves `claude /login` working the way it always did, which is what
 * capturing a new account still depends on.
 */
async function setDefault(id) {
  const index = readIndex();
  if (id !== null && !index.accounts.some(a => a.id === id)) {
    throw new Error(`Account ${id} not found.`);
  }
  if (id) await switchTo(id);
  // Re-read: switchTo() writes the index.
  const next = readIndex();
  next.defaultId = id;
  writeIndex(next);
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

  const current = await readCredentialsForDir(dir);
  if (isUsableStore(current)) {
    // Already provisioned; drop the seed if the Keychain has taken over.
    await pruneSeedForDir(dir);
    // The CLI refreshes inside this store, so it — not the snapshot — is the
    // record of where the account's tokens are now. Copy it back, or the backup
    // rots exactly the way the machine-wide one did.
    snapshotFromStore(id, current);
    return dir;
  }

  // Either never provisioned, or the CLI emptied it after a refresh the server
  // refused. Both want the same thing, and the second used to be indistinguishable
  // from the first only because a blanked payload still reads as an object:
  // the dead store was handed back untouched, forever.
  const snapshot = readSnapshot(id);
  if (!isUsableStore(snapshot)) return null;
  writeSeedForDir(dir, snapshot);
  return dir;
}

/**
 * Refresh an account's snapshot from its own credential store.
 *
 * Only when the store still holds the account the snapshot describes: a
 * `claude /login` run inside that directory could have put a stranger there,
 * and overwriting a good snapshot with one is unrecoverable. Skipping the
 * refresh is not.
 *
 * @param {string} id
 * @param {Object} creds - what the store currently holds
 */
function snapshotFromStore(id, creds) {
  const snapshot = readSnapshot(id);
  if (!snapshot) return;
  const fp = fingerprintCredentials(creds);
  if (!fp) return;
  if (fp !== fingerprintCredentials(snapshot) && !isRotationOf(creds, snapshot)) return;

  const stored = accountCredentials(creds);
  if (JSON.stringify(stored) === JSON.stringify(snapshot)) return;
  fs.writeFileSync(accountFile(id), JSON.stringify(stored, null, 2), { mode: 0o600 });

  const index = readIndex();
  const account = index.accounts.find(a => a.id === id);
  if (!account) return;
  account.fingerprint = fp;
  writeIndex(index);
}

/**
 * Whether an account is the one the machine-wide store currently holds.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function ownsLiveStore(id) {
  const index = readIndex();
  if (!index.accounts.some(a => a.id === id)) return false;
  return matchLiveAccount(index, await readCurrentCredentials())?.id === id;
}

/**
 * The credentials an account authenticates with — its own store, or the
 * machine-wide one when it is the account that store holds.
 *
 * One account, two stores refreshing the same OAuth grant, is the shape that
 * breaks: rotation invalidates whichever refresh token the other one still
 * holds, and the loser is signed out. So the live account has exactly one
 * store, and it is the machine-wide one.
 *
 * @param {string|null} id
 * @returns {Promise<Object|null>}
 */
async function credentialsForAccount(id) {
  if (!id) return readCurrentCredentials();
  if (await ownsLiveStore(id)) return readCurrentCredentials();
  const dir = await ensureAccountStore(id);
  return dir ? readCredentialsForDir(dir) : null;
}

/**
 * The environment a spawn should inherit to authenticate as this project's
 * account, or null when it should use the machine-wide login.
 *
 * Deliberately no fallback to the default account: unbound work runs against
 * the machine-wide store, which is what keeps `claude /login` — and therefore
 * capturing a new account — behaving as it always has. setDefault() is what
 * makes the default real, by putting it in that store.
 *
 * Nor does the account that already owns the machine-wide store get a private
 * one: pointing a spawn at a second copy of the same OAuth grant is what signs
 * the account out. Both stores refresh on their own schedule, each rotation
 * invalidates the other's refresh token server-side, and the CLI blanks
 * whichever store loses the race. The default account is the usual victim,
 * because it is the one most likely to be live and bound at once.
 *
 * @param {string|null} accountId - The project's binding, if any
 * @returns {Promise<Object|null>} Env overlay, or null
 */
async function accountEnv(accountId) {
  if (!accountId) return null;
  if (await ownsLiveStore(accountId)) return null;
  const dir = await ensureAccountStore(accountId);
  if (!dir) return null;
  return { [SECURESTORAGE_ENV]: dir };
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
 * own store, which `ensureAccountStore()` copies back instead.
 */
async function syncActiveFromDisk() {
  const creds = await readCurrentCredentials();
  if (!creds) return null;
  const fp = fingerprintCredentials(creds);
  if (!fp) return null;

  const index = readIndex();
  const match = matchLiveAccount(index, creds);
  if (!match) return null;

  const stored = accountCredentials(creds);
  // This runs on a timer, and a refresh is an eight-hourly event: without the
  // early-out every tick would rewrite two files and move `lastUsedAt`, which
  // is supposed to mean "last used", not "last polled".
  if (match.fingerprint === fp
      && index.liveId === match.id
      && JSON.stringify(readSnapshot(match.id)) === JSON.stringify(stored)) {
    return summarize(match);
  }

  fs.writeFileSync(accountFile(match.id), JSON.stringify(stored, null, 2), { mode: 0o600 });
  match.fingerprint = fp;
  match.lastUsedAt = new Date().toISOString();
  index.liveId = match.id;
  writeIndex(index);
  return summarize(match);
}

/**
 * Keep the machine-wide store's snapshot current while the app runs.
 *
 * The CLI refreshes that store on its own schedule, rotating the refresh token
 * as it goes — and a rotation invalidates the previous one server-side. A
 * snapshot taken before the rotation is therefore not merely old, it is dead:
 * restoring it signs the account out. Syncing only at switch time left that
 * window open for however long the user went without switching, which in
 * practice was forever.
 */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
let syncTimer = null;

function startCredentialWatch() {
  if (syncTimer) return;
  const tick = () => syncActiveFromDisk()
    .catch(err => console.warn('[AccountManager] credential sync failed:', err.message));
  tick();
  syncTimer = setInterval(tick, SYNC_INTERVAL_MS);
  if (syncTimer.unref) syncTimer.unref();
}

function stopCredentialWatch() {
  if (!syncTimer) return;
  clearInterval(syncTimer);
  syncTimer = null;
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
  startCredentialWatch,
  stopCredentialWatch,
  updateAccount,
  renameAccount,
  removeAccount,
  accountConfigDir,
  ensureAccountStore,
  credentialsForAccount,
  ownsLiveStore,
  accountEnv
};
