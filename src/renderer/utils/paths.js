/**
 * Paths Utilities
 * Centralized path definitions for the application
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

// Base directories
const homeDir = os.homedir();
const dataDir = path.join(homeDir, '.claude-terminal');
const claudeDir = path.join(homeDir, '.claude');

// Application data files
const projectsFile = path.join(dataDir, 'projects.json');
const settingsFile = path.join(dataDir, 'settings.json');
const legacyMcpsFile = path.join(dataDir, 'mcps.json');

// Claude configuration files
const claudeSettingsFile = path.join(claudeDir, 'settings.json');
const claudeConfigFile = path.join(homeDir, '.claude.json'); // Main Claude Code config with MCP servers
const skillsDir = path.join(claudeDir, 'skills');
const agentsDir = path.join(claudeDir, 'agents');

/**
 * Ensure all required directories exist
 */
function ensureDirectories() {
  [dataDir, skillsDir, agentsDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

/**
 * Get the path for a project-specific Claude settings file
 * @param {string} projectPath - Project root path
 * @returns {string} - Path to .claude/settings.local.json
 */
function getProjectClaudeSettings(projectPath) {
  return path.join(projectPath, '.claude', 'settings.local.json');
}

/**
 * Check if a path exists
 * @param {string} filePath - Path to check
 * @returns {boolean}
 */
function pathExists(filePath) {
  return fs.existsSync(filePath);
}

/**
 * Get the application assets directory
 * @returns {string}
 */
function getAssetsDir() {
  // In development: __dirname/../../../assets
  // In production: resources/assets
  const devPath = path.join(__dirname, '..', '..', '..', 'assets');
  if (fs.existsSync(devPath)) {
    return devPath;
  }
  return path.join(process.resourcesPath, 'assets');
}

module.exports = {
  homeDir,
  dataDir,
  claudeDir,
  projectsFile,
  settingsFile,
  legacyMcpsFile,
  claudeSettingsFile,
  claudeConfigFile,
  skillsDir,
  agentsDir,
  ensureDirectories,
  getProjectClaudeSettings,
  pathExists,
  getAssetsDir
};
