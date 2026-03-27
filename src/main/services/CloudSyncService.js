/**
 * CloudSyncService
 * Orchestrates bidirectional cloud sync:
 * - Local→Cloud: auto-upload incremental changes via FileWatcherService
 * - Cloud→Local: background polling for pending changes from headless sessions
 * Runs entirely in main process, independent of renderer tab state.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { settingsFile, projectsFile } = require('../utils/paths');
const { hashFiles } = require('../utils/fileHash');
const fileWatcherService = require('./FileWatcherService');

const POLL_INTERVAL_MS = 30000;
const FETCH_TIMEOUT_MS = 10000;
const SYNC_META_FILE = path.join(os.homedir(), '.claude-terminal', 'cloud-sync-meta.json');

let _mainWindow = null;
let _pollTimer = null;
let _isPolling = false;

/** @type {Map<string, { lastSyncTimestamp: number, projectPath: string }>} */
let _syncMeta = new Map();

/** @type {Map<string, { message: string, timestamp: number }>} */
let _lastErrors = new Map();

/** @type {Set<string>} Locks to prevent concurrent incremental uploads */
const _uploadLocks = new Set();

// ── Public API ──

function setMainWindow(win) {
  _mainWindow = win;
}

/**
 * Start background sync (called when cloud connects).
 */
function start() {
  _loadSyncMetadata();
  _startPolling();
  _startWatchingAllSyncedProjects();

  fileWatcherService.onChanges((projectId, changes) => {
    _handleLocalChanges(projectId, changes);
  });

  console.log('[CloudSync] Started');
}

/**
 * Stop all sync activities (called when cloud disconnects or app quits).
 */
function stop() {
  _stopPolling();
  fileWatcherService.offChanges();
  fileWatcherService.unwatchAll();
  _saveSyncMetadata();
  console.log('[CloudSync] Stopped');
}

/**
 * Register a project for auto-sync after initial upload.
 * @param {string} projectId
 * @param {string} projectPath
 */
function registerProject(projectId, projectPath) {
  _syncMeta.set(projectId, { lastSyncTimestamp: Date.now(), projectPath });
  _saveSyncMetadata();
  fileWatcherService.watch(projectId, projectPath).catch(err => {
    console.error(`[CloudSync] Failed to start watcher for ${projectId}:`, err.message);
  });
  console.log(`[CloudSync] Registered project: ${projectId}`);
}

/**
 * Unregister a project from auto-sync.
 * @param {string} projectId
 */
function unregisterProject(projectId) {
  _syncMeta.delete(projectId);
  _saveSyncMetadata();
  fileWatcherService.unwatch(projectId);
}

/**
 * Check if a project is registered for auto-sync.
 * @param {string} projectId
 * @returns {boolean}
 */
function isRegistered(projectId) {
  return _syncMeta.has(projectId);
}

/**
 * Get last sync timestamp for a project.
 * @param {string} projectId
 * @returns {number|null}
 */
function getLastSyncTimestamp(projectId) {
  return _syncMeta.get(projectId)?.lastSyncTimestamp || null;
}

/**
 * Update the last sync timestamp (after a successful download).
 * @param {string} projectId
 */
function updateSyncTimestamp(projectId) {
  const meta = _syncMeta.get(projectId);
  if (meta) {
    meta.lastSyncTimestamp = Date.now();
    _saveSyncMetadata();
  }
  // Clear error on successful sync
  _lastErrors.delete(projectId);
}

/**
 * Get full sync status for a project.
 * @param {string} projectId
 * @returns {{ registered: boolean, lastSync: number|null, watching: boolean, lastError: { message: string, timestamp: number }|null }}
 */
function getSyncStatus(projectId) {
  const meta = _syncMeta.get(projectId);
  return {
    registered: !!meta,
    lastSync: meta?.lastSyncTimestamp || null,
    watching: fileWatcherService.isWatching(projectId),
    lastError: _lastErrors.get(projectId) || null,
  };
}

/**
 * Get sync statuses for all registered projects.
 * @returns {Object<string, { registered: boolean, lastSync: number|null, watching: boolean, lastError: object|null }>}
 */
function getAllSyncStatuses() {
  const result = {};
  for (const [projectId] of _syncMeta) {
    result[projectId] = getSyncStatus(projectId);
  }
  return result;
}

// ── Background polling (Cloud→Local) ──

function _startPolling() {
  _stopPolling();
  _pollTimer = setInterval(() => _pollForChanges(), POLL_INTERVAL_MS);
  // Immediate first check
  _pollForChanges();
}

function _stopPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

function _findLocalProjectPath(cloudProjectName) {
  try {
    const data = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
    const projects = data.projects || [];
    const match = projects.find(p =>
      p.name === cloudProjectName || path.basename(p.path) === cloudProjectName
    );
    return match?.path || null;
  } catch { return null; }
}

async function _hashFilterPendingChanges(allChanges, url, key) {
  const headers = { 'Authorization': `Bearer ${key}` };
  const filtered = [];

  for (const entry of allChanges) {
    const { projectName, changes } = entry;
    const localPath = _findLocalProjectPath(projectName);
    if (!localPath) { filtered.push(entry); continue; }

    const allFiles = changes.flatMap(c => c.changedFiles || []);
    if (allFiles.length === 0) continue;

    try {
      const hashResp = await _fetchCloud(
        `${url}/api/projects/${encodeURIComponent(projectName)}/files/hashes`,
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePaths: allFiles }),
        }
      );
      if (!hashResp.ok) { filtered.push(entry); continue; }
      const { hashes: cloudHashes } = await hashResp.json();
      const cloudHashMap = new Map(cloudHashes.map(h => [h.path, h.hash]));
      const localHashes = await hashFiles(localPath, allFiles);

      const diffFiles = allFiles.filter(fp => {
        const localH = localHashes.get(fp);
        const cloudH = cloudHashMap.get(fp);
        return !localH || !cloudH || localH !== cloudH;
      });

      if (diffFiles.length === 0) {
        await _fetchCloud(
          `${url}/api/projects/${encodeURIComponent(projectName)}/changes/ack`,
          { method: 'POST', headers }
        ).catch(() => {});
      } else {
        const filteredChanges = changes.map(c => ({
          ...c,
          changedFiles: (c.changedFiles || []).filter(f => diffFiles.includes(f)),
        })).filter(c => c.changedFiles.length > 0);
        if (filteredChanges.length > 0) {
          filtered.push({ projectName, changes: filteredChanges });
        }
      }
    } catch {
      filtered.push(entry);
    }
  }

  return filtered;
}

async function _pollForChanges() {
  if (_isPolling) return;
  _isPolling = true;

  try {
    const { url, key } = _getCloudConfig();
    if (!url || !key) return;
    const headers = { 'Authorization': `Bearer ${key}` };

    const projectsResp = await _fetchCloud(`${url}/api/projects`, { headers });
    if (!projectsResp.ok) return;
    const { projects } = await projectsResp.json();

    // Build set of local project IDs for matching — only notify for known projects
    const localProjectIds = new Set();
    try {
      const data = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
      (data.projects || []).forEach(p => localProjectIds.add(p.id));
    } catch {}

    const allChanges = [];
    for (const project of projects) {
      if (!localProjectIds.has(project.name)) continue;
      try {
        const changesResp = await _fetchCloud(
          `${url}/api/projects/${encodeURIComponent(project.name)}/changes`,
          { headers }
        );
        if (!changesResp.ok) continue;
        const { changes } = await changesResp.json();
        if (changes && changes.length > 0) {
          allChanges.push({ projectName: project.name, displayName: project.displayName || project.name, changes });
        }
      } catch {
        // Skip this project on error
      }
    }

    // Hash-filter: auto-dismiss changes where local files already match cloud
    const filtered = await _hashFilterPendingChanges(allChanges, url, key);
    if (filtered.length > 0 && _mainWindow && !_mainWindow.isDestroyed()) {
      _mainWindow.webContents.send('cloud:pending-changes', { changes: filtered });
    }
  } catch (err) {
    console.warn('[CloudSync] Poll error:', err.message);
  } finally {
    _isPolling = false;
  }
}

// ── Local→Cloud incremental upload ──

async function _handleLocalChanges(projectId, changes) {
  if (_uploadLocks.has(projectId)) {
    console.log(`[CloudSync] Skipping incremental upload for ${projectId}: upload already in progress`);
    return;
  }
  _uploadLocks.add(projectId);
  let zipPath = null;

  try {
    const { url, key } = _getCloudConfig();
    const project = _getProjectById(projectId);
    if (!project || !url || !key) return;

    const projectName = project.name || path.basename(project.path);

    // Notify renderer
    _sendToRenderer('cloud:auto-sync-status', {
      projectId,
      status: 'uploading',
      fileCount: changes.size,
    });

    // Build incremental zip
    const archiver = require('archiver');
    zipPath = path.join(os.tmpdir(), `ct-incremental-${Date.now()}.zip`);

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);

      for (const [relativePath, type] of changes) {
        if (type === 'unlink') {
          // .DELETED marker (empty file) — matches download flow convention
          archive.append('', { name: relativePath + '.DELETED' });
        } else {
          const absPath = path.join(project.path, relativePath);
          if (fs.existsSync(absPath)) {
            archive.file(absPath, { name: relativePath.replace(/\\/g, '/') });
          }
        }
      }

      archive.finalize();
    });

    // Upload incremental zip
    const FormData = require('form-data');
    const formData = new FormData();
    formData.append('zip', fs.createReadStream(zipPath), {
      filename: `${projectName}-incremental.zip`,
      contentType: 'application/zip',
    });

    const http = url.startsWith('https') ? require('https') : require('http');
    const urlObj = new URL(`${url}/api/projects/${encodeURIComponent(projectName)}/sync`);

    await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: 'PATCH',
        headers: {
          ...formData.getHeaders(),
          'Authorization': `Bearer ${key}`,
        },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body ? JSON.parse(body) : {});
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      formData.pipe(req);
    });

    // Update sync timestamp + clear error
    const meta = _syncMeta.get(projectId);
    if (meta) { meta.lastSyncTimestamp = Date.now(); _saveSyncMetadata(); }
    _lastErrors.delete(projectId);

    _sendToRenderer('cloud:auto-sync-status', {
      projectId,
      status: 'synced',
      fileCount: changes.size,
    });

    console.log(`[CloudSync] Incremental upload: ${changes.size} files for ${projectName}`);
  } catch (err) {
    console.error(`[CloudSync] Incremental upload failed for ${projectId}:`, err.message);
    _lastErrors.set(projectId, { message: err.message, timestamp: Date.now() });
    _sendToRenderer('cloud:auto-sync-status', {
      projectId,
      status: 'error',
      error: err.message,
    });
  } finally {
    _uploadLocks.delete(projectId);
    // Cleanup zip in finally to avoid orphaned tmp files on error
    if (zipPath) await fs.promises.unlink(zipPath).catch(() => {});
  }
}

// ── Helpers ──

async function _fetchCloud(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function _sendToRenderer(channel, data) {
  if (_mainWindow && !_mainWindow.isDestroyed()) {
    _mainWindow.webContents.send(channel, data);
  }
}

function _getCloudConfig() {
  try {
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      const url = settings.cloudServerUrl?.replace(/\/$/, '');
      const key = settings.cloudApiKey;
      return { url, key };
    }
  } catch {}
  return {};
}

function _getProjectById(projectId) {
  try {
    if (fs.existsSync(projectsFile)) {
      const data = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
      return (data.projects || []).find(p => p.id === projectId);
    }
  } catch {}
  return null;
}

function _startWatchingAllSyncedProjects() {
  try {
    if (!fs.existsSync(projectsFile)) return;
    const data = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
    const projects = data.projects || [];
    const toRemove = [];

    for (const [projectId, meta] of _syncMeta) {
      const project = projects.find(p => p.id === projectId);
      if (project && project.path && fs.existsSync(project.path)) {
        fileWatcherService.watch(projectId, project.path).catch(err => {
          console.error(`[CloudSync] Failed to start watcher for ${projectId}:`, err.message);
        });
      } else {
        toRemove.push(projectId);
      }
    }

    // Clean up stale entries and stop their watchers
    for (const id of toRemove) {
      _syncMeta.delete(id);
      fileWatcherService.unwatch(id);
    }
    if (toRemove.length > 0) _saveSyncMetadata();
  } catch (err) {
    console.warn('[CloudSync] Error starting watchers:', err.message);
  }
}

function _loadSyncMetadata() {
  try {
    if (fs.existsSync(SYNC_META_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SYNC_META_FILE, 'utf8'));
      _syncMeta = new Map(Object.entries(raw));
    }
  } catch {
    _syncMeta = new Map();
  }
}

function _saveSyncMetadata() {
  try {
    const data = Object.fromEntries(_syncMeta);
    const dir = path.dirname(SYNC_META_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpFile = SYNC_META_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    fs.renameSync(tmpFile, SYNC_META_FILE);
  } catch (err) {
    console.warn('[CloudSync] Failed to save sync metadata:', err.message);
  }
}

module.exports = {
  setMainWindow,
  start,
  stop,
  registerProject,
  unregisterProject,
  isRegistered,
  getLastSyncTimestamp,
  updateSyncTimestamp,
  getSyncStatus,
  getAllSyncStatuses,
};
