/**
 * Toast Component
 *
 * The single in-app notification surface. Two implementations used to coexist —
 * this one and a copy in `renderer.js` — sharing the same CSS classes but not the
 * same DOM shape or the same container, so a toast looked different depending on
 * which module happened to raise it. `renderer.js` now delegates here.
 *
 * One toast shape covers every caller:
 *   [icon] [title? / message?] [count?] [action?] [close]  + progress bar
 * Title and message are both optional; the content column is the only flexible
 * element, which is what keeps the close button pinned to the right edge.
 */

const { BaseComponent } = require('../../core/BaseComponent');
const { escapeHtml } = require('../../utils/dom');
const { t } = require('../../i18n');

// Max visible toasts — oldest are evicted when exceeded
const MAX_VISIBLE_TOASTS = 5;

// Time the hide animation needs before the node can be removed (keep in sync
// with the `toast-slide-out` duration in styles/modals.css).
const HIDE_ANIMATION_MS = 260;

// Messages longer than this are truncated — a toast is a glance, not a log
const MAX_MESSAGE_LENGTH = 200;

const TOAST_ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
};

const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

/**
 * Calculate auto-hide duration based on how much there is to read.
 * Min 3s, +1s per 50 characters, max 10s.
 */
function calculateDuration(text) {
  const baseDuration = 3000;
  const perCharChunk = Math.floor((text || '').length / 50);
  return Math.min(baseDuration + perCharChunk * 1000, 10000);
}

function truncate(text) {
  if (!text) return '';
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
}

class Toast extends BaseComponent {
  constructor() {
    super(null);
    this._container = null;
  }

  /**
   * Resolve the one container. `index.html` ships `#toast-container`; anything
   * that loads this module without that markup (tests, the quick picker) gets an
   * equivalent created on demand.
   */
  _ensureContainer() {
    if (this._container && this._container.isConnected) return this._container;

    const existing = document.getElementById('toast-container');
    if (existing) {
      this._container = existing;
    } else {
      this._container = document.createElement('div');
      this._container.className = 'toast-container';
      this._container.id = 'toast-container';
      document.body.appendChild(this._container);
    }

    this._container.setAttribute('role', 'log');
    this._container.setAttribute('aria-live', 'polite');
    this._container.setAttribute('aria-relevant', 'additions');
    return this._container;
  }

  _liveToasts() {
    if (!this._container) return [];
    return Array.from(this._container.querySelectorAll('.toast')).filter(el => !el._hiding);
  }

  _enforceStackLimit() {
    const toasts = this._liveToasts();
    const overflow = toasts.length - MAX_VISIBLE_TOASTS;
    for (let i = 0; i < overflow; i++) this.hideToast(toasts[i]);
  }

  /**
   * Fold a repeat into the toast already on screen: bump its counter and restart
   * its timer. Saving the same settings twice used to stack two identical cards.
   */
  _coalesce(key) {
    const existing = this._liveToasts().find(el => el._toastKey === key);
    if (!existing) return null;

    existing._toastCount = (existing._toastCount || 1) + 1;
    let badge = existing.querySelector('.toast-count');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'toast-count';
      existing.querySelector('.toast-content').after(badge);
    }
    badge.textContent = `×${existing._toastCount}`;

    existing.classList.remove('toast-pulse');
    // Force a reflow so the animation restarts on a consecutive repeat
    void existing.offsetWidth;
    existing.classList.add('toast-pulse');

    if (existing._restartTimer) existing._restartTimer();
    return existing;
  }

  /**
   * @param {Object} opts
   * @param {string} [opts.type='info']   'success' | 'error' | 'warning' | 'info'
   * @param {string} [opts.title]         Bold first line
   * @param {string} [opts.message]       Body text (newlines are preserved)
   * @param {number} [opts.duration]      ms; 0 keeps the toast until dismissed
   * @param {string} [opts.action]        Label for an inline action button
   * @param {Function} [opts.onAction]    Handler for that button
   * @param {boolean} [opts.dedupe=true]  Fold repeats into one card
   * @returns {HTMLElement} the toast element
   */
  showToast({ message, title, type = 'info', duration, action, onAction, dedupe = true }) {
    const container = this._ensureContainer();

    const safeTitle = title ? String(title) : '';
    const safeMessage = truncate(message ? String(message) : '');

    if (duration === undefined) duration = calculateDuration(safeMessage || safeTitle);

    // A persistent toast is a handle its caller keeps and mutates — never fold those.
    const key = `${type}|${safeTitle}|${safeMessage}|${action || ''}`;
    if (dedupe && duration > 0) {
      const merged = this._coalesce(key);
      if (merged) return merged;
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast._toastKey = key;
    toast._toastCount = 1;

    const body = safeMessage ? escapeHtml(safeMessage).replace(/\n/g, '<br>') : '';

    toast.innerHTML = `
      <span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span>
      <div class="toast-content">
        ${safeTitle ? `<div class="toast-title">${escapeHtml(safeTitle)}</div>` : ''}
        ${body ? `<div class="toast-message">${body}</div>` : ''}
      </div>
      ${action ? `<button class="toast-action" type="button">${escapeHtml(action)}</button>` : ''}
      <button class="toast-close" type="button" aria-label="${escapeHtml(t('common.close') || 'Close')}">${CLOSE_ICON}</button>
      ${duration > 0 ? '<div class="toast-progress"></div>' : ''}
    `;

    toast.querySelector('.toast-close').onclick = () => this.hideToast(toast);

    if (action && onAction) {
      toast.querySelector('.toast-action').onclick = () => {
        onAction();
        this.hideToast(toast);
      };
    }

    container.appendChild(toast);
    this._enforceStackLimit();

    requestAnimationFrame(() => toast.classList.add('show'));

    if (duration > 0) this._attachTimer(toast, duration);

    return toast;
  }

  /**
   * Auto-hide with a progress bar that pauses while the pointer is over the toast
   * (or while it holds focus, so keyboard users get the same reprieve).
   */
  _attachTimer(toast, duration) {
    const progress = toast.querySelector('.toast-progress');
    let timerId = null;
    let remaining = duration;
    let startTime = 0;

    const runProgress = (ms) => {
      if (!progress) return;
      progress.style.transition = 'none';
      progress.style.transform = `scaleX(${remaining / duration})`;
      void progress.offsetWidth;
      progress.style.transition = `transform ${ms}ms linear`;
      progress.style.transform = 'scaleX(0)';
    };

    const start = () => {
      startTime = Date.now();
      runProgress(remaining);
      timerId = setTimeout(() => this.hideToast(toast), remaining);
    };

    const pause = () => {
      if (!timerId) return;
      clearTimeout(timerId);
      timerId = null;
      remaining = Math.max(500, remaining - (Date.now() - startTime));
      if (progress) {
        const current = getComputedStyle(progress).transform;
        progress.style.transition = 'none';
        progress.style.transform = current === 'none' ? 'scaleX(1)' : current;
      }
    };

    const resume = () => {
      if (!timerId && toast.isConnected && !toast._hiding) start();
    };

    toast.addEventListener('mouseenter', pause);
    toast.addEventListener('mouseleave', resume);
    toast.addEventListener('focusin', pause);
    toast.addEventListener('focusout', resume);

    toast._restartTimer = () => {
      if (timerId) clearTimeout(timerId);
      timerId = null;
      remaining = duration;
      start();
    };
    toast._clearTimer = () => {
      if (timerId) clearTimeout(timerId);
      timerId = null;
    };

    start();
  }

  hideToast(toast) {
    if (!toast || toast._hiding) return;
    toast._hiding = true;

    if (toast._clearTimer) toast._clearTimer();

    toast.classList.remove('show');
    toast.classList.add('hide');

    setTimeout(() => toast.remove(), HIDE_ANIMATION_MS);
  }

  showSuccess(message, duration) {
    return this.showToast({ message, type: 'success', duration });
  }

  showError(message, duration) {
    return this.showToast({ message, type: 'error', duration });
  }

  showWarning(message, duration) {
    return this.showToast({ message, type: 'warning', duration });
  }

  showInfo(message, duration) {
    return this.showToast({ message, type: 'info', duration });
  }

  withUndo(message, undoCallback, { type = 'info', duration } = {}) {
    return this.showToast({
      message,
      type,
      duration: duration !== undefined ? duration : 8000,
      action: t('toast.undo') || 'Undo',
      onAction: undoCallback,
      dedupe: false,
    });
  }

  clearAllToasts() {
    this._liveToasts().forEach(el => this.hideToast(el));
  }

  destroy() {
    if (this._container) this._container.innerHTML = '';
    this._container = null;
    super.destroy();
  }
}

// ── Singleton + legacy bridge ──
let _instance = null;
function _getInstance() {
  if (!_instance) _instance = new Toast();
  return _instance;
}

module.exports = {
  Toast,
  showToast: (opts) => _getInstance().showToast(opts || {}),
  show: (message, type = 'info', duration) => _getInstance().showToast({ message, type, duration }),
  hideToast: (toast) => _getInstance().hideToast(toast),
  showSuccess: (msg, dur) => _getInstance().showSuccess(msg, dur),
  showError: (msg, dur) => _getInstance().showError(msg, dur),
  showWarning: (msg, dur) => _getInstance().showWarning(msg, dur),
  showInfo: (msg, dur) => _getInstance().showInfo(msg, dur),
  withUndo: (msg, cb, opts) => _getInstance().withUndo(msg, cb, opts),
  clearAllToasts: () => _getInstance().clearAllToasts()
};
