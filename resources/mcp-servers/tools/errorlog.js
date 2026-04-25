'use strict';

/**
 * Error Log Tools Module for Claude Terminal MCP
 *
 * Exposes centralized error log data to Claude agents.
 * Communicates with the main process ErrorLogService via IPC.
 *
 * Tools:
 *   errorlog_stats     - Get error log statistics
 *   errorlog_entries   - Get recent error entries with optional filters
 *   errorlog_patterns  - Get recurring error patterns
 *   errorlog_export    - Export full error log for bug reports
 *   errorlog_clear     - Clear all error log entries
 */

function log(...args) {
  process.stderr.write(`[ct-mcp:errorlog] ${args.join(' ')}\n`);
}

// The MCP server injects sendCommand() for IPC with the main process.
// We store a reference when handle() is called via context.
let _sendCommand = null;

const tools = [
  {
    name: 'errorlog_stats',
    description: 'Get error log statistics: total count, critical/warning/info breakdown, pattern alerts count, top domains. Useful for a quick health check.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'errorlog_entries',
    description: 'Get recent error log entries. Supports filtering by level (critical/warning/info), domain, and search text. Returns newest first, max 100 entries.',
    inputSchema: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['critical', 'warning', 'info'],
          description: 'Filter by severity level',
        },
        domain: {
          type: 'string',
          description: 'Filter by domain (e.g. "ipc:git", "service:workflow", "mcp", "uncaught")',
        },
        search: {
          type: 'string',
          description: 'Search text in message, domain, or stack trace',
        },
        limit: {
          type: 'number',
          description: 'Max entries to return (default 50, max 100)',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'errorlog_patterns',
    description: 'Get recurring error patterns detected in the last hour. Shows errors that repeat 5+ times with frequency count.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'errorlog_export',
    description: 'Export the full error log as a JSON object for bug reports. Includes stats, pattern alerts, and the last 500 entries.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'errorlog_clear',
    description: 'Clear all error log entries and pattern alerts.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

async function handle(toolName, args, context) {
  if (context?.sendCommand) _sendCommand = context.sendCommand;

  try {
    switch (toolName) {
      case 'errorlog_stats':
        return await _handleStats();
      case 'errorlog_entries':
        return await _handleEntries(args);
      case 'errorlog_patterns':
        return await _handlePatterns();
      case 'errorlog_export':
        return await _handleExport();
      case 'errorlog_clear':
        return await _handleClear();
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }], isError: true };
    }
  } catch (err) {
    log('Error:', err.message);
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
}

async function _handleStats() {
  const stats = await _ipc('errorlog-get-stats');
  if (!stats) return _text('No error log data available.');

  const lines = [
    `## Error Log Stats`,
    ``,
    `- **Total entries:** ${stats.total}`,
    `- **Last hour:** ${stats.last1h}`,
    `  - Critical: ${stats.critical}`,
    `  - Warning: ${stats.warning}`,
    `  - Info: ${stats.info}`,
    `- **Pattern alerts:** ${stats.patternAlerts}`,
  ];

  if (stats.domains && Object.keys(stats.domains).length > 0) {
    lines.push(``, `### Top domains (last hour)`);
    const sorted = Object.entries(stats.domains).sort((a, b) => b[1] - a[1]);
    for (const [domain, count] of sorted.slice(0, 10)) {
      lines.push(`- \`${domain}\`: ${count}`);
    }
  }

  return _text(lines.join('\n'));
}

async function _handleEntries(args) {
  const filters = {};
  if (args.level) filters.level = args.level;
  if (args.domain) filters.domain = args.domain;
  if (args.search) filters.search = args.search;

  const entries = await _ipc('errorlog-get-entries', filters);
  if (!entries || entries.length === 0) return _text('No error entries found matching filters.');

  const limit = Math.min(args.limit || 50, 100);
  const visible = entries.slice(-limit).reverse();

  const lines = [`## Error Log (${visible.length} of ${entries.length} entries)`, ``];

  for (const e of visible) {
    const time = new Date(e.timestamp).toLocaleTimeString();
    lines.push(`### [${e.level.toUpperCase()}] ${e.domain} - ${time}`);
    lines.push(e.message);
    if (e.stack) {
      lines.push('```');
      lines.push(e.stack.slice(0, 500));
      lines.push('```');
    }
    lines.push(``);
  }

  return _text(lines.join('\n'));
}

async function _handlePatterns() {
  const patterns = await _ipc('errorlog-get-patterns');
  if (!patterns || patterns.length === 0) return _text('No recurring error patterns detected.');

  const lines = [`## Recurring Error Patterns`, ``];
  for (const p of patterns) {
    lines.push(`- **${p.count}x** \`${p.domain}\` - ${p.message}`);
  }

  return _text(lines.join('\n'));
}

async function _handleExport() {
  const data = await _ipc('errorlog-export');
  return _text('```json\n' + JSON.stringify(data, null, 2).slice(0, 10000) + '\n```');
}

async function _handleClear() {
  await _ipc('errorlog-clear');
  return _text('Error log cleared.');
}

// IPC helper
async function _ipc(channel, args) {
  if (_sendCommand) {
    return _sendCommand(channel, args);
  }
  return null;
}

function _text(text) {
  return { content: [{ type: 'text', text }] };
}

module.exports = { tools, handle };
