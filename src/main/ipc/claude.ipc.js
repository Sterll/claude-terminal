/**
 * Claude IPC Handlers
 * Handles Claude Code session-related IPC communication
 */

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Encode project path to match Claude's folder naming convention
 * @param {string} projectPath - The project path
 * @returns {string} - Encoded path for folder name
 */
function encodeProjectPath(projectPath) {
  // Claude uses path with : and \ replaced by -
  return projectPath.replace(/:/g, '-').replace(/\\/g, '-').replace(/\//g, '-');
}

/**
 * Get sessions index path for a project
 * @param {string} projectPath - The project path
 * @returns {string} - Path to sessions-index.json
 */
function getSessionsIndexPath(projectPath) {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const encodedPath = encodeProjectPath(projectPath);
  return path.join(claudeDir, encodedPath, 'sessions-index.json');
}

/**
 * Get Claude sessions for a project
 * @param {string} projectPath - The project path
 * @returns {Promise<Array>} - Array of session objects
 */
async function getClaudeSessions(projectPath) {
  try {
    const indexPath = getSessionsIndexPath(projectPath);

    if (!fs.existsSync(indexPath)) {
      return [];
    }

    const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

    if (!data.entries || !Array.isArray(data.entries)) {
      return [];
    }

    // Sort by modified date (most recent first) and limit to 10
    const sessions = data.entries
      .filter(entry => !entry.isSidechain) // Filter out sidechain sessions
      .sort((a, b) => new Date(b.modified) - new Date(a.modified))
      .slice(0, 10)
      .map(entry => ({
        sessionId: entry.sessionId,
        summary: entry.summary || 'Sans titre',
        firstPrompt: entry.firstPrompt || '',
        messageCount: entry.messageCount || 0,
        created: entry.created,
        modified: entry.modified,
        gitBranch: entry.gitBranch
      }));

    return sessions;
  } catch (error) {
    console.error('Error reading Claude sessions:', error);
    return [];
  }
}

/**
 * Register Claude IPC handlers
 */
function registerClaudeHandlers() {
  // Get Claude sessions for a project
  ipcMain.handle('claude-sessions', async (event, projectPath) => {
    return getClaudeSessions(projectPath);
  });
}

module.exports = { registerClaudeHandlers };
