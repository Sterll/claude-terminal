/**
 * Dialog IPC Handlers
 * Handles dialog and system-related IPC communication
 */

const { ipcMain, dialog, shell, app } = require('electron');
const path = require('path');
const fs = require('fs');
const updaterService = require('../services/UpdaterService');

let mainWindow = null;

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
    const { execFile } = require('child_process');
    // Allowlist of known editors - prevents arbitrary command injection
    const ALLOWED_EDITORS = ['code', 'cursor', 'webstorm', 'idea', 'subl', 'atom', 'notepad++', 'notepad', 'vim', 'nvim', 'nano', 'zed'];
    const editorBin = (editor || '').trim();
    const isAllowed = ALLOWED_EDITORS.some(e => editorBin === e || editorBin.endsWith(`/${e}`) || editorBin.endsWith(`\\${e}`) || editorBin.endsWith(`\\${e}.exe`) || editorBin.endsWith(`/${e}.exe`));
    if (!isAllowed) {
      console.error(`[Dialog IPC] Editor not in allowlist: "${editorBin}"`);
      return;
    }
    execFile(editorBin, [projectPath], { shell: true }, (error) => {
      if (error) {
        console.error(`[Dialog IPC] Failed to open editor "${editorBin}":`, error.message);
      }
    });
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
}

module.exports = {
  registerDialogHandlers,
  setMainWindow
};
