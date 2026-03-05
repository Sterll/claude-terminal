#!/usr/bin/env node
/**
 * Claude Terminal Hook Handler
 * Called by Claude Code hooks. Sends event directly to the running app via HTTP.
 *
 * Usage: echo '{}' | node claude-terminal-hook-handler.js <HookName>
 *
 * For PermissionRequest hooks: blocks until the user responds (Allow/Deny)
 * in the app notification, then exits with 0 (allow) or 2 (deny).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

const HOOK_NAME = process.argv[2] || 'unknown';
const HOOKS_DIR = path.join(os.homedir(), '.claude-terminal', 'hooks');
const PORT_FILE = path.join(HOOKS_DIR, 'port');
const TOKEN_FILE = path.join(HOOKS_DIR, 'token');

const IS_PERMISSION = HOOK_NAME === 'PermissionRequest';

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

  // For PermissionRequest: attach a requestId so the app can route the user's response back
  let requestId = null;
  if (IS_PERMISSION) {
    requestId = crypto.randomBytes(8).toString('hex');
    if (parsedStdin && typeof parsedStdin === 'object') {
      parsedStdin._requestId = requestId;
    } else {
      parsedStdin = { _requestId: requestId };
    }
  }

  const entry = JSON.stringify({
    hook: HOOK_NAME,
    timestamp: new Date().toISOString(),
    stdin: parsedStdin,
    cwd: process.cwd()
  });

  // Read port and token, send to app
  let port, token;
  try {
    port = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10);
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch (e) {
    // App not running or files missing — exit silently
    process.exit(0);
  }

  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path: '/hook',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(entry),
      'Authorization': `Bearer ${token}`
    },
    timeout: 1000
  }, () => {
    if (IS_PERMISSION && requestId) {
      // Block and wait for user's Allow/Deny response (up to 31s)
      waitForPermissionDecision(port, token, requestId);
    } else {
      process.exit(0);
    }
  });

  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.write(entry);
  req.end();
}

/**
 * Long-poll the app for the user's permission decision.
 * The server holds the connection open until the user clicks Allow or Deny.
 * Exits with 0 (allow) or 2 (deny).
 */
function waitForPermissionDecision(port, token, requestId) {
  const queryPath = '/permission-wait?id=' + encodeURIComponent(requestId) + '&token=' + encodeURIComponent(token);

  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path: queryPath,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
    timeout: 31000 // slightly longer than server-side 30s timeout
  }, (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      const decision = data.trim();
      process.exit(decision === 'deny' ? 2 : 0);
    });
  });

  req.on('error', () => process.exit(0)); // app died → allow by default
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end();
}
