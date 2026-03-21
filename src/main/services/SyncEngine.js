/**
 * SyncEngine
 * Entity-based bidirectional sync between local app state and cloud relay.
 *
 * Entities: settings, projects, timeTracking, conversations, skills, agents, mcpConfigs,
 *           keybindings, memory, hooksConfig, timeTrackingArchives, installedPlugins
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

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const DATA_DIR = path.join(os.homedir(), '.claude-terminal');
const MANIFEST_FILE = path.join(DATA_DIR, 'sync-manifest.json');
const TIMETRACKING_FILE = path.join(DATA_DIR, 'timetracking.json');
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
const AGENTS_DIR = path.join(CLAUDE_DIR, 'agents');
const MCP_CONFIG_FILE = path.join(os.homedir(), '.claude.json');
const KEYBINDINGS_FILE = path.join(CLAUDE_DIR, 'keybindings.json');
const MEMORY_FILE = path.join(CLAUDE_DIR, 'MEMORY.md');
const CLAUDE_SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const PLUGINS_DIR = path.join(CLAUDE_DIR, 'plugins');
const INSTALLED_PLUGINS_FILE = path.join(PLUGINS_DIR, 'installed_plugins.json');
const ARCHIVES_DIR = path.join(DATA_DIR, 'archives');
const TIMETRACKING_DIR = path.join(DATA_DIR, 'timetracking');

const SYNC_DEBOUNCE_MS = 2000;
const CONVERSATION_SYNC_DEBOUNCE_MS = 30000;
const FILE_SYNC_DEBOUNCE_MS = 5000;

// ── Entity definitions ──

const ENTITY_TYPES = {
  settings: {
    granularity: 'per-key',
    localPath: () => settingsFile,
    excludeKeys: [
      'cloudServerUrl', 'cloudApiKey', 'cloudAutoConnect', 'cloudAutoSync',
      'cloudSyncSettings', 'cloudSyncProjects', 'cloudSyncTimeTracking',
      'cloudSyncConversations', 'cloudSyncSkills', 'cloudSyncMcpConfigs',
      'cloudSyncKeybindings', 'cloudSyncMemory', 'cloudSyncHooksConfig',
      'cloudSyncPlugins', 'cloudAutoUploadProjects', 'cloudExcludeSensitiveFiles',
      'machineId',
    ],
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
    localPath: () => CLAUDE_DIR,
    autoResolve: true,
  },
  skills: {
    granularity: 'per-directory',
    localPath: () => SKILLS_DIR,
    autoResolve: true, // last-write-wins per skill (no conflict modal)
  },
  agents: {
    granularity: 'per-directory',
    localPath: () => AGENTS_DIR,
    autoResolve: true,
  },
  mcpConfigs: {
    granularity: 'per-key',
    localPath: () => MCP_CONFIG_FILE,
    excludeKeys: [],
    autoResolve: false,
  },
  keybindings: {
    granularity: 'whole-file',
    localPath: () => KEYBINDINGS_FILE,
    autoResolve: false, // conflicts possible
  },
  memory: {
    granularity: 'whole-file',
    localPath: () => MEMORY_FILE,
    autoResolve: false, // user decides local vs cloud
  },
  hooksConfig: {
    granularity: 'whole-file',
    localPath: () => CLAUDE_SETTINGS_FILE,
    autoResolve: false, // hooks are critical, user decides
  },
  timeTrackingArchives: {
    granularity: 'per-file',
    localPath: () => TIMETRACKING_DIR,
    autoResolve: true, // additive merge, no conflicts
  },
  installedPlugins: {
    granularity: 'whole-file',
    localPath: () => INSTALLED_PLUGINS_FILE,
    autoResolve: true, // merge plugin lists
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
    /** @type {boolean} server supports /api/sync/* endpoints */
    this._serverSupportsSync = true;
    /** @type {number} consecutive failures → exponential backoff */
    this._syncFailures = 0;
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
    this._serverSupportsSync = true;
    this._syncFailures = 0;
    this._loadManifest();
    console.log('[SyncEngine] Started');
  }

  /**
   * Stop the sync engine (called when cloud disconnects).
   */
  stop() {
    this.active = false;
    this._syncing = false;
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

  // ── Sync toggles ──

  /**
   * Read per-entity sync toggles from settings.json.
   * Returns map of entityType → boolean (enabled).
   */
  _getSyncToggles() {
    try {
      const raw = fs.readFileSync(settingsFile, 'utf8');
      const s = JSON.parse(raw);
      return {
        settings: s.cloudSyncSettings !== false,
        projects: s.cloudSyncProjects !== false,
        timeTracking: s.cloudSyncTimeTracking !== false,
        conversations: s.cloudSyncConversations !== false,
        skills: s.cloudSyncSkills === true,
        agents: s.cloudSyncSkills === true,
        mcpConfigs: s.cloudSyncMcpConfigs !== false,
        keybindings: s.cloudSyncKeybindings !== false,
        memory: s.cloudSyncMemory !== false,
        hooksConfig: s.cloudSyncHooksConfig !== false,
        timeTrackingArchives: s.cloudSyncTimeTracking !== false,
        installedPlugins: s.cloudSyncPlugins !== false,
      };
    } catch {
      // If settings unreadable, sync everything by default
      return {};
    }
  }

  /**
   * Check if a given entity type is enabled for sync.
   */
  _isEntityEnabled(entityType) {
    const toggles = this._getSyncToggles();
    return toggles[entityType] !== false;
  }

  // ── Full sync (on connect or manual trigger) ──

  /**
   * Perform a full sync of all entity types.
   * Called on initial cloud connect.
   */
  async fullSync() {
    if (!this.active) return { ok: false, reason: 'not_active' };
    if (this._syncing) {
      console.log('[SyncEngine] Full sync already in progress, skipping');
      return { ok: false, reason: 'already_syncing' };
    }
    if (!this._serverSupportsSync) {
      this._emitStatus('full-sync', 'error', 'Server does not support entity sync (needs update)');
      return { ok: false, reason: 'server_not_supported' };
    }
    this._syncing = true;
    this._emitStatus('full-sync', 'started');

    const ALL_SYNC_STEPS = [
      'settings', 'projects', 'timeTracking', 'conversations',
      'skills', 'agents', 'mcpConfigs', 'keybindings',
      'memory', 'hooksConfig', 'timeTrackingArchives', 'installedPlugins',
    ];
    const toggles = this._getSyncToggles();
    const enabledSteps = ALL_SYNC_STEPS.filter(s => toggles[s] !== false);
    const totalSteps = enabledSteps.length + 1; // +1 for initial fetch
    let currentStep = 0;
    let didEmitFinal = false;

    const emitProgress = (label) => {
      currentStep++;
      this._emitStatus('full-sync', 'progress', { step: currentStep, total: totalSteps, label });
    };

    try {
      // Pull cloud state
      emitProgress('fetch');
      const cloudState = await this._fetchCloudState();
      if (!cloudState) {
        didEmitFinal = true;
        this._emitStatus('full-sync', 'error', 'Failed to fetch cloud state');
        return { ok: false, reason: 'fetch_failed' };
      }

      const conflicts = [];

      const syncSteps = [
        { key: 'settings', fn: async () => { conflicts.push(...await this._syncSettings(cloudState.settings || {})); } },
        { key: 'projects', fn: async () => { conflicts.push(...await this._syncProjects(cloudState.projects || {})); } },
        { key: 'timeTracking', fn: async () => { await this._syncTimeTracking(cloudState.timeTracking || {}); } },
        { key: 'conversations', fn: async () => { await this._syncConversations(cloudState.conversations || {}); } },
        { key: 'skills', fn: async () => { await this._syncDirectoryEntities('skills', SKILLS_DIR, cloudState.skills || {}); } },
        { key: 'agents', fn: async () => { await this._syncDirectoryEntities('agents', AGENTS_DIR, cloudState.agents || {}); } },
        { key: 'mcpConfigs', fn: async () => { conflicts.push(...await this._syncMcpConfigs(cloudState.mcpConfigs || {})); } },
        { key: 'keybindings', fn: async () => { conflicts.push(...await this._syncWholeFile('keybindings', KEYBINDINGS_FILE, cloudState.keybindings || null)); } },
        { key: 'memory', fn: async () => { conflicts.push(...await this._syncWholeFile('memory', MEMORY_FILE, cloudState.memory || null, true)); } },
        { key: 'hooksConfig', fn: async () => { conflicts.push(...await this._syncWholeFile('hooksConfig', CLAUDE_SETTINGS_FILE, cloudState.hooksConfig || null)); } },
        { key: 'timeTrackingArchives', fn: async () => { await this._syncTimeTrackingArchives(cloudState.timeTrackingArchives || {}); } },
        { key: 'installedPlugins', fn: async () => { await this._syncInstalledPlugins(cloudState.installedPlugins || null); } },
      ];

      const errors = [];
      for (const { key, fn } of syncSteps) {
        if (!this.active) break;
        if (toggles[key] === false) continue;
        emitProgress(key);
        try {
          await fn();
        } catch (stepErr) {
          console.error(`[SyncEngine] Sync step "${key}" failed:`, stepErr.message);
          errors.push({ key, message: stepErr.message });
        }
        this._saveManifest();
      }

      // Handle conflicts
      if (this.active && conflicts.length > 0 && this._onConflict) {
        const resolutions = await this._onConflict(conflicts);
        await this._applyResolutions(resolutions);
      }

      this.manifest.lastFullSync = Date.now();
      this._saveManifest();
      didEmitFinal = true;
      if (errors.length > 0) {
        this._emitStatus('full-sync', 'completed', { conflicts: conflicts.length, errors: errors.length });
        return { ok: true, conflicts: conflicts.length, errors };
      }
      this._emitStatus('full-sync', 'completed', { conflicts: conflicts.length });
      return { ok: true, conflicts: conflicts.length };
    } catch (err) {
      console.error('[SyncEngine] Full sync failed:', err.message);
      didEmitFinal = true;
      this._emitStatus('full-sync', 'error', err.message);
      return { ok: false, reason: 'error', message: err.message };
    } finally {
      this._syncing = false;
      if (!didEmitFinal) {
        this._emitStatus('full-sync', 'completed', { aborted: true });
      }
    }
  }

  // ── Incremental push (local change → cloud) ──

  /**
   * Notify the engine that a local entity changed.
   * Debounced push to cloud.
   * @param {'settings'|'projects'|'timeTracking'|'conversations'|'skills'|'agents'|'mcpConfigs'|'keybindings'|'memory'|'hooksConfig'|'timeTrackingArchives'|'installedPlugins'} entityType
   * @param {string} [entityId] - specific key/id that changed (optional)
   */
  notifyLocalChange(entityType, entityId) {
    if (!this.active) return;
    if (!this._isEntityEnabled(entityType)) return;

    const debounceKey = entityId ? `${entityType}.${entityId}` : entityType;
    const debounceMs = entityType === 'conversations' ? CONVERSATION_SYNC_DEBOUNCE_MS
      : (entityType === 'skills' || entityType === 'agents') ? FILE_SYNC_DEBOUNCE_MS
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
    if (!this.active || !this._serverSupportsSync) return;
    if (!this._isEntityEnabled(entityType)) return;

    try {
      const data = this._readLocalEntity(entityType, entityId);
      if (data === null) return;

      const entityKey = entityId ? `${entityType}.${entityId}` : entityType;
      const body = JSON.stringify({
        machineId: getMachineId(),
        entityType,
        entityId: entityId || null,
        data,
        hash: this._hash(JSON.stringify(data)),
        timestamp: Date.now(),
      });

      // Skip if payload too large (> 5MB) to avoid 413 errors
      if (body.length > 5 * 1024 * 1024) {
        console.warn(`[SyncEngine] Skipping push for ${entityKey}: payload too large (${(body.length / 1024 / 1024).toFixed(1)}MB)`);
        return;
      }

      const resp = await this._fetchCloud('/api/sync/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (resp.ok) {
        this.manifest.entities[entityKey] = {
          localHash: this._hash(JSON.stringify(data)),
          cloudHash: this._hash(JSON.stringify(data)),
          lastSyncAt: Date.now(),
        };
        this._saveManifest();
        this._emitStatus('push', 'completed', { entityType, entityId });
      } else if (resp.status === 413) {
        console.warn(`[SyncEngine] Server rejected ${entityKey}: payload too large (413)`);
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
        // Cloud doesn't have this key → push local (not a conflict)
        if (cloudVal === undefined || !cloudSettings[key]) {
          await this._pushEntity('settings', key);
        } else {
          // True conflict: both sides have different values
          conflicts.push({
            entityType: 'settings',
            entityId: key,
            localValue: localVal,
            cloudValue: cloudVal,
            cloudTimestamp,
            localTimestamp: manifestEntry?.lastSyncAt || 0,
          });
        }
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
    const claudeDir = path.join(os.homedir(), '.claude');
    if (!fs.existsSync(claudeDir)) return;

    // Cloud → local: record cloud conversation metadata
    for (const [sessionId, cloudMeta] of Object.entries(cloudConversations)) {
      const entityKey = `conversations.${sessionId}`;
      this.manifest.entities[entityKey] = {
        localHash: null,
        cloudHash: this._hash(JSON.stringify(cloudMeta)),
        lastSyncAt: Date.now(),
        cloudLineCount: cloudMeta.lines || 0,
      };
    }

    // Local → cloud: push local sessions not in cloud (recent ones only)
    const projectsDir = path.join(claudeDir, 'projects');
    if (!fs.existsSync(projectsDir)) return;

    try {
      const projectDirs = fs.readdirSync(projectsDir);
      for (const projDir of projectDirs) {
        const projPath = path.join(projectsDir, projDir);
        try {
          if (!fs.statSync(projPath).isDirectory()) continue;
          const files = fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl'));
          for (const file of files) {
            const sessionId = file.replace('.jsonl', '');
            if (cloudConversations[sessionId]) continue; // Already in cloud
            const entityKey = `conversations.${sessionId}`;
            if (this.manifest.entities[entityKey]?.cloudLineCount > 0) continue; // Already pushed
            const filePath = path.join(projPath, file);
            try {
              const stat = fs.statSync(filePath);
              // Only push sessions from last 7 days to avoid flooding
              if (Date.now() - stat.mtimeMs > 7 * 24 * 60 * 60 * 1000) continue;
              await this.pushConversation(sessionId, filePath);
            } catch {}
          }
        } catch {}
      }
    } catch {}
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
      // Skip files larger than 5MB to avoid 413 errors
      const stat = fs.statSync(filePath);
      if (stat.size > 5 * 1024 * 1024) {
        console.warn(`[SyncEngine] Skipping conversation ${sessionId}: file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
        return;
      }

      const entityKey = `conversations.${sessionId}`;
      const manifestEntry = this.manifest.entities[entityKey];
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      const lastSyncedLineCount = manifestEntry?.cloudLineCount || 0;

      // Only send new lines (append-only)
      const newLines = lines.slice(lastSyncedLineCount);
      if (newLines.length === 0) return;

      const payload = JSON.stringify({
        machineId: getMachineId(),
        appendLines: newLines.join('\n'),
        totalLineCount: lines.length,
        timestamp: Date.now(),
      });

      // Double-check serialized size
      if (payload.length > 5 * 1024 * 1024) {
        console.warn(`[SyncEngine] Skipping conversation ${sessionId}: payload too large`);
        return;
      }

      const resp = await this._fetchCloud(`/api/sync/conversation/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });

      if (resp.ok) {
        this.manifest.entities[entityKey] = {
          localHash: this._hash(content),
          cloudHash: this._hash(content),
          lastSyncAt: Date.now(),
          cloudLineCount: lines.length,
        };
        this._saveManifest();
      } else if (resp.status === 413) {
        console.warn(`[SyncEngine] Server rejected conversation ${sessionId}: payload too large (413)`);
      }
    } catch (err) {
      console.warn(`[SyncEngine] Push conversation ${sessionId} failed:`, err.message);
    }
  }

  // ── Skills & Agents sync (per-directory, auto-resolve) ──

  /**
   * Sync a directory-based entity type (skills or agents).
   * Each subdirectory is one entity. Files inside are serialized as {files: {path: content}}.
   * Strategy: last-write-wins (auto-resolve, no conflict modal).
   * @param {'skills'|'agents'} entityType
   * @param {string} localDir
   * @param {Object} cloudEntities - { "entity-name": { files: {}, hash, updatedAt } }
   */
  async _syncDirectoryEntities(entityType, localDir, cloudEntities) {
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }

    // Read local entities
    const localEntities = this._readDirectoryEntities(localDir);
    let cloudApplied = false;

    // Cloud → local: add or update items we don't have or that are newer
    for (const [name, cloudEntry] of Object.entries(cloudEntities)) {
      const entityKey = `${entityType}.${name}`;
      const manifestEntry = this.manifest.entities[entityKey];
      const localEntity = localEntities[name];
      const cloudHash = cloudEntry.hash || this._hash(JSON.stringify(cloudEntry.files));

      if (!localEntity) {
        // Cloud has it, we don't → write locally
        this._writeDirectoryEntity(localDir, name, cloudEntry.files);
        this.manifest.entities[entityKey] = { localHash: cloudHash, cloudHash, lastSyncAt: Date.now() };
        cloudApplied = true;
        continue;
      }

      const localHash = this._hash(JSON.stringify(localEntity));

      if (localHash === cloudHash) {
        this.manifest.entities[entityKey] = { localHash, cloudHash, lastSyncAt: Date.now() };
        continue;
      }

      // Both exist, different → last-write-wins by timestamp
      const cloudTime = cloudEntry.updatedAt || 0;
      const localTime = manifestEntry?.lastSyncAt || 0;

      if (cloudTime > localTime) {
        // Cloud is newer → overwrite local
        this._writeDirectoryEntity(localDir, name, cloudEntry.files);
        this.manifest.entities[entityKey] = { localHash: cloudHash, cloudHash, lastSyncAt: Date.now() };
        cloudApplied = true;
      } else {
        // Local is newer → push to cloud
        await this._pushEntity(entityType, name);
      }
    }

    // Local → cloud: push items cloud doesn't have
    for (const [name, localFiles] of Object.entries(localEntities)) {
      if (!cloudEntities[name]) {
        await this._pushEntity(entityType, name);
      }
    }

    // Notify renderer to reload if cloud updated local files
    if (cloudApplied) {
      this._sendToRenderer(`sync:${entityType}-updated`);
    }
  }

  /**
   * Read all subdirectories in a dir as entities.
   * @returns {Object} { "entity-name": { "file.md": "content", ... } }
   */
  _readDirectoryEntities(dir) {
    const entities = {};
    try {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const itemPath = path.join(dir, item);
        try {
          const stat = fs.statSync(itemPath);
          if (stat.isDirectory()) {
            entities[item] = this._readDirFiles(itemPath);
          } else if (item.endsWith('.md')) {
            // Top-level .md files (like standalone skills/agents)
            entities[item] = { [item]: fs.readFileSync(itemPath, 'utf8') };
          }
        } catch {}
      }
    } catch {}
    return entities;
  }

  /**
   * Read all files in a directory recursively (shallow, max 2 levels).
   * @returns {Object} { "SKILL.md": "content", "sub/file.js": "content" }
   */
  _readDirFiles(dir, prefix = '') {
    const files = {};
    try {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const relPath = prefix ? `${prefix}/${item}` : item;
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            Object.assign(files, this._readDirFiles(fullPath, relPath));
          } else if (stat.size < 512 * 1024) { // Skip files > 512KB
            files[relPath] = fs.readFileSync(fullPath, 'utf8');
          }
        } catch {}
      }
    } catch {}
    return files;
  }

  /**
   * Write an entity's files to a subdirectory.
   */
  _writeDirectoryEntity(baseDir, name, files) {
    const entityDir = path.join(baseDir, name);
    try {
      if (!fs.existsSync(entityDir)) {
        fs.mkdirSync(entityDir, { recursive: true });
      }
      for (const [relPath, content] of Object.entries(files || {})) {
        const fullPath = path.join(entityDir, relPath);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf8');
      }
    } catch (err) {
      console.warn(`[SyncEngine] Failed to write ${name} to ${baseDir}:`, err.message);
    }
  }

  // ── Whole-file sync (keybindings, memory, hooksConfig) ──

  /**
   * Sync a single whole-file entity.
   * @param {string} entityType
   * @param {string} filePath
   * @param {object|null} cloudData - { value, hash, updatedAt }
   * @param {boolean} [isText=false] - if true, read/write as raw text instead of JSON
   * @returns {Array} conflicts
   */
  async _syncWholeFile(entityType, filePath, cloudData, isText = false) {
    const conflicts = [];
    const entityKey = entityType;
    const manifestEntry = this.manifest.entities[entityKey];

    // Read local
    const localValue = this._readWholeFile(filePath, isText);
    const cloudValue = cloudData?.value ?? null;
    const cloudTimestamp = cloudData?.updatedAt || 0;

    const localHash = this._hash(typeof localValue === 'string' ? localValue : JSON.stringify(localValue));
    const cloudHash = cloudData?.hash || this._hash(typeof cloudValue === 'string' ? cloudValue : JSON.stringify(cloudValue));

    // Both null/missing — nothing to sync, but mark as consistent
    if (localValue === null && cloudValue === null) {
      this.manifest.entities[entityKey] = { localHash: null, cloudHash: null, lastSyncAt: Date.now() };
      return conflicts;
    }

    // Same content
    if (localHash === cloudHash) {
      this.manifest.entities[entityKey] = { localHash, cloudHash, lastSyncAt: Date.now() };
      return conflicts;
    }

    const localChanged = !manifestEntry?.localHash || localHash !== manifestEntry.localHash;
    const cloudChanged = !manifestEntry?.cloudHash || cloudHash !== manifestEntry.cloudHash;

    if (localChanged && cloudChanged) {
      // Cloud doesn't have this entity → push local (not a conflict)
      if (cloudValue === null || cloudData === null) {
        await this._pushEntity(entityType);
      } else {
        // True conflict: both sides have different values
        conflicts.push({
          entityType,
          entityId: null,
          localValue: isText ? (localValue || '').slice(0, 200) : localValue,
          cloudValue: isText ? (cloudValue || '').slice(0, 200) : cloudValue,
          cloudTimestamp,
          localTimestamp: manifestEntry?.lastSyncAt || 0,
        });
      }
    } else if (cloudChanged && cloudValue !== null) {
      // Cloud wins → apply locally
      this._writeWholeFile(filePath, cloudValue, isText);
      this.manifest.entities[entityKey] = { localHash: cloudHash, cloudHash, lastSyncAt: Date.now() };
      this._sendToRenderer(`sync:${entityType}-updated`);
    } else if (localChanged) {
      // Local wins → push to cloud
      await this._pushEntity(entityType);
    }

    return conflicts;
  }

  _readWholeFile(filePath, isText = false) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const content = fs.readFileSync(filePath, 'utf8');
      return isText ? content : JSON.parse(content);
    } catch {
      return null;
    }
  }

  _writeWholeFile(filePath, data, isText = false) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const content = isText ? data : JSON.stringify(data, null, 2);
      const tmpFile = filePath + '.tmp';
      fs.writeFileSync(tmpFile, content, 'utf8');
      fs.renameSync(tmpFile, filePath);
    } catch (err) {
      console.error(`[SyncEngine] Failed to write ${filePath}:`, err.message);
    }
  }

  // ── Time tracking archives sync (per-file, additive) ──

  /**
   * Sync time tracking archives.
   * Archives are stored as YYYY/month.json or YYYY/MM/archive-data.json.
   * Strategy: additive merge per archive file (like timeTracking).
   */
  async _syncTimeTrackingArchives(cloudArchives) {
    // cloudArchives: { "2025/01": { data, hash, updatedAt }, ... }
    const localArchives = this._readArchiveEntities();

    // Cloud → local
    for (const [archiveKey, cloudEntry] of Object.entries(cloudArchives)) {
      const entityKey = `timeTrackingArchives.${archiveKey}`;
      const localData = localArchives[archiveKey];
      const cloudHash = cloudEntry.hash || this._hash(JSON.stringify(cloudEntry.data));

      if (!localData) {
        // Cloud has it, we don't → write locally
        this._writeArchiveFile(archiveKey, cloudEntry.data);
        this.manifest.entities[entityKey] = { localHash: cloudHash, cloudHash, lastSyncAt: Date.now() };
        continue;
      }

      const localHash = this._hash(JSON.stringify(localData));
      if (localHash === cloudHash) {
        this.manifest.entities[entityKey] = { localHash, cloudHash, lastSyncAt: Date.now() };
        continue;
      }

      // Both exist, different → merge additively (combine sessions, dedup)
      const merged = this._mergeTimeTracking(localData, cloudEntry.data);
      this._writeArchiveFile(archiveKey, merged);
      const mergedHash = this._hash(JSON.stringify(merged));
      this.manifest.entities[entityKey] = { localHash: mergedHash, cloudHash: mergedHash, lastSyncAt: Date.now() };
      await this._pushEntity('timeTrackingArchives', archiveKey);
    }

    // Local → cloud: push archives cloud doesn't have
    for (const [archiveKey] of Object.entries(localArchives)) {
      if (!cloudArchives[archiveKey]) {
        await this._pushEntity('timeTrackingArchives', archiveKey);
      }
    }
  }

  /**
   * Read all archive files from both old and new format.
   * @returns {Object} { "2025/01": data, "2025/february": data, ... }
   */
  _readArchiveEntities() {
    const archives = {};

    // New format: ~/.claude-terminal/timetracking/YYYY/month.json
    if (fs.existsSync(TIMETRACKING_DIR)) {
      try {
        for (const yearDir of fs.readdirSync(TIMETRACKING_DIR)) {
          const yearPath = path.join(TIMETRACKING_DIR, yearDir);
          if (!fs.statSync(yearPath).isDirectory()) continue;
          for (const file of fs.readdirSync(yearPath)) {
            if (!file.endsWith('.json')) continue;
            try {
              const data = JSON.parse(fs.readFileSync(path.join(yearPath, file), 'utf8'));
              archives[`${yearDir}/${file.replace('.json', '')}`] = data;
            } catch {}
          }
        }
      } catch {}
    }

    // Legacy format: ~/.claude-terminal/archives/YYYY/MM/archive-data.json
    if (fs.existsSync(ARCHIVES_DIR)) {
      try {
        for (const yearDir of fs.readdirSync(ARCHIVES_DIR)) {
          const yearPath = path.join(ARCHIVES_DIR, yearDir);
          if (!fs.statSync(yearPath).isDirectory()) continue;
          for (const monthDir of fs.readdirSync(yearPath)) {
            const archiveFile = path.join(yearPath, monthDir, 'archive-data.json');
            if (!fs.existsSync(archiveFile)) continue;
            try {
              const data = JSON.parse(fs.readFileSync(archiveFile, 'utf8'));
              archives[`legacy/${yearDir}/${monthDir}`] = data;
            } catch {}
          }
        }
      } catch {}
    }

    return archives;
  }

  _writeArchiveFile(archiveKey, data) {
    try {
      let filePath;
      if (archiveKey.startsWith('legacy/')) {
        // Legacy: archives/YYYY/MM/archive-data.json
        const parts = archiveKey.replace('legacy/', '').split('/');
        filePath = path.join(ARCHIVES_DIR, parts[0], parts[1], 'archive-data.json');
      } else {
        // New: timetracking/YYYY/month.json
        const parts = archiveKey.split('/');
        filePath = path.join(TIMETRACKING_DIR, parts[0], `${parts[1]}.json`);
      }
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpFile = filePath + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpFile, filePath);
    } catch (err) {
      console.warn(`[SyncEngine] Failed to write archive ${archiveKey}:`, err.message);
    }
  }

  // ── Installed plugins sync (merge plugin lists) ──

  async _syncInstalledPlugins(cloudData) {
    // cloudData: { value: { plugins: [...] }, hash, updatedAt }
    const localPlugins = this._readWholeFile(INSTALLED_PLUGINS_FILE);
    const cloudPlugins = cloudData?.value ?? null;
    const entityKey = 'installedPlugins';

    if (!localPlugins && !cloudPlugins) return;

    if (!localPlugins && cloudPlugins) {
      // Cloud has plugins, we don't → write locally
      this._writeWholeFile(INSTALLED_PLUGINS_FILE, cloudPlugins);
      const h = this._hash(JSON.stringify(cloudPlugins));
      this.manifest.entities[entityKey] = { localHash: h, cloudHash: h, lastSyncAt: Date.now() };
      this._sendToRenderer('sync:plugins-updated');
      return;
    }

    if (localPlugins && !cloudPlugins) {
      // We have plugins, cloud doesn't → push
      await this._pushEntity('installedPlugins');
      return;
    }

    // Both exist → merge plugin arrays (union by name)
    const merged = this._mergePluginLists(localPlugins, cloudPlugins);
    this._writeWholeFile(INSTALLED_PLUGINS_FILE, merged);
    const mergedHash = this._hash(JSON.stringify(merged));
    this.manifest.entities[entityKey] = { localHash: mergedHash, cloudHash: mergedHash, lastSyncAt: Date.now() };
    await this._pushEntity('installedPlugins');
    this._sendToRenderer('sync:plugins-updated');
  }

  /**
   * Merge two installed_plugins.json structures.
   * Format v2: { version: 2, plugins: { "name@marketplace": [{ scope, installPath, ... }] } }
   * Fallback: { plugins: [...] } or plain array (legacy)
   */
  _mergePluginLists(local, cloud) {
    const localPlugins = local?.plugins;
    const cloudPlugins = cloud?.plugins;

    // v2 format: plugins is an object (Record<string, array>)
    if (localPlugins && typeof localPlugins === 'object' && !Array.isArray(localPlugins)) {
      const merged = { ...(local || {}), plugins: { ...localPlugins } };
      if (cloudPlugins && typeof cloudPlugins === 'object' && !Array.isArray(cloudPlugins)) {
        for (const [key, value] of Object.entries(cloudPlugins)) {
          if (!merged.plugins[key]) {
            merged.plugins[key] = value;
          }
          // If both have it, keep local
        }
      }
      return merged;
    }

    // Legacy array format fallback
    const localList = Array.isArray(local) ? local : (Array.isArray(localPlugins) ? localPlugins : []);
    const cloudList = Array.isArray(cloud) ? cloud : (Array.isArray(cloudPlugins) ? cloudPlugins : []);

    const merged = new Map();
    for (const p of localList) {
      const key = p.name || p.id || JSON.stringify(p);
      merged.set(key, p);
    }
    for (const p of cloudList) {
      const key = p.name || p.id || JSON.stringify(p);
      if (!merged.has(key)) {
        merged.set(key, p);
      }
    }

    const result = Array.from(merged.values());
    return Array.isArray(local) ? result : { ...(local || {}), plugins: result };
  }

  // ── MCP Configs sync (per-key, like settings) ──

  async _syncMcpConfigs(cloudMcpConfigs) {
    const conflicts = [];
    const localConfig = this._readMcpConfig();
    const localServers = localConfig.mcpServers || {};

    for (const key of Object.keys({ ...localServers, ...cloudMcpConfigs })) {
      const entityKey = `mcpConfigs.${key}`;
      const manifestEntry = this.manifest.entities[entityKey];
      const localVal = localServers[key];
      const cloudVal = cloudMcpConfigs[key]?.value;
      const cloudTimestamp = cloudMcpConfigs[key]?.updatedAt || 0;

      const localHash = this._hash(JSON.stringify(localVal));
      const cloudHash = this._hash(JSON.stringify(cloudVal));

      if (localHash === cloudHash) {
        this.manifest.entities[entityKey] = { localHash, cloudHash, lastSyncAt: Date.now() };
        continue;
      }

      const lastSyncHash = manifestEntry?.localHash;
      const localChanged = !lastSyncHash || localHash !== lastSyncHash;
      const cloudChanged = !manifestEntry?.cloudHash || cloudHash !== manifestEntry.cloudHash;

      if (localChanged && cloudChanged) {
        // Cloud doesn't have this key → push local (not a conflict)
        if (cloudVal === undefined || !cloudMcpConfigs[key]) {
          await this._pushEntity('mcpConfigs', key);
        } else {
          conflicts.push({
            entityType: 'mcpConfigs',
            entityId: key,
            localValue: localVal,
            cloudValue: cloudVal,
            cloudTimestamp,
            localTimestamp: manifestEntry?.lastSyncAt || 0,
          });
        }
      } else if (cloudChanged && cloudVal !== undefined) {
        localServers[key] = cloudVal;
        this.manifest.entities[entityKey] = { localHash: cloudHash, cloudHash, lastSyncAt: Date.now() };
      } else if (localChanged) {
        await this._pushEntity('mcpConfigs', key);
      }
    }

    this._writeMcpConfig({ ...localConfig, mcpServers: localServers });
    return conflicts;
  }

  _readMcpConfig() {
    try {
      if (fs.existsSync(MCP_CONFIG_FILE)) {
        return JSON.parse(fs.readFileSync(MCP_CONFIG_FILE, 'utf8'));
      }
    } catch {}
    return { mcpServers: {} };
  }

  _writeMcpConfig(config) {
    try {
      const tmpFile = MCP_CONFIG_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), 'utf8');
      fs.renameSync(tmpFile, MCP_CONFIG_FILE);
    } catch (err) {
      console.error('[SyncEngine] Failed to write MCP config:', err.message);
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
    } else if (entityType === 'mcpConfigs' && entityId) {
      const config = this._readMcpConfig();
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers[entityId] = cloudValue;
      this._writeMcpConfig(config);
      this._sendToRenderer('sync:mcp-updated', { key: entityId });
    } else if (entityType === 'keybindings') {
      this._writeWholeFile(KEYBINDINGS_FILE, cloudValue);
      this._sendToRenderer('sync:keybindings-updated');
    } else if (entityType === 'memory') {
      this._writeWholeFile(MEMORY_FILE, cloudValue, true);
      this._sendToRenderer('sync:memory-updated');
    } else if (entityType === 'hooksConfig') {
      this._writeWholeFile(CLAUDE_SETTINGS_FILE, cloudValue);
      this._sendToRenderer('sync:hooksConfig-updated');
    }
  }

  // ── Cloud API helpers ──

  async _fetchCloudState() {
    try {
      const resp = await this._fetchCloud('/api/sync/state', { method: 'GET' });
      if (!resp.ok) {
        // 404 = server doesn't have sync endpoints
        if (resp.status === 404) {
          this._serverSupportsSync = false;
          console.warn('[SyncEngine] Server does not support entity sync (404). Disabling.');
        }
        return null;
      }

      // Check content-type before parsing
      const ct = resp.headers?.get('content-type') || '';
      if (!ct.includes('application/json')) {
        const text = await resp.text();
        if (text.startsWith('<!') || text.startsWith('<html')) {
          this._serverSupportsSync = false;
          console.warn('[SyncEngine] Server returned HTML instead of JSON. Sync endpoints not available.');
          return null;
        }
        // Try parsing anyway (some servers don't set content-type)
        try { return JSON.parse(text); } catch { return null; }
      }

      const data = await resp.json();
      this._syncFailures = 0;
      return data;
    } catch (err) {
      this._syncFailures++;
      // Don't permanently disable sync for transient network errors — just log and let next attempt retry
      console.warn(`[SyncEngine] Failed to fetch cloud state (attempt ${this._syncFailures}):`, err.message);
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
    if (entityType === 'skills') {
      if (entityId) {
        const entityDir = path.join(SKILLS_DIR, entityId);
        return fs.existsSync(entityDir) ? this._readDirFiles(entityDir) : null;
      }
      return this._readDirectoryEntities(SKILLS_DIR);
    }
    if (entityType === 'agents') {
      if (entityId) {
        const entityDir = path.join(AGENTS_DIR, entityId);
        return fs.existsSync(entityDir) ? this._readDirFiles(entityDir) : null;
      }
      return this._readDirectoryEntities(AGENTS_DIR);
    }
    if (entityType === 'mcpConfigs') {
      const config = this._readMcpConfig();
      return entityId ? (config.mcpServers || {})[entityId] : config.mcpServers;
    }
    if (entityType === 'keybindings') {
      return this._readWholeFile(KEYBINDINGS_FILE);
    }
    if (entityType === 'memory') {
      return this._readWholeFile(MEMORY_FILE, true);
    }
    if (entityType === 'hooksConfig') {
      return this._readWholeFile(CLAUDE_SETTINGS_FILE);
    }
    if (entityType === 'timeTrackingArchives') {
      if (entityId) {
        const archives = this._readArchiveEntities();
        return archives[entityId] || null;
      }
      return this._readArchiveEntities();
    }
    if (entityType === 'installedPlugins') {
      return this._readWholeFile(INSTALLED_PLUGINS_FILE);
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
