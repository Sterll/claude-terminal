/**
 * SyncEngine
 * Bidirectional sync of app entities between desktop and cloud server.
 * Desktop = source of truth. Timestamp + hash-based conflict detection.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir, settingsFile, projectsFile, claudeDir } = require('../utils/paths');

const SYNC_META_FILE = path.join(dataDir, 'sync-meta.json');
const PUSH_DEBOUNCE_MS = 2000;
const PULL_INTERVAL_MS = 60000;
const SUPPRESS_DURATION_MS = 3000;
const FETCH_TIMEOUT_MS = 15000;

const ENTITY_TYPES = [
  'settings', 'projects', 'timetracking', 'mcp',
  'skills', 'agents', 'memory', 'hooks', 'plugins',
];

function computeHash(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

class SyncEngine {
  constructor() {
    this._cloudUrl = null;
    this._apiKey = null;
    this._handlers = {};
    this._syncMeta = {};
    this._watchers = {};
    this._pushQueue = new Set();
    this._pushTimer = null;
    this._pullTimer = null;
    this._pulling = false;
    this._pushing = false;
    this._suppressPaths = new Set();
    this._status = 'idle';
    this._conflicts = [];
    this._started = false;
    this._onStatusChange = null;
    this._onConflict = null;
    this._settingsGetter = null;
  }

  setCallbacks({ onStatusChange, onConflict, getSettings }) {
    this._onStatusChange = onStatusChange;
    this._onConflict = onConflict;
    this._settingsGetter = getSettings;
  }

  _emitStatus() {
    if (this._onStatusChange) {
      this._onStatusChange(this.getStatus());
    }
  }

  _setStatus(status) {
    if (this._status !== status) {
      this._status = status;
      this._emitStatus();
    }
  }

  // ── Entity Handler Registration ──

  _registerHandlers() {
    const homeDir = require('os').homedir();
    const claudeJsonPath = path.join(homeDir, '.claude.json');
    const claudeSettingsPath = path.join(claudeDir, 'settings.json');
    const timetrackingFile = path.join(dataDir, 'timetracking.json');
    const skillsDir = path.join(claudeDir, 'skills');
    const agentsDir = path.join(claudeDir, 'agents');
    const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
    const pluginsFile = path.join(claudeDir, 'plugins', 'installed_plugins.json');

    this._handlers = {
      settings: {
        settingKey: 'cloudSyncSettings',
        path: settingsFile,
        read: async () => {
          try {
            const raw = await fs.promises.readFile(settingsFile, 'utf8');
            const data = JSON.parse(raw);
            // Strip sensitive cloud credentials from sync
            const { cloudApiKey, cloudServerUrl, ...rest } = data;
            return rest;
          } catch { return null; }
        },
        write: async (data) => {
          // Merge: keep local cloud credentials
          let local = {};
          try { local = JSON.parse(await fs.promises.readFile(settingsFile, 'utf8')); } catch { /* */ }
          const merged = { ...data, cloudApiKey: local.cloudApiKey, cloudServerUrl: local.cloudServerUrl, cloudAutoConnect: local.cloudAutoConnect };
          await this._atomicWrite(settingsFile, JSON.stringify(merged, null, 2));
        },
        sanitize: (data) => {
          const { cloudApiKey, cloudServerUrl, cloudAutoConnect, ...rest } = data;
          return rest;
        },
      },

      projects: {
        settingKey: 'cloudSyncProjects',
        path: projectsFile,
        read: async () => {
          try {
            const raw = await fs.promises.readFile(projectsFile, 'utf8');
            return JSON.parse(raw);
          } catch { return null; }
        },
        write: async (data) => {
          await this._atomicWrite(projectsFile, JSON.stringify(data, null, 2));
        },
        sanitize: (data) => data,
      },

      timetracking: {
        settingKey: 'cloudSyncTimeTracking',
        path: timetrackingFile,
        read: async () => {
          try {
            const raw = await fs.promises.readFile(timetrackingFile, 'utf8');
            return JSON.parse(raw);
          } catch { return null; }
        },
        write: async (data) => {
          await this._atomicWrite(timetrackingFile, JSON.stringify(data, null, 2));
        },
        sanitize: (data) => data,
      },

      mcp: {
        settingKey: 'cloudSyncMcpConfigs',
        path: claudeJsonPath,
        read: async () => {
          try {
            const raw = await fs.promises.readFile(claudeJsonPath, 'utf8');
            const full = JSON.parse(raw);
            return full.mcpServers || {};
          } catch { return null; }
        },
        write: async (data) => {
          let full = {};
          try { full = JSON.parse(await fs.promises.readFile(claudeJsonPath, 'utf8')); } catch { /* */ }
          full.mcpServers = data;
          await this._atomicWrite(claudeJsonPath, JSON.stringify(full, null, 2));
        },
        sanitize: (data) => {
          // Strip env vars that might contain secrets
          const cleaned = {};
          for (const [name, cfg] of Object.entries(data)) {
            const c = { ...cfg };
            if (c.env) {
              const safeEnv = {};
              for (const [k, v] of Object.entries(c.env)) {
                // Keep env vars but redact values that look like secrets
                if (/token|secret|key|password|credential/i.test(k)) {
                  safeEnv[k] = '***REDACTED***';
                } else {
                  safeEnv[k] = v;
                }
              }
              c.env = safeEnv;
            }
            cleaned[name] = c;
          }
          return cleaned;
        },
      },

      skills: {
        settingKey: 'cloudSyncSkills',
        path: skillsDir,
        isDir: true,
        read: async () => {
          try {
            const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true });
            const skills = [];
            for (const entry of entries) {
              if (!entry.isDirectory()) continue;
              const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
              try {
                const content = await fs.promises.readFile(skillFile, 'utf8');
                skills.push({ name: entry.name, content });
              } catch { /* skip skills without SKILL.md */ }
            }
            return skills;
          } catch { return null; }
        },
        write: async (data) => {
          if (!Array.isArray(data)) return;
          await fs.promises.mkdir(skillsDir, { recursive: true });
          for (const skill of data) {
            if (!skill.name || !skill.content) continue;
            // Validate skill name to prevent path traversal
            if (/[\/\\]/.test(skill.name) || skill.name === '..' || skill.name === '.') continue;
            const dir = path.join(skillsDir, skill.name);
            await fs.promises.mkdir(dir, { recursive: true });
            await this._atomicWrite(path.join(dir, 'SKILL.md'), skill.content);
          }
        },
        sanitize: (data) => data,
      },

      agents: {
        settingKey: 'cloudSyncSkills', // Shared toggle with skills
        path: agentsDir,
        isDir: true,
        read: async () => {
          try {
            const entries = await fs.promises.readdir(agentsDir, { withFileTypes: true });
            const agents = [];
            for (const entry of entries) {
              if (!entry.isDirectory()) continue;
              const agentFile = path.join(agentsDir, entry.name, 'AGENT.md');
              try {
                const content = await fs.promises.readFile(agentFile, 'utf8');
                agents.push({ name: entry.name, content });
              } catch { /* skip */ }
            }
            return agents;
          } catch { return null; }
        },
        write: async (data) => {
          if (!Array.isArray(data)) return;
          await fs.promises.mkdir(agentsDir, { recursive: true });
          for (const agent of data) {
            if (!agent.name || !agent.content) continue;
            if (/[\/\\]/.test(agent.name) || agent.name === '..' || agent.name === '.') continue;
            const dir = path.join(agentsDir, agent.name);
            await fs.promises.mkdir(dir, { recursive: true });
            await this._atomicWrite(path.join(dir, 'AGENT.md'), agent.content);
          }
        },
        sanitize: (data) => data,
      },

      memory: {
        settingKey: 'cloudSyncMemory',
        path: claudeMdPath,
        read: async () => {
          try {
            return await fs.promises.readFile(claudeMdPath, 'utf8');
          } catch { return null; }
        },
        write: async (data) => {
          if (typeof data !== 'string') return;
          await fs.promises.mkdir(path.dirname(claudeMdPath), { recursive: true });
          await this._atomicWrite(claudeMdPath, data);
        },
        sanitize: (data) => data,
      },

      hooks: {
        settingKey: 'cloudSyncHooksConfig',
        path: claudeSettingsPath,
        read: async () => {
          try {
            const raw = await fs.promises.readFile(claudeSettingsPath, 'utf8');
            const full = JSON.parse(raw);
            return full.hooks || {};
          } catch { return null; }
        },
        write: async (data) => {
          let full = {};
          try { full = JSON.parse(await fs.promises.readFile(claudeSettingsPath, 'utf8')); } catch { /* */ }
          full.hooks = data;
          await this._atomicWrite(claudeSettingsPath, JSON.stringify(full, null, 2));
        },
        sanitize: (data) => data,
      },

      plugins: {
        settingKey: 'cloudSyncPlugins',
        path: pluginsFile,
        read: async () => {
          try {
            const raw = await fs.promises.readFile(pluginsFile, 'utf8');
            return JSON.parse(raw);
          } catch { return null; }
        },
        write: async (data) => {
          await fs.promises.mkdir(path.dirname(pluginsFile), { recursive: true });
          await this._atomicWrite(pluginsFile, JSON.stringify(data, null, 2));
        },
        sanitize: (data) => data,
      },
    };
  }

  // ── Lifecycle ──

  async start(cloudUrl, apiKey) {
    if (this._started) return;
    this._cloudUrl = cloudUrl.replace(/\/$/, '');
    this._apiKey = apiKey;
    this._started = true;

    this._registerHandlers();
    this._loadSyncMeta();
    this._startWatchers();
    this._setStatus('syncing');

    // Initial pull
    try {
      await this.pullAll();
      this._setStatus('idle');
    } catch (err) {
      console.error('[SyncEngine] Initial pull failed:', err.message);
      this._setStatus('error');
    }

    // Periodic pull
    this._pullTimer = setInterval(() => {
      if (!this._pulling && !this._pushing) {
        this.pullAll().catch(err => {
          console.error('[SyncEngine] Periodic pull failed:', err.message);
        });
      }
    }, PULL_INTERVAL_MS);
  }

  stop() {
    if (!this._started) return;
    this._started = false;
    this._stopWatchers();
    if (this._pushTimer) { clearTimeout(this._pushTimer); this._pushTimer = null; }
    if (this._pullTimer) { clearInterval(this._pullTimer); this._pullTimer = null; }
    this._saveSyncMeta();
    this._pushQueue.clear();
    this._setStatus('idle');
  }

  getStatus() {
    return {
      status: this._status,
      started: this._started,
      lastSync: this._lastSyncAt || null,
      pendingPush: this._pushQueue.size,
      conflicts: this._conflicts.length,
    };
  }

  getConflicts() {
    return [...this._conflicts];
  }

  // ── Sync Meta Persistence ──

  _loadSyncMeta() {
    try {
      if (fs.existsSync(SYNC_META_FILE)) {
        this._syncMeta = JSON.parse(fs.readFileSync(SYNC_META_FILE, 'utf8'));
      }
    } catch (e) {
      console.warn('[SyncEngine] Failed to load sync meta:', e.message);
      this._syncMeta = {};
    }
  }

  _saveSyncMeta() {
    try {
      fs.writeFileSync(SYNC_META_FILE, JSON.stringify(this._syncMeta, null, 2), 'utf8');
    } catch (e) {
      console.warn('[SyncEngine] Failed to save sync meta:', e.message);
    }
  }

  // ── File Watchers ──

  _startWatchers() {
    for (const [type, handler] of Object.entries(this._handlers)) {
      if (!handler.path) continue;
      try {
        const watchPath = handler.path;
        // Ensure watched path exists
        if (handler.isDir) {
          if (!fs.existsSync(watchPath)) {
            fs.mkdirSync(watchPath, { recursive: true });
          }
        } else if (!fs.existsSync(watchPath)) {
          continue; // File doesn't exist yet, will be watched when created
        }

        const watcher = fs.watch(watchPath, { recursive: !!handler.isDir }, () => {
          if (this._suppressPaths.has(watchPath)) return;
          this._queuePush(type);
        });
        watcher.on('error', () => {}); // Ignore watcher errors
        this._watchers[type] = watcher;
      } catch (e) {
        console.warn(`[SyncEngine] Failed to watch ${type}:`, e.message);
      }
    }
  }

  _stopWatchers() {
    for (const [type, watcher] of Object.entries(this._watchers)) {
      try { watcher.close(); } catch { /* */ }
    }
    this._watchers = {};
  }

  _suppressPath(filePath) {
    this._suppressPaths.add(filePath);
    setTimeout(() => this._suppressPaths.delete(filePath), SUPPRESS_DURATION_MS);
  }

  // ── Push (Local -> Cloud) ──

  _queuePush(entityType) {
    if (!this._started) return;
    this._pushQueue.add(entityType);
    if (this._pushTimer) clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => this._flushPushQueue(), PUSH_DEBOUNCE_MS);
  }

  async _flushPushQueue() {
    if (!this._started || this._pushing || this._pushQueue.size === 0) return;
    this._pushing = true;
    this._setStatus('syncing');

    const types = [...this._pushQueue];
    this._pushQueue.clear();

    for (const type of types) {
      try {
        await this._pushEntity(type);
      } catch (err) {
        console.error(`[SyncEngine] Push ${type} failed:`, err.message);
      }
    }

    this._pushing = false;
    this._saveSyncMeta();
    this._lastSyncAt = Date.now();
    this._setStatus(this._conflicts.length > 0 ? 'conflict' : 'idle');
  }

  async _pushEntity(type) {
    const handler = this._handlers[type];
    if (!handler) return;

    // Check toggle
    if (!this._isEntityEnabled(type)) return;

    const data = await handler.read();
    if (data === null || data === undefined) return;

    const sanitized = handler.sanitize ? handler.sanitize(data) : data;
    const hash = computeHash(sanitized);

    // Skip if unchanged from last sync
    const meta = this._syncMeta[type];
    if (meta && meta.lastSyncedHash === hash) return;

    const clientHash = meta?.lastSyncedHash || undefined;
    const resp = await this._fetch(`/api/sync/entities/${type}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: sanitized, clientHash }),
    });

    if (resp.status === 409) {
      // Conflict
      const body = await resp.json();
      this._addConflict(type, data, body.serverData?.data);
      return;
    }

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }

    const result = await resp.json();
    this._syncMeta[type] = {
      lastSyncedHash: result.hash || hash,
      lastSyncedAt: result.updatedAt || Date.now(),
    };
  }

  async forcePush(type) {
    if (!this._started) throw new Error('Sync engine not started');
    const handler = this._handlers[type];
    if (!handler) throw new Error(`Unknown entity type: ${type}`);

    const data = await handler.read();
    if (data === null) return;
    const sanitized = handler.sanitize ? handler.sanitize(data) : data;

    // Force push without clientHash (no conflict check)
    const resp = await this._fetch(`/api/sync/entities/${type}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: sanitized }),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const result = await resp.json();
    this._syncMeta[type] = {
      lastSyncedHash: result.hash || computeHash(sanitized),
      lastSyncedAt: result.updatedAt || Date.now(),
    };
    this._saveSyncMeta();
  }

  // ── Pull (Cloud -> Local) ──

  async pullAll() {
    if (!this._started || this._pulling) return;
    this._pulling = true;

    try {
      this._setStatus('syncing');

      const resp = await this._fetch('/api/sync/manifest');
      if (!resp.ok) throw new Error(`Manifest fetch failed: HTTP ${resp.status}`);
      const { manifest } = await resp.json();

      for (const [type, info] of Object.entries(manifest)) {
        if (!this._handlers[type]) continue;
        if (!this._isEntityEnabled(type)) continue;

        const meta = this._syncMeta[type];
        // Server has changes we haven't synced
        if (!meta || meta.lastSyncedHash !== info.hash) {
          await this._pullEntity(type);
        }
      }

      this._lastSyncAt = Date.now();
      this._saveSyncMeta();
      this._setStatus(this._conflicts.length > 0 ? 'conflict' : 'idle');
    } catch (err) {
      console.error('[SyncEngine] Pull failed:', err.message);
      this._setStatus('error');
    } finally {
      this._pulling = false;
    }
  }

  async _pullEntity(type) {
    const handler = this._handlers[type];
    if (!handler) return;

    const resp = await this._fetch(`/api/sync/entities/${type}`);
    if (resp.status === 404) return; // Entity doesn't exist on server
    if (!resp.ok) throw new Error(`Pull ${type} failed: HTTP ${resp.status}`);

    const envelope = await resp.json();
    const meta = this._syncMeta[type];

    // Check if local also changed (conflict detection)
    const localData = await handler.read();
    if (localData !== null && meta) {
      const localHash = computeHash(handler.sanitize ? handler.sanitize(localData) : localData);
      if (localHash !== meta.lastSyncedHash && envelope.hash !== meta.lastSyncedHash) {
        // Both sides changed since last sync -> conflict
        this._addConflict(type, localData, envelope.data);
        return;
      }
    }

    // Apply cloud data locally
    if (handler.path) {
      this._suppressPath(handler.path);
    }
    await handler.write(envelope.data);

    this._syncMeta[type] = {
      lastSyncedHash: envelope.hash,
      lastSyncedAt: envelope.updatedAt,
    };
  }

  async onRemoteChange(entityType) {
    if (!this._started || !this._handlers[entityType]) return;
    if (!this._isEntityEnabled(entityType)) return;
    try {
      await this._pullEntity(entityType);
      this._saveSyncMeta();
      this._emitStatus();
    } catch (err) {
      console.error(`[SyncEngine] Remote change pull for ${entityType} failed:`, err.message);
    }
  }

  // ── Force Full Sync ──

  async forceFullSync() {
    if (!this._started) throw new Error('Sync engine not started');
    this._setStatus('syncing');

    // Push all enabled entities first
    for (const type of ENTITY_TYPES) {
      if (!this._isEntityEnabled(type)) continue;
      try {
        await this._pushEntity(type);
      } catch (err) {
        console.error(`[SyncEngine] Force push ${type} failed:`, err.message);
      }
    }

    // Then pull
    await this.pullAll();
  }

  // ── Conflict Management ──

  _addConflict(entityType, localData, cloudData) {
    // Don't add duplicate conflicts for same entity
    const existing = this._conflicts.findIndex(c => c.entityType === entityType);
    if (existing >= 0) {
      this._conflicts[existing] = { entityType, localData, cloudData, detectedAt: Date.now() };
    } else {
      this._conflicts.push({ entityType, localData, cloudData, detectedAt: Date.now() });
    }
    if (this._onConflict) {
      this._onConflict(this._conflicts);
    }
  }

  async resolveConflict(entityType, resolution) {
    const idx = this._conflicts.findIndex(c => c.entityType === entityType);
    if (idx < 0) throw new Error(`No conflict for ${entityType}`);

    const conflict = this._conflicts[idx];
    const handler = this._handlers[entityType];

    if (resolution === 'local') {
      // Push local data to cloud (force, no conflict check)
      await this.forcePush(entityType);
    } else if (resolution === 'cloud') {
      // Write cloud data locally
      if (handler.path) this._suppressPath(handler.path);
      await handler.write(conflict.cloudData);
      // Update meta to match cloud
      const hash = computeHash(conflict.cloudData);
      this._syncMeta[entityType] = { lastSyncedHash: hash, lastSyncedAt: Date.now() };
      this._saveSyncMeta();
    }

    this._conflicts.splice(idx, 1);
    this._emitStatus();
  }

  async resolveAllConflicts(resolution) {
    const types = this._conflicts.map(c => c.entityType);
    for (const type of types) {
      await this.resolveConflict(type, resolution);
    }
  }

  // ── Helpers ──

  _isEntityEnabled(type) {
    if (!this._settingsGetter) return true;
    const settings = this._settingsGetter();
    if (!settings.cloudAutoSync) return false;
    const handler = this._handlers[type];
    if (!handler?.settingKey) return true;
    return settings[handler.settingKey] !== false;
  }

  async _fetch(urlPath, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers = { ...opts.headers, 'Authorization': `Bearer ${this._apiKey}` };
      return await fetch(`${this._cloudUrl}${urlPath}`, { ...opts, headers, signal: controller.signal });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`Sync request timed out`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async _atomicWrite(filePath, content) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
    const tmpPath = filePath + '.tmp.' + crypto.randomBytes(4).toString('hex');
    await fs.promises.writeFile(tmpPath, content, 'utf8');
    await fs.promises.rename(tmpPath, filePath);
  }
}

const syncEngine = new SyncEngine();
module.exports = { syncEngine, SyncEngine };
