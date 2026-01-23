/**
 * Dialog IPC Handlers
 * Handles dialog and system-related IPC communication
 */

const { ipcMain, dialog, shell, Notification, app } = require('electron');
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

  // Show notification
  ipcMain.on('show-notification', (event, { title, body, terminalId }) => {
    if (!Notification.isSupported()) return;

    // Try to find icon
    let iconPath = path.join(__dirname, '..', '..', '..', 'assets', 'icon.ico');
    if (!fs.existsSync(iconPath)) {
      iconPath = undefined;
    }

    const notification = new Notification({
      title,
      body,
      icon: iconPath,
      silent: false
    });

    notification.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('notification-clicked', { terminalId });
      }
    });

    notification.show();
  });

  // Get app version
  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  // Install update and restart
  ipcMain.on('update-install', () => {
    updaterService.quitAndInstall();
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
