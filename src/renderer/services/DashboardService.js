/**
 * Dashboard Service
 * Handles dashboard data loading, rendering and operations
 */

const { ipcRenderer } = require('electron');
const { projectsState, setGitPulling, setGitPushing, getGitOperation } = require('../state');
const { escapeHtml } = require('../utils');

// ========== CACHE SYSTEM ==========
const dashboardCache = new Map(); // projectId -> { data, timestamp, loading }
const CACHE_TTL = 30000; // 30 seconds cache validity
const REFRESH_DEBOUNCE = 2000; // 2 seconds minimum between refreshes

/**
 * Get cached dashboard data
 * @param {string} projectId
 * @returns {Object|null}
 */
function getCachedData(projectId) {
  const cached = dashboardCache.get(projectId);
  if (!cached) return null;
  return cached.data;
}

/**
 * Check if cache is still valid
 * @param {string} projectId
 * @returns {boolean}
 */
function isCacheValid(projectId) {
  const cached = dashboardCache.get(projectId);
  if (!cached) return false;
  return Date.now() - cached.timestamp < CACHE_TTL;
}

/**
 * Check if a refresh is already in progress
 * @param {string} projectId
 * @returns {boolean}
 */
function isRefreshing(projectId) {
  const cached = dashboardCache.get(projectId);
  return cached?.loading === true;
}

/**
 * Set cache data
 * @param {string} projectId
 * @param {Object} data
 */
function setCacheData(projectId, data) {
  dashboardCache.set(projectId, {
    data,
    timestamp: Date.now(),
    loading: false
  });
}

/**
 * Set loading state
 * @param {string} projectId
 * @param {boolean} loading
 */
function setCacheLoading(projectId, loading) {
  const cached = dashboardCache.get(projectId);
  if (cached) {
    cached.loading = loading;
  } else {
    dashboardCache.set(projectId, { data: null, timestamp: 0, loading });
  }
}

/**
 * Invalidate cache for a project
 * @param {string} projectId
 */
function invalidateCache(projectId) {
  dashboardCache.delete(projectId);
}

/**
 * Clear all cache
 */
function clearAllCache() {
  dashboardCache.clear();
}

/**
 * Get full git info for dashboard
 * @param {string} projectPath
 * @returns {Promise<Object>}
 */
async function getGitInfoFull(projectPath) {
  try {
    return await ipcRenderer.invoke('git-info-full', projectPath);
  } catch (e) {
    console.error('Error getting full git info:', e);
    return { isGitRepo: false };
  }
}

/**
 * Get basic git info for a project
 * @param {string} projectPath
 * @returns {Promise<Object>}
 */
async function getGitInfo(projectPath) {
  try {
    return await ipcRenderer.invoke('git-info', projectPath);
  } catch (e) {
    console.error('Error getting git info:', e);
    return { isGitRepo: false };
  }
}

/**
 * Get project statistics (lines of code, etc.)
 * @param {string} projectPath
 * @returns {Promise<Object>}
 */
async function getProjectStats(projectPath) {
  try {
    return await ipcRenderer.invoke('project-stats', projectPath);
  } catch (e) {
    console.error('Error getting project stats:', e);
    return { files: 0, lines: 0, byExtension: {} };
  }
}

/**
 * Load full dashboard data for a project
 * @param {string} projectPath
 * @returns {Promise<Object>}
 */
async function loadDashboardData(projectPath) {
  const [gitInfo, stats] = await Promise.all([
    getGitInfoFull(projectPath),
    getProjectStats(projectPath)
  ]);

  return { gitInfo, stats };
}

/**
 * Execute git pull for a project
 * @param {string} projectId
 * @param {Function} onComplete - Callback when complete
 * @returns {Promise<Object>}
 */
async function gitPull(projectId, onComplete) {
  const project = projectsState.get().projects.find(p => p.id === projectId);
  if (!project) return { success: false, error: 'Project not found' };

  setGitPulling(projectId, true);

  try {
    const result = await ipcRenderer.invoke('git-pull', { projectPath: project.path });
    setGitPulling(projectId, false, result);
    if (onComplete) onComplete(result);
    return result;
  } catch (e) {
    const result = { success: false, error: e.message };
    setGitPulling(projectId, false, result);
    if (onComplete) onComplete(result);
    return result;
  }
}

/**
 * Execute git push for a project
 * @param {string} projectId
 * @param {Function} onComplete - Callback when complete
 * @returns {Promise<Object>}
 */
async function gitPush(projectId, onComplete) {
  const project = projectsState.get().projects.find(p => p.id === projectId);
  if (!project) return { success: false, error: 'Project not found' };

  setGitPushing(projectId, true);

  try {
    const result = await ipcRenderer.invoke('git-push', { projectPath: project.path });
    setGitPushing(projectId, false, result);
    if (onComplete) onComplete(result);
    return result;
  } catch (e) {
    const result = { success: false, error: e.message };
    setGitPushing(projectId, false, result);
    if (onComplete) onComplete(result);
    return result;
  }
}

/**
 * Check quick git status
 * @param {string} projectPath
 * @returns {Promise<Object>}
 */
async function getGitStatusQuick(projectPath) {
  try {
    return await ipcRenderer.invoke('git-status-quick', { projectPath });
  } catch (e) {
    return { isGitRepo: false };
  }
}

/**
 * Format number with thousands separator
 * @param {number} n
 * @returns {string}
 */
function formatNumber(n) {
  return n?.toLocaleString('fr-FR') || '0';
}

/**
 * Build sync badges HTML
 * @param {Object} aheadBehind
 * @returns {string}
 */
function buildSyncBadges(aheadBehind) {
  if (!aheadBehind) return '';

  let badges = '';

  if (!aheadBehind.hasRemote) {
    badges += `<span class="sync-badge no-remote"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg> Pas de remote</span>`;
    return badges;
  }

  if (aheadBehind.notTracking) {
    badges += `<span class="sync-badge not-tracking"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg> Branche non trackee</span>`;
    return badges;
  }

  if (aheadBehind.behind > 0) {
    badges += `<span class="sync-badge pull"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8z"/></svg> ${aheadBehind.behind} a pull</span>`;
  }
  if (aheadBehind.ahead > 0) {
    badges += `<span class="sync-badge push"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 4v2h14V4H5zm0 10h4v6h6v-6h4l-7-7-7 7z"/></svg> ${aheadBehind.ahead} a push</span>`;
  }
  if (aheadBehind.ahead === 0 && aheadBehind.behind === 0) {
    badges += `<span class="sync-badge synced"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Synchronise</span>`;
  }

  return badges;
}

/**
 * Build file list HTML for a category
 * @param {Array} fileList
 * @param {string} title
 * @param {string} badgeClass
 * @returns {string}
 */
function buildFileListHtml(fileList, title, badgeClass) {
  if (!fileList || fileList.length === 0) return '';

  const filesHtml = fileList.slice(0, 10).map(f => `
    <div class="file-item ${f.type}">
      <span class="file-status-icon ${f.type}"></span>
      <span class="file-name">${escapeHtml(f.file)}</span>
    </div>
  `).join('');

  const moreHtml = fileList.length > 10
    ? `<div class="file-item more">... et ${fileList.length - 10} autres</div>`
    : '';

  return `
    <div class="file-group">
      <div class="file-group-title"><span class="file-badge ${badgeClass}">${fileList.length}</span> ${title}</div>
      <div class="file-list">${filesHtml}${moreHtml}</div>
    </div>
  `;
}

/**
 * Build commits list HTML
 * @param {Array} commits
 * @returns {string}
 */
function buildCommitsHtml(commits) {
  if (!commits || commits.length === 0) return '';

  return `
    <div class="dashboard-section">
      <h3><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg> Commits recents</h3>
      <div class="commits-list">
        ${commits.map(c => `
          <div class="commit-item">
            <span class="commit-hash">${c.hash}</span>
            <span class="commit-message">${escapeHtml(c.message || '')}</span>
            <span class="commit-meta">${escapeHtml(c.author || '')} - ${c.date || ''}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

/**
 * Build changed files section HTML
 * @param {Object} files
 * @returns {string}
 */
function buildChangedFilesHtml(files) {
  const stagedCount = files?.staged?.length || 0;
  const unstagedCount = files?.unstaged?.length || 0;
  const untrackedCount = files?.untracked?.length || 0;
  const totalChanges = stagedCount + unstagedCount + untrackedCount;

  if (totalChanges === 0) return '';

  return `
    <div class="dashboard-section">
      <h3><svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z"/></svg> Fichiers modifies <span class="section-count">${totalChanges}</span></h3>
      <div class="changed-files">
        ${buildFileListHtml(files.staged, 'Staged (prets a commit)', 'staged')}
        ${buildFileListHtml(files.unstaged, 'Modifies (non staged)', 'unstaged')}
        ${buildFileListHtml(files.untracked, 'Non suivis', 'untracked')}
      </div>
    </div>
  `;
}

/**
 * Build git status section HTML
 * @param {Object} gitInfo
 * @returns {string}
 */
function buildGitStatusHtml(gitInfo) {
  if (!gitInfo.isGitRepo) {
    return `
      <div class="dashboard-no-git">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        <p>Ce projet n'est pas un depot Git</p>
      </div>
    `;
  }

  const { aheadBehind, files, branches, stashes, latestTag, recentCommits, branch } = gitInfo;

  // Stashes HTML
  let stashesHtml = '';
  if (stashes && stashes.length > 0) {
    stashesHtml = `
      <div class="dashboard-mini-section">
        <span class="mini-label"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 21h14v-2H5v2zm0-4h14v-2H5v2zm0-4h14v-2H5v2zm0-4h14V7H5v2zm0-6v2h14V3H5z"/></svg> ${stashes.length} stash${stashes.length > 1 ? 'es' : ''}</span>
      </div>
    `;
  }

  // Tag HTML
  let tagHtml = '';
  if (latestTag) {
    tagHtml = `
      <div class="dashboard-mini-section">
        <span class="mini-label"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg> ${latestTag.name}</span>
        ${latestTag.commitsBehind > 0 ? `<span class="tag-behind">+${latestTag.commitsBehind} commits</span>` : ''}
      </div>
    `;
  }

  return `
    <div class="dashboard-git-header">
      <div class="git-branch">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 2a3 3 0 0 0-3 3c0 1.28.81 2.38 1.94 2.81A4 4 0 0 0 9 12H6a3 3 0 0 0 0 6 3 3 0 0 0 2.94-2.41A4 4 0 0 0 13 12v-1.17A3 3 0 0 0 15 8a3 3 0 0 0-3-3 3 3 0 0 0-2.24 1.01A4 4 0 0 0 6 2z"/></svg>
        <span class="branch-name">${branch}</span>
        <span class="branch-count">${branches?.length || 1} branche${(branches?.length || 1) > 1 ? 's' : ''}</span>
      </div>
      <div class="git-sync-status">${buildSyncBadges(aheadBehind)}</div>
    </div>
    ${tagHtml}
    ${stashesHtml}
    ${buildChangedFilesHtml(files)}
    ${buildCommitsHtml(recentCommits)}
  `;
}

/**
 * Build code stats section HTML
 * @param {Object} stats
 * @param {Object} gitInfo
 * @returns {string}
 */
function buildStatsHtml(stats, gitInfo) {
  if (!stats) return '';

  const topExtensions = Object.entries(stats.byExtension || {})
    .sort((a, b) => (b[1]?.lines || 0) - (a[1]?.lines || 0))
    .slice(0, 5);

  let extensionsHtml = '';
  if (topExtensions.length > 0) {
    const maxLines = topExtensions[0]?.[1]?.lines || 1;
    extensionsHtml = `
      <div class="extensions-breakdown">
        ${topExtensions.map(([ext, data]) => `
          <div class="ext-row">
            <span class="ext-name">${ext}</span>
            <div class="ext-bar-container">
              <div class="ext-bar" style="width: ${((data?.lines || 0) / maxLines * 100)}%"></div>
            </div>
            <span class="ext-stats">${formatNumber(data?.files || 0)} fichiers - ${formatNumber(data?.lines || 0)} lignes</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  return `
    <div class="dashboard-section">
      <h3><svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/></svg> Statistiques du code</h3>
      <div class="code-stats-grid">
        <div class="code-stat">
          <div class="code-stat-value">${formatNumber(stats.lines)}</div>
          <div class="code-stat-label">Lignes de code</div>
        </div>
        <div class="code-stat">
          <div class="code-stat-value">${formatNumber(stats.files)}</div>
          <div class="code-stat-label">Fichiers source</div>
        </div>
        ${gitInfo.isGitRepo ? `
        <div class="code-stat">
          <div class="code-stat-value">${formatNumber(gitInfo.totalCommits)}</div>
          <div class="code-stat-label">Total commits</div>
        </div>
        ` : ''}
      </div>
      ${extensionsHtml}
    </div>
  `;
}

/**
 * Build contributors section HTML
 * @param {Array} contributors
 * @returns {string}
 */
function buildContributorsHtml(contributors) {
  if (!contributors || contributors.length === 0) return '';

  return `
    <div class="dashboard-section">
      <h3><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg> Contributeurs</h3>
      <div class="contributors-list">
        ${contributors.map(c => `
          <div class="contributor-item">
            <span class="contributor-name">${escapeHtml(c.name)}</span>
            <span class="contributor-commits">${c.commits} commits</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

/**
 * Render the dashboard HTML with given data
 * @param {HTMLElement} container
 * @param {Object} project
 * @param {Object} data - { gitInfo, stats }
 * @param {Object} options
 * @param {boolean} isRefreshing - Show refresh indicator
 */
function renderDashboardHtml(container, project, data, options, isRefreshing = false) {
  const {
    terminalCount = 0,
    fivemStatus = 'stopped',
    onOpenFolder,
    onOpenClaude,
    onGitPull,
    onGitPush,
    onCopyPath
  } = options;

  const { gitInfo, stats } = data;
  const isFivem = project.type === 'fivem';

  // Build HTML
  container.innerHTML = `
    ${isRefreshing ? '<div class="dashboard-refresh-indicator"><span class="refresh-spinner"></span> Actualisation...</div>' : ''}
    <div class="dashboard-project-header">
      <div class="dashboard-project-title">
        <h2>${escapeHtml(project.name)}</h2>
        <span class="dashboard-project-type ${isFivem ? 'fivem' : ''}">${isFivem ? 'FiveM Server' : 'Standalone'}</span>
      </div>
      <div class="dashboard-project-actions">
        <button class="btn-secondary" id="dash-btn-open-folder">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7l2 2h5v12zm0-12h-5l-2-2H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2z"/></svg>
          Ouvrir dossier
        </button>
        ${gitInfo.isGitRepo && gitInfo.aheadBehind?.hasRemote ? `
        <button class="btn-secondary" id="dash-btn-git-pull" ${!gitInfo.aheadBehind?.notTracking && gitInfo.aheadBehind?.behind === 0 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8z"/></svg>
          Pull
        </button>
        <button class="btn-secondary" id="dash-btn-git-push" ${!gitInfo.aheadBehind?.notTracking && gitInfo.aheadBehind?.ahead === 0 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 4v2h14V4H5zm0 10h4v6h6v-6h4l-7-7-7 7z"/></svg>
          Push
        </button>
        ` : ''}
        <button class="btn-primary" id="dash-btn-claude">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.89 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
          Ouvrir Claude
        </button>
      </div>
    </div>

    <div class="dashboard-quick-stats">
      <div class="quick-stat">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.89 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
        <span>${terminalCount} terminal${terminalCount > 1 ? 's' : ''}</span>
      </div>
      ${isFivem ? `
      <div class="quick-stat ${fivemStatus}">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 16V4H3v12h18m0-14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7v2h2v2H8v-2h2v-2H3a2 2 0 0 1-2-2V4c0-1.11.89-2 2-2h18"/></svg>
        <span>${fivemStatus === 'running' ? 'En ligne' : fivemStatus === 'starting' ? 'Demarrage...' : 'Arrete'}</span>
      </div>
      ` : ''}
      ${gitInfo.isGitRepo && gitInfo.remoteUrl ? `
      <div class="quick-stat">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
        <span class="remote-url">${gitInfo.remoteUrl.replace(/^https?:\/\//, '').replace(/\.git$/, '').substring(0, 40)}</span>
      </div>
      ` : ''}
    </div>

    <div class="dashboard-path-bar">
      <code>${escapeHtml(project.path)}</code>
      <button class="btn-icon-small btn-copy-path" title="Copier">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
      </button>
    </div>

    <div class="dashboard-grid">
      <div class="dashboard-col">
        ${buildGitStatusHtml(gitInfo)}
      </div>
      <div class="dashboard-col">
        ${buildStatsHtml(stats, gitInfo)}
        ${gitInfo.isGitRepo ? buildContributorsHtml(gitInfo.contributors) : ''}
      </div>
    </div>
  `;

  // Attach event listeners
  container.querySelector('#dash-btn-open-folder')?.addEventListener('click', () => {
    if (onOpenFolder) onOpenFolder(project.path);
  });

  container.querySelector('#dash-btn-claude')?.addEventListener('click', () => {
    if (onOpenClaude) onOpenClaude(project);
  });

  container.querySelector('#dash-btn-git-pull')?.addEventListener('click', async () => {
    const btn = container.querySelector('#dash-btn-git-pull');
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-spinner"></span> Pull...';
    if (onGitPull) await onGitPull(project.id);
    // Invalidate cache and re-render
    invalidateCache(project.id);
    renderDashboard(container, project, options);
  });

  container.querySelector('#dash-btn-git-push')?.addEventListener('click', async () => {
    const btn = container.querySelector('#dash-btn-git-push');
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-spinner"></span> Push...';
    if (onGitPush) await onGitPush(project.id);
    // Invalidate cache and re-render
    invalidateCache(project.id);
    renderDashboard(container, project, options);
  });

  container.querySelector('.btn-copy-path')?.addEventListener('click', () => {
    navigator.clipboard.writeText(project.path);
    if (onCopyPath) onCopyPath(project.path);
  });
}

/**
 * Render dashboard content for a project (with caching)
 * @param {HTMLElement} container - Container element
 * @param {Object} project - Project data
 * @param {Object} options - Render options
 * @returns {Promise<void>}
 */
async function renderDashboard(container, project, options = {}) {
  const projectId = project.id;
  const cachedData = getCachedData(projectId);
  const cacheValid = isCacheValid(projectId);
  const alreadyRefreshing = isRefreshing(projectId);

  // Case 1: We have cached data - show it immediately
  if (cachedData) {
    // Render with cached data, show refresh indicator if cache is stale
    renderDashboardHtml(container, project, cachedData, options, !cacheValid && !alreadyRefreshing);

    // If cache is still valid or already refreshing, we're done
    if (cacheValid || alreadyRefreshing) {
      return;
    }

    // Start background refresh
    setCacheLoading(projectId, true);

    try {
      const newData = await loadDashboardData(project.path);
      setCacheData(projectId, newData);

      // Only update UI if this project is still displayed
      if (container.querySelector('#dash-btn-open-folder')) {
        renderDashboardHtml(container, project, newData, options, false);
      }
    } catch (e) {
      console.error('Error refreshing dashboard:', e);
      setCacheLoading(projectId, false);
    }
    return;
  }

  // Case 2: No cache - show loading and fetch
  container.innerHTML = `
    <div class="dashboard-loading">
      <div class="loading-spinner"></div>
      <p>Chargement des informations...</p>
    </div>
  `;

  setCacheLoading(projectId, true);

  try {
    const data = await loadDashboardData(project.path);
    setCacheData(projectId, data);
    renderDashboardHtml(container, project, data, options, false);
  } catch (e) {
    console.error('Error loading dashboard:', e);
    setCacheLoading(projectId, false);
    container.innerHTML = `
      <div class="dashboard-error">
        <p>Erreur lors du chargement</p>
        <button class="btn-secondary" onclick="location.reload()">Reessayer</button>
      </div>
    `;
  }
}

/**
 * Get all projects for dashboard dropdown
 * @returns {Array}
 */
function getDashboardProjects() {
  return projectsState.get().projects.map((p, index) => ({
    ...p,
    index
  }));
}

module.exports = {
  getGitInfo,
  getGitInfoFull,
  getProjectStats,
  loadDashboardData,
  gitPull,
  gitPush,
  getGitStatusQuick,
  getDashboardProjects,
  renderDashboard,
  formatNumber,
  getGitOperation,
  // Cache management
  invalidateCache,
  clearAllCache
};
