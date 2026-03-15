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

// Pending PermissionRequest responses: requestId -> { res: ServerResponse, timer: NodeJS.Timeout, createdAt: number }
const pendingPermissions = new Map();
const PERMISSION_TIMEOUT_MS = 30000; // 30s — hook handler also uses 31s timeout
const MAX_PENDING_PERMISSIONS = 100;
let _gcTimer = null;

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

      // Cap pending permissions to prevent unbounded growth
      if (pendingPermissions.size >= MAX_PENDING_PERMISSIONS) {
        const oldest = pendingPermissions.keys().next().value;
        const entry = pendingPermissions.get(oldest);
        clearTimeout(entry.timer);
        pendingPermissions.delete(oldest);
        try { entry.res.writeHead(503); entry.res.end('too many pending'); } catch (_) {}
      }
      pendingPermissions.set(id, { res, timer, createdAt: Date.now() });
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
  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;

    // Write port and token files atomically (temp + rename) so hook handler
    // scripts never read a truncated/corrupted file on crash.
    try {
      if (!fs.existsSync(PORT_DIR)) {
        fs.mkdirSync(PORT_DIR, { recursive: true });
      }
      const portTmp = PORT_FILE + '.tmp';
      const tokenTmp = TOKEN_FILE + '.tmp';
      await fs.promises.writeFile(portTmp, String(port));
      await fs.promises.rename(portTmp, PORT_FILE);
      await fs.promises.writeFile(tokenTmp, authToken);
      await fs.promises.rename(tokenTmp, TOKEN_FILE);
    } catch (e) {
      console.error('[HookEventServer] Failed to write port/token files:', e);
    }

    console.log(`[HookEventServer] Listening on 127.0.0.1:${port}`);
  });

  server.on('error', (e) => {
    console.error('[HookEventServer] Server error:', e);
  });

  // Periodic GC for stale pending permissions (2x timeout interval)
  if (!_gcTimer) {
    _gcTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of pendingPermissions.entries()) {
        if (now - entry.createdAt > PERMISSION_TIMEOUT_MS * 2) {
          clearTimeout(entry.timer);
          pendingPermissions.delete(id);
          try { entry.res.writeHead(408); entry.res.end('expired'); } catch (_) {}
        }
      }
    }, PERMISSION_TIMEOUT_MS);
    _gcTimer.unref?.();
  }
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
  if (_gcTimer) {
    clearInterval(_gcTimer);
    _gcTimer = null;
  }

  // Clear all pending permissions
  for (const [id, entry] of pendingPermissions.entries()) {
    clearTimeout(entry.timer);
    try { entry.res.writeHead(503); entry.res.end('shutdown'); } catch (_) {}
  }
  pendingPermissions.clear();

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
