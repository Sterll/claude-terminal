/**
 * Web App Terminal Panel
 * Dev server console view with info panel + live preview (webview)
 */

const { getWebAppServer, setWebAppPort } = require('./WebAppState');
const { getSetting } = require('../../../renderer/state/settings.state');
const api = window.electron_api;

// Track active poll timer per wrapper (shared between views)
const pollTimers = new WeakMap();

// Store detached webview data per previewView element
const detachedWebviews = new WeakMap();

function clearPollTimer(wrapper) {
  const timer = pollTimers.get(wrapper);
  if (timer) {
    clearInterval(timer);
    pollTimers.delete(wrapper);
  }
}

function startPortPoll(wrapper, projectIndex, onFound) {
  clearPollTimer(wrapper);
  const timer = setInterval(async () => {
    const s = getWebAppServer(projectIndex);
    if (s.status === 'stopped') { clearPollTimer(wrapper); return; }
    let p = s.port;
    if (!p) {
      try { p = await api.webapp.getPort({ projectIndex }); } catch (e) {}
    }
    if (p) {
      setWebAppPort(projectIndex, p);
      clearPollTimer(wrapper);
      onFound(p);
    }
  }, 2000);
  pollTimers.set(wrapper, timer);
}

async function resolvePort(projectIndex) {
  const server = getWebAppServer(projectIndex);
  if (server.port) return server.port;
  if (server.status !== 'running') return null;
  try {
    const p = await api.webapp.getPort({ projectIndex });
    if (p) setWebAppPort(projectIndex, p);
    return p || null;
  } catch (e) { return null; }
}

function isPreviewEnabled() {
  const val = getSetting('webappPreviewEnabled');
  return val !== undefined ? val : true;
}

// ── SVG icons ──────────────────────────────────────────────────────────
const ICON_CONSOLE = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><rect x="1" y="2" width="14" height="12" rx="2"/><path d="M4.5 6L7 8.5 4.5 11M8.5 11H12" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_PREVIEW = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><rect x="1" y="3" width="14" height="10" rx="2"/><path d="M1 6h14" stroke-linecap="round"/><circle cx="4" cy="4.5" r=".6" fill="currentColor" stroke="none"/><circle cx="6" cy="4.5" r=".6" fill="currentColor" stroke="none"/><circle cx="8" cy="4.5" r=".6" fill="currentColor" stroke="none"/></svg>`;
const ICON_INFO    = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.5v4M8 5.5v.5" stroke-linecap="round"/></svg>`;
const ICON_BACK    = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11"><path d="M7.5 2.5L4 6l3.5 3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_FWD     = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11"><path d="M4.5 2.5L8 6 4.5 9.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_RELOAD  = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11"><path d="M10 3.5A5 5 0 103.5 10" stroke-linecap="round"/><path d="M10 1.5v2H8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_OPEN    = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11"><path d="M8 2h2v2M10 2L6 6M5 3H2v7h7V7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function getViewSwitcherHtml() {
  const previewEnabled = isPreviewEnabled();
  return `
    <div class="wa-shell">
      <div class="wa-tabbar">
        <div class="wa-tabs">
          <button class="wa-tab active" data-view="console">
            ${ICON_CONSOLE}
            <span>Console</span>
          </button>
          ${previewEnabled ? `
          <button class="wa-tab" data-view="preview">
            ${ICON_PREVIEW}
            <span>Preview</span>
          </button>` : ''}
          <button class="wa-tab" data-view="info">
            ${ICON_INFO}
            <span>Info</span>
          </button>
        </div>
        <div class="wa-tabbar-right">
          <div class="wa-server-status" data-status="stopped">
            <span class="wa-status-pip"></span>
            <span class="wa-status-label"></span>
          </div>
        </div>
      </div>
      <div class="wa-body">
        <div class="webapp-console-view wa-view"></div>
        ${previewEnabled ? `<div class="webapp-preview-view wa-view"></div>` : ''}
        <div class="webapp-info-view wa-view"></div>
      </div>
    </div>
  `;
}

/**
 * Detach the webview from DOM (removes the native surface entirely).
 * Stores it so we can re-attach later without losing state.
 */
function detachWebview(previewView) {
  const webview = previewView.querySelector('.webapp-preview-webview');
  if (!webview) return;
  const currentUrl = webview.getURL();
  // Remove from DOM — this destroys the OS-level surface
  webview.remove();
  detachedWebviews.set(previewView, currentUrl);
}

/**
 * Re-attach the webview to the browser container.
 */
function attachWebview(previewView) {
  const savedUrl = detachedWebviews.get(previewView);
  if (!savedUrl || savedUrl === 'about:blank') return;
  const browserEl = previewView.querySelector('.wa-browser');
  if (!browserEl) return;
  const webview = document.createElement('webview');
  webview.className = 'webapp-preview-webview';
  webview.setAttribute('src', savedUrl);
  webview.setAttribute('disableblinkfeatures', 'Auxclick');
  browserEl.appendChild(webview);
  wireWebviewEvents(previewView, webview);
  detachedWebviews.delete(previewView);
}

/**
 * Wire up webview events (navigation, console, etc.)
 */
function wireWebviewEvents(previewView, webview) {
  const addrPath = previewView.querySelector('.wa-addr-path');
  const addrPort = previewView.querySelector('.wa-addr-port');

  webview.addEventListener('did-navigate', (e) => {
    try {
      const u = new URL(e.url);
      if (addrPort) addrPort.textContent = u.port ? `:${u.port}` : '';
      if (addrPath) addrPath.textContent = u.pathname !== '/' ? u.pathname : '';
    } catch (err) {}
  });
  webview.addEventListener('did-navigate-in-page', (e) => {
    try {
      const u = new URL(e.url);
      if (addrPath) addrPath.textContent = u.pathname !== '/' ? u.pathname : '';
    } catch (err) {}
  });

  webview.addEventListener('console-message', (e) => {
    if (e.level >= 2) {
      const logEntry = { level: e.level, message: e.message, source: e.sourceId, line: e.line };
      if (!previewView._consoleLogs) previewView._consoleLogs = [];
      previewView._consoleLogs.push(logEntry);
      if (previewView._consoleLogs.length > 100) previewView._consoleLogs.shift();
    }
  });
}

function setupViewSwitcher(wrapper, terminalId, projectIndex, project, deps) {
  const { t, getTerminal } = deps;
  const consoleView  = wrapper.querySelector('.webapp-console-view');
  const previewView  = wrapper.querySelector('.webapp-preview-view');
  const infoView     = wrapper.querySelector('.webapp-info-view');
  const statusEl     = wrapper.querySelector('.wa-server-status');
  const statusLabel  = wrapper.querySelector('.wa-status-label');

  const STATUS_LABELS = { stopped: '', starting: 'Starting', running: 'Running' };

  function refreshStatus() {
    const s = getWebAppServer(projectIndex);
    const st = s.status || 'stopped';
    if (statusEl) statusEl.dataset.status = st;
    if (statusLabel) statusLabel.textContent = STATUS_LABELS[st] || '';
  }
  refreshStatus();
  const pipInterval = setInterval(refreshStatus, 2000);
  wrapper._waPipInterval = pipInterval;

  function switchView(view) {
    const panes = [consoleView, previewView, infoView].filter(Boolean);

    wrapper.querySelectorAll('.wa-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.view === view);
    });

    panes.forEach(p => p.classList.remove('wa-view-active'));

    if (view === 'console') {
      consoleView.classList.add('wa-view-active');
      const termData = getTerminal(terminalId);
      if (termData) setTimeout(() => termData.fitAddon.fit(), 50);
    } else if (view === 'preview' && previewView) {
      previewView.classList.add('wa-view-active');
      renderPreviewView(wrapper, projectIndex, project, deps);
    } else if (view === 'info') {
      infoView.classList.add('wa-view-active');
      renderInfoView(wrapper, projectIndex, project, deps);
    }

    // Detach webview when leaving preview tab
    if (view !== 'preview' && previewView) {
      detachWebview(previewView);
    }

    const termData = getTerminal(terminalId);
    if (termData) termData.activeView = view;
  }

  // Watch for terminal tab switches (wrapper gains/loses .active class).
  // When our wrapper becomes inactive, detach the webview.
  const observer = new MutationObserver(() => {
    if (!wrapper.classList.contains('active') && previewView) {
      detachWebview(previewView);
    } else if (wrapper.classList.contains('active') && previewView && previewView.classList.contains('wa-view-active')) {
      // Re-attach if we come back to this tab and preview was the active sub-tab
      if (detachedWebviews.has(previewView)) {
        attachWebview(previewView);
      }
    }
  });
  observer.observe(wrapper, { attributes: true, attributeFilter: ['class'] });
  wrapper._waClassObserver = observer;

  // Initial state: show console
  switchView('console');

  wrapper.querySelectorAll('.wa-tab').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
}

async function renderPreviewView(wrapper, projectIndex, project, deps) {
  const { t } = deps;
  const previewView = wrapper.querySelector('.webapp-preview-view');
  if (!previewView) return;

  const port = await resolvePort(projectIndex);
  const server = getWebAppServer(projectIndex);

  if (!port) {
    if (previewView.dataset.loadedPort) delete previewView.dataset.loadedPort;

    const isStopped = server.status === 'stopped';
    previewView.innerHTML = `
      <div class="wa-empty ${isStopped ? 'is-stopped' : 'is-loading'}">
        <div class="wa-empty-visual">
          ${isStopped
            ? `<svg viewBox="0 0 48 48" fill="none" width="40" height="40"><rect x="3" y="7" width="42" height="30" rx="4" stroke="currentColor" stroke-width="1" opacity=".15"/><path d="M3 14h42" stroke="currentColor" stroke-width="1" opacity=".15"/><rect x="18" y="37" width="12" height="4" rx="1.5" fill="currentColor" opacity=".07"/><path d="M13 43h22" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".07"/><circle cx="9" cy="10.5" r="1.2" fill="currentColor" opacity=".18"/><circle cx="14" cy="10.5" r="1.2" fill="currentColor" opacity=".12"/><circle cx="19" cy="10.5" r="1.2" fill="currentColor" opacity=".08"/></svg>`
            : `<svg viewBox="0 0 48 48" fill="none" width="38" height="38" class="wa-spin-slow"><circle cx="24" cy="24" r="19" stroke="currentColor" stroke-width="1" opacity=".07"/><path d="M24 5a19 19 0 0116 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".5"/><path d="M24 11a13 13 0 0110 6" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity=".2"/></svg>`
          }
        </div>
        <div class="wa-empty-body">
          <p class="wa-empty-title">${isStopped ? 'No server running' : 'Starting up'}</p>
          <p class="wa-empty-sub">${isStopped ? 'Start the dev server to see a live preview here' : 'Waiting for port detection…'}</p>
        </div>
      </div>
    `;

    if (!isStopped) {
      startPortPoll(wrapper, projectIndex, () => {
        renderPreviewView(wrapper, projectIndex, project, deps);
      });
    }
    return;
  }

  clearPollTimer(wrapper);
  const url = `http://localhost:${port}`;

  // If webview already exists for this port, just re-attach if needed
  const existingWebview = previewView.querySelector('.webapp-preview-webview');
  if (existingWebview && previewView.dataset.loadedPort === String(port)) {
    return;
  }
  if (!existingWebview && detachedWebviews.has(previewView) && previewView.dataset.loadedPort === String(port)) {
    attachWebview(previewView);
    return;
  }

  previewView.dataset.loadedPort = String(port);
  previewView.innerHTML = `
    <div class="wa-browser">
      <div class="wa-browser-bar">
        <div class="wa-browser-nav">
          <button class="wa-browser-btn wa-back" title="Back">${ICON_BACK}</button>
          <button class="wa-browser-btn wa-fwd" title="Forward">${ICON_FWD}</button>
          <button class="wa-browser-btn wa-reload" title="Reload">${ICON_RELOAD}</button>
        </div>
        <div class="wa-address-bar">
          <span class="wa-addr-scheme">http://</span><span class="wa-addr-host">localhost</span><span class="wa-addr-port">:${port}</span><span class="wa-addr-path"></span>
        </div>
        <button class="wa-browser-btn wa-open-ext" title="${t('webapp.openBrowser')}">${ICON_OPEN}</button>
      </div>
      <webview class="webapp-preview-webview" src="${url}" disableblinkfeatures="Auxclick"></webview>
    </div>
  `;

  const webview = previewView.querySelector('.webapp-preview-webview');
  wireWebviewEvents(previewView, webview);

  previewView.querySelector('.wa-reload').onclick = () => {
    const wv = previewView.querySelector('.webapp-preview-webview');
    if (wv) wv.reload();
  };
  previewView.querySelector('.wa-back').onclick = () => {
    const wv = previewView.querySelector('.webapp-preview-webview');
    if (wv && wv.canGoBack()) wv.goBack();
  };
  previewView.querySelector('.wa-fwd').onclick = () => {
    const wv = previewView.querySelector('.webapp-preview-webview');
    if (wv && wv.canGoForward()) wv.goForward();
  };
  previewView.querySelector('.wa-open-ext').onclick = () => {
    const wv = previewView.querySelector('.webapp-preview-webview');
    api.dialog.openExternal(wv ? wv.getURL() : url);
  };
}

async function renderInfoView(wrapper, projectIndex, project, deps) {
  const { t } = deps;
  const server = getWebAppServer(projectIndex);
  const infoView = wrapper.querySelector('.webapp-info-view');
  if (!infoView) return;

  const port = await resolvePort(projectIndex);
  const url = port ? `http://localhost:${port}` : null;

  const STATUS = {
    stopped:  { cls: 'stopped',  label: 'Stopped',  desc: 'Dev server is not running' },
    starting: { cls: 'starting', label: 'Starting', desc: 'Launching dev server…'     },
    running:  { cls: 'running',  label: 'Running',  desc: url || 'Server active'       },
  };
  const st = STATUS[server.status] || STATUS.stopped;

  const framework = project.framework || project.webFramework || null;
  const devCmd    = project.devCommand || 'auto';
  const projectName = project.name || 'Web App';

  const ICON_STATUS_RUNNING = `<svg viewBox="0 0 20 20" fill="none" width="18" height="18"><circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.2" opacity=".25"/><circle cx="10" cy="10" r="4" fill="currentColor"/></svg>`;
  const ICON_STATUS_STOPPED = `<svg viewBox="0 0 20 20" fill="none" width="18" height="18"><circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.2" opacity=".25"/><rect x="7.5" y="7.5" width="5" height="5" rx="1" fill="currentColor" opacity=".5"/></svg>`;
  const ICON_GLOBE = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" width="13" height="13"><circle cx="8" cy="8" r="6.5"/><path d="M8 1.5C6 4 5 6 5 8s1 4 3 6.5M8 1.5C10 4 11 6 11 8s-1 4-3 6.5M1.5 8h13" stroke-linecap="round"/></svg>`;
  const ICON_TERMINAL = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" width="13" height="13"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6L7 8.5 4.5 11M8.5 11H12" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const ICON_PORT = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" width="13" height="13"><path d="M8 2v12M4 5h8M3 9h10" stroke-linecap="round"/><rect x="5" y="7" width="6" height="4" rx="1"/></svg>`;

  infoView.innerHTML = `
    <div class="wa-info">

      <div class="wa-info-hero ${st.cls}">
        <div class="wa-info-hero-bg"></div>
        <div class="wa-info-hero-content">
          <div class="wa-info-hero-icon">${server.status === 'running' ? ICON_STATUS_RUNNING : ICON_STATUS_STOPPED}</div>
          <div class="wa-info-hero-text">
            <div class="wa-info-hero-label">${st.label}</div>
            <div class="wa-info-hero-sub">${st.desc}</div>
          </div>
          ${url ? `<button class="wa-info-cta webapp-open-url" data-url="${url}">${ICON_OPEN}<span>Open</span></button>` : ''}
        </div>
      </div>

      <div class="wa-info-grid">
        <div class="wa-info-tile">
          <div class="wa-info-tile-icon">${ICON_PORT}</div>
          <div class="wa-info-tile-body">
            <div class="wa-info-tile-label">Port</div>
            <div class="wa-info-tile-val wa-mono">${port ? port : '—'}</div>
          </div>
        </div>
        <div class="wa-info-tile">
          <div class="wa-info-tile-icon">${ICON_TERMINAL}</div>
          <div class="wa-info-tile-body">
            <div class="wa-info-tile-label">Command</div>
            <div class="wa-info-tile-val wa-mono">${devCmd}</div>
          </div>
        </div>
        ${framework ? `
        <div class="wa-info-tile">
          <div class="wa-info-tile-icon">${ICON_GLOBE}</div>
          <div class="wa-info-tile-body">
            <div class="wa-info-tile-label">Framework</div>
            <div class="wa-info-tile-val">${framework}</div>
          </div>
        </div>` : ''}
        ${url ? `
        <div class="wa-info-tile wa-info-tile-link webapp-open-url" data-url="${url}" role="button" tabindex="0">
          <div class="wa-info-tile-icon">${ICON_GLOBE}</div>
          <div class="wa-info-tile-body">
            <div class="wa-info-tile-label">Local URL</div>
            <div class="wa-info-tile-val wa-mono">${url}</div>
          </div>
          <div class="wa-info-tile-arrow">${ICON_OPEN}</div>
        </div>` : ''}
      </div>

    </div>
  `;

  infoView.querySelectorAll('.webapp-open-url').forEach(el => {
    el.style.cursor = 'pointer';
    el.onclick = () => {
      const u = el.dataset.url;
      if (u) api.dialog.openExternal(u);
    };
  });

  if (!port && server.status === 'running') {
    startPortPoll(wrapper, projectIndex, () => {
      renderInfoView(wrapper, projectIndex, project, deps);
    });
  }
}

function cleanup(wrapper) {
  clearPollTimer(wrapper);
  if (wrapper._waPipInterval) clearInterval(wrapper._waPipInterval);
  if (wrapper._waClassObserver) {
    wrapper._waClassObserver.disconnect();
    delete wrapper._waClassObserver;
  }
  const previewView = wrapper.querySelector('.webapp-preview-view');
  if (previewView) {
    const webview = previewView.querySelector('.webapp-preview-webview');
    if (webview) webview.remove();
    detachedWebviews.delete(previewView);
    delete previewView.dataset.loadedPort;
  }
}

module.exports = {
  getViewSwitcherHtml,
  setupViewSwitcher,
  renderPreviewView,
  renderInfoView,
  cleanup
};
