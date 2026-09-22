/**
 * Dialog IPC Handlers
 * Handles dialog and system-related IPC communication
 */

const { ipcMain, dialog, shell, app, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { grant } = require('../utils/rendererSecurity');
const updaterService = require('../services/UpdaterService');

let mainWindow = null;

// Map of active file watchers: filePath -> { watcher: FSWatcher, refCount: number }
const fileWatchers = new Map();

// ─── External Editor Launch ──────────────────────────────────────────────────

const ALLOWED_EDITORS = ['code', 'cursor', 'webstorm', 'idea', 'subl', 'atom', 'notepad++', 'notepad', 'vim', 'nvim', 'nano', 'zed'];

// Characters that are never legitimate in an editor binary path or a project
// path, and that would change the meaning of the command line if it ever
// reaches a command interpreter (cmd.exe is still needed for .cmd/.bat
// launchers on Windows). Applied to the FULL string, not just the basename.
// `()` and `{}` are intentionally absent: now that `shell: true` is gone they
// carry no meaning, and rejecting them would break `C:\Program Files (x86)\...`.
const DANGEROUS_CHARS = /[;&|$`<>^\n\r\0"]/;

// .cmd / .bat cannot be launched by CreateProcess directly — they need cmd.exe.
const WINDOWS_SCRIPT_EXT = /\.(cmd|bat)$/i;

// On macOS the GUI editors ship their CLI shim *disabled*: `code` only exists
// on PATH once the user has run "Shell Command: Install 'code' in PATH" by
// hand, and most never do. Spawning it then fails with an ENOENT that arrives
// on the child's `error` event, after the function has already returned, so
// every "Open in editor" button in the app looked dead with nothing logged
// anywhere the user could see. The application bundle is installed by
// definition, so fall back to launching that through `open -a`.
const MAC_APP_BUNDLES = {
  code: 'Visual Studio Code',
  cursor: 'Cursor',
  zed: 'Zed',
  subl: 'Sublime Text',
  atom: 'Atom',
  webstorm: 'WebStorm',
  idea: 'IntelliJ IDEA',
};

/**
 * Read the editor configured in settings, used when the caller omits `editor`.
 * @returns {string}
 */
function _getConfiguredEditor() {
  try {
    const { settingsFile } = require('../utils/paths');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    return String(settings.editor || '').trim();
  } catch (e) {
    return '';
  }
}

/**
 * Resolve an editor command to a concrete file on Windows, probing PATHEXT the
 * way a shell would — but without handing the string to a shell.
 * @param {string} bin
 * @returns {string|null} Absolute path to the executable/launcher, or null
 */
function _resolveWindowsLauncher(bin) {
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExt = path.extname(bin) !== '';
  const candidates = [];
  const addCandidate = (full) => {
    if (hasExt) candidates.push(full);
    else for (const ext of exts) candidates.push(full + ext);
  };

  if (path.isAbsolute(bin) || bin.includes('\\') || bin.includes('/')) {
    addCandidate(path.resolve(bin));
  } else {
    for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      addCandidate(path.join(dir.replace(/^"|"$/g, ''), bin));
    }
  }

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (e) {}
  }
  return null;
}

/**
 * Resolve an editor command to a concrete file on macOS/Linux, walking PATH
 * the way a shell would, but without handing the string to a shell.
 * @param {string} bin
 * @returns {string|null} Absolute path to the executable, or null
 */
function _resolvePosixBinary(bin) {
  const candidates = (path.isAbsolute(bin) || bin.includes('/'))
    ? [path.resolve(bin)]
    : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, bin));

  for (const candidate of candidates) {
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && (st.mode & 0o111)) return candidate;
    } catch (e) { /* next candidate */ }
  }
  return null;
}

/**
 * Build the argv for spawning an editor WITHOUT a shell.
 * @param {string} editorBin
 * @returns {{ file: string, args: string[], viaOpen?: boolean }}
 */
function _buildEditorCommand(editorBin) {
  if (process.platform === 'darwin') {
    if (_resolvePosixBinary(editorBin)) return { file: editorBin, args: [] };
    const bundle = MAC_APP_BUNDLES[path.basename(editorBin).toLowerCase()];
    // `open` waits for LaunchServices rather than for the editor, so it exits
    // right away and its exit code tells us whether the bundle was found.
    if (bundle) return { file: '/usr/bin/open', args: ['-a', bundle], viaOpen: true };
    return { file: editorBin, args: [] };
  }
  if (process.platform !== 'win32') return { file: editorBin, args: [] };

  const resolved = _resolveWindowsLauncher(editorBin);
  // Not found: spawn it as-is so the caller gets a real ENOENT instead of silence.
  if (!resolved) return { file: editorBin, args: [] };

  if (WINDOWS_SCRIPT_EXT.test(resolved)) {
    // PATH-based launchers (`code`, `cursor`, `zed`…) are .cmd wrappers. cmd.exe
    // is required, but both the launcher path and the target have already been
    // rejected if they contain any metacharacter, so nothing can be injected.
    return { file: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', resolved] };
  }
  return { file: resolved, args: [] };
}

/**
 * Spawn the editor and wait long enough to know whether it actually started.
 *
 * `spawn` reports a missing binary asynchronously, on the child's `error`
 * event. Returning before that arrives is what turned "editor not installed"
 * into a button that does nothing: the renderer was told `success: true` and
 * the ENOENT went to a console nobody reads.
 *
 * @param {{ file: string, args: string[], viaOpen?: boolean }} cmd
 * @param {string} targetPath
 * @returns {Promise<Error|null>} the launch failure, or null
 */
function _spawnEditor(cmd, targetPath) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd.file, [...cmd.args, targetPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      resolve(error);
      return;
    }

    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      // Detached and unreferenced: the editor outlives us, and a launcher that
      // never exits must not hold the event loop open either.
      try { proc.unref(); } catch (e) { /* already gone */ }
      resolve(err || null);
    };

    proc.once('error', done);
    proc.once('spawn', () => {
      // A direct editor launch keeps running, so `spawn` firing is the whole
      // answer. `open` is a launcher that exits immediately and signals a
      // missing bundle through its exit code, so that one is worth waiting for,
      // bounded, because a wedged launcher must not hang the caller.
      if (!cmd.viaOpen) {
        done(null);
        return;
      }
      const timer = setTimeout(() => done(null), 3000);
      proc.once('close', (code) => {
        clearTimeout(timer);
        done(code === 0 ? null : new Error(`open exited with code ${code}`));
      });
    });
  });
}

/**
 * Open a project folder or a file in the user's external editor.
 * Accepts `path` or `filePath` (both are used by different renderer callers),
 * and falls back to the configured editor when `editor` is omitted.
 * @param {{ editor?: string, path?: string, filePath?: string }} params
 * @returns {Promise<{ success: boolean, error?: string, editor?: string }>}
 */
async function openInEditor(params) {
  const targetPath = String((params && (params.path || params.filePath)) || '').trim();
  const editorBin = String((params && params.editor) || '').trim() || _getConfiguredEditor();

  if (!editorBin) {
    console.error('[Dialog IPC] open-in-editor: no editor specified and none configured');
    return { success: false, error: 'No editor specified and none configured' };
  }
  if (!targetPath) {
    console.error('[Dialog IPC] open-in-editor: no path provided');
    return { success: false, error: 'No path provided' };
  }
  if (DANGEROUS_CHARS.test(editorBin)) {
    console.error(`[Dialog IPC] Editor rejected (dangerous chars): "${editorBin}"`);
    return { success: false, error: 'Editor path contains forbidden characters' };
  }
  if (DANGEROUS_CHARS.test(targetPath)) {
    console.error(`[Dialog IPC] Target path rejected (dangerous chars): "${targetPath}"`);
    return { success: false, error: 'Target path contains forbidden characters' };
  }

  const baseName = path.basename(editorBin).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  if (!ALLOWED_EDITORS.includes(baseName)) {
    console.debug(`[Dialog IPC] Using custom editor: "${editorBin}"`);
  }

  const failure = await _spawnEditor(_buildEditorCommand(editorBin), targetPath);
  if (failure) {
    console.error(`[Dialog IPC] Failed to open editor "${editorBin}":`, failure.message);
    return { success: false, error: failure.message, editor: editorBin };
  }
  return { success: true, editor: editorBin };
}

/**
 * Set main window reference
 * @param {BrowserWindow} window
 */
function setMainWindow(window) {
  mainWindow = window;
}

/**
 * Register dialog IPC handlers
 */
function registerDialogHandlers() {
  // Window controls
  ipcMain.on('window-minimize', () => mainWindow?.minimize());
  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.on('window-close', () => mainWindow?.close());

  // Force quit application (bypass minimize to tray)
  ipcMain.on('app-quit', () => {
    const { setQuitting } = require('../windows/MainWindow');
    setQuitting(true);
    app.quit();
  });

  // Dynamic window title
  ipcMain.on('set-window-title', (event, title) => {
    if (mainWindow) {
      mainWindow.setTitle(title);
    }
  });

  // Folder dialog
  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    });
    if (!result.canceled && result.filePaths[0]) grant(result.filePaths[0], { directory: fs.statSync(result.filePaths[0]).isDirectory() });
    return result.filePaths[0] || null;
  });

  // Save file dialog
  ipcMain.handle('save-file-dialog', async (event, { defaultPath, filters, title }) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: title || 'Save file',
      defaultPath: defaultPath || undefined,
      filters: filters || [{ name: 'All Files', extensions: ['*'] }]
    });
    if (result.canceled) return null;
    grant(result.filePath, { directory: false });
    return result.filePath;
  });

  // File dialog
  ipcMain.handle('select-file', async (event, { filters }) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: filters || [
        { name: 'Scripts', extensions: ['bat', 'cmd', 'sh', 'exe'] },
        { name: 'Tous les fichiers', extensions: ['*'] }
      ]
    });
    if (!result.canceled && result.filePaths[0]) grant(result.filePaths[0], { directory: fs.statSync(result.filePaths[0]).isDirectory() });
    return result.filePaths[0] || null;
  });

  // Open in explorer
  ipcMain.on('open-in-explorer', (event, folderPath) => {
    shell.openPath(folderPath);
  });

  // Open in external editor.
  // Registered as both `handle` (so failures surface to the caller) and `on`
  // (the preload bridge currently uses `send`, and other callers may too).
  ipcMain.handle('open-in-editor', async (event, params) => {
    // Never reject: the preload bridge is `invoke`, and a rejection there
    // becomes an unhandled promise rejection in every caller that ignores the
    // result, which is most of them.
    try {
      return await openInEditor(params);
    } catch (error) {
      console.error('[Dialog IPC] open-in-editor failed:', error.message);
      return { success: false, error: error.message };
    }
  });
  ipcMain.on('open-in-editor', (event, params) => {
    openInEditor(params).catch(err => console.error('[Dialog IPC] open-in-editor failed:', err.message));
  });

  // Open external URL in browser (only https:// and http:// allowed)
  ipcMain.on('open-external', (event, url) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      shell.openExternal(url);
    }
  });

  // Show notification (custom BrowserWindow)
  ipcMain.on('show-notification', (event, params) => {
    const { showNotification } = require('../windows/NotificationWindow');
    showNotification(params);
  });

  // Get app version
  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  // Release notes for a version already installed. The updater fetches these
  // before an install to fill the banner's "What's new"; asking again after the
  // restart is what lets the app say what changed once you are actually in it.
  ipcMain.handle('get-release-notes', async (event, version) => {
    if (!version || typeof version !== 'string') return null;
    // No initialize() here: this is a plain GitHub read, and arming the
    // auto-updater as a side effect of asking what changed would be a surprise.
    return updaterService.fetchReleaseNotes(version);
  });

  // Install update and restart
  ipcMain.on('update-install', () => {
    updaterService.quitAndInstall();
  });

  // Manually check for updates
  ipcMain.handle('check-for-updates', async () => {
    try {
      updaterService.initialize();
      const result = await updaterService.manualCheck();
      return { success: true, version: result?.updateInfo?.version || null };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Launch at startup - get current setting
  ipcMain.handle('get-launch-at-startup', () => {
    const settings = app.getLoginItemSettings();
    return settings.openAtLogin;
  });

  // Launch at startup - set setting
  ipcMain.handle('set-launch-at-startup', (event, enabled) => {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: false
    });
    return enabled;
  });

  // Clipboard access (needed when navigator.clipboard is unavailable in xterm context)
  ipcMain.handle('clipboard-read', () => clipboard.readText());
  ipcMain.handle('clipboard-write', (event, text) => { clipboard.writeText(text); });

  // File watcher for markdown live reload
  ipcMain.handle('watch-file', (event, filePath) => {
    if (fileWatchers.has(filePath)) {
      fileWatchers.get(filePath).refCount++;
      return;
    }
    try {
      const watcher = fs.watch(filePath, { persistent: true }, (eventType) => {
        if (eventType === 'change' || eventType === 'rename') {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('file-changed', filePath);
          }
        }
      });
      watcher.on('error', () => {
        // File may have been deleted or become inaccessible
        fileWatchers.delete(filePath);
      });
      fileWatchers.set(filePath, { watcher, refCount: 1 });
    } catch (e) {
      // Silently fail if file cannot be watched
    }
  });

  ipcMain.handle('unwatch-file', (event, filePath) => {
    const entry = fileWatchers.get(filePath);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount <= 0) {
      entry.watcher.close();
      fileWatchers.delete(filePath);
    }
  });
}

module.exports = {
  registerDialogHandlers,
  setMainWindow
};
