/**
 * Main Process Paths Utilities
 * Centralized path definitions for the main process
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

// Base directories
const homeDir = os.homedir();
const dataDir = path.join(homeDir, '.claude-terminal');
const claudeDir = path.join(homeDir, '.claude');

// Application data files
const settingsFile = path.join(dataDir, 'settings.json');
const projectsFile = path.join(dataDir, 'projects.json');
// Files owned by the main process. settings.json is owned by the renderer:
// a main-side read-modify-write can race the renderer's atomic rename, read
// an in-flight file as empty and rewrite it with everything else stripped.
const windowStateFile = path.join(dataDir, 'window-state.json');
const machineIdFile = path.join(dataDir, 'machine-id.json');

/**
 * Ensure the data directory exists
 */
function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

/**
 * Load saved accent color from settings
 * @returns {string} - Accent color hex string
 */
function loadAccentColor() {
  const defaultColor = '#d97706';
  try {
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      return settings.accentColor || defaultColor;
    }
  } catch (e) {
    console.error('Error loading accent color:', e);
  }
  return defaultColor;
}

/**
 * Get the assets directory path
 * @param {string} dirname - __dirname from calling module
 * @returns {string}
 */
function getAssetsDir(dirname) {
  // In development: relative to main.js
  // In production: resources/assets
  const devPath = path.join(dirname, 'assets');
  if (fs.existsSync(devPath)) {
    return devPath;
  }
  return path.join(process.resourcesPath || dirname, 'assets');
}

/**
 * Where Claude Code reads administrator-deployed settings, most specific
 * first.
 *
 * These are not ours to write and not the user's to edit — that is the whole
 * point of them. Anything enforcing an org policy has to look here rather than
 * in `settingsFile`, which is this app's own preferences file and belongs to
 * the user.
 *
 * @returns {string[]}
 */
function managedSettingsPaths() {
  if (process.platform === 'win32') {
    const programData = process.env.ProgramData || 'C:\ProgramData';
    return [path.join(programData, 'ClaudeCode', 'managed-settings.json')];
  }
  if (process.platform === 'darwin') {
    return [
      '/Library/Application Support/ClaudeCode/managed-settings.json',
      '/etc/claude-code/managed-settings.json',
    ];
  }
  return ['/etc/claude-code/managed-settings.json'];
}

module.exports = {
  homeDir,
  dataDir,
  claudeDir,
  settingsFile,
  projectsFile,
  windowStateFile,
  machineIdFile,
  managedSettingsPaths,
  ensureDataDir,
  loadAccentColor,
  getAssetsDir
};
