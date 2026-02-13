/**
 * Dashboard Service
 * Handles dashboard data loading, rendering and operations
 */

// Use preload API instead of direct ipcRenderer
const api = window.electron_api;
const { fs, path } = window.electron_nodeModules;
const { projectsState, setGitPulling, setGitPushing, setGitMerging, setMergeInProgress, getGitOperation, getProjectTimes, getFolder, getProject, countProjectsRecursive } = require('../state');
const { escapeHtml } = require('../utils');
const { formatDuration } = require('../utils/format');
const { t } = require('../i18n');
const registry = require('../../project-types/registry');

// ========== CACHE SYSTEM ==========
const dashboardCache = new Map(); // projectId -> { data, timestamp, loading }
const CACHE_TTL = 30000; // 30 seconds cache validity
const REFRESH_DEBOUNCE = 2000; // 2 seconds minimum between refreshes
const DISK_CACHE_FILE = '.claude-terminal';

// Periodic cache cleanup to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of dashboardCache.entries()) {
    if (now - entry.timestamp > CACHE_TTL * 4) {
      dashboardCache.delete(key);
    }
  }
}, 60000);

// ========== DISK CACHE ==========

/**
 * Get disk cache file path for a project
 * @param {string} projectPath
 * @returns {string}
 */
function getDiskCachePath(projectPath) {
  return path.join(projectPath, DISK_CACHE_FILE);
}

/**
 * Read disk cache for a project (sync, fast)
 * @param {string} projectPath
 * @returns {Object|null}
 */
function readDiskCache(projectPath) {
  try {
    const filePath = getDiskCachePath(projectPath);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.dashboard) return null;
    return parsed.dashboard;
  } catch (e) {
    return null;
  }
}

/**
 * Write disk cache for a project (sync, small file = fast)
 * @param {string} projectPath
 * @param {Object} data
 */
function writeDiskCache(projectPath, data) {
  try {
    const filePath = getDiskCachePath(projectPath);
    const payload = {
      _version: 1,
      _updatedAt: new Date().toISOString(),
      dashboard: data
    };
    fs.writeFileSync(filePath, JSON.stringify(payload), 'utf-8');
  } catch (e) {
    // Silently ignore write errors (read-only dirs, etc.)
  }
}

// ========== PROJECT TYPE DETECTION ==========

const PROJECT_TYPE_MARKERS = [
  // Order matters: more specific first
  { type: 'fivem',      label: 'FiveM',      color: '#F97316', files: ['fxmanifest.lua', '__resource.lua'] },
  { type: 'next',       label: 'Next.js',    color: '#000000', deps: ['next'] },
  { type: 'nuxt',       label: 'Nuxt',       color: '#00DC82', deps: ['nuxt'] },
  { type: 'svelte',     label: 'Svelte',     color: '#FF3E00', deps: ['svelte'] },
  { type: 'angular',    label: 'Angular',    color: '#DD0031', files: ['angular.json'] },
  { type: 'react',      label: 'React',      color: '#61DAFB', deps: ['react'] },
  { type: 'vue',        label: 'Vue',        color: '#42B883', deps: ['vue'] },
  { type: 'electron',   label: 'Electron',   color: '#9FEAF9', deps: ['electron'] },
  { type: 'express',    label: 'Express',    color: '#68A063', deps: ['express'] },
  { type: 'nestjs',     label: 'NestJS',     color: '#E0234E', deps: ['@nestjs/core'] },
  { type: 'typescript', label: 'TypeScript', color: '#3178C6', files: ['tsconfig.json'] },
  { type: 'node',       label: 'Node.js',    color: '#68A063', files: ['package.json'] },
  { type: 'rust',       label: 'Rust',       color: '#DEA584', files: ['Cargo.toml'] },
  { type: 'go',         label: 'Go',         color: '#00ADD8', files: ['go.mod'] },
  { type: 'python',     label: 'Python',     color: '#3776AB', files: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'] },
  { type: 'ruby',       label: 'Ruby',       color: '#CC342D', files: ['Gemfile'] },
  { type: 'java',       label: 'Java',       color: '#ED8B00', files: ['pom.xml', 'build.gradle', 'build.gradle.kts'] },
  { type: 'csharp',     label: 'C#',         color: '#512BD4', files: ['*.sln', '*.csproj'] },
  { type: 'php',        label: 'PHP',        color: '#777BB4', files: ['composer.json'] },
  { type: 'dart',       label: 'Flutter',    color: '#02569B', files: ['pubspec.yaml'] },
  { type: 'cpp',        label: 'C/C++',      color: '#00599C', files: ['CMakeLists.txt', 'Makefile'] },
  { type: 'lua',        label: 'Lua',        color: '#000080', files: ['*.lua'] },
];

/**
 * Parse package.json dependencies (sync)
 * @param {string} projectPath
 * @returns {Set<string>}
 */
function getPackageDeps(projectPath) {
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(pkgPath)) return new Set();
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {})
    ]);
  } catch (e) {
    return new Set();
  }
}

/**
 * Check if a glob-like pattern matches any file in dir (first level only)
 * @param {string} dir
 * @param {string} pattern - filename or *.ext
 * @returns {boolean}
 */
function fileMatchExists(dir, pattern) {
  if (pattern.startsWith('*.')) {
    // Glob: check extension
    const ext = pattern.slice(1); // .lua, .sln, etc.
    try {
      const entries = fs.readdirSync(dir);
      return entries.some(e => e.endsWith(ext));
    } catch (e) {
      return false;
    }
  }
  return fs.existsSync(path.join(dir, pattern));
}

/**
 * Detect project type from marker files (sync, fast)
 * @param {string} projectPath
 * @returns {{ type: string, label: string, color: string }|null}
 */
function detectProjectType(projectPath) {
  try {
    let deps = null; // lazy-loaded

    for (const marker of PROJECT_TYPE_MARKERS) {
      // Check file markers
      if (marker.files) {
        const hasFile = marker.files.some(f => fileMatchExists(projectPath, f));
        if (hasFile) {
          // For markers with deps, need to also check deps (e.g. next needs package.json AND next dep)
          if (!marker.deps) return { type: marker.type, label: marker.label, color: marker.color };
        } else if (!marker.deps) {
          continue;
        }
      }

      // Check dependency markers
      if (marker.deps) {
        if (!deps) deps = getPackageDeps(projectPath);
        if (deps.size === 0) continue;
        const hasDep = marker.deps.some(d => deps.has(d));
        if (hasDep) return { type: marker.type, label: marker.label, color: marker.color };
      }
    }

    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Load all disk caches into memory for instant display
 * Call this at app startup before API preload
 */
function loadAllDiskCaches() {
  const projects = projectsState.get().projects;
  if (!projects || projects.length === 0) return;

  let loaded = 0;
  for (const project of projects) {
    // Skip if already in memory cache
    if (getCachedData(project.id)) continue;

    const diskData = readDiskCache(project.path);
    if (diskData) {
      // Refresh projectType from disk (fast) in case it changed
      if (!diskData.projectType) {
        diskData.projectType = detectProjectType(project.path);
      }
      // Load into memory with timestamp=0 so it gets refreshed by preload
      dashboardCache.set(project.id, {
        data: diskData,
        timestamp: 0,
        loading: false
      });
      loaded++;
    } else {
      // No disk cache - at least detect project type for minimal display
      const projectType = detectProjectType(project.path);
      if (projectType) {
        dashboardCache.set(project.id, {
          data: { projectType },
          timestamp: 0,
          loading: false
        });
        loaded++;
      }
    }
  }

  if (loaded > 0) {
    // Disk cache loaded
    window.dispatchEvent(new CustomEvent('dashboard-preload-progress'));
  }
}

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
 * Set cache data (memory + disk)
 * @param {string} projectId
 * @param {Object} data
 */
function setCacheData(projectId, data) {
  dashboardCache.set(projectId, {
    data,
    timestamp: Date.now(),
    loading: false
  });

  // Persist to disk asynchronously
  const project = projectsState.get().projects.find(p => p.id === projectId);
  if (project) {
    writeDiskCache(project.path, data);
  }
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
    return await api.git.infoFull(projectPath);
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
    return await api.git.info(projectPath);
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
    return await api.project.stats(projectPath);
  } catch (e) {
    console.error('Error getting project stats:', e);
    return { files: 0, lines: 0, byExtension: {} };
  }
}

/**
 * Get GitHub Actions workflow runs for a project
 * @param {string} remoteUrl - Git remote URL
 * @returns {Promise<Object>}
 */
async function getWorkflowRuns(remoteUrl) {
  if (!remoteUrl || !remoteUrl.includes('github.com')) {
    // Not a GitHub repo
    return { runs: [], notGitHub: true };
  }

  try {
    const result = await api.github.workflowRuns(remoteUrl);
    // Workflow runs fetched
    return result;
  } catch (e) {
    console.error('[Dashboard] Error fetching workflow runs:', e);
    return { runs: [], error: e.message };
  }
}

/**
 * Get GitHub Pull Requests for a project
 * @param {string} remoteUrl - Git remote URL
 * @returns {Promise<Object>}
 */
async function getPullRequests(remoteUrl) {
  if (!remoteUrl || !remoteUrl.includes('github.com')) {
    return { pullRequests: [], notGitHub: true };
  }

  try {
    const result = await api.github.pullRequests(remoteUrl);
    return result;
  } catch (e) {
    console.error('[Dashboard] Error fetching pull requests:', e);
    return { pullRequests: [], error: e.message };
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

  // Detect project type (sync, fast)
  const projectType = detectProjectType(projectPath);

  // Fetch workflow runs and pull requests if it's a GitHub repo
  let workflowRuns = { runs: [] };
  let pullRequests = { pullRequests: [] };
  if (gitInfo.isGitRepo && gitInfo.remoteUrl) {
    [workflowRuns, pullRequests] = await Promise.all([
      getWorkflowRuns(gitInfo.remoteUrl),
      getPullRequests(gitInfo.remoteUrl)
    ]);
  } else {
    // No git remote, skip GitHub data
  }

  return { gitInfo, stats, workflowRuns, pullRequests, projectType };
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
    const result = await api.git.pull({ projectPath: project.path });
    setGitPulling(projectId, false, result);
    // If there are merge conflicts, set the merge in progress state
    if (result.hasConflicts) {
      setMergeInProgress(projectId, true, result.conflicts);
    }
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
    const result = await api.git.push({ projectPath: project.path });
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
    return await api.git.statusQuick({ projectPath });
  } catch (e) {
    return { isGitRepo: false };
  }
}

/**
 * Abort merge for a project
 * @param {string} projectId
 * @param {Function} onComplete - Callback when complete
 * @returns {Promise<Object>}
 */
async function gitMergeAbort(projectId, onComplete) {
  const project = projectsState.get().projects.find(p => p.id === projectId);
  if (!project) return { success: false, error: 'Project not found' };

  try {
    const result = await api.git.mergeAbort({ projectPath: project.path });
    if (result.success) {
      setMergeInProgress(projectId, false, []);
    }
    if (onComplete) onComplete(result);
    return result;
  } catch (e) {
    const result = { success: false, error: e.message };
    if (onComplete) onComplete(result);
    return result;
  }
}

/**
 * Check if merge is in progress
 * @param {string} projectPath
 * @returns {Promise<boolean>}
 */
async function isMergeInProgress(projectPath) {
  try {
    return await api.git.mergeInProgress({ projectPath });
  } catch (e) {
    return false;
  }
}

/**
 * Get merge conflicts
 * @param {string} projectPath
 * @returns {Promise<Array>}
 */
async function getMergeConflicts(projectPath) {
  try {
    return await api.git.mergeConflicts({ projectPath });
  } catch (e) {
    return [];
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
    badges += `<span class="sync-badge no-remote"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg> ${t('git.noRemote')}</span>`;
    return badges;
  }

  if (aheadBehind.notTracking) {
    badges += `<span class="sync-badge not-tracking"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg> ${t('git.notTracking')}</span>`;
    return badges;
  }

  if (aheadBehind.behind > 0) {
    badges += `<span class="sync-badge pull"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8z"/></svg> ${aheadBehind.behind} ${t('git.toPull')}</span>`;
  }
  if (aheadBehind.ahead > 0) {
    badges += `<span class="sync-badge push"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 4v2h14V4H5zm0 10h4v6h6v-6h4l-7-7-7 7z"/></svg> ${aheadBehind.ahead} ${t('git.toPush')}</span>`;
  }
  if (aheadBehind.ahead === 0 && aheadBehind.behind === 0) {
    badges += `<span class="sync-badge synced"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> ${t('git.synced')}</span>`;
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
    ? `<div class="file-item more">${t('git.andMore', { count: fileList.length - 10 })}</div>`
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
      <h3><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg> ${t('git.recentCommits')}</h3>
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
      <h3><svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z"/></svg> ${t('git.changedFiles')} <span class="section-count">${totalChanges}</span></h3>
      <div class="changed-files">
        ${buildFileListHtml(files.staged, t('git.staged'), 'staged')}
        ${buildFileListHtml(files.unstaged, t('git.unstaged'), 'unstaged')}
        ${buildFileListHtml(files.untracked, t('git.untracked'), 'untracked')}
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
        <p>${t('git.notGitRepo')}</p>
      </div>
    `;
  }

  const { aheadBehind, files, branches, stashes, latestTag, recentCommits, branch } = gitInfo;

  // Stashes HTML
  let stashesHtml = '';
  if (stashes && stashes.length > 0) {
    stashesHtml = `
      <div class="dashboard-mini-section">
        <span class="mini-label"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 21h14v-2H5v2zm0-4h14v-2H5v2zm0-4h14v-2H5v2zm0-4h14V7H5v2zm0-6v2h14V3H5z"/></svg> ${stashes.length} ${t('git.stashes')}</span>
      </div>
    `;
  }

  // Tag HTML
  let tagHtml = '';
  if (latestTag) {
    tagHtml = `
      <div class="dashboard-mini-section">
        <span class="mini-label"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg> ${latestTag.name}</span>
        ${latestTag.commitsBehind > 0 ? `<span class="tag-behind">${t('dashboard.tagCommitsBehind', { count: latestTag.commitsBehind })}</span>` : ''}
      </div>
    `;
  }

  return `
    <div class="dashboard-git-header">
      <div class="git-branch">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 2a3 3 0 0 0-3 3c0 1.28.81 2.38 1.94 2.81A4 4 0 0 0 9 12H6a3 3 0 0 0 0 6 3 3 0 0 0 2.94-2.41A4 4 0 0 0 13 12v-1.17A3 3 0 0 0 15 8a3 3 0 0 0-3-3 3 3 0 0 0-2.24 1.01A4 4 0 0 0 6 2z"/></svg>
        <span class="branch-name">${branch}</span>
        <span class="branch-count">${(branches?.local?.length || 0) + (branches?.remote?.length || 0) || 1} ${t('git.branches')}</span>
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
              <div class="ext-bar" data-bar-width="${((data?.lines || 0) / maxLines * 100).toFixed(1)}%" style="width: 0"></div>
            </div>
            <span class="ext-stats">${t('dashboard.extFiles', { count: formatNumber(data?.files || 0), lines: formatNumber(data?.lines || 0) })}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  return `
    <div class="dashboard-section">
      <h3><svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/></svg> ${t('dashboard.codeStats')}</h3>
      <div class="code-stats-grid">
        <div class="code-stat">
          <div class="code-stat-value" data-count-to="${stats.lines || 0}">0</div>
          <div class="code-stat-label">${t('dashboard.linesOfCode')}</div>
        </div>
        <div class="code-stat">
          <div class="code-stat-value" data-count-to="${stats.files || 0}">0</div>
          <div class="code-stat-label">${t('dashboard.sourceFiles')}</div>
        </div>
        ${gitInfo.isGitRepo ? `
        <div class="code-stat">
          <div class="code-stat-value" data-count-to="${gitInfo.totalCommits || 0}">0</div>
          <div class="code-stat-label">${t('dashboard.totalCommits')}</div>
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
      <h3><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg> ${t('dashboard.contributors')}</h3>
      <div class="contributors-list">
        ${contributors.map(c => `
          <div class="contributor-item">
            <span class="contributor-name">${escapeHtml(c.name)}</span>
            <span class="contributor-commits">${c.commits} ${t('git.commits')}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

/**
 * Build GitHub Actions workflow runs section HTML
 * @param {Object} workflowRuns - { runs, authenticated, notGitHub, notFound }
 * @returns {string}
 */
function buildWorkflowRunsHtml(workflowRuns) {
  if (!workflowRuns || workflowRuns.notGitHub || workflowRuns.notFound) return '';
  if (!workflowRuns.authenticated) return '';
  if (!workflowRuns.runs || workflowRuns.runs.length === 0) return '';

  const getStatusIcon = (status, conclusion) => {
    if (status === 'in_progress' || status === 'queued') {
      return '<svg class="workflow-icon running" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>';
    }
    if (conclusion === 'success') {
      return '<svg class="workflow-icon success" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
    }
    if (conclusion === 'failure') {
      return '<svg class="workflow-icon failure" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
    }
    if (conclusion === 'cancelled') {
      return '<svg class="workflow-icon cancelled" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>';
    }
    // skipped, neutral, etc.
    return '<svg class="workflow-icon skipped" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
  };

  const getStatusClass = (status, conclusion) => {
    if (status === 'in_progress' || status === 'queued') return 'running';
    if (conclusion === 'success') return 'success';
    if (conclusion === 'failure') return 'failure';
    if (conclusion === 'cancelled') return 'cancelled';
    return 'skipped';
  };

  const formatTime = (dateStr) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('time.justNow') || 'just now';
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    return `${diffDays}d`;
  };

  return `
    <div class="dashboard-section workflow-runs-section">
      <h3>
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM10 17l-3.5-3.5 1.41-1.41L10 14.17l4.59-4.59L16 11l-6 6z"/></svg>
        GitHub Actions
      </h3>
      <div class="workflow-runs-list">
        ${workflowRuns.runs.map(run => `
          <div class="workflow-run-item ${getStatusClass(run.status, run.conclusion)}" data-url="${escapeHtml(run.url)}">
            <div class="workflow-run-status">
              ${getStatusIcon(run.status, run.conclusion)}
            </div>
            <div class="workflow-run-info">
              <div class="workflow-run-name">${escapeHtml(run.name)}</div>
              <div class="workflow-run-meta">
                <span class="workflow-branch">${escapeHtml(run.branch)}</span>
                <span class="workflow-commit">${run.commit}</span>
                <span class="workflow-time">${formatTime(run.createdAt)}</span>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

/**
 * Build GitHub Pull Requests section HTML
 * @param {Object} pullRequestsData - { pullRequests, authenticated, notGitHub, notFound }
 * @returns {string}
 */
function buildPullRequestsHtml(pullRequestsData) {
  if (!pullRequestsData || pullRequestsData.notGitHub || pullRequestsData.notFound) return '';
  if (!pullRequestsData.authenticated) return '';
  if (!pullRequestsData.pullRequests || pullRequestsData.pullRequests.length === 0) return '';

  const getStateIcon = (state, draft) => {
    if (draft) {
      // Draft icon (circle with dashed outline)
      return '<svg class="pr-icon draft" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/></svg>';
    }
    if (state === 'merged') {
      // Merge icon
      return '<svg class="pr-icon merged" viewBox="0 0 24 24" fill="currentColor"><path d="M7 3a3 3 0 0 0-2 5.24V15.76a3 3 0 1 0 2 0V10.7a7.03 7.03 0 0 0 5 2.23 3 3 0 1 0 0-2 5.02 5.02 0 0 1-4.39-3.17A3 3 0 0 0 7 3z"/></svg>';
    }
    if (state === 'closed') {
      // X icon
      return '<svg class="pr-icon closed" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
    }
    // Open (git-pull-request icon)
    return '<svg class="pr-icon open" viewBox="0 0 24 24" fill="currentColor"><path d="M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 7a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm0 4v6.76a3 3 0 1 0 2 0V11H6zm1 9a1 1 0 1 1 0-2 1 1 0 0 1 0 2zM18 7a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm0 4v6.76a3 3 0 1 0 2 0V11h-2zm1 9a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/></svg>';
  };

  const getStateClass = (state, draft) => {
    if (draft) return 'draft';
    return state; // open, merged, closed
  };

  const formatTime = (dateStr) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('time.justNow') || 'just now';
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    return `${diffDays}d`;
  };

  return `
    <div class="dashboard-section pull-requests-section">
      <h3>
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 7a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm0 4v6.76a3 3 0 1 0 2 0V11H6zm1 9a1 1 0 1 1 0-2 1 1 0 0 1 0 2zM18 7a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm0 4v6.76a3 3 0 1 0 2 0V11h-2zm1 9a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/></svg>
        ${t('dashboard.pullRequests')}
      </h3>
      <div class="pull-requests-list">
        ${pullRequestsData.pullRequests.map(pr => `
          <div class="pull-request-item ${getStateClass(pr.state, pr.draft)}" data-url="${escapeHtml(pr.url)}">
            <div class="pull-request-status">
              ${getStateIcon(pr.state, pr.draft)}
            </div>
            <div class="pull-request-info">
              <div class="pull-request-title">
                <span class="pr-number">#${pr.number}</span>
                ${escapeHtml(pr.title)}
              </div>
              <div class="pull-request-meta">
                <span class="pr-author">${escapeHtml(pr.author)}</span>
                ${pr.labels.length > 0 ? `<span class="pr-labels">${pr.labels.map(l => `<span class="pr-label" style="background: #${l.color}20; color: #${l.color}; border-color: #${l.color}40">${escapeHtml(l.name)}</span>`).join('')}</span>` : ''}
                <span class="pr-time">${formatTime(pr.updatedAt)}</span>
              </div>
            </div>
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
 * @param {Object} data - { gitInfo, stats, workflowRuns, pullRequests }
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
    onMergeAbort,
    onCopyPath
  } = options;

  const { gitInfo, stats, workflowRuns, pullRequests } = data;
  const typeHandler = registry.get(project.type);
  const dashboardBadge = typeHandler.getDashboardBadge(project);
  const gitOps = getGitOperation(project.id);
  const hasMergeConflict = gitOps.mergeInProgress && gitOps.conflicts.length > 0;
  const projectTimes = getProjectTimes(project.id);

  // Build HTML
  container.innerHTML = `
    ${isRefreshing ? `<div class="dashboard-refresh-indicator"><span class="refresh-spinner"></span> ${t('dashboard.refreshing')}</div>` : ''}
    ${hasMergeConflict ? `
    <div class="dashboard-merge-alert">
      <div class="merge-alert-header">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
        <strong>${t('git.mergeConflict')}</strong> - ${t('git.filesInConflict', { count: gitOps.conflicts.length })}
      </div>
      <div class="merge-alert-files">
        ${gitOps.conflicts.slice(0, 5).map(f => `<code>${escapeHtml(f)}</code>`).join('')}
        ${gitOps.conflicts.length > 5 ? `<span class="more-files">${t('git.andMore', { count: gitOps.conflicts.length - 5 })}</span>` : ''}
      </div>
      <div class="merge-alert-hint">${t('git.resolveConflicts')}</div>
    </div>
    ` : ''}
    <div class="dashboard-project-header" data-animate="0">
      <div class="dashboard-project-title">
        <h2>${escapeHtml(project.name)}</h2>
        <span class="dashboard-project-type ${dashboardBadge ? dashboardBadge.cssClass : ''}">${dashboardBadge ? dashboardBadge.text : t('dashboard.standalone')}</span>
      </div>
      <div class="dashboard-project-actions">
        <button class="btn-secondary" id="dash-btn-open-folder">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7l2 2h5v12zm0-12h-5l-2-2H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2z"/></svg>
          ${t('dashboard.openFolder')}
        </button>
        ${gitInfo.isGitRepo && gitInfo.aheadBehind?.hasRemote ? `
        <button class="btn-secondary" id="dash-btn-git-pull" ${!gitInfo.aheadBehind?.notTracking && gitInfo.aheadBehind?.behind === 0 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8z"/></svg>
          ${t('dashboard.pull')}
        </button>
        <button class="btn-secondary" id="dash-btn-git-push" ${!gitInfo.aheadBehind?.notTracking && gitInfo.aheadBehind?.ahead === 0 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 4v2h14V4H5zm0 10h4v6h6v-6h4l-7-7-7 7z"/></svg>
          ${t('dashboard.push')}
        </button>
        ${hasMergeConflict ? `
        <button class="btn-danger" id="dash-btn-merge-abort">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          ${t('dashboard.abortMerge')}
        </button>
        ` : ''}
        ` : ''}
        <button class="btn-primary" id="dash-btn-claude">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.89 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
          ${t('dashboard.openClaude')}
        </button>
      </div>
    </div>

    <div class="dashboard-quick-stats" data-animate="1">
      <div class="quick-stat">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.89 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
        <span>${terminalCount} ${t('dashboard.terminals')}</span>
      </div>
      <div class="quick-stat time-stat">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
        <span class="time-today">${formatDuration(projectTimes.today)}</span>
        <span class="time-sep">/</span>
        <span class="time-total">${formatDuration(projectTimes.total)}</span>
      </div>
      ${typeHandler.getDashboardStats({ fivemStatus, projectIndex: projectsState.get().projects.findIndex(p => p.id === project.id), project, t })}
      ${gitInfo.isGitRepo && gitInfo.remoteUrl ? `
      <div class="quick-stat">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
        <span class="remote-url">${gitInfo.remoteUrl.replace(/^https?:\/\//, '').replace(/\.git$/, '').substring(0, 40)}</span>
      </div>
      ` : ''}
    </div>

    <div class="dashboard-path-bar" data-animate="2">
      <code>${escapeHtml(project.path)}</code>
      <button class="btn-icon-small btn-copy-path" title="${t('dashboard.copyPath')}">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
      </button>
    </div>

    <div class="dashboard-grid" data-animate="3">
      <div class="dashboard-col">
        ${buildGitStatusHtml(gitInfo)}
        ${buildWorkflowRunsHtml(workflowRuns)}
        ${buildPullRequestsHtml(pullRequests)}
      </div>
      <div class="dashboard-col">
        ${buildStatsHtml(stats, gitInfo)}
        ${gitInfo.isGitRepo ? buildContributorsHtml(gitInfo.contributors) : ''}
      </div>
    </div>
  `;

  // Attach click handlers for workflow runs
  container.querySelectorAll('.workflow-run-item').forEach(item => {
    item.addEventListener('click', () => {
      const url = item.dataset.url;
      if (url) {
        api.dialog.openExternal(url);
      }
    });
    item.style.cursor = 'pointer';
  });

  // Attach click handlers for pull requests
  container.querySelectorAll('.pull-request-item').forEach(item => {
    item.addEventListener('click', () => {
      const url = item.dataset.url;
      if (url) {
        api.dialog.openExternal(url);
      }
    });
    item.style.cursor = 'pointer';
  });

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
    btn.innerHTML = `<span class="btn-spinner"></span> ${t('git.pulling')}`;
    if (onGitPull) await onGitPull(project.id);
    // Invalidate cache and re-render
    invalidateCache(project.id);
    renderDashboard(container, project, options);
  });

  container.querySelector('#dash-btn-git-push')?.addEventListener('click', async () => {
    const btn = container.querySelector('#dash-btn-git-push');
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner"></span> ${t('git.pushing')}`;
    if (onGitPush) await onGitPush(project.id);
    // Invalidate cache and re-render
    invalidateCache(project.id);
    renderDashboard(container, project, options);
  });

  container.querySelector('#dash-btn-merge-abort')?.addEventListener('click', async () => {
    const btn = container.querySelector('#dash-btn-merge-abort');
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner"></span> ${t('git.aborting')}`;
    if (onMergeAbort) await onMergeAbort(project.id);
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
 * Animate a counter element from 0 to target value
 * @param {HTMLElement} el - Element to animate
 * @param {number} target - Target number
 * @param {number} duration - Animation duration in ms
 */
function animateCounter(el, target, duration = 600) {
  if (!el || target === 0) {
    if (el) el.textContent = '0';
    return;
  }

  const start = performance.now();

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function tick(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const easedProgress = easeOutCubic(progress);
    const current = Math.round(easedProgress * target);
    el.textContent = current.toLocaleString('fr-FR');

    if (progress < 1) {
      requestAnimationFrame(tick);
    }
  }

  requestAnimationFrame(tick);
}

/**
 * Animate dashboard sections, counters and bars into view
 * @param {HTMLElement} container - Dashboard container
 */
function animateDashboardIn(container) {
  // Stagger sections with data-animate
  const sections = container.querySelectorAll('[data-animate]');
  sections.forEach(section => {
    const index = parseInt(section.dataset.animate, 10);
    section.style.opacity = '0';
    section.style.transform = 'translateY(8px)';
    section.style.transition = 'opacity 250ms ease, transform 250ms ease';

    setTimeout(() => {
      section.style.opacity = '1';
      section.style.transform = 'translateY(0)';
    }, 50 + index * 60);
  });

  // Animate counters
  const counters = container.querySelectorAll('[data-count-to]');
  counters.forEach(el => {
    const target = parseInt(el.dataset.countTo, 10) || 0;
    animateCounter(el, target, 600);
  });

  // Animate extension bars after a delay
  const bars = container.querySelectorAll('[data-bar-width]');
  setTimeout(() => {
    bars.forEach(bar => {
      bar.style.transition = 'width 500ms cubic-bezier(0.22, 1, 0.36, 1)';
      bar.style.width = bar.dataset.barWidth;
    });
  }, 300);
}

/**
 * Transition between old and new dashboard content with cross-fade
 * @param {HTMLElement} container - Dashboard container
 * @param {Object} project - Project data
 * @param {Object} data - Dashboard data
 * @param {Object} options - Render options
 * @param {boolean} isRefreshing - Show refresh indicator
 */
function transitionDashboard(container, project, data, options, isRefreshing = false) {
  const hasExistingContent = container.querySelector('.dashboard-project-header');

  if (!hasExistingContent) {
    // No existing content - render directly with entrance animations
    renderDashboardHtml(container, project, data, options, isRefreshing);
    animateDashboardIn(container);
    return;
  }

  // Cross-fade: wrap old content, create new content, fade
  const wrapper = document.createElement('div');
  wrapper.className = 'dashboard-transition-wrapper';
  wrapper.style.position = 'relative';

  // Capture old content
  const outgoing = document.createElement('div');
  outgoing.className = 'dashboard-outgoing';
  outgoing.innerHTML = container.innerHTML;
  wrapper.appendChild(outgoing);

  // Create incoming content (hidden)
  const incoming = document.createElement('div');
  incoming.className = 'dashboard-incoming';
  wrapper.appendChild(incoming);

  // Replace container with wrapper
  container.innerHTML = '';
  container.appendChild(wrapper);

  // Render new content into incoming (just for visual)
  renderDashboardHtml(incoming, project, data, options, isRefreshing);

  // Trigger cross-fade
  requestAnimationFrame(() => {
    outgoing.classList.add('fade-out');
    incoming.classList.add('fade-in');
  });

  // After fade completes, replace with final rendered content (with event listeners)
  setTimeout(() => {
    container.innerHTML = '';
    renderDashboardHtml(container, project, data, options, isRefreshing);
    animateDashboardIn(container);
  }, 220);
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
    // Use cross-fade transition when switching projects (existing content visible)
    transitionDashboard(container, project, cachedData, options, !cacheValid && !alreadyRefreshing);

    // If cache is still valid or already refreshing, we're done
    if (cacheValid || alreadyRefreshing) {
      return;
    }

    // Start background refresh
    setCacheLoading(projectId, true);

    try {
      const newData = await loadDashboardData(project.path);
      setCacheData(projectId, newData);

      // Only update UI if this project is still displayed — discrete refresh, no animation
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
      <p>${t('dashboard.loadingInfo')}</p>
    </div>
  `;

  setCacheLoading(projectId, true);

  try {
    const data = await loadDashboardData(project.path);
    setCacheData(projectId, data);
    renderDashboardHtml(container, project, data, options, false);
    animateDashboardIn(container);
  } catch (e) {
    console.error('Error loading dashboard:', e);
    setCacheLoading(projectId, false);
    container.innerHTML = `
      <div class="dashboard-error">
        <p>${t('dashboard.loadError')}</p>
        <button class="btn-secondary" onclick="location.reload()">${t('dashboard.retry')}</button>
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

/**
 * Preload dashboard data for all projects in background
 * This should be called at app startup to warm up the cache
 */
async function preloadAllProjects() {
  const projects = projectsState.get().projects;
  if (!projects || projects.length === 0) return;

  // Preloading projects silently

  const PROJECT_TIMEOUT = 20000; // 20s max per project

  function withTimeout(promise, ms, name) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms for ${name}`)), ms))
    ]);
  }

  // Load projects in parallel batches
  const BATCH_SIZE = 4;
  for (let i = 0; i < projects.length; i += BATCH_SIZE) {
    const batch = projects.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (project) => {
      // Skip if already cached
      if (isCacheValid(project.id)) return;

      try {
        setCacheLoading(project.id, true);
        const data = await withTimeout(
          loadDashboardData(project.path),
          PROJECT_TIMEOUT,
          project.name
        );
        setCacheData(project.id, data);
        // Preloaded
      } catch (e) {
        console.error(`[Dashboard] Failed to preload ${project.name}:`, e.message);
        // Store minimal data (project type) so it's not stuck as "no data"
        const projectType = detectProjectType(project.path);
        if (projectType) {
          setCacheData(project.id, { projectType, gitInfo: {}, stats: {}, workflowRuns: { runs: [] }, pullRequests: { pullRequests: [] } });
        }
        setCacheLoading(project.id, false);
      }
    }));

    // Notify after each batch so overview can refresh progressively
    window.dispatchEvent(new CustomEvent('dashboard-preload-progress'));
  }

  // Preload complete
}

/**
 * Build overview HTML grid for all projects
 * @param {Array} projects - All projects
 * @param {Object} options - { dataMap, timesMap }
 * @returns {string}
 */
function buildOverviewCardHtml(project, dataMap, timesMap) {
  const data = dataMap[project.id];
  const times = timesMap[project.id] || { today: 0 };
  const hasData = !!data;

  const gitInfo = data?.gitInfo || {};
  const branch = gitInfo.branch || '';
  const aheadBehind = gitInfo.aheadBehind || {};
  const files = gitInfo.files || {};
  const workflowRuns = data?.workflowRuns || {};
  const pullRequests = data?.pullRequests || {};
  const projectType = data?.projectType || null;

  const stagedCount = files?.staged?.length || 0;
  const unstagedCount = files?.unstaged?.length || 0;
  const untrackedCount = files?.untracked?.length || 0;
  const totalChanges = stagedCount + unstagedCount + untrackedCount;

  const latestRun = workflowRuns?.runs?.[0];
  let ciHtml = '';
  if (latestRun) {
    let ciClass = 'skipped';
    let ciSymbol = '?';
    if (latestRun.status === 'in_progress' || latestRun.status === 'queued') {
      ciClass = 'running';
      ciSymbol = '⟳';
    } else if (latestRun.conclusion === 'success') {
      ciClass = 'success';
      ciSymbol = '✓';
    } else if (latestRun.conclusion === 'failure') {
      ciClass = 'failure';
      ciSymbol = '✗';
    }
    ciHtml = `<span class="overview-ci ${ciClass}" title="CI: ${latestRun.conclusion || latestRun.status}">${ciSymbol}</span>`;
  }

  let typeBadgeHtml = '';
  if (projectType) {
    typeBadgeHtml = `<span class="overview-type-badge" style="--type-color: ${projectType.color}">${escapeHtml(projectType.label)}</span>`;
  }

  const openPrs = (pullRequests?.pullRequests || []).filter(pr => pr.state === 'open').length;
  const lastCommit = gitInfo.recentCommits?.[0] || null;

  let syncHtml = '';
  if (aheadBehind.hasRemote && !aheadBehind.notTracking) {
    const parts = [];
    if (aheadBehind.behind > 0) parts.push(`↓${aheadBehind.behind}`);
    if (aheadBehind.ahead > 0) parts.push(`↑${aheadBehind.ahead}`);
    if (parts.length > 0) {
      syncHtml = `<span class="overview-sync">${parts.join(' ')}</span>`;
    }
  }

  let statsHtml = '';
  if (!hasData && !projectType) {
    statsHtml = `<div class="overview-stat overview-no-data"><span>${t('dashboard.noData')}</span></div>`;
  } else {
    if (branch) {
      statsHtml += `<div class="overview-stat">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 2a3 3 0 0 0-3 3c0 1.28.81 2.38 1.94 2.81A4 4 0 0 0 9 12H6a3 3 0 0 0 0 6 3 3 0 0 0 2.94-2.41A4 4 0 0 0 13 12v-1.17A3 3 0 0 0 15 8a3 3 0 0 0-3-3 3 3 0 0 0-2.24 1.01A4 4 0 0 0 6 2z"/></svg>
        <span>${escapeHtml(branch)}</span>
        ${syncHtml}
      </div>`;
    }

    if (lastCommit) {
      const commitMsg = (lastCommit.message || '').length > 40
        ? lastCommit.message.substring(0, 40) + '...'
        : (lastCommit.message || '');
      statsHtml += `<div class="overview-stat overview-commit">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg>
        <span class="overview-commit-hash">${lastCommit.hash || ''}</span>
        <span class="overview-commit-msg">${escapeHtml(commitMsg)}</span>
        ${lastCommit.date ? `<span class="overview-commit-date">${lastCommit.date}</span>` : ''}
      </div>`;
    }

    if (openPrs > 0) {
      statsHtml += `<div class="overview-stat">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 7a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm0 4v6.76a3 3 0 1 0 2 0V11H6zm1 9a1 1 0 1 1 0-2 1 1 0 0 1 0 2zM18 7a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm0 4v6.76a3 3 0 1 0 2 0V11h-2zm1 9a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/></svg>
        <span>${t('dashboard.openPrs', { count: openPrs })}</span>
      </div>`;
    }

    if (totalChanges > 0) {
      statsHtml += `<div class="overview-stat">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z"/></svg>
        <span>${t('dashboard.filesChanged', { count: totalChanges })}</span>
      </div>`;
    }

    if (times.today > 0) {
      statsHtml += `<div class="overview-stat">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
        <span>${formatDuration(times.today)} ${t('dashboard.todayTime')}</span>
      </div>`;
    }

    if (!statsHtml && projectType) {
      statsHtml = `<div class="overview-stat overview-no-data"><span>${t('dashboard.noData')}</span></div>`;
    }
  }

  const projectIndex = projectsState.get().projects.findIndex(p => p.id === project.id);
  return `
    <div class="overview-card ${!hasData && !projectType ? 'loading' : ''}" data-project-index="${projectIndex}">
      <div class="overview-card-header">
        <span class="overview-project-name">${escapeHtml(project.name)}</span>
        <div class="overview-header-badges">
          ${typeBadgeHtml}
          ${ciHtml}
        </div>
      </div>
      <div class="overview-card-stats">
        ${statsHtml}
      </div>
    </div>
  `;
}

function buildOverviewHtml(projects, options = {}) {
  const { dataMap = {}, timesMap = {} } = options;

  if (projects.length === 0) {
    return `<div class="dashboard-empty">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>
      <p>${t('projects.noProjects')}</p>
    </div>`;
  }

  const state = projectsState.get();
  const { folders, rootOrder } = state;

  // If no rootOrder (legacy), fall back to flat grid
  if (!rootOrder || rootOrder.length === 0) {
    const cardsHtml = projects.map(p => buildOverviewCardHtml(p, dataMap, timesMap)).join('');
    return `<div class="overview-grid">${cardsHtml}</div>`;
  }

  function renderFolderSection(folder) {
    const projectCount = countProjectsRecursive(folder.id);
    if (projectCount === 0) return '';

    const colorStyle = folder.color ? `style="color: ${folder.color}"` : '';
    const folderIcon = folder.icon
      ? `<span class="overview-section-emoji">${folder.icon}</span>`
      : `<svg viewBox="0 0 24 24" fill="currentColor" ${colorStyle}><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>`;

    let contentHtml = '';
    let pendingCards = '';
    const children = folder.children || [];
    for (const childId of children) {
      const childFolder = folders.find(f => f.id === childId);
      if (childFolder) {
        if (pendingCards) {
          contentHtml += `<div class="overview-grid">${pendingCards}</div>`;
          pendingCards = '';
        }
        contentHtml += renderFolderSection(childFolder);
      } else {
        const childProject = projects.find(p => p.id === childId);
        if (childProject && childProject.folderId === folder.id) {
          pendingCards += buildOverviewCardHtml(childProject, dataMap, timesMap);
        }
      }
    }
    if (pendingCards) {
      contentHtml += `<div class="overview-grid">${pendingCards}</div>`;
    }

    return `
      <div class="overview-section">
        <div class="overview-section-header">
          <span class="overview-section-icon">${folderIcon}</span>
          <span class="overview-section-name" ${colorStyle}>${escapeHtml(folder.name)}</span>
          <span class="overview-section-count">${projectCount}</span>
        </div>
        ${contentHtml}
      </div>
    `;
  }

  let html = '';
  let rootCardsHtml = '';

  for (const itemId of rootOrder) {
    const folder = folders.find(f => f.id === itemId);
    if (folder) {
      // Flush any pending root cards before the folder section
      if (rootCardsHtml) {
        html += `<div class="overview-grid">${rootCardsHtml}</div>`;
        rootCardsHtml = '';
      }
      html += renderFolderSection(folder);
    } else {
      const project = projects.find(p => p.id === itemId);
      if (project) {
        rootCardsHtml += buildOverviewCardHtml(project, dataMap, timesMap);
      }
    }
  }

  // Flush remaining root cards
  if (rootCardsHtml) {
    html += `<div class="overview-grid">${rootCardsHtml}</div>`;
  }

  return `<div class="overview-container">${html}</div>`;
}

/**
 * Render overview dashboard for all projects
 * @param {HTMLElement} container - Container element
 * @param {Array} projects - All projects
 * @param {Object} options - { dataMap, timesMap, onCardClick }
 */
function renderOverview(container, projects, options = {}) {
  const { onCardClick } = options;

  container.innerHTML = buildOverviewHtml(projects, options);

  // Attach click handlers
  container.querySelectorAll('.overview-card').forEach(card => {
    card.addEventListener('click', () => {
      const index = parseInt(card.dataset.projectIndex);
      if (onCardClick) onCardClick(index);
    });
  });

  // Animate cards in
  const cards = container.querySelectorAll('.overview-card');
  cards.forEach((card, i) => {
    card.style.opacity = '0';
    card.style.transform = 'translateY(8px)';
    card.style.transition = 'opacity 200ms ease, transform 200ms ease';
    setTimeout(() => {
      card.style.opacity = '1';
      card.style.transform = 'translateY(0)';
    }, 30 + i * 40);
  });
}

module.exports = {
  getGitInfo,
  getGitInfoFull,
  getProjectStats,
  loadDashboardData,
  gitPull,
  gitPush,
  gitMergeAbort,
  isMergeInProgress,
  getMergeConflicts,
  getGitStatusQuick,
  getDashboardProjects,
  renderDashboard,
  renderOverview,
  formatNumber,
  getGitOperation,
  // Cache management
  getCachedData,
  invalidateCache,
  clearAllCache,
  loadAllDiskCaches,
  preloadAllProjects
};
