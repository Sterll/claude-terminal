/**
 * Paths Utilities
 * Centralized path definitions for the application
 */

// Use preload API for Node.js modules
const { path, fs, os, process: nodeProcess, __dirname: appDir } = window.electron_nodeModules;

// Base directories
const homeDir = os.homedir();
const dataDir = path.join(homeDir, '.claude-terminal');
const claudeDir = path.join(homeDir, '.claude');

// Application data files
const projectsFile = path.join(dataDir, 'projects.json');
const settingsFile = path.join(dataDir, 'settings.json');
const legacyMcpsFile = path.join(dataDir, 'mcps.json');
const archivesDir = path.join(dataDir, 'archives'); // Legacy, kept for migration
const timeTrackingFile = path.join(dataDir, 'timetracking.json');
const timeTrackingDir = path.join(dataDir, 'timetracking');
const sessionRecapsDir = path.join(dataDir, 'session-recaps');
const contextPacksFile = path.join(dataDir, 'context-packs.json');
const promptTemplatesFile = path.join(dataDir, 'prompt-templates.json');
const queryHistoryFile = path.join(dataDir, 'query-history.json');
const savedQueriesFile = path.join(dataDir, 'saved-queries.json');

// Claude configuration files
const claudeSettingsFile = path.join(claudeDir, 'settings.json');
const claudeConfigFile = path.join(homeDir, '.claude.json'); // Main Claude Code config with MCP servers
const skillsDir = path.join(claudeDir, 'skills');
const agentsDir = path.join(claudeDir, 'agents');

/**
 * Ensure all required directories exist
 */
async function ensureDirectories() {
  const { ensureDirs } = require('./fs-async');
  await ensureDirs(dataDir, skillsDir, agentsDir, timeTrackingDir, sessionRecapsDir);
}

/**
 * Get the application assets directory
 * @returns {Promise<string>}
 */
async function getAssetsDir() {
  const { fileExists } = require('./fs-async');
  // In development: appDir/assets (appDir is the project root)
  // In production: resources/assets
  const devPath = path.join(appDir, 'assets');
  if (await fileExists(devPath)) {
    return devPath;
  }
  return path.join(nodeProcess.resourcesPath, 'assets');
}

module.exports = {
  homeDir,
  dataDir,
  claudeDir,
  projectsFile,
  settingsFile,
  legacyMcpsFile,
  archivesDir,
  timeTrackingFile,
  timeTrackingDir,
  sessionRecapsDir,
  contextPacksFile,
  promptTemplatesFile,
  queryHistoryFile,
  savedQueriesFile,
  claudeSettingsFile,
  claudeConfigFile,
  skillsDir,
  agentsDir,
  ensureDirectories,
  getAssetsDir
};
