/**
 * MCP IPC Handlers
 * Handles MCP-related IPC communication
 */

const { ipcMain } = require('electron');
const mcpService = require('../services/McpService');
const { updateClaudeConfig } = require('../utils/claudeConfig');
const { sendFeaturePing } = require('../services/TelemetryService');

/**
 * Register MCP IPC handlers
 */
function registerMcpHandlers() {
  ipcMain.handle('mcp-save-server', async (_event, { name, config }) => {
    if (typeof name !== 'string' || !name || !config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid MCP server');
    await updateClaudeConfig(full => { full.mcpServers = { ...full.mcpServers, [name]: config }; });
  });
  ipcMain.handle('mcp-save-config', async (_event, servers, knownIds = []) => {
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('Invalid MCP configuration');
    if (!Array.isArray(knownIds) || knownIds.some(id => typeof id !== 'string')) throw new Error('Invalid MCP server ids');
    await updateClaudeConfig(config => {
      const next = { ...config.mcpServers };
      for (const id of knownIds) if (!Object.hasOwn(servers, id)) delete next[id];
      config.mcpServers = { ...next, ...servers };
    });
    return { success: true };
  });
  // Start MCP process
  ipcMain.handle('mcp-start', async (event, { id, command, args, env }) => {
    sendFeaturePing('mcp:start');
    return mcpService.start({ id, command, args, env });
  });

  // Stop MCP process
  ipcMain.handle('mcp-stop', async (event, { id }) => {
    sendFeaturePing('mcp:stop');
    return mcpService.stop({ id });
  });
}

module.exports = { registerMcpHandlers };
