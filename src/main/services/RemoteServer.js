/**
 * RemoteServer
 * WebSocket + HTTP server that serves the mobile PWA and bridges
 * Claude Terminal state/events to connected mobile devices.
 *
 * Auth flow (LAN):
 *  1. User enables Remote in settings → server starts
 *  2. A 4-digit PIN is shown in settings (rotates every 2 min or on demand)
 *  3. Mobile opens http://<ip>:<port>, enters PIN → POST /auth { pin }
 *     → server returns a session token (valid for the server lifetime)
 *  4. Mobile connects WS with ?token=<sessionToken>
 *  5. On reconnect, mobile uses stored session token directly
 *
 * Auth flow (cloud relay):
 *  The relay is a dumb pipe: it only forwards {type, data} frames and carries no
 *  per-client identity. A relayed mobile therefore proves itself with the SAME
 *  PIN, tunnelled as an `auth:pin` frame, and receives the SAME kind of session
 *  token, validated through the same _isTokenValid() path. See
 *  _handleRelayAuth() / handleExternalMessage() at the bottom of this file.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { app } = require('electron');

const { settingsFile, projectsFile } = require('../utils/paths');

const PIN_TTL_MS = 2 * 60 * 1000; // 2 minutes
const MAX_AUTH_ATTEMPTS = 5;
const AUTH_LOCKOUT_MS = 60_000; // 1 minute lockout after max attempts
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_POST_BODY = 1024; // 1 KB
const WS_MAX_PAYLOAD = 5 * 1024 * 1024; // 5 MB
const MAX_MENTION_FILE_SIZE = 1024 * 1024; // 1 MB

// In packaged builds, remote-ui is in extraResources; in dev, relative to project root
function getPwaDir() {
  if (app && app.isPackaged) {
    return path.join(process.resourcesPath, 'remote-ui');
  }
  return path.join(__dirname, '..', '..', '..', 'remote-ui');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

let httpServer = null;
let wss = null;
let mainWindow = null;

// Current PIN state
let _pin = null;       // string '0000'–'9999'
let _pinExpiry = 0;    // timestamp ms
let _pinUsed = false;  // true after one successful auth (PIN stays displayed but can't be reused)

// Valid session tokens → { issuedAt } (once authenticated via PIN)
const _sessionTokens = new Map(); // Map<token, { issuedAt }>
// Subset of _sessionTokens that was issued over the cloud relay. Tracked apart
// so relay sessions can be revoked (or survive a local-server restart) as a unit
// — they have no socket of their own to hang their lifetime on.
const _relayTokens = new Set(); // Set<token>
const _connectedClients = new Map(); // Map<sessionToken, WebSocket>
const _clientMeta = new Map(); // Map<sessionToken, { connectedAt, ip, userAgent }>

// Brute-force protection — tracked PER CLIENT IP. A global counter let any host
// on the LAN lock the legitimate user out with a handful of bad PINs.
const _authAttempts = new Map(); // Map<ip, { failures, lockoutUntil, lastAttemptAt }>
const AUTH_ATTEMPT_TTL_MS = 60 * 60 * 1000; // forget idle IPs after 1 hour

// Live time data pushed from renderer
let _timeData = { todayMs: 0 };

// ─── External Transport Bridge ───────────────────────────────────────────────
// External transport (e.g. cloud relay) — injected via setExternalTransport()
// Duck-typed: { connected: boolean, send(data: string): void }
let _externalTransport = null;
let _externalTransportConnectedAt = 0;

// Virtual WS-like object that routes send() calls through the external transport
const _externalWsProxy = {
  get readyState() { return _externalTransport?.connected ? 1 : 3; },
  send(data) {
    if (_externalTransport?.connected) {
      try { _externalTransport.send(typeof data === 'string' ? data : JSON.stringify(data)); } catch (e) {
        console.warn(`[Remote] External transport send failed: ${e.message}`);
      }
    }
  },
  close() {},
};

// Cache sessionId → projectId mapping to avoid disk reads on every chat-idle
const _sessionProjectMap = new Map();

// Cache sessionId → tab name (set by broadcastSessionStarted / broadcastTabRenamed)
const _sessionTabNames = new Map();

// Buffer of chat events per session — replayed to late-joining clients
// Each entry is an array of { channel, data } objects
const _sessionMessageBuffer = new Map();
const MAX_BUFFER_PER_SESSION = 500; // cap to prevent memory issues
const BUFFER_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let _cleanupTimer = null;

// ─── Settings ─────────────────────────────────────────────────────────────────

let _settingsCache = null;
let _settingsCacheAt = 0;

async function _loadSettings() {
  const now = Date.now();
  if (_settingsCache && now - _settingsCacheAt < 5000) return _settingsCache;
  try {
    _settingsCache = JSON.parse(await fs.promises.readFile(settingsFile, 'utf8'));
    _settingsCacheAt = now;
    return _settingsCache;
  } catch (e) {
    return {};
  }
}

// ─── Network Interfaces ───────────────────────────────────────────────────────

function _getLocalIps() {
  const nets = os.networkInterfaces();
  const result = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family !== 'IPv4' || net.internal) continue;
      result.push(net.address);
    }
  }
  return result;
}

function _getNetworkInterfaces() {
  const nets = os.networkInterfaces();
  const result = [];
  for (const [ifaceName, iface] of Object.entries(nets)) {
    for (const net of iface) {
      if (net.family !== 'IPv4' || net.internal) continue;
      result.push({ ifaceName, address: net.address });
    }
  }
  return result;
}

/**
 * Is `origin` one of the origins this server is actually reachable on?
 * Derived from the real bound port + local interfaces — never from the
 * client-controlled Host header.
 * @param {string|undefined} origin
 * @returns {boolean} true when absent (native clients send no Origin)
 */
function _isAllowedOrigin(origin) {
  if (!origin) return true;
  let parsed;
  try { parsed = new URL(origin); } catch (e) { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const boundPort = httpServer?.address()?.port;
  if (!boundPort) return false;
  const originPort = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  if (originPort !== Number(boundPort)) return false;

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1', ..._getLocalIps()]);
  return allowedHosts.has(hostname);
}

/**
 * Same check for a Host header (`ip:port`). Unlike Origin, Host is required.
 * @param {string|undefined} host
 */
function _isAllowedHost(host) {
  if (!host) return false;
  return _isAllowedOrigin(`http://${host}`);
}

// ─── PIN Management ───────────────────────────────────────────────────────────

async function generatePin() {
  const settings = await _loadSettings();
  if (settings.remotePersistentPin && settings.remotePersistentPinValue) {
    const ppin = String(settings.remotePersistentPinValue).padStart(6, '0');
    if (/^\d{6}$/.test(ppin)) {
      _pin = ppin;
      _pinExpiry = Infinity;
      _pinUsed = false;
      console.debug('[Remote] Using persistent PIN');
      return _pin;
    }
  }
  _pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  _pinExpiry = Date.now() + PIN_TTL_MS;
  _pinUsed = false;
  console.debug(`[Remote] New PIN generated (valid 2 min)`);
  return _pin;
}

function _normalizeIp(ip) {
  if (!ip) return 'unknown';
  return String(ip).replace(/^::ffff:/, '');
}

function _pruneAuthAttempts(now) {
  for (const [ip, entry] of _authAttempts.entries()) {
    if (now >= entry.lockoutUntil && now - entry.lastAttemptAt > AUTH_ATTEMPT_TTL_MS) {
      _authAttempts.delete(ip);
    }
  }
}

async function _isPinValid(pin, clientIp) {
  const ip = _normalizeIp(clientIp);
  const now = Date.now();
  _pruneAuthAttempts(now);

  let entry = _authAttempts.get(ip);
  if (!entry) {
    entry = { failures: 0, lockoutUntil: 0, lastAttemptAt: 0 };
    _authAttempts.set(ip, entry);
  }
  // Lockout is scoped to the offending IP — other clients keep working.
  if (now < entry.lockoutUntil) return false;
  entry.lastAttemptAt = now;

  const settings = await _loadSettings();
  const isPersistent = settings.remotePersistentPin && !!settings.remotePersistentPinValue;
  if (_pin !== null && _secretsMatch(_pin, pin) && (isPersistent || (!_pinUsed && now < _pinExpiry))) {
    _authAttempts.delete(ip);
    return true;
  }

  // The counter is deliberately NOT reset on lockout: once an IP has burned
  // through MAX_AUTH_ATTEMPTS, every later failure re-arms the lockout at once
  // instead of handing the attacker a fresh budget of 5 guesses.
  entry.failures++;
  if (entry.failures >= MAX_AUTH_ATTEMPTS) {
    entry.lockoutUntil = now + AUTH_LOCKOUT_MS;
    if (!isPersistent) generatePin();
    console.warn(`[Remote] Too many failed PIN attempts from ${ip} — locked out for ${AUTH_LOCKOUT_MS / 1000}s`);
  }
  return false;
}

function _isTokenValid(token) {
  const entry = _sessionTokens.get(token);
  if (!entry) return false;
  if (Date.now() - entry.issuedAt > TOKEN_TTL_MS) {
    _sessionTokens.delete(token);
    return false;
  }
  return true;
}

async function getPin() {
  const settings = await _loadSettings();
  const isPersistent = settings.remotePersistentPin && !!settings.remotePersistentPinValue;
  return { pin: _pin, expiresAt: isPersistent ? Infinity : _pinExpiry, used: _pinUsed, persistent: isPersistent };
}

// ─── HTTP Handler ─────────────────────────────────────────────────────────────

function _handleHttpRequest(req, res) {
  // CORS — only allow the server's own origin. The expected origin is derived
  // from the real bound port + local interfaces, NOT from the attacker
  // controlled Host header, and a mismatch is rejected outright.
  const origin = req.headers.origin;
  if (origin) {
    if (!_isAllowedOrigin(origin)) {
      console.warn(`[Remote] Request rejected — disallowed origin: ${origin}`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden origin' }));
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  // POST /auth — exchange PIN for session token
  if (req.method === 'POST' && req.url === '/auth') {
    let body = '';
    let bodySize = 0;
    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > MAX_POST_BODY) { req.destroy(); res.writeHead(413); res.end('Payload too large'); return; }
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const { pin } = JSON.parse(body);
        if (!await _isPinValid(pin, req.socket.remoteAddress)) {
          console.warn(`[Remote] Auth failed — wrong or expired PIN`);
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or expired PIN' }));
          return;
        }
        // Generate a session token
        const token = crypto.randomBytes(24).toString('hex');
        _sessionTokens.set(token, { issuedAt: Date.now() });
        const authSettings = await _loadSettings();
        const isPersistentPin = authSettings.remotePersistentPin && !!authSettings.remotePersistentPinValue;
        if (!isPersistentPin) {
          _pinUsed = true;
          generatePin(); // Fresh PIN for next auth
        }
        console.debug(`[Remote] Auth OK — session token issued, ${_sessionTokens.size} active token(s)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token }));
      } catch (e) {
        console.warn(`[Remote] Auth error — bad JSON body`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Static file serving for PWA
  const pwaDir = getPwaDir();
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(pwaDir, urlPath);

  // Security: prevent path traversal (use resolved paths with separator check)
  const normalizedFile = path.resolve(filePath);
  const normalizedBase = path.resolve(pwaDir);
  if (normalizedFile !== normalizedBase && !normalizedFile.startsWith(normalizedBase + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback → index.html
      console.debug(`[Remote] Static 404 ${urlPath} → SPA fallback`);
      fs.readFile(path.join(pwaDir, 'index.html'), (err2, html) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    console.debug(`[Remote] GET ${urlPath} → 200`);
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ─── WebSocket Auth & Message Handling ───────────────────────────────────────

function _handleWsUpgrade(request, socket, head) {
  if (!wss) { socket.destroy(); return; }

  // Origin/Host check — the WS handshake is not subject to the browser's
  // same-origin policy, so a malicious page could otherwise open a socket to
  // this server. Native clients send no Origin and stay gated by the token.
  const origin = request.headers.origin;
  if (!_isAllowedOrigin(origin) || !_isAllowedHost(request.headers.host)) {
    console.warn(`[Remote] WS upgrade rejected — origin="${origin || 'none'}" host="${request.headers.host || 'none'}"`);
    try { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); } catch (e) {}
    socket.destroy();
    return;
  }

  const urlParams = new URLSearchParams(request.url.replace(/^.*\?/, ''));
  const token = urlParams.get('token');

  if (!token || !_isTokenValid(token)) {
    console.warn(`[Remote] WS upgrade rejected — invalid or expired token`);
    // Accepter le WS puis fermer avec code 4401 pour que le client sache que c'est un token invalide
    // (un rejet HTTP 401 sur upgrade est moins fiable sur iOS Safari)
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.close(4401, 'Invalid or expired token');
    });
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    // Close any existing WS for this token
    const existing = _connectedClients.get(token);
    if (existing) { try { existing.close(); } catch (e) {} }

    _connectedClients.set(token, ws);
    _clientMeta.set(token, {
      connectedAt: Date.now(),
      ip: request.socket.remoteAddress || 'unknown',
      userAgent: request.headers['user-agent'] || 'unknown',
    });
    console.debug(`[Remote] WS connected — ${_connectedClients.size} client(s) active`);

    ws.on('message', (raw) => _handleClientMessage(ws, token, raw));
    ws.on('close', (code) => {
      _connectedClients.delete(token);
      _clientMeta.delete(token);
      _sessionTokens.delete(token);
      console.debug(`[Remote] WS disconnected (code: ${code}) — ${_connectedClients.size} client(s) remaining`);
    });
    ws.on('error', (e) => {
      _connectedClients.delete(token);
      _clientMeta.delete(token);
      _sessionTokens.delete(token);
      console.warn(`[Remote] WS error: ${e.message}`);
    });

    // Send full init (hello + projects + sessions + time)
    _sendFullInit(ws);
  });
}

/**
 * Send full init sequence to a client (local WS or external transport proxy).
 * 1. hello (settings: model, effort, accent, language)
 * 2. projects + active sessions + buffered replay (deferred to next tick)
 * 3. time:update snapshot
 * 4. Request fresh time data from renderer
 */
async function _sendFullInit(ws) {
  // 1. hello
  const settings = await _loadSettings();
  _wsSend(ws, 'hello', {
    version: '1.0',
    serverName: 'Claude Terminal',
    chatModel: settings.chatModel || null,
    effortLevel: settings.effortLevel || null,
    accentColor: settings.accentColor || '#d97706',
    language: settings.language || 'fr',
  });
  // 2. projects + sessions (deferred — disk I/O)
  setImmediate(() => _sendProjectsAndSessions(ws));
  // 3. time tracking snapshot
  if (_timeData.todayMs > 0) {
    _wsSend(ws, 'time:update', { todayMs: _timeData.todayMs });
  }
  // 4. Request fresh time data from renderer
  if (_isMainWindowReady()) {
    mainWindow.webContents.send('remote:request-time-push');
  }
}

async function _sendProjectsAndSessions(ws) {
  try {
    let projects = [];
    let folders = [];
    let rootOrder = [];
    if (fs.existsSync(projectsFile)) {
      const raw = await fs.promises.readFile(projectsFile, 'utf8');
      const data = JSON.parse(raw);
      projects = (data.projects || []).map(p => ({
        id: p.id,
        name: p.name,
        path: p.path,
        color: p.color,
        icon: p.icon,
        folderId: p.folderId || null,
      }));
      folders = (data.folders || []).map(f => ({
        id: f.id,
        name: f.name,
        parentId: f.parentId || null,
        children: f.children || [],
        color: f.color,
        icon: f.icon,
      }));
      rootOrder = data.rootOrder || [];
    }

    // Envoyer les projets + hiérarchie via projects:updated
    _wsSend(ws, 'projects:updated', { projects, folders, rootOrder });

    // Collect all sessions to replay: active sessions + any with buffered messages
    const chatService = require('./ChatService');
    const activeSessions = chatService.getActiveSessions();
    const activeIds = new Set(activeSessions.map(s => s.sessionId));

    // Build unified session list: active sessions first, then buffered-only sessions
    const sessionsToSend = [];
    for (const { sessionId, cwd } of activeSessions) {
      const project = projects.find(p => p.path && cwd && (
        cwd.replace(/\\/g, '/').startsWith(p.path.replace(/\\/g, '/'))
      ));
      const projectId = project?.id || _sessionProjectMap.get(sessionId) || null;
      if (projectId) _sessionProjectMap.set(sessionId, projectId);
      const tabName = _sessionTabNames.get(sessionId) || project?.name || 'Chat';
      sessionsToSend.push({ sessionId, projectId, tabName });
    }
    // Add buffered sessions that are no longer active (completed but still in buffer)
    for (const sessionId of _sessionMessageBuffer.keys()) {
      if (!activeIds.has(sessionId)) {
        const projectId = _sessionProjectMap.get(sessionId) || null;
        const tabName = _sessionTabNames.get(sessionId) || 'Chat';
        sessionsToSend.push({ sessionId, projectId, tabName });
      }
    }

    let totalBuffered = 0;
    console.debug(`[Remote] Sending init data — ${projects.length} project(s), ${sessionsToSend.length} session(s) (${activeSessions.length} active, ${sessionsToSend.length - activeSessions.length} buffered)`);
    for (const { sessionId, projectId, tabName } of sessionsToSend) {
      _wsSend(ws, 'session:started', { sessionId, projectId, tabName });

      // Replay buffered chat events for this session
      const buffer = _sessionMessageBuffer.get(sessionId);
      if (buffer && buffer.length > 0) {
        totalBuffered += buffer.length;
        for (const { channel, data } of buffer) {
          _wsSend(ws, channel, data);
        }
      }
    }
    if (totalBuffered > 0) {
      console.debug(`[Remote] Replayed ${totalBuffered} buffered chat event(s)`);
    }
  } catch (e) {
    console.warn(`[Remote] Failed to send init data: ${e.message}`);
  }
}

async function _isRegisteredProjectPath(cwd) {
  try {
    const raw = await fs.promises.readFile(projectsFile, 'utf8');
    const data = JSON.parse(raw);
    const normalized = path.resolve(cwd);
    return (data.projects || []).some(p => path.resolve(p.path) === normalized);
  } catch (e) { return false; }
}

/**
 * Constant-time comparison of two secret strings.
 * Avoids leaking length/content via early-exit timing.
 */
function _secretsMatch(expected, provided) {
  const a = Buffer.from(String(expected), 'utf8');
  const b = Buffer.from(String(provided), 'utf8');
  if (a.length !== b.length) {
    // Still burn a comparison against a fixed-size buffer to reduce timing signal.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

async function _handleClientMessage(ws, token, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }

  const { type, data } = msg;
  if (!type) return;
  if (type !== 'ping') console.debug(`[Remote] ← ${type}`, data ? JSON.stringify(data).slice(0, 120) : '');

  try {
    switch (type) {
      case 'ping':
        _wsSend(ws, 'pong', {});
        break;

      case 'chat:send': {
        const chatService = require('./ChatService');
        const sessionId = data?.sessionId;
        if (!sessionId) { _wsSend(ws, 'chat-error', { error: 'Missing sessionId' }); break; }
        const images = Array.isArray(data.images) ? data.images : [];
        const mentions = Array.isArray(data.mentions) ? data.mentions : [];
        const sessionInfo = chatService.getSessionInfo?.(sessionId);
        const cwd = sessionInfo?.cwd || null;
        _resolveMentions(mentions, cwd).then(resolvedText => {
          const fullText = resolvedText ? (data.text || '') + resolvedText : (data.text || '');
          return chatService.sendMessage(sessionId, fullText, images);
        }).catch(err => {
          console.warn(`[Remote] chat:send error: ${err.message}`);
          _wsSend(ws, 'chat-error', { sessionId, error: err.message });
        });
        // Notify renderer so it can display the user message in ChatView
        if (_isMainWindowReady()) {
          mainWindow.webContents.send('remote:user-message', {
            sessionId,
            text: data.text,
            images: images.map(img => ({
              base64: img.base64,
              mediaType: img.mediaType,
              dataUrl: `data:${img.mediaType};base64,${img.base64}`,
              name: 'image',
            })),
          });
        }
        break;
      }

      case 'chat:start': {
        if (_isMainWindowReady()) {
          const mentions = Array.isArray(data?.mentions) ? data.mentions : [];
          const cwd = data?.cwd;
          // Validate cwd against registered projects to prevent path traversal
          if (cwd && !await _isRegisteredProjectPath(cwd)) {
            _wsSend(ws, 'chat-error', { sessionId: data?.sessionId, error: 'Invalid project path' });
            break;
          }
          const resumeSessionId = data.resumeSessionId || null;
          _resolveMentions(mentions, cwd).then(resolvedText => {
            const prompt = resolvedText ? (data.prompt || '') + resolvedText : (data.prompt || '');
            mainWindow.webContents.send('remote:open-chat-tab', {
              cwd,
              prompt: prompt || null,
              images: Array.isArray(data.images) ? data.images : [],
              sessionId: data.sessionId,
              model: data.model || null,
              effort: data.effort || null,
              resumeSessionId,
            });
          }).catch(() => {
            mainWindow.webContents.send('remote:open-chat-tab', {
              cwd,
              prompt: data?.prompt || null,
              images: Array.isArray(data?.images) ? data.images : [],
              sessionId: data?.sessionId,
              model: data?.model || null,
              effort: data?.effort || null,
              resumeSessionId,
            });
          });
        } else {
          _wsSend(ws, 'chat-error', { sessionId: data?.sessionId, error: 'App window not available' });
        }
        break;
      }

      case 'chat:interrupt': {
        const chatService = require('./ChatService');
        if (data?.sessionId) chatService.interrupt(data.sessionId);
        break;
      }

      case 'chat:permission-response': {
        const chatService = require('./ChatService');
        const { requestId, result } = data || {};
        if (!requestId || typeof result?.behavior !== 'string') {
          console.warn('[Remote] Invalid permission response');
          break;
        }
        // Validate that the requestId exists in pending permissions before resolving
        if (!chatService.pendingPermissions.has(requestId)) {
          console.warn(`[Remote] Permission response for unknown requestId: ${requestId}`);
          break;
        }
        chatService.resolvePermission(requestId, result);
        break;
      }

      case 'git:status': {
        const git = require('../utils/git');
        const cwd = data?.cwd;
        if (!cwd || !await _isRegisteredProjectPath(cwd)) { _wsSend(ws, 'git:status', { error: 'Invalid project path' }); break; }
        git.getGitInfoFull(cwd, { skipFetch: true }).then(info => {
          _wsSend(ws, 'git:status', info);
        }).catch(err => {
          _wsSend(ws, 'git:status', { isGitRepo: false, error: err.message });
        });
        break;
      }

      case 'git:pull': {
        const git = require('../utils/git');
        const cwd = data?.cwd;
        if (!cwd || !await _isRegisteredProjectPath(cwd)) { _wsSend(ws, 'git:pull', { success: false, error: 'Invalid project path' }); break; }
        git.gitPull(cwd).then(result => {
          _wsSend(ws, 'git:pull', result);
          git.getGitInfoFull(cwd, { skipFetch: true }).then(info => _wsSend(ws, 'git:status', info)).catch(() => {});
        }).catch(err => {
          _wsSend(ws, 'git:pull', { success: false, error: err.message });
        });
        break;
      }

      case 'git:push': {
        const git = require('../utils/git');
        const cwd = data?.cwd;
        if (!cwd || !await _isRegisteredProjectPath(cwd)) { _wsSend(ws, 'git:push', { success: false, error: 'Invalid project path' }); break; }
        git.gitPush(cwd).then(result => {
          _wsSend(ws, 'git:push', result);
          git.getGitInfoFull(cwd, { skipFetch: true }).then(info => _wsSend(ws, 'git:status', info)).catch(() => {});
        }).catch(err => {
          _wsSend(ws, 'git:push', { success: false, error: err.message });
        });
        break;
      }

      case 'mention:file-list': {
        const cwd = await _resolveProjectPath(data?.projectId);
        if (!cwd) { _wsSend(ws, 'mention:file-list', { files: [] }); break; }
        _getProjectFiles(cwd).then(files => {
          _wsSend(ws, 'mention:file-list', { files });
        }).catch(() => {
          _wsSend(ws, 'mention:file-list', { files: [] });
        });
        break;
      }

      case 'settings:update': {
        const chatService = require('./ChatService');
        const { sessionId, model, effort } = data || {};
        const ops = [];
        let anyFailed = false;
        if (model && sessionId) {
          ops.push(chatService.setModel(sessionId, model).catch(err => {
            anyFailed = true;
            _wsSend(ws, 'chat-error', { sessionId, error: `Model change failed: ${err.message}` });
          }));
        }
        if (effort && sessionId) {
          ops.push(chatService.setEffort(sessionId, effort).catch(err => {
            anyFailed = true;
            _wsSend(ws, 'chat-error', { sessionId, error: `Effort change failed: ${err.message}` });
          }));
        }
        Promise.all(ops).then(() => {
          if (!anyFailed) _wsSend(ws, 'settings:updated', { sessionId, model, effort });
        });
        break;
      }

      case 'request:init': {
        // Mobile (cloud or local) is requesting initial state
        console.debug('[Remote] ← request:init — sending hello + projects + sessions');
        const settings = await _loadSettings();
        _wsSend(ws, 'hello', {
          version: '1.0',
          serverName: 'Claude Terminal',
          chatModel: settings.chatModel || null,
          effortLevel: settings.effortLevel || null,
          accentColor: settings.accentColor || '#d97706',
          language: settings.language || 'fr',
        });
        setImmediate(() => {
          _sendProjectsAndSessions(ws);
          _wsSend(ws, 'time:update', _timeData);
          if (_isMainWindowReady()) {
            mainWindow.webContents.send('remote:request-time-push');
          }
        });
        break;
      }

      case 'webhook:trigger': {
        const { workflowId, payload, triggeredAt, secret, headers } = data || {};
        if (!workflowId || typeof workflowId !== 'string') {
          console.warn('[Remote] webhook:trigger: missing or invalid workflowId');
          break;
        }
        try {
          const workflowService = require('./WorkflowService');

          // Load the target workflow and enforce that it is actually a webhook
          // trigger — otherwise any client could fire ANY workflow by id.
          const wf = await workflowService.getWorkflow(workflowId);
          if (!wf) {
            console.warn(`[Remote] webhook:trigger: workflow not found: ${workflowId}`);
            _wsSend(ws, 'webhook:result', { workflowId, success: false, error: 'Workflow not found' });
            break;
          }
          if (wf.trigger?.type !== 'webhook') {
            console.warn(`[Remote] webhook:trigger: workflow ${workflowId} is not a webhook trigger`);
            _wsSend(ws, 'webhook:result', { workflowId, success: false, error: 'Workflow is not a webhook trigger' });
            break;
          }

          // Optional per-workflow secret. When set, the caller must present the
          // matching value (via payload.secret, an explicit `secret`, or an
          // x-webhook-secret header). Compared in constant time.
          const expectedSecret = wf.trigger.webhookSecret;
          if (expectedSecret) {
            const provided =
              secret ||
              (payload && payload.secret) ||
              (headers && (headers['x-webhook-secret'] || headers['X-Webhook-Secret'])) ||
              '';
            if (!_secretsMatch(String(expectedSecret), String(provided))) {
              console.warn(`[Remote] webhook:trigger: invalid secret for ${workflowId}`);
              _wsSend(ws, 'webhook:result', { workflowId, success: false, error: 'Invalid webhook secret' });
              break;
            }
          }

          console.log(`[Remote] webhook:trigger workflowId=${workflowId}`);
          workflowService.trigger(workflowId, {
            source: 'webhook',
            triggerData: {
              source: 'webhook',
              payload: payload || {},
              triggeredAt: triggeredAt || new Date().toISOString(),
            },
          }).catch(err => {
            console.error(`[Remote] webhook:trigger failed for ${workflowId}:`, err.message);
          });
        } catch (e) {
          console.warn('[Remote] webhook:trigger: WorkflowService not available:', e.message);
        }
        break;
      }

      case 'sessions:list-past': {
        const cwd = await _resolveProjectPath(data?.projectId);
        if (!cwd) { _wsSend(ws, 'sessions:past', { projectId: data?.projectId, sessions: [] }); break; }
        const { getClaudeSessions } = require('../ipc/claude.ipc');
        getClaudeSessions(cwd).then(sessions => {
          _wsSend(ws, 'sessions:past', { projectId: data.projectId, sessions });
        }).catch(() => {
          _wsSend(ws, 'sessions:past', { projectId: data.projectId, sessions: [] });
        });
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.warn(`[Remote] Error handling ${type}: ${err.message}`);
  }
}

// ─── Mention Resolution ──────────────────────────────────────────────────────

async function _resolveMentions(mentions, cwd) {
  if (!mentions || !mentions.length) return '';
  const blocks = [];

  for (const mention of mentions) {
    let content = '';
    switch (mention.type) {
      case 'file': {
        // Only allow relative paths resolved within cwd — no fullPath from remote clients
        const relativePath = mention.data?.path;
        if (!relativePath || !cwd) { content = '[No file path]'; break; }
        const filePath = path.resolve(cwd, relativePath);
        // Containment check: file must be within the project directory
        const resolvedCwd = path.resolve(cwd);
        if (!filePath.startsWith(resolvedCwd + path.sep) && filePath !== resolvedCwd) {
          content = '[File path outside project directory]';
          break;
        }
        try {
          const stats = fs.statSync(filePath);
          if (stats.size > MAX_MENTION_FILE_SIZE) {
            content = `[File too large: ${(stats.size / 1024 / 1024).toFixed(1)} MB]`;
            break;
          }
          const raw = fs.readFileSync(filePath, 'utf8');
          const lines = raw.split('\n');
          const displayPath = relativePath;
          content = lines.length > 500
            ? `File: ${displayPath} (first 500/${lines.length} lines)\n\n${lines.slice(0, 500).join('\n')}`
            : `File: ${displayPath}\n\n${raw}`;
        } catch (e) {
          content = `[Error reading file: ${relativePath}]`;
        }
        break;
      }

      case 'git': {
        if (!cwd) { content = '[No project path]'; break; }
        try {
          const git = require('../utils/git');
          const status = await git.getGitStatusDetailed(cwd);
          if (!status?.success || !status.files?.length) { content = '[No git changes]'; break; }
          const diffs = [];
          for (const file of status.files.slice(0, 15)) {
            try {
              const d = await git.getFileDiff(cwd, file.path);
              if (d) diffs.push(`--- ${file.path} ---\n${d}`);
            } catch (e) {}
          }
          content = diffs.length > 0
            ? `Git Changes (${status.files.length} files):\n\n${diffs.join('\n\n')}`
            : `Git Status: ${status.files.length} changed files\n${status.files.map(f => `  ${f.status || '?'} ${f.path}`).join('\n')}`;
        } catch (e) { content = '[Error fetching git info]'; }
        break;
      }

      case 'terminal':
        // Terminal output can't be resolved in main process (it lives in renderer xterm)
        // The renderer will inject terminal context via the SDK conversation
        content = '[Terminal output is available in the active terminal on desktop]';
        break;

      case 'errors':
        content = '[Error output is available in the active terminal on desktop]';
        break;

      case 'todos': {
        if (!cwd) { content = '[No project path]'; break; }
        try {
          const { execFile } = require('child_process');
          const { promisify } = require('util');
          const exec = promisify(execFile);
          const { stdout } = await exec('git', ['grep', '-n', '-E', 'TODO|FIXME|HACK|XXX', '--', '*.js', '*.ts', '*.py', '*.lua', '*.jsx', '*.tsx'], {
            cwd, timeout: 5000, maxBuffer: 1024 * 1024,
          });
          const lines = stdout.split('\n').filter(Boolean).slice(0, 50);
          content = lines.length > 0
            ? `TODO Items (${lines.length}):\n\n${lines.join('\n')}`
            : '[No TODOs found]';
        } catch (e) {
          content = '[No TODOs found or error scanning]';
        }
        break;
      }

      default:
        content = `[Unknown mention: ${mention.type}]`;
    }

    blocks.push(`\n\n---\n@${mention.type}:\n${content}`);
  }

  return blocks.join('');
}

// ─── File Listing Helpers ─────────────────────────────────────────────────────

async function _resolveProjectPath(projectId) {
  if (!projectId) return null;
  try {
    const raw = await fs.promises.readFile(projectsFile, 'utf8');
    const data = JSON.parse(raw);
    const proj = (data.projects || []).find(p => p.id === projectId);
    return proj?.path || null;
  } catch (e) {}
  return null;
}

async function _getProjectFiles(cwd, maxFiles = 500) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const exec = promisify(execFile);
  const files = [];

  try {
    // Try git ls-files first (fast, respects .gitignore)
    const { stdout } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd,
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const lines = stdout.split('\n').filter(Boolean);
    for (const line of lines.slice(0, maxFiles)) {
      files.push({ path: line });
    }
  } catch (e) {
    // Fallback: simple recursive readdir (1 level)
    try {
      const entries = fs.readdirSync(cwd, { withFileTypes: true });
      for (const entry of entries.slice(0, maxFiles)) {
        if (entry.isFile() && !entry.name.startsWith('.')) {
          files.push({ path: entry.name });
        }
      }
    } catch (e2) {}
  }
  return files;
}

// ─── Broadcast Helpers ────────────────────────────────────────────────────────

function _isMainWindowReady() {
  return mainWindow && !mainWindow.isDestroyed();
}

function _wsSend(ws, type, data) {
  if (ws.readyState === 1 /* OPEN */) {
    try { ws.send(JSON.stringify({ type, data })); } catch (e) {
      console.warn(`[Remote] Failed to send ${type}: ${e.message}`);
    }
  }
}

function _broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  // Local WS clients
  for (const ws of _connectedClients.values()) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch (e) {}
    }
  }
  // External transport — forward to remote clients (e.g. cloud relay)
  if (_externalTransport?.connected) {
    try { _externalTransport.send(msg); } catch (e) {}
  }
}

async function broadcastProjectsUpdate(projects) {
  const light = (projects || []).map(p => ({
    id: p.id, name: p.name, path: p.path, color: p.color, icon: p.icon,
    folderId: p.folderId || null,
  }));
  // Read folders + rootOrder from disk for hierarchy
  let folders = [];
  let rootOrder = [];
  try {
    const raw = await fs.promises.readFile(projectsFile, 'utf8');
    const data = JSON.parse(raw);
    folders = (data.folders || []).map(f => ({
      id: f.id, name: f.name, parentId: f.parentId || null,
      children: f.children || [], color: f.color, icon: f.icon,
    }));
    rootOrder = data.rootOrder || [];
  } catch (e) {}
  _broadcast('projects:updated', { projects: light, folders, rootOrder });
}

function broadcastSessionStarted({ sessionId, projectId, tabName }) {
  console.debug(`[Remote] → broadcast session:started sessionId=${sessionId} projectId=${projectId} tabName=${tabName}`);
  if (projectId) _sessionProjectMap.set(sessionId, projectId);
  if (tabName) _sessionTabNames.set(sessionId, tabName);
  _broadcast('session:started', { sessionId, projectId, tabName: tabName || 'Chat' });
}

function broadcastTabRenamed({ sessionId, tabName }) {
  if (tabName) _sessionTabNames.set(sessionId, tabName);
  _broadcast('session:tab-renamed', { sessionId, tabName });
}

function setTimeData({ todayMs }) {
  _timeData.todayMs = todayMs || 0;
  _broadcast('time:update', { todayMs: _timeData.todayMs });
}

// ─── Auto-Start / Stop Logic ──────────────────────────────────────────────────

async function _syncServerState() {
  const settings = await _loadSettings();
  const shouldRun = !!settings.remoteEnabled;

  if (shouldRun && !httpServer) {
    const port = settings.remotePort || 3712;
    start(mainWindow, port);
  } else if (!shouldRun && httpServer) {
    stop();
  }
}

// ─── ChatService Bridge ──────────────────────────────────────────────────────
// The callback bridges ChatService events (chat-message, chat-idle, etc.)
// to both local WS clients AND the external transport. It must be installed
// whenever either the local remote server OR an external transport is active.

let _chatBridgeInstalled = false;

function _ensureChatBridge() {
  if (_chatBridgeInstalled) return;
  _chatBridgeInstalled = true;
  console.debug('[Remote] Installing chat bridge callback');

  const chatService = require('./ChatService');
  chatService.setRemoteEventCallback((channel, data) => {
    const relayed = ['chat-message', 'chat-idle', 'chat-done', 'chat-error', 'chat-permission-request', 'chat-user-message', 'session:closed', 'session:tab-renamed'];
    if (!relayed.includes(channel)) return;
    if (channel === 'chat-user-message') {
      console.debug(`[Remote] Bridge received chat-user-message sid=${data?.sessionId} text="${(data?.text || '').slice(0, 50)}"`);
    }

    let enriched = data;
    // Enrich chat-idle / chat-permission-request with cached projectId
    if ((channel === 'chat-idle' || channel === 'chat-permission-request') && data?.sessionId) {
      const cachedProjectId = _sessionProjectMap.get(data.sessionId);
      if (cachedProjectId) {
        enriched = { ...data, projectId: cachedProjectId };
      }
    }

    // Buffer chat events per session for late-joining clients
    const sid = data?.sessionId;
    if (sid) {
      const buffered = ['chat-message', 'chat-user-message', 'chat-permission-request', 'chat-idle', 'chat-done'];
      if (buffered.includes(channel)) {
        if (!_sessionMessageBuffer.has(sid)) _sessionMessageBuffer.set(sid, []);
        const buf = _sessionMessageBuffer.get(sid);
        buf.push({ channel, data: enriched });
        if (buf.length > MAX_BUFFER_PER_SESSION) buf.shift();
        if (channel !== 'chat-message') {
          console.debug(`[Remote] Buffered ${channel} for session ${sid} (buffer size: ${buf.length})`);
        }
      }
      // Clean up maps only on explicit session close (keep buffer for reconnecting clients)
      if (channel === 'session:closed') {
        _sessionMessageBuffer.delete(sid);
        _sessionProjectMap.delete(sid);
        _sessionTabNames.delete(sid);
      }
    }

    if (channel !== 'chat-message') {
      console.debug(`[Remote] → broadcast ${channel} sessionId=${data?.sessionId} clients=${_connectedClients.size}`);
    }
    _broadcast(channel, enriched);
  });
}

function _teardownChatBridge() {
  if (!_chatBridgeInstalled) return;
  // Only remove if neither local server nor external transport are registered
  if (httpServer || _externalTransport) return;
  _chatBridgeInstalled = false;
  try {
    const chatService = require('./ChatService');
    chatService.setRemoteEventCallback(null);
  } catch (e) {}
}

// ─── Stale Buffer Cleanup ─────────────────────────────────────────────────────

function _cleanupStaleBuffers() {
  try {
    const chatService = require('./ChatService');
    const activeSessions = chatService.getActiveSessions();
    const activeIds = new Set(activeSessions.map(s => s.sessionId));
    let cleaned = 0;

    for (const sid of _sessionMessageBuffer.keys()) {
      if (!activeIds.has(sid)) {
        _sessionMessageBuffer.delete(sid);
        _sessionProjectMap.delete(sid);
        _sessionTabNames.delete(sid);
        cleaned++;
      }
    }
    // Also clean orphan entries in project/tab maps not in buffer or active
    for (const sid of _sessionProjectMap.keys()) {
      if (!activeIds.has(sid) && !_sessionMessageBuffer.has(sid)) {
        _sessionProjectMap.delete(sid);
        _sessionTabNames.delete(sid);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.debug(`[Remote] Cleaned ${cleaned} stale session buffer(s)`);
    }
  } catch (e) {
    // ChatService not available yet, skip
  }
}

function _startCleanupTimer() {
  if (_cleanupTimer) return;
  _cleanupTimer = setInterval(_cleanupStaleBuffers, BUFFER_CLEANUP_INTERVAL_MS);
  _cleanupTimer.unref?.(); // Don't prevent process exit
}

function _stopCleanupTimer() {
  if (_cleanupTimer) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

function start(win, port = 3712) {
  if (httpServer) return;
  mainWindow = win;

  httpServer = http.createServer(_handleHttpRequest);
  wss = new WebSocketServer({
    noServer: true,
    maxPayload: WS_MAX_PAYLOAD,
    perMessageDeflate: {
      zlibDeflateOptions: { level: 1 },  // fast compression
      threshold: 128,                     // only compress messages > 128 bytes
    },
  });
  httpServer.on('upgrade', _handleWsUpgrade);

  httpServer.listen(port, '0.0.0.0', () => {
    const ips = _getLocalIps();
    console.debug(`[Remote] Server started on port ${port}`);
    ips.forEach(ip => console.debug(`[Remote]   → http://${ip}:${port}`));
  });

  httpServer.on('error', (e) => {
    console.error(`[Remote] Server error: ${e.message}`);
    stop(); // Full cleanup including wss, callback, clients
  });

  // Bridge ChatService events → connected WS clients + external transport
  _ensureChatBridge();
  _startCleanupTimer();
}

async function stop() {
  for (const ws of _connectedClients.values()) {
    try { ws.close(); } catch (e) {}
  }
  _connectedClients.clear();
  _clientMeta.clear();
  if (_externalTransport) {
    // Relay sessions are independent of the LAN server — toggling the local
    // server off must not silently drop a phone back to read-only.
    for (const token of _sessionTokens.keys()) {
      if (!_relayTokens.has(token)) _sessionTokens.delete(token);
    }
  } else {
    _sessionTokens.clear();
    _relayTokens.clear();
  }
  _pin = null;
  _authAttempts.clear();

  if (wss) {
    await new Promise(resolve => { const s = wss; wss = null; s.close(resolve); });
  }
  if (httpServer) {
    await new Promise(resolve => { const s = httpServer; httpServer = null; s.close(resolve); });
  }

  // Only clear shared caches if no external transport is registered
  if (!_externalTransport) {
    _sessionProjectMap.clear();
    _sessionMessageBuffer.clear();
    _sessionTabNames.clear();
  }

  // Only remove chat bridge if external transport is also disconnected
  _teardownChatBridge();

  // Stop cleanup timer only if external transport is also disconnected
  if (!_externalTransport) {
    _stopCleanupTimer();
  }

  console.debug('[Remote] Server stopped');
}

function setMainWindow(win) {
  mainWindow = win;
  // No auto-start — user must explicitly start the server or connect cloud
}

// ─── External Transport API ──────────────────────────────────────────────────

/**
 * Inject an external transport for bridging messages beyond local Wi-Fi.
 * The transport must implement: { connected: boolean, send(data: string): void }
 * @param {{ connected: boolean, send: (data: string) => void } | null} transport
 */
function setExternalTransport(transport) {
  _externalTransport = transport;
  _externalTransportConnectedAt = transport ? Date.now() : 0;
  if (transport) {
    // Ensure chat bridge is active so events flow to external transport
    // even if the local WS remote server isn't started
    _ensureChatBridge();
    _startCleanupTimer();
  } else {
    // Transport released — every session token minted over it dies with it, so a
    // reconnecting phone has to present the PIN again rather than resurrecting a
    // token nobody can revoke.
    for (const token of _relayTokens) _sessionTokens.delete(token);
    _relayTokens.clear();
    // Teardown bridge and cleanup timer if local server also inactive
    _teardownChatBridge();
    if (!httpServer) _stopCleanupTimer();
  }
}

// ─── Relay Session Auth ──────────────────────────────────────────────────────
//
// A mobile arriving over the relay authenticates exactly like a LAN mobile: it
// presents the 6-digit PIN shown in Settings → Remote Control and gets back a
// session token from the same _sessionTokens map. The only difference is the
// carrier — POST /auth is not reachable through the relay, so the exchange is
// tunnelled as two ordinary {type, data} frames the relay already knows how to
// forward:
//
//   mobile  → { type: 'auth:pin',    data: { pin, nonce }, clientId }
//   desktop → { type: 'auth:result', data: { ok, token?, error?, nonce, clientId } }
//
// Threat model, stated plainly: the relay sees every frame in clear, so it — and
// any other mobile already holding the cloud API key — can observe a handshake
// in flight. That is unchanged from LAN, where the token crosses the Wi-Fi in
// clear too. What the PIN buys is that possession of the cloud API key ALONE no
// longer grants write access: the caller must additionally read a rotating code
// off the desktop screen.
//
// The relay gives us no client IP, so brute-force attempts over it all share a
// single lockout bucket. A client-supplied id is deliberately NOT used as the
// bucket key: an attacker would just rotate it for an unlimited PIN budget.
const RELAY_AUTH_BUCKET = 'relay';

/** Extract the optional, client-supplied correlation id (echoed, never trusted). */
function _externalClientId(parsed) {
  const raw = parsed && parsed.clientId;
  return typeof raw === 'string' ? raw.slice(0, 64) : null;
}

/**
 * Handle an `auth:pin` frame from the relay: validate the PIN and, on success,
 * mint a session token with the same lifetime and validation path as a LAN one.
 * @param {object} parsed
 */
async function _handleRelayAuth(parsed) {
  const data = parsed.data || {};
  const nonce = typeof data.nonce === 'string' ? data.nonce.slice(0, 64) : null;
  const clientId = _externalClientId(parsed);
  const reply = (payload) => _wsSend(_externalWsProxy, 'auth:result', { nonce, clientId, ...payload });

  if (_pin === null) {
    reply({ ok: false, error: 'No PIN available — open Settings → Remote Control on the desktop' });
    return;
  }
  if (typeof data.pin !== 'string' || !/^\d{6}$/.test(data.pin)) {
    reply({ ok: false, error: 'Invalid or expired PIN' });
    return;
  }
  if (!await _isPinValid(data.pin, RELAY_AUTH_BUCKET)) {
    console.warn('[Remote] Relay auth failed — wrong or expired PIN');
    reply({ ok: false, error: 'Invalid or expired PIN' });
    return;
  }

  const token = crypto.randomBytes(24).toString('hex');
  _sessionTokens.set(token, { issuedAt: Date.now() });
  _relayTokens.add(token);

  const settings = await _loadSettings();
  const isPersistentPin = settings.remotePersistentPin && !!settings.remotePersistentPinValue;
  if (!isPersistentPin) {
    _pinUsed = true;
    generatePin(); // Fresh PIN for next auth — same one-shot rule as POST /auth
  }
  console.debug(`[Remote] Relay auth OK — session token issued, ${_sessionTokens.size} active token(s)`);
  reply({ ok: true, token });
}

// Message types accepted from an external transport that has NOT presented a
// valid session token. The relay protocol authenticates the desktop and the
// mobile against the relay server with a shared API key, but carries no
// per-client session token — so an untokened relay message is trusted only for
// read-only operations.
const EXTERNAL_READONLY_TYPES = new Set([
  'ping',
  'request:init',
  'git:status',
  'mention:file-list',
  'sessions:list-past',
]);

// Types that start work, mutate state, or approve a Claude tool permission.
// These require a session token — issued by POST /auth on the LAN, or by the
// `auth:pin` handshake over the relay — exactly like a local WS client.
//
// These two sets are an ALLOWLIST, not just a privilege split: a type absent
// from both is ignored on the relay path whether or not a valid token is
// presented. A handler added to the switch in _handleClientMessage therefore
// stays unreachable from the relay until someone deliberately classifies it here.
const EXTERNAL_PRIVILEGED_TYPES = new Set([
  'chat:send',
  'chat:start',
  'chat:interrupt',
  'chat:permission-response',
  'git:pull',
  'git:push',
  'settings:update',
  'webhook:trigger',
]);

/**
 * Handle a message arriving from an external transport (e.g. cloud relay).
 * Routes it through the same handler as local WS messages, but only after the
 * same authentication check — a relay message is NOT implicitly trusted.
 * @param {object|string} msg - Parsed JSON message
 */
function handleExternalMessage(msg) {
  let parsed = msg;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch (e) { return; }
  }
  if (!parsed || typeof parsed !== 'object') return;

  const type = parsed.type;
  if (!type) return;

  const clientId = _externalClientId(parsed);

  // PIN handshake. Handled inline and returned on unconditionally, BEFORE the
  // token branch, so `auth:pin` can never be routed into _handleClientMessage —
  // not even by presenting a valid token alongside it.
  if (type === 'auth:pin') {
    _handleRelayAuth(parsed).catch(e => console.warn(`[Remote] Relay auth error: ${e.message}`));
    return;
  }

  const dispatch = (token) => _handleClientMessage(
    _externalWsProxy,
    token,
    Buffer.from(JSON.stringify({ type, data: parsed.data })),
  );

  // A relayed client that completed the PIN handshake carries its session token
  // on every frame. Validate it through the exact same check as local clients
  // and grant the same privileges — that is what lifts the read-only restriction.
  const token = parsed.token || parsed.sessionToken || (parsed.auth && parsed.auth.token) || null;
  if (token) {
    if (!_isTokenValid(token)) {
      console.warn(`[Remote] Rejected external "${type}" — invalid or expired session token`);
      _wsSend(_externalWsProxy, 'remote:rejected', {
        type,
        clientId,
        reason: 'invalid-token',
        error: 'Invalid or expired session token',
      });
      return;
    }
    // Fail-closed even once authenticated: a handler added to the switch later
    // stays unreachable over the relay until it is explicitly classified in one
    // of the two sets above. Authentication lifts the read-only restriction, it
    // does not widen the surface.
    if (!EXTERNAL_READONLY_TYPES.has(type) && !EXTERNAL_PRIVILEGED_TYPES.has(type)) {
      console.debug(`[Remote] Ignored external "${type}" — not classified for the relay path`);
      return;
    }
    dispatch(token);
    return;
  }

  if (EXTERNAL_READONLY_TYPES.has(type)) {
    dispatch('__external__');
    return;
  }

  if (EXTERNAL_PRIVILEGED_TYPES.has(type)) {
    console.warn(`[Remote] Rejected external "${type}" — no session token (PIN handshake required)`);
    _wsSend(_externalWsProxy, 'remote:rejected', {
      type,
      clientId,
      reason: 'auth-required',
      error: 'Unauthorized: this action requires an authenticated session',
    });
    return;
  }
  // Relay control/sync traffic (cloud:project-updated, sync:entity-changed, …)
  // is consumed in cloud-relay.ipc.js — drop it here without noise.
}

/**
 * Get initialization data for an external transport client.
 * Returns an array of messages to send (hello, projects, sessions, time).
 * The caller is responsible for sending them via the transport.
 * @returns {{ sendInit: (sendFn: Function) => void, requestTimePush: () => void }}
 */
function sendInitToTransport() {
  if (!_externalTransport?.connected) return;
  console.debug('[Remote] Sending init data to external transport');
  _sendFullInit(_externalWsProxy);
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function getServerInfo() {
  const settings = await _loadSettings();
  const port = settings.remotePort || 3712;
  const ifaces = _getNetworkInterfaces();
  const ips = ifaces.map(i => i.address);
  const selectedIp = settings.remoteSelectedIp || ips[0] || 'localhost';
  return {
    running: !!httpServer,
    port,
    localIps: ips,
    networkInterfaces: ifaces,
    selectedIp,
    address: httpServer ? `http://${selectedIp}:${port}` : null,
    connectedCount: _connectedClients.size,
  };
}

function getConnectedClients() {
  const clients = [];
  for (const [token] of _connectedClients.entries()) {
    const meta = _clientMeta.get(token) || {};
    clients.push({
      id: token.slice(0, 8),
      type: 'local',
      connectedAt: meta.connectedAt || 0,
      ip: meta.ip || 'unknown',
      userAgent: meta.userAgent || 'unknown',
    });
  }
  // Add cloud relay as a virtual client when connected
  if (_externalTransport?.connected) {
    clients.push({
      id: 'cloud',
      type: 'relay',
      connectedAt: _externalTransportConnectedAt,
      ip: 'relay',
      userAgent: 'Cloud Relay',
      authenticatedSessions: _relayTokens.size,
    });
  }
  return clients;
}

function disconnectClient(clientId) {
  // The relay is one virtual client with no socket of its own, so "disconnect"
  // means revoking every session token issued over it: relayed phones drop back
  // to read-only until they present the PIN again.
  if (clientId === 'cloud') {
    if (!_relayTokens.size) return false;
    for (const token of _relayTokens) _sessionTokens.delete(token);
    _relayTokens.clear();
    _wsSend(_externalWsProxy, 'remote:rejected', {
      type: null,
      reason: 'revoked',
      error: 'Session revoked by administrator',
    });
    return true;
  }
  for (const [token, ws] of _connectedClients.entries()) {
    if (token.slice(0, 8) === clientId) {
      try { ws.close(4403, 'Disconnected by administrator'); } catch (e) {}
      _connectedClients.delete(token);
      _clientMeta.delete(token);
      _sessionTokens.delete(token);
      return true;
    }
  }
  return false;
}

module.exports = {
  start,
  stop,
  setMainWindow,
  getPin,
  generatePin,
  getServerInfo,
  getConnectedClients,
  disconnectClient,
  broadcastProjectsUpdate,
  broadcastSessionStarted,
  broadcastTabRenamed,
  setTimeData,
  setExternalTransport,
  handleExternalMessage,
  sendInitToTransport,
  _syncServerState,
};
