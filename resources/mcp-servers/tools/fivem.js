'use strict';

/**
 * FiveM Tools Module for Claude Terminal MCP
 *
 * Provides FiveM project-specific tools: resource scanning, manifest reading,
 * server.cfg analysis, and server control via trigger files.
 *
 * Only relevant for projects with type === 'fivem'.
 */

const fs = require('fs');
const path = require('path');
const { loadProjects } = require('./_projectsCache');

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:fivem] ${args.join(' ')}\n`);
}

// -- Data access --------------------------------------------------------------

function getDataDir() {
  return process.env.CT_DATA_DIR || '';
}

function findFivemProject(nameOrId) {
  const data = loadProjects();
  const project = data.projects.find(p =>
    p.id === nameOrId ||
    (p.name || '').toLowerCase() === nameOrId.toLowerCase() ||
    path.basename(p.path || '').toLowerCase() === nameOrId.toLowerCase()
  );
  if (!project) return null;
  if (project.type !== 'fivem') return null;
  return project;
}

function findAnyFivemProject(nameOrId) {
  // Also allow by name without strict type check — user may not have set type
  const data = loadProjects();
  return data.projects.find(p =>
    (p.type === 'fivem') && (
      p.id === nameOrId ||
      (p.name || '').toLowerCase() === nameOrId.toLowerCase() ||
      path.basename(p.path || '').toLowerCase() === nameOrId.toLowerCase()
    )
  );
}

function listFivemProjects() {
  const data = loadProjects();
  return data.projects.filter(p => p.type === 'fivem');
}

// -- Resource scanning --------------------------------------------------------

function scanResources(projectPath) {
  const resourcesDir = path.join(projectPath, 'resources');
  if (!fs.existsSync(resourcesDir)) return [];

  const results = [];

  function scanDir(dir, category) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const resPath = path.join(dir, entry.name);

        // Check for manifest
        const hasFxManifest = fs.existsSync(path.join(resPath, 'fxmanifest.lua'));
        const hasOldManifest = !hasFxManifest && fs.existsSync(path.join(resPath, '__resource.lua'));

        if (hasFxManifest || hasOldManifest) {
          results.push({
            name: entry.name,
            path: resPath,
            category,
            manifest: hasFxManifest ? 'fxmanifest.lua' : '__resource.lua',
          });
        }
      }
    } catch (_) {}
  }

  // Scan root resources/
  scanDir(resourcesDir, 'root');

  // Scan category dirs like [local], [standalone], etc.
  try {
    const topEntries = fs.readdirSync(resourcesDir, { withFileTypes: true });
    for (const entry of topEntries) {
      if (entry.isDirectory() && entry.name.startsWith('[') && entry.name.endsWith(']')) {
        scanDir(path.join(resourcesDir, entry.name), entry.name);
      }
    }
  } catch (_) {}

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

// -- Manifest parsing ---------------------------------------------------------

function parseManifest(manifestPath) {
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = {};

    // Single-value fields: key 'value'
    const singleFields = ['fx_version', 'game', 'name', 'description', 'version', 'author'];
    for (const field of singleFields) {
      const match = raw.match(new RegExp(`${field}\\s+['"]([^'"]*?)['"]`));
      if (match) parsed[field] = match[1];
    }

    // Array fields: key { 'file1', 'file2' }
    const arrayFields = ['client_scripts', 'server_scripts', 'shared_scripts', 'dependencies',
                          'client_script', 'server_script', 'shared_script', 'dependency'];
    for (const field of arrayFields) {
      const match = raw.match(new RegExp(`${field}\\s*\\{([^}]*)\\}`, 's'));
      if (match) {
        const items = match[1].match(/['"]([^'"]*?)['"]/g);
        if (items) {
          const key = field.endsWith('s') ? field : field + 's';
          parsed[key] = items.map(i => i.replace(/['"]/g, ''));
        }
      }
      // Single value variant: client_script 'file.lua'
      if (!parsed[field + 's'] && !parsed[field]) {
        const single = raw.match(new RegExp(`${field}\\s+['"]([^'"]*?)['"]`));
        if (single) {
          const key = field.endsWith('s') ? field : field + 's';
          parsed[key] = [single[1]];
        }
      }
    }

    return { raw, parsed };
  } catch (e) {
    return { raw: null, parsed: null, error: e.message };
  }
}

// -- server.cfg parsing -------------------------------------------------------

function parseServerCfg(projectPath) {
  const cfgPath = path.join(projectPath, 'server.cfg');
  if (!fs.existsSync(cfgPath)) return null;

  try {
    const content = fs.readFileSync(cfgPath, 'utf8');
    const lines = content.split('\n');
    const ensured = [];
    const settings = {};

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed) continue;

      // ensure/start/restart directives
      const ensureMatch = trimmed.match(/^(?:ensure|start|restart)\s+(\S+)/);
      if (ensureMatch) {
        ensured.push(ensureMatch[1]);
        continue;
      }

      // set directives
      const setMatch = trimmed.match(/^set[sv]?\s+(\S+)\s+["']?([^"'\r\n]*)["']?/);
      if (setMatch) {
        settings[setMatch[1]] = setMatch[2].trim();
        continue;
      }
    }

    return { ensured, settings, raw: content };
  } catch (e) {
    return { error: e.message };
  }
}

// -- Trigger files (async control) -------------------------------------------

function writeTrigger(type, data) {
  const triggerDir = path.join(getDataDir(), 'fivem', 'triggers');
  if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });

  const triggerFile = path.join(triggerDir, `${type}_${Date.now()}.json`);
  fs.writeFileSync(triggerFile, JSON.stringify({
    type,
    ...data,
    source: 'mcp',
    timestamp: new Date().toISOString(),
  }), 'utf8');
  return triggerFile;
}

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'fivem_list_resources',
    description: 'List all FiveM resources in a project. Scans the resources/ directory for fxmanifest.lua files and shows which are ensured in server.cfg.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'FiveM project name or ID' },
      },
      required: ['project'],
    },
  },
  {
    name: 'fivem_read_manifest',
    description: 'Read and parse a FiveM resource manifest (fxmanifest.lua). Returns parsed fields (fx_version, scripts, dependencies) and raw content.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'FiveM project name or ID' },
        resource: { type: 'string', description: 'Resource name (folder name in resources/)' },
      },
      required: ['project', 'resource'],
    },
  },
  {
    name: 'fivem_server_cfg',
    description: 'Read and analyze server.cfg of a FiveM project. Returns ensured resources, server settings (hostname, tags, etc.), and raw content.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'FiveM project name or ID' },
      },
      required: ['project'],
    },
  },
  {
    name: 'fivem_start',
    description: 'Start a FiveM server for a project. Triggers the server start asynchronously in Claude Terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'FiveM project name or ID' },
      },
      required: ['project'],
    },
  },
  {
    name: 'fivem_stop',
    description: 'Stop a running FiveM server for a project. Sends a graceful quit command.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'FiveM project name or ID' },
      },
      required: ['project'],
    },
  },
  {
    name: 'fivem_command',
    description: 'Send a command to a running FiveM server console (e.g., "ensure myresource", "restart myresource", "refresh").',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'FiveM project name or ID' },
        command: { type: 'string', description: 'Command to send to the FiveM server console' },
      },
      required: ['project', 'command'],
    },
  },
  {
    name: 'fivem_ensure',
    description: 'Ensure (start/restart) a FiveM resource on the running server. Validates that the resource exists in the project before sending the ensure command.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'FiveM project name or ID' },
        resource: { type: 'string', description: 'Resource name to ensure' },
      },
      required: ['project', 'resource'],
    },
  },
  {
    name: 'fivem_resource_files',
    description: 'List files in a FiveM resource directory. Useful to see the structure of a resource (client/, server/, shared/ scripts, config files, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'FiveM project name or ID' },
        resource: { type: 'string', description: 'Resource name' },
      },
      required: ['project', 'resource'],
    },
  },
];

// -- Tool handler -------------------------------------------------------------

async function handle(name, args) {
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  try {
    // ── fivem_list_resources ──
    if (name === 'fivem_list_resources') {
      if (!args.project) return fail('Missing required parameter: project');
      const p = findFivemProject(args.project);
      if (!p) {
        const fiveMs = listFivemProjects();
        if (!fiveMs.length) return fail('No FiveM projects found. Make sure a project has type "fivem".');
        return fail(`FiveM project "${args.project}" not found. Available: ${fiveMs.map(p => p.name || path.basename(p.path)).join(', ')}`);
      }
      if (!p.path || !fs.existsSync(p.path)) return fail(`Project path not found: ${p.path}`);

      const resources = scanResources(p.path);
      const cfg = parseServerCfg(p.path);
      const ensuredSet = new Set(cfg ? cfg.ensured : []);

      if (!resources.length) return ok(`No resources found in ${p.name || path.basename(p.path)}/resources/`);

      // Mark ensured status
      const lines = resources.map(r => {
        const ensured = ensuredSet.has(r.name);
        const status = ensured ? '[ensured]' : '[not ensured]';
        const cat = r.category !== 'root' ? ` (${r.category})` : '';
        return `  ${ensured ? '●' : '○'} ${r.name}${cat} ${status} — ${r.manifest}`;
      });

      const ensuredCount = resources.filter(r => ensuredSet.has(r.name)).length;
      return ok(
        `FiveM Resources for ${p.name || path.basename(p.path)} (${resources.length} total, ${ensuredCount} ensured):\n\n${lines.join('\n')}`
      );
    }

    // ── fivem_read_manifest ──
    if (name === 'fivem_read_manifest') {
      if (!args.project) return fail('Missing required parameter: project');
      if (!args.resource) return fail('Missing required parameter: resource');

      const p = findFivemProject(args.project);
      if (!p) return fail(`FiveM project "${args.project}" not found.`);

      // Find resource
      const resources = scanResources(p.path);
      const res = resources.find(r => r.name.toLowerCase() === args.resource.toLowerCase());
      if (!res) return fail(`Resource "${args.resource}" not found. Use fivem_list_resources to see available resources.`);

      const manifestPath = path.join(res.path, res.manifest);
      const { raw, parsed, error } = parseManifest(manifestPath);
      if (error) return fail(`Error reading manifest: ${error}`);

      let output = `# ${res.name} — ${res.manifest}\n\n`;

      if (parsed) {
        if (parsed.fx_version) output += `fx_version: ${parsed.fx_version}\n`;
        if (parsed.game) output += `game: ${parsed.game}\n`;
        if (parsed.name) output += `name: ${parsed.name}\n`;
        if (parsed.author) output += `author: ${parsed.author}\n`;
        if (parsed.version) output += `version: ${parsed.version}\n`;
        if (parsed.description) output += `description: ${parsed.description}\n`;
        if (parsed.client_scripts?.length) output += `\nclient_scripts: ${parsed.client_scripts.join(', ')}\n`;
        if (parsed.server_scripts?.length) output += `server_scripts: ${parsed.server_scripts.join(', ')}\n`;
        if (parsed.shared_scripts?.length) output += `shared_scripts: ${parsed.shared_scripts.join(', ')}\n`;
        if (parsed.dependencies?.length) output += `dependencies: ${parsed.dependencies.join(', ')}\n`;
      }

      output += `\n───── Raw manifest ─────\n${raw}`;
      return ok(output);
    }

    // ── fivem_server_cfg ──
    if (name === 'fivem_server_cfg') {
      if (!args.project) return fail('Missing required parameter: project');

      const p = findFivemProject(args.project);
      if (!p) return fail(`FiveM project "${args.project}" not found.`);

      const cfg = parseServerCfg(p.path);
      if (!cfg) return fail(`No server.cfg found in ${p.path}`);
      if (cfg.error) return fail(`Error reading server.cfg: ${cfg.error}`);

      let output = `# server.cfg — ${p.name || path.basename(p.path)}\n\n`;

      // Ensured resources
      output += `## Ensured resources (${cfg.ensured.length})\n`;
      if (cfg.ensured.length) {
        output += cfg.ensured.map(r => `  ● ${r}`).join('\n') + '\n';
      } else {
        output += '  (none)\n';
      }

      // Settings
      const settingKeys = Object.keys(cfg.settings);
      if (settingKeys.length) {
        output += `\n## Server settings (${settingKeys.length})\n`;
        for (const [key, val] of Object.entries(cfg.settings)) {
          output += `  ${key}: ${val}\n`;
        }
      }

      output += `\n───── Raw server.cfg ─────\n${cfg.raw}`;
      return ok(output);
    }

    // ── fivem_start ──
    if (name === 'fivem_start') {
      if (!args.project) return fail('Missing required parameter: project');

      const p = findFivemProject(args.project);
      if (!p) return fail(`FiveM project "${args.project}" not found.`);

      writeTrigger('start', { projectId: p.id, projectPath: p.path });
      return ok(`FiveM server start triggered for "${p.name || path.basename(p.path)}". The server will start in Claude Terminal.`);
    }

    // ── fivem_stop ──
    if (name === 'fivem_stop') {
      if (!args.project) return fail('Missing required parameter: project');

      const p = findFivemProject(args.project);
      if (!p) return fail(`FiveM project "${args.project}" not found.`);

      writeTrigger('stop', { projectId: p.id });
      return ok(`FiveM server stop triggered for "${p.name || path.basename(p.path)}". The server will stop in Claude Terminal.`);
    }

    // ── fivem_command ──
    if (name === 'fivem_command') {
      if (!args.project) return fail('Missing required parameter: project');
      if (!args.command) return fail('Missing required parameter: command');

      const p = findFivemProject(args.project);
      if (!p) return fail(`FiveM project "${args.project}" not found.`);

      writeTrigger('command', { projectId: p.id, command: args.command });
      return ok(`Command "${args.command}" sent to FiveM server for "${p.name || path.basename(p.path)}".`);
    }

    // ── fivem_ensure ──
    if (name === 'fivem_ensure') {
      if (!args.project) return fail('Missing required parameter: project');
      if (!args.resource) return fail('Missing required parameter: resource');

      const p = findFivemProject(args.project);
      if (!p) return fail(`FiveM project "${args.project}" not found.`);
      if (!p.path || !fs.existsSync(p.path)) return fail(`Project path not found: ${p.path}`);

      // Verify resource exists on disk
      const resources = scanResources(p.path);
      const res = resources.find(r => r.name.toLowerCase() === args.resource.toLowerCase());
      if (!res) {
        const available = resources.map(r => r.name).slice(0, 20).join(', ');
        return fail(`Resource "${args.resource}" not found in project. Available: ${available || 'none'}`);
      }

      writeTrigger('command', { projectId: p.id, command: `ensure ${res.name}` });
      return ok(`Ensured resource "${res.name}" on FiveM server for "${p.name || path.basename(p.path)}".`);
    }

    // ── fivem_resource_files ──
    if (name === 'fivem_resource_files') {
      if (!args.project) return fail('Missing required parameter: project');
      if (!args.resource) return fail('Missing required parameter: resource');

      const p = findFivemProject(args.project);
      if (!p) return fail(`FiveM project "${args.project}" not found.`);

      const resources = scanResources(p.path);
      const res = resources.find(r => r.name.toLowerCase() === args.resource.toLowerCase());
      if (!res) return fail(`Resource "${args.resource}" not found.`);

      const files = [];
      function listDir(dir, prefix = '') {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              files.push(`📁 ${rel}/`);
              listDir(path.join(dir, entry.name), rel);
            } else {
              const stat = fs.statSync(path.join(dir, entry.name));
              const size = stat.size < 1024 ? `${stat.size}B` : `${(stat.size / 1024).toFixed(1)}KB`;
              files.push(`   ${rel} (${size})`);
            }
          }
        } catch (_) {}
      }

      listDir(res.path);
      if (!files.length) return ok(`Resource "${res.name}" is empty.`);

      return ok(`Files in ${res.name}/ (${files.length}):\n\n${files.join('\n')}`);
    }

    return fail(`Unknown FiveM tool: ${name}`);
  } catch (error) {
    log(`Error in ${name}:`, error.message);
    return fail(`FiveM error: ${error.message}`);
  }
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {}

// -- Exports ------------------------------------------------------------------

module.exports = { tools, handle, cleanup };
