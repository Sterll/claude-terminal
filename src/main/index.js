/**
 * Main Process Bootstrap
 * Entry point for the Electron main process
 */

const { app, globalShortcut, dialog } = require('electron');
const fs = require('fs');
const nodePath = require('path');
const os = require('os');

// Set App User Model ID ASAP — must be before any window/notification
// Must match electron-builder.config.js appId for installed builds
if (process.platform === 'win32') {
  app.setAppUserModelId('com.yanis.claude-terminal');
}

// ============================================
// GLOBAL ERROR HANDLERS - Must be very first!
// ============================================
const crashLogPath = nodePath.join(os.homedir(), '.claude-terminal', 'crash.log');

function appendCrashLog(type, error) {
  try {
    const dir = nodePath.dirname(crashLogPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const entry = `[${new Date().toISOString()}] ${type}: ${error?.stack || error}\n`;
    fs.appendFileSync(crashLogPath, entry);
  } catch (_) { /* last resort - can't even log */ }
}

process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught Exception:', error);
  appendCrashLog('UNCAUGHT_EXCEPTION', error);
  try {
    dialog.showErrorBox(
      'Claude Terminal - Fatal Error',
      `An unexpected error occurred.\n\n${error.message}\n\nThe app will restart. Check logs at:\n${crashLogPath}`
    );
  } catch (_) {}
  app.relaunch();
  app.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[ERROR] Unhandled Promise Rejection:', reason);
  appendCrashLog('UNHANDLED_REJECTION', reason);
});

// ============================================
// SINGLE INSTANCE LOCK - Must be first!
// ============================================
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running
  // Quit immediately and let the first instance handle it
  app.quit();
} else {
  // We got the lock - this is the primary instance
  // Now we can safely require other modules and set up the app
  bootstrapApp();
}

/**
 * Bootstrap the application (only called if we have the single instance lock)
 */
function bootstrapApp() {
  // Lazy require modules only after we have the lock
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
    registerNotificationHandlers
  } = require('./windows/NotificationWindow');
  const {
    createTray,
    registerTrayHandlers
  } = require('./windows/TrayManager');
  const { updaterService } = require('./services');
  const { ensureDataDir } = require('./utils/paths');



  // Handle second instance attempt - show existing window
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });

  /**
   * Initialize the application
   */
  function initializeApp() {
    // Ensure data directory exists before any file operations
    ensureDataDir();

    // Create main window
    const isDev = process.argv.includes('--dev');
    const mainWindow = createMainWindow({ isDev });

    // Initialize services with main window reference
    initializeServices(mainWindow);

    // Register IPC handlers
    registerAllHandlers(mainWindow);
    registerQuickPickerHandlers();
    registerNotificationHandlers();
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
   * Note: Global shortcuts are system-wide and may conflict with other apps.
   * We only register truly global shortcuts here (that work even when app is in background).
   * App-local shortcuts (Ctrl+Shift+T, Ctrl+Shift+E, Ctrl+Shift+P) are now handled
   * in the renderer process via KeyboardShortcuts.js
   */
  function registerGlobalShortcuts() {
    // No global shortcuts registered by default to avoid conflicts
    // All shortcuts are now handled locally in the renderer when the app is focused
    console.debug('[Shortcut] Global shortcuts disabled - using local shortcuts instead');
  }

  /**
   * Cleanup before quit
   */
  function cleanup() {
    globalShortcut.unregisterAll();
    updaterService.stopPeriodicCheck();
    cleanupServices();
  }

  // App ready - initialize
  app.whenReady().then(initializeApp);

  // Will quit - cleanup
  app.on('will-quit', cleanup);

  // Before quit - notify renderer to save state and cleanup
  app.on('before-quit', () => {
    setQuitting(true);
    // Notify renderer to save active time tracking sessions
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app-will-quit');
    }
    cleanupServices();
  });

  // Window all closed
  app.on('window-all-closed', () => {
    // Don't quit on Windows/Linux, app stays in tray
    if (process.platform === 'darwin') {
      app.quit();
    }
  });
}
