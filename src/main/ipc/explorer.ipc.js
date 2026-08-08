/**
 * Explorer IPC Handlers - File Watcher Service
 * Watches directories currently expanded in the file explorer UI using
 * per-directory shallow (depth:0) chokidar watchers.
 *
 * Design: Only directories that are currently expanded in the UI have active watchers.
 * This reduces OS file handles from thousands (recursive) to typically 1-50 (expanded only).
 */

const { ipcMain } = require('electron');
/** @type {import('chokidar')} */
let chokidar = null;
async function getChokidar() {
  if (!chokidar) {
    const mod = await import('chokidar');
    chokidar = mod.default ?? mod;
  }
  return chokidar;
}
const path = require('path');

// ==================== MODULE STATE ====================

/** BrowserWindow reference set by registerExplorerHandlers */
let mainWindow = null;

/**
 * Per-directory shallow watcher map.
 * Keys: absolute dirPath string
 * Values: { watcher: FSWatcher, watchId: number, ownerId: number|null }
 *
 * `ownerId` is the webContents.id of the renderer that asked for the watcher, so
 * the watcher can be released when that renderer navigates away, crashes or is
 * destroyed — not only when it politely sends explorer:unwatchDir.
 */
const dirWatchers = new Map();

/**
 * Monotonically increasing counter. Each watchDir call captures its own myWatchId
 * so stale debounce callbacks can be discarded.
 */
let watchId = 0;

/**
 * Bumped by every bulk teardown. watchDir() awaits the lazy chokidar import, so a
 * teardown can land in the middle of that await; comparing the epoch afterwards
 * stops the resolved watcher from being registered into a map that was just
 * cleared (which would leak it permanently — nothing holds a reference to close).
 */
let watchEpoch = 0;

/** dirPaths with a watchDir() in flight, to avoid creating two watchers for one dir. */
const pendingWatchDirs = new Set();

/** webContents ids whose lifetime listeners are already attached. */
const boundSenders = new Set();

/** Batched change events pending the next flush */
let pendingChanges = [];

/** setTimeout handle for the debounce flush */
let debounceTimer = null;

/** Debounce window in milliseconds — within the 300-500ms range per decision */
const DEBOUNCE_MS = 350;

/** Warn the renderer when this many directories are being watched simultaneously */
const WATCH_LIMIT_WARN = 50;

// ==================== IGNORE PATTERNS ====================

/**
 * Mirror of IGNORE_PATTERNS from FileExplorer.js.
 * Used by chokidar to skip high-noise directories.
 */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  '.next', 'vendor', '.cache', '.idea', '.vscode',
  '.DS_Store', 'Thumbs.db', '.env.local', 'coverage',
  '.nuxt', '.output', '.turbo', '.parcel-cache'
]);

/**
 * Returns a function for chokidar's `ignored` option.
 * Returns true if any path segment is in IGNORED_DIRS.
 * Splits on both '\\' and '/' for cross-platform compatibility.
 */
function makeIgnoredFn() {
  return (filePath) => {
    if (!filePath) return false;
    const segments = filePath.split(/[\\/]/);
    return segments.some(seg => IGNORED_DIRS.has(seg));
  };
}

// ==================== CHANGE BATCHING ====================

/**
 * Flushes pendingChanges to the renderer via IPC.
 * @param {number} myWatchId - watchId captured when this flush was scheduled (unused now — stale filtering is per-event)
 */
function flushChanges(myWatchId) {
  if (pendingChanges.length === 0) return;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('explorer:changes', pendingChanges.slice());
  }

  pendingChanges = [];
  debounceTimer = null;
}

/**
 * Pushes a single change event and (re)schedules the debounce flush.
 * Drops the event silently if the watcher for watchedDir is no longer active or has been replaced.
 * @param {'add'|'remove'} type - Change type
 * @param {string} filePath - Absolute path of the changed entry
 * @param {boolean} isDirectory - Whether the entry is a directory
 * @param {number} myWatchId - watchId captured when this watcher's closure was created
 * @param {string} watchedDir - The directory this watcher is watching
 */
function pushChange(type, filePath, isDirectory, myWatchId, watchedDir) {
  const entry = dirWatchers.get(watchedDir);
  if (!entry || entry.watchId !== myWatchId) return; // stale watcher — discard

  pendingChanges.push({ type, path: filePath, isDirectory });

  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => flushChanges(myWatchId), DEBOUNCE_MS);
}

// ==================== WATCHER LIFECYCLE ====================

/**
 * Starts watching a single directory with a shallow (depth:0) chokidar watcher.
 * If a watcher for this directory is already active, returns immediately.
 * @param {string} dirPath - Absolute path to the directory to watch
 * @param {number|null} [ownerId] - webContents.id of the requesting renderer
 */
async function watchDir(dirPath, ownerId = null) {
  if (dirWatchers.has(dirPath) || pendingWatchDirs.has(dirPath)) return; // already watching / in flight

  const myEpoch = watchEpoch;
  pendingWatchDirs.add(dirPath);
  let chok;
  try {
    chok = await getChokidar();
  } finally {
    pendingWatchDirs.delete(dirPath);
  }

  // The renderer went away (or a bulk stop ran) while chokidar was importing.
  // Bail out before creating a watcher nobody would ever close.
  if (myEpoch !== watchEpoch || dirWatchers.has(dirPath)) return;

  watchId++;
  const myWatchId = watchId;

  const watcher = chok.watch(dirPath, {
    ignored: makeIgnoredFn(),
    persistent: true,             // activates chokidar's native error listener which swallows EPERM on Windows directory deletion
    ignoreInitial: true,          // only report changes, not the initial directory scan
    ignorePermissionErrors: true, // silently ignore EACCES/EPERM from subdirectories
    depth: 0,                     // shallow: only direct children of dirPath
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 100
    }
  });

  watcher
    .on('add',       (p) => pushChange('add',    p, false, myWatchId, dirPath))
    .on('addDir',    (p) => pushChange('add',    p, true,  myWatchId, dirPath))
    .on('unlink',    (p) => pushChange('remove', p, false, myWatchId, dirPath))
    .on('unlinkDir', (p) => pushChange('remove', p, true,  myWatchId, dirPath))
    .on('error', () => {
      // Silently ignore errors (e.g. permission denied on subdirectories)
    });

  dirWatchers.set(dirPath, { watcher, watchId: myWatchId, ownerId });

  if (dirWatchers.size >= WATCH_LIMIT_WARN && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('explorer:watchLimitWarning', dirWatchers.size);
  }
}

/**
 * Stops the watcher for a single directory and removes it from the map.
 * No-op if the directory is not currently being watched.
 * @param {string} dirPath - Absolute path to the directory to unwatch
 */
function unwatchDir(dirPath) {
  const entry = dirWatchers.get(dirPath);
  if (!entry) return;

  entry.watcher.close(); // fire-and-forget — safe, chokidar handles this internally
  dirWatchers.delete(dirPath);
}

/** Clears the batched-change state once no watcher can feed it anymore. */
function clearPendingChanges() {
  pendingChanges = [];

  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

/**
 * Stops all active per-directory watchers and clears pending state.
 */
function stopAllDirWatchers() {
  for (const entry of dirWatchers.values()) {
    try { entry.watcher.close(); } catch (_) { /* already closed */ }
  }
  dirWatchers.clear();
  watchEpoch++; // cancel any watchDir() still awaiting the chokidar import

  clearPendingChanges();
}

/**
 * Releases every watcher requested by one renderer.
 * @param {number} ownerId - webContents.id
 */
function stopWatchersForOwner(ownerId) {
  for (const [dirPath, entry] of dirWatchers) {
    if (entry.ownerId !== ownerId) continue;
    try { entry.watcher.close(); } catch (_) { /* already closed */ }
    dirWatchers.delete(dirPath);
  }
  // Bumping the epoch also cancels in-flight watchDir() calls from other
  // renderers. Harmless: the app only ever has one explorer renderer, and a
  // cancelled request is re-issued by that renderer, whereas a missed cancel
  // leaks a watcher for the life of the process.
  watchEpoch++;

  if (dirWatchers.size === 0) clearPendingChanges();
}

/**
 * Binds watcher lifetime to the renderer that requested it.
 *
 * Before this, watchers were only released by an explicit explorer:unwatchDir /
 * explorer:stopWatch from the renderer. A Ctrl+R reload or a renderer crash never
 * sends those, so every chokidar watcher from the previous document was orphaned
 * and accumulated for the life of the main process (one OS file handle each).
 *
 * @param {Electron.WebContents} contents
 */
function bindRendererLifetime(contents) {
  if (!contents || contents.isDestroyed() || boundSenders.has(contents.id)) return;
  const ownerId = contents.id;
  boundSenders.add(ownerId);

  const release = () => stopWatchersForOwner(ownerId);

  // Main-frame navigation (Ctrl+R, location.reload(), loadFile) replaces the
  // document that asked for these watchers. 'did-navigate' fires on commit,
  // before the new document's scripts run, so it cannot race a fresh watchDir()
  // from the new page. Deliberately NOT 'did-start-loading': that also fires for
  // subframe loads and would kill live watchers whenever a chat renders an
  // html preview iframe.
  contents.on('did-navigate', release);
  // Renderer crashed/was killed — no unwatch will ever arrive.
  contents.on('render-process-gone', release);
  contents.on('destroyed', () => {
    boundSenders.delete(ownerId);
    release();
  });
}

/**
 * Public stop function — stops all watchers.
 * Called on renderer teardown and by cleanupServices() at app shutdown.
 */
function stopWatch() {
  stopAllDirWatchers();
}

// ==================== IPC REGISTRATION ====================

/**
 * Registers IPC handlers for the file explorer watcher.
 * Must be called with a reference to the main BrowserWindow.
 * @param {BrowserWindow} mw - The main application window
 */
function registerExplorerHandlers(mw) {
  mainWindow = mw;

  // Start watching a single directory (shallow, depth:0)
  ipcMain.on('explorer:watchDir', (event, dirPath) => {
    if (!dirPath || typeof dirPath !== 'string') return;
    bindRendererLifetime(event.sender);
    watchDir(dirPath, event.sender.id);
  });

  // Stop watching a single directory
  ipcMain.on('explorer:unwatchDir', (event, dirPath) => {
    if (!dirPath || typeof dirPath !== 'string') return;
    unwatchDir(dirPath);
  });

  // Stop all watchers (project deselect / collapse-all / refresh)
  ipcMain.on('explorer:stopWatch', () => {
    stopWatch();
  });
}

module.exports = { registerExplorerHandlers, stopWatch };
