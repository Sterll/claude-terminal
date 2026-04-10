/**
 * Claude Terminal Remote — PWA JavaScript
 * Auth flow: enter PIN → POST /auth → get session token → WS connect
 *
 * Message format mirrors ChatView.js handling of Agent SDK messages:
 *  - system        → init/config (ignore)
 *  - stream_event  → streaming (message_start, content_block_start/delta/stop, message_stop)
 *  - assistant     → full message with content blocks (text + tool_use + tool_result)
 *  - result        → turn completion (cost, tokens, final text)
 */

const _debugLog = console.log.bind(console);

// ─── i18n (provided by i18n.js loaded before this file) ──────────────────────

const { t } = window.i18n;

// ─── Tool Icons (SVG) ─────────────────────────────────────────────────────────

const TOOL_ICONS = {
  bash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  read: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  write: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
  edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
  grep: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  glob: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  task: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>',
  _default: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

function getToolIcon(name) {
  return TOOL_ICONS[(name || '').toLowerCase()] || TOOL_ICONS._default;
}

function getToolDisplayInfo(toolName, input) {
  if (!input) return '';
  const name = (toolName || '').toLowerCase();
  if (name === 'bash') return input.command || '';
  if (name === 'read' || name === 'write' || name === 'edit') return input.file_path || '';
  if (name === 'grep' || name === 'glob') return input.pattern || '';
  if (name === 'task') return input.description || input.prompt?.slice(0, 60) || '';
  return input.file_path || input.path || input.command || input.query || '';
}

// ─── State ────────────────────────────────────────────────────────────────────

const MODEL_OPTIONS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
];

const EFFORT_OPTIONS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

const state = {
  projects: [],
  folders: [],
  rootOrder: [],
  collapsedFolders: JSON.parse(localStorage.getItem('remote_collapsed_folders') || '{}'),
  selectedProjectId: null,
  sessions: {},           // { [sessionId]: Session }
  selectedSessionId: null,
  pendingPermissions: new Map(), // Map<requestId, permData>
  currentView: 'projects',
  todayMs: 0,
  _pendingUserMessage: null,
  selectedModel: 'claude-sonnet-4-6',
  selectedEffort: 'high',
  inProjectHub: false,
  slashCommands: [], // Dynamic slash commands from SDK
  fileList: [], // File list for @file picker [{path, fullPath}]
  pastSessions: {}, // { [projectId]: Session[] } — historical sessions from disk
  // Headless cloud mode
  cloudSessionMode: false,    // true when running headless via cloud API
  desktopOffline: false,      // true when desktop is offline (relay mode)
  _headlessSessionId: null,   // active headless session ID on cloud
};

// Session shape:
// {
//   sessionId, projectId, tabName,
//   messages[]: { role, content, toolName?, toolId?, toolInput?, toolOutput?, status? },
//   streaming: '', streamEl: null, hasToolUse: false,
//   toolInputBuffers: Map<blockIdx, string>,
//   toolCards: Map<blockIdx, { toolId, toolName }>,
//   currentBlockIdx: -1, currentBlockType: null,
// }

// ─── Session Persistence ──────────────────────────────────────────────────────
// Sessions are fully server-authoritative: on (re)connect the server replays
// all buffered chat events.  No client-side storage needed.

function _saveSessions() {
  // No-op — server is the source of truth.
  // Kept as a callable stub so existing call-sites don't need changes.
}

function _restoreSessions() {
  // Clean up legacy sessionStorage keys from previous versions
  try {
    sessionStorage.removeItem('remote_sessions');
    sessionStorage.removeItem('remote_selected_session');
    sessionStorage.removeItem('remote_selected_project');
  } catch (_) {}
}

// ─── Connection State Machine ──────────────────────────────────────────────────

const conn = {
  token: localStorage.getItem('remote_session_token'),
  ws: null,
  state: 'auth',
  retryCount: 0,
  retryTimer: null,
  // Cloud relay mode: 'lan' (default, same network) or 'relay' (via cloud server)
  mode: localStorage.getItem('remote_conn_mode') || 'lan',
  cloudUrl: localStorage.getItem('remote_cloud_url') || '',
  cloudApiKey: localStorage.getItem('remote_cloud_api_key') || '',
};

function connSetState(s) {
  conn.state = s;
  const statusEl = $('connection-dot');
  const labelEl = $('status-label');
  if (statusEl) {
    statusEl.classList.toggle('disconnected', s !== 'connected' && s !== 'connecting');
    statusEl.classList.toggle('reconnecting', s === 'reconnecting');
  }
  if (labelEl) {
    if (s === 'connected') labelEl.textContent = t('status.connected');
    else if (s === 'reconnecting') labelEl.textContent = t('status.reconnecting');
    else if (s === 'connecting') labelEl.textContent = '…';
    else labelEl.textContent = t('status.disconnected');
  }
  const banner = $('reconnecting-banner');
  if (banner) banner.classList.toggle('hidden', s !== 'reconnecting');
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  _debugLog('[Init] mode=' + conn.mode, 'cloudUrl=' + (conn.cloudUrl || 'none'), 'hasKey=' + !!conn.cloudApiKey);
  i18n.applyDOM();
  _restoreSessions();
  setupPinEntry();
  setupCloudKeyEntry();
  setupNavigation();
  setupChatInput();
  setupPlusMenu();
  _setupImageInputs();
  _setupChatDelegation();
  _setupMentionChipsDelegation();

  // Check for relay mode params in URL: ?mode=relay&url=...&key=...
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('mode') === 'relay' && urlParams.get('url') && urlParams.get('key')) {
    conn.mode = 'relay';
    conn.cloudUrl = urlParams.get('url');
    conn.cloudApiKey = urlParams.get('key');
    localStorage.setItem('remote_conn_mode', 'relay');
    localStorage.setItem('remote_cloud_url', conn.cloudUrl);
    localStorage.setItem('remote_cloud_api_key', conn.cloudApiKey);
    // Clean URL
    window.history.replaceState({}, '', window.location.pathname);
  }

  // Auto-detect cloud hosting: if served from a cloud server (has /health endpoint),
  // default to cloud mode and use current origin as relay URL.
  // Must await detection before deciding which screen to show.
  _detectCloudHosting().then(() => {
    if (conn.mode === 'relay' && conn.cloudUrl && conn.cloudApiKey) {
      // Relay mode: skip PIN, connect directly
      _showMain();
      _openWS();
    } else if (conn.token) {
      _showMain();
      _openWS();
    } else {
      _showAuth();
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // Check for updates every 60s
      setInterval(() => reg.update(), 60_000);
      // Auto-apply new SW when available
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (!newSW) return;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'activated') {
            console.log('[SW] New version activated, reloading...');
            window.location.reload();
          }
        });
      });
    }).catch(err => {
      console.warn('SW registration failed:', err);
    });
  }

  _setupPwaInstallBanner();
  _setupCloudPopup();
}

// ─── Screen Management ────────────────────────────────────────────────────────

function _showAuth(showCloudError) {
  $('screen-auth').classList.remove('hidden');
  $('screen-main').classList.add('hidden');
  // Reset PIN fields
  const pinInput = $('pin-input');
  if (pinInput) { pinInput.value = ''; pinInput.disabled = false; }
  const submitBtn = $('pin-submit-btn');
  if (submitBtn) submitBtn.disabled = false;
  const errEl = $('pin-error');
  if (errEl) errEl.classList.add('hidden');
  // Reset cloud key fields
  const cloudKeyInput = $('cloud-key-input');
  if (cloudKeyInput) { cloudKeyInput.value = ''; cloudKeyInput.disabled = false; }
  const cloudSubmitBtn = $('cloud-key-submit-btn');
  if (cloudSubmitBtn) cloudSubmitBtn.disabled = false;
  const cloudErrEl = $('cloud-key-error');
  if (cloudErrEl) cloudErrEl.classList.toggle('hidden', !showCloudError);
  // Show the correct auth section based on mode
  const isCloud = conn.mode === 'relay';
  const pinSection = $('auth-pin-section');
  const cloudSection = $('auth-cloud-section');
  if (pinSection && cloudSection) {
    pinSection.classList.toggle('hidden', isCloud);
    cloudSection.classList.toggle('hidden', !isCloud);
  }
  connSetState('auth');
}

function _showMain() {
  $('screen-auth').classList.add('hidden');
  $('screen-main').classList.remove('hidden');
}

// ─── PIN Entry ────────────────────────────────────────────────────────────────

function setupPinEntry() {
  const pinInput = $('pin-input');
  const submitBtn = $('pin-submit-btn');
  if (!pinInput || !submitBtn) return;

  pinInput.addEventListener('input', () => {
    const val = pinInput.value.replace(/\D/g, '').slice(0, 6);
    pinInput.value = val;
    if (val.length === 6) submitPin(val);
  });
  submitBtn.addEventListener('click', () => submitPin(pinInput.value.trim()));
  pinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitPin(pinInput.value.trim());
  });
}

async function submitPin(pin) {
  if (!pin || pin.length < 6) return;

  const pinInput = $('pin-input');
  const submitBtn = $('pin-submit-btn');
  const errorEl = $('pin-error');

  if (pinInput) pinInput.disabled = true;
  if (submitBtn) submitBtn.disabled = true;
  if (errorEl) errorEl.classList.add('hidden');

  try {
    const res = await fetch('/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json();

    if (!res.ok || !data.token) {
      if (errorEl) errorEl.classList.remove('hidden');
      if (pinInput) { pinInput.disabled = false; pinInput.value = ''; pinInput.focus(); }
      if (submitBtn) submitBtn.disabled = false;
      return;
    }

    conn.token = data.token;
    localStorage.setItem('remote_session_token', data.token);
    _showMain();
    _openWS();
  } catch (e) {
    if (errorEl) { errorEl.textContent = t('pin.connFail'); errorEl.classList.remove('hidden'); }
    if (pinInput) { pinInput.disabled = false; pinInput.focus(); }
    if (submitBtn) submitBtn.disabled = false;
  }
}

// ─── Cloud Key Entry ─────────────────────────────────────────────────────────

function setupCloudKeyEntry() {
  const keyInput = $('cloud-key-input');
  const submitBtn = $('cloud-key-submit-btn');
  const switchCloudBtn = $('auth-switch-cloud');
  const switchPinBtn = $('auth-switch-pin');

  if (submitBtn && keyInput) {
    submitBtn.addEventListener('click', () => submitCloudKey(keyInput.value.trim()));
    keyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitCloudKey(keyInput.value.trim());
    });
  }

  if (switchCloudBtn) {
    switchCloudBtn.addEventListener('click', () => {
      $('auth-pin-section').classList.add('hidden');
      $('auth-cloud-section').classList.remove('hidden');
      const ki = $('cloud-key-input');
      if (ki) ki.focus();
    });
  }

  if (switchPinBtn) {
    switchPinBtn.addEventListener('click', () => {
      $('auth-cloud-section').classList.add('hidden');
      $('auth-pin-section').classList.remove('hidden');
      const pi = $('pin-input');
      if (pi) pi.focus();
    });
  }
}

function submitCloudKey(apiKey) {
  if (!apiKey) return;

  const keyInput = $('cloud-key-input');
  const submitBtn = $('cloud-key-submit-btn');
  const errorEl = $('cloud-key-error');

  if (keyInput) keyInput.disabled = true;
  if (submitBtn) submitBtn.disabled = true;
  if (errorEl) errorEl.classList.add('hidden');

  // Use current origin as cloud URL (since we're served from the cloud server)
  const cloudUrl = window.location.origin;

  conn.mode = 'relay';
  conn.cloudUrl = cloudUrl;
  conn.cloudApiKey = apiKey;
  localStorage.setItem('remote_conn_mode', 'relay');
  localStorage.setItem('remote_cloud_url', cloudUrl);
  localStorage.setItem('remote_cloud_api_key', apiKey);

  _showMain();
  _openWS();
}

function _detectCloudHosting() {
  // If we're on a cloud server, auto-show cloud auth mode
  // Detection: try /health endpoint - if it returns cloud:true, we're on a cloud server
  return fetch('/health').then(r => r.json()).then(data => {
    if (data && data.cloud === true && conn.mode !== 'relay') {
      // We're hosted on a cloud server - set relay mode with current origin
      conn.mode = 'relay';
      conn.cloudUrl = window.location.origin;
      localStorage.setItem('remote_conn_mode', 'relay');
      localStorage.setItem('remote_cloud_url', conn.cloudUrl);
      // Show cloud auth section (API key input) instead of PIN
      const pinSection = $('auth-pin-section');
      const cloudSection = $('auth-cloud-section');
      if (pinSection && cloudSection) {
        pinSection.classList.add('hidden');
        cloudSection.classList.remove('hidden');
        const ki = $('cloud-key-input');
        if (ki) ki.focus();
      }
    }
  }).catch(() => { /* Not on cloud, keep PIN mode */ });
}

// ─── WebSocket Connection ──────────────────────────────────────────────────────

function _openWS() {
  if (conn.ws && conn.ws.readyState === WebSocket.OPEN) return;
  // Close stale connecting/closing socket before creating a new one
  if (conn.ws) { try { conn.ws.close(); } catch (e) {} conn.ws = null; }
  if (conn.retryTimer) { clearTimeout(conn.retryTimer); conn.retryTimer = null; }

  // Relay mode: connect to cloud server directly with API key
  if (conn.mode === 'relay') {
    if (!conn.cloudUrl || !conn.cloudApiKey) { _showAuth(); return; }
    connSetState('connecting');
    const base = conn.cloudUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:').replace(/\/$/, '');
    const wsUrl = `${base}/relay?role=mobile&token=${encodeURIComponent(conn.cloudApiKey)}`;
    const ws = new WebSocket(wsUrl);
    conn.ws = ws;
  } else {
    // LAN mode: standard local WS with session token
    if (!conn.token) { _showAuth(); return; }
    connSetState('connecting');
    const wsUrl = `ws://${window.location.host}/ws?token=${conn.token}`;
    const ws = new WebSocket(wsUrl);
    conn.ws = ws;
  }

  const ws = conn.ws;

  ws.onopen = () => {
    conn.retryCount = 0;
    _debugLog('[WS] Connected to relay');
    connSetState('connected');
    _requestNotificationPermission();
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (e) { console.error('[WS] parse error:', e); }
  };

  ws.onclose = (e) => {
    _debugLog('[WS] Closed:', e.code, e.reason);
    conn.ws = null;
    // Auth failure
    if (e.code === 4401 || e.code === 4003) {
      const wasRelay = conn.mode === 'relay';
      if (wasRelay) {
        conn.cloudApiKey = '';
        localStorage.removeItem('remote_cloud_api_key');
      } else {
        conn.token = null;
        localStorage.removeItem('remote_session_token');
      }
      connSetState('auth');
      _showAuth(wasRelay);
      return;
    }
    // Kicked by administrator
    if (e.code === 4403) {
      conn.token = null;
      localStorage.removeItem('remote_session_token');
      connSetState('auth');
      _showAuth(false);
      const errEl = $('auth-error');
      if (errEl) {
        errEl.textContent = t('misc.disconnectedAdmin');
        errEl.classList.remove('hidden');
      }
      return;
    }
    // Too many mobiles
    if (e.code === 4002) {
      const labelEl = $('status-label');
      if (labelEl) labelEl.textContent = t('misc.tooManyMobile');
      return;
    }
    if (conn.state !== 'auth') _scheduleReconnect();
  };

  ws.onerror = () => {};
}

function _scheduleReconnect() {
  if (conn.mode === 'relay') {
    if (!conn.cloudUrl || !conn.cloudApiKey) return;
  } else {
    if (!conn.token) return;
  }
  const delay = Math.min(1000 * Math.pow(2, conn.retryCount), 30000);
  conn.retryCount++;
  connSetState('reconnecting');
  conn.retryTimer = setTimeout(() => { conn.retryTimer = null; _openWS(); }, delay);
}

function _onDesktopOffline() {
  _debugLog('[State] Desktop offline, relay mode=' + conn.mode);
  state.desktopOffline = true;
  // Clear desktop sessions — they're no longer reachable
  state.sessions = {};
  state.selectedSessionId = null;
  renderSessionBar(); renderChatMessages();
  const labelEl = $('status-label');
  if (labelEl) labelEl.textContent = t('misc.desktopOffline');
  const dot = $('connection-dot');
  if (dot) { dot.classList.add('disconnected'); dot.classList.remove('reconnecting'); }
  // Show cloud popup if in relay mode (cloud server available)
  if (conn.mode === 'relay' && conn.cloudUrl && conn.cloudApiKey) {
    _showCloudPopup(true);
  }
}

async function _fetchCloudProjects() {
  if (!conn.cloudUrl || !conn.cloudApiKey) return;
  const base = conn.cloudUrl.replace(/\/$/, '');
  try {
    const resp = await fetch(`${base}/api/projects`, {
      headers: { 'Authorization': `Bearer ${conn.cloudApiKey}` },
    });
    if (!resp.ok) return;
    const { projects } = await resp.json();
    if (projects && projects.length) {
      // Map cloud projects to the format the PWA expects
      state.projects = projects.map(p => ({
        id: `cloud-${p.name}`,
        name: p.displayName || p.name,
        path: p.name,
        color: '',
        icon: '',
        _cloud: true,
      }));
      state.folders = [];
      state.rootOrder = [];
      renderProjectsList();
    }
  } catch (e) {
    console.error('[Cloud] Failed to fetch projects:', e);
  }
}

function _onRelayKicked() {
  conn.ws = null;
  connSetState('auth');
  _showAuth();
}

function wsSend(type, data) {
  if (conn.ws && conn.ws.readyState === 1) {
    conn.ws.send(JSON.stringify({ type, data }));
  }
}

// ─── Notifications ───────────────────────────────────────────────────────────

function _requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function _showNotification(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;
  try {
    const notif = new Notification(title, {
      body,
      tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [200, 100, 200],
    });
    notif.onclick = () => { window.focus(); notif.close(); };
  } catch (e) {
    if (navigator.serviceWorker?.ready) {
      navigator.serviceWorker.ready.then(reg => {
        reg.showNotification(title, { body, tag, icon: '/icon-192.png' });
      });
    }
  }
}

// ─── Message Router ───────────────────────────────────────────────────────────

function handleMessage(msg) {
  const { type, data } = msg;
  switch (type) {
    case 'hello':
      connSetState('connected');
      // Server is authoritative — clear all local sessions, they'll be
      // re-created by the session:started + chat-message replay that follows
      state.sessions = {};
      state.selectedSessionId = null;
      if (data.chatModel) { state.selectedModel = data.chatModel; }
      if (data.effortLevel) { state.selectedEffort = data.effortLevel; }
      if (data.accentColor) _applyAccentColor(data.accentColor);
      if (data.language) i18n.setLang(data.language);
      _updatePlusMenuSelection();
      renderSessionBar(); renderChatMessages();
      break;
    case 'projects:updated':     onProjectsUpdated(data); break;
    case 'session:started':      onSessionStarted(data); break;
    case 'session:tab-renamed':  onTabRenamed(data); break;
    case 'session:closed':       onSessionClosed(data); break;
    case 'chat-message':         onChatMessage(data); break;
    case 'chat-user-message':    onChatUserMessage(data); break;
    case 'chat-idle':            onChatIdle(data); break;
    case 'chat-done':            onChatDone(data); break;
    case 'chat-error':           onChatError(data); break;
    case 'chat-permission-request': onPermissionRequest(data); break;
    case 'time:update':          onTimeUpdate(data); break;
    case 'git:status':           onGitStatus(data); break;
    case 'git:pull':             onGitResult('pull', data); break;
    case 'git:push':             onGitResult('push', data); break;
    case 'mention:file-list':    onFileList(data); break;
    case 'sessions:past':        onPastSessions(data); break;
    case 'settings:updated':     break; // ack, nothing to do
    case 'pong': break;
    // Relay-specific events
    case 'relay:desktop-online':
      _debugLog('[Relay] Desktop came online');
      state.desktopOffline = false;
      connSetState('connected');
      _showCloudPopup(false);
      _showHeadlessBanner(false);
      _cleanupHeadlessSession();
      // Clear cloud/headless sessions — desktop will resend its own via request:init
      state.sessions = {};
      state.selectedSessionId = null;
      renderSessionBar(); renderChatMessages();
      // Ask the desktop to send init data (projects, sessions, time)
      wsSend('request:init', {});
      break;
    case 'relay:desktop-offline': _onDesktopOffline(); break;
    case 'relay:kicked':          _onRelayKicked(); break;
    // Cloud session stream events routed through relay WS
    case 'stream':
      if (msg.data) {
        _debugLog('[Stream] Relay event:', msg.data.type, msg.data.event?.type || '');
        _handleHeadlessEvent(msg.data);
      }
      break;
  }
}

// ─── Server Events ────────────────────────────────────────────────────────────

function onProjectsUpdated({ projects, folders, rootOrder }) {
  state.projects = projects || [];
  state.folders = folders || [];
  state.rootOrder = rootOrder || [];
  // Update any sessions that were created before projects arrived (race condition)
  for (const session of Object.values(state.sessions)) {
    if (session.projectId && session.tabName === 'Chat') {
      const project = state.projects.find(p => p.id === session.projectId);
      if (project) session.tabName = project.name;
    }
  }
  // Update project hub header if in project hub
  if (state.inProjectHub && state.selectedProjectId) {
    const project = state.projects.find(p => p.id === state.selectedProjectId);
    if (project) {
      const title = $('header-title');
      if (title && title.textContent === 'Project') {
        title.textContent = project.name;
        title.style.color = project.color || '';
      }
    }
  }
  renderProjectsList();
  renderDashboard();
}

function onSessionStarted({ sessionId, projectId, tabName }) {
  const messages = [];
  if (state._pendingUserMessage) {
    messages.push({ role: 'user', content: state._pendingUserMessage });
    state._pendingUserMessage = null;
  }
  if (!state.sessions[sessionId]) {
    state.sessions[sessionId] = _makeSession(sessionId, projectId, tabName, messages);
  }
  if (!state.selectedSessionId || projectId === state.selectedProjectId) {
    state.selectedSessionId = sessionId;
    state.selectedProjectId = projectId;
  }
  if (!state.inProjectHub && projectId) {
    enterProjectHub(projectId);
    switchView('chat'); // go straight to chat for new session
  } else if (state.currentView === 'sessions') {
    renderSessionsView(); // refresh tabs list
  } else if (state.currentView !== 'chat') {
    switchView('chat');
  } else {
    renderSessionBar(); renderChatMessages();
  }
  _saveSessions();
}

function onTabRenamed({ sessionId, tabName }) {
  const session = state.sessions[sessionId];
  if (session && tabName) {
    session.tabName = tabName;
    if (state.currentView === 'sessions') renderSessionsView();
    _refreshControlIfActive();
    // Update session bar if active
    if (state.selectedSessionId === sessionId) renderSessionBar();
  }
}

function onSessionClosed({ sessionId }) {
  if (!sessionId || !state.sessions[sessionId]) return;
  delete state.sessions[sessionId];
  // If the closed session was selected, pick another or clear
  if (state.selectedSessionId === sessionId) {
    const remaining = Object.values(state.sessions).filter(s => s.projectId === state.selectedProjectId);
    state.selectedSessionId = remaining.length ? remaining[0].sessionId : null;
  }
  _saveSessions();
  if (state.currentView === 'sessions') renderSessionsView();
  if (state.currentView === 'chat') renderChatView();
  if (state.currentView === 'control') renderControlView();
}

function onTimeUpdate({ todayMs }) {
  state.todayMs = todayMs || 0;
  renderDashboard();
}

// ─── Chat Message Handler (mirrors ChatView.js SDK format) ────────────────────

function _getOrCreateSession(sessionId, projectId) {
  if (!state.sessions[sessionId]) {
    const pid = projectId || state.selectedProjectId;
    const project = state.projects.find(p => p.id === pid);
    state.sessions[sessionId] = _makeSession(sessionId, pid, project?.name || 'Chat', []);
    _saveSessions();
  }
  return state.sessions[sessionId];
}

function _makeSession(sessionId, projectId, tabName, messages) {
  return {
    sessionId,
    projectId: projectId || null,
    tabName: tabName || 'Chat',
    messages: messages || [],
    streaming: '',
    streamEl: null,
    hasToolUse: false,
    status: 'idle',        // idle | active | permission | error
    lastActivity: '',      // last action description
    // Tool streaming state
    toolInputBuffers: new Map(),  // blockIdx → accumulated JSON string
    toolCards: new Map(),          // blockIdx → { toolId, toolName }
    currentBlockIdx: -1,
    currentBlockType: null,
  };
}

function onChatMessage({ sessionId, message }) {
  if (!message) return;
  const session = _getOrCreateSession(sessionId);
  const type = message.type;

  // Auto-select this session if none selected and it belongs to the current project
  if (!state.selectedSessionId && session.projectId === state.selectedProjectId) {
    state.selectedSessionId = sessionId;
    if (state.currentView === 'chat') renderSessionBar();
  }

  if (type === 'system') return;

  if (type === 'stream_event' && message.event) {
    _handleStreamEvent(session, sessionId, message.event);
    return;
  }

  if (type === 'assistant') {
    _handleAssistantMessage(session, sessionId, message);
    return;
  }

  if (type === 'result') {
    _handleResult(session, sessionId, message);
    return;
  }
}

// ── Stream Event Handler ──

function _handleStreamEvent(session, sessionId, event) {
  switch (event.type) {
    case 'message_start':
      session.streaming = '';
      session.streamEl = null;
      session.hasToolUse = false;
      session.toolInputBuffers.clear();
      session.toolCards.clear();
      session.currentBlockIdx = -1;
      session.currentBlockType = null;
      _setThinking(sessionId, false);
      break;

    case 'content_block_start': {
      const block = event.content_block;
      const idx = event.index ?? -1;
      if (!block) break;

      session.currentBlockIdx = idx;
      session.currentBlockType = block.type;

      if (block.type === 'tool_use') {
        session.hasToolUse = true;
        _finalizeStream(session);
        // Store tool card info for matching later
        session.toolCards.set(idx, { toolId: block.id, toolName: block.name || 'Tool' });
        session.lastActivity = block.name || 'Tool';
        _refreshControlIfActive();
        session.toolInputBuffers.set(idx, '');
        // Add tool message (will be updated with input when block stops)
        session.messages.push({
          role: 'tool',
          toolId: block.id,
          toolName: block.name || 'Tool',
          content: block.name || 'Tool',
          toolInput: null,
          toolOutput: null,
          status: 'running',
        });
        _renderIfActive(sessionId);
      } else if (block.type === 'text') {
        _ensureStreamEl(session, sessionId);
      }
      break;
    }

    case 'content_block_delta': {
      const delta = event.delta;
      if (!delta) break;

      if (delta.type === 'text_delta' && delta.text) {
        session.streaming += delta.text;
        _appendStreamDelta(session, sessionId, delta.text);
      } else if (delta.type === 'input_json_delta' && delta.partial_json) {
        // Buffer tool input JSON
        const idx = session.currentBlockIdx;
        if (idx >= 0 && session.toolInputBuffers.has(idx)) {
          const buf = session.toolInputBuffers.get(idx) + delta.partial_json;
          session.toolInputBuffers.set(idx, buf);
        }
      }
      break;
    }

    case 'content_block_stop': {
      const idx = event.index ?? session.currentBlockIdx;

      if (session.currentBlockType === 'tool_use' && idx >= 0) {
        // Parse accumulated input JSON and update the tool message
        const jsonStr = session.toolInputBuffers.get(idx);
        const cardInfo = session.toolCards.get(idx);
        if (jsonStr && cardInfo) {
          try {
            const toolInput = JSON.parse(jsonStr);
            // Find the matching tool message and update it
            const toolMsg = _findToolMessage(session, cardInfo.toolId);
            if (toolMsg) {
              toolMsg.toolInput = toolInput;
              toolMsg.content = cardInfo.toolName;
            }
          } catch (e) { /* JSON parse error — incomplete input */ }
        }
        // Update the live DOM card if visible
        _updateLiveToolCard(session, sessionId, idx);
      } else {
        // Text block finished
        _finalizeStream(session);
      }
      _renderIfActive(sessionId);
      session.currentBlockType = null;
      break;
    }

    case 'message_stop':
      _finalizeStream(session);
      _setThinking(sessionId, false);
      if (!session.hasToolUse) {
        setInputState('idle');
      }
      // Update lastActivity with a snippet of the last text
      if (session.streaming || session.messages.length) {
        const last = _getSessionLastMessage(session);
        if (last) session.lastActivity = last;
        _refreshControlIfActive();
      }
      _renderIfActive(sessionId);
      _saveSessions();
      break;
  }
}

// ── Assistant Message Handler ──

function _handleAssistantMessage(session, sessionId, msg) {
  // SDK-level errors
  if (msg.error) {
    const errorMap = {
      rate_limit: 'Rate limit reached. Please wait.',
      billing_error: 'Billing error.',
      authentication_failed: 'Authentication failed.',
      max_output_tokens: 'Max output tokens reached.',
      server_error: 'Server error.',
    };
    session.messages.push({ role: 'error', content: errorMap[msg.error] || msg.error });
    _setThinking(sessionId, false);
    setInputState('idle');
    _renderIfActive(sessionId);
    return;
  }

  // Process tool_result blocks from the full assistant message
  // The SDK message has .message.content which is an array of content blocks
  const content = msg.message?.content || msg.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_result') {
        const output = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map(b => b.text || '').join('\n')
            : '';
        // Find matching tool message and attach output
        const toolMsg = _findToolMessage(session, block.tool_use_id);
        if (toolMsg) {
          toolMsg.toolOutput = output;
          toolMsg.status = block.is_error ? 'error' : 'complete';
        }
        _renderIfActive(sessionId);
      }
      // Skip text and tool_use blocks — already captured by stream_event
    }
  }
}

// ── Result Handler ──

function _handleResult(session, sessionId, msg) {
  _finalizeStream(session);
  _setThinking(sessionId, false);
  setInputState('idle');

  // Mark all running tools as complete
  for (const m of session.messages) {
    if (m.role === 'tool' && m.status === 'running') m.status = 'complete';
  }

  // SDK error in result
  if (msg.is_error && msg.subtype) {
    const errors = {
      error_max_turns: 'Max turns reached.',
      error_max_budget_usd: 'Budget limit reached.',
      error_during_execution: msg.errors?.join(', ') || 'Error during execution.',
    };
    const errorMsg = errors[msg.subtype];
    if (errorMsg) session.messages.push({ role: 'error', content: errorMsg });
  }

  _renderIfActive(sessionId);
}

// ── Helper: find tool message by toolId ──

function _findToolMessage(session, toolId) {
  if (!toolId) return null;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    if (session.messages[i].role === 'tool' && session.messages[i].toolId === toolId) {
      return session.messages[i];
    }
  }
  return null;
}

// ── Helper: update live tool card DOM without full re-render ──

function _updateLiveToolCard(session, sessionId, blockIdx) {
  if (sessionId !== state.selectedSessionId || state.currentView !== 'chat') return;
  const container = $('chat-messages');
  if (!container) return;

  const cardInfo = session.toolCards.get(blockIdx);
  if (!cardInfo) return;
  const toolMsg = _findToolMessage(session, cardInfo.toolId);
  if (!toolMsg) return;

  // Find the card in DOM and update the detail text
  const cards = container.querySelectorAll('.tool-card');
  for (const card of cards) {
    if (card.dataset.toolId === cardInfo.toolId) {
      const detailEl = card.querySelector('.tool-detail');
      if (detailEl && toolMsg.toolInput) {
        const detail = getToolDisplayInfo(toolMsg.toolName, toolMsg.toolInput);
        detailEl.textContent = _truncate(detail, 70);
        if (detail) card.classList.add('expandable');
      }
      break;
    }
  }
}

// ── User message from desktop ──

function onChatUserMessage({ sessionId, text, images }) {
  const session = _getOrCreateSession(sessionId);
  // Avoid duplicate if this client sent the message
  const lastMsg = session.messages[session.messages.length - 1];
  if (lastMsg?.role === 'user' && lastMsg.content === text) return;
  const imageCount = typeof images === 'number' ? images : (Array.isArray(images) ? images.length : 0);
  const imageLabel = imageCount > 0 ? ` (${imageCount} image${imageCount > 1 ? 's' : ''})` : '';
  let content = text || '';
  if (imageLabel) content += imageLabel;
  if (!content) content = t('chat.imageAttached');
  session.messages.push({ role: 'user', content });
  _renderIfActive(sessionId);
}

// ── Chat-idle / done / error / permission ──

function onChatIdle({ sessionId, projectId }) {
  const session = _getOrCreateSession(sessionId, projectId);
  if (!session.projectId && projectId) session.projectId = projectId;
  session.status = 'active';
  session.lastActivity = t('status.claudeWorking');
  _refreshControlIfActive();
  if (!state.selectedSessionId) {
    state.selectedSessionId = sessionId;
    state.selectedProjectId = projectId || state.selectedProjectId;
    if (!state.inProjectHub && projectId) {
      enterProjectHub(projectId);
      switchView('chat');
    } else if (state.currentView === 'sessions') {
      renderSessionsView();
    } else if (state.currentView !== 'chat') {
      switchView('chat');
    } else {
      renderSessionBar();
    }
  }
  _setThinking(sessionId, true);
  setInputState('sending');
}

function onChatDone({ sessionId }) {
  const session = state.sessions[sessionId];
  if (!session) return;
  _finalizeStream(session);
  _setThinking(sessionId, false);
  session.status = 'idle';
  session.lastActivity = t('status.done');
  _refreshControlIfActive();
  setInputState('idle');
  _renderIfActive(sessionId);
  _saveSessions();
  if (state.currentView !== 'chat') $('chat-badge')?.classList.remove('hidden');
  _showNotification(
    t('status.claudeFinished'),
    session.tabName || 'Chat',
    `done-${sessionId}`
  );
}

function onChatError({ sessionId, error }) {
  const session = state.sessions[sessionId];
  if (session) {
    _finalizeStream(session);
    session.messages.push({ role: 'error', content: error || 'Unknown error' });
    session.status = 'error';
    session.lastActivity = error || 'Error';
    _refreshControlIfActive();
  }
  _setThinking(sessionId, false);
  setInputState('idle');
  _renderIfActive(sessionId);
  _saveSessions();
  if (state.currentView !== 'chat') $('chat-badge')?.classList.remove('hidden');
  _showNotification(
    t('status.claudeError'),
    (error || '').slice(0, 80),
    `error-${sessionId}`
  );
}

function onPermissionRequest(data) {
  // Insert permission as inline message in the active session
  const session = data.sessionId ? _getOrCreateSession(data.sessionId) : null;
  if (session) {
    session.messages.push({
      role: 'permission',
      content: data.toolName || 'Tool',
      permData: data,
    });
    session.status = 'permission';
    session.lastActivity = `${t('status.permPrefix')} ${data.toolName || 'Tool'}`;
    _refreshControlIfActive();
  }
  state.pendingPermissions.set(data.requestId, data);
  _renderIfActive(data.sessionId);
  if (state.currentView !== 'chat') $('chat-badge')?.classList.remove('hidden');
  const toolName = data.toolName || 'Tool';
  _showNotification(
    t('status.permRequired'),
    toolName,
    `perm-${data.requestId}`
  );
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
}

// ─── Streaming Helpers ────────────────────────────────────────────────────────

function _ensureStreamEl(session, sessionId) {
  if (session.streamEl) return;
  if (sessionId !== state.selectedSessionId || state.currentView !== 'chat') return;

  const container = $('chat-messages');
  if (!container) return;

  const el = document.createElement('div');
  el.className = 'chat-msg assistant streaming';
  container.appendChild(el);
  session.streamEl = el;
  _scrollToBottom(container);
}

function _appendStreamDelta(session, sessionId, text) {
  if (sessionId !== state.selectedSessionId || state.currentView !== 'chat') return;

  // If streamEl was detached from DOM (e.g. by renderChatMessages re-render), discard it
  if (session.streamEl && !session.streamEl.isConnected) {
    session.streamEl = null;
  }

  if (!session.streamEl) _ensureStreamEl(session, sessionId);
  if (!session.streamEl) return;

  session.streamEl.textContent = session.streaming;
  const container = $('chat-messages');
  if (container) _scrollToBottom(container);
}

function _finalizeStream(session) {
  if (session.streaming) {
    session.messages.push({ role: 'assistant', content: session.streaming });
    session.streaming = '';
  }
  if (session.streamEl) {
    session.streamEl.classList.remove('streaming');
    session.streamEl = null;
  }
}

function _setThinking(sessionId, show) {
  if (sessionId !== state.selectedSessionId) return;
  const el = $('thinking-indicator');
  if (el) el.classList.toggle('hidden', !show);
}

function _renderIfActive(sessionId) {
  if (sessionId === state.selectedSessionId && state.currentView === 'chat') {
    renderChatMessages();
  }
}

function _scrollToBottom(container) {
  const threshold = 80;
  const nearBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) < threshold;
  if (nearBottom) container.scrollTop = container.scrollHeight;
}

// ─── Navigation ───────────────────────────────────────────────────────────────

const GLOBAL_VIEWS = ['projects', 'chat', 'control', 'dashboard'];
const PROJECT_VIEWS = ['sessions', 'git'];

function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => { navigator.vibrate?.(10); switchView(btn.dataset.view); });
  });
  _updateNavPill();
}

function _activeNavViews() {
  return state.inProjectHub ? PROJECT_VIEWS : GLOBAL_VIEWS;
}

function _updateNavPill() {
  const pill = $('nav-pill');
  if (!pill) return;
  const views = _activeNavViews();
  pill.style.width = `calc(100% / ${views.length})`;
  const idx = views.indexOf(state.currentView);
  if (idx >= 0) pill.style.transform = `translateX(${idx * 100}%)`;
}

function switchView(view) {
  state.currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  const activeGroup = state.inProjectHub ? 'nav-project' : 'nav-global';
  document.querySelectorAll(`#${activeGroup} .nav-item`).forEach(b => b.classList.remove('active'));
  const viewEl = $(`view-${view}`);
  if (viewEl) viewEl.classList.remove('hidden');
  const navBtn = document.querySelector(`#${activeGroup} .nav-item[data-view="${view}"]`);
  if (navBtn) navBtn.classList.add('active');
  _updateNavPill();
  if (view === 'sessions') {
    renderSessionsView();
  }
  if (view === 'chat') {
    $('chat-badge')?.classList.add('hidden');
    renderChatView();
  }
  if (view === 'control') {
    renderControlView();
  }
  if (view === 'git') {
    renderGitView();
  }
}

// ── Project Hub (full-screen project mode) ──

function enterProjectHub(projectId) {
  state.selectedProjectId = projectId;
  state.inProjectHub = true;
  state.fileList = []; // Clear stale file list from previous project

  const project = state.projects.find(p => p.id === projectId);

  // Show header in project hub
  document.querySelector('.app-header')?.classList.remove('hidden');
  $('header-back')?.classList.remove('hidden');
  const title = $('header-title');
  if (title) {
    title.textContent = project?.name || 'Project';
    title.style.color = project?.color || '';
  }

  // Switch nav groups
  $('nav-global')?.classList.add('hidden');
  $('nav-project')?.classList.remove('hidden');

  // Show git actions in header
  $('header-git-actions')?.classList.remove('hidden');

  // Reset git data for new project
  _gitData = null;

  switchView('sessions');
  requestPastSessions(projectId);
}

function backToProjects() {
  // If in chat inside project hub, go back to sessions first
  if (state.inProjectHub && state.currentView === 'chat') {
    switchView('sessions');
    return;
  }

  state.inProjectHub = false;

  // Hide header on global views
  document.querySelector('.app-header')?.classList.add('hidden');
  $('header-back')?.classList.add('hidden');
  $('header-git-actions')?.classList.add('hidden');

  // Switch nav groups
  $('nav-global')?.classList.remove('hidden');
  $('nav-project')?.classList.add('hidden');

  // Hide git actions
  $('header-git-actions')?.classList.add('hidden');

  switchView('projects');
}

// ─── Sessions View (project tabs) ─────────────────────────────────────────────

function renderSessionsView() {
  const list = $('sessions-list');
  if (!list) return;

  const projectId = state.selectedProjectId;
  const sessions = Object.values(state.sessions).filter(s => s.projectId === projectId);

  if (!sessions.length) {
    list.innerHTML = `
      <div class="sessions-empty">
        <div class="sessions-empty-icon">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <div class="sessions-empty-title">${t('session.noChats')}</div>
        <div class="sessions-empty-hint">${t('session.noChatsHint')}</div>
      </div>`;
    return;
  }

  // Sort: permission first, then active, then error, then idle
  const statusOrder = { permission: 0, active: 1, error: 2, idle: 3 };
  const sorted = [...sessions].sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));

  list.innerHTML = sorted.map(s => {
    const statusLabel = {
      active: t('status.active'),
      permission: t('status.permission'),
      idle: t('status.idle'),
      error: t('status.error'),
    }[s.status] || t('status.idle');
    const lastMsg = s.lastActivity || _getSessionLastMessage(s);
    const isSelected = s.sessionId === state.selectedSessionId;

    return `
      <div class="session-card ${isSelected ? 'selected' : ''} session-card-${s.status}" data-session-id="${s.sessionId}">
        <div class="session-card-left">
          <div class="control-status-dot ${s.status}"></div>
        </div>
        <div class="session-card-body">
          <div class="session-card-top">
            <span class="session-tab-name">${escHtml(s.tabName || 'Chat')}</span>
            <span class="control-status-badge ${s.status}">${statusLabel}</span>
          </div>
          <div class="session-card-activity">${escHtml(lastMsg)}</div>
        </div>
      </div>`;
  }).join('');

  // Past sessions from disk
  const PAST_INITIAL_LIMIT = 10;
  const pastList = (state.pastSessions[projectId] || [])
    .filter(ps => !state.sessions[ps.sessionId]);
  const pastExpanded = list._pastExpanded || false;
  const visiblePast = pastExpanded ? pastList : pastList.slice(0, PAST_INITIAL_LIMIT);
  const hasMore = pastList.length > PAST_INITIAL_LIMIT && !pastExpanded;

  if (pastList.length > 0) {
    list.innerHTML += `<div class="past-sessions-divider"><span>${t('session.pastDivider')} (${pastList.length})</span></div>`;
    list.innerHTML += visiblePast.map(s => {
      const timeAgo = _formatTimeAgo(s.modified);
      const preview = s.summary || s.firstPrompt || '';
      return `
        <div class="session-card session-card-past" data-resume-id="${escHtml(s.sessionId)}" data-project-id="${escHtml(projectId)}">
          <div class="session-card-left">
            <svg class="past-session-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
          </div>
          <div class="session-card-body">
            <div class="session-card-top">
              <span class="session-tab-name">${escHtml((preview || 'Chat').slice(0, 60))}</span>
              <span class="past-session-time">${escHtml(timeAgo)}</span>
            </div>
            <div class="session-card-activity">${s.messageCount || 0} messages</div>
          </div>
        </div>`;
    }).join('');
    if (hasMore) {
      list.innerHTML += `<button class="past-sessions-show-more">${t('session.showMore', { count: pastList.length - PAST_INITIAL_LIMIT })}</button>`;
    }
  }

  // Event delegation — attach once, not per render
  if (!list._sessionDelegated) {
    list._sessionDelegated = true;
    list.addEventListener('click', (e) => {
      // "Show more" past sessions
      if (e.target.closest('.past-sessions-show-more')) {
        list._pastExpanded = true;
        renderSessionsView();
        return;
      }
      // Past session resume
      const pastCard = e.target.closest('.session-card-past');
      if (pastCard && pastCard.dataset.resumeId) {
        resumePastSession(pastCard.dataset.resumeId, pastCard.dataset.projectId);
        return;
      }
      // Active session
      const card = e.target.closest('.session-card');
      if (card && card.dataset.sessionId) openSession(card.dataset.sessionId);
    });
  }
}

function openSession(sessionId) {
  state.selectedSessionId = sessionId;
  switchView('chat');
}

function createNewSession() {
  state.selectedSessionId = null;
  switchView('chat');
}

// ─── Past Sessions (Resume) ──────────────────────────────────────────────────

function onPastSessions(data) {
  if (data.projectId) {
    state.pastSessions[data.projectId] = data.sessions || [];
    if (state.currentView === 'sessions') renderSessionsView();
  }
}

function requestPastSessions(projectId) {
  // Desktop online: ask via WS
  if (!state.desktopOffline) {
    wsSend('sessions:list-past', { projectId });
  }
  // Cloud mode: also fetch from cloud API
  if (conn.cloudUrl && conn.cloudApiKey) {
    const project = state.projects.find(p => p.id === projectId);
    if (!project) return;
    const projectName = project.name || project.path?.split(/[\\/]/).pop() || '';
    _fetchCloudPastSessions(projectId, projectName);
  }
}

async function _fetchCloudPastSessions(projectId, projectName) {
  try {
    const base = conn.cloudUrl.replace(/\/$/, '');
    const resp = await fetch(`${base}/api/sessions/history/${encodeURIComponent(projectName)}`, {
      headers: { 'Authorization': `Bearer ${conn.cloudApiKey}` },
    });
    if (!resp.ok) return;
    const { sessions } = await resp.json();
    if (!sessions?.length) return;
    // Merge with existing past sessions (desktop ones), avoiding duplicates
    const existing = state.pastSessions[projectId] || [];
    const existingIds = new Set(existing.map(s => s.sessionId));
    const merged = [...existing, ...sessions.filter(s => !existingIds.has(s.sessionId))];
    merged.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    state.pastSessions[projectId] = merged;
    if (state.currentView === 'sessions') renderSessionsView();
  } catch (err) {
    _debugLog('[Cloud] Failed to fetch past sessions:', err?.message || err);
  }
}

function resumePastSession(sessionId, projectId) {
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return;

  // Visual feedback: dim the card to show it's loading
  const card = document.querySelector(`.session-card-past[data-resume-id="${sessionId}"]`);
  if (card) {
    card.style.opacity = '0.4';
    card.style.pointerEvents = 'none';
  }

  // Cloud/headless mode: resume via cloud API
  if (state.desktopOffline && conn.cloudUrl && conn.cloudApiKey) {
    const projectName = project.name || project.path?.split(/[\\/]/).pop() || '';
    _startHeadlessSession(projectName, 'Continue from where we left off.', sessionId).catch(() => {
      // Restore card on failure (banner already shows error via _startHeadlessSession)
      if (card) {
        card.style.opacity = '';
        card.style.pointerEvents = '';
      }
    });
    return;
  }

  // Desktop mode: resume via WS relay
  state.selectedSessionId = null;
  switchView('chat');
  renderChatView();
  wsSend('chat:start', {
    cwd: project.path,
    resumeSessionId: sessionId,
  });
}

function _formatTimeAgo(isoDate) {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('misc.justNow');
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(isoDate).toLocaleDateString();
}

// ─── Mission Control View ──────────────────────────────────────────────────────

function _refreshControlIfActive() {
  if (state.currentView === 'control') renderControlView();
  if (state.currentView === 'sessions') renderSessionsView();
}

function renderControlView() {
  const list = $('control-list');
  const empty = $('control-empty');
  const countEl = $('control-count');
  if (!list) return;

  const sessions = Object.values(state.sessions);
  if (countEl) countEl.textContent = sessions.length;

  if (!sessions.length) {
    list.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  // Sort: permission first, then active, then error, then idle
  const statusOrder = { permission: 0, active: 1, error: 2, idle: 3 };
  const sorted = [...sessions].sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));

  list.innerHTML = sorted.map(s => {
    const project = state.projects.find(p => p.id === s.projectId);
    const projectName = project?.name || s.tabName || 'Chat';
    const projectColor = /^#[0-9a-fA-F]{3,8}$/.test(project?.color) ? project.color : 'var(--accent)';
    const statusLabel = {
      active: t('status.active'),
      permission: t('status.permission'),
      idle: t('status.idle'),
      error: t('status.error'),
    }[s.status] || t('status.idle');
    const lastMsg = _getSessionLastMessage(s);

    return `
      <div class="control-card control-card-${s.status}" data-session-id="${s.sessionId}" data-project-id="${s.projectId || ''}">
        <div class="control-card-left">
          <div class="control-status-dot ${s.status}"></div>
        </div>
        <div class="control-card-body">
          <div class="control-card-top">
            <span class="control-project-name" style="color:${projectColor}">${escHtml(projectName)}</span>
            <span class="control-status-badge ${s.status}">${statusLabel}</span>
          </div>
          <div class="control-card-activity">${escHtml(s.lastActivity || lastMsg)}</div>
        </div>
      </div>`;
  }).join('');

  // Event delegation — attach once, not per render
  if (!list._controlDelegated) {
    list._controlDelegated = true;
    list.addEventListener('click', (e) => {
      const card = e.target.closest('.control-card');
      if (!card) return;
      const sessionId = card.dataset.sessionId;
      const projectId = card.dataset.projectId;
      state.selectedSessionId = sessionId;
      if (projectId && !state.inProjectHub) {
        enterProjectHub(projectId);
      }
      switchView('chat');
    });
  }
}

function _getSessionLastMessage(session) {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role === 'assistant' && m.content) {
      const text = typeof m.content === 'string' ? m.content : '';
      return text.length > 60 ? text.slice(0, 60) + '…' : text;
    }
    if (m.role === 'tool' && m.toolName) return m.toolName;
  }
  return '';
}

// ─── Projects View ────────────────────────────────────────────────────────────

function _countProjectsInFolder(folderId, visited = new Set()) {
  if (visited.has(folderId)) return 0;
  visited.add(folderId);
  const folder = state.folders.find(f => f.id === folderId);
  if (!folder) return 0;
  let count = 0;
  for (const childId of (folder.children || [])) {
    const isFolder = state.folders.some(f => f.id === childId);
    if (isFolder) {
      count += _countProjectsInFolder(childId, visited);
    } else {
      count++;
    }
  }
  return count;
}

function _toggleFolder(folderId) {
  state.collapsedFolders[folderId] = !state.collapsedFolders[folderId];
  try { localStorage.setItem('remote_collapsed_folders', JSON.stringify(state.collapsedFolders)); } catch (e) {}
  renderProjectsList();
}

function _renderItem(itemId, depth, visited = new Set()) {
  if (visited.has(itemId)) return '';
  visited.add(itemId);
  const folder = state.folders.find(f => f.id === itemId);
  if (folder) {
    const collapsed = !!state.collapsedFolders[folder.id];
    const projectCount = _countProjectsInFolder(folder.id);
    const chevron = collapsed
      ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    let html = `<div class="folder-row ${collapsed ? 'collapsed' : ''}" data-folder-id="${escHtml(folder.id)}" style="padding-left:${12 + depth * 20}px">
      <span class="folder-chevron">${chevron}</span>
      <span class="folder-icon">${folder.icon || '📁'}</span>
      <span class="folder-name">${escHtml(folder.name)}</span>
      <span class="folder-count">${projectCount}</span>
    </div>`;
    if (!collapsed) {
      for (const childId of (folder.children || [])) {
        html += _renderItem(childId, depth + 1, visited);
      }
    }
    return html;
  }
  const project = state.projects.find(p => p.id === itemId);
  if (project) {
    const color = escHtml(project.color || '#d97706');
    const iconDisplay = project.icon ? escHtml(project.icon) : escHtml((project.name || project.id).charAt(0).toUpperCase());
    return `<div class="project-card" data-project-id="${escHtml(project.id)}" style="padding-left:${12 + depth * 20}px">
      <div class="project-icon-wrap" style="background:${color}18;color:${color}">
        ${iconDisplay}
      </div>
      <div class="project-info">
        <div class="project-name">${escHtml(project.name || project.id)}</div>
        <div class="project-path">${escHtml(shortenPath(project.path || ''))}</div>
      </div>
      <svg class="project-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
    </div>`;
  }
  return '';
}

function renderProjectsList() {
  const list = $('projects-list');
  const empty = $('projects-empty');
  const countEl = $('projects-count');

  if (countEl) countEl.textContent = state.projects.length;

  if (!list) return;
  if (!state.projects.length) {
    list.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  // If we have rootOrder + folders, render hierarchically
  if (state.rootOrder.length > 0 && state.folders.length > 0) {
    list.innerHTML = state.rootOrder.map(id => _renderItem(id, 0)).join('');
  } else {
    // Fallback: flat list (old behavior)
    list.innerHTML = state.projects.map(p => _renderItem(p.id, 0)).join('');
  }

  // Event delegation — attach once, not per render
  if (!list._projectDelegated) {
    list._projectDelegated = true;
    list.addEventListener('click', (e) => {
      const card = e.target.closest('.project-card');
      if (card && card.dataset.projectId) { selectProject(card.dataset.projectId); return; }
      const row = e.target.closest('.folder-row');
      if (row && row.dataset.folderId) { navigator.vibrate?.(10); _toggleFolder(row.dataset.folderId); }
    });
  }
}

function selectProject(projectId) {
  enterProjectHub(projectId);
}

// ─── Chat View ────────────────────────────────────────────────────────────────

// Set up event delegation on chat-messages container once (never re-attached)
function _setupChatDelegation() {
  const container = $('chat-messages');
  if (!container) return;
  container.addEventListener('click', (e) => {
    // Tool card expand
    const toolCard = e.target.closest('.tool-card.expandable');
    if (toolCard) { _toggleToolExpand(toolCard); return; }
    // Permission allow/deny
    const allowBtn = e.target.closest('.btn-allow');
    if (allowBtn) { e.stopPropagation(); const perm = allowBtn.closest('.perm-inline'); if (perm) _respondInlinePermission(perm, true); return; }
    const denyBtn = e.target.closest('.btn-deny');
    if (denyBtn) { e.stopPropagation(); const perm = denyBtn.closest('.perm-inline'); if (perm) _respondInlinePermission(perm, false); return; }
  });
}

function renderChatView() {
  renderSessionBar();
  renderChatMessages();
  updateSendBtn();
  _updateScrollFab();
}

function renderSessionBar() {
  const bar = $('session-bar');
  const select = $('session-select');
  const sessions = Object.values(state.sessions).filter(s =>
    !state.selectedProjectId || s.projectId === state.selectedProjectId
  );
  if (!sessions.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  select.innerHTML = sessions.map(s =>
    `<option value="${escHtml(s.sessionId)}" ${s.sessionId === state.selectedSessionId ? 'selected' : ''}>
      ${escHtml(s.tabName || 'Chat')}
    </option>`
  ).join('');
  select.onchange = () => { state.selectedSessionId = select.value; renderChatMessages(); };
}

function renderChatMessages() {
  const container = $('chat-messages');
  const session = state.selectedSessionId ? state.sessions[state.selectedSessionId] : null;

  if (session) session.streamEl = null;

  if (!session) {
    const project = state.projects.find(p => p.id === state.selectedProjectId);
    container.innerHTML = `
      <div class="no-session">
        <div class="no-session-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"/>
            <line x1="9" y1="21" x2="15" y2="21"/>
          </svg>
        </div>
        <div class="no-session-title">${t('session.noChats')}</div>
        <div class="no-session-hint">${t('session.noChatsHint')}${project ? ' — ' + escHtml(project.name) : ''}</div>
      </div>`;
    return;
  }

  let html = '';
  for (const m of session.messages) {
    html += _renderMessage(m);
  }
  container.innerHTML = html;

  // Re-create streaming element if still active
  if (session.streaming) {
    const el = document.createElement('div');
    el.className = 'chat-msg assistant streaming';
    el.textContent = session.streaming;
    container.appendChild(el);
    session.streamEl = el;
  }

  // Event delegation is set up once in _setupChatDelegation() — no per-render listeners needed

  _scrollToBottom(container);
  _updateScrollFab();
}

// ── Render a single message to HTML ──

function _renderMessage(m) {
  if (m.role === 'user') {
    const imgHtml = m.imageUrl ? `<img class="chat-user-image" src="${m.imageUrl}" alt="Attached image">` : '';
    const mentionHtml = m.mentionLabels?.length
      ? `<div class="chat-user-mentions">${m.mentionLabels.map(l => `<span class="chat-user-mention">${escHtml(l)}</span>`).join('')}</div>`
      : '';
    return `<div class="chat-msg user">${escHtml(m.content)}${mentionHtml}${imgHtml}</div>`;
  }

  if (m.role === 'assistant') {
    const hasCode = m.content && m.content.includes('```');
    return `<div class="chat-msg assistant${hasCode ? ' has-code' : ''}">${renderMarkdown(m.content)}</div>`;
  }

  if (m.role === 'tool') {
    return _renderToolCard(m);
  }

  if (m.role === 'permission') {
    return _renderInlinePermission(m);
  }

  if (m.role === 'error') {
    return `<div class="chat-msg error-msg">${escHtml(m.content)}</div>`;
  }

  return '';
}

// ── Tool Card Rendering (compact, expandable) ──

function _renderToolCard(m) {
  const icon = getToolIcon(m.toolName);
  const detail = m.toolInput ? getToolDisplayInfo(m.toolName, m.toolInput) : '';
  const truncDetail = _truncate(detail, 70);
  const hasDetail = !!m.toolInput;
  const statusIcon = m.status === 'running'
    ? '<div class="tool-spinner"></div>'
    : m.status === 'error'
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';

  return `<div class="tool-card ${hasDetail ? 'expandable' : ''}" data-tool-id="${escHtml(m.toolId || '')}">
    <div class="tool-card-row">
      <span class="tool-icon">${icon}</span>
      <span class="tool-name">${escHtml(m.toolName || 'Tool')}</span>
      <span class="tool-detail">${escHtml(truncDetail)}</span>
      <span class="tool-status">${statusIcon}</span>
    </div>
    <div class="tool-expand-content"></div>
  </div>`;
}

function _toggleToolExpand(card) {
  const contentEl = card.querySelector('.tool-expand-content');
  if (!contentEl) return;

  if (card.classList.contains('expanded')) {
    card.classList.remove('expanded');
    contentEl.innerHTML = '';
    return;
  }

  const toolId = card.dataset.toolId;
  const session = state.sessions[state.selectedSessionId];
  if (!session) return;
  const toolMsg = _findToolMessage(session, toolId);
  if (!toolMsg) return;

  card.classList.add('expanded');
  contentEl.innerHTML = _formatToolExpandContent(toolMsg);
}

function _formatToolExpandContent(m) {
  const name = (m.toolName || '').toLowerCase();
  const ext = _extFromPath(m.toolInput?.file_path);
  let html = '';

  // Input display
  if (name === 'bash' && m.toolInput?.command) {
    html += `<div class="tool-expand-section">
      <pre class="tool-code">${syntaxHighlight(m.toolInput.command, 'bash')}</pre>
    </div>`;
  } else if ((name === 'write' || name === 'edit' || name === 'read') && m.toolInput?.file_path) {
    html += `<div class="tool-expand-path">${escHtml(m.toolInput.file_path)}</div>`;
  }

  if (name === 'edit' && m.toolInput?.old_string && m.toolInput?.new_string) {
    html += '<div class="tool-diff">';
    for (const line of m.toolInput.old_string.split('\n')) {
      html += `<div class="diff-line diff-del"><span class="diff-sign">-</span><span class="diff-text">${syntaxHighlight(line, ext)}</span></div>`;
    }
    for (const line of m.toolInput.new_string.split('\n')) {
      html += `<div class="diff-line diff-add"><span class="diff-sign">+</span><span class="diff-text">${syntaxHighlight(line, ext)}</span></div>`;
    }
    html += '</div>';
  }

  // Output display — highlight for read/write (file content), plain for bash output
  if (m.toolOutput) {
    const lines = m.toolOutput.split('\n');
    const maxLines = 20;
    const truncated = lines.length > maxLines;
    const display = truncated ? lines.slice(0, maxLines) : lines;
    const outputText = display.join('\n');
    const useHighlight = name === 'read' || name === 'write';
    html += `<div class="tool-expand-section">
      <pre class="tool-output">${useHighlight ? syntaxHighlight(outputText, ext) : escHtml(outputText)}${truncated ? `\n<span class="syn-cmt">… (${lines.length - maxLines} more)</span>` : ''}</pre>
    </div>`;
  } else if (name === 'bash' && m.status === 'complete') {
    html += `<div class="tool-expand-section"><pre class="tool-output tool-output-empty">${t('status.noOutput')}</pre></div>`;
  }

  return html || `<div class="tool-expand-section" style="color:var(--text-muted);font-size:12px">${t('misc.noDetails')}</div>`;
}

// ── Inline Permission Rendering ──

function _renderInlinePermission(m) {
  const perm = m.permData;
  if (!perm) return '';
  let desc = '';
  try {
    desc = Object.entries(perm.input || {}).map(([k, v]) =>
      `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`
    ).join('\n');
  } catch (e) {}

  const resolved = !state.pendingPermissions.has(perm.requestId);

  return `<div class="perm-inline ${resolved ? 'resolved' : ''}" data-request-id="${escHtml(perm.requestId || '')}">
    <div class="perm-inline-header">
      <span class="perm-inline-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      </span>
      <span class="perm-inline-tool">${escHtml(perm.toolName || 'Tool')}</span>
    </div>
    ${desc ? `<pre class="perm-inline-desc">${escHtml(_truncate(desc, 200))}</pre>` : ''}
    ${resolved
      ? '<div class="perm-inline-resolved">Resolved</div>'
      : `<div class="perm-inline-actions">
          <button class="btn-action btn-allow"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> ${t('misc.allow')}</button>
          <button class="btn-action btn-deny"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> ${t('misc.deny')}</button>
        </div>`
    }
  </div>`;
}

function _respondInlinePermission(el, allow) {
  const requestId = el.dataset.requestId;
  if (!requestId || !state.pendingPermissions.has(requestId)) return;
  navigator.vibrate?.(10);
  wsSend('chat:permission-response', {
    requestId,
    result: { behavior: allow ? 'allow' : 'deny' },
  });
  state.pendingPermissions.delete(requestId);
  el.classList.add('resolved');
  const actionsEl = el.querySelector('.perm-inline-actions');
  if (actionsEl) actionsEl.innerHTML = `<div class="perm-inline-resolved">${allow ? 'Allowed' : 'Denied'}</div>`;
}

// ─── Chat Input ───────────────────────────────────────────────────────────────

function setupChatInput() {
  const input = $('chat-input');
  const sendBtn = $('send-btn');
  const interruptBtn = $('interrupt-btn');
  if (!input) return;

  input.addEventListener('input', () => {
    updateSendBtn();
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    _updateAutocomplete();
  });
  input.addEventListener('keydown', (e) => {
    // Autocomplete navigation
    if (_handleAutocompleteKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  sendBtn.addEventListener('click', sendMessage);
  interruptBtn.addEventListener('click', interruptSession);

  // Scroll FAB
  const chatMsgs = $('chat-messages');
  if (chatMsgs) {
    chatMsgs.addEventListener('scroll', _updateScrollFab);
  }
}

// ─── Autocomplete System (Slash Commands + Mentions) ─────────────────────────

const _MENTION_ICONS = {
  file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  git: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>',
  terminal: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  errors: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  todos: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
};

function _getMentionTypes() {
  return [
    { type: 'file', label: '@file', desc: t('mention.file'), icon: _MENTION_ICONS.file, hasPicker: true },
    { type: 'git', label: '@git', desc: t('mention.git'), icon: _MENTION_ICONS.git },
    { type: 'terminal', label: '@terminal', desc: t('mention.terminal'), icon: _MENTION_ICONS.terminal },
    { type: 'errors', label: '@errors', desc: t('mention.errors'), icon: _MENTION_ICONS.errors },
    { type: 'todos', label: '@todos', desc: t('mention.todos'), icon: _MENTION_ICONS.todos },
  ];
}

function _getSlashDefaults() {
  return [
    { cmd: '/compact', desc: t('slash.compact') },
    { cmd: '/clear', desc: t('slash.clear') },
    { cmd: '/help', desc: t('slash.help') },
  ];
}

let _acMode = null; // 'slash' | 'mention-types' | 'mention-file' | null
let _acIndex = 0;
let _acItems = [];
let _pendingMentions = []; // [{type, label, icon, data?}]

function _updateAutocomplete() {
  const input = $('chat-input');
  if (!input) return;
  const text = input.value;
  const cursor = input.selectionStart;
  const before = text.substring(0, cursor);

  // Slash commands: / at start, no space yet
  if (text.startsWith('/') && !text.includes(' ') && !text.includes('\n')) {
    _showSlashDropdown(text.slice(1).toLowerCase());
    return;
  }

  // File picker mode: @file followed by space + query
  if (_acMode === 'mention-file') {
    const match = before.match(/@file\s+(.*)$/i);
    if (match) {
      _showFilePicker(match[1]);
      return;
    }
    // Lost the @file prefix — exit picker
    _hideAutocomplete();
    return;
  }

  // Mention types: @ at word boundary
  const atMatch = before.match(/@(\w*)$/);
  if (atMatch) {
    _showMentionTypes(atMatch[1].toLowerCase());
    return;
  }

  _hideAutocomplete();
}

function _showSlashDropdown(query) {
  const all = state.slashCommands.length > 0
    ? state.slashCommands.map(c => {
        const cmd = c.startsWith('/') ? c : '/' + c;
        const def = _getSlashDefaults().find(d => d.cmd === cmd);
        return { cmd, desc: def?.desc || '' };
      })
    : _getSlashDefaults();

  const filtered = all.filter(c => c.cmd.slice(1).includes(query));
  if (!filtered.length) { _hideAutocomplete(); return; }

  _acMode = 'slash';
  _acItems = filtered;
  _acIndex = Math.min(_acIndex, filtered.length - 1);

  const dd = $('autocomplete-dropdown');
  dd.innerHTML = filtered.map((c, i) => `
    <div class="ac-item${i === _acIndex ? ' active' : ''}" data-idx="${i}">
      <span class="ac-cmd">${escHtml(c.cmd)}</span>
      ${c.desc ? `<span class="ac-desc">${escHtml(c.desc)}</span>` : ''}
    </div>
  `).join('');
  dd.classList.remove('hidden');
  _bindAcClicks();
}

function _showMentionTypes(query) {
  const filtered = _getMentionTypes().filter(m => m.type.includes(query));
  if (!filtered.length) { _hideAutocomplete(); return; }

  _acMode = 'mention-types';
  _acItems = filtered;
  _acIndex = Math.min(_acIndex, filtered.length - 1);

  const dd = $('autocomplete-dropdown');
  dd.innerHTML = filtered.map((m, i) => `
    <div class="ac-item${i === _acIndex ? ' active' : ''}" data-idx="${i}">
      <span class="ac-icon">${m.icon}</span>
      <span class="ac-cmd">${escHtml(m.label)}</span>
      <span class="ac-desc">${escHtml(m.desc)}</span>
    </div>
  `).join('');
  dd.classList.remove('hidden');
  _bindAcClicks();
}

function _showFilePicker(query) {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? state.fileList.filter(f => f.path.toLowerCase().includes(q))
    : state.fileList;
  const shown = filtered.slice(0, 30);

  _acMode = 'mention-file';
  _acItems = shown;
  _acIndex = Math.min(_acIndex, Math.max(shown.length - 1, 0));

  const dd = $('autocomplete-dropdown');
  if (!shown.length) {
    dd.innerHTML = `<div class="ac-item ac-empty">${t('chat.noFiles')}</div>`;
    dd.classList.remove('hidden');
    return;
  }
  dd.innerHTML = shown.map((f, i) => `
    <div class="ac-item${i === _acIndex ? ' active' : ''}" data-idx="${i}">
      <span class="ac-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>
      <span class="ac-file-path">${escHtml(f.path)}</span>
    </div>
  `).join('');
  dd.classList.remove('hidden');
  _bindAcClicks();
}

let _acDelegationSet = false;
function _bindAcClicks() {
  if (_acDelegationSet) return;
  _acDelegationSet = true;
  const dd = $('autocomplete-dropdown');
  dd.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.ac-item:not(.ac-empty)');
    if (!item) return;
    e.preventDefault();
    _acIndex = parseInt(item.dataset.idx) || 0;
    _selectAcItem();
  });
}

function _selectAcItem() {
  if (_acMode === 'slash') {
    const item = _acItems[_acIndex];
    if (!item) return;
    const input = $('chat-input');
    input.value = item.cmd;
    input.focus();
    _hideAutocomplete();
  } else if (_acMode === 'mention-types') {
    const item = _acItems[_acIndex];
    if (!item) return;
    if (item.hasPicker) {
      // Switch to file picker mode
      const input = $('chat-input');
      const cursor = input.selectionStart;
      const before = input.value.substring(0, cursor);
      const after = input.value.substring(cursor);
      const cleaned = before.replace(/@\w*$/, '@file ');
      input.value = cleaned + after;
      input.selectionStart = input.selectionEnd = cleaned.length;
      _acMode = 'mention-file';
      _acIndex = 0;
      // Request file list from server if not cached
      if (!state.fileList.length) _requestFileList();
      _showFilePicker('');
      input.focus();
    } else {
      // Direct mention — add chip
      _removeAtTrigger();
      _addMentionChip(item.type, item.label, item.icon);
      _hideAutocomplete();
      $('chat-input')?.focus();
    }
  } else if (_acMode === 'mention-file') {
    const item = _acItems[_acIndex];
    if (!item) return;
    _removeAtTrigger();
    _addMentionChip('file', `@${item.path}`, _getMentionTypes()[0].icon, { path: item.path, fullPath: item.fullPath });
    _hideAutocomplete();
    $('chat-input')?.focus();
  }
}

function _hideAutocomplete() {
  const dd = $('autocomplete-dropdown');
  if (dd) { dd.classList.add('hidden'); dd.innerHTML = ''; }
  _acMode = null;
  _acIndex = 0;
  _acItems = [];
}

function _handleAutocompleteKey(e) {
  if (!_acMode) return false;
  const dd = $('autocomplete-dropdown');
  if (dd?.classList.contains('hidden')) return false;

  const items = dd.querySelectorAll('.ac-item:not(.ac-empty)');
  if (!items.length) {
    if (e.key === 'Escape') { e.preventDefault(); _hideAutocomplete(); return true; }
    return false;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _acIndex = Math.min(_acIndex + 1, items.length - 1);
    _highlightAcItem(items);
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    _acIndex = Math.max(_acIndex - 1, 0);
    _highlightAcItem(items);
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    _selectAcItem();
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    _hideAutocomplete();
    return true;
  }
  return false;
}

function _highlightAcItem(items) {
  items.forEach((el, i) => el.classList.toggle('active', i === _acIndex));
  items[_acIndex]?.scrollIntoView({ block: 'nearest' });
}

function _removeAtTrigger() {
  const input = $('chat-input');
  if (!input) return;
  const cursor = input.selectionStart;
  const before = input.value.substring(0, cursor);
  const after = input.value.substring(cursor);
  // Remove @word or @file ... from before cursor
  const cleaned = before.replace(/@\w*(\s+\S*)?$/, '');
  input.value = cleaned + after;
  input.selectionStart = input.selectionEnd = cleaned.length;
}

// ─── Mention Chips ─────────────────────────────────────────────────────────────

function _addMentionChip(type, label, icon, data) {
  _pendingMentions.push({ type, label, icon, data: data || null });
  _renderMentionChips();
}

function _removeMentionChip(idx) {
  _pendingMentions.splice(idx, 1);
  _renderMentionChips();
}

function _renderMentionChips() {
  const container = $('mention-chips');
  if (!container) return;
  if (!_pendingMentions.length) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = _pendingMentions.map((chip, i) => `
    <span class="mention-chip">
      <span class="mention-chip-icon">${chip.icon}</span>
      <span class="mention-chip-label">${escHtml(chip.label)}</span>
      <button class="mention-chip-remove" data-idx="${i}">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </span>
  `).join('');
  // Delegation is set up once in _setupMentionChipsDelegation()
}

function _setupMentionChipsDelegation() {
  const container = $('mention-chips');
  if (!container) return;
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.mention-chip-remove');
    if (!btn) return;
    e.stopPropagation();
    _removeMentionChip(parseInt(btn.dataset.idx));
  });
}

function _requestFileList() {
  wsSend('mention:file-list', { projectId: state.selectedProjectId });
}

function onFileList(data) {
  state.fileList = data.files || [];
  // Refresh the picker if we're in file picker mode
  if (_acMode === 'mention-file') {
    const input = $('chat-input');
    const cursor = input?.selectionStart || 0;
    const before = (input?.value || '').substring(0, cursor);
    const match = before.match(/@file\s+(.*)$/i);
    _showFilePicker(match ? match[1] : '');
  }
}

function updateSendBtn() {
  const input = $('chat-input');
  const sendBtn = $('send-btn');
  const hasContent = !!(input?.value.trim() || _pendingImage || _pendingMentions.length);
  const hasTarget = !!(state.selectedSessionId || state.selectedProjectId);
  if (sendBtn) sendBtn.disabled = !hasContent || !hasTarget;
}

// ─── Image Attachment ─────────────────────────────────────────────────────────

let _pendingImage = null; // { base64, mediaType, dataUrl }

function openCamera() {
  $('plus-menu')?.classList.add('hidden');
  $('camera-input')?.click();
}

function openGallery() {
  $('plus-menu')?.classList.add('hidden');
  $('gallery-input')?.click();
}

function _setupImageInputs() {
  $('camera-input')?.addEventListener('change', _handleImagePick);
  $('gallery-input')?.addEventListener('change', _handleImagePick);
}

function _handleImagePick(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = ''; // reset so same file can be picked again

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return;
    _pendingImage = {
      mediaType: match[1],
      base64: match[2],
      dataUrl,
    };
    _showImagePreview(dataUrl);
    updateSendBtn();
  };
  reader.readAsDataURL(file);
}

function _showImagePreview(dataUrl) {
  const bar = $('image-preview-bar');
  const img = $('image-preview-img');
  if (bar && img) {
    img.src = dataUrl;
    bar.classList.remove('hidden');
  }
}

function removeImage() {
  _pendingImage = null;
  const bar = $('image-preview-bar');
  if (bar) bar.classList.add('hidden');
  updateSendBtn();
}

// ─── Send Message ─────────────────────────────────────────────────────────────

function sendMessage() {
  const input = $('chat-input');
  const text = input.value.trim();
  const image = _pendingImage;
  const mentions = _pendingMentions.length ? [..._pendingMentions] : [];
  if (!text && !image && !mentions.length) return;

  navigator.vibrate?.(10);
  _hideAutocomplete();
  _debugLog('[Send] cloudMode=' + state.cloudSessionMode, 'headlessId=' + state._headlessSessionId, 'offline=' + state.desktopOffline, 'relay=' + conn.mode);

  // Headless cloud mode: follow-up messages go to cloud API
  if (state.cloudSessionMode && state._headlessSessionId) {
    input.value = '';
    input.style.height = 'auto';
    _clearImageAfterSend();
    _clearMentionsAfterSend();
    _sendHeadlessMessage(text);
    updateSendBtn();
    return;
  }

  // Desktop offline in relay mode: start a headless session
  if (state.desktopOffline && conn.mode === 'relay' && conn.cloudUrl && conn.cloudApiKey) {
    const project = state.projects.find(p => p.id === state.selectedProjectId);
    if (!project) return;
    const projectName = project.name || project.path?.split(/[\\/]/).pop() || '';
    input.value = '';
    input.style.height = 'auto';
    _clearImageAfterSend();
    _clearMentionsAfterSend();
    _startHeadlessSession(projectName, text);
    updateSendBtn();
    return;
  }

  // Build images array for WS
  const images = image ? [{ base64: image.base64, mediaType: image.mediaType }] : [];
  // Build mentions array for WS (type + data)
  const mentionsPayload = mentions.map(m => ({ type: m.type, data: m.data || null }));

  if (!state.selectedSessionId) {
    const project = state.projects.find(p => p.id === state.selectedProjectId);
    if (!project) return;
    state._pendingUserMessage = text || (image ? t('chat.imageAttached') : mentions.map(m => m.label).join(' '));
    wsSend('chat:start', {
      cwd: project.path,
      prompt: text || '',
      images,
      mentions: mentionsPayload,
      model: state.selectedModel,
      effort: state.selectedEffort,
    });
    input.value = '';
    input.style.height = 'auto';
    _clearImageAfterSend();
    _clearMentionsAfterSend();
    setInputState('sending');
    updateSendBtn();
    return;
  }

  const session = state.sessions[state.selectedSessionId];
  if (session) {
    session.messages.push({
      role: 'user',
      content: text || t('chat.imageAttached'),
      imageUrl: image?.dataUrl || null,
      mentionLabels: mentions.map(m => m.label),
    });
    renderChatMessages();
    _saveSessions();
  }
  wsSend('chat:send', { sessionId: state.selectedSessionId, text: text || '', images, mentions: mentionsPayload });
  input.value = '';
  input.style.height = 'auto';
  _clearImageAfterSend();
  _clearMentionsAfterSend();
  setInputState('sending');
  updateSendBtn();
}

function _clearMentionsAfterSend() {
  _pendingMentions = [];
  _renderMentionChips();
}

function _clearImageAfterSend() {
  _pendingImage = null;
  const bar = $('image-preview-bar');
  if (bar) bar.classList.add('hidden');
}

function interruptSession() {
  if (state.selectedSessionId) {
    wsSend('chat:interrupt', { sessionId: state.selectedSessionId });
    setInputState('idle');
  }
}

function setInputState(s) {
  const sendBtn = $('send-btn');
  const interruptBtn = $('interrupt-btn');
  if (s === 'sending') {
    sendBtn.classList.add('hidden');
    interruptBtn.classList.remove('hidden');
  } else {
    interruptBtn.classList.add('hidden');
    sendBtn.classList.remove('hidden');
    updateSendBtn();
  }
}

// ─── Plus Menu (Model & Thinking Switcher) ────────────────────────────────────

function setupPlusMenu() {
  const btn = $('plus-menu-btn');
  const menu = $('plus-menu');
  if (!btn || !menu) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !menu.classList.contains('hidden');
    if (isOpen) {
      _closePlusMenu();
    } else {
      _openPlusMenu();
    }
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== btn) {
      _closePlusMenu();
    }
  });

  // Model options
  $('model-options')?.querySelectorAll('.plus-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const modelId = opt.dataset.model;
      if (modelId) _selectModel(modelId);
    });
  });

  // Effort options
  $('effort-options')?.querySelectorAll('.plus-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const effort = opt.dataset.effort;
      if (effort) _selectEffort(effort);
    });
  });

  // Initialize selection state
  _updatePlusMenuSelection();
}

function _openPlusMenu() {
  const menu = $('plus-menu');
  const btn = $('plus-menu-btn');
  if (!menu) return;
  menu.classList.remove('hidden');
  btn?.classList.add('open');
  _updatePlusMenuSelection();
}

function _closePlusMenu() {
  const menu = $('plus-menu');
  const btn = $('plus-menu-btn');
  if (!menu) return;
  menu.classList.add('hidden');
  btn?.classList.remove('open');
}

function _updatePlusMenuSelection() {
  // Model
  $('model-options')?.querySelectorAll('.plus-option').forEach(opt => {
    const isSelected = opt.dataset.model === state.selectedModel;
    opt.classList.toggle('selected', isSelected);
  });
  // Effort
  $('effort-options')?.querySelectorAll('.plus-option').forEach(opt => {
    const isSelected = opt.dataset.effort === state.selectedEffort;
    opt.classList.toggle('selected', isSelected);
  });
}

function _selectModel(modelId) {
  state.selectedModel = modelId;
  _updatePlusMenuSelection();

  // If there's an active session, update it mid-session
  if (state.selectedSessionId) {
    wsSend('settings:update', { sessionId: state.selectedSessionId, model: modelId });
  }
  _closePlusMenu();
}

function _selectEffort(effort) {
  state.selectedEffort = effort;
  _updatePlusMenuSelection();

  // If there's an active session, update it mid-session
  if (state.selectedSessionId) {
    wsSend('settings:update', { sessionId: state.selectedSessionId, effort });
  }
  _closePlusMenu();
}

// Use escHtml() below for all HTML escaping (includes &quot;)

// ─── Scroll FAB ───────────────────────────────────────────────────────────────

function _updateScrollFab() {
  const container = $('chat-messages');
  const fab = $('scroll-fab');
  if (!container || !fab) return;
  const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  fab.classList.toggle('hidden', distFromBottom < 120);
}

function _scrollToBottomSmooth() {
  const container = $('chat-messages');
  if (container) container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
}

// ─── Git View ─────────────────────────────────────────────────────────────────

let _gitData = null;
let _gitBusy = null; // 'pull' | 'push' | null

function gitPull() {
  if (_gitBusy) return;
  const project = state.projects.find(p => p.id === state.selectedProjectId);
  if (!project?.path) return;
  _gitBusy = 'pull';
  _updateGitBtns();
  wsSend('git:pull', { cwd: project.path });
}

function gitPush() {
  if (_gitBusy) return;
  const project = state.projects.find(p => p.id === state.selectedProjectId);
  if (!project?.path) return;
  _gitBusy = 'push';
  _updateGitBtns();
  wsSend('git:push', { cwd: project.path });
}

function onGitResult(action, data) {
  _gitBusy = null;
  _updateGitBtns();
  const btn = $(action === 'pull' ? 'btn-git-pull' : 'btn-git-push');
  if (btn) {
    btn.classList.add(data.success ? 'flash-ok' : 'flash-err');
    setTimeout(() => btn.classList.remove('flash-ok', 'flash-err'), 800);
  }
}

function _updateGitBtns() {
  const pullBtn = $('btn-git-pull');
  const pushBtn = $('btn-git-push');
  if (pullBtn) pullBtn.classList.toggle('busy', _gitBusy === 'pull');
  if (pushBtn) pushBtn.classList.toggle('busy', _gitBusy === 'push');
}

function renderGitView() {
  const container = $('git-content');
  if (!container) return;

  // Request fresh git status
  const project = state.projects.find(p => p.id === state.selectedProjectId);
  if (project?.path) {
    wsSend('git:status', { cwd: project.path });
  }

  if (!_gitData || !_gitData.isGitRepo) {
    container.innerHTML = `
      <div class="git-loading">
        <div class="tool-spinner"></div>
        <span style="margin-left:10px;color:var(--text-muted)">${t('git.loading')}</span>
      </div>`;
    return;
  }

  _renderGitData(container, _gitData);
}

function onGitStatus(data) {
  _gitData = data;
  _updateGitBadges(data);
  if (state.currentView === 'git') {
    const container = $('git-content');
    if (container) _renderGitData(container, data);
  }
}

function _updateGitBadges(git) {
  const ahead = git?.aheadBehind?.ahead || 0;
  const behind = git?.aheadBehind?.behind || 0;
  const badgeAhead = $('badge-ahead');
  const badgeBehind = $('badge-behind');
  if (badgeAhead) {
    badgeAhead.textContent = `↑${ahead}`;
    badgeAhead.classList.toggle('hidden', ahead === 0);
  }
  if (badgeBehind) {
    badgeBehind.textContent = `↓${behind}`;
    badgeBehind.classList.toggle('hidden', behind === 0);
  }
}

function _renderGitData(container, git) {
  if (!git.isGitRepo) {
    container.innerHTML = `<div class="git-empty">${t('git.notRepo')}</div>`;
    return;
  }

  const branch = escHtml(git.branch || 'unknown');
  const ahead = git.aheadBehind?.ahead || 0;
  const behind = git.aheadBehind?.behind || 0;
  const files = git.files || { staged: [], unstaged: [], untracked: [] };
  const totalChanges = files.staged.length + files.unstaged.length + files.untracked.length;
  const lastCommit = git.commit;

  let html = '';

  // Branch card
  html += `
    <div class="git-card git-branch-card">
      <div class="git-card-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>
      </div>
      <div class="git-card-body">
        <div class="git-branch-name">${branch}</div>
        <div class="git-branch-meta">
          ${ahead > 0 ? `<span class="git-ahead">↑${ahead}</span>` : ''}
          ${behind > 0 ? `<span class="git-behind">↓${behind}</span>` : ''}
          ${ahead === 0 && behind === 0 ? `<span class="git-synced">${t('git.upToDate')}</span>` : ''}
        </div>
      </div>
    </div>`;

  // Last commit
  if (lastCommit) {
    html += `
      <div class="git-card">
        <div class="git-card-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2"><circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/></svg>
        </div>
        <div class="git-card-body">
          <div class="git-commit-msg">${escHtml(lastCommit.message || '')}</div>
          <div class="git-commit-meta"><span class="git-commit-hash">${escHtml(lastCommit.hash || '')}</span> · ${escHtml(lastCommit.date || '')}</div>
        </div>
      </div>`;
  }

  // Changes section
  if (totalChanges > 0) {
    html += `<div class="git-section-title">${t('git.changes')} <span class="git-changes-count">${totalChanges}</span></div>`;

    const renderFile = (f, type) => {
      const statusClass = type === 'staged' ? 'staged' : type === 'untracked' ? 'untracked' : 'modified';
      const statusLabel = type === 'staged' ? 'S' : type === 'untracked' ? '?' : 'M';
      return `<div class="git-file ${statusClass}"><span class="git-file-status">${statusLabel}</span><span class="git-file-name">${escHtml(f.file || f)}</span></div>`;
    };

    if (files.staged.length) {
      files.staged.forEach(f => { html += renderFile(f, 'staged'); });
    }
    if (files.unstaged.length) {
      files.unstaged.forEach(f => { html += renderFile(f, 'modified'); });
    }
    if (files.untracked.length) {
      files.untracked.forEach(f => { html += renderFile(f, 'untracked'); });
    }
  } else {
    html += `<div class="git-clean">${t('git.clean')} ✓</div>`;
  }

  // Recent commits
  if (git.recentCommits?.length) {
    html += `<div class="git-section-title">${t('git.recentCommits')}</div>`;
    for (const c of git.recentCommits.slice(0, 5)) {
      html += `
        <div class="git-commit-row">
          <span class="git-commit-hash">${escHtml((c.hash || '').slice(0, 7))}</span>
          <span class="git-commit-text">${escHtml(c.message || '')}</span>
        </div>`;
    }
  }

  container.innerHTML = html;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function formatDuration(ms) {
  if (!ms) return '0m';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function renderDashboard() {
  const timeEl = $('dash-time');
  if (timeEl) timeEl.textContent = formatDuration(state.todayMs);

  const projectEl = $('dash-project');
  if (projectEl) {
    const activeProject = state.projects.find(p => p.id === state.selectedProjectId);
    projectEl.textContent = activeProject?.name || '—';
  }

  const sessionsEl = $('dash-sessions');
  if (sessionsEl) sessionsEl.textContent = Object.keys(state.sessions).length;

  const list = $('projects-status-list');
  if (!list) return;
  const projects = state.projects.slice(0, 8);
  if (!projects.length) {
    list.innerHTML = `<div class="dash-empty-hint">${t('project.noProjectsDash')}</div>`;
    return;
  }
  list.innerHTML = projects.map((p, i) => {
    const color = escHtml(p.color || '#d97706');
    const icon = p.icon ? escHtml(p.icon) : escHtml((p.name || p.id).charAt(0).toUpperCase());
    return `
    <div class="project-status-item" style="animation-delay:${i * 0.03}s">
      <div class="project-status-icon" style="background:${color}18;color:${color}">${icon}</div>
      <span class="project-status-name">${escHtml(p.name || p.id)}</span>
    </div>`;
  }).join('');
}

// ─── Accent Color ─────────────────────────────────────────────────────────────

function _applyAccentColor(hex) {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  const r = document.documentElement;
  r.style.setProperty('--accent', hex);
  // Compute hover (lighten ~15%)
  const [rr, gg, bb] = [1, 3, 5].map(i => Math.min(255, parseInt(hex.slice(i, i + 2), 16) + 30));
  r.style.setProperty('--accent-hover', `#${[rr, gg, bb].map(c => c.toString(16).padStart(2, '0')).join('')}`);
  // Compute dim (12% opacity)
  const [dr, dg, db] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  r.style.setProperty('--accent-dim', `rgba(${dr},${dg},${db},0.12)`);
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Syntax Highlighting ──────────────────────────────────────────────────────

const SYN_LANG_MAP = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  json: 'json',
  html: 'html', htm: 'html', xml: 'html',
  css: 'css', scss: 'css', less: 'css',
  lua: 'lua',
  py: 'python', python: 'python',
  md: 'markdown',
  yaml: 'yaml', yml: 'yaml',
  sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash',
  sql: 'sql',
  rs: 'rust', rust: 'rust',
  go: 'go',
  java: 'java', cs: 'java', cpp: 'java', c: 'java', php: 'java',
  rb: 'ruby', ruby: 'ruby',
  javascript: 'javascript', typescript: 'typescript',
};

const SYN_COMMENT = {
  lua: /(--[^\n]*)/g, sql: /(--[^\n]*)/g,
  python: /(#[^\n]*)/g, ruby: /(#[^\n]*)/g, bash: /(#[^\n]*)/g, yaml: /(#[^\n]*)/g,
  html: /(&lt;!--[\s\S]*?--&gt;)/g,
};

const SYN_KEYWORDS = {
  javascript: /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|import|export|default|from|async|await|try|catch|finally|throw|typeof|instanceof|in|of|null|undefined|true|false|yield|delete|void|super|static|get|set)\b/g,
  typescript: /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|import|export|default|from|async|await|try|catch|finally|throw|typeof|instanceof|in|of|null|undefined|true|false|yield|delete|void|super|static|get|set|type|interface|enum|namespace|declare|abstract|implements|readonly|as|is|keyof|infer|never|unknown|any)\b/g,
  python: /\b(def|class|return|if|elif|else|for|while|break|continue|import|from|as|try|except|finally|raise|with|yield|lambda|pass|del|global|nonlocal|assert|True|False|None|and|or|not|in|is|async|await|self)\b/g,
  lua: /\b(local|function|return|if|then|else|elseif|end|for|while|do|repeat|until|break|in|and|or|not|nil|true|false|goto|self)\b/g,
  html: /\b(DOCTYPE|html|head|body|div|span|script|style|link|meta|title|class|id|src|href|rel|type)\b/g,
  css: /\b(display|flex|grid|position|width|height|margin|padding|border|background|color|font|text|align|justify|content|items|overflow|z-index|opacity|transition|transform|animation|none|auto|inherit|initial|important)\b/g,
  yaml: /\b(true|false|null|yes|no)\b/g,
  bash: /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|echo|export|source|cd|ls|grep|sed|awk|cat|mkdir|rm|cp|mv|chmod|sudo|npm|node|git|docker)\b/g,
  sql: /\b(SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TABLE|INTO|VALUES|SET|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|NULL|IS|IN|LIKE|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|AS|DISTINCT|COUNT|SUM|AVG|MAX|MIN|INDEX|PRIMARY|KEY|FOREIGN|REFERENCES|CASCADE|UNIQUE|DEFAULT|EXISTS|BETWEEN|UNION|CASE|WHEN|THEN|ELSE|END|BEGIN|COMMIT|ROLLBACK)\b/gi,
  rust: /\b(fn|let|mut|const|if|else|for|while|loop|break|continue|return|match|struct|enum|impl|trait|pub|use|mod|crate|self|super|as|in|ref|move|async|await|unsafe|where|type|true|false|Some|None|Ok|Err)\b/g,
  go: /\b(func|var|const|if|else|for|range|switch|case|default|break|continue|return|go|defer|select|chan|map|struct|interface|type|package|import|true|false|nil|make|new|len|cap|append|delete|copy|panic|recover)\b/g,
  java: /\b(public|private|protected|static|final|abstract|class|interface|extends|implements|return|if|else|for|while|do|switch|case|break|continue|new|this|super|try|catch|finally|throw|throws|import|package|void|int|long|float|double|boolean|char|null|true|false|instanceof|enum|override|using|namespace|string|var|const|virtual|struct)\b/g,
  ruby: /\b(def|class|module|return|if|elsif|else|unless|for|while|do|end|begin|rescue|ensure|raise|yield|include|require|attr_reader|attr_writer|attr_accessor|self|super|nil|true|false|and|or|not|in|puts|print|lambda|proc)\b/g,
};

function syntaxHighlight(code, langHint) {
  const lang = SYN_LANG_MAP[langHint] || null;
  if (!lang || !code) return escHtml(code || '');
  if (code.length > 50000) return escHtml(code);

  if (lang === 'json') return _synJSON(code);
  if (lang === 'markdown') return _synMarkdown(code);

  let escaped = escHtml(code);
  const tokens = [];
  const protect = (html) => { const id = tokens.length; tokens.push(html); return `\x00T${id}\x00`; };

  // Comments
  const cmtPat = SYN_COMMENT[lang] || /(\/\/[^\n]*)/g;
  escaped = escaped.replace(cmtPat, (_, m) => protect(`<span class="syn-cmt">${m}</span>`));

  // Strings (double, single, backtick)
  escaped = escaped.replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)/g, (_, m) => protect(`<span class="syn-str">${m}</span>`));
  escaped = escaped.replace(/(&#x27;(?:[^&]|&(?!#x27;))*?&#x27;)/g, (_, m) => protect(`<span class="syn-str">${m}</span>`));
  if (lang === 'javascript' || lang === 'typescript') {
    escaped = escaped.replace(/(&#96;(?:[^&]|&(?!#96;))*?&#96;)/g, (_, m) => protect(`<span class="syn-str">${m}</span>`));
  }

  // Numbers
  escaped = escaped.replace(/\b(\d+\.?\d*)\b/g, (_, m) => protect(`<span class="syn-num">${m}</span>`));

  // Keywords
  const kwRegex = SYN_KEYWORDS[lang];
  if (kwRegex) escaped = escaped.replace(kwRegex, (_, m) => protect(`<span class="syn-kw">${m}</span>`));

  // Function calls
  escaped = escaped.replace(/\b([a-zA-Z_]\w*)\s*\(/g, (_, m) => protect(`<span class="syn-fn">${m}</span>`) + '(');

  // Restore tokens
  escaped = escaped.replace(/\x00T(\d+)\x00/g, (_, i) => tokens[i]);
  return escaped;
}

function _synJSON(code) {
  let e = escHtml(code);
  e = e.replace(/(&quot;[^&]*?&quot;)\s*:/g, '<span class="syn-fn">$1</span>:');
  e = e.replace(/:\s*(&quot;[^&]*?&quot;)/g, ': <span class="syn-str">$1</span>');
  e = e.replace(/:\s*(\d+\.?\d*)/g, ': <span class="syn-num">$1</span>');
  e = e.replace(/:\s*(true|false|null)\b/g, ': <span class="syn-kw">$1</span>');
  return e;
}

function _synMarkdown(code) {
  let e = escHtml(code);
  e = e.replace(/^(#{1,6}\s.*)$/gm, '<span class="syn-kw">$1</span>');
  e = e.replace(/(\*\*[^*]+\*\*)/g, '<span class="syn-fn">$1</span>');
  e = e.replace(/(&#96;[^&]+?&#96;)/g, '<span class="syn-str">$1</span>');
  e = e.replace(/(\[[^\]]+\]\([^)]+\))/g, '<span class="syn-str">$1</span>');
  return e;
}

function _extFromPath(filePath) {
  if (!filePath) return '';
  const dot = filePath.lastIndexOf('.');
  return dot >= 0 ? filePath.slice(dot + 1).toLowerCase() : '';
}

function shortenPath(p) {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 2) return p;
  return '…/' + parts.slice(-2).join('/');
}

function _truncate(str, max) {
  if (!str) return '';
  if (str.length <= max) return str;
  return '…' + str.slice(-(max - 1));
}

function renderMarkdown(text) {
  // Extract code blocks first (before escaping), replace with placeholders
  const codeBlocks = [];
  let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    const highlighted = syntaxHighlight(code.replace(/\n$/, ''), lang || '');
    const langLabel = lang ? `<span class="code-block-lang">${escHtml(lang)}</span>` : '';
    codeBlocks.push(`<pre class="msg-code-block">${langLabel}${highlighted}</pre>`);
    return `\x00CB${idx}\x00`;
  });

  // Now escape and apply inline markdown
  processed = escHtml(processed)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');

  // Restore code blocks
  processed = processed.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[i]);
  return processed;
}

// ─── PWA Install Banner ──────────────────────────────────────────────────────

let _deferredInstallPrompt = null;

function _setupPwaInstallBanner() {
  // Already in standalone mode (installed) → skip
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) return;

  // Already dismissed
  if (localStorage.getItem('pwa_install_dismissed')) return;

  const banner = $('pwa-install-banner');
  const btn = $('pwa-install-btn');
  const closeBtn = $('pwa-install-close');
  const hint = $('pwa-install-hint');
  if (!banner || !btn || !hint) return;

  const isIos = /iP(hone|ad|od)/.test(navigator.userAgent);
  const isAndroid = /Android/.test(navigator.userAgent);

  if (isIos) {
    // iOS: no native install prompt, guide user
    hint.innerHTML = 'Tap <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="vertical-align:-2px"><path d="M12 3v12m0-12l-4 4m4-4l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 15v4a2 2 0 002 2h12a2 2 0 002-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> then <b>"Add to Home Screen"</b>';
    btn.textContent = 'OK';
    btn.addEventListener('click', () => _dismissInstallBanner());
    banner.classList.remove('hidden');
  } else if (isAndroid) {
    // Android: use beforeinstallprompt API
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      _deferredInstallPrompt = e;
      hint.textContent = 'Add to your home screen';
      btn.textContent = 'Install';
      banner.classList.remove('hidden');
    });

    btn.addEventListener('click', async () => {
      if (_deferredInstallPrompt) {
        _deferredInstallPrompt.prompt();
        const result = await _deferredInstallPrompt.userChoice;
        if (result.outcome === 'accepted') _dismissInstallBanner();
        _deferredInstallPrompt = null;
      } else {
        _dismissInstallBanner();
      }
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => _dismissInstallBanner());
  }
}

function _dismissInstallBanner() {
  const banner = $('pwa-install-banner');
  if (banner) banner.classList.add('hidden');
  localStorage.setItem('pwa_install_dismissed', '1');
}

// ─── Cloud Popup ─────────────────────────────────────────────────────────────

function _showCloudPopup(show) {
  const overlay = $('cloud-popup-overlay');
  if (!overlay) return;
  if (show) {
    // Apply i18n
    const title = $('cloud-popup-title');
    const desc = $('cloud-popup-desc');
    const ctaLabel = $('cloud-popup-cta-label');
    if (title) title.textContent = t('cloud.popupTitle');
    if (desc) desc.textContent = t('cloud.popupDesc');
    if (ctaLabel) ctaLabel.textContent = t('cloud.popupCta');
    overlay.classList.remove('hidden');
  } else {
    overlay.classList.add('hidden');
  }
}

function _onCloudPopupCta() {
  _debugLog('[Cloud] CTA clicked, fetching projects...');
  _showCloudPopup(false);
  _showHeadlessBanner(true);
  _fetchCloudProjects();
  switchView('projects');
}

function _setupCloudPopup() {
  const cta = $('cloud-popup-cta');
  const dismiss = $('cloud-popup-dismiss');
  if (cta) cta.addEventListener('click', _onCloudPopupCta);
  if (dismiss) dismiss.addEventListener('click', () => _showCloudPopup(false));
}

// ─── Headless Cloud Sessions ──────────────────────────────────────────────────

function _showHeadlessBanner(show) {
  const banner = $('headless-banner');
  const text = $('headless-banner-text');
  const badge = $('headless-badge');
  if (!banner) return;
  if (show) {
    banner.classList.remove('hidden');
    if (text) text.textContent = t('headless.banner');
    if (badge) badge.style.display = state.cloudSessionMode ? '' : 'none';
  } else {
    banner.classList.add('hidden');
    if (badge) badge.style.display = 'none';
  }
}

async function _startHeadlessSession(projectName, prompt, resumeSessionId) {
  if (!conn.cloudUrl || !conn.cloudApiKey) return;
  const base = conn.cloudUrl.replace(/\/$/, '');
  const headers = {
    'Authorization': `Bearer ${conn.cloudApiKey}`,
    'Content-Type': 'application/json',
  };

  // Update banner
  const text = $('headless-banner-text');
  if (text) text.textContent = t('headless.creating');

  try {
    // Create session via cloud API
    const body = {
      projectName,
      prompt,
      model: state.selectedModel,
      effort: state.selectedEffort,
    };
    if (resumeSessionId) body.resumeSessionId = resumeSessionId;
    const resp = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(err);
    }

    const { sessionId } = await resp.json();
    _debugLog('[Headless] Session created:', sessionId);
    state._headlessSessionId = sessionId;
    state.cloudSessionMode = true;

    // Update banner
    if (text) text.textContent = t('headless.bannerActive');
    const badge = $('headless-badge');
    if (badge) badge.style.display = '';

    // Create a local session to render messages
    const project = state.projects.find(p => p.name === projectName || p.path?.endsWith(projectName));
    const localSession = _makeSession(`headless-${sessionId}`, project?.id || '', projectName);
    localSession.messages.push({ role: 'user', content: prompt });
    state.sessions[localSession.sessionId] = localSession;
    state.selectedSessionId = localSession.sessionId;
    renderSessionBar();
    renderChatMessages();
    _saveSessions();

    // Open WS stream to receive SDK events
    _openHeadlessStream(sessionId);

    // Switch to chat view
    switchView('chat');
    setInputState('sending');

  } catch (err) {
    _debugLog('[Headless] Failed to create session:', err?.message || err);
    if (text) text.textContent = t('headless.error');
    setTimeout(() => {
      if (state.desktopOffline) {
        if (text) text.textContent = t('headless.banner');
      }
    }, 3000);
  }
}

function _openHeadlessStream(sessionId) {
  // Stream events are now received via the relay WS (type: 'stream')
  // No need to open a separate WS connection (which fails on iOS Safari)
  _debugLog('[Headless] Listening for stream events via relay WS for session:', sessionId);
}

function _handleHeadlessEvent(msg) {
  const localSessionId = `headless-${state._headlessSessionId}`;
  const session = state.sessions[localSessionId];
  if (!session) return;

  if (msg.type === 'event') {
    const event = msg.event;
    if (!event) return;

    // Translate SDK events into the format onChatMessage() expects
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text') {
          // Completed text block
          session.messages.push({ role: 'assistant', content: block.text });
          renderChatMessages();
          _saveSessions();
        } else if (block.type === 'tool_use') {
          // Tool use
          session.messages.push({
            role: 'tool',
            toolName: block.name,
            toolId: block.id,
            toolInput: block.input,
            content: '',
            status: 'running',
          });
          renderChatMessages();
          _saveSessions();
        } else if (block.type === 'tool_result') {
          // Find matching tool card and update
          const toolMsg = [...session.messages].reverse().find(m => m.toolId === block.tool_use_id);
          if (toolMsg) {
            toolMsg.status = 'done';
            toolMsg.toolOutput = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            renderChatMessages();
            _saveSessions();
          }
        }
      }
    }

    // Result event from SDK (tool_result as top-level)
    if (event.type === 'result' && event.result) {
      const text = typeof event.result === 'string' ? event.result : event.result.text;
      if (text && !session.messages.some(m => m.role === 'assistant' && m.content === text)) {
        session.messages.push({ role: 'assistant', content: text });
        renderChatMessages();
        _saveSessions();
      }
    }
  }

  if (msg.type === 'idle') {
    setInputState('idle');
  }

  if (msg.type === 'done') {
    setInputState('idle');
  }

  if (msg.type === 'error') {
    session.messages.push({ role: 'assistant', content: `Error: ${msg.error || 'Unknown error'}` });
    renderChatMessages();
    _saveSessions();
    setInputState('idle');
  }
}

async function _sendHeadlessMessage(text) {
  if (!state._headlessSessionId || !conn.cloudUrl || !conn.cloudApiKey) return;
  const base = conn.cloudUrl.replace(/\/$/, '');
  const headers = {
    'Authorization': `Bearer ${conn.cloudApiKey}`,
    'Content-Type': 'application/json',
  };

  const localSessionId = `headless-${state._headlessSessionId}`;
  const session = state.sessions[localSessionId];
  if (session) {
    session.messages.push({ role: 'user', content: text });
    renderChatMessages();
    _saveSessions();
  }

  setInputState('sending');

  try {
    await fetch(`${base}/api/sessions/${encodeURIComponent(state._headlessSessionId)}/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: text }),
    });
  } catch (err) {
    console.error('[Headless] Failed to send message:', err);
    setInputState('idle');
  }
}

function _cleanupHeadlessSession() {
  state.cloudSessionMode = false;
  state._headlessSessionId = null;
}

// ─── Start ────────────────────────────────────────────────────────────────────

init();
