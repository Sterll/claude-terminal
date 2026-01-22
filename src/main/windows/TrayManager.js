/**
 * Tray Manager
 * Manages the system tray icon and menu
 */

const path = require('path');
const { Tray, Menu, ipcMain } = require('electron');
const { showMainWindow, setQuitting } = require('./MainWindow');
const { createQuickPickerWindow } = require('./QuickPickerWindow');

let tray = null;

/**
 * Get the application icon path for tray
 * @returns {string}
 */
function getTrayIconPath() {
  // In development: relative to src/main/windows
  // In production: resources/assets
  const devPath = path.join(__dirname, '..', '..', '..', 'assets', 'icon.ico');
  const fs = require('fs');
  if (fs.existsSync(devPath)) {
    return devPath;
  }
  return path.join(process.resourcesPath || __dirname, 'assets', 'icon.ico');
}

/**
 * Create the system tray
 */
function createTray() {
  const iconPath = getTrayIconPath();
  tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Ouvrir Claude Terminal',
      click: () => {
        showMainWindow();
      }
    },
    {
      label: 'Quick Pick (Ctrl+Shift+P)',
      click: () => {
        createQuickPickerWindow();
      }
    },
    {
      label: 'Nouveau Terminal (Ctrl+Shift+T)',
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
      label: 'Quitter',
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
