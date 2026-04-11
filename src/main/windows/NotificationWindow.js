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
const BASE_HEIGHT = 100;
const GAP = 8;
const MARGIN = 16;
const MAX_NOTIFICATIONS = 5;

/**
 * Calculate notification window height based on button count.
 * More buttons = taller window (they wrap to a second row).
 */
function calcHeight(buttons) {
  if (!buttons || buttons.length <= 2) return BASE_HEIGHT;
  return BASE_HEIGHT + 28; // extra row for 3-4 buttons
}

/**
 * Show a notification window
 */
function showNotification({ title, body, terminalId, autoDismiss = 8000, labels, buttons, meta }) {
  const notifId = ++notifIdCounter;

  // Normalize buttons: support legacy labels.show format and missing buttons
  let normalizedButtons = buttons;
  if (!normalizedButtons || normalizedButtons.length === 0) {
    const showLabel = (labels && labels.show) ? labels.show : 'Show';
    normalizedButtons = [{ label: showLabel, action: 'show', style: 'primary' }];
  }

  const height = calcHeight(normalizedButtons);

  // Evict oldest if at capacity
  if (activeNotifications.size >= MAX_NOTIFICATIONS) {
    const oldest = activeNotifications.keys().next().value;
    dismissNotification(oldest);
  }

  const win = new BrowserWindow({
    width: WIDTH,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, '..', 'preload-notification.js')
    }
  });

  const notifMeta = Object.assign({}, meta || {});
  const data = encodeURIComponent(JSON.stringify({ title, body, terminalId, notifId, autoDismiss, buttons: normalizedButtons, meta: notifMeta }));
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

  activeNotifications.set(notifId, { window: win, height });
  repositionAll();

  return notifId;
}

/**
 * Reposition all active notifications (stack from bottom-right)
 */
function repositionAll() {
  const mainWindow = getMainWindow();
  const display = mainWindow && !mainWindow.isDestroyed()
    ? screen.getDisplayNearestPoint(mainWindow.getBounds())
    : screen.getPrimaryDisplay();
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
  ipcMain.on('notification-action', (event, { action, terminalId, value, requestId }) => {
    if (action === 'answer') {
      // Send answer silently — no focus, no window show
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('notification-clicked', { terminalId, answerText: value || null });
      }
    } else if (action === 'show') {
      // Bring main window to focus and switch to the right terminal
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.setAlwaysOnTop(true);
        mainWindow.focus();
        mainWindow.setAlwaysOnTop(false);
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('notification-clicked', { terminalId, answerText: null });
          }
        }, 300);
      }
    } else if (action === 'allow' || action === 'deny') {
      // Resolve a pending PermissionRequest hook (blocking wait in hook handler)
      try {
        const HookEventServer = require('../services/HookEventServer');
        HookEventServer.resolvePendingPermission(requestId, action);
      } catch (e) {
        console.error('[NotificationWindow] Failed to resolve permission:', e);
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
