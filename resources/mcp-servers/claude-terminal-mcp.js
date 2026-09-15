#!/usr/bin/env node
'use strict';

/**
 * Claude Terminal — Unified MCP Server
 *
 * Single MCP server that exposes all Claude Terminal tools to Claude Code.
 * Tool modules are loaded from ./tools/ directory.
 *
 * Environment variables:
 *   CT_DATA_DIR      - Path to ~/.claude-terminal/ (app data)
 *   CT_PROJECT_PATH  - Current project path
 *   NODE_PATH        - Path to node_modules with native drivers
 */

const readline = require('readline');
const path = require('path');
const fs = require('fs');

const VERSION = '1.0.0';
const SERVER_NAME = 'claude-terminal';

// -- Logging (stderr only, stdout is protocol) --------------------------------

function log(...args) {
  process.stderr.write(`[${SERVER_NAME}] ${args.join(' ')}\n`);
}

// -- JSON-RPC helpers ---------------------------------------------------------

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function sendNotification(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n');
}

// -- Tool module loading ------------------------------------------------------

const toolModules = [];
let allTools = [];

function loadToolModules() {
  const toolsDir = path.join(__dirname, 'tools');
  if (!fs.existsSync(toolsDir)) {
    log('Warning: tools/ directory not found at', toolsDir);
    return;
  }

  const files = fs.readdirSync(toolsDir).filter(f => f.endsWith('.js'));
  for (const file of files) {
    try {
      const mod = require(path.join(toolsDir, file));
      if (mod.tools && mod.handle) {
        toolModules.push(mod);
        allTools.push(...mod.tools);
        log(`Loaded tool module: ${file} (${mod.tools.length} tools)`);
      }
    } catch (err) {
      log(`Failed to load tool module ${file}: ${err.message}`);
    }
  }

  log(`Total tools registered: ${allTools.length}`);
}

// -- Tool dispatch ------------------------------------------------------------

async function callTool(name, args) {
  for (const mod of toolModules) {
    const tool = mod.tools.find(t => t.name === name);
    if (tool) {
      return await mod.handle(name, args);
    }
  }
  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}

// -- Protocol handler ---------------------------------------------------------

async function handleMessage(message) {
  const { id, method, params } = message;

  if (method === 'initialize') {
    sendResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: VERSION },
    });
    sendNotification('notifications/initialized');
    log('Initialized');
    return;
  }

  if (method === 'tools/list') {
    sendResponse(id, { tools: allTools });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    try {
      const result = await callTool(toolName, toolArgs);
      sendResponse(id, result);
    } catch (error) {
      log(`Tool error (${toolName}):`, error.message);
      sendResponse(id, { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true });
    }
    return;
  }

  // Ignore notifications
  if (!id) return;
  sendError(id, -32601, `Method not found: ${method}`);
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {
  for (const mod of toolModules) {
    if (typeof mod.cleanup === 'function') {
      try { await mod.cleanup(); } catch (e) { log(`Cleanup error: ${e.message}`); }
    }
  }
}

// -- Main loop ----------------------------------------------------------------

loadToolModules();

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const message = JSON.parse(trimmed);
    handleMessage(message).catch((error) => {
      log('Unhandled error:', error.message);
      if (message.id) sendError(message.id, -32603, `Internal error: ${error.message}`);
    });
  } catch (parseError) {
    log('Failed to parse message:', parseError.message);
  }
});

rl.on('close', () => {
  log('stdin closed, shutting down');
  cleanup().then(() => process.exit(0));
});

process.on('SIGINT', () => {
  log('SIGINT received');
  cleanup().then(() => process.exit(0));
});

process.on('SIGTERM', () => {
  log('SIGTERM received');
  cleanup().then(() => process.exit(0));
});

log(`Claude Terminal MCP v${VERSION} started`);
