/**
 * CloudPanel
 * Dedicated Cloud tab — connection, profile, sessions, and file sync management.
 * Full-page layout with grid when connected, centered form when disconnected.
 */

const { t } = require('../../i18n');

let _ctx = null;
let _cloudSessionsInterval = null;

function _escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml(settings) {
  return `
    <div class="cloud-panel">

      <!-- ═══ Top Bar ═══ -->
      <div class="cp-topbar">
        <div class="cp-topbar-left">
          <div class="cp-topbar-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
            </svg>
          </div>
          <div>
            <div class="cp-topbar-title">${t('cloud.relayTitle')}</div>
            <div class="cp-topbar-subtitle">${t('cloud.infoBanner')}</div>
          </div>
        </div>
        <div class="cp-topbar-right">
          <div class="cp-sync-status" id="cp-sync-status" style="display:none">
            <span class="cp-sync-status-icon"></span>
            <span class="cp-sync-status-text" id="cp-sync-status-text"></span>
            <div class="cp-sync-progress" id="cp-sync-progress" style="display:none">
              <div class="cp-sync-progress-bar" id="cp-sync-progress-bar"></div>
            </div>
          </div>
          <div class="cp-status-pill" id="cp-status-pill">
            <span class="cp-status-dot"></span>
            <span id="cp-status-text">${t('cloud.disconnected')}</span>
          </div>
          <button class="cp-connect-btn" id="cp-connect-btn">${t('cloud.connect')}</button>
        </div>
      </div>

      <!-- ═══ Body ═══ -->
      <div class="cp-body">

        <!-- Disconnected State -->
        <div class="cp-disconnected" id="cp-disconnected-view">
          <div class="cp-disconnected-hero">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
            </svg>
            <h2>${t('cloud.tabTitle')}</h2>
            <p>${t('cloud.panelDisconnected')}</p>
          </div>

          <!-- Connection Form -->
          <div class="cp-form-card">
            <div class="cp-field">
              <label for="cp-server-url">${t('cloud.serverUrl')}</label>
              <input type="text" id="cp-server-url" class="cp-input" value="${_escapeHtml(settings.cloudServerUrl || '')}" placeholder="${t('cloud.serverUrlPlaceholder')}">
            </div>
            <div class="cp-field">
              <label for="cp-api-key">${t('cloud.apiKey')}</label>
              <div class="cp-key-row">
                <input type="password" id="cp-api-key" class="cp-input cp-key-input" value="${_escapeHtml(settings.cloudApiKey || '')}" placeholder="${t('cloud.apiKeyPlaceholder')}">
                <button class="cp-key-toggle" id="cp-key-toggle" type="button" title="${t('cloud.toggleVisibility')}">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                  </svg>
                </button>
              </div>
              <div class="cp-field-hint">${t('cloud.apiKeyDesc')}</div>
            </div>
            <div class="cloud-machine-id" id="cp-machine-id" style="display:none">
              <span class="cloud-machine-id-label">${t('cloud.thisMachine')}</span>
              <code class="cloud-machine-id-value"></code>
            </div>
            <div class="cp-form-footer">
              <div class="cp-auto">
                <label class="settings-toggle rp-mini-toggle">
                  <input type="checkbox" id="cp-auto-connect" ${settings.cloudAutoConnect !== false ? 'checked' : ''}>
                  <span class="settings-toggle-slider"></span>
                </label>
                <span class="cp-auto-label">${t('cloud.autoConnect')}</span>
              </div>
            </div>
          </div>

          <!-- Install (collapsible) -->
          <div class="cp-install-collapsible">
            <button class="cp-install-toggle" id="cp-install-toggle">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
              <span>${t('cloud.installTitle')}</span>
            </button>
            <div class="cp-install-content" id="cp-install-content">
              <div class="cp-install-cmd">
                <code id="cp-install-cmd">curl -fsSL https://raw.githubusercontent.com/Sterll/claude-terminal/main/cloud/install.sh | sudo bash</code>
                <button class="cp-install-copy" id="cp-install-copy" title="${t('cloud.copyCmd')}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
              </div>
              <div class="cp-install-hint">${t('cloud.installHint')}</div>
            </div>
          </div>
        </div>

        <!-- ═══ Connected State ═══ -->
        <div class="cp-connected" id="cp-connected-view" style="display:none">

          <!-- Upload Progress (hidden by default) -->
          <div class="cp-upload-progress" id="cp-upload-progress" style="display:none">
            <div class="cp-upload-header">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/>
                <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
              </svg>
              <span class="cp-upload-title" id="cp-upload-title">${t('cloud.uploadTitle')}</span>
            </div>
            <div class="cp-upload-bar-wrap">
              <div class="cp-upload-bar" id="cp-upload-bar" style="width:0%"></div>
            </div>
            <div class="cp-upload-details" id="cp-upload-details"></div>
          </div>

          <!-- Profile (compact inline) -->
          <div class="cp-profile-bar">
            <div class="cp-user-avatar" id="cp-user-avatar">?</div>
            <div class="cp-user-name" id="cp-user-display-name">\u2014</div>
            <span class="cp-badge" id="cp-user-claude-badge">\u2014</span>
          </div>

          <!-- Entity Sync -->
          <div class="cp-section">
            <div class="cp-section-header">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
              <span>${t('cloud.syncSectionTitle')}</span>
              <span class="cp-sync-badge" id="cp-sync-badge" style="display:none">0</span>
            </div>
            <div class="cp-section-body">
              <div class="cp-sync-area" id="cp-sync-area">
                <div class="cp-sessions-empty" id="cp-sync-empty">${t('cloud.syncNoChanges')}</div>
                <div id="cp-sync-list" style="display:none"></div>
              </div>
            </div>
            <div class="cp-sync-actions">
              <button class="cp-btn-full" id="cp-sync-check-btn">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
                ${t('cloud.syncCheckBtn')}
              </button>
              <button class="cp-btn-full cp-btn-accent" id="cp-full-sync-btn">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                </svg>
                ${t('sync.fullSyncBtn')}
              </button>
            </div>
          </div>

          <!-- Sessions + Projects (side by side) -->
          <div class="cp-duo-grid">

            <!-- Sessions -->
            <div class="cp-section">
              <div class="cp-section-header">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
                </svg>
                <span>${t('cloud.sessionsTitle')}</span>
                <span class="cp-sessions-count" id="cp-sessions-count" style="display:none"></span>
                <div class="cp-header-actions">
                  <span class="cp-sessions-loading" id="cp-sessions-loading" style="display:none">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                    </svg>
                  </span>
                  <button class="cp-btn-icon" id="cp-sessions-refresh" title="${t('cloud.sessionsRefresh')}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                    </svg>
                  </button>
                </div>
              </div>
              <div class="cp-section-body" style="padding:0">
                <div id="cp-sessions-list" class="cp-sessions-list"></div>
              </div>
            </div>

            <!-- Cloud Projects -->
            <div class="cp-section">
              <div class="cp-section-header">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>
                </svg>
                <span>${t('cloud.cloudProjects')}</span>
                <span class="cp-sessions-count" id="cp-cloud-projects-count" style="display:none"></span>
                <div class="cp-header-actions">
                  <span class="cp-sessions-loading" id="cp-cloud-projects-loading" style="display:none">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                    </svg>
                  </span>
                  <button class="cp-btn-icon" id="cp-cloud-projects-refresh" title="${t('cloud.cloudProjectsRefresh')}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                    </svg>
                  </button>
                </div>
              </div>
              <div class="cp-section-body" style="padding:0">
                <div id="cp-cloud-projects-list" class="cp-sessions-list"></div>
              </div>
            </div>

          </div>

          <!-- Advanced Settings (collapsed) -->
          <details class="cp-advanced">
            <summary class="cp-advanced-toggle">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
              <span>${t('cloud.advancedSettings')}</span>
            </summary>
            <div class="cp-advanced-body">

              <!-- Git Identity -->
              <div class="cp-adv-group">
                <div class="cp-adv-group-title">${t('cloud.userGitIdentity')}</div>
                <div class="cp-adv-row">
                  <div class="cp-field">
                    <label for="cp-user-git-name">${t('cloud.userGitName')}</label>
                    <input type="text" id="cp-user-git-name" class="cp-input" placeholder="John Doe">
                  </div>
                  <div class="cp-field">
                    <label for="cp-user-git-email">${t('cloud.userGitEmail')}</label>
                    <input type="text" id="cp-user-git-email" class="cp-input" placeholder="john@example.com">
                  </div>
                  <div class="cp-user-actions">
                    <span class="cp-user-save-status" id="cp-user-save-status"></span>
                    <button class="cp-btn-sm" id="cp-user-save-btn">${t('cloud.userSave')}</button>
                  </div>
                </div>
              </div>

              <!-- Connection -->
              <div class="cp-adv-group">
                <div class="cp-adv-group-title">${t('cloud.serverUrl')} &amp; ${t('cloud.apiKey')}</div>
                <div class="cp-field">
                  <label>${t('cloud.serverUrl')}</label>
                  <input type="text" id="cp-server-url-connected" class="cp-input" value="${_escapeHtml(settings.cloudServerUrl || '')}" placeholder="${t('cloud.serverUrlPlaceholder')}">
                </div>
                <div class="cp-field" style="margin-top:10px">
                  <label>${t('cloud.apiKey')}</label>
                  <div class="cp-key-row">
                    <input type="password" id="cp-api-key-connected" class="cp-input cp-key-input" value="${_escapeHtml(settings.cloudApiKey || '')}" placeholder="${t('cloud.apiKeyPlaceholder')}">
                    <button class="cp-key-toggle" id="cp-key-toggle-connected" type="button">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                      </svg>
                    </button>
                  </div>
                </div>
              </div>

              <!-- Toggles -->
              <div class="cp-adv-group">
                <div class="cp-adv-group-title">${t('cloud.syncOptions')}</div>
                <div class="cp-toggle-list">
                  <div class="cp-auto">
                    <label class="settings-toggle rp-mini-toggle">
                      <input type="checkbox" id="cp-auto-connect-connected" ${settings.cloudAutoConnect !== false ? 'checked' : ''}>
                      <span class="settings-toggle-slider"></span>
                    </label>
                    <span class="cp-auto-label">${t('cloud.autoConnect')}</span>
                  </div>
                  <div class="cp-auto">
                    <label class="settings-toggle rp-mini-toggle">
                      <input type="checkbox" id="cp-auto-sync" ${settings.cloudAutoSync !== false ? 'checked' : ''}>
                      <span class="settings-toggle-slider"></span>
                    </label>
                    <span class="cp-auto-label">${t('cloud.autoSyncToggle')}</span>
                  </div>
                  <div class="cp-auto">
                    <label class="settings-toggle rp-mini-toggle">
                      <input type="checkbox" id="cp-auto-upload-projects" ${settings.cloudAutoUploadProjects !== false ? 'checked' : ''}>
                      <span class="settings-toggle-slider"></span>
                    </label>
                    <span class="cp-auto-label">${t('cloud.autoUploadProjects')}</span>
                  </div>
                </div>
                <div class="cp-adv-group-title" style="margin-top:8px">${t('cloud.syncDataTitle')}</div>
                <div class="cp-sync-data-toggles">
                  ${[
                    { id: 'cloudSyncSettings', key: 'syncToggleSettings', def: true },
                    { id: 'cloudSyncProjects', key: 'syncToggleProjects', def: true },
                    { id: 'cloudSyncTimeTracking', key: 'syncToggleTimeTracking', def: true },
                    { id: 'cloudSyncConversations', key: 'syncToggleConversations', def: true },
                    { id: 'cloudSyncSkills', key: 'syncToggleSkills', def: false },
                    { id: 'cloudSyncMcpConfigs', key: 'syncToggleMcp', def: true },
                    { id: 'cloudSyncKeybindings', key: 'syncToggleKeybindings', def: true },
                    { id: 'cloudSyncMemory', key: 'syncToggleMemory', def: true },
                    { id: 'cloudSyncHooksConfig', key: 'syncToggleHooks', def: true },
                    { id: 'cloudSyncPlugins', key: 'syncTogglePlugins', def: true },
                  ].map(item => `
                    <div class="cp-auto cp-auto-sm">
                      <label class="settings-toggle rp-mini-toggle">
                        <input type="checkbox" id="cp-dt-${item.id}" ${item.def ? (settings[item.id] !== false ? 'checked' : '') : (settings[item.id] ? 'checked' : '')}>
                        <span class="settings-toggle-slider"></span>
                      </label>
                      <span class="cp-auto-label">${t('cloud.' + item.key)}</span>
                    </div>
                  `).join('')}
                </div>
              </div>

              <!-- Cloud Keys -->
              <div class="cp-adv-group">
                <div class="cp-adv-group-title">${t('cloud.projectKeysTitle')}</div>
                <div class="cp-field-hint" style="margin-bottom:8px">${t('cloud.projectKeysHint')}</div>
                <div class="cp-project-keys-list" id="cp-project-keys-list"></div>
              </div>

            </div>
          </details>

        </div>

      </div>
    </div>
  `;
}


function setupHandlers(context) {
  _ctx = context;
  const api = window.electron_api;

  // ── Install toggle ──
  const installToggle = document.getElementById('cp-install-toggle');
  const installContent = document.getElementById('cp-install-content');
  if (installToggle && installContent) {
    installToggle.addEventListener('click', () => {
      installToggle.classList.toggle('open');
      installContent.classList.toggle('open');
    });
  }

  // ── Install copy ──
  const installCopyBtn = document.getElementById('cp-install-copy');
  const installCmd = document.getElementById('cp-install-cmd');
  if (installCopyBtn && installCmd) {
    installCopyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(installCmd.textContent).then(() => {
        installCopyBtn.classList.add('copied');
        setTimeout(() => installCopyBtn.classList.remove('copied'), 1500);
      });
    });
  }

  // ── Connection form (both views share settings) ──
  const urlInput = document.getElementById('cp-server-url');
  const keyInput = document.getElementById('cp-api-key');
  const autoToggle = document.getElementById('cp-auto-connect');
  const urlInputC = document.getElementById('cp-server-url-connected');
  const keyInputC = document.getElementById('cp-api-key-connected');
  const autoToggleC = document.getElementById('cp-auto-connect-connected');
  const connectBtn = document.getElementById('cp-connect-btn');
  const statusPill = document.getElementById('cp-status-pill');
  const statusText = document.getElementById('cp-status-text');
  const disconnectedView = document.getElementById('cp-disconnected-view');
  const connectedView = document.getElementById('cp-connected-view');

  // Key visibility toggles
  function wireKeyToggle(toggleId, inputId) {
    const toggle = document.getElementById(toggleId);
    const input = document.getElementById(inputId);
    if (toggle && input) {
      toggle.addEventListener('click', () => {
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        toggle.classList.toggle('revealed', isPassword);
      });
    }
  }
  wireKeyToggle('cp-key-toggle', 'cp-api-key');
  wireKeyToggle('cp-key-toggle-connected', 'cp-api-key-connected');

  function _saveField(prop, value) {
    _ctx.settingsState.setProp(prop, value);
    _ctx.saveSettings();
  }

  // Sync disconnected & connected inputs
  function _wireInputs(el, elC, prop) {
    if (el) el.addEventListener('change', () => {
      const v = el.value.trim();
      _saveField(prop, v);
      if (elC) elC.value = v;
    });
    if (elC) elC.addEventListener('change', () => {
      const v = elC.value.trim();
      _saveField(prop, v);
      if (el) el.value = v;
    });
  }
  _wireInputs(urlInput, urlInputC, 'cloudServerUrl');
  _wireInputs(keyInput, keyInputC, 'cloudApiKey');

  function _wireToggle(el, elC, prop) {
    if (el) el.addEventListener('change', () => {
      _saveField(prop, el.checked);
      if (elC) elC.checked = el.checked;
    });
    if (elC) elC.addEventListener('change', () => {
      _saveField(prop, elC.checked);
      if (el) el.checked = elC.checked;
    });
  }
  _wireToggle(autoToggle, autoToggleC, 'cloudAutoConnect');

  // Auto-sync toggle
  const autoSyncToggle = document.getElementById('cp-auto-sync');
  if (autoSyncToggle) {
    autoSyncToggle.addEventListener('change', () => {
      _saveField('cloudAutoSync', autoSyncToggle.checked);
    });
  }

  // Auto-upload new projects toggle
  const autoUploadToggle = document.getElementById('cp-auto-upload-projects');
  if (autoUploadToggle) {
    autoUploadToggle.addEventListener('change', () => {
      _saveField('cloudAutoUploadProjects', autoUploadToggle.checked);
    });
  }

  // Data sync toggles (granular per-entity)
  const SYNC_TOGGLE_IDS = [
    'cloudSyncSettings', 'cloudSyncProjects', 'cloudSyncTimeTracking',
    'cloudSyncConversations', 'cloudSyncSkills', 'cloudSyncMcpConfigs',
    'cloudSyncKeybindings', 'cloudSyncMemory', 'cloudSyncHooksConfig', 'cloudSyncPlugins',
  ];
  for (const prop of SYNC_TOGGLE_IDS) {
    const el = document.getElementById(`cp-dt-${prop}`);
    if (el) {
      el.addEventListener('change', () => _saveField(prop, el.checked));
    }
  }

  function _updateStatusUI(connected) {
    if (statusPill) statusPill.classList.toggle('online', connected);
    if (statusText) statusText.textContent = connected ? t('cloud.connected') : t('cloud.disconnected');
    if (connectBtn) {
      connectBtn.textContent = connected ? t('cloud.disconnect') : t('cloud.connect');
      connectBtn.classList.toggle('connected', connected);
    }
    if (disconnectedView) disconnectedView.style.display = connected ? 'none' : '';
    if (connectedView) connectedView.style.display = connected ? '' : 'none';

    if (connected) {
      _loadCloudUser();
      _loadCloudSessions(true);
      _loadCloudProjects(true);
      _startSessionsPolling();
      _checkCloudChanges();
      // Sync polling is now handled by CloudSyncService in main process
    } else {
      _stopSessionsPolling();
      _updateSyncBadge(0);
    }
  }

  // Connect/Disconnect
  if (connectBtn) {
    connectBtn.addEventListener('click', async () => {
      connectBtn.disabled = true;
      try {
        const status = await api.cloud.status();
        if (status.connected) {
          await api.cloud.disconnect();
          _updateStatusUI(false);
        } else {
          const url = (urlInput?.value || urlInputC?.value || '').trim();
          const key = (keyInput?.value || keyInputC?.value || '').trim();
          if (!url || !key) return;
          await api.cloud.connect({ serverUrl: url, apiKey: key });
          if (statusText) statusText.textContent = t('cloud.connecting');
        }
      } finally {
        connectBtn.disabled = false;
      }
    });
  }

  // Listen for status changes
  if (api.cloud?.onStatusChanged) {
    api.cloud.onStatusChanged((status) => {
      _updateStatusUI(status.connected);
    });
  }

  // Initial status check + machineId display
  (async () => {
    try {
      const status = await api.cloud.status();
      if (status.connected) _updateStatusUI(true);
    } catch { /* ignore */ }

    try {
      const machineId = await api.cloud.getMachineId();
      const machineIdEl = document.getElementById('cp-machine-id');
      if (machineIdEl) {
        machineIdEl.querySelector('.cloud-machine-id-value').textContent = machineId;
        machineIdEl.style.display = 'flex';
      }
    } catch { /* ignore */ }

    _renderProjectKeysList();
  })();

  // ── Project cloud key overrides ──
  function _renderProjectKeysList() {
    const list = document.getElementById('cp-project-keys-list');
    if (!list || !_ctx?.projectsState) return;
    const { projects } = _ctx.projectsState.get();
    if (!projects || projects.length === 0) return;

    list.innerHTML = projects.map(p => {
      const name = p.name || window.electron_nodeModules.path.basename(p.path || '');
      const override = _escapeHtml(p.cloudProjectKey || '');
      return `
        <div class="cp-project-key-row" data-project-id="${p.id}">
          <span class="cp-project-key-name" title="${_escapeHtml(p.path || '')}">${_escapeHtml(name)}</span>
          <input type="text" class="cp-input cp-project-key-input"
            placeholder="${_escapeHtml(t('cloud.projectKeyPlaceholder'))}"
            value="${override}" data-project-id="${p.id}">
        </div>`;
    }).join('');

    list.querySelectorAll('.cp-project-key-input').forEach(input => {
      let saveTimer = null;
      input.addEventListener('input', () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
          const projectId = input.dataset.projectId;
          const value = input.value.trim();
          try {
            await api.project.setCloudKey(projectId, value || null);
          } catch (e) {
            console.warn('[CloudPanel] Failed to save cloudProjectKey:', e.message);
          }
        }, 500);
      });
    });
  }

  // ── User profile ──
  async function _loadCloudUser() {
    try {
      const user = await api.cloud.getUser();
      const nameEl = document.getElementById('cp-user-display-name');
      const avatarEl = document.getElementById('cp-user-avatar');
      const badgeEl = document.getElementById('cp-user-claude-badge');
      const gitNameInput = document.getElementById('cp-user-git-name');
      const gitEmailInput = document.getElementById('cp-user-git-email');
      if (nameEl) nameEl.textContent = user.name || '\u2014';
      if (avatarEl) avatarEl.textContent = (user.name || '?')[0].toUpperCase();
      if (badgeEl) {
        if (user.claudeAuthed) {
          badgeEl.textContent = t('cloud.userClaudeAuthed');
          badgeEl.className = 'cp-badge success';
        } else {
          badgeEl.textContent = t('cloud.userClaudeNotAuthed');
          badgeEl.className = 'cp-badge warning';
        }
      }
      if (gitNameInput) gitNameInput.value = user.gitName || '';
      if (gitEmailInput) gitEmailInput.value = user.gitEmail || '';
    } catch { /* ignore */ }
  }

  const userSaveBtn = document.getElementById('cp-user-save-btn');
  const userSaveStatus = document.getElementById('cp-user-save-status');
  if (userSaveBtn) {
    userSaveBtn.addEventListener('click', async () => {
      userSaveBtn.disabled = true;
      const gitName = document.getElementById('cp-user-git-name')?.value.trim();
      const gitEmail = document.getElementById('cp-user-git-email')?.value.trim();
      try {
        await api.cloud.updateUser({ gitName, gitEmail });
        if (userSaveStatus) {
          userSaveStatus.textContent = t('cloud.userSaved');
          userSaveStatus.className = 'cp-user-save-status success';
          setTimeout(() => { userSaveStatus.textContent = ''; userSaveStatus.className = 'cp-user-save-status'; }, 2000);
        }
      } catch {
        if (userSaveStatus) {
          userSaveStatus.textContent = t('cloud.userSaveError');
          userSaveStatus.className = 'cp-user-save-status error';
          setTimeout(() => { userSaveStatus.textContent = ''; userSaveStatus.className = 'cp-user-save-status'; }, 3000);
        }
      } finally {
        userSaveBtn.disabled = false;
      }
    });
  }

  // ── Sessions ──
  function _timeAgo(ts) {
    if (!ts) return '';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return t('cloud.timeJustNow');
    if (diff < 3600) return t('cloud.timeMinAgo', { count: Math.floor(diff / 60) });
    if (diff < 86400) return t('cloud.timeHourAgo', { count: Math.floor(diff / 3600) });
    return t('cloud.timeDayAgo', { count: Math.floor(diff / 86400) });
  }

  function _shortModel(model) {
    if (!model) return '';
    if (model.includes('opus')) return 'Opus';
    if (model.includes('sonnet')) return 'Sonnet';
    if (model.includes('haiku')) return 'Haiku';
    return model.split('-').slice(-1)[0];
  }

  async function _loadCloudSessions(showLoading = false) {
    const listEl = document.getElementById('cp-sessions-list');
    const countEl = document.getElementById('cp-sessions-count');
    const loadingEl = document.getElementById('cp-sessions-loading');
    if (!listEl) return;

    if (showLoading && loadingEl) loadingEl.style.display = '';

    try {
      const { sessions } = await api.cloud.getSessions();

      if (loadingEl) loadingEl.style.display = 'none';

      if (!sessions || sessions.length === 0) {
        if (countEl) countEl.style.display = 'none';
        listEl.innerHTML = `<div class="cp-sessions-empty">${t('cloud.sessionsEmpty')}</div>`;
        return;
      }

      const running = sessions.filter(s => s.status === 'running').length;
      if (countEl) {
        countEl.textContent = running > 0 ? String(running) : String(sessions.length);
        countEl.className = 'cp-sessions-count' + (running > 0 ? ' running' : '');
        countEl.style.display = '';
      }

      listEl.innerHTML = sessions.map(s => {
        const isRunning = s.status === 'running';
        const isError = s.status === 'error';
        const statusClass = isRunning ? 'running' : isError ? 'error' : 'idle';
        const statusLabel = isRunning ? t('cloud.sessionRunning') : isError ? t('cloud.sessionError') : t('cloud.sessionIdle');
        const modelLabel = _shortModel(s.model);
        const startedLabel = s.createdAt ? _timeAgo(s.createdAt) : '';
        const lastLabel = s.lastActivity && s.lastActivity !== s.createdAt ? _timeAgo(s.lastActivity) : '';

        const stopBtn = isRunning
          ? `<button class="cp-btn-sm cp-btn-danger cp-session-stop" data-id="${_escapeHtml(s.id)}">${t('cloud.sessionStop')}</button>`
          : `<button class="cp-btn-sm cp-session-delete cp-session-stop" data-id="${_escapeHtml(s.id)}" title="${t('cloud.deleteSession')}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>`;

        return `<div class="cp-session-item">
          <div class="cp-session-status-dot ${statusClass}"></div>
          <div class="cp-session-info">
            <div class="cp-session-top">
              <span class="cp-session-project">${_escapeHtml(s.projectName)}</span>
              ${modelLabel ? `<span class="cp-session-model">${_escapeHtml(modelLabel)}</span>` : ''}
              <span class="cp-session-status-label ${statusClass}">${statusLabel}</span>
            </div>
            <div class="cp-session-meta">
              ${startedLabel ? `<span>${t('cloud.sessionStarted')} ${startedLabel}</span>` : ''}
              ${lastLabel ? `<span>· ${t('cloud.sessionActivity')} ${lastLabel}</span>` : ''}
            </div>
          </div>
          ${stopBtn}
        </div>`;
      }).join('');

      listEl.querySelectorAll('.cp-session-stop').forEach(btn => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await api.cloud.stopSession({ sessionId: btn.dataset.id });
            await _loadCloudSessions();
          } catch {
            btn.disabled = false;
          }
        });
      });
    } catch {
      if (loadingEl) loadingEl.style.display = 'none';
      listEl.innerHTML = `<div class="cp-sessions-empty">${t('cloud.sessionsEmpty')}</div>`;
    }
  }

  function _startSessionsPolling() {
    _stopSessionsPolling();
    _cloudSessionsInterval = setInterval(() => {
      if (!document.getElementById('cp-sessions-list')) { _stopSessionsPolling(); return; }
      _loadCloudSessions(false); // silent poll — no loading spinner
    }, 15000);
  }

  function _stopSessionsPolling() {
    if (_cloudSessionsInterval) { clearInterval(_cloudSessionsInterval); _cloudSessionsInterval = null; }
  }

  const sessionsRefresh = document.getElementById('cp-sessions-refresh');
  if (sessionsRefresh) {
    sessionsRefresh.addEventListener('click', async () => {
      sessionsRefresh.disabled = true;
      sessionsRefresh.classList.add('spinning');
      await _loadCloudSessions(true);
      sessionsRefresh.disabled = false;
      setTimeout(() => sessionsRefresh.classList.remove('spinning'), 400);
    });
  }

  // ── Cloud Projects (cross-machine) ──

  async function _loadCloudProjects(showLoading = false) {
    const listEl = document.getElementById('cp-cloud-projects-list');
    const loadingEl = document.getElementById('cp-cloud-projects-loading');
    const countEl = document.getElementById('cp-cloud-projects-count');
    if (!listEl) return;

    if (showLoading && loadingEl) loadingEl.style.display = '';

    try {
      const { projects: cloudProjects } = await api.cloud.getProjects();
      if (loadingEl) loadingEl.style.display = 'none';

      if (!cloudProjects || cloudProjects.length === 0) {
        if (countEl) countEl.style.display = 'none';
        listEl.innerHTML = `<div class="cp-sessions-empty">${t('cloud.cloudProjectsEmpty')}</div>`;
        return;
      }

      if (countEl) {
        countEl.textContent = String(cloudProjects.length);
        countEl.className = 'cp-sessions-count';
        countEl.style.display = '';
      }

      const localProjects = _ctx.projectsState?.get()?.projects || [];
      const localNames = new Set(localProjects.map(p => p.name));
      const localBasenames = new Set(localProjects.map(p => p.path?.replace(/\\/g, '/').split('/').pop()).filter(Boolean));

      listEl.innerHTML = cloudProjects.map(p => {
        const isLocal = localNames.has(p.name) || localBasenames.has(p.name);
        const badge = isLocal
          ? `<span class="cp-cloud-project-local">${t('cloud.cloudProjectLocal')}</span>`
          : `<button class="cp-btn-sm cp-cloud-project-import" data-name="${_escapeHtml(p.name)}">${t('cloud.cloudProjectImport')}</button>`;
        return `<div class="cp-session-item">
          <div class="cp-session-info">
            <div class="cp-session-top">
              <span class="cp-session-project">${_escapeHtml(p.name)}</span>
            </div>
          </div>
          ${badge}
        </div>`;
      }).join('');

      listEl.querySelectorAll('.cp-cloud-project-import').forEach(btn => {
        btn.addEventListener('click', async () => {
          const projectName = btn.dataset.name;
          btn.disabled = true;
          btn.textContent = t('cloud.cloudProjectImporting');
          const Toast = require('../../ui/components/Toast');
          try {
            const result = await api.cloud.importProject({ projectName });
            if (result.canceled) {
              btn.disabled = false;
              btn.textContent = t('cloud.cloudProjectImport');
              return;
            }
            // Add to local projects state (skip auto-upload since it's already in cloud)
            const { addProject } = require('../../state');
            const imported = addProject({ name: result.projectName, path: result.projectPath, type: 'standalone' });
            if (imported && window._cloudSkipAutoUpload) window._cloudSkipAutoUpload(imported.id);
            Toast.show(t('cloud.cloudProjectImported', { name: projectName }), 'success');
            await _loadCloudProjects(false);
          } catch (err) {
            Toast.show(err.message || t('cloud.uploadError'), 'error');
            btn.disabled = false;
            btn.textContent = t('cloud.cloudProjectImport');
          }
        });
      });
    } catch {
      if (loadingEl) loadingEl.style.display = 'none';
      listEl.innerHTML = `<div class="cp-sessions-empty">${t('cloud.cloudProjectsEmpty')}</div>`;
    }
  }

  const cloudProjectsRefresh = document.getElementById('cp-cloud-projects-refresh');
  if (cloudProjectsRefresh) {
    cloudProjectsRefresh.addEventListener('click', async () => {
      cloudProjectsRefresh.disabled = true;
      cloudProjectsRefresh.classList.add('spinning');
      await _loadCloudProjects(true);
      cloudProjectsRefresh.disabled = false;
      setTimeout(() => cloudProjectsRefresh.classList.remove('spinning'), 400);
    });
  }

  // ── Upload progress ──
  if (api.cloud?.onUploadProgress) {
    api.cloud.onUploadProgress((progress) => {
      const wrap = document.getElementById('cp-upload-progress');
      const bar = document.getElementById('cp-upload-bar');
      const details = document.getElementById('cp-upload-details');
      if (!wrap || !bar || !details) return;

      if (progress.phase === 'done') {
        wrap.style.display = 'none';
        bar.style.width = '0%';
        details.textContent = '';
        return;
      }

      wrap.style.display = '';
      const pct = progress.percent || 0;
      bar.style.width = `${pct}%`;

      const phases = {
        scanning: t('cloud.uploadPhaseScanning'),
        compressing: t('cloud.uploadPhaseCompressing'),
        uploading: t('cloud.uploadPhaseUploading'),
      };
      const label = phases[progress.phase] || '';

      if (progress.phase === 'uploading' && progress.uploadedMB != null && progress.totalMB != null) {
        details.textContent = `${label} ${progress.uploadedMB} / ${progress.totalMB} MB (${pct}%)`;
      } else {
        details.textContent = `${label} (${pct}%)`;
      }
    });
  }

  // ── Sync changes ──
  async function _checkCloudChanges() {
    const syncEmpty = document.getElementById('cp-sync-empty');
    const syncList = document.getElementById('cp-sync-list');
    if (!syncList) return;

    try {
      const result = await api.cloud.checkPendingChanges();
      const changes = result.changes || [];

      if (_ctx.updateProjectPendingChanges) {
        _ctx.updateProjectPendingChanges(changes);
      }

      if (changes.length === 0) {
        if (syncEmpty) syncEmpty.style.display = '';
        syncList.style.display = 'none';
        _updateSyncBadge(0);
        return;
      }

      if (syncEmpty) syncEmpty.style.display = 'none';
      syncList.style.display = '';

      let totalFiles = 0;
      syncList.innerHTML = changes.map(({ projectName, changes: fileChanges }) => {
        const files = fileChanges.flatMap(c => c.changedFiles || []);
        totalFiles += files.length;
        const fileList = files.slice(0, 10).map(f => `<div class="cp-sync-file">${_escapeHtml(f)}</div>`).join('');
        const moreCount = files.length > 10 ? `<div class="cp-sync-more">+${files.length - 10} ${t('cloud.syncMoreFiles')}</div>` : '';
        return `<div class="cp-sync-project" data-project="${_escapeHtml(projectName)}">
          <div class="cp-sync-project-header">
            <span class="cp-sync-project-name">${_escapeHtml(projectName)}</span>
            <span class="cp-sync-count">${files.length === 1 ? t('cloud.fileCountSingular', { count: files.length }) : t('cloud.fileCountPlural', { count: files.length })}</span>
            <button class="cp-btn-sm cp-sync-apply" data-project="${_escapeHtml(projectName)}">${t('cloud.syncApply')}</button>
          </div>
          <div class="cp-sync-files">${fileList}${moreCount}</div>
        </div>`;
      }).join('');

      _updateSyncBadge(totalFiles);

      syncList.querySelectorAll('.cp-sync-apply').forEach(btn => {
        btn.addEventListener('click', async () => {
          const projName = btn.dataset.project;
          btn.disabled = true;
          btn.textContent = t('sync.applying');
          try {
            const projects = _ctx.projectsState?.get()?.projects || [];
            const localProject = projects.find(p =>
              p.name === projName || p.path?.replace(/\\/g, '/').split('/').pop() === projName
            );
            if (!localProject) {
              const Toast = require('../../ui/components/Toast');
              Toast.show(t('cloud.syncNoLocalProject', { project: projName }), 'warning');
              btn.disabled = false;
              btn.textContent = t('cloud.syncApply');
              return;
            }
            await api.cloud.downloadChanges({ projectName: projName, localProjectPath: localProject.path, cloudProjectKey: projName });
            const Toast = require('../../ui/components/Toast');
            Toast.show(t('cloud.syncApplied'), 'success');
            await _checkCloudChanges();
          } catch {
            const Toast = require('../../ui/components/Toast');
            Toast.show(t('cloud.syncError') || t('cloud.uploadError'), 'error');
            btn.disabled = false;
            btn.textContent = t('cloud.syncApply');
          }
        });
      });
    } catch {
      if (syncEmpty) syncEmpty.style.display = '';
      if (syncList) syncList.style.display = 'none';
      _updateSyncBadge(0);
    }
  }

  function _updateSyncBadge(count) {
    const badge = document.getElementById('cp-sync-badge');
    if (!badge) return;
    if (count > 0) {
      badge.style.display = '';
      badge.textContent = String(count);
    } else {
      badge.style.display = 'none';
    }
  }

  const syncCheckBtn = document.getElementById('cp-sync-check-btn');
  if (syncCheckBtn) {
    syncCheckBtn.addEventListener('click', async () => {
      syncCheckBtn.disabled = true;
      syncCheckBtn.classList.add('loading');
      try {
        await _checkCloudChanges();
      } finally {
        syncCheckBtn.disabled = false;
        syncCheckBtn.classList.remove('loading');
      }
    });
  }

  // ── Full Sync button ──
  const fullSyncBtn = document.getElementById('cp-full-sync-btn');
  if (fullSyncBtn) {
    fullSyncBtn.addEventListener('click', async () => {
      fullSyncBtn.disabled = true;
      fullSyncBtn.classList.add('loading');
      _updateSyncStatusUI('syncing');
      try {
        await api.sync.fullSync();
      } catch {
        _updateSyncStatusUI('error');
      } finally {
        fullSyncBtn.disabled = false;
        fullSyncBtn.classList.remove('loading');
      }
    });
  }

  // ── Sync step label map ──
  const SYNC_STEP_LABELS = {
    fetch: t('sync.stepFetch'),
    settings: t('sync.stepSettings'),
    projects: t('sync.stepProjects'),
    timeTracking: t('sync.stepTimeTracking'),
    conversations: t('sync.stepConversations'),
    skills: t('sync.stepSkills'),
    agents: t('sync.stepAgents'),
    mcpConfigs: t('sync.stepMcp'),
    keybindings: t('sync.stepKeybindings'),
    memory: t('sync.stepMemory'),
    hooksConfig: t('sync.stepHooks'),
    timeTrackingArchives: t('sync.stepArchives'),
    installedPlugins: t('sync.stepPlugins'),
  };

  // ── Sync status indicator ──
  let _syncHideTimer = null;

  function _updateSyncStatusUI(state, detail) {
    const el = document.getElementById('cp-sync-status');
    const textEl = document.getElementById('cp-sync-status-text');
    const progressEl = document.getElementById('cp-sync-progress');
    const progressBar = document.getElementById('cp-sync-progress-bar');
    if (!el || !textEl) return;

    if (_syncHideTimer) { clearTimeout(_syncHideTimer); _syncHideTimer = null; }

    el.style.display = '';
    el.className = `cp-sync-status ${state}`;

    if (state === 'syncing') {
      textEl.textContent = t('sync.syncing');
      if (progressEl) { progressEl.style.display = 'none'; }
    } else if (state === 'progress') {
      const { step, total, label } = detail || {};
      const pct = Math.round((step / total) * 100);
      const stepLabel = SYNC_STEP_LABELS[label] || label || '';
      textEl.textContent = `${stepLabel} (${step}/${total})`;
      if (progressEl && progressBar) {
        progressEl.style.display = '';
        progressBar.style.width = `${pct}%`;
      }
    } else if (state === 'synced') {
      textEl.textContent = t('sync.synced');
      if (progressEl && progressBar) {
        progressBar.style.width = '100%';
        setTimeout(() => { if (progressEl) progressEl.style.display = 'none'; }, 600);
      }
      _syncHideTimer = setTimeout(() => { el.style.display = 'none'; }, 5000);
    } else if (state === 'error') {
      textEl.textContent = detail?.message || t('sync.syncError');
      if (progressEl) { progressEl.style.display = 'none'; }
      _syncHideTimer = setTimeout(() => { el.style.display = 'none'; }, 8000);
    }
  }

  // Listen for sync status from main process
  if (api.sync?.onStatus) {
    api.sync.onStatus(({ type, status, detail }) => {
      if (status === 'started') {
        _updateSyncStatusUI('syncing');
      } else if (status === 'progress') {
        _updateSyncStatusUI('progress', detail);
      } else if (status === 'completed') {
        _updateSyncStatusUI('synced');
      } else if (status === 'error') {
        _updateSyncStatusUI('error', { message: typeof detail === 'string' ? detail : null });
      }
    });
  }
}


function cleanup() {
  _stopSessionsPolling();
}

function _stopSessionsPolling() {
  if (_cloudSessionsInterval) { clearInterval(_cloudSessionsInterval); _cloudSessionsInterval = null; }
}


module.exports = { buildHtml, setupHandlers, cleanup };
