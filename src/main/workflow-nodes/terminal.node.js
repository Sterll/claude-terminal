'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { resolveVars } = require('./_registry');
const { findProjectRecord, projectLabel } = require('./_projects');

/**
 * Drive a project's terminal tab from a workflow.
 *
 * WHAT THIS CANNOT DO, honestly:
 *   - The terminal is xterm.js in the renderer, driven by a node-pty the
 *     TerminalService owns. The main process cannot type into it directly, so
 *     `send` hands the command to the renderer over the same `mcp-terminal:send`
 *     channel the `terminal_send_command` MCP tool already uses, with the same
 *     payload shape. That path is fire-and-forget: this node learns nothing
 *     about whether the command ran, what it printed, or whether it succeeded.
 *   - The renderer picks the target tab itself (last MCP-created tab for the
 *     project, else the most recent one). With several tabs open, which one
 *     receives the command is not something this node decides.
 *   - If no tab is open for the project, the renderer QUEUES the command for
 *     30 seconds and drops it after that. `delivered: true` therefore means
 *     "handed to the renderer", never "executed".
 *   - `read` tails ~/.claude-terminal/terminals/output/<projectId>.log, the
 *     file `terminal_read_output` reads and TerminalOutputCapture writes. Only
 *     terminals attached to a project are captured, and the log is a rolling
 *     tail with ANSI stripped — not a faithful transcript.
 *
 * Use `shell` instead when you need the output or the exit code. This node is
 * for driving an interactive session a human is watching.
 */

const MIN_LINES = 1;
const MAX_LINES = 200;   // same cap as the terminal_read_output MCP tool

/** Path of the captured-output log for a project, as the MCP tools define it. */
function outputLogFile(projectId) {
  return path.join(os.homedir(), '.claude-terminal', 'terminals', 'output', `${projectId}.log`);
}

/** Clamp a user-supplied line count into [1, 200]; anything unparseable → 50. */
function clampLines(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(Math.trunc(n), MIN_LINES), MAX_LINES);
}

module.exports = {
  type:     'workflow/terminal',
  title:    'Terminal',
  desc:     'Send a command to a project terminal, or read its captured output (delivery is not confirmed)',
  color:    'blue',
  width:    240,
  category: 'actions',
  icon:     'terminal',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [
    { name: 'Done',      type: 'exec'    },
    { name: 'Error',     type: 'exec'    },
    { name: 'output',    type: 'string'  },
    { name: 'lines',     type: 'number'  },
    { name: 'command',   type: 'string'  },
    { name: 'projectId', type: 'string'  },
    { name: 'delivered', type: 'boolean' },
  ],

  props: { action: 'send', projectId: '', command: '', lines: 50 },

  fields: [
    { type: 'select', key: 'action', label: 'wfn.terminal.action.label',
      options: [
        { value: 'send', label: 'wfn.terminal.action.send' },
        { value: 'read', label: 'wfn.terminal.action.read' },
      ] },
    { type: 'cwd-picker', key: 'projectId', label: 'wfn.terminal.project.label',
      hint: 'wfn.terminal.project.hint' },
    { type: 'text', key: 'command', label: 'wfn.terminal.command.label', mono: true,
      hint: 'wfn.terminal.command.hint',
      placeholder: 'npm run dev',
      showIf: (p) => !p.action || p.action === 'send' },
    { type: 'number', key: 'lines', label: 'wfn.terminal.lines.label',
      hint: 'wfn.terminal.lines.hint',
      showIf: (p) => p.action === 'read' },
  ],

  badge: (n) => (n.properties.action || 'send').toUpperCase(),

  async run(config, vars, signal, ctx) {
    if (signal?.aborted) throw new Error('Cancelled');

    const action = String(config.action || 'send').trim().toLowerCase();
    if (action !== 'send' && action !== 'read') {
      throw new Error(`Terminal node: unknown action "${action}" (expected "send" or "read")`);
    }

    const ref     = String(resolveVars(config.projectId || '', vars) ?? '').trim();
    const project = findProjectRecord(ref, vars);
    if (!project) {
      throw new Error(ref
        ? `Terminal node: project "${ref}" not found in projects.json`
        : 'Terminal node: no project selected, and the run context has none');
    }

    // Every slot is always present so a downstream link never reads undefined
    // just because the other action was selected.
    const base = { output: '', lines: 0, command: '', projectId: project.id || '', delivered: false };

    if (action === 'send') {
      // Trailing CR/LF would submit a second, empty line into the shell — the
      // renderer appends the carriage return itself.
      const command = String(resolveVars(config.command || '', vars) ?? '').replace(/[\r\n]+$/, '');
      if (!command.trim()) throw new Error('Terminal node: no command specified');

      if (!ctx?.sendFn) {
        throw new Error('Terminal node: no renderer channel available — a terminal cannot be driven from the main process');
      }

      ctx.sendFn('mcp-terminal:send', {
        projectId:   project.id,
        projectName: projectLabel(project),
        command,
        source:      'workflow',
      });

      return { ...base, command, delivered: true };
    }

    // ── read ────────────────────────────────────────────────────────────────
    const maxLines = clampLines(resolveVars(config.lines ?? 50, vars));
    const logFile  = outputLogFile(project.id);

    // No log at all means nothing has ever run in a terminal attached to this
    // project. Returning '' there would quietly feed an empty string onward and
    // a `read -> claude analyse` chain would analyse nothing while reporting
    // success. Fail loudly instead. A log that EXISTS but is empty still
    // returns '', because that genuinely means "nothing captured yet".
    if (!fs.existsSync(logFile)) {
      throw new Error(
        `Terminal node: no captured output for "${projectLabel(project)}". ` +
        'Only terminals opened against a project are captured — open one and run ' +
        "something, or use a shell node when you need a command's output."
      );
    }

    let output = '';
    try {
      // Trailing newlines are dropped BEFORE splitting. A log ending in "\n"
      // otherwise yields a final empty element that eats one slot of the tail —
      // ask for 2 lines and you get the last line plus a blank. The MCP tool
      // has that off-by-one; there is no reason to inherit it.
      const content = fs.readFileSync(logFile, 'utf8').replace(/[\r\n]+$/, '');
      output = content.split(/\r?\n/).slice(-maxLines).join('\n').trim();
    } catch (e) {
      throw new Error(`Terminal node: cannot read the capture log: ${e.message}`);
    }

    return { ...base, output, lines: output ? output.split('\n').length : 0 };
  },
};
