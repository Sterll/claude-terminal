/**
 * HookEventServer
 * Listens for hook events from the Claude Terminal hook handler script.
 * Runs a tiny HTTP server on localhost, forwards events to renderer via IPC.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT_DIR = path.join(os.homedir(), '.claude-terminal', 'hooks');
const PORT_FILE = path.join(PORT_DIR, 'port');
const TOKEN_FILE = path.join(PORT_DIR, 'token');

let server = null;
let mainWindow = null;
let authToken = null;

// Pending PermissionRequest responses: requestId -> { res: ServerResponse, timer: NodeJS.Timeout }
const pendingPermissions = new Map();
const PERMISSION_TIMEOUT_MS = 30000; // 30s — hook handler also uses 31s timeout

/**
 * Start the hook event server
 * @param {BrowserWindow} win - Main window to send IPC events to
 */
function start(win) {
  mainWindow = win;

  if (server) return;

  // Generate a random token for this session
  authToken = crypto.randomBytes(32).toString('hex');

  const MAX_BODY = 16 * 1024; // 16 KB — hook payloads are typically < 1 KB

  server = http.createServer((req, res) => {
    // ── POST /hook — receive hook event from handler script ──
    if (req.method === 'POST' && req.url === '/hook') {
      // Validate bearer token
      const authHeader = req.headers['authorization'] || '';
      if (authHeader !== `Bearer ${authToken}`) {
        res.writeHead(401);
        res.end('unauthorized');
        return;
      }

      let body = '';
      req.setTimeout(5000);
      req.on('data', chunk => {
        body += chunk;
        if (body.length > MAX_BODY) {
          res.writeHead(413);
          res.end('payload too large');
          req.destroy();
        }
      });
      req.on('end', () => {
        res.writeHead(200);
        res.end('ok');

        try {
          const event = JSON.parse(body);
          // Hook event received — forwarded to renderer via IPC
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('hook-event', event);
          }
          // Also forward to WorkflowService for hook-triggered workflows
          try {
            require('./WorkflowService').onHookEvent(event);
          } catch (_) { /* WorkflowService optional dependency */ }
        } catch (e) {
          console.warn('[HookEventServer] Malformed payload:', body.substring(0, 200));
        }
      });

    // ── GET /permission-wait?id=<requestId>&token=<token> — blocking wait for user decision ──
    // Called by the hook handler script after a PermissionRequest event.
    // The request is held open until the user clicks Allow/Deny in the notification.
    } else if (req.method === 'GET' && req.url.startsWith('/permission-wait')) {
      const urlParts = req.url.split('?');
      const qs = new URLSearchParams(urlParts[1] || '');
      const id = qs.get('id');
      const tokenParam = qs.get('token');

      if (tokenParam !== authToken) {
        res.writeHead(401);
        res.end('unauthorized');
        return;
      }
      if (!id) {
        res.writeHead(400);
        res.end('missing id');
        return;
      }

      // Hold the connection open until user responds or timeout
      const timer = setTimeout(() => {
        if (pendingPermissions.has(id)) {
          pendingPermissions.delete(id);
          // Default: allow on timeout (non-blocking fallback)
          res.writeHead(200);
          res.end('allow');
        }
      }, PERMISSION_TIMEOUT_MS);

      pendingPermissions.set(id, { res, timer });
      req.on('close', () => {
        // Client disconnected — clean up silently
        if (pendingPermissions.has(id)) {
          clearTimeout(pendingPermissions.get(id).timer);
          pendingPermissions.delete(id);
        }
      });

    } else {
      res.writeHead(404);
      res.end();
    }
  });

  // Listen on random port, localhost only
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;

    // Write port and token files so hook handler scripts can find us
    if (!fs.existsSync(PORT_DIR)) {
      fs.mkdirSync(PORT_DIR, { recursive: true });
    }
    fs.writeFileSync(PORT_FILE, String(port));
    fs.writeFileSync(TOKEN_FILE, authToken);

    console.log(`[HookEventServer] Listening on 127.0.0.1:${port}`);
  });

  server.on('error', (e) => {
    console.error('[HookEventServer] Server error:', e);
  });
}

/**
 * Resolve a pending PermissionRequest — called when user clicks Allow or Deny.
 * @param {string} id - The requestId from the hook handler
 * @param {'allow'|'deny'} decision
 * @returns {boolean} true if a pending request was found and resolved
 */
function resolvePendingPermission(id, decision) {
  const pending = pendingPermissions.get(id);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingPermissions.delete(id);
  pending.res.writeHead(200);
  pending.res.end(decision === 'allow' ? 'allow' : 'deny');
  console.log(`[HookEventServer] Permission ${decision} for requestId=${id}`);
  return true;
}

/**
 * Stop the hook event server and clean up port file
 */
function stop() {
  if (server) {
    server.close();
    server = null;
  }

  // Remove port and token files
  try {
    if (fs.existsSync(PORT_FILE)) fs.unlinkSync(PORT_FILE);
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  } catch (e) {
    // Ignore cleanup errors
  }

  authToken = null;
  mainWindow = null;
}

/**
 * Update the main window reference (e.g. after window recreation)
 * @param {BrowserWindow} win
 */
function setMainWindow(win) {
  mainWindow = win;
}

module.exports = {
  start,
  stop,
  setMainWindow,
  resolvePendingPermission
};
