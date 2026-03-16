'use strict';

/**
 * Marketplace & Discovery Tools Module for Claude Terminal MCP
 *
 * Provides tools for searching and installing skills from the skills.sh marketplace,
 * and for browsing the official MCP server registry.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:marketplace] ${args.join(' ')}\n`);
}

// -- Data access --------------------------------------------------------------

function getDataDir() {
  return process.env.CT_DATA_DIR || '';
}

function getSkillsDir() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.claude', 'skills');
}

// -- HTTP helper --------------------------------------------------------------

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      const { statusCode } = res;

      // Follow redirects (301, 302, 307, 308)
      if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
        res.resume();
        return httpGet(res.headers.location).then(resolve, reject);
      }

      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode} from ${url}`));
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(body));
        } catch (_) {
          resolve(body);
        }
      });
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout (10s) for ${url}`));
    });

    req.on('error', reject);
  });
}

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'marketplace_search',
    description: 'Search for skills on the skills.sh marketplace.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for skills' },
        limit: { type: 'number', description: 'Maximum number of results (default: 10, max: 30)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'marketplace_featured',
    description: 'Get featured/popular skills from the skills.sh marketplace.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of results (default: 10)' },
      },
    },
  },
  {
    name: 'marketplace_install',
    description: 'Install a skill from the skills.sh marketplace into Claude Terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill name or slug to install' },
      },
      required: ['skill'],
    },
  },
  {
    name: 'marketplace_uninstall',
    description: 'Uninstall a skill from Claude Terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill name or slug to uninstall' },
      },
      required: ['skill'],
    },
  },
  {
    name: 'marketplace_installed',
    description: 'List all skills currently installed in Claude Terminal.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'mcp_registry_search',
    description: 'Search the official MCP server registry for MCP servers.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for MCP servers' },
        limit: { type: 'number', description: 'Maximum number of results (default: 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'mcp_registry_detail',
    description: 'Get detailed information about a specific MCP server from the registry.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Server ID or name from the MCP registry' },
      },
      required: ['server'],
    },
  },
];

// -- Formatting helpers -------------------------------------------------------

function formatSkillResult(skill) {
  const parts = [skill.name || skill.slug || '(unknown)'];
  if (skill.description) parts.push(`  ${skill.description}`);
  if (skill.author) parts.push(`  Author: ${skill.author}`);
  if (skill.downloads != null) parts.push(`  Downloads: ${skill.downloads}`);
  if (skill.slug) parts.push(`  Slug: ${skill.slug}`);
  return parts.join('\n');
}

function formatRegistryResult(server) {
  const parts = [server.name || server.id || '(unknown)'];
  if (server.description) parts.push(`  ${server.description}`);
  if (server.author) parts.push(`  Author: ${server.author}`);
  if (server.tools && Array.isArray(server.tools)) {
    parts.push(`  Tools: ${server.tools.length}`);
  } else if (server.toolCount != null) {
    parts.push(`  Tools: ${server.toolCount}`);
  }
  return parts.join('\n');
}

function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      meta[key] = value;
    }
  }
  return meta;
}

// -- Tool handler -------------------------------------------------------------

async function handle(name, args) {
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  try {
    // -- marketplace_search ---------------------------------------------------
    if (name === 'marketplace_search') {
      if (!args.query) return fail('Missing required parameter: query');

      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 30);
      const query = encodeURIComponent(args.query);
      const url = `https://skills.sh/api/search?q=${query}&limit=${limit}`;

      let data;
      try {
        data = await httpGet(url);
      } catch (err) {
        return fail(`Failed to search skills.sh: ${err.message}`);
      }

      const results = Array.isArray(data) ? data : (data.results || data.skills || []);
      if (!results.length) return ok(`No skills found for "${args.query}".`);

      const lines = results.slice(0, limit).map(formatSkillResult);
      return ok(`Marketplace search results for "${args.query}" (${lines.length}):\n\n${lines.join('\n\n')}`);
    }

    // -- marketplace_featured -------------------------------------------------
    if (name === 'marketplace_featured') {
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 30);
      const url = `https://skills.sh/api/featured?limit=${limit}`;

      let data;
      try {
        data = await httpGet(url);
      } catch (err) {
        return fail(`Failed to fetch featured skills: ${err.message}`);
      }

      const results = Array.isArray(data) ? data : (data.results || data.skills || []);
      if (!results.length) return ok('No featured skills available.');

      const lines = results.slice(0, limit).map(formatSkillResult);
      return ok(`Featured skills (${lines.length}):\n\n${lines.join('\n\n')}`);
    }

    // -- marketplace_install --------------------------------------------------
    if (name === 'marketplace_install') {
      if (!args.skill) return fail('Missing required parameter: skill');

      const triggerDir = path.join(getDataDir(), 'marketplace', 'triggers');
      if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });

      const triggerFile = path.join(triggerDir, `install_${Date.now()}.json`);
      fs.writeFileSync(triggerFile, JSON.stringify({
        action: 'install',
        skill: args.skill,
        source: 'mcp',
        timestamp: new Date().toISOString(),
      }), 'utf8');

      return ok(`Install triggered for skill "${args.skill}". Claude Terminal will handle the installation (git clone + registration).`);
    }

    // -- marketplace_uninstall ------------------------------------------------
    if (name === 'marketplace_uninstall') {
      if (!args.skill) return fail('Missing required parameter: skill');

      const triggerDir = path.join(getDataDir(), 'marketplace', 'triggers');
      if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });

      const triggerFile = path.join(triggerDir, `uninstall_${Date.now()}.json`);
      fs.writeFileSync(triggerFile, JSON.stringify({
        action: 'uninstall',
        skill: args.skill,
        source: 'mcp',
        timestamp: new Date().toISOString(),
      }), 'utf8');

      return ok(`Uninstall triggered for skill "${args.skill}". Claude Terminal will handle the removal.`);
    }

    // -- marketplace_installed ------------------------------------------------
    if (name === 'marketplace_installed') {
      const installedSkills = [];

      // Source 1: marketplace.json from CT data directory
      const marketplaceFile = path.join(getDataDir(), 'marketplace.json');
      let marketplaceData = {};
      try {
        if (fs.existsSync(marketplaceFile)) {
          marketplaceData = JSON.parse(fs.readFileSync(marketplaceFile, 'utf8'));
        }
      } catch (e) {
        log('Error reading marketplace.json:', e.message);
      }

      const marketplaceSkills = marketplaceData.installed || marketplaceData.skills || [];
      const seenNames = new Set();

      for (const skill of marketplaceSkills) {
        const skillName = skill.name || skill.slug || '(unknown)';
        seenNames.add(skillName.toLowerCase());
        const parts = [skillName];
        if (skill.description) parts.push(`  ${skill.description}`);
        if (skill.installedAt || skill.installedDate) {
          parts.push(`  Installed: ${skill.installedAt || skill.installedDate}`);
        }
        parts.push('  Source: marketplace');
        installedSkills.push(parts.join('\n'));
      }

      // Source 2: ~/.claude/skills/ directory (SKILL.md files)
      const skillsDir = getSkillsDir();
      try {
        if (fs.existsSync(skillsDir)) {
          const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
            if (!fs.existsSync(skillMdPath)) continue;

            // Skip if already listed from marketplace.json
            if (seenNames.has(entry.name.toLowerCase())) continue;

            const parts = [entry.name];
            try {
              const content = fs.readFileSync(skillMdPath, 'utf8');
              const meta = parseFrontmatter(content);
              if (meta.description) parts.push(`  ${meta.description}`);
              if (meta.author) parts.push(`  Author: ${meta.author}`);
            } catch (_) {}

            // Check directory modified time as proxy for install date
            try {
              const stat = fs.statSync(path.join(skillsDir, entry.name));
              parts.push(`  Installed: ${stat.mtime.toISOString().split('T')[0]}`);
            } catch (_) {}

            parts.push('  Source: local');
            installedSkills.push(parts.join('\n'));
          }
        }
      } catch (e) {
        log('Error scanning skills directory:', e.message);
      }

      if (!installedSkills.length) return ok('No skills installed.');

      return ok(`Installed skills (${installedSkills.length}):\n\n${installedSkills.join('\n\n')}`);
    }

    // -- mcp_registry_search --------------------------------------------------
    if (name === 'mcp_registry_search') {
      if (!args.query) return fail('Missing required parameter: query');

      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 30);
      const query = encodeURIComponent(args.query);
      const url = `https://registry.modelcontextprotocol.io/v0.1/servers?q=${query}&limit=${limit}`;

      let data;
      try {
        data = await httpGet(url);
      } catch (err) {
        return fail(`Failed to search MCP registry: ${err.message}`);
      }

      const results = Array.isArray(data) ? data : (data.results || data.servers || []);
      if (!results.length) return ok(`No MCP servers found for "${args.query}".`);

      const lines = results.slice(0, limit).map(formatRegistryResult);
      return ok(`MCP Registry search results for "${args.query}" (${lines.length}):\n\n${lines.join('\n\n')}`);
    }

    // -- mcp_registry_detail --------------------------------------------------
    if (name === 'mcp_registry_detail') {
      if (!args.server) return fail('Missing required parameter: server');

      const serverId = encodeURIComponent(args.server);
      const url = `https://registry.modelcontextprotocol.io/v0.1/servers/${serverId}`;

      let data;
      try {
        data = await httpGet(url);
      } catch (err) {
        return fail(`Failed to fetch MCP server details: ${err.message}`);
      }

      if (!data || typeof data === 'string') {
        return fail(`MCP server "${args.server}" not found in registry.`);
      }

      let output = `# ${data.name || data.id || args.server}\n`;
      if (data.description) output += `${data.description}\n`;
      output += '\n';
      if (data.author) output += `Author: ${data.author}\n`;
      if (data.version) output += `Version: ${data.version}\n`;
      if (data.license) output += `License: ${data.license}\n`;
      if (data.repository || data.repo) output += `Repository: ${data.repository || data.repo}\n`;
      if (data.homepage) output += `Homepage: ${data.homepage}\n`;

      // Tools list
      if (data.tools && Array.isArray(data.tools) && data.tools.length) {
        output += `\n## Tools (${data.tools.length})\n`;
        for (const tool of data.tools) {
          if (typeof tool === 'string') {
            output += `  - ${tool}\n`;
          } else {
            output += `  - ${tool.name || '?'}`;
            if (tool.description) output += `: ${tool.description}`;
            output += '\n';
          }
        }
      }

      // Install instructions
      if (data.install || data.installation) {
        const installInfo = data.install || data.installation;
        output += '\n## Installation\n';
        if (typeof installInfo === 'string') {
          output += `${installInfo}\n`;
        } else if (installInfo.command) {
          output += `Command: ${installInfo.command}\n`;
        } else if (installInfo.npm) {
          output += `npm: ${installInfo.npm}\n`;
        }
      }

      // Config example
      if (data.config || data.configuration) {
        const config = data.config || data.configuration;
        output += '\n## Configuration\n';
        output += `${typeof config === 'string' ? config : JSON.stringify(config, null, 2)}\n`;
      }

      return ok(output);
    }

    return fail(`Unknown marketplace tool: ${name}`);
  } catch (error) {
    log(`Error in ${name}:`, error.message);
    return fail(`Marketplace error: ${error.message}`);
  }
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {}

// -- Exports ------------------------------------------------------------------

module.exports = { tools, handle, cleanup };
