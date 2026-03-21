/**
 * Sensitive file patterns for cloud sync exclusion.
 * Used by FileWatcherService (incremental sync) and zipProject (initial upload).
 * Configurable via `cloudExcludeSensitiveFiles` setting.
 */

const path = require('path');
const fs = require('fs');
const { settingsFile } = require('./paths');

// File names that are always sensitive
const SENSITIVE_NAMES = new Set([
  '.env', '.env.local', '.env.production', '.env.development', '.env.staging',
  '.env.test', '.env.prod', '.env.dev',
  '.npmrc',              // can contain auth tokens
  '.pypirc',             // PyPI credentials
  '.netrc',              // network credentials
  '.htpasswd',           // Apache passwords
  'credentials.json',    // GCP, Firebase, etc.
  'service-account.json',// GCP service account
  'serviceAccountKey.json',
  '.credentials.json',   // Claude credentials
  'secrets.json', 'secrets.yaml', 'secrets.yml',
  'docker-compose.override.yml', // often contains secrets
]);

// File extensions that are sensitive
const SENSITIVE_EXTENSIONS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.jks',  // certificates & keys
  '.keystore', '.truststore',
]);

// Glob patterns for filenames (startsWith matching)
const SENSITIVE_PREFIXES = [
  '.env.',  // .env.anything
];

/**
 * Check if a file path (relative) matches a sensitive pattern.
 * @param {string} relativePath - Forward-slash separated relative path
 * @returns {boolean}
 */
function isSensitiveFile(relativePath) {
  const basename = relativePath.split('/').pop();
  if (!basename) return false;

  // Exact name match
  if (SENSITIVE_NAMES.has(basename)) return true;
  if (SENSITIVE_NAMES.has(basename.toLowerCase())) return true;

  // Extension match
  const ext = path.extname(basename).toLowerCase();
  if (SENSITIVE_EXTENSIONS.has(ext)) return true;

  // Prefix match (.env.*)
  for (const prefix of SENSITIVE_PREFIXES) {
    if (basename.toLowerCase().startsWith(prefix)) return true;
  }

  return false;
}

/**
 * Check if the setting is enabled (reads from disk for main process usage).
 * @returns {boolean}
 */
function isExcludeSensitiveEnabled() {
  try {
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      return settings.cloudExcludeSensitiveFiles !== false;
    }
  } catch {}
  return true; // safe default
}

/**
 * Filter a list of file paths, removing sensitive files if setting is enabled.
 * @param {string[]} files - Array of relative file paths
 * @returns {string[]}
 */
function filterSensitiveFiles(files) {
  if (!isExcludeSensitiveEnabled()) return files;
  return files.filter(f => !isSensitiveFile(f));
}

module.exports = {
  SENSITIVE_NAMES,
  SENSITIVE_EXTENSIONS,
  isSensitiveFile,
  isExcludeSensitiveEnabled,
  filterSensitiveFiles,
};
