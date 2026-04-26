'use strict';

/**
 * Terminal Tools Module for Claude Terminal MCP
 *
 * Provides terminal management tools: list, create, send commands, read output, close.
 * Communicates with the Electron app via trigger files in CT_DATA_DIR/terminals/triggers/.
 */

const fs = require('fs');
const path = require('path');
const { loadProjects } = require('./_projectsCache');

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:terminal] ${args.join(' ')}\n`);
}

// -- Data access --------------------------------------------------------------

function getDataDir() {
  return process.env.CT_DATA_DIR || '';
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

// Writes a trigger on the new `tabs/triggers/` pipeline (supports request/response).
function writeTabTrigger(action, payload) {
  const triggerDir = path.join(getDataDir(), 'tabs', 'triggers');
  if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });
  const requestId = payload.requestId || `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const triggerFile = path.join(triggerDir, `${action}_${requestId}.json`);
  fs.writeFileSync(triggerFile, JSON.stringify({
    action,
    requestId,
    ...payload,
    source: 'mcp',
    timestamp: new Date().toISOString(),
  }), 'utf8');
  return requestId;
}

async function awaitTabResponse(requestId, { timeoutMs = 10000, intervalMs = 150 } = {}) {
  const responseDir = path.join(getDataDir(), 'tabs', 'responses');
  if (!fs.existsSync(responseDir)) fs.mkdirSync(responseDir, { recursive: true });
  const responseFile = path.join(responseDir, `${requestId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(responseFile)) {
      let data = null;
      try { data = JSON.parse(fs.readFileSync(responseFile, 'utf8')); } catch (_) {}
      try { fs.unlinkSync(responseFile); } catch (_) {}
      return data || { ok: true };
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { ok: false, error: 'Timed out waiting for renderer response' };
}

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'terminal_list',
    description: '[Legacy — prefer tab_list] List active terminals in Claude Terminal. Shows terminal ID, project, mode (terminal/chat), and status.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Optional filter by project name or ID' },
      },
    },
  },
  {
    name: 'terminal_create',
    description: 'Open a new terminal tab in Claude Terminal for a project. Returns the newly created tab\'s stable `tabId` that can be passed to tab_send / tab_status / tab_close. When `skipPermissions` is omitted, the user\'s global setting is used (same behavior as creating a tab from the UI).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID' },
        mode: { type: 'string', enum: ['terminal', 'chat'], description: 'Terminal mode (default: terminal)' },
        skipPermissions: {
          type: 'boolean',
          description: 'Bypass Claude permission prompts for this tab (chat mode only). If omitted, the global user setting is applied.',
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'terminal_send_command',
    description: '[Legacy — prefer tab_send with a stable tabId] Send a command to a running terminal in Claude Terminal. The command is typed into the first terminal of the specified project, which is ambiguous when multiple tabs exist.',
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
    description: '[Legacy] Read recent output from a terminal in Claude Terminal. Returns the last N lines of terminal output.',
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
    description: '[Legacy — prefer tab_close with a stable tabId] Close a terminal tab in Claude Terminal.',
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

      const triggerPayload = {
        projectId: p.id,
        projectName: p.name || path.basename(p.path || ''),
        projectPath: p.path,
        mode,
      };
      // Forward skipPermissions only when explicitly set; the renderer falls
      // back to the user's global setting when this field is undefined.
      if (typeof args.skipPermissions === 'boolean') {
        triggerPayload.skipPermissions = args.skipPermissions;
      }
      const requestId = writeTabTrigger('create', triggerPayload);
      const resp = await awaitTabResponse(requestId, { timeoutMs: 15000 });
      if (resp.ok && resp.tabId) {
        return ok(JSON.stringify({
          tabId: resp.tabId,
          projectId: p.id,
          mode,
          projectName: p.name || path.basename(p.path || ''),
          ...(typeof resp.skipPermissions === 'boolean' ? { skipPermissions: resp.skipPermissions } : {}),
        }, null, 2));
      }
      return fail(`Failed to create terminal: ${resp.error || 'unknown error'}`);
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
