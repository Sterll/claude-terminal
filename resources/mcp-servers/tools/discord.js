'use strict';

/**
 * Discord Tools Module for Claude Terminal MCP
 *
 * Provides Discord bot project tools: command scanning, library detection,
 * bot status checking.
 *
 * Only relevant for projects with type === 'discord'.
 */

const fs = require('fs');
const path = require('path');
const { loadProjects } = require('./_projectsCache');

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:discord] ${args.join(' ')}\n`);
}

// -- Data access --------------------------------------------------------------

function findDiscordProject(nameOrId) {
  const data = loadProjects();
  return data.projects.find(p =>
    (p.type === 'discord') && (
      p.id === nameOrId ||
      (p.name || '').toLowerCase() === nameOrId.toLowerCase() ||
      path.basename(p.path || '').toLowerCase() === nameOrId.toLowerCase()
    )
  );
}

function resolveProjectPath(nameOrId) {
  // Try current project path first
  const currentPath = process.env.CT_PROJECT_PATH;
  if (!nameOrId && currentPath) return currentPath;

  const project = findDiscordProject(nameOrId);
  if (project) return project.path;

  // Fallback to current project
  return currentPath || null;
}

// -- Library detection --------------------------------------------------------

const JS_LIBS = {
  'discord.js': 'discord.js',
  'eris': 'Eris',
  'oceanic.js': 'Oceanic.js',
  'discordeno': 'Discordeno'
};

const PY_LIBS = {
  'discord.py': 'discord.py',
  'discord': 'discord.py',
  'py-cord': 'Pycord',
  'nextcord': 'Nextcord',
  'disnake': 'Disnake',
  'hikari': 'Hikari'
};

function detectLibrary(projectPath) {
  // Node.js
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [dep, name] of Object.entries(JS_LIBS)) {
        if (deps[dep]) return { name, lang: 'js', version: deps[dep] };
      }
    }
  } catch (e) {}

  // Python
  try {
    const reqPath = path.join(projectPath, 'requirements.txt');
    if (fs.existsSync(reqPath)) {
      const content = fs.readFileSync(reqPath, 'utf8');
      for (const [dep, name] of Object.entries(PY_LIBS)) {
        if (content.includes(dep)) return { name, lang: 'py' };
      }
    }
  } catch (e) {}

  return null;
}

// -- Command scanning ---------------------------------------------------------

function scanCommands(projectPath) {
  const lib = detectLibrary(projectPath);
  if (!lib) return [];

  const extensions = lib.lang === 'py' ? ['.py'] : ['.js', '.ts', '.mjs'];
  const files = getSourceFiles(projectPath, extensions);
  const commands = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const relPath = path.relative(projectPath, file);

      if (lib.lang === 'js') {
        // SlashCommandBuilder
        const builderRe = /new\s+SlashCommandBuilder\(\)\s*\.setName\(['"`]([^'"`]+)['"`]\)(?:\s*\.setDescription\(['"`]([^'"`]+)['"`]\))?/g;
        let m;
        while ((m = builderRe.exec(content)) !== null) {
          commands.push({ name: m[1], description: m[2] || '', file: relPath, type: 'slash' });
        }

        // Object literal
        const objRe = /(?:name|data)\s*:\s*['"`]([^'"`]+)['"`]\s*,\s*description\s*:\s*['"`]([^'"`]+)['"`]/g;
        while ((m = objRe.exec(content)) !== null) {
          if (!commands.find(c => c.name === m[1])) {
            commands.push({ name: m[1], description: m[2], file: relPath, type: 'slash' });
          }
        }

        // Eris registerCommand
        const erisRe = /\.registerCommand\(['"`]([^'"`]+)['"`]/g;
        while ((m = erisRe.exec(content)) !== null) {
          commands.push({ name: m[1], description: '', file: relPath, type: 'prefix' });
        }
      } else {
        // Python patterns
        const pyPatterns = [
          /@(?:\w+\.)?(?:slash_)?command\(\s*(?:name\s*=\s*)?['"]([^'"]+)['"]/g,
          /@(?:\w+\.)?tree\.command\(\s*(?:name\s*=\s*)?['"]([^'"]+)['"]/g
        ];
        for (const pattern of pyPatterns) {
          let m;
          while ((m = pattern.exec(content)) !== null) {
            if (!commands.find(c => c.name === m[1])) {
              commands.push({ name: m[1], description: '', file: relPath, type: 'slash' });
            }
          }
        }
      }
    } catch (e) {}
  }

  return commands;
}

function getSourceFiles(dir, extensions, depth = 0) {
  if (depth > 4) return [];
  const files = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === 'venv') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...getSourceFiles(full, extensions, depth + 1));
      } else if (extensions.some(ext => entry.name.endsWith(ext))) {
        files.push(full);
      }
    }
  } catch (e) {}
  return files;
}

// -- Tools definition ---------------------------------------------------------

const tools = [
  {
    name: 'discord_list_commands',
    description: 'Scan a Discord bot project for slash commands and prefix commands. Returns command names, descriptions, types, and file locations.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name, ID, or folder name. Defaults to current project.'
        }
      }
    }
  },
  {
    name: 'discord_bot_status',
    description: 'Get Discord bot project info: detected library, language, version, and command count.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name, ID, or folder name. Defaults to current project.'
        }
      }
    }
  }
];

// -- Handler ------------------------------------------------------------------

async function handle(toolName, args) {
  try {
    switch (toolName) {
      case 'discord_list_commands': {
        const projectPath = resolveProjectPath(args.project);
        if (!projectPath) {
          return { content: [{ type: 'text', text: 'No Discord project found.' }], isError: true };
        }

        const commands = scanCommands(projectPath);
        if (!commands.length) {
          return {
            content: [{ type: 'text', text: `No commands detected in ${path.basename(projectPath)}.\n\nSupported patterns:\n- discord.js: SlashCommandBuilder, object literals\n- Eris: registerCommand()\n- discord.py: @command(), @tree.command()` }]
          };
        }

        const lines = commands.map(c =>
          `/${c.name}${c.description ? ` — ${c.description}` : ''} [${c.type}] (${c.file})`
        );

        return {
          content: [{ type: 'text', text: `${commands.length} command(s) found in ${path.basename(projectPath)}:\n\n${lines.join('\n')}` }]
        };
      }

      case 'discord_bot_status': {
        const projectPath = resolveProjectPath(args.project);
        if (!projectPath) {
          return { content: [{ type: 'text', text: 'No Discord project found.' }], isError: true };
        }

        const lib = detectLibrary(projectPath);
        const commands = scanCommands(projectPath);

        const info = [];
        info.push(`Project: ${path.basename(projectPath)}`);
        if (lib) {
          info.push(`Library: ${lib.name}${lib.version ? ` (${lib.version})` : ''}`);
          info.push(`Language: ${lib.lang === 'py' ? 'Python' : 'JavaScript'}`);
        } else {
          info.push('Library: Not detected');
        }
        info.push(`Commands: ${commands.length}`);

        return { content: [{ type: 'text', text: info.join('\n') }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }], isError: true };
    }
  } catch (e) {
    log('Error in handle:', e.message);
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {
  // Nothing to clean up
}

module.exports = { tools, handle, cleanup };
