/**
 * SyncEngine
 * Entity-based bidirectional sync between local app state and cloud relay.
 *
 * Entities: settings, projects, timeTracking, conversations, skills, agents, mcpConfigs
 * Strategy: last-write-wins per entity, with user prompt on true conflicts.
 *
 * Conflict = both local and cloud changed since last sync.
 * Auto-resolve: time tracking (additive merge), conversations (append-only).
 * Manual resolve: settings keys, project config.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { settingsFile, projectsFile } = require('../utils/paths');
const { getMachineId } = require('../utils/machineId');

const DATA_DIR = path.join(os.homedir(), '.claude-terminal');
const MANIFEST_FILE = path.join(DATA_DIR, 'sync-manifest.json');
const TIMETRACKING_FILE = path.join(DATA_DIR, 'timetracking.json');

const SYNC_DEBOUNCE_MS = 2000;
const CONVERSATION_SYNC_DEBOUNCE_MS = 30000;

// ── Entity definitions ──

const ENTITY_TYPES = {
  settings: {
    granularity: 'per-key',
    localPath: () => settingsFile,
    excludeKeys: ['cloudServerUrl', 'cloudApiKey', 'cloudAutoConnect', 'machineId'],
    autoResolve: false,
  },
  projects: {
    granularity: 'per-item',
    localPath: () => projectsFile,
    idField: 'id',
    autoResolve: false,
  },
  timeTracking: {
    granularity: 'additive',
    localPath: () => TIMETRACKING_FILE,
    autoResolve: true,
  },
  conversations: {
    granularity: 'append-only',
    localPath: () => path.join(os.homedir(), '.claude'),
    autoResolve: true,
  },
};

// ── Manifest (tracks sync state per entity) ──

/**
 * Manifest shape:
 * {
 *   lastFullSync: timestamp,
 *   entities: {
 *     "settings.accentColor": { localHash, cloudHash, lastSyncAt },
 *     "projects.abc123":      { localHash, cloudHash, lastSyncAt },
 *     "timeTracking":         { localHash, cloudHash, lastSyncAt },
 *     "conversations.session-xyz": { localHash, cloudHash, lastSyncAt, lineCount },
 *     ...
 *   }
 * }
 */

class SyncEngine {
  constructor() {
    /** @type {object} */
    this.manifest = { lastFullSync: 0, entities: {} };
    /** @type {string|null} */
    this.cloudUrl = null;
    /** @type {string|null} */
    this.apiKey = null;
    /** @type {boolean} */
    this.active = false;
    /** @type {Function|null} */
    this._onConflict = null;
    /** @type {Function|null} */
    this._onSyncStatus = null;
    /** @type {Map<string, NodeJS.Timeout>} debounce timers */
    this._debounceTimers = new Map();
    /** @type {boolean} */
    this._syncing = false;
    /** @type {BrowserWindow|null} */
    this._mainWindow = null;
  }

  // ── Lifecycle ──

  /**
   * Start the sync engine (called when cloud connects).
   * @param {string} cloudUrl
   * @param {string} apiKey
   */
  start(cloudUrl, apiKey) {
    this.cloudUrl = cloudUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.active = true;
    this._loadManifest();
    console.log('[SyncEngine] Started');
  }

  /**
   * Stop the sync engine (called when cloud disconnects).
   */
  stop() {
    this.active = false;
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();
    this._saveManifest();
    console.log('[SyncEngine] Stopped');
  }

  setMainWindow(win) {
    this._mainWindow = win;
  }

  /**
   * Register conflict handler (renderer will show modal).
   * @param {Function} fn - (conflicts: SyncConflict[]) => Promise<Resolution[]>
   */
  onConflict(fn) { this._onConflict = fn; }

  /**
   * Register sync status handler.
   * @param {Function} fn - ({ type, status, detail })
   */
  onSyncStatus(fn) { this._onSyncStatus = fn; }

  // ── Full sync (on connect or manual trigger) ──

  /**
   * Perform a full sync of all entity types.
   * Called on initial cloud connect.
   */
  async fullSync() {
    if (this._syncing || !this.active) return;
    this._syncing = true;
    this._emitStatus('full-sync', 'started');

    try {
      // Pull cloud state
      const cloudState = await this._fetchCloudState();
      if (!cloudState) {
        this._emitStatus('full-sync', 'error', 'Failed to fetch cloud state');
        return;
      }

      const conflicts = [];

      // Sync settings (per-key)
      const settingsConflicts = await this._syncSettings(cloudState.settings || {});
      conflicts.push(...settingsConflicts);

      // Sync projects (per-item)
      const projectsConflicts = await this._syncProjects(cloudState.projects || {});
      conflicts.push(...projectsConflicts);

      // Sync time tracking (additive merge, no conflicts)
      await this._syncTimeTracking(cloudState.timeTracking || {});

      // Sync conversations (append-only, no conflicts)
      await this._syncConversations(cloudState.conversations || {});

      // Handle conflicts
      if (conflicts.length > 0 && this._onConflict) {
        const resolutions = await this._onConflict(conflicts);
        await this._applyResolutions(resolutions);
      }

      this.manifest.lastFullSync = Date.now();
      this._saveManifest();
      this._emitStatus('full-sync', 'completed', { conflicts: conflicts.length });
    } catch (err) {
      console.error('[SyncEngine] Full sync failed:', err.message);
      this._emitStatus('full-sync', 'error', err.message);
    } finally {
      this._syncing = false;
    }
  }

  // ── Incremental push (local change → cloud) ──

  /**
   * Notify the engine that a local entity changed.
   * Debounced push to cloud.
   * @param {'settings'|'projects'|'timeTracking'|'conversations'} entityType
   * @param {string} [entityId] - specific key/id that changed (optional)
   */
  notifyLocalChange(entityType, entityId) {
    if (!this.active) return;

    const debounceKey = entityId ? `${entityType}.${entityId}` : entityType;
    const debounceMs = entityType === 'conversations'
      ? CONVERSATION_SYNC_DEBOUNCE_MS
      : SYNC_DEBOUNCE_MS;

    // Clear existing timer
    if (this._debounceTimers.has(debounceKey)) {
      clearTimeout(this._debounceTimers.get(debounceKey));
    }

    this._debounceTimers.set(debounceKey, setTimeout(async () => {
      this._debounceTimers.delete(debounceKey);
      await this._pushEntity(entityType, entityId);
    }, debounceMs));
  }

  // ── Push single entity to cloud ──

  async _pushEntity(entityType, entityId) {
    if (!this.active) return;

    try {
      const data = this._readLocalEntity(entityType, entityId);
      if (data === null) return;

      const entityKey = entityId ? `${entityType}.${entityId}` : entityType;
      const hash = this._hash(JSON.stringify(data));

      const resp = await this._fetchCloud('/api/sync/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          machineId: getMachineId(),
          entityType,
          entityId: entityId || null,
          data,
          hash,
          timestamp: Date.now(),
        }),
      });

      if (resp.ok) {
        this.manifest.entities[entityKey] = {
          localHash: hash,
          cloudHash: hash,
          lastSyncAt: Date.now(),
        };
        this._saveManifest();
        this._emitStatus('push', 'completed', { entityType, entityId });
      }
    } catch (err) {
      console.warn(`[SyncEngine] Push failed for ${entityType}${entityId ? '.' + entityId : ''}:`, err.message);
    }
  }

  // ── Settings sync ──

  async _syncSettings(cloudSettings) {
    const conflicts = [];
    const localSettings = this._readLocalSettings();
    const excludeKeys = ENTITY_TYPES.settings.excludeKeys;

    for (const key of Object.keys({ ...localSettings, ...cloudSettings })) {
      if (excludeKeys.includes(key)) continue;

      const entityKey = `settings.${key}`;
      const manifestEntry = this.manifest.entities[entityKey];
      const localVal = localSettings[key];
      const cloudVal = cloudSettings[key]?.value;
      const cloudTimestamp = cloudSettings[key]?.updatedAt || 0;

      const localHash = this._hash(JSON.stringify(localVal));
      const cloudHash = this._hash(JSON.stringify(cloudVal));

      // No change
      if (localHash === cloudHash) {
        this.manifest.entities[entityKey] = { localHash, cloudHash, lastSyncAt: Date.now() };
        continue;
      }

      const lastSyncHash = manifestEntry?.localHash;
      const localChanged = !lastSyncHash || localHash !== lastSyncHash;
      const cloudChanged = !manifestEntry?.cloudHash || cloudHash !== manifestEntry.cloudHash;

      if (localChanged && cloudChanged) {
        // True conflict
        conflicts.push({
          entityType: 'settings',
          entityId: key,
          localValue: localVal,
          cloudValue: cloudVal,
          cloudTimestamp,
          localTimestamp: manifestEntry?.lastSyncAt || 0,
        });
      } else if (cloudChanged) {
        // Cloud wins → apply locally
        localSettings[key] = cloudVal;
        this.manifest.entities[entityKey] = { localHash: cloudHash, cloudHash, lastSyncAt: Date.now() };
      } else if (localChanged) {
        // Local wins → push to cloud
        await this._pushEntity('settings', key);
      }
    }

    // Write merged settings locally
    this._writeLocalSettings(localSettings);
    return conflicts;
  }

  // ── Projects sync ──

  async _syncProjects(cloudProjects) {
    const conflicts = [];
    const localData = this._readLocalProjects();
    const localProjects = localData.projects || [];
    const localMap = new Map(localProjects.map(p => [p.id, p]));

    for (const [id, cloudEntry] of Object.entries(cloudProjects)) {
      const entityKey = `projects.${id}`;
      const manifestEntry = this.manifest.entities[entityKey];
      const localProject = localMap.get(id);
      const cloudProject = cloudEntry.data;
      const cloudTimestamp = cloudEntry.updatedAt || 0;

      if (!localProject && cloudProject) {
        // Cloud has a project we don't → add locally
        // Adjust path to local machine
        const adjustedProject = { ...cloudProject };
        adjustedProject.path = this._adjustProjectPath(cloudProject.path);
        localProjects.push(adjustedProject);
        this.manifest.entities[entityKey] = {
          localHash: this._hash(JSON.stringify(adjustedProject)),
          cloudHash: this._hash(JSON.stringify(cloudProject)),
          lastSyncAt: Date.now(),
        };
        continue;
      }

      if (localProject && !cloudProject) {
        // We have a project cloud doesn't → push to cloud
        await this._pushEntity('projects', id);
        continue;
      }

      if (localProject && cloudProject) {
        const localHash = this._hash(JSON.stringify(localProject));
        const cloudHash = this._hash(JSON.stringify(cloudProject));

        if (localHash === cloudHash) {
          this.manifest.entities[entityKey] = { localHash, cloudHash, lastSyncAt: Date.now() };
          continue;
        }

        const localChanged = !manifestEntry?.localHash || localHash !== manifestEntry.localHash;
        const cloudChanged = !manifestEntry?.cloudHash || cloudHash !== manifestEntry.cloudHash;

        if (localChanged && cloudChanged) {
          conflicts.push({
            entityType: 'projects',
            entityId: id,
            localValue: localProject,
            cloudValue: cloudProject,
            cloudTimestamp,
            localTimestamp: manifestEntry?.lastSyncAt || 0,
          });
        } else if (cloudChanged) {
          // Cloud wins
          const adjusted = { ...cloudProject, path: this._adjustProjectPath(cloudProject.path) };
          Object.assign(localProject, adjusted);
          this.manifest.entities[entityKey] = { localHash: this._hash(JSON.stringify(localProject)), cloudHash, lastSyncAt: Date.now() };
        } else if (localChanged) {
          await this._pushEntity('projects', id);
        }
      }
    }

    // Push local-only projects
    for (const p of localProjects) {
      if (!cloudProjects[p.id]) {
        await this._pushEntity('projects', p.id);
      }
    }

    this._writeLocalProjects({ ...localData, projects: localProjects });
    return conflicts;
  }

  // ── Time tracking sync (additive merge, no conflicts) ──

  async _syncTimeTracking(cloudTimeTracking) {
    const localTT = this._readLocalFile(TIMETRACKING_FILE);
    if (!localTT || !cloudTimeTracking) return;

    // Merge strategy: for each project/day, take the MAX duration
    // This prevents double-counting while preserving data from both machines
    const merged = this._mergeTimeTracking(localTT, cloudTimeTracking);
    this._writeLocalFile(TIMETRACKING_FILE, merged);
    await this._pushEntity('timeTracking');

    this.manifest.entities['timeTracking'] = {
      localHash: this._hash(JSON.stringify(merged)),
      cloudHash: this._hash(JSON.stringify(merged)),
      lastSyncAt: Date.now(),
    };
  }

  /**
   * Merge time tracking data from two sources.
   * For sessions: combine unique sessions (by start time).
   * For totals: sum across machines, dedup by session ID.
   */
  _mergeTimeTracking(local, cloud) {
    const merged = { ...local };
    if (!cloud || !local) return merged;

    // Merge global stats: take max
    if (cloud.global && merged.global) {
      merged.global.totalMs = Math.max(merged.global.totalMs || 0, cloud.global.totalMs || 0);
    }

    // Merge per-project data: combine sessions, sum unique durations
    if (cloud.projects) {
      if (!merged.projects) merged.projects = {};
      for (const [projectId, cloudData] of Object.entries(cloud.projects)) {
        if (!merged.projects[projectId]) {
          merged.projects[projectId] = cloudData;
        } else {
          const localData = merged.projects[projectId];
          // Merge sessions by start timestamp (dedup)
          if (cloudData.sessions && localData.sessions) {
            const sessionMap = new Map();
            for (const s of localData.sessions) sessionMap.set(s.start, s);
            for (const s of cloudData.sessions) {
              if (!sessionMap.has(s.start)) sessionMap.set(s.start, s);
            }
            localData.sessions = Array.from(sessionMap.values()).sort((a, b) => a.start - b.start);
          }
          // Recalculate totals from merged sessions
          if (localData.sessions) {
            localData.totalMs = localData.sessions.reduce((sum, s) => sum + (s.duration || 0), 0);
          }
        }
      }
    }

    return merged;
  }

  // ── Conversations sync (append-only) ──

  async _syncConversations(cloudConversations) {
    // cloudConversations: { "session-id": { lines: number, lastLine: string, updatedAt } }
    // We sync conversation metadata only during full sync,
    // actual content is synced on-demand or incrementally.
    const claudeDir = path.join(os.homedir(), '.claude');
    if (!fs.existsSync(claudeDir)) return;

    for (const [sessionId, cloudMeta] of Object.entries(cloudConversations)) {
      const entityKey = `conversations.${sessionId}`;
      this.manifest.entities[entityKey] = {
        localHash: null,
        cloudHash: this._hash(JSON.stringify(cloudMeta)),
        lastSyncAt: Date.now(),
        cloudLineCount: cloudMeta.lines || 0,
      };
    }
  }

  /**
   * Pull a specific conversation from cloud (on-demand).
   * @param {string} sessionId
   * @param {string} projectPath - encoded project path for local storage
   * @returns {object|null} conversation data
   */
  async pullConversation(sessionId, projectPath) {
    if (!this.active) return null;

    try {
      const resp = await this._fetchCloud(`/api/sync/conversation/${encodeURIComponent(sessionId)}`, {
        method: 'GET',
      });

      if (!resp.ok) return null;
      const data = await resp.json();

      // Write conversation JSONL locally
      if (data.content && projectPath) {
        const sessionsDir = path.join(os.homedir(), '.claude', 'projects', projectPath);
        if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
        const localFile = path.join(sessionsDir, `${sessionId}.jsonl`);
        fs.writeFileSync(localFile, data.content, 'utf8');
      }

      return data;
    } catch (err) {
      console.warn(`[SyncEngine] Pull conversation ${sessionId} failed:`, err.message);
      return null;
    }
  }

  /**
   * Push a conversation to cloud (incremental, append-only).
   * @param {string} sessionId
   * @param {string} filePath - absolute path to .jsonl file
   */
  async pushConversation(sessionId, filePath) {
    if (!this.active || !fs.existsSync(filePath)) return;

    try {
      const entityKey = `conversations.${sessionId}`;
      const manifestEntry = this.manifest.entities[entityKey];
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      const lastSyncedLineCount = manifestEntry?.cloudLineCount || 0;

      // Only send new lines (append-only)
      const newLines = lines.slice(lastSyncedLineCount);
      if (newLines.length === 0) return;

      const resp = await this._fetchCloud(`/api/sync/conversation/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          machineId: getMachineId(),
          appendLines: newLines.join('\n'),
          totalLineCount: lines.length,
          timestamp: Date.now(),
        }),
      });

      if (resp.ok) {
        this.manifest.entities[entityKey] = {
          localHash: this._hash(content),
          cloudHash: this._hash(content),
          lastSyncAt: Date.now(),
          cloudLineCount: lines.length,
        };
        this._saveManifest();
      }
    } catch (err) {
      console.warn(`[SyncEngine] Push conversation ${sessionId} failed:`, err.message);
    }
  }

  // ── Conflict resolution ──

  async _applyResolutions(resolutions) {
    if (!resolutions || resolutions.length === 0) return;

    for (const resolution of resolutions) {
      const { entityType, entityId, choice } = resolution; // choice: 'local' | 'cloud'
      const entityKey = entityId ? `${entityType}.${entityId}` : entityType;

      if (choice === 'local') {
        // Push local to cloud
        await this._pushEntity(entityType, entityId);
      } else if (choice === 'cloud') {
        // Apply cloud value locally
        await this._applyCloudValue(entityType, entityId, resolution.cloudValue);
      }

      // Mark as resolved
      const hash = this._hash(JSON.stringify(
        choice === 'local' ? resolution.localValue : resolution.cloudValue
      ));
      this.manifest.entities[entityKey] = {
        localHash: hash,
        cloudHash: hash,
        lastSyncAt: Date.now(),
      };
    }

    this._saveManifest();
  }

  async _applyCloudValue(entityType, entityId, cloudValue) {
    if (entityType === 'settings' && entityId) {
      const settings = this._readLocalSettings();
      settings[entityId] = cloudValue;
      this._writeLocalSettings(settings);
      // Notify renderer to reload settings
      this._sendToRenderer('sync:settings-updated', { key: entityId, value: cloudValue });
    } else if (entityType === 'projects' && entityId) {
      const data = this._readLocalProjects();
      const idx = data.projects.findIndex(p => p.id === entityId);
      const adjusted = { ...cloudValue, path: this._adjustProjectPath(cloudValue.path) };
      if (idx >= 0) {
        data.projects[idx] = adjusted;
      } else {
        data.projects.push(adjusted);
      }
      this._writeLocalProjects(data);
      this._sendToRenderer('sync:projects-updated');
    }
  }

  // ── Cloud API helpers ──

  async _fetchCloudState() {
    try {
      const resp = await this._fetchCloud('/api/sync/state', { method: 'GET' });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (err) {
      console.error('[SyncEngine] Failed to fetch cloud state:', err.message);
      return null;
    }
  }

  async _fetchCloud(endpoint, opts = {}) {
    const url = `${this.cloudUrl}${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      return await fetch(url, {
        ...opts,
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          ...opts.headers,
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Local file helpers ──

  _readLocalSettings() {
    try {
      if (fs.existsSync(settingsFile)) {
        return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      }
    } catch {}
    return {};
  }

  _writeLocalSettings(settings) {
    try {
      const tmpFile = settingsFile + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(settings, null, 2), 'utf8');
      fs.renameSync(tmpFile, settingsFile);
    } catch (err) {
      console.error('[SyncEngine] Failed to write settings:', err.message);
    }
  }

  _readLocalProjects() {
    try {
      if (fs.existsSync(projectsFile)) {
        return JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
      }
    } catch {}
    return { projects: [], folders: [], rootOrder: [] };
  }

  _writeLocalProjects(data) {
    try {
      const tmpFile = projectsFile + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpFile, projectsFile);
    } catch (err) {
      console.error('[SyncEngine] Failed to write projects:', err.message);
    }
  }

  _readLocalFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    } catch {}
    return null;
  }

  _writeLocalFile(filePath, data) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpFile = filePath + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpFile, filePath);
    } catch (err) {
      console.error(`[SyncEngine] Failed to write ${filePath}:`, err.message);
    }
  }

  _readLocalEntity(entityType, entityId) {
    if (entityType === 'settings') {
      const settings = this._readLocalSettings();
      return entityId ? settings[entityId] : settings;
    }
    if (entityType === 'projects') {
      const data = this._readLocalProjects();
      if (entityId) {
        return data.projects.find(p => p.id === entityId) || null;
      }
      return data;
    }
    if (entityType === 'timeTracking') {
      return this._readLocalFile(TIMETRACKING_FILE);
    }
    return null;
  }

  // ── Manifest persistence ──

  _loadManifest() {
    try {
      if (fs.existsSync(MANIFEST_FILE)) {
        this.manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
      }
    } catch {
      this.manifest = { lastFullSync: 0, entities: {} };
    }
  }

  _saveManifest() {
    try {
      const dir = path.dirname(MANIFEST_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpFile = MANIFEST_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(this.manifest, null, 2), 'utf8');
      fs.renameSync(tmpFile, MANIFEST_FILE);
    } catch (err) {
      console.warn('[SyncEngine] Failed to save manifest:', err.message);
    }
  }

  // ── Utilities ──

  _hash(str) {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(str || '').digest('hex').slice(0, 12);
  }

  /**
   * Adjust a project path from another machine to the local machine.
   * Converts drive letters and home dirs.
   */
  _adjustProjectPath(remotePath) {
    if (!remotePath) return remotePath;
    // If path is from another OS, try to make it work locally
    const homeDir = os.homedir();
    // Replace common home dir patterns
    const homePatterns = [
      /^C:\\Users\\[^\\]+/i,
      /^\/home\/[^/]+/,
      /^\/Users\/[^/]+/,
    ];
    for (const pattern of homePatterns) {
      if (pattern.test(remotePath)) {
        return remotePath.replace(pattern, homeDir);
      }
    }
    return remotePath;
  }

  _sendToRenderer(channel, data) {
    if (this._mainWindow && !this._mainWindow.isDestroyed()) {
      this._mainWindow.webContents.send(channel, data);
    }
  }

  _emitStatus(type, status, detail) {
    if (this._onSyncStatus) {
      this._onSyncStatus({ type, status, detail });
    }
    this._sendToRenderer('sync:status', { type, status, detail });
  }
}

module.exports = { SyncEngine, syncEngine: new SyncEngine() };
