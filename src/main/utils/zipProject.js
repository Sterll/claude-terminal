/**
 * Zip Project Utility
 * Creates a zip archive of a project directory, respecting .gitignore rules.
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { settingsFile } = require('./paths');

// ── Sensitive file filter (inline) ──
const SENSITIVE_NAMES = new Set([
  '.env', '.env.local', '.env.production', '.env.development', '.env.staging',
  '.env.test', '.env.prod', '.env.dev',
  '.npmrc', '.pypirc', '.netrc', '.htpasswd',
  'credentials.json', 'service-account.json', 'serviceAccountKey.json',
  '.credentials.json', 'secrets.json', 'secrets.yaml', 'secrets.yml',
]);
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.truststore']);

function _isSensitiveFile(relativePath) {
  const basename = relativePath.split('/').pop();
  if (!basename) return false;
  if (SENSITIVE_NAMES.has(basename) || SENSITIVE_NAMES.has(basename.toLowerCase())) return true;
  if (SENSITIVE_EXTENSIONS.has(path.extname(basename).toLowerCase())) return true;
  if (basename.toLowerCase().startsWith('.env.')) return true;
  return false;
}

function filterSensitiveFiles(files) {
  try {
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (settings.cloudExcludeSensitiveFiles === false) return files;
    }
  } catch {}
  return files.filter(f => !_isSensitiveFile(f));
}

// Directories always excluded from zip
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'build', 'dist', '.next', '__pycache__',
  '.venv', 'venv', '.cache', 'coverage', '.tsbuildinfo', '.ct-cloud',
  '.turbo', '.parcel-cache', '.svelte-kit', '.nuxt', '.output',
]);

// Binary/already-compressed extensions — use STORE (no compression) to save CPU
const STORE_EXTENSIONS = new Set([
  // FiveM models/assets
  '.ytd', '.yft', '.ydr', '.ybn', '.ymap', '.ytyp', '.rpf', '.stream',
  // Images/textures
  '.png', '.jpg', '.jpeg', '.tga', '.dds', '.bmp', '.gif', '.webp', '.ico',
  // Audio/video
  '.mp3', '.ogg', '.wav', '.flac', '.mp4', '.webm',
  // Already compressed archives
  '.zip', '.rar', '.7z', '.gz', '.tar', '.bz2',
  // Binaries/fonts
  '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2', '.ttf', '.otf',
]);

/**
 * Get list of project files to include in zip.
 * Uses git ls-files if available, falls back to recursive walk.
 * @param {string} projectPath
 * @param {object} [options]
 * @param {boolean} [options.includeGit] - Include .git directory (for cloud sync)
 */
function getProjectFiles(projectPath, options = {}) {
  let files = [];

  try {
    // Try git ls-files (respects .gitignore automatically)
    const output = execSync(
      'git ls-files --cached --others --exclude-standard',
      { cwd: projectPath, encoding: 'utf-8', timeout: 15000, maxBuffer: 10 * 1024 * 1024 }
    );
    files = output.trim().split('\n').filter(Boolean);
    if (files.length === 0) files = walkDir(projectPath, projectPath);
  } catch {
    // Not a git repo or git not available — fall back to walk
    files = walkDir(projectPath, projectPath);
  }

  // Include .git directory contents for cloud sync (enables push/pull)
  if (options.includeGit) {
    const gitDir = path.join(projectPath, '.git');
    if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
      const gitFiles = walkGitDir(gitDir, projectPath);
      files.push(...gitFiles);
    }
  }

  return files;
}

/**
 * Recursive directory walk with exclusions.
 */
function walkDir(dir, rootDir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.') && EXCLUDE_DIRS.has(entry.name)) continue;
    if (EXCLUDE_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath, rootDir));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, fullPath));
    }
  }

  return files;
}

/**
 * Walk .git directory (no exclusions, only skip huge pack files > 50MB).
 */
function walkGitDir(dir, rootDir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkGitDir(fullPath, rootDir));
    } else if (entry.isFile()) {
      // Skip pack files larger than 50MB to keep upload reasonable
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > 50 * 1024 * 1024) continue;
      } catch { continue; }
      files.push(path.relative(rootDir, fullPath));
    }
  }

  return files;
}

/**
 * Create a zip archive of a project.
 * @param {string} projectPath - Absolute path to the project
 * @param {string} zipPath - Absolute path for the output zip
 * @param {function} [onProgress] - Progress callback ({ phase, percent })
 * @param {object} [options]
 * @param {boolean} [options.includeGit] - Include .git directory (for cloud sync)
 * @returns {Promise<string>} Path to the created zip
 */
async function zipProject(projectPath, zipPath, onProgress, options = {}) {
  const archiver = require('archiver');

  if (onProgress) onProgress({ phase: 'scanning', percent: 0 });

  const rawFiles = getProjectFiles(projectPath, options);
  // Filter out sensitive files (.env, keys, credentials) unless user opted out
  const files = filterSensitiveFiles(rawFiles);
  if (files.length === 0) throw new Error('No files found in project');

  if (onProgress) onProgress({ phase: 'compressing', percent: 10 });

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    let processed = 0;
    archive.on('entry', () => {
      processed++;
      if (onProgress) {
        const percent = 10 + Math.round((processed / files.length) * 80);
        onProgress({ phase: 'compressing', percent });
      }
    });

    output.on('close', () => resolve(zipPath));
    archive.on('error', reject);
    archive.pipe(output);

    for (const file of files) {
      const absPath = path.join(projectPath, file);
      const ext = path.extname(file).toLowerCase();
      // Use STORE (no compression) for binary/already-compressed files to save CPU
      archive.file(absPath, {
        name: file.replace(/\\/g, '/'),
        store: STORE_EXTENSIONS.has(ext),
      });
    }

    archive.finalize();
  });
}

module.exports = { zipProject, getProjectFiles };
