/**
 * Archive Service
 * Manages monthly time tracking session archives
 * Archives are stored in ~/.claude-terminal/archives/ as monthly JSON files
 */

const { path, fs } = window.electron_nodeModules;
const { archivesDir } = require('../utils/paths');

// Month names for filenames (lowercase English)
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];

// LRU cache for loaded archives (max 3 in memory)
const MAX_CACHE_SIZE = 3;
const archiveCache = new Map(); // "YYYY-MM" -> { data, loadedAt }

/**
 * Get the cache key for a year/month
 * @param {number} year
 * @param {number} month - 0-based JS month index
 * @returns {string}
 */
function getCacheKey(year, month) {
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

/**
 * Get the archive filename for a given year/month
 * @param {number} year
 * @param {number} month - 0-based JS month index
 * @returns {string} e.g. "february_2026.json"
 */
function getArchiveFilename(year, month) {
  return `${MONTH_NAMES[month]}_${year}.json`;
}

/**
 * Get the full path to an archive file
 * @param {number} year
 * @param {number} month - 0-based JS month index
 * @returns {string}
 */
function getArchiveFilePath(year, month) {
  return path.join(archivesDir, getArchiveFilename(year, month));
}

/**
 * Ensure the archives directory exists
 */
function ensureArchivesDir() {
  if (!fs.existsSync(archivesDir)) {
    fs.mkdirSync(archivesDir, { recursive: true });
  }
}

/**
 * Check if a year/month is the current month
 * @param {number} year
 * @param {number} month - 0-based
 * @returns {boolean}
 */
function isCurrentMonth(year, month) {
  const now = new Date();
  return year === now.getFullYear() && month === now.getMonth();
}

/**
 * Create an empty archive structure
 * @param {number} year
 * @param {number} month - 0-based
 * @returns {Object}
 */
function createEmptyArchive(year, month) {
  return {
    version: 1,
    month: getCacheKey(year, month),
    createdAt: new Date().toISOString(),
    lastModifiedAt: new Date().toISOString(),
    globalSessions: [],
    projectSessions: {}
  };
}

/**
 * Read an archive file from disk (bypasses cache)
 * @param {string} filePath
 * @returns {Object|null}
 */
function readArchiveFromDisk(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content || !content.trim()) return null;
    return JSON.parse(content);
  } catch (error) {
    console.warn('[ArchiveService] Failed to read archive:', filePath, error.message);
    return null;
  }
}

/**
 * Load an archive with LRU caching
 * @param {number} year
 * @param {number} month - 0-based
 * @returns {Object|null}
 */
function loadArchive(year, month) {
  const key = getCacheKey(year, month);

  // Check cache
  if (archiveCache.has(key)) {
    return archiveCache.get(key).data;
  }

  // Read from disk
  const filePath = getArchiveFilePath(year, month);
  const data = readArchiveFromDisk(filePath);

  if (data) {
    // Evict oldest if cache full
    if (archiveCache.size >= MAX_CACHE_SIZE) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [k, v] of archiveCache) {
        if (v.loadedAt < oldestTime) {
          oldestTime = v.loadedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) archiveCache.delete(oldestKey);
    }

    archiveCache.set(key, { data, loadedAt: Date.now() });
  }

  return data;
}

/**
 * Write an archive file atomically
 * @param {number} year
 * @param {number} month - 0-based
 * @param {Object} archiveData
 */
function writeArchive(year, month, archiveData) {
  ensureArchivesDir();

  const filePath = getArchiveFilePath(year, month);
  const tempFile = `${filePath}.tmp`;

  try {
    fs.writeFileSync(tempFile, JSON.stringify(archiveData, null, 2));
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    console.error('[ArchiveService] Failed to write archive:', filePath, error.message);
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch (_) {}
  }
}

/**
 * Append sessions to an archive, deduplicating by session ID
 * @param {number} year
 * @param {number} month - 0-based
 * @param {Array} globalSessions - Global sessions to add
 * @param {Object} projectSessionsMap - { projectId: { projectName, sessions: [] } }
 */
function appendToArchive(year, month, globalSessions, projectSessionsMap) {
  const filePath = getArchiveFilePath(year, month);

  // Read fresh from disk (bypass cache for writes)
  let archive = readArchiveFromDisk(filePath);
  if (!archive) {
    archive = createEmptyArchive(year, month);
  }

  // Deduplicate global sessions
  if (globalSessions && globalSessions.length > 0) {
    const existingIds = new Set(archive.globalSessions.map(s => s.id));
    for (const session of globalSessions) {
      if (!existingIds.has(session.id)) {
        archive.globalSessions.push(session);
      }
    }
  }

  // Deduplicate project sessions
  if (projectSessionsMap) {
    for (const [projectId, data] of Object.entries(projectSessionsMap)) {
      if (!archive.projectSessions[projectId]) {
        archive.projectSessions[projectId] = {
          projectName: data.projectName || 'Unknown',
          sessions: []
        };
      }
      const existingIds = new Set(archive.projectSessions[projectId].sessions.map(s => s.id));
      for (const session of data.sessions) {
        if (!existingIds.has(session.id)) {
          archive.projectSessions[projectId].sessions.push(session);
        }
      }
      // Update project name to latest
      if (data.projectName) {
        archive.projectSessions[projectId].projectName = data.projectName;
      }
    }
  }

  archive.lastModifiedAt = new Date().toISOString();

  writeArchive(year, month, archive);
  invalidateArchiveCache(year, month);
}

/**
 * Get archived global sessions for a specific month
 * @param {number} year
 * @param {number} month - 0-based
 * @returns {Array}
 */
function getArchivedGlobalSessions(year, month) {
  const archive = loadArchive(year, month);
  return archive?.globalSessions || [];
}

/**
 * Get archived sessions for a specific project in a month
 * @param {number} year
 * @param {number} month - 0-based
 * @param {string} projectId
 * @returns {Array}
 */
function getArchivedProjectSessions(year, month, projectId) {
  const archive = loadArchive(year, month);
  return archive?.projectSessions?.[projectId]?.sessions || [];
}

/**
 * Get all archived project sessions for a month
 * @param {number} year
 * @param {number} month - 0-based
 * @returns {Object} { projectId: { projectName, sessions } }
 */
function getArchivedAllProjectSessions(year, month) {
  const archive = loadArchive(year, month);
  return archive?.projectSessions || {};
}

/**
 * Invalidate cache for a specific month
 * @param {number} year
 * @param {number} month - 0-based
 */
function invalidateArchiveCache(year, month) {
  archiveCache.delete(getCacheKey(year, month));
}

/**
 * Clear entire archive cache
 */
function clearArchiveCache() {
  archiveCache.clear();
}

/**
 * Get list of months in a date range
 * @param {Date} periodStart
 * @param {Date} periodEnd
 * @returns {Array<{year: number, month: number}>}
 */
function getMonthsInRange(periodStart, periodEnd) {
  const months = [];
  const start = new Date(periodStart.getFullYear(), periodStart.getMonth(), 1);
  const end = new Date(periodEnd);

  while (start < end) {
    months.push({ year: start.getFullYear(), month: start.getMonth() });
    start.setMonth(start.getMonth() + 1);
  }
  return months;
}

module.exports = {
  getArchiveFilePath,
  getArchiveFilename,
  ensureArchivesDir,
  isCurrentMonth,
  loadArchive,
  writeArchive,
  appendToArchive,
  getArchivedGlobalSessions,
  getArchivedProjectSessions,
  getArchivedAllProjectSessions,
  invalidateArchiveCache,
  clearArchiveCache,
  getMonthsInRange
};
