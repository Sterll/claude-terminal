/**
 * Quick Picker Window Manager
 * Manages the quick project picker overlay window
 */

const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { getMainWindow, showMainWindow } = require('./MainWindow');

let quickPickerWindow = null;

/**
 * Create or show the quick picker window
 */
function createQuickPickerWindow() {
  if (quickPickerWindow) {
    quickPickerWindow.show();
    quickPickerWindow.focus();
    // Force reload projects
    quickPickerWindow.webContents.send('reload-projects');
    return quickPickerWindow;
  }

  quickPickerWindow = new BrowserWindow({
    width: 600,
    height: 460,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    center: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, '..', 'preload-quickpicker.js')
    }
  });

  const htmlPath = path.join(__dirname, '..', '..', '..', 'quick-picker.html');
  quickPickerWindow.loadFile(htmlPath);

  quickPickerWindow.once('ready-to-show', () => {
    quickPickerWindow.show();
    quickPickerWindow.focus();
  });

  quickPickerWindow.on('blur', () => {
    if (quickPickerWindow && !quickPickerWindow.isDestroyed()) {
      quickPickerWindow.hide();
      // Return focus to the main window
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus();
      }
    }
  });

  quickPickerWindow.on('closed', () => {
    quickPickerWindow = null;
  });

  return quickPickerWindow;
}

/**
 * Get the quick picker window instance
 * @returns {BrowserWindow|null}
 */
function getQuickPickerWindow() {
  return quickPickerWindow;
}

/**
 * Hide the quick picker window
 */
function hideQuickPicker() {
  if (quickPickerWindow) {
    quickPickerWindow.hide();
  }
  // Always return focus to the main window
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
  }
}

/**
 * Register quick picker IPC handlers
 */
function registerQuickPickerHandlers() {
  // Handle project selection
  ipcMain.on('quick-pick-select', (event, project) => {
    hideQuickPicker();

    const mainWindow = getMainWindow();
    if (!mainWindow) {
      // Main window will be created by app
      return;
    }

    showMainWindow();

    // Send project to open
    setTimeout(() => {
      mainWindow.webContents.send('open-project', project);
    }, 200);
  });

  // Handle command selection (navigate to tab in main window)
  ipcMain.on('quick-pick-command', (event, { tabId, action }) => {
    hideQuickPicker();

    const mainWindow = getMainWindow();
    if (!mainWindow) return;

    showMainWindow();

    setTimeout(() => {
      mainWindow.webContents.send('navigate-to-tab', { tabId, action });
    }, 200);
  });

  // Handle workflow trigger (navigate to workflows panel and trigger the workflow)
  ipcMain.on('quick-pick-workflow', (event, { workflowId }) => {
    hideQuickPicker();

    const mainWindow = getMainWindow();
    if (!mainWindow) return;

    showMainWindow();

    setTimeout(() => {
      mainWindow.webContents.send('navigate-to-tab', { tabId: 'workflows' });
      mainWindow.webContents.send('workflow-trigger', { workflowId });
    }, 200);
  });

  // Handle close
  ipcMain.on('quick-pick-close', () => {
    hideQuickPicker();
  });
}

module.exports = {
  createQuickPickerWindow,
  getQuickPickerWindow,
  hideQuickPicker,
  registerQuickPickerHandlers
};
