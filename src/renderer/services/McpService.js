/**
 * MCP Service
 * Handles MCP server management in the renderer
 */

const { ipcRenderer } = require('electron');
const fs = require('fs');
const {
  getMcps,
  getMcp,
  setMcps,
  addMcp,
  updateMcp,
  removeMcp,
  getMcpProcess,
  setMcpProcessStatus,
  addMcpLog,
  clearMcpLogs,
  setSelectedMcp,
  initMcpProcess
} = require('../state');
const { claudeConfigFile, legacyMcpsFile } = require('../utils/paths');

/**
 * Load MCPs from Claude Code config file (~/.claude.json)
 */
function loadMcps() {
  let mcps = [];

  try {
    // Load from Claude Code config (~/.claude.json)
    if (fs.existsSync(claudeConfigFile)) {
      const config = JSON.parse(fs.readFileSync(claudeConfigFile, 'utf8'));

      // Load global MCP servers
      if (config.mcpServers) {
        mcps = Object.entries(config.mcpServers).map(([id, serverConfig]) => {
          const mcp = {
            id,
            name: id,
            type: serverConfig.type || 'stdio',
            enabled: true,
            scope: 'global'
          };

          if (serverConfig.type === 'http') {
            mcp.url = serverConfig.url;
          } else {
            mcp.command = serverConfig.command;
            mcp.args = serverConfig.args || [];
            mcp.env = serverConfig.env || {};
          }

          return mcp;
        });
      }

      // Load project-specific MCP servers
      if (config.projects) {
        Object.entries(config.projects).forEach(([projectPath, projectConfig]) => {
          if (projectConfig.mcpServers && Object.keys(projectConfig.mcpServers).length > 0) {
            Object.entries(projectConfig.mcpServers).forEach(([id, serverConfig]) => {
              // Check if already exists (global takes precedence)
              if (!mcps.find(m => m.id === id)) {
                const mcp = {
                  id,
                  name: id,
                  type: serverConfig.type || 'stdio',
                  enabled: true,
                  scope: 'project',
                  projectPath
                };

                if (serverConfig.type === 'http') {
                  mcp.url = serverConfig.url;
                } else {
                  mcp.command = serverConfig.command;
                  mcp.args = serverConfig.args || [];
                  mcp.env = serverConfig.env || {};
                }

                mcps.push(mcp);
              }
            });
          }
        });
      }
    }

    // Migrate from legacy file if needed
    if (mcps.length === 0 && fs.existsSync(legacyMcpsFile)) {
      const legacyMcps = JSON.parse(fs.readFileSync(legacyMcpsFile, 'utf8'));
      if (Array.isArray(legacyMcps)) {
        mcps = legacyMcps;
        saveMcps(mcps);
        // Remove legacy file after migration
        fs.unlinkSync(legacyMcpsFile);
      }
    }
  } catch (e) {
    console.error('Error loading MCPs:', e);
  }

  setMcps(mcps);

  // Initialize process tracking
  mcps.forEach(mcp => initMcpProcess(mcp.id));

  return mcps;
}

/**
 * Save MCPs to Claude Code config file (~/.claude.json)
 * Only saves global scope MCPs
 * @param {Array} mcps
 */
function saveMcps(mcps) {
  try {
    let config = {};

    if (fs.existsSync(claudeConfigFile)) {
      config = JSON.parse(fs.readFileSync(claudeConfigFile, 'utf8'));
    }

    config.mcpServers = {};
    mcps.filter(mcp => mcp.scope !== 'project').forEach(mcp => {
      if (mcp.type === 'http') {
        config.mcpServers[mcp.id] = {
          type: 'http',
          url: mcp.url
        };
      } else {
        config.mcpServers[mcp.id] = {
          type: 'stdio',
          command: mcp.command,
          args: mcp.args || [],
          env: mcp.env || {}
        };
      }
    });

    fs.writeFileSync(claudeConfigFile, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('Error saving MCPs:', e);
  }
}

/**
 * Start an MCP server
 * @param {string} id - MCP ID
 * @returns {Promise<Object>}
 */
async function startMcp(id) {
  const mcp = getMcp(id);
  if (!mcp) return { success: false, error: 'MCP not found' };

  setMcpProcessStatus(id, 'starting');
  addMcpLog(id, 'info', `Starting ${mcp.name}...`);

  try {
    // HTTP servers are external - just mark as running
    if (mcp.type === 'http') {
      setMcpProcessStatus(id, 'running');
      addMcpLog(id, 'info', `HTTP server available at ${mcp.url}`);
      return { success: true };
    }

    // stdio servers need to be spawned
    const result = await ipcRenderer.invoke('mcp-start', {
      id,
      command: mcp.command,
      args: mcp.args,
      env: mcp.env
    });

    if (result.success) {
      setMcpProcessStatus(id, 'running');
      addMcpLog(id, 'info', 'Started successfully');
    } else {
      setMcpProcessStatus(id, 'error');
      addMcpLog(id, 'stderr', result.error || 'Failed to start');
    }

    return result;
  } catch (e) {
    setMcpProcessStatus(id, 'error');
    addMcpLog(id, 'stderr', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Stop an MCP server
 * @param {string} id - MCP ID
 * @returns {Promise<Object>}
 */
async function stopMcp(id) {
  const mcp = getMcp(id);
  addMcpLog(id, 'info', 'Stopping...');

  try {
    // HTTP servers are external - just mark as stopped
    if (mcp && mcp.type === 'http') {
      setMcpProcessStatus(id, 'stopped');
      addMcpLog(id, 'info', 'Disconnected');
      return { success: true };
    }

    const result = await ipcRenderer.invoke('mcp-stop', { id });
    setMcpProcessStatus(id, 'stopped');
    addMcpLog(id, 'info', 'Stopped');
    return result;
  } catch (e) {
    addMcpLog(id, 'stderr', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Register MCP IPC listeners
 * @param {Function} onOutputCallback - Callback for MCP output
 * @param {Function} onExitCallback - Callback for MCP exit
 */
function registerMcpListeners(onOutputCallback, onExitCallback) {
  ipcRenderer.on('mcp-output', (event, { id, type, data }) => {
    addMcpLog(id, type, data);
    if (onOutputCallback) {
      onOutputCallback(id, type, data);
    }
  });

  ipcRenderer.on('mcp-exit', (event, { id, code }) => {
    setMcpProcessStatus(id, 'stopped');
    addMcpLog(id, 'info', `Exited with code ${code}`);
    if (onExitCallback) {
      onExitCallback(id, code);
    }
  });
}

/**
 * Create a new MCP configuration
 * @param {Object} config
 * @returns {Object}
 */
function createMcp(config) {
  const mcp = {
    id: config.id || `mcp-${Date.now()}`,
    name: config.name || config.id,
    command: config.command,
    args: config.args || [],
    env: config.env || {},
    enabled: true
  };

  addMcp(mcp);
  initMcpProcess(mcp.id);
  saveMcps(getMcps());

  return mcp;
}

/**
 * Update MCP configuration
 * @param {string} id
 * @param {Object} updates
 */
function updateMcpConfig(id, updates) {
  updateMcp(id, updates);
  saveMcps(getMcps());
}

/**
 * Delete an MCP
 * @param {string} id
 */
async function deleteMcp(id) {
  // Stop if running
  const process = getMcpProcess(id);
  if (process.status === 'running') {
    await stopMcp(id);
  }

  removeMcp(id);
  saveMcps(getMcps());
}

module.exports = {
  loadMcps,
  saveMcps,
  startMcp,
  stopMcp,
  registerMcpListeners,
  createMcp,
  updateMcpConfig,
  deleteMcp,
  getMcps,
  getMcp,
  getMcpProcess,
  clearMcpLogs,
  setSelectedMcp
};
