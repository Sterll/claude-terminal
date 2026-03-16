'use strict';

/**
 * Terminal Tools Module for Claude Terminal MCP
 *
 * Provides terminal management tools: list, create, send commands, read output, close.
 * Communicates with the Electron app via trigger files in CT_DATA_DIR/terminals/triggers/.
 */

const fs = require('fs');
const path = require('path');

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:terminal] ${args.join(' ')}\n`);
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

function findProject(nameOrId) {
  const data = loadProjects();
  return data.projects.find(p =>
    p.id === nameOrId ||
    (p.name || '').toLowerCase() === nameOrId.toLowerCase() ||
    path.basename(p.path || '').toLowerCase() === nameOrId.toLowerCase()
  );
}

function loadTerminals() {
  const file = path.join(getDataDir(), 'terminals.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log('Error reading terminals.json:', e.message);
  }
  return [];
}

function writeTrigger(action, payload) {
  const triggerDir = path.join(getDataDir(), 'terminals', 'triggers');
  if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });

  const triggerFile = path.join(triggerDir, `${action}_${Date.now()}.json`);
  fs.writeFileSync(triggerFile, JSON.stringify({
    action,
    ...payload,
    source: 'mcp',
    timestamp: new Date().toISOString(),
  }), 'utf8');

  return triggerFile;
}

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'terminal_list',
    description: 'List active terminals in Claude Terminal. Shows terminal ID, project, mode (terminal/chat), and status.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Optional filter by project name or ID' },
      },
    },
  },
  {
    name: 'terminal_create',
    description: 'Open a new terminal tab in Claude Terminal for a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID' },
        mode: { type: 'string', enum: ['terminal', 'chat'], description: 'Terminal mode (default: terminal)' },
      },
      required: ['project'],
    },
  },
  {
    name: 'terminal_send_command',
    description: 'Send a command to a running terminal in Claude Terminal. The command is typed into the active terminal of the specified project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID' },
        command: { type: 'string', description: 'Command to send to the terminal' },
      },
      required: ['project', 'command'],
    },
  },
  {
    name: 'terminal_read_output',
    description: 'Read recent output from a terminal in Claude Terminal. Returns the last N lines of terminal output.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID' },
        lines: { type: 'number', description: 'Number of lines to return (default: 50, max: 200)' },
      },
      required: ['project'],
    },
  },
  {
    name: 'terminal_close',
    description: 'Close a terminal tab in Claude Terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID' },
        terminalId: { type: 'string', description: 'Terminal ID to close (if not provided, closes the active terminal)' },
      },
      required: ['project'],
    },
  },
];

// -- Tool handler -------------------------------------------------------------

async function handle(name, args) {
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  try {
    if (name === 'terminal_list') {
      let terminals = loadTerminals();

      if (args.project) {
        const p = findProject(args.project);
        if (!p) return fail(`Project "${args.project}" not found. Use project_list to see available projects.`);
        terminals = terminals.filter(t =>
          t.projectId === p.id ||
          (t.projectName || '').toLowerCase() === (p.name || '').toLowerCase()
        );
      }

      if (!terminals.length) {
        return ok(args.project
          ? `No active terminals for project "${args.project}".`
          : 'No active terminals.');
      }

      const lines = terminals.map(t => {
        const parts = [`Terminal ${t.id || '?'}`];
        parts.push(`  Project: ${t.projectName || '?'}`);
        parts.push(`  Mode: ${t.mode || 'terminal'}`);
        if (t.pid) parts.push(`  PID: ${t.pid}`);
        if (t.started) parts.push(`  Started: ${t.started}`);
        return parts.join('\n');
      });

      return ok(`Active terminals (${terminals.length}):\n\n${lines.join('\n\n')}`);
    }

    if (name === 'terminal_create') {
      if (!args.project) return fail('Missing required parameter: project');

      const p = findProject(args.project);
      if (!p) return fail(`Project "${args.project}" not found. Use project_list to see available projects.`);

      const mode = args.mode || 'terminal';
      if (mode !== 'terminal' && mode !== 'chat') {
        return fail(`Invalid mode "${mode}". Must be "terminal" or "chat".`);
      }

      writeTrigger('create', {
        projectId: p.id,
        projectName: p.name || path.basename(p.path || ''),
        projectPath: p.path,
        mode,
      });

      return ok(`Terminal creation triggered for "${p.name || path.basename(p.path || '?')}" in ${mode} mode.`);
    }

    if (name === 'terminal_send_command') {
      if (!args.project) return fail('Missing required parameter: project');
      if (!args.command) return fail('Missing required parameter: command');

      const p = findProject(args.project);
      if (!p) return fail(`Project "${args.project}" not found. Use project_list to see available projects.`);

      writeTrigger('send', {
        projectId: p.id,
        projectName: p.name || path.basename(p.path || ''),
        command: args.command,
      });

      return ok(`Command sent to terminal of "${p.name || path.basename(p.path || '?')}": ${args.command}`);
    }

    if (name === 'terminal_read_output') {
      if (!args.project) return fail('Missing required parameter: project');

      const p = findProject(args.project);
      if (!p) return fail(`Project "${args.project}" not found. Use project_list to see available projects.`);

      const maxLines = Math.min(Math.max(args.lines || 50, 1), 200);

      const outputFile = path.join(getDataDir(), 'terminals', 'output', `${p.id}.log`);
      if (!fs.existsSync(outputFile)) {
        return ok(`No terminal output available for "${p.name || path.basename(p.path || '?')}".`);
      }

      try {
        const content = fs.readFileSync(outputFile, 'utf8');
        const allLines = content.split('\n');
        const tail = allLines.slice(-maxLines);
        const output = tail.join('\n').trim();

        if (!output) {
          return ok(`Terminal output is empty for "${p.name || path.basename(p.path || '?')}".`);
        }

        return ok(`Terminal output for "${p.name || path.basename(p.path || '?')}" (last ${tail.length} lines):\n${'─'.repeat(40)}\n${output}`);
      } catch (e) {
        log('Error reading terminal output:', e.message);
        return fail(`Failed to read terminal output: ${e.message}`);
      }
    }

    if (name === 'terminal_close') {
      if (!args.project) return fail('Missing required parameter: project');

      const p = findProject(args.project);
      if (!p) return fail(`Project "${args.project}" not found. Use project_list to see available projects.`);

      const payload = {
        projectId: p.id,
        projectName: p.name || path.basename(p.path || ''),
      };

      if (args.terminalId) {
        payload.terminalId = args.terminalId;
      }

      writeTrigger('close', payload);

      const target = args.terminalId
        ? `terminal "${args.terminalId}"`
        : 'active terminal';

      return ok(`Close triggered for ${target} of "${p.name || path.basename(p.path || '?')}".`);
    }

    return fail(`Unknown terminal tool: ${name}`);
  } catch (error) {
    log(`Error in ${name}:`, error.message);
    return fail(`Terminal error: ${error.message}`);
  }
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {}

// -- Exports ------------------------------------------------------------------

module.exports = { tools, handle, cleanup };
