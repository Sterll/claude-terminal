/**
 * CloudPanel
 * Cloud tab - connection, profile, projects, and sessions management.
 * Two states: disconnected (connection form) and connected (dashboard).
 */

const { t } = require('../../i18n');

let _ctx = null;
let _sessionsInterval = null;
let _projectsInterval = null;

function _escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml(settings) {
  return `
    <div class="cloud-panel">

      <!-- Top Bar -->
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
          <div class="cp-status-pill" id="cp-status-pill">
            <span class="cp-status-dot"></span>
            <span id="cp-status-text">${t('cloud.disconnected')}</span>
          </div>
          <button class="cp-connect-btn" id="cp-connect-btn">${t('cloud.connect')}</button>
        </div>
      </div>

      <!-- Body -->
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
            <div class="cp-field cp-auto-connect-row">
              <label class="cp-toggle-label">
                <input type="checkbox" id="cp-auto-connect" ${settings.cloudAutoConnect ? 'checked' : ''}>
                <span>${t('cloud.autoConnect')}</span>
              </label>
            </div>
            <div id="cp-connect-error" class="cp-error" style="display:none"></div>
            <button class="cp-primary-btn" id="cp-connect-form-btn">${t('cloud.connect')}</button>
          </div>

          <div class="cp-install-card">
            <div class="cp-install-title">${t('cloud.installTitle')}</div>
            <div class="cp-install-hint">${t('cloud.installHint')}</div>
            <div class="cp-install-cmd">
              <code>curl -fsSL https://raw.githubusercontent.com/Sterll/claude-terminal/main/cloud/install.sh | bash</code>
              <button class="cp-copy-btn" id="cp-copy-install-cmd" title="${t('cloud.copyCmd')}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              </button>
            </div>
          </div>
        </div>

        <!-- Connected State -->
        <div class="cp-connected" id="cp-connected-view" style="display:none">

          <!-- User Profile -->
          <div class="cp-section">
            <div class="cp-section-header">
              <h3>${t('cloud.userTitle')}</h3>
            </div>
            <div class="cp-user-card" id="cp-user-card">
              <div class="cp-user-name" id="cp-user-name"></div>
              <div class="cp-user-git-row">
                <div class="cp-field-inline">
                  <label>${t('cloud.userGitName')}</label>
                  <input type="text" id="cp-git-name" class="cp-input cp-input-sm" placeholder="Your Name">
                </div>
                <div class="cp-field-inline">
                  <label>${t('cloud.userGitEmail')}</label>
                  <input type="text" id="cp-git-email" class="cp-input cp-input-sm" placeholder="you@example.com">
                </div>
                <button class="cp-btn-sm" id="cp-save-user">${t('cloud.userSave')}</button>
              </div>
            </div>
          </div>

          <!-- Sync Status -->
          <div class="cp-section cp-sync-section">
            <div class="cp-sync-bar">
              <div class="cp-sync-status">
                <span class="cp-sync-dot" id="cp-sync-dot"></span>
                <span class="cp-sync-text" id="cp-sync-text">${t('cloud.syncStatusIdle')}</span>
                <span class="cp-sync-last" id="cp-sync-last"></span>
              </div>
              <div class="cp-sync-actions">
                <span class="cp-sync-conflicts-badge" id="cp-sync-conflicts-badge" style="display:none">0</span>
                <button class="cp-btn-sm" id="cp-sync-now-btn">${t('cloud.syncNow')}</button>
              </div>
            </div>

            <!-- Sync Toggles (collapsible) -->
            <details class="cp-sync-details">
              <summary class="cp-sync-settings-toggle">${t('cloud.syncTitle')}</summary>
              <div class="cp-sync-toggles">
                <label class="cp-sync-toggle-row">
                  <input type="checkbox" id="cp-sync-auto" ${settings.cloudAutoSync !== false ? 'checked' : ''}>
                  <span>${t('cloud.syncAuto')}</span>
                </label>
                <label class="cp-sync-toggle-row">
                  <input type="checkbox" data-sync-key="cloudSyncSettings" ${settings.cloudSyncSettings !== false ? 'checked' : ''}>
                  <span>${t('cloud.syncSettings')}</span>
                </label>
                <label class="cp-sync-toggle-row">
                  <input type="checkbox" data-sync-key="cloudSyncProjects" ${settings.cloudSyncProjects !== false ? 'checked' : ''}>
                  <span>${t('cloud.syncProjects')}</span>
                </label>
                <label class="cp-sync-toggle-row">
                  <input type="checkbox" data-sync-key="cloudSyncTimeTracking" ${settings.cloudSyncTimeTracking !== false ? 'checked' : ''}>
                  <span>${t('cloud.syncTimeTracking')}</span>
                </label>
                <label class="cp-sync-toggle-row">
                  <input type="checkbox" data-sync-key="cloudSyncMcpConfigs" ${settings.cloudSyncMcpConfigs !== false ? 'checked' : ''}>
                  <span>${t('cloud.syncMcp')}</span>
                </label>
                <label class="cp-sync-toggle-row">
                  <input type="checkbox" data-sync-key="cloudSyncSkills" ${settings.cloudSyncSkills !== false ? 'checked' : ''}>
                  <span>${t('cloud.syncSkills')}</span>
                </label>
                <label class="cp-sync-toggle-row">
                  <input type="checkbox" data-sync-key="cloudSyncMemory" ${settings.cloudSyncMemory !== false ? 'checked' : ''}>
                  <span>${t('cloud.syncMemory')}</span>
                </label>
                <label class="cp-sync-toggle-row">
                  <input type="checkbox" data-sync-key="cloudSyncHooksConfig" ${settings.cloudSyncHooksConfig !== false ? 'checked' : ''}>
                  <span>${t('cloud.syncHooks')}</span>
                </label>
                <label class="cp-sync-toggle-row">
                  <input type="checkbox" data-sync-key="cloudSyncPlugins" ${settings.cloudSyncPlugins !== false ? 'checked' : ''}>
                  <span>${t('cloud.syncPlugins')}</span>
                </label>
              </div>
            </details>

            <!-- Conflicts -->
            <div class="cp-conflicts" id="cp-conflicts" style="display:none">
              <div class="cp-conflict-banner">
                <span id="cp-conflict-count"></span>
                <button class="cp-btn-sm" id="cp-resolve-all-btn">${t('cloud.conflictResolveAll')}</button>
              </div>
              <div id="cp-conflict-list" class="cp-conflict-list"></div>
            </div>
          </div>

          <!-- Projects -->
          <div class="cp-section">
            <div class="cp-section-header">
              <h3>${t('cloud.cloudProjects')}</h3>
              <div class="cp-section-actions">
                <button class="cp-btn-sm" id="cp-upload-project-btn">${t('cloud.uploadBtn')}</button>
                <button class="cp-btn-sm cp-btn-ghost" id="cp-refresh-projects-btn">${t('cloud.cloudProjectsRefresh')}</button>
              </div>
            </div>
            <div id="cp-projects-grid" class="cp-projects-grid">
              <div class="cp-empty">${t('cloud.cloudProjectsEmpty')}</div>
            </div>
          </div>

          <!-- Sessions -->
          <div class="cp-section">
            <div class="cp-section-header">
              <h3>${t('cloud.sessionsTitle')}</h3>
              <button class="cp-btn-sm cp-btn-ghost" id="cp-refresh-sessions-btn">${t('cloud.sessionsRefresh')}</button>
            </div>
            <div id="cp-sessions-list" class="cp-sessions-list">
              <div class="cp-empty">${t('cloud.sessionsEmpty')}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function setupHandlers(context) {
  _ctx = context;
  const { settings, saveSettings } = context;
  const api = window.electron_api;
  if (!api?.cloud) return;

  const connectBtn = document.getElementById('cp-connect-btn');
  const connectFormBtn = document.getElementById('cp-connect-form-btn');
  const statusPill = document.getElementById('cp-status-pill');
  const statusText = document.getElementById('cp-status-text');
  const disconnectedView = document.getElementById('cp-disconnected-view');
  const connectedView = document.getElementById('cp-connected-view');
  const connectError = document.getElementById('cp-connect-error');
  const keyToggle = document.getElementById('cp-key-toggle');
  const copyInstallCmd = document.getElementById('cp-copy-install-cmd');

  // ── View toggle ──

  function setView(connected) {
    if (disconnectedView) disconnectedView.style.display = connected ? 'none' : '';
    if (connectedView) connectedView.style.display = connected ? '' : 'none';
    if (connectBtn) {
      connectBtn.textContent = connected ? t('cloud.disconnect') : t('cloud.connect');
      connectBtn.classList.toggle('connected', connected);
    }
    if (statusPill) statusPill.classList.toggle('connected', connected);
    if (statusText) statusText.textContent = connected ? t('cloud.connected') : t('cloud.disconnected');
  }

  // ── Connect / Disconnect ──

  async function doConnect() {
    const serverUrl = document.getElementById('cp-server-url')?.value?.trim();
    const apiKey = document.getElementById('cp-api-key')?.value?.trim();
    const autoConnect = document.getElementById('cp-auto-connect')?.checked;

    if (!serverUrl || !apiKey) {
      if (connectError) {
        connectError.textContent = t('cloud.serverUrl') + ' & ' + t('cloud.apiKey') + ' required';
        connectError.style.display = '';
      }
      return;
    }

    if (connectError) connectError.style.display = 'none';

    // Save settings
    settings.cloudServerUrl = serverUrl;
    settings.cloudApiKey = apiKey;
    settings.cloudAutoConnect = autoConnect;
    saveSettings(settings);

    await api.cloud.connect({ serverUrl, apiKey });
  }

  async function doDisconnect() {
    await api.cloud.disconnect();
    settings.cloudAutoConnect = false;
    saveSettings(settings);
    setView(false);
  }

  if (connectFormBtn) connectFormBtn.addEventListener('click', doConnect);
  if (connectBtn) {
    connectBtn.addEventListener('click', () => {
      const isConnected = statusPill?.classList.contains('connected');
      isConnected ? doDisconnect() : doConnect();
    });
  }

  // ── Status listener ──

  const unsubStatus = api.cloud.onStatusChanged?.((status) => {
    setView(status.connected);
    if (status.connected) {
      _loadUser();
      _loadProjects();
      _loadSessions();
      _startPolling();
    } else {
      _stopPolling();
      if (status.error && connectError) {
        connectError.textContent = status.error;
        connectError.style.display = '';
      }
    }
  });

  // ── Key toggle ──

  if (keyToggle) {
    keyToggle.addEventListener('click', () => {
      const input = document.getElementById('cp-api-key');
      if (input) input.type = input.type === 'password' ? 'text' : 'password';
    });
  }

  // ── Copy install command ──

  if (copyInstallCmd) {
    copyInstallCmd.addEventListener('click', async () => {
      const code = copyInstallCmd.closest('.cp-install-cmd')?.querySelector('code');
      if (code) {
        await api.app.clipboardWrite(code.textContent);
        copyInstallCmd.classList.add('copied');
        setTimeout(() => copyInstallCmd.classList.remove('copied'), 2000);
      }
    });
  }

  // ── User profile ──

  async function _loadUser() {
    try {
      const user = await api.cloud.getUser();
      const nameEl = document.getElementById('cp-user-name');
      const gitNameEl = document.getElementById('cp-git-name');
      const gitEmailEl = document.getElementById('cp-git-email');
      if (nameEl) nameEl.textContent = user.name || '';
      if (gitNameEl) gitNameEl.value = user.gitName || '';
      if (gitEmailEl) gitEmailEl.value = user.gitEmail || '';
    } catch {}
  }

  const saveUserBtn = document.getElementById('cp-save-user');
  if (saveUserBtn) {
    saveUserBtn.addEventListener('click', async () => {
      const gitName = document.getElementById('cp-git-name')?.value?.trim();
      const gitEmail = document.getElementById('cp-git-email')?.value?.trim();
      try {
        await api.cloud.updateUser({ gitName, gitEmail });
        saveUserBtn.textContent = t('cloud.userSaved');
        setTimeout(() => { saveUserBtn.textContent = t('cloud.userSave'); }, 2000);
      } catch {
        saveUserBtn.textContent = t('cloud.userSaveError');
        setTimeout(() => { saveUserBtn.textContent = t('cloud.userSave'); }, 2000);
      }
    });
  }

  // ── Projects ──

  async function _loadProjects() {
    try {
      const { projects } = await api.cloud.getProjects();
      _renderProjects(projects || []);
    } catch {
      _renderProjects([]);
    }
  }

  function _renderProjects(projects) {
    const grid = document.getElementById('cp-projects-grid');
    if (!grid) return;

    if (projects.length === 0) {
      grid.innerHTML = `<div class="cp-empty">${t('cloud.cloudProjectsEmpty')}</div>`;
      return;
    }

    grid.innerHTML = projects.map(p => {
      const name = _escapeHtml(p.displayName || p.name);
      const activity = p.lastActivity ? _timeAgo(p.lastActivity) : '';
      return `
        <div class="cp-project-card" data-name="${_escapeHtml(p.name)}">
          <div class="cp-project-info">
            <div class="cp-project-name">${name}</div>
            ${activity ? `<div class="cp-project-activity">${activity}</div>` : ''}
          </div>
          <div class="cp-project-actions">
            <button class="cp-btn-sm cp-btn-ghost cp-import-btn" data-name="${_escapeHtml(p.name)}" data-display="${name}" title="${t('cloud.cloudProjectImport')}">${t('cloud.cloudProjectImport')}</button>
            <button class="cp-btn-sm cp-btn-danger cp-delete-btn" data-name="${_escapeHtml(p.name)}" data-display="${name}" title="${t('cloud.deleteTitle')}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </div>
      `;
    }).join('');

    // Import buttons
    grid.querySelectorAll('.cp-import-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.name;
        const display = btn.dataset.display;
        btn.textContent = t('cloud.cloudProjectImporting');
        btn.disabled = true;
        try {
          const result = await api.cloud.importProject({ projectName: name, displayName: display });
          if (result && !result.canceled) {
            const Toast = require('../components/Toast');
            Toast.show(t('cloud.cloudProjectImported', { name: display }), 'success');
          }
        } catch (err) {
          const Toast = require('../components/Toast');
          Toast.show(t('cloud.uploadError'), 'error');
        }
        btn.textContent = t('cloud.cloudProjectImport');
        btn.disabled = false;
      });
    });

    // Delete buttons
    grid.querySelectorAll('.cp-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.name;
        const display = btn.dataset.display;
        const { showConfirm } = require('../components/Modal');
        const confirmed = await showConfirm({
          title: t('cloud.deleteTitle'),
          message: t('cloud.confirmCloudDelete', { name: display }),
          confirmLabel: t('cloud.deleteTitle'),
          danger: true,
        });
        if (confirmed) {
          try {
            await api.cloud.deleteProject({ projectId: name });
            _loadProjects();
            const Toast = require('../components/Toast');
            Toast.show(t('cloud.deleteSuccess'), 'success');
          } catch {
            const Toast = require('../components/Toast');
            Toast.show(t('cloud.deleteError'), 'error');
          }
        }
      });
    });
  }

  // Upload project button
  const uploadBtn = document.getElementById('cp-upload-project-btn');
  if (uploadBtn) {
    uploadBtn.addEventListener('click', async () => {
      const { projectsState } = require('../../state/projects.state');
      const projects = projectsState.get().projects || [];
      if (projects.length === 0) return;

      // Show project picker
      const { showModal } = require('../components/Modal');
      const listHtml = projects.map(p => {
        const name = _escapeHtml(p.name || p.path?.split(/[\\/]/).pop() || '?');
        return `<div class="cp-pick-item" data-id="${_escapeHtml(p.id)}" data-name="${name}" data-path="${_escapeHtml(p.path)}">${name}</div>`;
      }).join('');

      const modal = showModal({
        title: t('cloud.uploadTitle'),
        html: `<div class="cp-pick-list">${listHtml}</div>`,
        size: 'small',
      });

      modal.el.querySelectorAll('.cp-pick-item').forEach(item => {
        item.addEventListener('click', async () => {
          modal.close();
          const projectId = item.dataset.id;
          const projectName = item.dataset.name;
          const projectPath = item.dataset.path;

          // Check for GitHub remote first
          let useGit = false;
          try {
            const { hasGitHub } = await api.cloud.checkGitRemote({ projectPath });
            useGit = hasGitHub;
          } catch {}

          try {
            if (useGit) {
              await api.cloud.uploadProjectGit({ projectId, projectName, projectPath });
            } else {
              await api.cloud.uploadProject({ projectId, projectName, projectPath });
            }
            const Toast = require('../components/Toast');
            Toast.show(t('cloud.uploadSuccess'), 'success');
            _loadProjects();
          } catch (err) {
            const Toast = require('../components/Toast');
            Toast.show(`${t('cloud.uploadError')}: ${err.message}`, 'error');
          }
        });
      });
    });
  }

  // Refresh projects
  const refreshProjectsBtn = document.getElementById('cp-refresh-projects-btn');
  if (refreshProjectsBtn) refreshProjectsBtn.addEventListener('click', _loadProjects);

  // ── Sessions ──

  async function _loadSessions() {
    try {
      const { sessions } = await api.cloud.getSessions();
      _renderSessions(sessions || []);
    } catch {
      _renderSessions([]);
    }
  }

  function _renderSessions(sessions) {
    const list = document.getElementById('cp-sessions-list');
    if (!list) return;

    if (sessions.length === 0) {
      list.innerHTML = `<div class="cp-empty">${t('cloud.sessionsEmpty')}</div>`;
      return;
    }

    list.innerHTML = sessions.map(s => {
      const project = _escapeHtml(s.projectName || '');
      const model = _escapeHtml(s.model || 'default');
      const status = s.status || 'running';
      const statusKey = `cloud.session${status.charAt(0).toUpperCase() + status.slice(1)}`;
      const started = s.startedAt ? _timeAgo(s.startedAt) : '';
      return `
        <div class="cp-session-item ${status}">
          <div class="cp-session-info">
            <span class="cp-session-project">${project}</span>
            <span class="cp-session-model">${model}</span>
            <span class="cp-session-status">${t(statusKey) || status}</span>
            ${started ? `<span class="cp-session-time">${started}</span>` : ''}
          </div>
          <button class="cp-btn-sm cp-btn-danger cp-stop-session-btn" data-id="${_escapeHtml(s.id)}">${t('cloud.sessionStop')}</button>
        </div>
      `;
    }).join('');

    list.querySelectorAll('.cp-stop-session-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api.cloud.stopSession({ sessionId: btn.dataset.id });
          _loadSessions();
        } catch {}
        btn.disabled = false;
      });
    });
  }

  // Refresh sessions
  const refreshSessionsBtn = document.getElementById('cp-refresh-sessions-btn');
  if (refreshSessionsBtn) refreshSessionsBtn.addEventListener('click', _loadSessions);

  // ── Upload progress ──

  const unsubProgress = api.cloud.onUploadProgress?.((progress) => {
    // Could show a toast or progress bar - for now just log
    if (progress.phase === 'done') {
      _loadProjects();
    }
  });

  // ── Sync ──

  const syncNowBtn = document.getElementById('cp-sync-now-btn');
  const syncAutoToggle = document.getElementById('cp-sync-auto');
  const resolveAllBtn = document.getElementById('cp-resolve-all-btn');

  if (syncNowBtn) {
    syncNowBtn.addEventListener('click', async () => {
      syncNowBtn.disabled = true;
      try {
        await api.cloud.syncForce();
      } catch {}
      syncNowBtn.disabled = false;
    });
  }

  // Auto-sync master toggle
  if (syncAutoToggle) {
    syncAutoToggle.addEventListener('change', () => {
      settings.cloudAutoSync = syncAutoToggle.checked;
      saveSettings(settings);
      if (syncAutoToggle.checked) {
        api.cloud.syncStart().catch(() => {});
      } else {
        api.cloud.syncStop().catch(() => {});
      }
    });
  }

  // Per-entity toggles
  document.querySelectorAll('[data-sync-key]').forEach(toggle => {
    toggle.addEventListener('change', () => {
      settings[toggle.dataset.syncKey] = toggle.checked;
      saveSettings(settings);
    });
  });

  // Resolve all conflicts
  if (resolveAllBtn) {
    resolveAllBtn.addEventListener('click', async () => {
      resolveAllBtn.disabled = true;
      try {
        await api.cloud.resolveAllConflicts('local');
      } catch {}
      resolveAllBtn.disabled = false;
    });
  }

  // Sync status listener
  const unsubSyncStatus = api.cloud.onSyncStatusChanged?.((status) => {
    _updateSyncUI(status);
  });

  // Sync conflict listener
  const unsubSyncConflict = api.cloud.onSyncConflict?.((conflicts) => {
    _renderConflicts(conflicts);
  });

  function _updateSyncUI(status) {
    const dot = document.getElementById('cp-sync-dot');
    const text = document.getElementById('cp-sync-text');
    const lastEl = document.getElementById('cp-sync-last');
    const badge = document.getElementById('cp-sync-conflicts-badge');

    const statusMap = {
      idle: { key: 'cloud.syncStatusIdle', cls: 'idle' },
      syncing: { key: 'cloud.syncStatusSyncing', cls: 'syncing' },
      error: { key: 'cloud.syncStatusError', cls: 'error' },
      offline: { key: 'cloud.syncStatusOffline', cls: 'offline' },
      conflict: { key: 'cloud.syncStatusConflict', cls: 'conflict' },
    };

    const s = statusMap[status.status] || statusMap.idle;
    if (dot) { dot.className = 'cp-sync-dot ' + s.cls; }
    if (text) text.textContent = t(s.key);
    if (lastEl && status.lastSync) {
      lastEl.textContent = t('cloud.syncLastSync', { time: _timeAgo(status.lastSync) });
    }
    if (badge) {
      if (status.conflicts > 0) {
        badge.textContent = status.conflicts;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }
  }

  function _renderConflicts(conflicts) {
    const container = document.getElementById('cp-conflicts');
    const countEl = document.getElementById('cp-conflict-count');
    const listEl = document.getElementById('cp-conflict-list');

    if (!container) return;

    if (!conflicts || conflicts.length === 0) {
      container.style.display = 'none';
      return;
    }

    container.style.display = '';
    if (countEl) countEl.textContent = t('cloud.conflictsBanner', { count: conflicts.length });

    if (listEl) {
      listEl.innerHTML = conflicts.map(c => `
        <div class="cp-conflict-card">
          <div class="cp-conflict-info">
            <span class="cp-conflict-type">${_escapeHtml(c.entityType)}</span>
            <span class="cp-conflict-desc">${t('cloud.conflictDesc')}</span>
          </div>
          <div class="cp-conflict-actions">
            <button class="cp-btn-sm" data-resolve="${_escapeHtml(c.entityType)}" data-resolution="local">${t('cloud.conflictKeepLocal')}</button>
            <button class="cp-btn-sm cp-btn-ghost" data-resolve="${_escapeHtml(c.entityType)}" data-resolution="cloud">${t('cloud.conflictKeepCloud')}</button>
          </div>
        </div>
      `).join('');

      listEl.querySelectorAll('[data-resolve]').forEach(btn => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await api.cloud.resolveConflict({ entityType: btn.dataset.resolve, resolution: btn.dataset.resolution });
          } catch {}
          btn.disabled = false;
        });
      });
    }
  }

  // Load initial sync status
  api.cloud.syncStatus().then(status => {
    if (status) _updateSyncUI(status);
  }).catch(() => {});

  api.cloud.getConflicts().then(conflicts => {
    if (conflicts?.length > 0) _renderConflicts(conflicts);
  }).catch(() => {});

  // ── Polling ──

  function _startPolling() {
    _stopPolling();
    _sessionsInterval = setInterval(_loadSessions, 15000);
    _projectsInterval = setInterval(_loadProjects, 30000);
  }

  function _stopPolling() {
    if (_sessionsInterval) { clearInterval(_sessionsInterval); _sessionsInterval = null; }
    if (_projectsInterval) { clearInterval(_projectsInterval); _projectsInterval = null; }
  }

  // ── Initial state check ──

  api.cloud.status().then(status => {
    if (status?.connected) {
      setView(true);
      _loadUser();
      _loadProjects();
      _loadSessions();
      _startPolling();
    }
  }).catch(() => {});

  // Store cleanup refs
  _ctx._unsubStatus = unsubStatus;
  _ctx._unsubProgress = unsubProgress;
  _ctx._unsubSyncStatus = unsubSyncStatus;
  _ctx._unsubSyncConflict = unsubSyncConflict;
  _ctx._stopPolling = _stopPolling;
}

// ── Helpers ──

function _timeAgo(timestamp) {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 60) return t('cloud.timeJustNow');
  if (diff < 3600) return t('cloud.timeMinAgo', { count: Math.floor(diff / 60) });
  if (diff < 86400) return t('cloud.timeHourAgo', { count: Math.floor(diff / 3600) });
  return t('cloud.timeDayAgo', { count: Math.floor(diff / 86400) });
}

function cleanup() {
  if (_ctx?._unsubStatus) _ctx._unsubStatus();
  if (_ctx?._unsubProgress) _ctx._unsubProgress();
  if (_ctx?._unsubSyncStatus) _ctx._unsubSyncStatus();
  if (_ctx?._unsubSyncConflict) _ctx._unsubSyncConflict();
  if (_ctx?._stopPolling) _ctx._stopPolling();
  _ctx = null;
}

module.exports = { buildHtml, setupHandlers, cleanup };
