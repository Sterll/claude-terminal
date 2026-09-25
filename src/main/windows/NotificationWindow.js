/**
 * Notification Window Manager
 * Manages frameless BrowserWindow notifications with stacking
 */

const { app, BrowserWindow, ipcMain, screen, Notification } = require('electron');
const path = require('path');
const { getMainWindow } = require('./MainWindow');

const activeNotifications = new Map(); // notifId -> { window, height }
let notifIdCounter = 0;

const WIDTH = 400;
const BASE_HEIGHT = 100;
const GAP = 8;
const MARGIN = 16;
const MAX_NOTIFICATIONS = 5;

// Bounds for the height notification.html measures for itself. The floor is a
// title with no body and no buttons; the ceiling stops a malformed payload from
// opening a window the size of the screen.
const MIN_HEIGHT = 64;
const MAX_HEIGHT = 260;

/**
 * Initial notification window height, from the button count alone.
 * This is only an estimate: how many lines the body wraps to is not knowable
 * here, so the window is resized to what notification.html measures once it has
 * laid the card out ('notification-resize' below).
 */
function calcHeight(buttons) {
  if (!buttons || buttons.length <= 2) return BASE_HEIGHT;
  return BASE_HEIGHT + 28; // extra row for 3-4 buttons
}

/**
 * Show a notification window
 */
/**
 * True when the app runs as a native Wayland client. There a toplevel window
 * cannot place itself (setBounds is ignored) and mutter activates every new
 * window of a client that already has focus, `focusable: false` and
 * showInactive() notwithstanding - so the custom toast would steal the keyboard
 * from whatever the user is typing into, and focus cannot be taken back without
 * an activation token. The desktop's own notification banner never takes focus.
 */
function isNativeWayland() {
  if (process.platform !== 'linux') return false;
  const ozone = app.commandLine.getSwitchValue('ozone-platform');
  if (ozone === 'x11') return false;
  if (ozone === 'wayland') return true;
  return process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY;
}

/**
 * Wayland path: a system notification. Loses the inline buttons (Electron only
 * supports notification actions on macOS), so a click does what 'show' does and
 * anything else - answers, allow/deny - is done from the app.
 */
function showSystemNotification({ title, body, terminalId }) {
  const notifId = ++notifIdCounter;
  if (!Notification.isSupported()) return notifId;
  const n = new Notification({ title: title || 'Claude Terminal', body: body || '', silent: false });
  n.on('click', () => focusMainAndOpen(terminalId));
  n.show();
  return notifId;
}

function focusMainAndOpen(terminalId) {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(false);
  setTimeout(() => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('notification-clicked', { terminalId, answerText: null });
    }
  }, 300);
}

function showNotification({ title, body, terminalId, autoDismiss = 8000, labels, buttons, meta }) {
  if (isNativeWayland()) return showSystemNotification({ title, body, terminalId });
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
      sandbox: true,
      preload: path.join(__dirname, '..', 'preload-notification.js')
    }
  });

  const notifMeta = Object.assign({}, meta || {});
  const data = encodeURIComponent(JSON.stringify({ title, body, terminalId, notifId, autoDismiss, buttons: normalizedButtons, meta: notifMeta }));
  const htmlPath = path.join(__dirname, '..', '..', '..', 'notification.html');
  require('../utils/rendererSecurity').guardWindow(win, htmlPath);
  win.loadFile(htmlPath, { search: `data=${data}` });

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive();
  });

  // Safety net: force-close even if the renderer never sends 'notification-dismiss'
  // (e.g. its script threw before arming the auto-dismiss timer). Only for auto-dismissing
  // notifications — autoDismiss:0 means "persistent" and must stay until the user acts.
  let safetyTimer = null;
  if (autoDismiss && autoDismiss > 0) {
    safetyTimer = setTimeout(() => dismissNotification(notifId), autoDismiss + 2000);
  }

  // Single cleanup point: the 'closed' event handles all map/reposition work
  win.on('closed', () => {
    if (safetyTimer) clearTimeout(safetyTimer);
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
    // Clamp to the top of the work area so a tall stack never spills off-screen (unclickable).
    const y = Math.max(workArea.y, currentY);
    notif.window.setBounds({
      x: rightEdge - WIDTH,
      y,
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
      focusMainAndOpen(terminalId);
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

  // The card measures itself once laid out and reports the height it actually
  // needs. repositionAll() applies it, so a notification that grew also pushes
  // the ones stacked above it rather than overlapping them.
  ipcMain.on('notification-resize', (event, { notifId, height }) => {
    const notif = activeNotifications.get(notifId);
    if (!notif || notif.window.isDestroyed()) return;
    if (!Number.isFinite(height)) return;
    const clamped = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(height)));
    if (clamped === notif.height) return;
    notif.height = clamped;
    repositionAll();
  });
}

module.exports = {
  showNotification,
  dismissNotification,
  registerNotificationHandlers
};
