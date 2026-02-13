/**
 * API Terminal Panel
 * Console + Info + Routes (API tester with variable resolution)
 */

const { getApiServer, setApiPort, getApiRoutes, setApiRoutes, addApiHistoryEntry, getApiHistory } = require('./ApiState');
const { updateProject } = require('../../../renderer/state/projects.state');
const apiElectron = window.electron_api;

const pollTimers = new WeakMap();

function clearPollTimer(wrapper) {
  const timer = pollTimers.get(wrapper);
  if (timer) { clearInterval(timer); pollTimers.delete(wrapper); }
}

function startPortPoll(wrapper, projectIndex, onFound) {
  clearPollTimer(wrapper);
  const timer = setInterval(async () => {
    const s = getApiServer(projectIndex);
    if (s.status === 'stopped') { clearPollTimer(wrapper); return; }
    let p = s.port;
    if (!p) { try { p = await apiElectron.api.getPort({ projectIndex }); } catch (e) {} }
    if (p) { setApiPort(projectIndex, p); clearPollTimer(wrapper); onFound(p); }
  }, 2000);
  pollTimers.set(wrapper, timer);
}

async function resolvePort(projectIndex) {
  const server = getApiServer(projectIndex);
  if (server.port) return server.port;
  if (server.status !== 'running') return null;
  try {
    const p = await apiElectron.api.getPort({ projectIndex });
    if (p) setApiPort(projectIndex, p);
    return p || null;
  } catch (e) { return null; }
}

// ===== Helpers =====

const METHOD_COLORS = {
  GET: '#3fb950', POST: '#58a6ff', PUT: '#d29922',
  PATCH: '#d29922', DELETE: '#ff7b72', HEAD: '#8b949e',
  OPTIONS: '#8b949e', ALL: '#a855f7'
};

function methodBadge(method) {
  const color = METHOD_COLORS[method] || '#8b949e';
  return `<span class="api-method-badge" style="--method-color:${color}">${method}</span>`;
}

function statusColor(status) {
  if (status >= 200 && status < 300) return '#3fb950';
  if (status >= 300 && status < 400) return '#58a6ff';
  if (status >= 400 && status < 500) return '#d29922';
  if (status >= 500) return '#ff7b72';
  return '#8b949e';
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== Variable resolution system =====

function getProjectVars(project) {
  return project.routeVariables || {};
}

function saveProjectVars(project, vars) {
  project.routeVariables = vars;
  updateProject(project.id, { routeVariables: vars });
}

/** Extract unique ${varName} from an array of routes */
function extractUnresolvedVars(routes) {
  const vars = new Set();
  for (const r of routes) {
    const matches = r.path.matchAll(/\$\{(\w+)\}/g);
    for (const m of matches) vars.add(m[1]);
  }
  return [...vars];
}

/** Replace ${varName} in a path using saved variables */
function resolveRoutePath(path, vars) {
  return path.replace(/\$\{(\w+)\}/g, (full, name) => {
    return vars[name] !== undefined && vars[name] !== '' ? vars[name] : full;
  });
}

/** Check if a path still has unresolved vars */
function hasUnresolvedVars(path) {
  return /\$\{/.test(path);
}

// ===== Main view =====

function getViewSwitcherHtml() {
  return `
    <div class="api-view-switcher">
      <button class="api-view-tab active" data-view="console">
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zm0 14H4V8h16v10z"/><path d="M7 10l4 3-4 3v-6z"/></svg>
        Console
      </button>
      <button class="api-view-tab" data-view="routes">
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
        Routes
      </button>
      <button class="api-view-tab" data-view="info">
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
        Info
      </button>
    </div>
    <div class="api-view-content">
      <div class="api-console-view"></div>
      <div class="api-routes-view" style="display:none;"></div>
      <div class="api-info-view" style="display:none;"></div>
    </div>
  `;
}

function setupViewSwitcher(wrapper, terminalId, projectIndex, project, deps) {
  const { t, getTerminal } = deps;
  const consoleView = wrapper.querySelector('.api-console-view');
  const routesView = wrapper.querySelector('.api-routes-view');
  const infoView = wrapper.querySelector('.api-info-view');

  wrapper.querySelectorAll('.api-view-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view;
      wrapper.querySelectorAll('.api-view-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      consoleView.style.display = view === 'console' ? '' : 'none';
      routesView.style.display = view === 'routes' ? '' : 'none';
      infoView.style.display = view === 'info' ? '' : 'none';

      if (view === 'console') {
        const termData = getTerminal(terminalId);
        if (termData) setTimeout(() => termData.fitAddon.fit(), 50);
      } else if (view === 'routes') {
        renderRoutesView(wrapper, projectIndex, project, deps);
      } else if (view === 'info') {
        renderInfoView(wrapper, projectIndex, project, deps);
      }

      const termData = getTerminal(terminalId);
      if (termData) termData.activeView = view;
    });
  });
}

// ===== Info view =====

async function renderInfoView(wrapper, projectIndex, project, deps) {
  const { t } = deps;
  const server = getApiServer(projectIndex);
  const infoView = wrapper.querySelector('.api-info-view');
  if (!infoView) return;

  const port = await resolvePort(projectIndex);
  const url = port ? `http://localhost:${port}` : null;
  const statusKey = server.status === 'stopped' ? 'api.stopped'
    : server.status === 'starting' ? 'api.starting' : 'api.running';

  infoView.innerHTML = `
    <div class="api-info-panel">
      <div class="api-info-row">
        <span class="api-info-label">${t('api.devCommand')}</span>
        <span class="api-info-value"><code>${escapeHtml(project.devCommand || 'auto-detect')}</code></span>
      </div>
      <div class="api-info-row">
        <span class="api-info-label">Status</span>
        <span class="api-info-value"><span class="api-status-dot ${server.status}"></span> ${t(statusKey)}</span>
      </div>
      ${port ? `
        <div class="api-info-row">
          <span class="api-info-label">${t('api.port')}</span>
          <span class="api-info-value"><code>${port}</code></span>
        </div>
        <div class="api-info-row clickable api-open-url" data-url="${url}">
          <span class="api-info-label">${t('api.endpoint')}</span>
          <span class="api-info-value">
            <span class="api-url-link">${url}</span>
            <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12" style="margin-left:6px;opacity:0.5"><path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/><path d="M5 5v14h14v-7h-2v5H7V7h5V5H5z"/></svg>
          </span>
        </div>
      ` : server.status === 'running' ? `
        <div class="api-info-row">
          <span class="api-info-label">${t('api.port')}</span>
          <span class="api-info-value">${t('api.detecting')}</span>
        </div>
      ` : ''}
    </div>
  `;

  infoView.querySelectorAll('.api-open-url').forEach(row => {
    row.style.cursor = 'pointer';
    row.onclick = () => { if (row.dataset.url) apiElectron.dialog.openExternal(row.dataset.url); };
  });

  if (!port && server.status === 'running') {
    startPortPoll(wrapper, projectIndex, () => renderInfoView(wrapper, projectIndex, project, deps));
  }
}

// ===== Routes view =====

function isAutoDetect(project) {
  return project.autoDetectRoutes !== false;
}

function getManualRoutes(project) {
  return Array.isArray(project.manualRoutes) ? project.manualRoutes : [];
}

async function renderRoutesView(wrapper, projectIndex, project, deps) {
  const { t } = deps;
  const routesView = wrapper.querySelector('.api-routes-view');
  if (!routesView) return;

  const autoDetect = isAutoDetect(project);
  const rawRoutes = autoDetect ? getApiRoutes(projectIndex) : getManualRoutes(project);
  const server = getApiServer(projectIndex);
  const port = server.port;
  const baseUrl = port ? `http://localhost:${port}` : '';
  const savedVars = getProjectVars(project);

  // Detect unresolved variables
  const unresolvedVarNames = extractUnresolvedVars(rawRoutes);
  const hasVars = unresolvedVarNames.length > 0;

  // Resolve routes for display
  const routes = rawRoutes.map(r => ({
    ...r,
    displayPath: resolveRoutePath(r.path, savedVars),
    rawPath: r.path
  }));

  const countLabel = autoDetect
    ? (routes.length ? t('api.routesFound').replace('{count}', routes.length) : t('api.noRoutes'))
    : (routes.length ? t('api.manualRoutesCount').replace('{count}', routes.length) : t('api.noRoutes'));

  routesView.innerHTML = `
    <div class="api-routes-container">
      <!-- Left: Route list -->
      <div class="api-routes-sidebar">
        <div class="api-routes-toolbar">
          <span class="api-routes-count">${countLabel}</span>
          <div class="api-routes-toolbar-actions">
            ${autoDetect ? `
              <button class="api-routes-scan-btn" title="${t('api.scanRoutes')}">
                <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
                ${t('api.scanRoutes')}
              </button>
            ` : `
              <button class="api-routes-add-btn" title="${t('api.addRoute')}">
                <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                ${t('api.addRoute')}
              </button>
            `}
            <label class="api-routes-toggle" title="${autoDetect ? t('api.autoDetect') : t('api.manualMode')}">
              <input type="checkbox" class="api-routes-toggle-input" ${autoDetect ? 'checked' : ''} />
              <span class="api-routes-toggle-slider"></span>
              <span class="api-routes-toggle-label">${autoDetect ? t('api.autoDetect') : t('api.manualMode')}</span>
            </label>
          </div>
        </div>

        ${hasVars && autoDetect ? buildVariablesPanel(unresolvedVarNames, savedVars, t) : ''}

        <div class="api-routes-filter">
          <input type="text" class="api-routes-search" placeholder="Filter routes..." />
        </div>
        <div class="api-routes-list">
          ${routes.length === 0 ? `
            <div class="api-routes-empty">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="36" height="36" style="opacity:0.15"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
              <span>${autoDetect ? t('api.noRoutesHint') : t('api.manualRoutesHint')}</span>
            </div>
          ` : routes.map((r, i) => {
            const resolved = !hasUnresolvedVars(r.displayPath);
            const methodColor = METHOD_COLORS[r.method] || '#8b949e';
            return `
            <div class="api-route-item ${resolved ? '' : 'unresolved'}" data-index="${i}" data-method="${r.method}" data-path="${escapeHtml(r.displayPath)}" data-raw-path="${escapeHtml(r.rawPath)}" ${r.file ? `title="${escapeHtml(r.file)}:${r.line}"` : ''}>
              ${methodBadge(r.method)}
              <span class="api-route-path">${formatRoutePath(r.displayPath, r.rawPath, savedVars)}</span>
              ${r.handler ? `<span class="api-route-handler">${escapeHtml(r.handler)}</span>` : ''}
              ${!autoDetect ? `<button class="api-route-delete-btn" data-index="${i}" title="${t('api.deleteRoute')}">&times;</button>` : ''}
            </div>`;
          }).join('')}
        </div>

        <!-- Add route form (manual mode) -->
        <div class="api-add-route-form" style="display:none;">
          <div class="api-add-route-row">
            <select class="api-add-route-method">
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
              <option value="DELETE">DELETE</option>
            </select>
            <input type="text" class="api-add-route-path" placeholder="${t('api.routePath')}" />
          </div>
          <div class="api-add-route-row">
            <input type="text" class="api-add-route-handler" placeholder="${t('api.routeHandler')}" />
            <button class="api-add-route-confirm">${t('api.addRoute')}</button>
            <button class="api-add-route-cancel">&times;</button>
          </div>
        </div>

        <!-- Custom URL -->
        <div class="api-custom-url-section">
          <div class="api-custom-url-row">
            <select class="api-custom-method">
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
              <option value="DELETE">DELETE</option>
            </select>
            <input type="text" class="api-custom-url-input" placeholder="${t('api.urlPlaceholder')}" value="${baseUrl ? baseUrl + '/' : ''}" />
            <button class="api-custom-send-btn">${t('api.send')}</button>
          </div>
        </div>
      </div>

      <!-- Right: Request builder + Response -->
      <div class="api-tester-panel">
        <div class="api-tester-empty">
          <div class="api-tester-empty-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" width="48" height="48"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
          </div>
          <span class="api-tester-empty-text">${t('api.noResponse')}</span>
          <span class="api-tester-empty-hint">${t('api.ctrlEnterSend')}</span>
        </div>
      </div>
    </div>
  `;

  bindRoutesViewEvents(routesView, wrapper, projectIndex, project, deps, routes, baseUrl, autoDetect);
}

/** Build the variables panel HTML */
function buildVariablesPanel(varNames, savedVars, t) {
  return `
    <div class="api-vars-panel">
      <div class="api-vars-header">
        <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
        <span>${t('api.variables')}</span>
        <span class="api-vars-hint">${t('api.variablesHint')}</span>
      </div>
      <div class="api-vars-list">
        ${varNames.map(name => `
          <div class="api-var-row" data-var="${escapeHtml(name)}">
            <span class="api-var-name">\${${escapeHtml(name)}}</span>
            <input type="text" class="api-var-input" data-var="${escapeHtml(name)}" placeholder="${t('api.variablePlaceholder')}" value="${escapeHtml(savedVars[name] || '')}" spellcheck="false" />
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

/** Format route path with visual distinction for resolved vars */
function formatRoutePath(displayPath, rawPath, savedVars) {
  if (rawPath === displayPath) return escapeHtml(displayPath);
  // Highlight resolved segments
  let formatted = escapeHtml(displayPath);
  // If there are still unresolved vars, dim them
  formatted = formatted.replace(/\$\{(\w+)\}/g, '<span class="api-route-unresolved">${$1}</span>');
  return formatted;
}

function bindRoutesViewEvents(routesView, wrapper, projectIndex, project, deps, routes, baseUrl, autoDetect) {
  const { t } = deps;

  // ── Variables panel ──
  routesView.querySelectorAll('.api-var-input').forEach(input => {
    let saveTimeout;
    input.oninput = () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        const vars = getProjectVars(project);
        routesView.querySelectorAll('.api-var-input').forEach(inp => {
          vars[inp.dataset.var] = inp.value;
        });
        saveProjectVars(project, vars);
        // Re-render routes with new resolved values
        renderRoutesView(wrapper, projectIndex, project, deps);
      }, 600);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        clearTimeout(saveTimeout);
        const vars = getProjectVars(project);
        routesView.querySelectorAll('.api-var-input').forEach(inp => {
          vars[inp.dataset.var] = inp.value;
        });
        saveProjectVars(project, vars);
        renderRoutesView(wrapper, projectIndex, project, deps);
      }
    };
  });

  // ── Toggle auto-detect ──
  const toggleInput = routesView.querySelector('.api-routes-toggle-input');
  if (toggleInput) {
    toggleInput.onchange = () => {
      const newVal = toggleInput.checked;
      project.autoDetectRoutes = newVal;
      updateProject(project.id, { autoDetectRoutes: newVal });
      renderRoutesView(wrapper, projectIndex, project, deps);
    };
  }

  // ── Scan button (auto-detect mode) ──
  const scanBtn = routesView.querySelector('.api-routes-scan-btn');
  if (scanBtn) {
    scanBtn.onclick = async () => {
      scanBtn.disabled = true;
      scanBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13" class="api-spin"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg> ${t('api.scanning')}`;
      try {
        const detected = await apiElectron.api.detectRoutes({ projectPath: project.path });
        setApiRoutes(projectIndex, detected);
      } catch (e) {
        console.error('[API] Route detection error:', e);
      }
      scanBtn.disabled = false;
      renderRoutesView(wrapper, projectIndex, project, deps);
    };
  }

  // ── Add route button (manual mode) ──
  const addBtn = routesView.querySelector('.api-routes-add-btn');
  const addForm = routesView.querySelector('.api-add-route-form');
  if (addBtn && addForm) {
    addBtn.onclick = () => {
      addForm.style.display = '';
      addForm.querySelector('.api-add-route-path').focus();
    };

    addForm.querySelector('.api-add-route-cancel').onclick = () => {
      addForm.style.display = 'none';
    };

    const confirmAdd = () => {
      const method = addForm.querySelector('.api-add-route-method').value;
      const pathVal = addForm.querySelector('.api-add-route-path').value.trim();
      const handler = addForm.querySelector('.api-add-route-handler').value.trim();
      if (!pathVal) return;
      const normalizedPath = pathVal.startsWith('/') ? pathVal : '/' + pathVal;
      const manual = getManualRoutes(project);
      manual.push({ method, path: normalizedPath, handler: handler || '' });
      project.manualRoutes = manual;
      updateProject(project.id, { manualRoutes: manual });
      addForm.style.display = 'none';
      renderRoutesView(wrapper, projectIndex, project, deps);
    };

    addForm.querySelector('.api-add-route-confirm').onclick = confirmAdd;
    addForm.querySelector('.api-add-route-path').onkeydown = (e) => {
      if (e.key === 'Enter') confirmAdd();
      if (e.key === 'Escape') addForm.style.display = 'none';
    };
    addForm.querySelector('.api-add-route-handler').onkeydown = (e) => {
      if (e.key === 'Enter') confirmAdd();
      if (e.key === 'Escape') addForm.style.display = 'none';
    };
  }

  // ── Delete route buttons (manual mode) ──
  routesView.querySelectorAll('.api-route-delete-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      const manual = getManualRoutes(project);
      manual.splice(idx, 1);
      project.manualRoutes = manual;
      updateProject(project.id, { manualRoutes: manual });
      renderRoutesView(wrapper, projectIndex, project, deps);
    };
  });

  // ── Filter ──
  const searchInput = routesView.querySelector('.api-routes-search');
  searchInput.oninput = () => {
    const q = searchInput.value.toLowerCase();
    routesView.querySelectorAll('.api-route-item').forEach(item => {
      const text = (item.dataset.method + ' ' + item.dataset.path).toLowerCase();
      item.style.display = text.includes(q) ? '' : 'none';
    });
  };

  // ── Route click -> open tester ──
  routesView.querySelectorAll('.api-route-item').forEach(item => {
    item.onclick = (e) => {
      if (e.target.closest('.api-route-delete-btn')) return;
      const idx = parseInt(item.dataset.index);
      const route = routes[idx];
      if (!route) return;
      routesView.querySelectorAll('.api-route-item').forEach(r => r.classList.remove('selected'));
      item.classList.add('selected');
      const resolvedPath = route.displayPath;
      openTester(routesView, projectIndex, route.method, baseUrl + resolvedPath, deps);
    };
  });

  // ── Custom URL send ──
  routesView.querySelector('.api-custom-send-btn').onclick = () => {
    const method = routesView.querySelector('.api-custom-method').value;
    const url = routesView.querySelector('.api-custom-url-input').value.trim();
    if (!url) return;
    routesView.querySelectorAll('.api-route-item').forEach(r => r.classList.remove('selected'));
    openTester(routesView, projectIndex, method, url, deps);
  };

  routesView.querySelector('.api-custom-url-input').onkeydown = (e) => {
    if (e.key === 'Enter') routesView.querySelector('.api-custom-send-btn').click();
  };

  // ── Auto-scan on first open if auto-detect and no routes ──
  if (autoDetect && routes.length === 0 && scanBtn) {
    scanBtn.click();
  }
}

// ===== API Tester panel =====

function openTester(routesView, projectIndex, method, url, deps) {
  const { t } = deps;
  const panel = routesView.querySelector('.api-tester-panel');
  const needsBody = ['POST', 'PUT', 'PATCH'].includes(method);

  panel.innerHTML = `
    <div class="api-tester-request">
      <div class="api-tester-url-bar">
        <select class="api-tester-method">
          ${['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].map(m =>
            `<option value="${m}" ${m === method ? 'selected' : ''}>${m}</option>`
          ).join('')}
        </select>
        <input type="text" class="api-tester-url" value="${escapeHtml(url)}" spellcheck="false" />
        <button class="api-tester-send-btn">${t('api.send')}</button>
      </div>

      <!-- Headers -->
      <div class="api-tester-section">
        <div class="api-tester-section-header" data-toggle="headers">
          <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12" class="api-tester-chevron"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
          ${t('api.headers')}
          <button class="api-tester-add-header-btn" title="${t('api.addHeader')}">+</button>
        </div>
        <div class="api-tester-headers-list">
          <div class="api-tester-header-row">
            <input type="text" class="api-tester-header-key" value="Content-Type" spellcheck="false" />
            <input type="text" class="api-tester-header-val" value="application/json" spellcheck="false" />
            <button class="api-tester-header-del">&times;</button>
          </div>
          <div class="api-tester-header-row">
            <input type="text" class="api-tester-header-key" placeholder="Authorization" spellcheck="false" />
            <input type="text" class="api-tester-header-val" placeholder="Bearer token..." spellcheck="false" />
            <button class="api-tester-header-del">&times;</button>
          </div>
        </div>
      </div>

      <!-- Body -->
      ${needsBody ? `
        <div class="api-tester-section">
          <div class="api-tester-section-header" data-toggle="body">
            <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12" class="api-tester-chevron open"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
            ${t('api.body')}
          </div>
          <div class="api-tester-body-section">
            <textarea class="api-tester-body" placeholder='${t('api.requestBody')}' rows="6" spellcheck="false">{\n  \n}</textarea>
          </div>
        </div>
      ` : ''}
    </div>

    <!-- Response -->
    <div class="api-tester-response">
      <div class="api-tester-response-placeholder">
        <span style="opacity:0.4">${t('api.noResponse')}</span>
      </div>
    </div>
  `;

  bindTesterEvents(panel, projectIndex, deps);
}

function bindTesterEvents(panel, projectIndex, deps) {
  const { t } = deps;

  panel.querySelectorAll('.api-tester-section-header').forEach(header => {
    header.onclick = (e) => {
      if (e.target.classList.contains('api-tester-add-header-btn')) return;
      const section = header.nextElementSibling;
      const chevron = header.querySelector('.api-tester-chevron');
      if (section.style.display === 'none') {
        section.style.display = '';
        chevron.classList.add('open');
      } else {
        section.style.display = 'none';
        chevron.classList.remove('open');
      }
    };
  });

  panel.querySelector('.api-tester-add-header-btn').onclick = (e) => {
    e.stopPropagation();
    const list = panel.querySelector('.api-tester-headers-list');
    const row = document.createElement('div');
    row.className = 'api-tester-header-row';
    row.innerHTML = `
      <input type="text" class="api-tester-header-key" placeholder="${t('api.headerKey')}" spellcheck="false" />
      <input type="text" class="api-tester-header-val" placeholder="${t('api.headerValue')}" spellcheck="false" />
      <button class="api-tester-header-del">&times;</button>
    `;
    list.appendChild(row);
    row.querySelector('.api-tester-header-del').onclick = () => row.remove();
    row.querySelector('.api-tester-header-key').focus();
  };

  panel.querySelectorAll('.api-tester-header-del').forEach(btn => {
    btn.onclick = () => btn.parentElement.remove();
  });

  panel.querySelector('.api-tester-method').onchange = () => {
    const method = panel.querySelector('.api-tester-method').value;
    const bodySection = panel.querySelector('.api-tester-body-section')?.closest('.api-tester-section');
    if (bodySection) {
      bodySection.style.display = ['POST','PUT','PATCH'].includes(method) ? '' : 'none';
    }
  };

  panel.querySelector('.api-tester-send-btn').onclick = () => sendRequest(panel, projectIndex, deps);

  panel.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      sendRequest(panel, projectIndex, deps);
    }
  });
}

async function sendRequest(panel, projectIndex, deps) {
  const { t } = deps;
  const method = panel.querySelector('.api-tester-method').value;
  const url = panel.querySelector('.api-tester-url').value.trim();
  if (!url) return;

  const headers = {};
  panel.querySelectorAll('.api-tester-header-row').forEach(row => {
    const key = row.querySelector('.api-tester-header-key').value.trim();
    const val = row.querySelector('.api-tester-header-val').value.trim();
    if (key) headers[key] = val;
  });

  const bodyEl = panel.querySelector('.api-tester-body');
  const body = bodyEl ? bodyEl.value : '';

  const sendBtn = panel.querySelector('.api-tester-send-btn');
  const responseDiv = panel.querySelector('.api-tester-response');
  sendBtn.disabled = true;
  sendBtn.textContent = t('api.sending');
  responseDiv.innerHTML = '<div class="api-tester-response-placeholder"><div class="api-loading-dots"><span></span><span></span><span></span></div></div>';

  try {
    const result = await apiElectron.api.testRequest({ url, method, headers, body });
    addApiHistoryEntry(projectIndex, {
      request: { method, url, headers, body },
      response: result,
      timestamp: Date.now()
    });
    renderResponse(responseDiv, result, t);
  } catch (e) {
    responseDiv.innerHTML = `<div class="api-response-error">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      <span>${escapeHtml(e.message)}</span>
    </div>`;
  }

  sendBtn.disabled = false;
  sendBtn.textContent = t('api.send');
}

function renderResponse(container, result, t) {
  if (result.error && !result.status) {
    container.innerHTML = `
      <div class="api-response-error">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        <span>${escapeHtml(result.error)}</span>
      </div>
    `;
    return;
  }

  const sColor = statusColor(result.status);
  const headersHtml = Object.entries(result.headers || {}).map(([k, v]) =>
    `<div class="api-response-header"><span class="api-response-header-key">${escapeHtml(k)}</span><span class="api-response-header-val">${escapeHtml(v)}</span></div>`
  ).join('');

  let bodyHtml = escapeHtml(result.body || '');
  let isJson = false;
  try {
    const parsed = JSON.parse(result.body);
    bodyHtml = escapeHtml(JSON.stringify(parsed, null, 2));
    isJson = true;
  } catch (e) {}

  container.innerHTML = `
    <div class="api-response-status-bar">
      <span class="api-response-status">
        <span class="api-response-status-code" style="--status-color:${sColor}">${result.status}</span>
        <span class="api-response-status-text">${escapeHtml(result.statusText || '')}</span>
      </span>
      <div class="api-response-meta">
        <span class="api-response-meta-item" title="${t('api.time')}">
          <svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7z"/></svg>
          ${result.time}ms
        </span>
        <span class="api-response-meta-item" title="${t('api.size')}">
          <svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><path d="M20 6H4l8-4 8 4zm0 2H4v2h16V8zm-4 4H8v8h8v-8z"/></svg>
          ${formatSize(result.size)}
        </span>
      </div>
    </div>
    <div class="api-response-tabs">
      <button class="api-response-tab active" data-rtab="body">${t('api.responseBody')}</button>
      <button class="api-response-tab" data-rtab="headers">${t('api.responseHeaders')} (${Object.keys(result.headers || {}).length})</button>
    </div>
    <div class="api-response-body-content">
      <pre class="api-response-body ${isJson ? 'json' : ''}">${bodyHtml}</pre>
    </div>
    <div class="api-response-headers-content" style="display:none">
      ${headersHtml || '<span style="opacity:0.4">No headers</span>'}
    </div>
  `;

  container.querySelectorAll('.api-response-tab').forEach(tab => {
    tab.onclick = () => {
      container.querySelectorAll('.api-response-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const which = tab.dataset.rtab;
      container.querySelector('.api-response-body-content').style.display = which === 'body' ? '' : 'none';
      container.querySelector('.api-response-headers-content').style.display = which === 'headers' ? '' : 'none';
    };
  });
}

function cleanup(wrapper) {
  clearPollTimer(wrapper);
}

module.exports = {
  getViewSwitcherHtml,
  setupViewSwitcher,
  renderInfoView,
  renderRoutesView,
  cleanup
};
