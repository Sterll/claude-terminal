/**
 * HookEventServer
 * Listens for hook events from the Claude Terminal hook handler script.
 * Runs a tiny HTTP server on localhost, forwards events to renderer via IPC.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT_DIR = path.join(os.homedir(), '.claude-terminal', 'hooks');
const PORT_FILE = path.join(PORT_DIR, 'port');

let server = null;
let mainWindow = null;

/**
 * Start the hook event server
 * @param {BrowserWindow} win - Main window to send IPC events to
 */
function start(win) {
  mainWindow = win;

  if (server) return;

  const MAX_BODY = 16 * 1024; // 16 KB — hook payloads are typically < 1 KB

  server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/hook') {
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
          console.debug(`[HookEventServer] Received: ${event.hook} (cwd: ${event.cwd || '?'})`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('hook-event', event);
          }
        } catch (e) {
          console.warn('[HookEventServer] Malformed payload:', body.substring(0, 200));
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

    // Write port file so hook handler scripts can find us
    if (!fs.existsSync(PORT_DIR)) {
      fs.mkdirSync(PORT_DIR, { recursive: true });
    }
    fs.writeFileSync(PORT_FILE, String(port));

    console.log(`[HookEventServer] Listening on 127.0.0.1:${port}`);
  });

  server.on('error', (e) => {
    console.error('[HookEventServer] Server error:', e);
  });
}

/**
 * Stop the hook event server and clean up port file
 */
function stop() {
  if (server) {
    server.close();
    server = null;
  }

  // Remove port file
  try {
    if (fs.existsSync(PORT_FILE)) {
      fs.unlinkSync(PORT_FILE);
    }
  } catch (e) {
    // Ignore cleanup errors
  }

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
  setMainWindow
};
