/**
 * Main Process Bootstrap
 * Entry point for the Electron main process
 */

const { app, globalShortcut } = require('electron');
const { initializeServices, cleanupServices } = require('./services');
const { registerAllHandlers } = require('./ipc');
const {
  createMainWindow,
  getMainWindow,
  showMainWindow,
  setQuitting
} = require('./windows/MainWindow');
const {
  createQuickPickerWindow,
  registerQuickPickerHandlers
} = require('./windows/QuickPickerWindow');
const {
  createTray,
  registerTrayHandlers
} = require('./windows/TrayManager');
const { updaterService } = require('./services');

// Set App User Model ID for Windows notifications
if (process.platform === 'win32') {
  app.setAppUserModelId('Claude Terminal');
}

// Single instance lock - ensure only one instance runs
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running, quit this one
  app.quit();
}

// Handle second instance attempt (show existing window)
app.on('second-instance', () => {
  showMainWindow();
});

/**
 * Initialize the application
 */
function initializeApp() {
  // Create main window
  const isDev = process.argv.includes('--dev');
  const mainWindow = createMainWindow({ isDev });

  // Initialize services with main window reference
  initializeServices(mainWindow);

  // Register IPC handlers
  registerAllHandlers(mainWindow);
  registerQuickPickerHandlers();
  registerTrayHandlers();

  // Create tray
  createTray();

  // Register global shortcuts
  registerGlobalShortcuts();

  // Check for updates (production only)
  updaterService.checkForUpdates(app.isPackaged);
}

/**
 * Register global keyboard shortcuts
 */
function registerGlobalShortcuts() {
  // Ctrl+Shift+P: Quick picker
  globalShortcut.register('Ctrl+Shift+P', () => {
    createQuickPickerWindow();
  });

  // Ctrl+Shift+T: New terminal in current project
  globalShortcut.register('Ctrl+Shift+T', () => {
    let mainWindow = getMainWindow();
    if (!mainWindow) {
      mainWindow = createMainWindow({ isDev: process.argv.includes('--dev') });
    }
    showMainWindow();
    setTimeout(() => {
      mainWindow.webContents.send('open-terminal-current-project');
    }, 100);
  });
}

/**
 * Cleanup before quit
 */
function cleanup() {
  globalShortcut.unregisterAll();
  cleanupServices();
}

// App ready
app.whenReady().then(initializeApp);

// Will quit
app.on('will-quit', cleanup);

// Before quit - cleanup services
app.on('before-quit', () => {
  setQuitting(true);
  cleanupServices();
});

// Window all closed
app.on('window-all-closed', () => {
  // Don't quit on Windows/Linux, app stays in tray
  if (process.platform === 'darwin') {
    app.quit();
  }
});

// Export for potential use
module.exports = {
  initializeApp,
  cleanup
};
