/**
 * RemoteServer
 * WebSocket + HTTP server that serves the mobile PWA and bridges
 * Claude Terminal state/events to connected mobile devices.
 *
 * Auth flow:
 *  1. User enables Remote in settings → server starts
 *  2. A 4-digit PIN is shown in settings (rotates every 2 min or on demand)
 *  3. Mobile opens http://<ip>:<port>, enters PIN → POST /auth { pin }
 *     → server returns a session token (valid for the server lifetime)
 *  4. Mobile connects WS with ?token=<sessionToken>
 *  5. On reconnect, mobile uses stored session token directly
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
const _connectedClients = new Map(); // Map<sessionToken, WebSocket>
const _clientMeta = new Map(); // Map<sessionToken, { connectedAt, ip, userAgent }>

// Brute-force protection
let _failedAttempts = 0;
let _lockoutUntil = 0;

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

async function _isPinValid(pin) {
  if (Date.now() < _lockoutUntil) return false;
  const settings = await _loadSettings();
  const isPersistent = settings.remotePersistentPin && !!settings.remotePersistentPinValue;
  if (_pin !== null && pin === _pin && (isPersistent || (!_pinUsed && Date.now() < _pinExpiry))) {
    _failedAttempts = 0;
    return true;
  }
  _failedAttempts++;
  if (_failedAttempts >= MAX_AUTH_ATTEMPTS) {
    _lockoutUntil = Date.now() + AUTH_LOCKOUT_MS;
    _failedAttempts = 0;
    if (!isPersistent) generatePin();
    console.warn('[Remote] Too many failed PIN attempts — locked out for 60s');
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
  // CORS headers — only allow same-origin (PWA is served from this server)
  const origin = req.headers.origin;
  if (origin) {
    // Only allow requests from the server's own origin
    const serverOrigin = `http://${req.headers.host}`;
    if (origin === serverOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
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
        if (!await _isPinValid(pin)) {
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
        const { workflowId, payload, triggeredAt } = data || {};
        if (!workflowId || typeof workflowId !== 'string') {
          console.warn('[Remote] webhook:trigger: missing or invalid workflowId');
          break;
        }
        try {
          const workflowService = require('./WorkflowService');
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
  _sessionTokens.clear();
  _pin = null;
  _failedAttempts = 0;
  _lockoutUntil = 0;

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
    // Transport released - teardown bridge and cleanup timer if local server also inactive
    _teardownChatBridge();
    if (!httpServer) _stopCleanupTimer();
  }
}

/**
 * Handle a message arriving from an external transport (e.g. cloud relay).
 * Routes it through the same handler as local WS messages.
 * @param {object|string} msg - Parsed JSON message
 */
function handleExternalMessage(msg) {
  const raw = typeof msg === 'string' ? msg : JSON.stringify(msg);
  _handleClientMessage(_externalWsProxy, '__external__', Buffer.from(raw));
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
    });
  }
  return clients;
}

function disconnectClient(clientId) {
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
