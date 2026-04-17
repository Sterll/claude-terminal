'use strict';

/**
 * Tabs Tools Module for Claude Terminal MCP
 *
 * Orchestration layer for driving multiple Claude Terminal tabs (terminals
 * and chats) in parallel with stable IDs.
 *
 * How it works
 * ------------
 * - The renderer writes a rich snapshot of all tabs to `tabs.json` (in
 *   CT_DATA_DIR) every ~500ms. Read tools (`tab_list`, `tab_status`) just
 *   read from that file.
 * - Write tools (`tab_send`, `tab_close`) drop a JSON trigger in
 *   `tabs/triggers/`. The Electron main process polls that dir every 2s
 *   and forwards the action to the renderer, which applies it and writes
 *   a response file in `tabs/responses/<requestId>.json`.
 * - Phase 1 ships `list`, `send`, `status`, `close`. Wait primitives and
 *   permission control come in phase 2.
 *
 * Example orchestration
 * ---------------------
 *   // Spin up 3 chats in parallel on the same project, send prompts, poll.
 *   const a = await mcp.call('terminal_create', { project: 'ct', mode: 'chat' });
 *   const b = await mcp.call('terminal_create', { project: 'ct', mode: 'chat' });
 *   const c = await mcp.call('terminal_create', { project: 'ct', mode: 'chat' });
 *   // Each returns { tabId }. Fan out:
 *   await mcp.call('tab_send', { tabId: a.tabId, content: 'Analyze auth/' });
 *   await mcp.call('tab_send', { tabId: b.tabId, content: 'Refactor api/' });
 *   await mcp.call('tab_send', { tabId: c.tabId, content: 'Write tests' });
 *   // Poll status until each is idle again:
 *   const s = await mcp.call('tab_status', { tabId: a.tabId });
 */

const fs = require('fs');
const path = require('path');

// -- Constants ----------------------------------------------------------------

const RESPONSE_POLL_INTERVAL_MS = 150;
const RESPONSE_TIMEOUT_MS = 10000;

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:tabs] ${args.join(' ')}\n`);
}

// -- Data access --------------------------------------------------------------

function getDataDir() {
  return process.env.CT_DATA_DIR || '';
}

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log(`Error reading ${path.basename(file)}: ${e.message}`);
  }
  return fallback;
}

function loadTabs() {
  const snap = readJson(path.join(getDataDir(), 'tabs.json'), { tabs: [] });
  return Array.isArray(snap.tabs) ? snap.tabs : [];
}

function loadProjects() {
  return readJson(path.join(getDataDir(), 'projects.json'), { projects: [] });
}

function findProjectById(projectId) {
  const data = loadProjects();
  return (data.projects || []).find(p => p.id === projectId) || null;
}

function findTab(tabs, tabId) {
  if (!tabId) return null;
  return tabs.find(t => t.tabId === tabId) || null;
}

function newRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeTrigger(action, payload) {
  const triggerDir = path.join(getDataDir(), 'tabs', 'triggers');
  ensureDir(triggerDir);
  const requestId = payload.requestId || newRequestId();
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

async function awaitResponse(requestId, { timeoutMs = RESPONSE_TIMEOUT_MS, intervalMs = RESPONSE_POLL_INTERVAL_MS } = {}) {
  const responseDir = path.join(getDataDir(), 'tabs', 'responses');
  ensureDir(responseDir);
  const responseFile = path.join(responseDir, `${requestId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(responseFile)) {
      let data = null;
      try {
        data = JSON.parse(fs.readFileSync(responseFile, 'utf8'));
      } catch (_) {}
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
    name: 'tab_list',
    description: 'List all orchestration tabs (terminals + chats) with stable IDs, mode, status, and activity timestamps. Use this to discover tabs before calling tab_send / tab_status / tab_close.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Optional filter by project name or ID' },
        mode: { type: 'string', enum: ['terminal', 'chat'], description: 'Optional filter by tab mode' },
      },
    },
  },
  {
    name: 'tab_status',
    description: 'Return the detailed status for a tab identified by its stable tabId. Includes mode-specific details (lastCommand/isPromptReady for terminals, tokensUsed/pendingPermission for chats).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Stable tab identifier (see tab_list)' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'tab_send',
    description: 'Send content to a specific tab by its stable tabId. For chat tabs the content is submitted as a user message; for terminal tabs it is typed as a command with a trailing newline. Fire-and-forget with a short response confirmation (~2-5s).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Stable tab identifier (see tab_list)' },
        content: { type: 'string', description: 'Text to send (prompt for chat, command for terminal)' },
      },
      required: ['tabId', 'content'],
    },
  },
  {
    name: 'tab_close',
    description: 'Close a tab identified by its stable tabId. Kills the underlying PTY or ends the chat session.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Stable tab identifier' },
      },
      required: ['tabId'],
    },
  },
];

// -- Tool handler -------------------------------------------------------------

function formatTabLine(t) {
  const parts = [`${t.tabId}  [${t.mode}]  ${t.status}`];
  if (t.projectName) parts.push(`  project: ${t.projectName}`);
  if (t.title && t.title !== t.projectName) parts.push(`  title:   ${t.title}`);
  if (t.lastActivityAt) parts.push(`  active:  ${t.lastActivityAt}`);
  return parts.join('\n');
}

async function handle(name, args) {
  const ok = (text, extra) => ({ content: [{ type: 'text', text }], ...(extra || {}) });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  try {
    if (name === 'tab_list') {
      let tabs = loadTabs();
      if (args.mode) tabs = tabs.filter(t => t.mode === args.mode);
      if (args.project) {
        const lower = String(args.project).toLowerCase();
        tabs = tabs.filter(t =>
          (t.projectId || '').toLowerCase() === lower ||
          (t.projectName || '').toLowerCase() === lower
        );
      }
      if (!tabs.length) return ok(args.project || args.mode ? 'No matching tabs.' : 'No active tabs.');
      const body = tabs.map(formatTabLine).join('\n\n');
      return ok(`Active tabs (${tabs.length}):\n\n${body}`);
    }

    if (name === 'tab_status') {
      if (!args.tabId) return fail('Missing required parameter: tabId');
      const tab = findTab(loadTabs(), args.tabId);
      if (!tab) return fail(`Tab not found: ${args.tabId}`);
      return ok(JSON.stringify(tab, null, 2));
    }

    if (name === 'tab_send') {
      if (!args.tabId) return fail('Missing required parameter: tabId');
      if (typeof args.content !== 'string') return fail('Missing required parameter: content');

      // Validate existence locally first to fail fast before spending 10s waiting.
      if (!findTab(loadTabs(), args.tabId)) {
        return fail(`Tab not found: ${args.tabId}. Use tab_list to see available tabs.`);
      }

      const requestId = writeTrigger('send', { tabId: args.tabId, content: args.content });
      const resp = await awaitResponse(requestId);
      if (resp.ok) return ok(`Sent to tab ${args.tabId} (${resp.mode || 'tab'}).`);
      return fail(`Failed to send: ${resp.error || 'unknown error'}`);
    }

    if (name === 'tab_close') {
      if (!args.tabId) return fail('Missing required parameter: tabId');
      const requestId = writeTrigger('close', { tabId: args.tabId });
      const resp = await awaitResponse(requestId);
      if (resp.ok) return ok(`Tab ${args.tabId} closed.`);
      return fail(`Failed to close: ${resp.error || 'unknown error'}`);
    }

    return fail(`Unknown tabs tool: ${name}`);
  } catch (error) {
    log(`Error in ${name}:`, error.message);
    return fail(`Tabs error: ${error.message}`);
  }
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {}

// -- Exports ------------------------------------------------------------------

module.exports = { tools, handle, cleanup };
