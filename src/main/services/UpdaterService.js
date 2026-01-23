/**
 * Updater Service
 * Manages application auto-updates
 */

const { autoUpdater } = require('electron-updater');

class UpdaterService {
  constructor() {
    this.mainWindow = null;
    this.isInitialized = false;
  }

  /**
   * Set the main window reference for IPC communication
   * @param {BrowserWindow} window
   */
  setMainWindow(window) {
    this.mainWindow = window;
  }

  /**
   * Safely send IPC message to main window
   */
  safeSend(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * Initialize the auto updater
   */
  initialize() {
    if (this.isInitialized) return;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    // Handle update available
    autoUpdater.on('update-available', (info) => {
      this.safeSend('update-status', { status: 'available', version: info.version });
    });

    // Handle update downloaded
    autoUpdater.on('update-downloaded', (info) => {
      this.safeSend('update-status', { status: 'downloaded', version: info.version });
      // No native dialog - the renderer banner handles the UI
    });

    // Handle update not available
    autoUpdater.on('update-not-available', () => {
      this.safeSend('update-status', { status: 'not-available' });
    });

    // Handle error
    autoUpdater.on('error', (err) => {
      console.error('Auto-updater error:', err);
      this.safeSend('update-status', { status: 'error', error: err.message });
    });

    // Handle download progress
    autoUpdater.on('download-progress', (progressObj) => {
      this.safeSend('update-status', { status: 'downloading', progress: progressObj.percent });
    });

    this.isInitialized = true;
  }

  /**
   * Check for updates (only in production)
   * @param {boolean} isPackaged - Whether the app is packaged
   */
  checkForUpdates(isPackaged) {
    if (isPackaged) {
      this.initialize();
      autoUpdater.checkForUpdatesAndNotify();
    }
  }

  /**
   * Manually trigger update check
   */
  manualCheck() {
    this.initialize();
    return autoUpdater.checkForUpdates();
  }

  /**
   * Quit and install update
   */
  quitAndInstall() {
    // Force quit (bypass minimize to tray)
    const { setQuitting } = require('../windows/MainWindow');
    setQuitting(true);
    autoUpdater.quitAndInstall();
  }
}

// Singleton instance
const updaterService = new UpdaterService();

module.exports = updaterService;
