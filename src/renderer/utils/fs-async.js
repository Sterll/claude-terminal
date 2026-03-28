/**
 * Async File System Utilities
 * Non-blocking replacements for sync fs operations in the renderer process.
 * Prevents UI freezes by using fs.promises (libuv thread pool) instead of sync calls.
 */

const { fs, path } = window.electron_nodeModules;
const fsp = fs.promises;

/**
 * Check if a file/directory exists (async replacement for fs.existsSync)
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomic write with backup and recovery.
 * Pattern: ensure dir -> backup existing -> write tmp -> rename -> cleanup backup
 * @param {string} filePath
 * @param {string} content
 * @param {{ backup?: boolean }} opts
 */
async function atomicWrite(filePath, content, { backup = true } = {}) {
  const tmpFile = filePath + '.tmp';
  const bakFile = filePath + '.bak';

  try {
    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });

    if (backup) {
      try { await fsp.copyFile(filePath, bakFile); } catch {}
    }

    await fsp.writeFile(tmpFile, content, 'utf8');
    await fsp.rename(tmpFile, filePath);

    if (backup) {
      try { await fsp.unlink(bakFile); } catch {}
    }
  } catch (err) {
    if (backup) {
      try { await fsp.copyFile(bakFile, filePath); } catch {}
    }
    try { await fsp.unlink(tmpFile); } catch {}
    throw err;
  }
}

/**
 * Atomic JSON write
 * @param {string} filePath
 * @param {*} data - Will be JSON.stringify'd
 * @param {{ backup?: boolean }} opts
 */
async function atomicWriteJSON(filePath, data, opts) {
  return atomicWrite(filePath, JSON.stringify(data, null, 2), opts);
}

/**
 * Safe read file - returns null if file doesn't exist or errors
 * @param {string} filePath
 * @param {string} encoding
 * @returns {Promise<string|null>}
 */
async function safeReadFile(filePath, encoding = 'utf8') {
  try {
    return await fsp.readFile(filePath, encoding);
  } catch {
    return null;
  }
}

/**
 * Safe read JSON - returns null if file doesn't exist or is invalid JSON
 * @param {string} filePath
 * @returns {Promise<*|null>}
 */
async function safeReadJSON(filePath) {
  const raw = await safeReadFile(filePath);
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Recursive directory copy (async replacement for sync recursive copy)
 * @param {string} src
 * @param {string} dest
 */
async function copyDirRecursive(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else {
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Ensure directories exist (async replacement for mkdirSync)
 * @param {...string} dirs
 */
async function ensureDirs(...dirs) {
  for (const dir of dirs) {
    await fsp.mkdir(dir, { recursive: true });
  }
}

module.exports = {
  fsp,
  fileExists,
  atomicWrite,
  atomicWriteJSON,
  safeReadFile,
  safeReadJSON,
  copyDirRecursive,
  ensureDirs
};
