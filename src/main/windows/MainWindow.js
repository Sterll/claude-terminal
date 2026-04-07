/**
 * Main Window Manager
 * Manages the main application window
 */

const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { settingsFile } = require('../utils/paths');

// Ctrl+Tab interception flag — synced from renderer settings via IPC
let ctrlTabEnabled = true;
ipcMain.on('set-ctrl-tab-enabled', (_, enabled) => { ctrlTabEnabled = !!enabled; });

let mainWindow = null;
let isQuitting = false;
let normalBounds = null;
let saveTimer = null;

/**
 * Load saved window state from settings.json
 * @returns {Object|null} Saved window state or null
 */
function loadWindowState() {
  try {
    const data = fs.readFileSync(settingsFile, 'utf8');
    const settings = JSON.parse(data);
    return settings.windowState || null;
  } catch (e) {
    return null;
  }
}

/**
 * Validate window state against currently connected displays
 * Uses workArea (excludes taskbar) for bounds check
 * @param {Object|null} state
 * @returns {Object|null} Valid state or null (triggers default centering)
 */
function validateWindowState(state) {
  if (!state) return null;
  if (typeof state.x !== 'number' || typeof state.y !== 'number') return null;
  if (!state.width || !state.height || state.width <= 0 || state.height <= 0) return null;

  const { screen } = require('electron');
  const displays = screen.getAllDisplays();
  const onScreen = displays.some(({ workArea }) => {
    return (
      state.x >= workArea.x &&
      state.x < workArea.x + workArea.width &&
      state.y >= workArea.y &&
      state.y < workArea.y + workArea.height
    );
  });

  return onScreen ? state : null;
}

/**
 * Save window state to settings.json using async atomic write
 * @param {BrowserWindow} win
 */
async function saveWindowStateAsync(win) {
  if (!win || win.isDestroyed()) return;

  let bounds;
  if (win.isMaximized()) {
    if (!normalBounds) return;
    bounds = normalBounds;
  } else {
    bounds = win.getBounds();
  }

  const state = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: win.isMaximized()
  };

  try {
    let current = {};
    try {
      current = JSON.parse(await fs.promises.readFile(settingsFile, 'utf8'));
    } catch (e) {
      // File doesn't exist or is corrupt - start fresh
    }
    current.windowState = state;
    const data = JSON.stringify(current, null, 2);
    const tmpFile = settingsFile + '.tmp';
    await fs.promises.writeFile(tmpFile, data, 'utf8');
    try {
      await fs.promises.rename(tmpFile, settingsFile);
    } catch (renameErr) {
      if (renameErr.code === 'EPERM') {
        // Fallback: write directly (less atomic but avoids data loss)
        await fs.promises.writeFile(settingsFile, data, 'utf8');
        try { await fs.promises.unlink(tmpFile); } catch (_) {}
      } else {
        throw renameErr;
      }
    }
  } catch (e) {
    console.error('[MainWindow] Failed to save window state:', e);
  }
}

/**
 * Save window state synchronously (used only at close for crash-resilient checkpoint)
 * @param {BrowserWindow} win
 */
function saveWindowStateSync(win) {
  if (!win || win.isDestroyed()) return;

  let bounds;
  if (win.isMaximized()) {
    if (!normalBounds) return;
    bounds = normalBounds;
  } else {
    bounds = win.getBounds();
  }

  const state = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: win.isMaximized()
  };

  try {
    let current = {};
    try {
      current = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch (e) {}
    current.windowState = state;
    const data = JSON.stringify(current, null, 2);
    fs.writeFileSync(settingsFile, data, 'utf8');
  } catch (e) {
    console.error('[MainWindow] Failed to save window state:', e);
  }
}

/**
 * Debounced save - used on resize/move events (500ms)
 * @param {BrowserWindow} win
 */
function debouncedSaveWindowState(win) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveWindowStateAsync(win), 500);
}

/**
 * Immediate save - used on close event for crash-resilient final checkpoint
 * @param {BrowserWindow} win
 */
function saveWindowStateImmediate(win) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveWindowStateSync(win);
}

/**
 * Create the main window
 * @param {Object} options
 * @param {boolean} options.isDev - Whether to open DevTools
 * @returns {BrowserWindow}
 */
function createMainWindow({ isDev = false } = {}) {
  const isMac = process.platform === 'darwin';

  // Load and validate saved window state
  const savedState = validateWindowState(loadWindowState());

  const winOpts = {
    width: savedState ? savedState.width : 1400,
    height: savedState ? savedState.height : 900,
    minWidth: 1000,
    minHeight: 600,
    frame: isMac ? undefined : false,
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    trafficLightPosition: isMac ? { x: 12, y: 10 } : undefined,
    backgroundColor: '#0d0d0d',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true,
      preload: path.join(__dirname, '..', 'preload.js')
    }
  };

  // Only add x/y if we have a valid saved state — omitting them lets Electron center the window
  if (savedState) {
    winOpts.x = savedState.x;
    winOpts.y = savedState.y;
  }

  mainWindow = new BrowserWindow(winOpts);

  // Initialize normalBounds for pre-maximized tracking
  normalBounds = (savedState && !savedState.isMaximized)
    ? { x: savedState.x, y: savedState.y, width: savedState.width, height: savedState.height }
    : mainWindow.getBounds();

  // Load the main HTML file
  const htmlPath = path.join(__dirname, '..', '..', '..', 'index.html');
  mainWindow.loadFile(htmlPath);

  // Restore maximized state after loadFile
  if (savedState && savedState.isMaximized) {
    mainWindow.maximize();
  }

  // Intercept Ctrl+Arrow to prevent Windows Snap and forward to renderer
  // Ctrl+Left/Right: intercepted to prevent Windows Snap, forwarded as ctrl-arrow (renderer uses for word-jump)
  // Ctrl+Up/Down: forwarded as ctrl-arrow (renderer uses for project switching)
  // Ctrl+Tab/Ctrl+Shift+Tab: intercepted because Chromium swallows Tab before renderer keydown
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const modKey = process.platform === 'darwin' ? input.meta : input.control;
    if (modKey && !input.alt && input.type === 'keyDown') {
      if (!input.shift) {
        const dir = { Left: 'left', ArrowLeft: 'left', Right: 'right', ArrowRight: 'right',
                       Up: 'up', ArrowUp: 'up', Down: 'down', ArrowDown: 'down' }[input.key];
        if (dir) {
          event.preventDefault();
          mainWindow.webContents.send('ctrl-arrow', dir);
        }
      }
      if (input.key === 'Tab' && ctrlTabEnabled) {
        event.preventDefault();
        mainWindow.webContents.send('ctrl-tab', input.shift ? 'left' : 'right');
      }
    }
  });

  // Block navigation to external URLs — prevents XSS-injected links from navigating the main window
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const htmlPath = path.join(__dirname, '..', '..', '..', 'index.html');
    const fileUrl = `file://${htmlPath.replace(/\\/g, '/')}`;
    if (!url.startsWith('file://')) {
      event.preventDefault();
    }
  });

  // Block window.open() calls
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Open DevTools in development
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // Track normal (non-maximized) bounds for correct state restoration
  mainWindow.on('resize', () => {
    if (!mainWindow.isMaximized()) {
      normalBounds = mainWindow.getBounds();
      debouncedSaveWindowState(mainWindow);
    }
  });

  mainWindow.on('move', () => {
    if (!mainWindow.isMaximized()) {
      normalBounds = mainWindow.getBounds();
      debouncedSaveWindowState(mainWindow);
    }
  });

  mainWindow.on('maximize', () => {
    debouncedSaveWindowState(mainWindow);
  });

  mainWindow.on('unmaximize', () => {
    normalBounds = mainWindow.getBounds();
    debouncedSaveWindowState(mainWindow);
  });

  // Minimize to tray instead of closing
  mainWindow.on('close', (event) => {
    saveWindowStateImmediate(mainWindow);
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

/**
 * Get the main window instance
 * @returns {BrowserWindow|null}
 */
function getMainWindow() {
  return mainWindow;
}

/**
 * Show and focus the main window
 */
function showMainWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();

    // Refresh usage if stale
    try {
      const { onWindowShow } = require('../services/UsageService');
      onWindowShow();
    } catch (e) {}
  }
}

/**
 * Set quitting state
 * @param {boolean} quitting
 */
function setQuitting(quitting) {
  isQuitting = quitting;
}

/**
 * Check if quitting
 * @returns {boolean}
 */
function isAppQuitting() {
  return isQuitting;
}

/**
 * Send message to main window
 * @param {string} channel
 * @param {*} data
 */
function sendToMainWindow(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

/**
 * Check if window is visible
 * @returns {boolean}
 */
function isMainWindowVisible() {
  return mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
}

module.exports = {
  createMainWindow,
  getMainWindow,
  showMainWindow,
  setQuitting,
  isAppQuitting,
  sendToMainWindow,
  isMainWindowVisible
};
