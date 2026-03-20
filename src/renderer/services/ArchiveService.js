/**
 * Archive Service
 * Manages monthly time tracking session archives
 * Archives are stored in ~/.claude-terminal/timetracking/YYYY/month.json
 */

const { BaseService } = require('../core/BaseService');
const { timeTrackingDir, archivesDir, timeTrackingFile } = require('../utils/paths');

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];

const MAX_CACHE_SIZE = 3;

class ArchiveService extends BaseService {
  constructor(api, container) {
    super(api, container);
    this._cache = new Map();
  }

  getArchiveFilePath(year, month) {
    return this.api.path.join(timeTrackingDir, String(year), `${MONTH_NAMES[month]}.json`);
  }

  isCurrentMonth(year, month) {
    const now = new Date();
    return year === now.getFullYear() && month === now.getMonth();
  }

  async loadArchive(year, month) {
    const key = _getCacheKey(year, month);
    if (this._cache.has(key)) return this._cache.get(key).data;

    const filePath = this.getArchiveFilePath(year, month);
    const data = await this._readFromDisk(filePath);

    if (data) {
      if (this._cache.size >= MAX_CACHE_SIZE) {
        let oldestKey = null, oldestTime = Infinity;
        for (const [k, v] of this._cache) {
          if (v.loadedAt < oldestTime) { oldestTime = v.loadedAt; oldestKey = k; }
        }
        if (oldestKey) this._cache.delete(oldestKey);
      }
      this._cache.set(key, { data, loadedAt: Date.now() });
    }
    return data;
  }

  writeArchive(year, month, archiveData) {
    this._ensureYearDir(year);
    const filePath = this.getArchiveFilePath(year, month);
    const tempFile = `${filePath}.tmp`;
    try {
      this.api.fs.writeFileSync(tempFile, JSON.stringify(archiveData, null, 2));
      this.api.fs.renameSync(tempFile, filePath);
    } catch (error) {
      console.error('[ArchiveService] Failed to write archive:', filePath, error.message);
      try { if (this.api.fs.existsSync(tempFile)) this.api.fs.unlinkSync(tempFile); } catch (_) {}
    }
  }

  archiveCurrentFile(monthStr) {
    try {
      if (!this.api.fs.existsSync(timeTrackingFile)) return;
      const [yearStr, monthNumStr] = monthStr.split('-');
      const year = parseInt(yearStr, 10);
      const month = parseInt(monthNumStr, 10) - 1;

      this._ensureYearDir(year);
      const destPath = this.getArchiveFilePath(year, month);

      if (this.api.fs.existsSync(destPath)) {
        const existing = JSON.parse(this.api.fs.readFileSync(destPath, 'utf8'));
        const current = JSON.parse(this.api.fs.readFileSync(timeTrackingFile, 'utf8'));
        const merged = this._mergeArchives(existing, current, monthStr);
        const tempFile = `${destPath}.tmp`;
        this.api.fs.writeFileSync(tempFile, JSON.stringify(merged, null, 2));
        this.api.fs.renameSync(tempFile, destPath);
      } else {
        this.api.fs.copyFileSync(timeTrackingFile, destPath);
      }

      this.invalidateArchiveCache(year, month);
      console.debug(`[ArchiveService] Archived ${monthStr} → ${destPath}`);
    } catch (error) {
      console.error('[ArchiveService] Failed to archive current file:', error.message);
    }
  }

  async appendToArchive(year, month, globalSessions, projectSessionsMap) {
    const filePath = this.getArchiveFilePath(year, month);
    let archive = await this._readFromDisk(filePath);
    if (!archive) archive = _createEmptyArchive(year, month);

    if (globalSessions && globalSessions.length > 0) {
      const existingIds = new Set(archive.globalSessions.map(s => s.id));
      for (const session of globalSessions) {
        if (!existingIds.has(session.id)) archive.globalSessions.push(session);
      }
    }

    if (projectSessionsMap) {
      for (const [projectId, data] of Object.entries(projectSessionsMap)) {
        if (!archive.projectSessions[projectId]) {
          archive.projectSessions[projectId] = { projectName: data.projectName || 'Unknown', sessions: [] };
        }
        const existingIds = new Set(archive.projectSessions[projectId].sessions.map(s => s.id));
        for (const session of data.sessions) {
          if (!existingIds.has(session.id)) archive.projectSessions[projectId].sessions.push(session);
        }
        if (data.projectName) archive.projectSessions[projectId].projectName = data.projectName;
      }
    }

    archive.lastModifiedAt = new Date().toISOString();
    this.writeArchive(year, month, archive);
    this.invalidateArchiveCache(year, month);
  }

  async getArchivedGlobalSessions(year, month) {
    return (await this.loadArchive(year, month))?.globalSessions || [];
  }

  async getArchivedProjectSessions(year, month, projectId) {
    return (await this.loadArchive(year, month))?.projectSessions?.[projectId]?.sessions || [];
  }

  async getArchivedAllProjectSessions(year, month) {
    return (await this.loadArchive(year, month))?.projectSessions || {};
  }

  invalidateArchiveCache(year, month) {
    this._cache.delete(_getCacheKey(year, month));
  }

  clearArchiveCache() {
    this._cache.clear();
  }

  getMonthsInRange(periodStart, periodEnd) {
    const months = [];
    const start = new Date(periodStart.getFullYear(), periodStart.getMonth(), 1);
    const end = new Date(periodEnd);
    while (start < end) {
      months.push({ year: start.getFullYear(), month: start.getMonth() });
      start.setMonth(start.getMonth() + 1);
    }
    return months;
  }

  async migrateOldArchives() {
    try {
      if (!this.api.fs.existsSync(archivesDir)) return;
      const files = this.api.fs.readdirSync(archivesDir);
      if (files.length === 0) {
        try { this.api.fs.rmdirSync(archivesDir); } catch (_) {}
        return;
      }

      let migratedCount = 0;
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const match = file.match(/^([a-z]+)_(\d{4})\.json$/);
        if (!match) continue;
        const monthIndex = MONTH_NAMES.indexOf(match[1]);
        if (monthIndex === -1) continue;
        const year = parseInt(match[2], 10);

        const oldPath = this.api.path.join(archivesDir, file);
        const newPath = this.getArchiveFilePath(year, monthIndex);

        if (this.api.fs.existsSync(newPath)) {
          try { this.api.fs.unlinkSync(oldPath); } catch (_) {}
          continue;
        }

        const data = await this._readFromDisk(oldPath);
        if (data) {
          this._ensureYearDir(year);
          try {
            this.api.fs.writeFileSync(newPath, JSON.stringify(data, null, 2));
            this.api.fs.unlinkSync(oldPath);
            migratedCount++;
          } catch (err) {
            console.warn('[ArchiveService] Failed to migrate:', file, err.message);
          }
        }
      }

      try {
        if (this.api.fs.readdirSync(archivesDir).length === 0) this.api.fs.rmdirSync(archivesDir);
      } catch (_) {}

      if (migratedCount > 0) console.debug(`[ArchiveService] Migrated ${migratedCount} archive(s)`);
    } catch (error) {
      console.warn('[ArchiveService] Migration error:', error.message);
    }
  }

  // ── Private ──

  _ensureYearDir(year) {
    const yearDir = this.api.path.join(timeTrackingDir, String(year));
    if (!this.api.fs.existsSync(yearDir)) this.api.fs.mkdirSync(yearDir, { recursive: true });
  }

  async _readFromDisk(filePath) {
    try {
      if (!this.api.fs.existsSync(filePath)) return null;
      const content = await this.api.fs.promises.readFile(filePath, 'utf8');
      if (!content || !content.trim()) return null;
      return _normalizeArchive(JSON.parse(content));
    } catch (error) {
      console.warn('[ArchiveService] Failed to read archive:', filePath, error.message);
      return null;
    }
  }

  _mergeArchives(existing, current, monthStr) {
    const normalized = _normalizeArchive(existing);
    const currentNorm = _normalizeArchive(current);

    const globalById = new Map();
    (normalized.globalSessions || []).forEach(s => globalById.set(s.id, s));
    (currentNorm.globalSessions || []).forEach(s => globalById.set(s.id, s));
    const globalSessions = [...globalById.values()].sort((a, b) => a.startTime.localeCompare(b.startTime));

    const projectSessions = { ...(normalized.projectSessions || {}) };
    for (const [pid, data] of Object.entries(currentNorm.projectSessions || {})) {
      if (!projectSessions[pid]) {
        projectSessions[pid] = { projectName: data.projectName, sessions: [] };
      } else if (data.projectName) {
        projectSessions[pid].projectName = data.projectName;
      }
      const existingIds = new Set(projectSessions[pid].sessions.map(s => s.id));
      for (const s of data.sessions) {
        if (!existingIds.has(s.id)) projectSessions[pid].sessions.push(s);
      }
      projectSessions[pid].sessions.sort((a, b) => a.startTime.localeCompare(b.startTime));
    }

    return {
      version: 1, month: monthStr,
      createdAt: normalized.createdAt || new Date().toISOString(),
      lastModifiedAt: new Date().toISOString(),
      globalSessions, projectSessions
    };
  }
}

// ── Static helpers ──

function _getCacheKey(year, month) {
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

function _createEmptyArchive(year, month) {
  return {
    version: 1, month: _getCacheKey(year, month),
    createdAt: new Date().toISOString(), lastModifiedAt: new Date().toISOString(),
    globalSessions: [], projectSessions: {}
  };
}

function _normalizeArchive(data) {
  if (!data) return null;
  if (data.version === 3 || (data.global && !data.globalSessions)) {
    const projectSessions = {};
    for (const [pid, pData] of Object.entries(data.projects || {})) {
      if (pData.sessions?.length > 0) {
        projectSessions[pid] = { projectName: pData.projectName || pid, sessions: pData.sessions };
      }
    }
    return {
      version: 1, month: data.month,
      createdAt: data.createdAt || new Date().toISOString(),
      lastModifiedAt: data.lastModifiedAt || new Date().toISOString(),
      globalSessions: data.global?.sessions || [], projectSessions
    };
  }
  return data;
}

// ── Lazy singleton + legacy exports ──

let _instance = null;

function _getInstance() {
  if (!_instance) {
    const { getApiProvider, getContainer } = require('../core');
    _instance = new ArchiveService(getApiProvider(), getContainer());
  }
  return _instance;
}

module.exports = {
  ArchiveService,
  getInstance: _getInstance,
  getArchiveFilePath: (...a) => _getInstance().getArchiveFilePath(...a),
  isCurrentMonth: (...a) => _getInstance().isCurrentMonth(...a),
  loadArchive: (...a) => _getInstance().loadArchive(...a),
  writeArchive: (...a) => _getInstance().writeArchive(...a),
  appendToArchive: (...a) => _getInstance().appendToArchive(...a),
  archiveCurrentFile: (...a) => _getInstance().archiveCurrentFile(...a),
  getArchivedGlobalSessions: (...a) => _getInstance().getArchivedGlobalSessions(...a),
  getArchivedProjectSessions: (...a) => _getInstance().getArchivedProjectSessions(...a),
  getArchivedAllProjectSessions: (...a) => _getInstance().getArchivedAllProjectSessions(...a),
  invalidateArchiveCache: (...a) => _getInstance().invalidateArchiveCache(...a),
  clearArchiveCache: () => _getInstance().clearArchiveCache(),
  getMonthsInRange: (...a) => _getInstance().getMonthsInRange(...a),
  migrateOldArchives: (...a) => _getInstance().migrateOldArchives(...a),
};
