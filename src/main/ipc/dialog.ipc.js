/**
 * Dialog IPC Handlers
 * Handles dialog and system-related IPC communication
 */

const { ipcMain, dialog, shell, app, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
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
 * Build the argv for spawning an editor WITHOUT a shell.
 * @param {string} editorBin
 * @returns {{ file: string, args: string[] }}
 */
function _buildEditorCommand(editorBin) {
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
 * Open a project folder or a file in the user's external editor.
 * Accepts `path` or `filePath` (both are used by different renderer callers),
 * and falls back to the configured editor when `editor` is omitted.
 * @param {{ editor?: string, path?: string, filePath?: string }} params
 * @returns {{ success: boolean, error?: string }}
 */
function openInEditor(params) {
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

  try {
    const { file, args } = _buildEditorCommand(editorBin);
    const proc = spawn(file, [...args, targetPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    proc.on('error', (error) => {
      console.error(`[Dialog IPC] Failed to open editor "${editorBin}":`, error.message);
    });
    proc.unref();
    return { success: true };
  } catch (error) {
    console.error(`[Dialog IPC] Failed to spawn editor "${editorBin}":`, error.message);
    return { success: false, error: error.message };
  }
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
    return result.filePaths[0] || null;
  });

  // Open in explorer
  ipcMain.on('open-in-explorer', (event, folderPath) => {
    shell.openPath(folderPath);
  });

  // Open in external editor.
  // Registered as both `handle` (so failures surface to the caller) and `on`
  // (the preload bridge currently uses `send`, and other callers may too).
  ipcMain.handle('open-in-editor', (event, params) => openInEditor(params));
  ipcMain.on('open-in-editor', (event, params) => { openInEditor(params); });

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
