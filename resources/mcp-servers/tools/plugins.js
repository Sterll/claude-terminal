'use strict';

/**
 * Plugins Tools Module for Claude Terminal MCP
 *
 * Provides Claude Code plugin management tools: list, install, uninstall, catalog.
 */

const fs = require('fs');
const path = require('path');

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:plugins] ${args.join(' ')}\n`);
}

// -- Data access --------------------------------------------------------------

function getDataDir() {
  return process.env.CT_DATA_DIR || '';
}

function getClaudeDir() {
  return path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude');
}

function loadInstalledPlugins() {
  const file = path.join(getClaudeDir(), 'plugins', 'installed_plugins.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log('Error reading installed_plugins.json:', e.message);
  }
  return null;
}

function loadKnownMarketplaces() {
  const file = path.join(getClaudeDir(), 'plugins', 'known_marketplaces.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log('Error reading known_marketplaces.json:', e.message);
  }
  return null;
}

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'plugin_list',
    description: 'List all Claude Code plugins currently installed.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'plugin_install',
    description: 'Install a Claude Code plugin. The installation runs asynchronously in Claude Terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin: { type: 'string', description: 'Plugin name or URL to install' },
        marketplace: { type: 'string', description: 'Optional marketplace URL to install from' },
      },
      required: ['plugin'],
    },
  },
  {
    name: 'plugin_uninstall',
    description: 'Uninstall a Claude Code plugin.',
    inputSchema: {
      type: 'object',
      properties: {
        plugin: { type: 'string', description: 'Plugin name to uninstall' },
      },
      required: ['plugin'],
    },
  },
  {
    name: 'plugin_catalog',
    description: 'Browse available plugins from registered marketplaces.',
    inputSchema: {
      type: 'object',
      properties: {
        marketplace: { type: 'string', description: 'Specific marketplace URL to browse. If omitted, lists all known marketplaces.' },
      },
    },
  },
];

// -- Tool handler -------------------------------------------------------------

async function handle(name, args) {
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  try {
    if (name === 'plugin_list') {
      const data = loadInstalledPlugins();
      if (!data) return ok('No plugins installed.');

      const plugins = Array.isArray(data) ? data : (data.plugins || []);
      if (!plugins.length) return ok('No plugins installed.');

      const lines = plugins.map(p => {
        const parts = [`${p.name || '(unnamed)'}`];
        if (p.version) parts[0] += ` v${p.version}`;
        if (p.description) parts.push(`  Description: ${p.description}`);
        if (p.marketplace) parts.push(`  Marketplace: ${p.marketplace}`);
        if (p.source) parts.push(`  Source: ${p.source}`);
        return parts.join('\n');
      });

      return ok(`Installed plugins (${plugins.length}):\n\n${lines.join('\n\n')}`);
    }

    if (name === 'plugin_install') {
      if (!args.plugin) return fail('Missing required parameter: plugin');

      const triggerDir = path.join(getDataDir(), 'plugins', 'triggers');
      if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });

      const triggerFile = path.join(triggerDir, `install_${Date.now()}.json`);
      fs.writeFileSync(triggerFile, JSON.stringify({
        action: 'install',
        plugin: args.plugin,
        marketplace: args.marketplace || null,
        source: 'mcp',
        timestamp: new Date().toISOString(),
      }), 'utf8');

      let msg = `Plugin install triggered for "${args.plugin}".`;
      if (args.marketplace) msg += ` Marketplace: ${args.marketplace}`;
      msg += ' The installation will run asynchronously in Claude Terminal.';
      return ok(msg);
    }

    if (name === 'plugin_uninstall') {
      if (!args.plugin) return fail('Missing required parameter: plugin');

      const triggerDir = path.join(getDataDir(), 'plugins', 'triggers');
      if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });

      const triggerFile = path.join(triggerDir, `uninstall_${Date.now()}.json`);
      fs.writeFileSync(triggerFile, JSON.stringify({
        action: 'uninstall',
        plugin: args.plugin,
        source: 'mcp',
        timestamp: new Date().toISOString(),
      }), 'utf8');

      return ok(`Plugin uninstall triggered for "${args.plugin}". The removal will run asynchronously in Claude Terminal.`);
    }

    if (name === 'plugin_catalog') {
      const data = loadKnownMarketplaces();
      if (!data) return ok('No marketplaces registered. Add marketplaces in Claude Terminal settings.');

      const marketplaces = Array.isArray(data) ? data : (data.marketplaces || []);
      if (!marketplaces.length) return ok('No marketplaces registered. Add marketplaces in Claude Terminal settings.');

      if (args.marketplace) {
        const target = args.marketplace.toLowerCase();
        const found = marketplaces.find(m =>
          (m.url || '').toLowerCase() === target ||
          (m.name || '').toLowerCase() === target
        );

        if (!found) return fail(`Marketplace "${args.marketplace}" not found. Use plugin_catalog without arguments to see all known marketplaces.`);

        let output = `# ${found.name || found.url}\n`;
        output += `URL: ${found.url || '?'}\n`;
        if (found.description) output += `Description: ${found.description}\n`;
        if (found.pluginCount != null) output += `Plugins: ${found.pluginCount}\n`;
        return ok(output);
      }

      const lines = marketplaces.map(m => {
        const parts = [`${m.name || m.url || '(unnamed)'}`];
        if (m.url) parts.push(`  URL: ${m.url}`);
        if (m.description) parts.push(`  Description: ${m.description}`);
        if (m.pluginCount != null) parts.push(`  Plugins: ${m.pluginCount}`);
        return parts.join('\n');
      });

      return ok(`Known marketplaces (${marketplaces.length}):\n\n${lines.join('\n\n')}`);
    }

    return fail(`Unknown plugin tool: ${name}`);
  } catch (error) {
    log(`Error in ${name}:`, error.message);
    return fail(`Plugin error: ${error.message}`);
  }
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {}

// -- Exports ------------------------------------------------------------------

module.exports = { tools, handle, cleanup };
