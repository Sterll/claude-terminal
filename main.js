/**
 * Claude Terminal - Main Process Entry Point
 * Minimal entry point that bootstraps the modular architecture
 */

const { app, globalShortcut } = require('electron');

// ============================================
// FIX PATH on macOS/Linux - Apps launched from Finder/Dock have a minimal PATH
// Async version: resolves PATH in background without blocking startup
// ============================================
if (process.platform !== 'win32') {
  const { execFile } = require('child_process');
  const shell = process.env.SHELL || '/bin/zsh';
  execFile(shell, ['-lc', 'echo $PATH'], {
    encoding: 'utf8',
    timeout: 5000,
  }, (err, stdout) => {
    if (!err && stdout) {
      const shellPath = stdout.trim();
      if (shellPath) {
        process.env.PATH = shellPath;
      }
    }
  });
}

// ============================================
// DEV MODE - Allow running alongside production
// ============================================
const isDev = process.argv.includes('--dev');
if (isDev) {
  app.setName('Claude Terminal Dev');
}

// ============================================
// SINGLE INSTANCE LOCK - Must be first!
// ============================================
const gotTheLock = app.requestSingleInstanceLock(isDev ? { dev: true } : undefined);

if (!gotTheLock) {
  console.log('Another instance of Claude Terminal is already running. Focusing existing window.');
  app.quit();
} else {
  bootstrapApp();
}

function bootstrapApp() {
  const fs = require('fs');
  const { loadAccentColor, settingsFile } = require('./src/main/utils/paths');
  const { initializeServices, cleanupServices, hookEventServer } = require('./src/main/services');
  const { registerAllHandlers } = require('./src/main/ipc');
  const {
    createMainWindow,
    getMainWindow,
    showMainWindow,
    setQuitting
  } = require('./src/main/windows/MainWindow');
  const {
    createQuickPickerWindow,
    registerQuickPickerHandlers
  } = require('./src/main/windows/QuickPickerWindow');
  const {
    createSetupWizardWindow,
    isFirstLaunch
  } = require('./src/main/windows/SetupWizardWindow');
  const {
    createTray,
    registerTrayHandlers
  } = require('./src/main/windows/TrayManager');
  const {
    registerNotificationHandlers
  } = require('./src/main/windows/NotificationWindow');
  const { updaterService } = require('./src/main/services');

  // Handle second instance attempt - show existing window
  app.on('second-instance', () => {
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
   * Launch the main application (after setup wizard or directly)
   */
  function launchMainApp() {
    const accentColor = loadAccentColor();
    const isDev = process.argv.includes('--dev');
    const mainWindow = createMainWindow({ isDev });

    initializeServices(mainWindow);
    registerAllHandlers(mainWindow);
    registerQuickPickerHandlers();
    registerTrayHandlers();
    registerNotificationHandlers();
    createTray(accentColor);
    registerGlobalShortcuts();

    // Start hook event server if hooks are enabled
    try {
      if (fs.existsSync(settingsFile)) {
        const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        if (settings.hooksEnabled) {
          hookEventServer.start(mainWindow);
        }
      }
    } catch (e) {
      console.error('[Hooks] Failed to start event server:', e);
    }

    updaterService.checkForUpdates(app.isPackaged);
  }

  /**
   * Initialize the application
   * Checks for first launch and shows setup wizard if needed
   */
  function initializeApp() {
    if (isFirstLaunch()) {
      createSetupWizardWindow({
        onComplete: (settings) => {
          // Apply launch-at-startup setting if requested
          if (settings.launchAtStartup) {
            app.setLoginItemSettings({ openAtLogin: true });
          }
          launchMainApp();
        },
        onSkip: () => {
          launchMainApp();
        }
      });
    } else {
      launchMainApp();
    }
  }

  /**
   * Register global keyboard shortcuts
   */
  function registerGlobalShortcuts() {
    globalShortcut.register('CommandOrControl+Shift+P', () => {
      createQuickPickerWindow();
    });

    globalShortcut.register('CommandOrControl+Shift+T', () => {
      let mainWindow = getMainWindow();
      if (!mainWindow) {
        mainWindow = createMainWindow({ isDev: process.argv.includes('--dev') });
      }
      showMainWindow();
      setTimeout(() => {
        mainWindow.webContents.send('open-terminal-current-project');
      }, 100);
    });

    globalShortcut.register('CommandOrControl+Shift+W', () => {
      const mainWindow = getMainWindow();
      if (mainWindow) {
        showMainWindow();
        setTimeout(() => {
          mainWindow.webContents.send('open-new-worktree');
        }, 100);
      }
    });
  }

  /**
   * Cleanup before quit
   */
  function cleanup() {
    globalShortcut.unregisterAll();
    cleanupServices();
  }

  // App lifecycle
  app.whenReady().then(initializeApp);
  app.on('will-quit', cleanup);
  app.on('before-quit', () => {
    setQuitting(true);
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app-will-quit');
    }
    cleanupServices();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
  app.on('activate', () => {
    if (!getMainWindow()) {
      launchMainApp();
    } else {
      showMainWindow();
    }
  });
}
