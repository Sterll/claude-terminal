/**
 * Notification Window Manager
 * Manages frameless BrowserWindow notifications with stacking
 */

const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { getMainWindow } = require('./MainWindow');

const activeNotifications = new Map(); // notifId -> { window, height }
let notifIdCounter = 0;

const WIDTH = 400;
const HEIGHT = 100;
const GAP = 8;
const MARGIN = 16;
const MAX_NOTIFICATIONS = 5;

/**
 * Show a notification window
 */
function showNotification({ title, body, terminalId, autoDismiss = 8000, labels }) {
  const notifId = ++notifIdCounter;

  // Evict oldest if at capacity
  if (activeNotifications.size >= MAX_NOTIFICATIONS) {
    const oldest = activeNotifications.keys().next().value;
    dismissNotification(oldest);
  }

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const data = encodeURIComponent(JSON.stringify({ title, body, terminalId, notifId, autoDismiss, labels }));
  const htmlPath = path.join(__dirname, '..', '..', '..', 'notification.html');
  win.loadFile(htmlPath, { search: `data=${data}` });

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive();
  });

  // Single cleanup point: the 'closed' event handles all map/reposition work
  win.on('closed', () => {
    activeNotifications.delete(notifId);
    repositionAll();
  });

  activeNotifications.set(notifId, { window: win, height: HEIGHT });
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

  const entries = [...activeNotifications.entries()].reverse();
  for (const [, notif] of entries) {
    if (notif.window.isDestroyed()) continue;
    currentY -= notif.height;
    notif.window.setBounds({
      x: rightEdge - WIDTH,
      y: currentY,
      width: WIDTH,
      height: notif.height
    });
    currentY -= GAP;
  }
}

/**
 * Dismiss a notification by ID — just close the window.
 * Cleanup (map delete + reposition) is handled by the 'closed' event.
 */
function dismissNotification(notifId) {
  const notif = activeNotifications.get(notifId);
  if (!notif) return;
  if (!notif.window.isDestroyed()) {
    notif.window.close();
  } else {
    // Window already gone, just clean up stale entry
    activeNotifications.delete(notifId);
    repositionAll();
  }
}

/**
 * Register IPC handlers for notification windows
 */
function registerNotificationHandlers() {
  // Action handler — only performs the action, does NOT dismiss.
  // The notification.html handles its own exit animation then sends 'notification-dismiss'.
  ipcMain.on('notification-action', (event, { action, terminalId }) => {
    if (action === 'show') {
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.setAlwaysOnTop(true);
        mainWindow.focus();
        mainWindow.setAlwaysOnTop(false);
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('notification-clicked', { terminalId });
          }
        }, 300);
      }
    }
  });

  // Dismiss handler — called by notification.html after exit animation completes
  ipcMain.on('notification-dismiss', (event, { notifId }) => {
    dismissNotification(notifId);
  });
}

module.exports = {
  showNotification,
  dismissNotification,
  registerNotificationHandlers
};
