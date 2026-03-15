/**
 * Dialog IPC Handlers
 * Handles dialog and system-related IPC communication
 */

const { ipcMain, dialog, shell, app, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const updaterService = require('../services/UpdaterService');

let mainWindow = null;

// Map of active file watchers: filePath -> { watcher: FSWatcher, refCount: number }
const fileWatchers = new Map();

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

  // Open in external editor
  ipcMain.on('open-in-editor', (event, { editor, path: projectPath }) => {
    const path = require('path');
    // Allowlist checked against basename only — prevents ../../evil/code bypasses
    const ALLOWED_EDITORS = ['code', 'cursor', 'webstorm', 'idea', 'subl', 'atom', 'notepad++', 'notepad', 'vim', 'nvim', 'nano', 'zed'];
    const editorBin = (editor || '').trim();
    const baseName = path.basename(editorBin).replace(/\.exe$/i, '').toLowerCase();
    if (!ALLOWED_EDITORS.includes(baseName)) {
      console.error(`[Dialog IPC] Editor not in allowlist: "${editorBin}"`);
      return;
    }
    // shell:true is required on Windows for PATH-based launchers (.cmd wrappers like `idea`, `cursor`, `zed`).
    // Injection is prevented by validating editorBin against the allowlist (basename only) and passing
    // projectPath as a separate argument array — never via string interpolation.
    const { spawn } = require('child_process');
    const proc = spawn(editorBin, [projectPath], { shell: process.platform === 'win32', detached: true, stdio: 'ignore' });
    proc.on('error', (error) => {
      console.error(`[Dialog IPC] Failed to open editor "${editorBin}":`, error.message);
    });
    proc.unref();
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
