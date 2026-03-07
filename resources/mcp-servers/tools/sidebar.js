'use strict';

/**
 * Sidebar Tools Module for Claude Terminal MCP
 *
 * Manage pinned sidebar tabs in Claude Terminal.
 * Reads/writes CT_DATA_DIR/settings.json — the same file the app uses.
 */

const fs = require('fs');
const path = require('path');

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:sidebar] ${args.join(' ')}\n`);
}

// -- Data access --------------------------------------------------------------

function getDataDir() {
  return process.env.CT_DATA_DIR || '';
}

function loadSettings() {
  const file = path.join(getDataDir(), 'settings.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log('Error reading settings.json:', e.message);
  }
  return {};
}

function saveSettings(settings) {
  const file = path.join(getDataDir(), 'settings.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// -- Constants ----------------------------------------------------------------

const ALL_TABS = [
  'claude', 'git', 'database', 'mcp', 'plugins', 'skills',
  'agents', 'workflows', 'dashboard', 'timetracking', 'memory', 'cloud-panel',
];

const TAB_LABELS = {
  claude: 'Claude (terminal/chat)',
  git: 'Git & version control',
  database: 'Database management',
  mcp: 'MCP servers',
  plugins: 'Claude Code plugins',
  skills: 'Installed skills',
  agents: 'Custom agents',
  workflows: 'Workflow automation',
  dashboard: 'Projects dashboard',
  timetracking: 'Time tracking',
  memory: 'Memory editor (MEMORY.md)',
  'cloud-panel': 'Cloud remote control',
};

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'sidebar_get_pinned',
    description: 'Get the current pinned tabs configuration in the Claude Terminal sidebar. Returns which tabs are pinned (visible in sidebar) and which are hidden in the More overflow menu.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'sidebar_set_pinned',
    description: 'Set which tabs are pinned (visible) in the Claude Terminal sidebar. Unpinned tabs move to the More overflow menu. The "claude" tab is always pinned. Changes take effect after the app reloads or restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        pinned: {
          type: 'array',
          items: {
            type: 'string',
            enum: ALL_TABS,
          },
          description: `Tab IDs to pin. Available: ${ALL_TABS.join(', ')}`,
        },
      },
      required: ['pinned'],
    },
  },
];

// -- Tool handler -------------------------------------------------------------

async function handle(name, args) {
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  try {
    if (name === 'sidebar_get_pinned') {
      const settings = loadSettings();
      const pinned = settings.pinnedTabs || ALL_TABS;
      const hidden = ALL_TABS.filter(t => !pinned.includes(t));

      let out = '## Claude Terminal — Sidebar Tabs\n\n';
      out += `**Pinned (${pinned.length} visible in sidebar):**\n`;
      for (const t of pinned) out += `  ✓ ${t} — ${TAB_LABELS[t] || t}\n`;

      if (hidden.length) {
        out += `\n**Hidden (${hidden.length} in More menu):**\n`;
        for (const t of hidden) out += `  · ${t} — ${TAB_LABELS[t] || t}\n`;
      } else {
        out += '\nAll tabs are pinned (More menu is empty).\n';
      }

      return ok(out);
    }

    if (name === 'sidebar_set_pinned') {
      if (!Array.isArray(args.pinned)) return fail('pinned must be an array of tab IDs.');

      const invalid = args.pinned.filter(t => !ALL_TABS.includes(t));
      if (invalid.length) {
        return fail(`Unknown tab ID(s): ${invalid.join(', ')}.\nValid IDs: ${ALL_TABS.join(', ')}`);
      }

      // claude is always first, always pinned
      let pinned = [...args.pinned];
      if (!pinned.includes('claude')) pinned.unshift('claude');

      // Preserve the canonical order
      pinned = ALL_TABS.filter(t => pinned.includes(t));

      const settings = loadSettings();
      settings.pinnedTabs = pinned;
      saveSettings(settings);

      const hidden = ALL_TABS.filter(t => !pinned.includes(t));
      let out = `Sidebar updated successfully.\n\n`;
      out += `Pinned (${pinned.length}): ${pinned.join(', ')}\n`;
      out += `Hidden (${hidden.length}): ${hidden.join(', ') || 'none'}\n`;
      out += `\nReload Claude Terminal to apply the changes.`;
      return ok(out);
    }

    return fail(`Unknown sidebar tool: ${name}`);
  } catch (error) {
    log(`Error in ${name}:`, error.message);
    return fail(`Sidebar error: ${error.message}`);
  }
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {}

// -- Exports ------------------------------------------------------------------

module.exports = { tools, handle, cleanup };
