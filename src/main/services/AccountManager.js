/**
 * AccountManager
 * Manages multiple Claude OAuth accounts by snapshotting ~/.claude/.credentials.json
 * into ~/.claude-terminal/accounts/ and swapping the active credentials on demand.
 *
 * Login flow stays unchanged: user runs `claude /login` once in a terminal,
 * then captures the resulting credentials as a named account.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { dataDir } = require('../utils/paths');

const accountsDir = path.join(dataDir, 'accounts');
const indexFile = path.join(accountsDir, 'index.json');

function getCredentialsPath() {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(claudeDir, '.credentials.json');
}

function ensureDir() {
  if (!fs.existsSync(accountsDir)) fs.mkdirSync(accountsDir, { recursive: true });
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

function readCurrentCredentials() {
  const credPath = getCredentialsPath();
  if (!fs.existsSync(credPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(credPath, 'utf-8'));
  } catch {
    return null;
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
function listAccounts() {
  const index = readIndex();
  const currentFp = fingerprintCredentials(readCurrentCredentials());
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
function captureCurrent(name) {
  const creds = readCurrentCredentials();
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

  fs.writeFileSync(accountFile(id), JSON.stringify(creds, null, 2));
  index.accounts.push(account);
  index.activeId = id;
  writeIndex(index);
  return summarize(account);
}

/**
 * Swap ~/.claude/.credentials.json with the stored snapshot for this account.
 * Returns the swapped account summary.
 */
function switchTo(id) {
  const index = readIndex();
  const account = index.accounts.find(a => a.id === id);
  if (!account) throw new Error(`Account ${id} not found.`);

  const file = accountFile(id);
  if (!fs.existsSync(file)) {
    throw new Error(`Stored credentials missing for "${account.name}". Re-capture required.`);
  }

  const credPath = getCredentialsPath();
  const claudeDir = path.dirname(credPath);
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });

  const tmp = `${credPath}.tmp`;
  fs.copyFileSync(file, tmp);
  fs.renameSync(tmp, credPath);

  account.lastUsedAt = new Date().toISOString();
  index.activeId = id;
  writeIndex(index);
  return summarize(account);
}

/**
 * Refresh the stored snapshot for an account from the live ~/.claude/.credentials.json.
 * Used after the SDK refreshes tokens so backups stay current.
 */
function syncActiveFromDisk() {
  const creds = readCurrentCredentials();
  if (!creds) return null;
  const fp = fingerprintCredentials(creds);
  const index = readIndex();
  const match = index.accounts.find(a => a.fingerprint === fp);
  if (!match) return null;
  fs.writeFileSync(accountFile(match.id), JSON.stringify(creds, null, 2));
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
