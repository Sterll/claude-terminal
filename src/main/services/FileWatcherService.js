/**
 * FileWatcherService
 * Watches project directories for file changes using chokidar.
 * Collects change events and emits debounced notifications.
 * Used by CloudSyncService for auto-upload of local changes.
 */

const path = require('path');
const { execSync } = require('child_process');
const { isSensitiveFile, isExcludeSensitiveEnabled } = require('../utils/sensitiveFiles');

// Same exclusion list as zipProject.js
const EXCLUDE_DIRS = [
  'node_modules', '.git', 'build', 'dist', '.next', '__pycache__',
  '.venv', 'venv', '.cache', 'coverage', '.tsbuildinfo', '.ct-cloud',
  '.turbo', '.parcel-cache', '.svelte-kit', '.nuxt', '.output',
];

const DEBOUNCE_MS = 5000;

/** @type {typeof import('chokidar')|null} */
let chokidar = null;

async function loadChokidar() {
  if (!chokidar) {
    chokidar = await import('chokidar');
  }
  return chokidar;
}

class FileWatcherService {
  constructor() {
    this._watchers = new Map();
    this._onChanges = null;
  }

  /**
   * Register callback for when debounced changes are ready.
   * @param {(projectId: string, changes: Map<string, string>) => void} fn
   */
  onChanges(fn) {
    this._onChanges = fn;
  }

  /**
   * Unregister the changes callback.
   */
  offChanges() {
    this._onChanges = null;
  }

  /**
   * Start watching a project directory.
   * @param {string} projectId
   * @param {string} projectPath
   */
  async watch(projectId, projectPath) {
    if (this._watchers.has(projectId)) return;

    const chok = await loadChokidar();
    const ignoredPaths = EXCLUDE_DIRS.map(d => path.join(projectPath, d, '**'));

    const watcher = chok.watch(projectPath, {
      ignored: [
        ...ignoredPaths,
        /(^|[/\\])\../, // dotfiles
        /\.git[/\\]/,    // .git directory contents
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      depth: 20,
    });

    const state = {
      watcher,
      changes: new Map(),
      debounceTimer: null,
      projectPath,
    };

    const handleEvent = (eventType, filePath) => {
      const relative = path.relative(projectPath, filePath).replace(/\\/g, '/');
      if (!relative || relative.startsWith('..')) return;
      state.changes.set(relative, eventType);
      this._resetDebounce(projectId, state);
    };

    watcher
      .on('add', (fp) => handleEvent('add', fp))
      .on('change', (fp) => handleEvent('change', fp))
      .on('unlink', (fp) => handleEvent('unlink', fp));

    watcher.on('error', (err) => {
      console.error(`[FileWatcher] Error watching ${projectId}:`, err.message);
    });

    this._watchers.set(projectId, state);
    console.log(`[FileWatcher] Started watching: ${projectPath}`);
  }

  /**
   * Stop watching a project.
   * @param {string} projectId
   */
  unwatch(projectId) {
    const state = this._watchers.get(projectId);
    if (!state) return;
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.watcher.close().catch(() => {});
    this._watchers.delete(projectId);
  }

  /**
   * Stop watching all projects.
   */
  unwatchAll() {
    for (const [id] of this._watchers) {
      this.unwatch(id);
    }
  }

  /**
   * Check if a project is being watched.
   * @param {string} projectId
   * @returns {boolean}
   */
  isWatching(projectId) {
    return this._watchers.has(projectId);
  }

  /**
   * Filter changes through git ls-files to respect .gitignore.
   * Same approach as zipProject.js.
   * @param {string} projectPath
   * @param {Map<string, string>} changes
   * @returns {Map<string, string>}
   */
  filterByGitignore(projectPath, changes) {
    try {
      const output = execSync(
        'git ls-files --cached --others --exclude-standard',
        { cwd: projectPath, encoding: 'utf-8', timeout: 15000, maxBuffer: 10 * 1024 * 1024 }
      );
      const trackedFiles = new Set(output.trim().split('\n').filter(Boolean));
      const filtered = new Map();
      for (const [file, type] of changes) {
        // Deleted files won't appear in git ls-files, let them through
        if (type === 'unlink' || trackedFiles.has(file)) {
          filtered.set(file, type);
        }
      }
      return filtered;
    } catch {
      // Not a git repo or git not available, return all changes
      return changes;
    }
  }

  // ── Internal ──

  _resetDebounce(projectId, state) {
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      this._flushChanges(projectId, state);
    }, DEBOUNCE_MS);
  }

  _flushChanges(projectId, state) {
    if (state.changes.size === 0) return;
    let filtered = this.filterByGitignore(state.projectPath, state.changes);
    state.changes.clear();
    // Strip sensitive files (.env, keys, credentials) unless user opted out
    if (isExcludeSensitiveEnabled()) {
      const safe = new Map();
      for (const [file, type] of filtered) {
        if (!isSensitiveFile(file)) safe.set(file, type);
      }
      filtered = safe;
    }
    if (filtered.size === 0) return;
    if (this._onChanges) {
      this._onChanges(projectId, filtered);
    }
  }
}

module.exports = new FileWatcherService();
