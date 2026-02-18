/**
 * Tray Manager
 * Manages the system tray icon and menu
 */

const path = require('path');
const { Tray, Menu, ipcMain, nativeImage } = require('electron');
const { showMainWindow, setQuitting } = require('./MainWindow');
const { createQuickPickerWindow } = require('./QuickPickerWindow');

let tray = null;

/**
 * Get the application icon path for tray
 * @returns {string}
 */
function getTrayIconPath() {
  const fs = require('fs');
  if (process.platform === 'darwin') {
    const trayName = 'trayIconTemplate.png';
    const devPath = path.join(__dirname, '..', '..', '..', 'assets', trayName);
    if (fs.existsSync(devPath)) return devPath;
    return path.join(process.resourcesPath || __dirname, 'assets', trayName);
  }
  const ext = process.platform === 'win32' ? 'ico' : 'png';
  const iconName = `icon.${ext}`;
  const devPath = path.join(__dirname, '..', '..', '..', 'assets', iconName);
  if (fs.existsSync(devPath)) return devPath;
  return path.join(process.resourcesPath || __dirname, 'assets', iconName);
}

/**
 * Create the system tray
 */
function createTray() {
  const iconPath = getTrayIconPath();
  const icon = nativeImage.createFromPath(iconPath);
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true);
  } else {
    icon.resize({ width: 24, height: 24 });
  }
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Claude Terminal',
      click: () => {
        showMainWindow();
      }
    },
    {
      label: `Quick Pick (${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+Shift+P)`,
      click: () => {
        createQuickPickerWindow();
      }
    },
    {
      label: `New Terminal (${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+Shift+T)`,
      click: () => {
        showMainWindow();
        setTimeout(() => {
          const { getMainWindow } = require('./MainWindow');
          const mainWindow = getMainWindow();
          if (mainWindow) {
            mainWindow.webContents.send('open-terminal-current-project');
          }
        }, 100);
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        setQuitting(true);
        const { app } = require('electron');
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Claude Terminal');
  tray.setContextMenu(contextMenu);

  // Single click to open
  tray.on('click', () => {
    showMainWindow();
  });
}

/**
 * Register tray-related IPC handlers
 */
function registerTrayHandlers() {
  // Handler kept for compatibility, tray now uses fixed app icon
  ipcMain.on('update-accent-color', () => {
    // No-op: tray uses the application icon
  });
}

/**
 * Get tray instance
 * @returns {Tray|null}
 */
function getTray() {
  return tray;
}

/**
 * Destroy tray
 */
function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

module.exports = {
  createTray,
  registerTrayHandlers,
  getTray,
  destroyTray
};
