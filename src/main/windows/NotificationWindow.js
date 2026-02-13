/**
 * Notification Window Manager
 * Manages frameless BrowserWindow notifications with stacking
 */

const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { getMainWindow, showMainWindow } = require('./MainWindow');

const activeNotifications = new Map(); // notifId -> { window, type, height }
let notifIdCounter = 0;

// Dimensions per type
const DIMENSIONS = {
  done: { width: 400, height: 100 },
  permission: { width: 400, height: 120 },
  question: { width: 400, height: 170 }
};

const GAP = 8;
const MARGIN = 16;

/**
 * Show a notification window
 */
function showNotification({ type = 'done', title, body, terminalId, autoDismiss = 0, labels }) {
  const notifId = ++notifIdCounter;
  const dims = DIMENSIONS[type] || DIMENSIONS.done;

  const win = new BrowserWindow({
    width: dims.width,
    height: dims.height,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: type === 'question',
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const data = encodeURIComponent(JSON.stringify({ type, title, body, terminalId, notifId, autoDismiss, labels }));
  const htmlPath = path.join(__dirname, '..', '..', '..', 'notification.html');
  win.loadFile(htmlPath, { search: `data=${data}` });

  win.once('ready-to-show', () => {
    if (type === 'question') {
      win.show();
      win.focus();
    } else {
      win.showInactive();
    }
  });

  win.on('closed', () => {
    activeNotifications.delete(notifId);
    repositionAll();
  });

  activeNotifications.set(notifId, { window: win, type, height: dims.height });
  repositionAll();

  return notifId;
}

/**
 * Reposition all active notifications (stack from bottom-right)
 */
function repositionAll() {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const rightEdge = workArea.x + workArea.width - MARGIN;
  let currentY = workArea.y + workArea.height - MARGIN;

  // Iterate from newest to oldest (reverse insertion order)
  const entries = [...activeNotifications.entries()].reverse();
  for (const [, notif] of entries) {
    if (notif.window.isDestroyed()) continue;
    const bounds = notif.window.getBounds();
    currentY -= notif.height;
    notif.window.setBounds({
      x: rightEdge - bounds.width,
      y: currentY,
      width: bounds.width,
      height: notif.height
    });
    currentY -= GAP;
  }
}

/**
 * Dismiss a notification by ID
 */
function dismissNotification(notifId) {
  const notif = activeNotifications.get(notifId);
  if (!notif) return;
  if (!notif.window.isDestroyed()) {
    notif.window.close();
  }
  activeNotifications.delete(notifId);
  repositionAll();
}

/**
 * Register IPC handlers for notification windows
 */
function registerNotificationHandlers() {
  ipcMain.on('notification-action', (event, { action, terminalId, notifId, value }) => {
    const mainWindow = getMainWindow();

    switch (action) {
      case 'show':
        if (mainWindow && !mainWindow.isDestroyed()) {
          // Restore window from tray/minimized state
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
          // Delay IPC so renderer is ready after window restore
          setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('notification-clicked', { terminalId });
            }
          }, 200);
        }
        break;
      case 'allow':
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('notification-terminal-input', { terminalId, data: 'y\n' });
        }
        break;
      case 'deny':
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('notification-terminal-input', { terminalId, data: 'n\n' });
        }
        break;
      case 'answer':
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('notification-terminal-input', { terminalId, data: value + '\n' });
        }
        break;
    }

    dismissNotification(notifId);
  });

  ipcMain.on('notification-dismiss', (event, { notifId }) => {
    dismissNotification(notifId);
  });
}

module.exports = {
  showNotification,
  dismissNotification,
  registerNotificationHandlers
};
