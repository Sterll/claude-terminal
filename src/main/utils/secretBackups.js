'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { withCrossProcessLock } = require('./fileLock');
const { splitConnectionSecrets } = require('../../shared/database-credentials');
const SERVICE = 'claude-terminal-secret-backups';

function sanitize(value, kind) {
  if (kind === 'databases') {
    if (!Array.isArray(value)) throw new Error('Invalid database backup');
    return value.map(connection => splitConnectionSecrets(connection).config);
  }
  const copy = JSON.parse(JSON.stringify(value));
  function clean(config) {
    for (const [name, server] of Object.entries(config?.mcpServers || {})) {
      if (name !== 'claude-terminal' && !name.startsWith('claude-terminal-db-')) continue;
      for (const key of Object.keys(server?.env || {})) if (/^CT_DB_PASS(?:WORD)?(?:_|$)/.test(key)) delete server.env[key];
    }
  }
  clean(copy);
  for (const project of Object.values(copy?.projects || {})) clean(project);
  return copy;
}
function directory() { return path.join(require('./paths').dataDir, 'secret-backups'); }
async function key(create) {
  const dir = directory(); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return withCrossProcessLock(path.join(dir, '.key.lock'), async () => {
    const vault = require('keytar');
    let value = await vault.getPassword(SERVICE, 'encryption-key-v1');
    if (!value && create) {
      value = crypto.randomBytes(32).toString('hex');
      await vault.setPassword(SERVICE, 'encryption-key-v1', value);
      if (await vault.getPassword(SERVICE, 'encryption-key-v1') !== value) throw new Error('Could not verify backup encryption key');
    }
    if (!/^[a-f0-9]{64}$/.test(value || '')) throw new Error('Backup encryption key is unavailable in the OS keychain');
    return Buffer.from(value, 'hex');
  });
}
async function archive(file, original) {
  const encryptionKey = await key(true);
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ file, original }), 'utf8'), cipher.final()]);
  const archivePath = path.join(directory(), crypto.randomUUID() + '.ctbackup');
  const envelope = { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
  await fs.writeFile(archivePath, JSON.stringify(envelope), { flag: 'wx', mode: 0o600 });
  // Verify the persisted archive before allowing the plaintext to be replaced.
  const restored = await readArchive(archivePath, encryptionKey);
  if (restored.original !== original || restored.file !== file) throw new Error('Backup verification failed');
  return archivePath;
}
async function readArchive(file, encryptionKey) {
  if ((await fs.stat(file)).size > 32 * 1024 * 1024) throw new Error('Backup is too large');
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (value.version !== 1) throw new Error('Unsupported backup format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey || await key(false), Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8'));
}
async function secureFile(file, kind) {
  try { if (!(await fs.lstat(file)).isFile()) return false; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  return withCrossProcessLock(file + '.lock', async () => {
    const original = await fs.readFile(file, 'utf8');
    let parsed;
    try { parsed = JSON.parse(original); } catch { throw new Error('Invalid JSON; file preserved'); }
    const safe = sanitize(parsed, kind);
    if (JSON.stringify(safe) === JSON.stringify(parsed)) return false;
    await archive(file, original);
    if (await fs.readFile(file, 'utf8') !== original) throw new Error('Backup changed during migration; retry');
    const temporary = file + '.tmp.' + crypto.randomUUID();
    try {
      await fs.writeFile(temporary, JSON.stringify(safe, null, 2), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    return true;
  });
}
async function migrate(home, dataDir) {
  let secured = 0; const errors = [];
  for (const [dir, pattern, kind] of [
    [home, /^\.claude\.json\.(?:backup|bak)(?:[.-].*)?$/, 'claude'],
    [path.join(home, '.claude', 'backups'), /^\.claude\.json\.backup(?:[.-].*)?$/, 'claude'],
    [path.join(home, '.claude'), /^(?:settings\.json\.(?:backup|bak)(?:[.-].*)?|settings\.pre-hooks\.json)$/, 'claude'],
    [dataDir, /^databases\.json\.(?:backup|bak)(?:[.-].*)?$/, 'databases'],
  ]) {
    let names;
    try { names = await fs.readdir(dir); } catch (error) { if (error.code !== 'ENOENT') errors.push({ file: dir, error: error.code }); continue; }
    for (const name of names.filter(name => pattern.test(name) && !/\.(?:lock|ctbackup)$|\.tmp\./.test(name))) {
      const file = path.join(dir, name);
      try { if (await secureFile(file, kind)) secured++; }
      catch (error) { errors.push({ file, error: error.message }); }
    }
  }
  return { secured, errors };
}
module.exports = { sanitize, archive, readArchive, secureFile, migrate, directory };
