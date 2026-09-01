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

// Must mirror _ALL_TABS_ORDER in renderer.js. Tabs missing here are rejected by
// sidebar_set_pinned and silently dropped from the pinned list, so keep in sync.
const ALL_TABS = [
  'claude', 'git', 'database', 'mcp', 'plugins', 'skills',
  'agents', 'workflows', 'tasks', 'control-tower', 'dashboard', 'timetracking',
  'session-replay', 'memory', 'workspace', 'errorlog', 'connectivity',
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
  tasks: 'Parallel tasks',
  'control-tower': 'Control Tower (live agents)',
  dashboard: 'Projects dashboard',
  timetracking: 'Time tracking',
  'session-replay': 'Session replay',
  memory: 'Memory editor (MEMORY.md)',
  workspace: 'Workspace knowledge base',
  errorlog: 'Error log',
  connectivity: 'Connectivity (local Wi-Fi + cloud relay)',
};

// Navigable but not pinnable: Settings is a standalone button, not a nav tab.
const NAV_ONLY_TARGETS = { settings: 'Settings panel' };

// -- Live channel to the running app ------------------------------------------
// Same request/response pipeline as tabs.js: drop a trigger, the main process
// forwards it to the renderer, the renderer writes back a response file.

const RESPONSE_POLL_INTERVAL_MS = 100;
const RESPONSE_TIMEOUT_MS = 8000;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeTrigger(action, payload) {
  const triggerDir = path.join(getDataDir(), 'tabs', 'triggers');
  ensureDir(triggerDir);
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  fs.writeFileSync(
    path.join(triggerDir, `${action}_${requestId}.json`),
    JSON.stringify({
      action,
      requestId,
      ...payload,
      source: 'mcp',
      timestamp: new Date().toISOString(),
    }),
    'utf8'
  );
  return requestId;
}

async function awaitResponse(requestId) {
  const responseDir = path.join(getDataDir(), 'tabs', 'responses');
  ensureDir(responseDir);
  const responseFile = path.join(responseDir, `${requestId}.json`);
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (fs.existsSync(responseFile)) {
      let data = null;
      try {
        data = JSON.parse(fs.readFileSync(responseFile, 'utf8'));
      } catch (_) {}
      try { fs.unlinkSync(responseFile); } catch (_) {}
      return data || { ok: true };
    }
    await new Promise(r => setTimeout(r, RESPONSE_POLL_INTERVAL_MS));
  }
  return { ok: false, error: 'Claude Terminal did not respond — is the app running?' };
}

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'ui_navigate',
    description: `Switch the panel currently displayed in Claude Terminal — this actually moves the user's screen, it is not a read operation. Use it whenever the user asks to see, open, show or go to a part of the app ("open git", "show me the dashboard", "go to settings"), especially when they cannot click themselves. Takes effect within about a second. Available targets: ${Object.entries({ ...TAB_LABELS, ...NAV_ONLY_TARGETS }).map(([id, label]) => `${id} (${label})`).join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        tab: {
          type: 'string',
          enum: [...ALL_TABS, ...Object.keys(NAV_ONLY_TARGETS)],
          description: 'Panel to display.',
        },
      },
      required: ['tab'],
    },
  },
  {
    name: 'ui_state',
    description: 'Report what the user is currently looking at in Claude Terminal: which panel is displayed, and which panels are visible in the sidebar versus hidden in the More menu. Use it to answer "where am I?", to check a panel is already open before navigating, or to describe the screen to someone who cannot see it. Read-only — it changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
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
    if (name === 'ui_navigate') {
      const target = String(args.tab || '').trim();
      if (!target) return fail('Missing required parameter: tab');

      const valid = [...ALL_TABS, ...Object.keys(NAV_ONLY_TARGETS)];
      if (!valid.includes(target)) {
        return fail(`Unknown panel "${target}".\nAvailable: ${valid.join(', ')}`);
      }

      const requestId = writeTrigger('navigate', { tab: target });
      const res = await awaitResponse(requestId);

      if (!res.ok) {
        let msg = `Could not switch to "${target}": ${res.error || 'unknown error'}`;
        if (Array.isArray(res.available)) msg += `\nPanels present in the UI: ${res.available.join(', ')}`;
        return fail(msg);
      }

      const label = TAB_LABELS[target] || NAV_ONLY_TARGETS[target] || target;
      let out = `Now showing: ${label}`;
      if (res.from && res.from !== target) out += ` (was on ${TAB_LABELS[res.from] || res.from})`;
      if (res.wasHidden) out += `\nNote: this tab is unpinned, so it lives in the "More" overflow menu — it is displayed, but not visible in the sidebar.`;
      return ok(out);
    }

    if (name === 'ui_state') {
      const requestId = writeTrigger('ui_state', {});
      const res = await awaitResponse(requestId);

      if (!res.ok) {
        return fail(`Could not read the UI state: ${res.error || 'unknown error'}`);
      }

      const label = (id) => TAB_LABELS[id] || NAV_ONLY_TARGETS[id] || id;
      let out = `Currently showing: ${res.current ? label(res.current) : '(nothing active)'}\n`;
      if (Array.isArray(res.visible) && res.visible.length) {
        out += `\nVisible in the sidebar (${res.visible.length}): ${res.visible.join(', ')}`;
      }
      if (Array.isArray(res.hidden) && res.hidden.length) {
        out += `\nHidden in the More menu (${res.hidden.length}): ${res.hidden.join(', ')}`;
      }
      return ok(out);
    }

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
