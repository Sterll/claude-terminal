/**
 * Claude Terminal - Main Process Entry Point
 * Minimal entry point that bootstraps the modular architecture
 */

const { app, globalShortcut, session, ipcMain } = require('electron');

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
  // Set AUMID explicitly for NSIS builds — must match appId in electron-builder.config.js.
  // Without this, Electron may generate a different runtime AUMID, causing the taskbar
  // to show duplicate icons and breaking the taskbar pin across updates.
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.yanis.claude-terminal');
  }

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
  const telemetryService = require('./src/main/services/TelemetryService');

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

    // Send anonymous telemetry startup ping (if opted-in)
    telemetryService.sendStartupPing();
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

  // IPC: Re-run setup wizard from settings panel
  ipcMain.on('setup-wizard-rerun', () => {
    createSetupWizardWindow({
      onComplete: (settings) => {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('settings-changed-externally', settings);
        }
      },
      onSkip: () => { /* no-op, wizard was dismissed */ }
    });
  });

  /**
   * Default global shortcut keybindings
   */
  const GLOBAL_SHORTCUT_DEFAULTS = {
    globalQuickPicker: 'CommandOrControl+Shift+P',
    globalNewTerminal: 'CommandOrControl+Shift+T',
    globalNewWorktree: 'CommandOrControl+Shift+W'
  };

  /**
   * Global shortcut action handlers
   */
  const GLOBAL_SHORTCUT_ACTIONS = {
    globalQuickPicker: () => {
      createQuickPickerWindow();
    },
    globalNewTerminal: () => {
      let mainWindow = getMainWindow();
      if (!mainWindow) {
        mainWindow = createMainWindow({ isDev: process.argv.includes('--dev') });
      }
      showMainWindow();
      setTimeout(() => {
        mainWindow.webContents.send('open-terminal-current-project');
      }, 100);
    },
    globalNewWorktree: () => {
      const mainWindow = getMainWindow();
      if (mainWindow) {
        showMainWindow();
        setTimeout(() => {
          mainWindow.webContents.send('open-new-worktree');
        }, 100);
      }
    }
  };

  /**
   * Convert renderer-style key string (Ctrl+Shift+P) to Electron accelerator format
   */
  function toElectronAccelerator(key) {
    if (!key) return null;
    return key.replace(/Ctrl/gi, 'CommandOrControl')
      .replace(/Meta/gi, 'CommandOrControl');
  }

  /**
   * Load global shortcut overrides from settings.json
   */
  function loadGlobalShortcutSettings() {
    try {
      if (fs.existsSync(settingsFile)) {
        const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        return {
          overrides: settings.globalShortcuts || {},
          enabled: settings.globalShortcutsEnabled !== false
        };
      }
    } catch (e) {
      console.error('[GlobalShortcuts] Failed to load settings:', e);
    }
    return { overrides: {}, enabled: true };
  }

  /** Currently registered accelerators (for selective unregister) */
  const registeredAccelerators = new Set();

  /**
   * Register global keyboard shortcuts (reads config from settings or IPC payload)
   */
  function registerGlobalShortcuts(overrides) {
    // Unregister only our own shortcuts (not all global shortcuts)
    for (const acc of registeredAccelerators) {
      try { globalShortcut.unregister(acc); } catch (_) {}
    }
    registeredAccelerators.clear();

    const config = overrides || loadGlobalShortcutSettings();
    if (!config.enabled) return;

    for (const [id, defaultKey] of Object.entries(GLOBAL_SHORTCUT_DEFAULTS)) {
      const customKey = config.overrides[id];
      const accelerator = customKey ? toElectronAccelerator(customKey) : defaultKey;
      const action = GLOBAL_SHORTCUT_ACTIONS[id];
      if (accelerator && action) {
        try {
          globalShortcut.register(accelerator, action);
          registeredAccelerators.add(accelerator);
        } catch (e) {
          console.error(`[GlobalShortcuts] Failed to register ${id} (${accelerator}):`, e);
        }
      }
    }
  }

  // IPC: Renderer requests global shortcut re-registration
  ipcMain.on('update-global-shortcuts', (_event, payload) => {
    registerGlobalShortcuts(payload);
  });

  /**
   * Cleanup before quit
   */
  function cleanup() {
    globalShortcut.unregisterAll();
    cleanupServices();
  }

  // App lifecycle
  app.whenReady().then(() => {
    // Content Security Policy — allow only local file:// resources
    // Prevents XSS attacks from loading remote scripts/styles/iframes
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self' 'unsafe-inline' 'unsafe-eval' file: data: blob:; " +
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' file:; " +
            "style-src 'self' 'unsafe-inline' file: data:; " +
            "img-src 'self' file: data: blob: https:; " +
            "font-src 'self' file: data:; " +
            "connect-src 'self' file: ws://localhost:* http://localhost:* http://127.0.0.1:* https://claude-terminal-hub.claudeterminal.workers.dev; " +
            "frame-src 'none'; " +
            "object-src 'none'"
          ]
        }
      });
    });
    initializeApp();
  });
  app.on('will-quit', cleanup);
  app.on('before-quit', () => {
    telemetryService.sendQuitPing();
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
