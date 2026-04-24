'use strict';

/**
 * Projects Tools Module for Claude Terminal MCP
 *
 * Provides project listing, info, CRUD, stats, and quick action tools.
 * Reads/writes CT_DATA_DIR/projects.json with atomic writes.
 */

const fs = require('fs');
const path = require('path');

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:projects] ${args.join(' ')}\n`);
}

// -- Data access --------------------------------------------------------------

function getDataDir() {
  return process.env.CT_DATA_DIR || '';
}

function loadProjects() {
  const file = path.join(getDataDir(), 'projects.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log('Error reading projects.json:', e.message);
  }
  return { projects: [], folders: [], rootOrder: [] };
}

function saveProjects(data) {
  const file = path.join(getDataDir(), 'projects.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function notifyQuickActionChanged(projectId, mutation, actionName) {
  const triggerDir = path.join(getDataDir(), 'quickactions', 'triggers');
  if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });
  const triggerFile = path.join(triggerDir, `changed_${Date.now()}.json`);
  fs.writeFileSync(triggerFile, JSON.stringify({
    type: 'changed',
    projectId,
    mutation,
    actionName,
    timestamp: new Date().toISOString(),
  }), 'utf8');
}

function findProject(nameOrId) {
  const data = loadProjects();
  return data.projects.find(p =>
    p.id === nameOrId ||
    (p.name || '').toLowerCase() === nameOrId.toLowerCase() ||
    path.basename(p.path || '').toLowerCase() === nameOrId.toLowerCase()
  );
}

function findProjectInData(data, nameOrId) {
  return data.projects.find(p =>
    p.id === nameOrId ||
    (p.name || '').toLowerCase() === nameOrId.toLowerCase() ||
    path.basename(p.path || '').toLowerCase() === nameOrId.toLowerCase()
  );
}

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'project_list',
    description: 'List all projects configured in Claude Terminal with their type, path, and folder organization.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional name filter (case-insensitive substring match)' },
      },
    },
  },
  {
    name: 'project_info',
    description: 'Get detailed info about a specific project: path, type, quick actions, editor, color/icon customization.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name, folder name, or ID' },
      },
      required: ['project'],
    },
  },
  {
    name: 'project_todos',
    description: 'Scan a project directory for TODO, FIXME, HACK, and XXX comments in source files.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID' },
        pattern: { type: 'string', description: 'Comment pattern to search for (default: TODO|FIXME|HACK|XXX)' },
      },
      required: ['project'],
    },
  },
  {
    name: 'quickaction_list',
    description: 'List quick actions configured for a project. Quick actions are shell commands (build, test, dev, etc.) that can be run in a terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID' },
      },
      required: ['project'],
    },
  },
  {
    name: 'quickaction_run',
    description: 'Trigger a quick action on a project. Opens a terminal in Claude Terminal and runs the command. The action executes asynchronously.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID' },
        action: { type: 'string', description: 'Quick action name or ID' },
      },
      required: ['project', 'action'],
    },
  },
  {
    name: 'quickaction_add',
    description: 'Add a new quick action to a project. Quick actions are shell commands that can be triggered from the UI or via MCP.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID' },
        name:    { type: 'string', description: 'Display name for the action (e.g. "Build", "Dev Server")' },
        command: { type: 'string', description: 'Shell command to execute (e.g. "npm run build"). Supports variables: $PROJECT_PATH, $PROJECT_NAME, $BRANCH, $HOME' },
        icon:    { type: 'string', enum: ['play', 'build', 'test', 'code', 'refresh', 'download', 'upload', 'package', 'terminal', 'server', 'database', 'zap', 'settings', 'git', 'clean'], description: 'Icon for the action (default: play)' },
        pinned:  { type: 'boolean', description: 'Pin this action to the project card for quick access (max 3 pinned)' },
      },
      required: ['project', 'name', 'command'],
    },
  },
  {
    name: 'quickaction_update',
    description: 'Update an existing quick action on a project. Change its name, command, icon, or pinned state.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID' },
        action:  { type: 'string', description: 'Quick action name or ID to update' },
        name:    { type: 'string', description: 'New display name' },
        command: { type: 'string', description: 'New shell command' },
        icon:    { type: 'string', enum: ['play', 'build', 'test', 'code', 'refresh', 'download', 'upload', 'package', 'terminal', 'server', 'database', 'zap', 'settings', 'git', 'clean'], description: 'New icon' },
        pinned:  { type: 'boolean', description: 'Pin or unpin the action' },
      },
      required: ['project', 'action'],
    },
  },
  {
    name: 'quickaction_delete',
    description: 'Remove a quick action from a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID' },
        action:  { type: 'string', description: 'Quick action name or ID to delete' },
      },
      required: ['project', 'action'],
    },
  },
  {
    name: 'project_create',
    description: 'Add a new project to Claude Terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        path:  { type: 'string', description: 'Absolute path to the project directory' },
        name:  { type: 'string', description: 'Display name (defaults to folder name)' },
        type:  { type: 'string', enum: ['general', 'webapp', 'api', 'fivem', 'minecraft', 'python'], description: 'Project type (default: general)' },
        color: { type: 'string', description: 'Hex color (e.g. #d97706)' },
        icon:  { type: 'string', description: 'Icon name' },
      },
      required: ['path'],
    },
  },
  {
    name: 'project_delete',
    description: 'Remove a project from Claude Terminal. This only removes it from the project list, it does not delete any files.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID' },
      },
      required: ['project'],
    },
  },
  {
    name: 'project_update',
    description: 'Update project settings in Claude Terminal (name, color, icon, type, editor).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID' },
        name:    { type: 'string', description: 'New display name' },
        color:   { type: 'string', description: 'Hex color (e.g. #d97706)' },
        icon:    { type: 'string', description: 'Icon name' },
        type:    { type: 'string', enum: ['general', 'webapp', 'api', 'fivem', 'minecraft', 'python'], description: 'Project type' },
        editor:  { type: 'string', description: 'Preferred code editor (e.g. code, cursor)' },
      },
      required: ['project'],
    },
  },
  {
    name: 'project_stats',
    description: 'Get project statistics: lines of code per language, file count, directory size.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID' },
      },
      required: ['project'],
    },
  },
  {
    name: 'project_open',
    description: 'Open a project in the configured code editor (VS Code, Cursor, etc.) via Claude Terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID' },
      },
      required: ['project'],
    },
  },
];

// -- TODO scanner -------------------------------------------------------------

const SCAN_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.py', '.lua', '.go', '.rs', '.java',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt',
  '.sh', '.bash', '.zsh', '.css', '.scss', '.html', '.vue', '.svelte',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__',
  'vendor', 'target', '.cache', 'coverage', '.vscode', '.idea',
]);

function scanTodos(dir, pattern, results, depth = 0) {
  if (depth > 8 || results.length >= 100) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= 100) break;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          scanTodos(path.join(dir, entry.name), pattern, results, depth + 1);
        }
      } else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) {
        try {
          const content = fs.readFileSync(path.join(dir, entry.name), 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(pattern);
            if (match) {
              const rel = path.relative(dir, path.join(dir, entry.name)).replace(/\\/g, '/');
              const comment = lines[i].trim().slice(0, 120);
              results.push({ file: rel, line: i + 1, text: comment });
              if (results.length >= 100) break;
            }
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
}

// -- Stats scanner ------------------------------------------------------------

const LANG_MAP = {
  '.js':      'JavaScript',
  '.jsx':     'JavaScript',
  '.ts':      'TypeScript',
  '.tsx':     'TypeScript',
  '.py':      'Python',
  '.lua':     'Lua',
  '.go':      'Go',
  '.rs':      'Rust',
  '.java':    'Java',
  '.cs':      'C#',
  '.rb':      'Ruby',
  '.php':     'PHP',
  '.css':     'CSS',
  '.scss':    'CSS',
  '.html':    'HTML',
  '.vue':     'Vue',
  '.svelte':  'Svelte',
  '.json':    'JSON',
  '.md':      'Markdown',
  '.c':       'C',
  '.cpp':     'C++',
  '.h':       'C',
  '.hpp':     'C++',
  '.swift':   'Swift',
  '.kt':      'Kotlin',
  '.sh':      'Shell',
  '.bash':    'Shell',
  '.zsh':     'Shell',
  '.yaml':    'YAML',
  '.yml':     'YAML',
  '.toml':    'TOML',
  '.xml':     'XML',
  '.sql':     'SQL',
  '.r':       'R',
  '.dart':    'Dart',
  '.ex':      'Elixir',
  '.exs':     'Elixir',
};

const STATS_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__',
  'vendor', 'target', '.cache', 'coverage', '.vscode', '.idea', '.svn',
  '.hg', 'bower_components', '.parcel-cache', '.turbo', '.nuxt',
]);

function scanStats(dir, stats, depth = 0) {
  if (depth > 5 || stats.fileCount >= 5000) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (stats.fileCount >= 5000) break;
      if (entry.isDirectory()) {
        if (!STATS_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          scanStats(path.join(dir, entry.name), stats, depth + 1);
        }
      } else if (entry.isFile()) {
        stats.fileCount++;
        const ext = path.extname(entry.name).toLowerCase();
        const lang = LANG_MAP[ext];
        if (lang) {
          try {
            const filePath = path.join(dir, entry.name);
            const fileStat = fs.statSync(filePath);
            // Skip files larger than 1MB to avoid hanging
            if (fileStat.size > 1024 * 1024) {
              if (!stats.languages[lang]) stats.languages[lang] = { files: 0, lines: 0 };
              stats.languages[lang].files++;
              continue;
            }
            const content = fs.readFileSync(filePath, 'utf8');
            const lineCount = content.split('\n').length;
            if (!stats.languages[lang]) stats.languages[lang] = { files: 0, lines: 0 };
            stats.languages[lang].files++;
            stats.languages[lang].lines += lineCount;
            stats.totalLines += lineCount;
          } catch (_) {}
        }
      }
    }
  } catch (_) {}
}

// -- Tool handler -------------------------------------------------------------

async function handle(name, args) {
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  try {
    if (name === 'project_list') {
      const data = loadProjects();
      let projects = data.projects || [];

      if (args.filter) {
        const f = args.filter.toLowerCase();
        projects = projects.filter(p =>
          (p.name || '').toLowerCase().includes(f) ||
          (p.path || '').toLowerCase().includes(f) ||
          (p.type || '').toLowerCase().includes(f)
        );
      }

      if (!projects.length) return ok(args.filter ? `No projects matching "${args.filter}"` : 'No projects configured.');

      // Build folder map
      const folderMap = new Map();
      for (const f of (data.folders || [])) {
        folderMap.set(f.id, f.name);
      }

      const lines = projects.map(p => {
        const parts = [`${p.name || path.basename(p.path || '?')}`];
        parts.push(`  Path: ${p.path || '?'}`);
        parts.push(`  Type: ${p.type || 'standalone'}`);
        if (p.folderId && folderMap.has(p.folderId)) {
          parts.push(`  Folder: ${folderMap.get(p.folderId)}`);
        }
        if (p.quickActions && p.quickActions.length) {
          parts.push(`  Quick actions: ${p.quickActions.map(a => a.name).join(', ')}`);
        }
        return parts.join('\n');
      });

      return ok(`Projects (${projects.length}):\n\n${lines.join('\n\n')}`);
    }

    if (name === 'project_info') {
      if (!args.project) return fail('Missing required parameter: project');
      const p = findProject(args.project);
      if (!p) return fail(`Project "${args.project}" not found. Use project_list to see available projects.`);

      const data = loadProjects();
      const folderMap = new Map();
      for (const f of (data.folders || [])) folderMap.set(f.id, f.name);

      let output = `# ${p.name || path.basename(p.path || '?')}\n`;
      output += `ID: ${p.id}\n`;
      output += `Path: ${p.path || '?'}\n`;
      output += `Type: ${p.type || 'standalone'}\n`;
      if (p.folderId && folderMap.has(p.folderId)) output += `Folder: ${folderMap.get(p.folderId)}\n`;
      if (p.color) output += `Color: ${p.color}\n`;
      if (p.icon) output += `Icon: ${p.icon}\n`;
      if (p.preferredEditor) output += `Editor: ${p.preferredEditor}\n`;

      if (p.quickActions && p.quickActions.length) {
        output += `\n## Quick Actions\n`;
        for (const qa of p.quickActions) {
          output += `  ${qa.name}: ${qa.command}\n`;
        }
      }

      // Check if path exists and show basic stats
      if (p.path && fs.existsSync(p.path)) {
        try {
          const entries = fs.readdirSync(p.path);
          const hasGit = entries.includes('.git');
          const hasPkg = entries.includes('package.json');
          output += `\n## Directory\n`;
          output += `  Files: ${entries.length} items\n`;
          output += `  Git: ${hasGit ? 'yes' : 'no'}\n`;
          if (hasPkg) output += `  package.json: yes\n`;
        } catch (_) {}
      }

      return ok(output);
    }

    if (name === 'project_todos') {
      if (!args.project) return fail('Missing required parameter: project');
      const p = findProject(args.project);
      if (!p) return fail(`Project "${args.project}" not found.`);
      if (!p.path || !fs.existsSync(p.path)) return fail(`Project path not found: ${p.path}`);

      const patternStr = args.pattern || 'TODO|FIXME|HACK|XXX';
      // Validate regex to prevent ReDoS from user-provided patterns
      let regex;
      try {
        regex = new RegExp(`\\b(${patternStr})\\b`, 'i');
        // Quick sanity test to catch catastrophic backtracking
        const testStart = Date.now();
        regex.test('a'.repeat(100));
        if (Date.now() - testStart > 50) return fail('Pattern too expensive — simplify the regex.');
      } catch (e) {
        return fail(`Invalid regex pattern: ${e.message}`);
      }
      const results = [];
      scanTodos(p.path, regex, results);

      if (!results.length) return ok(`No ${patternStr} comments found in ${p.name || path.basename(p.path)}.`);

      const lines = results.map(r => `${r.file}:${r.line} — ${r.text}`);
      return ok(`Found ${results.length} comments in ${p.name || path.basename(p.path)}:\n\n${lines.join('\n')}`);
    }

    if (name === 'quickaction_list') {
      if (!args.project) return fail('Missing required parameter: project');
      const p = findProject(args.project);
      if (!p) return fail(`Project "${args.project}" not found. Use project_list to see available projects.`);

      const actions = p.quickActions || [];
      if (!actions.length) return ok(`No quick actions configured for ${p.name || path.basename(p.path || '?')}. Configure them in Claude Terminal.`);

      let output = `Quick actions for ${p.name || path.basename(p.path || '?')} (${actions.length}):\n`;
      output += `${'─'.repeat(40)}\n`;
      for (const a of actions) {
        output += `  ${a.name} [${a.icon || 'play'}]\n    ${a.command}\n`;
      }
      return ok(output);
    }

    if (name === 'quickaction_run') {
      if (!args.project) return fail('Missing required parameter: project');
      if (!args.action) return fail('Missing required parameter: action');

      const p = findProject(args.project);
      if (!p) return fail(`Project "${args.project}" not found.`);

      const actions = p.quickActions || [];
      const action = actions.find(a =>
        a.id === args.action ||
        a.name.toLowerCase() === args.action.toLowerCase()
      );
      if (!action) {
        const available = actions.map(a => a.name).join(', ');
        return fail(`Action "${args.action}" not found. Available: ${available || 'none'}`);
      }

      // Write trigger file for the app to pick up
      const triggerDir = path.join(getDataDir(), 'quickactions', 'triggers');
      if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });

      const triggerFile = path.join(triggerDir, `${action.id}_${Date.now()}.json`);
      fs.writeFileSync(triggerFile, JSON.stringify({
        projectId: p.id,
        actionId: action.id,
        actionName: action.name,
        command: action.command,
        source: 'mcp',
        timestamp: new Date().toISOString(),
      }), 'utf8');

      return ok(`Quick action "${action.name}" triggered on ${p.name || path.basename(p.path || '?')}. Command: ${action.command}`);
    }

    // ── quickaction_add ──────────────────────────────────────────────────
    if (name === 'quickaction_add') {
      if (!args.project) return fail('Missing required parameter: project');
      if (!args.name) return fail('Missing required parameter: name');
      if (!args.command) return fail('Missing required parameter: command');

      const data = loadProjects();
      const p = findProjectInData(data, args.project);
      if (!p) return fail(`Project "${args.project}" not found. Use project_list to see available projects.`);

      if (!p.quickActions) p.quickActions = [];

      const duplicate = p.quickActions.find(a => a.name.toLowerCase() === args.name.toLowerCase());
      if (duplicate) return fail(`Quick action "${args.name}" already exists on this project.`);

      const validIcons = ['play', 'build', 'test', 'code', 'refresh', 'download', 'upload', 'package', 'terminal', 'server', 'database', 'zap', 'settings', 'git', 'clean'];
      const icon = args.icon && validIcons.includes(args.icon) ? args.icon : 'play';

      const newAction = {
        id: generateId('qa'),
        name: args.name.trim(),
        command: args.command.trim(),
        icon,
      };

      if (args.pinned) {
        const pinnedCount = p.quickActions.filter(a => a.pinned).length;
        if (pinnedCount >= 3) return fail('Maximum 3 pinned actions allowed. Unpin another action first.');
        newAction.pinned = true;
      }

      p.quickActions.push(newAction);
      saveProjects(data);
      notifyQuickActionChanged(p.id, 'add', newAction.name);

      const projectName = p.name || path.basename(p.path || '?');
      return ok(`Quick action added to "${projectName}":\n  Name: ${newAction.name}\n  Command: ${newAction.command}\n  Icon: ${newAction.icon}${newAction.pinned ? '\n  Pinned: yes' : ''}\n  ID: ${newAction.id}`);
    }

    // ── quickaction_update ───────────────────────────────────────────────
    if (name === 'quickaction_update') {
      if (!args.project) return fail('Missing required parameter: project');
      if (!args.action) return fail('Missing required parameter: action');

      const data = loadProjects();
      const p = findProjectInData(data, args.project);
      if (!p) return fail(`Project "${args.project}" not found. Use project_list to see available projects.`);

      const actions = p.quickActions || [];
      const action = actions.find(a =>
        a.id === args.action ||
        a.name.toLowerCase() === args.action.toLowerCase()
      );
      if (!action) {
        const available = actions.map(a => a.name).join(', ');
        return fail(`Action "${args.action}" not found. Available: ${available || 'none'}`);
      }

      const updates = [];

      if (args.name !== undefined) {
        const dup = actions.find(a => a.id !== action.id && a.name.toLowerCase() === args.name.toLowerCase());
        if (dup) return fail(`Another action named "${args.name}" already exists.`);
        action.name = args.name.trim();
        updates.push(`name → "${action.name}"`);
      }
      if (args.command !== undefined) {
        action.command = args.command.trim();
        updates.push(`command → "${action.command}"`);
      }
      if (args.icon !== undefined) {
        const validIcons = ['play', 'build', 'test', 'code', 'refresh', 'download', 'upload', 'package', 'terminal', 'server', 'database', 'zap', 'settings', 'git', 'clean'];
        if (!validIcons.includes(args.icon)) return fail(`Invalid icon "${args.icon}". Valid: ${validIcons.join(', ')}`);
        action.icon = args.icon;
        updates.push(`icon → ${action.icon}`);
      }
      if (args.pinned !== undefined) {
        if (args.pinned && !action.pinned) {
          const pinnedCount = actions.filter(a => a.pinned).length;
          if (pinnedCount >= 3) return fail('Maximum 3 pinned actions. Unpin another action first.');
        }
        action.pinned = args.pinned;
        updates.push(`pinned → ${action.pinned}`);
      }

      if (!updates.length) return fail('No updates provided. Specify name, command, icon, or pinned.');

      saveProjects(data);
      notifyQuickActionChanged(p.id, 'update', action.name);

      const projectName = p.name || path.basename(p.path || '?');
      return ok(`Quick action "${action.name}" updated on "${projectName}":\n  ${updates.join('\n  ')}`);
    }

    // ── quickaction_delete ───────────────────────────────────────────────
    if (name === 'quickaction_delete') {
      if (!args.project) return fail('Missing required parameter: project');
      if (!args.action) return fail('Missing required parameter: action');

      const data = loadProjects();
      const p = findProjectInData(data, args.project);
      if (!p) return fail(`Project "${args.project}" not found. Use project_list to see available projects.`);

      const actions = p.quickActions || [];
      const action = actions.find(a =>
        a.id === args.action ||
        a.name.toLowerCase() === args.action.toLowerCase()
      );
      if (!action) {
        const available = actions.map(a => a.name).join(', ');
        return fail(`Action "${args.action}" not found. Available: ${available || 'none'}`);
      }

      const actionName = action.name;
      p.quickActions = actions.filter(a => a.id !== action.id);
      saveProjects(data);
      notifyQuickActionChanged(p.id, 'delete', actionName);

      const projectName = p.name || path.basename(p.path || '?');
      return ok(`Quick action "${actionName}" removed from "${projectName}".`);
    }

    // ── project_create ────────────────────────────────────────────────────
    if (name === 'project_create') {
      if (!args.path) return fail('Missing required parameter: path');

      const projectPath = path.resolve(args.path);
      if (!fs.existsSync(projectPath)) return fail(`Path does not exist: ${projectPath}`);

      const stat = fs.statSync(projectPath);
      if (!stat.isDirectory()) return fail(`Path is not a directory: ${projectPath}`);

      const data = loadProjects();
      const normalizedPath = projectPath.replace(/\\/g, '/');
      const existing = data.projects.find(p =>
        (p.path || '').replace(/\\/g, '/').toLowerCase() === normalizedPath.toLowerCase()
      );
      if (existing) {
        return fail(`Project already exists: "${existing.name || path.basename(existing.path)}" (${existing.path})`);
      }

      const validTypes = ['general', 'webapp', 'api', 'fivem', 'minecraft', 'python'];
      const projectType = args.type && validTypes.includes(args.type) ? args.type : 'general';

      const project = {
        id:              generateId('proj'),
        name:            (args.name || path.basename(projectPath)).trim(),
        path:            projectPath,
        type:            projectType,
        color:           args.color || null,
        icon:            args.icon || null,
        preferredEditor: null,
        quickActions:    [],
        createdAt:       Date.now(),
      };

      if (!data.projects) data.projects = [];
      if (!data.rootOrder) data.rootOrder = [];

      data.projects.push(project);
      data.rootOrder.push(project.id);
      saveProjects(data);

      return ok(`Project created:\n  Name: ${project.name}\n  Path: ${project.path}\n  Type: ${project.type}\n  ID: ${project.id}`);
    }

    // ── project_delete ────────────────────────────────────────────────────
    if (name === 'project_delete') {
      if (!args.project) return fail('Missing required parameter: project');

      const data = loadProjects();
      const p = findProjectInData(data, args.project);
      if (!p) return fail(`Project "${args.project}" not found. Use project_list to see available projects.`);

      const projectName = p.name || path.basename(p.path || '?');
      const projectPath = p.path || '?';

      data.projects = data.projects.filter(proj => proj.id !== p.id);
      data.rootOrder = (data.rootOrder || []).filter(id => id !== p.id);

      // Also remove from any folder children
      for (const folder of (data.folders || [])) {
        if (folder.children) {
          folder.children = folder.children.filter(id => id !== p.id);
        }
      }

      saveProjects(data);

      return ok(`Project removed from Claude Terminal:\n  Name: ${projectName}\n  Path: ${projectPath}\n\nNote: No files were deleted on disk.`);
    }

    // ── project_update ────────────────────────────────────────────────────
    if (name === 'project_update') {
      if (!args.project) return fail('Missing required parameter: project');

      const data = loadProjects();
      const p = findProjectInData(data, args.project);
      if (!p) return fail(`Project "${args.project}" not found. Use project_list to see available projects.`);

      const updates = [];

      if (args.name !== undefined) {
        p.name = args.name.trim();
        updates.push(`name → "${p.name}"`);
      }
      if (args.color !== undefined) {
        p.color = args.color || null;
        updates.push(`color → ${p.color || 'removed'}`);
      }
      if (args.icon !== undefined) {
        p.icon = args.icon || null;
        updates.push(`icon → ${p.icon || 'removed'}`);
      }
      if (args.type !== undefined) {
        const validTypes = ['general', 'webapp', 'api', 'fivem', 'minecraft', 'python'];
        if (!validTypes.includes(args.type)) {
          return fail(`Invalid type "${args.type}". Valid types: ${validTypes.join(', ')}`);
        }
        p.type = args.type;
        updates.push(`type → ${p.type}`);
      }
      if (args.editor !== undefined) {
        p.preferredEditor = args.editor || null;
        updates.push(`editor → ${p.preferredEditor || 'removed'}`);
      }

      if (!updates.length) return fail('No updates provided. Specify name, color, icon, type, or editor.');

      saveProjects(data);

      const projectName = p.name || path.basename(p.path || '?');
      return ok(`Project "${projectName}" updated:\n  ${updates.join('\n  ')}`);
    }

    // ── project_stats ─────────────────────────────────────────────────────
    if (name === 'project_stats') {
      if (!args.project) return fail('Missing required parameter: project');

      const p = findProject(args.project);
      if (!p) return fail(`Project "${args.project}" not found. Use project_list to see available projects.`);
      if (!p.path || !fs.existsSync(p.path)) return fail(`Project path not found: ${p.path}`);

      const stats = { fileCount: 0, totalLines: 0, languages: {} };
      scanStats(p.path, stats);

      const projectName = p.name || path.basename(p.path);

      // Sort languages by lines descending
      const sorted = Object.entries(stats.languages)
        .sort((a, b) => b[1].lines - a[1].lines);

      if (!sorted.length) {
        return ok(`# ${projectName} — Stats\n\nTotal files scanned: ${stats.fileCount}\nNo recognized source files found.`);
      }

      let output = `# ${projectName} — Stats\n\n`;
      output += `Total files scanned: ${stats.fileCount}\n`;
      output += `Total lines of code: ${stats.totalLines.toLocaleString()}\n`;
      output += `Languages detected: ${sorted.length}\n\n`;

      output += `## Lines by Language\n`;
      output += `${'─'.repeat(50)}\n`;

      const maxLangLen = Math.max(...sorted.map(([lang]) => lang.length));
      for (const [lang, data] of sorted) {
        const pct = stats.totalLines > 0 ? ((data.lines / stats.totalLines) * 100).toFixed(1) : '0.0';
        output += `  ${lang.padEnd(maxLangLen)}  ${data.lines.toLocaleString().padStart(8)} lines  ${data.files.toString().padStart(4)} files  (${pct}%)\n`;
      }

      if (stats.fileCount >= 5000) {
        output += `\nNote: Scan was limited to 5000 files. Results may be incomplete.`;
      }

      return ok(output);
    }

    // ── project_open ──────────────────────────────────────────────────────
    if (name === 'project_open') {
      if (!args.project) return fail('Missing required parameter: project');

      const p = findProject(args.project);
      if (!p) return fail(`Project "${args.project}" not found. Use project_list to see available projects.`);

      // Write trigger file for the app to pick up
      const triggerDir = path.join(getDataDir(), 'projects', 'triggers');
      if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });

      const triggerFile = path.join(triggerDir, `open_${Date.now()}.json`);
      fs.writeFileSync(triggerFile, JSON.stringify({
        action: 'open',
        projectId: p.id,
        projectPath: p.path,
        source: 'mcp',
        timestamp: new Date().toISOString(),
      }), 'utf8');

      const projectName = p.name || path.basename(p.path || '?');
      return ok(`Opening project "${projectName}" in editor. Trigger sent to Claude Terminal.`);
    }

    return fail(`Unknown project tool: ${name}`);
  } catch (error) {
    log(`Error in ${name}:`, error.message);
    return fail(`Project error: ${error.message}`);
  }
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {}

// -- Exports ------------------------------------------------------------------

module.exports = { tools, handle, cleanup };
