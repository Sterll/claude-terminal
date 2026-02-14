#!/usr/bin/env node
/**
 * Claude Terminal Hook Handler
 * Called by Claude Code hooks. Sends event directly to the running app via HTTP.
 *
 * Usage: echo '{}' | node claude-terminal-hook-handler.js <HookName>
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const HOOK_NAME = process.argv[2] || 'unknown';
const PORT_FILE = path.join(os.homedir(), '.claude-terminal', 'hooks', 'port');

// Read stdin
let stdinData = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdinData += chunk; });

// Timeout if no stdin after 2s (allow slow machines/heavy load)
const timeout = setTimeout(() => finish(), 2000);

process.stdin.on('end', () => {
  clearTimeout(timeout);
  finish();
});

function finish() {
  let parsedStdin = null;

  try {
    if (stdinData.trim()) {
      parsedStdin = JSON.parse(stdinData.trim());
    }
  } catch (e) {
    parsedStdin = { _raw: stdinData.trim() };
  }

  const entry = JSON.stringify({
    hook: HOOK_NAME,
    timestamp: new Date().toISOString(),
    stdin: parsedStdin,
    cwd: process.cwd()
  });

  // Read port and send to app
  let port;
  try {
    port = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10);
  } catch (e) {
    // App not running or port file missing — exit silently
    process.exit(0);
  }

  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path: '/hook',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(entry) },
    timeout: 1000
  }, () => {
    process.exit(0);
  });

  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.write(entry);
  req.end();
}
