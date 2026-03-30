/**
 * Toast Component
 * Notification toast messages
 */

const { BaseComponent } = require('../../core/BaseComponent');
const { escapeHtml } = require('../../utils/dom');
const { t } = require('../../i18n');

// Max visible toasts — oldest are evicted when exceeded
const MAX_VISIBLE_TOASTS = 5;

const TOAST_ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>'
};

/**
 * Calculate auto-hide duration based on message length.
 * Min 3s, +1s per 50 characters, max 10s.
 */
function calculateDuration(message) {
  const baseDuration = 3000;
  const perCharChunk = Math.floor(message.length / 50);
  const computed = baseDuration + perCharChunk * 1000;
  return Math.min(computed, 10000);
}

class Toast extends BaseComponent {
  constructor() {
    super(null);
    this._container = null;
  }

  _ensureContainer() {
    if (!this._container) {
      this._container = document.createElement('div');
      this._container.className = 'toast-container';
      this._container.setAttribute('role', 'log');
      this._container.setAttribute('aria-live', 'polite');
      this._container.setAttribute('aria-relevant', 'additions');
      document.body.appendChild(this._container);
    }
  }

  _enforceStackLimit() {
    if (!this._container) return;
    const toasts = this._container.querySelectorAll('.toast');
    const overflow = toasts.length - MAX_VISIBLE_TOASTS;
    if (overflow > 0) {
      for (let i = 0; i < overflow; i++) {
        this.hideToast(toasts[i]);
      }
    }
  }

  showToast({ message, type = 'info', duration, action, onAction }) {
    this._ensureContainer();

    if (duration === undefined) {
      duration = calculateDuration(message);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'alert');

    toast.innerHTML = `
      <span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span>
      <span class="toast-message">${escapeHtml(message)}</span>
      ${action ? `<button class="toast-action">${escapeHtml(action)}</button>` : ''}
      <button class="toast-close" aria-label="${t('common.close')}">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    `;

    toast.querySelector('.toast-close').onclick = () => {
      this.hideToast(toast);
    };

    if (action && onAction) {
      toast.querySelector('.toast-action').onclick = () => {
        onAction();
        this.hideToast(toast);
      };
    }

    this._container.appendChild(toast);
    this._enforceStackLimit();

    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    if (duration > 0) {
      let timerId = null;
      let remaining = duration;
      let startTime = Date.now();

      const startTimer = () => {
        startTime = Date.now();
        timerId = setTimeout(() => {
          this.hideToast(toast);
        }, remaining);
      };

      toast.addEventListener('mouseenter', () => {
        if (timerId) {
          clearTimeout(timerId);
          timerId = null;
          remaining -= (Date.now() - startTime);
          if (remaining < 500) remaining = 500;
        }
      });

      toast.addEventListener('mouseleave', () => {
        if (!timerId && toast.parentNode) {
          startTimer();
        }
      });

      startTimer();

      toast._autoHideTimer = () => {
        if (timerId) {
          clearTimeout(timerId);
          timerId = null;
        }
      };
    }

    return toast;
  }

  hideToast(toast) {
    if (toast._hiding) return;
    toast._hiding = true;

    if (toast._autoHideTimer) {
      toast._autoHideTimer();
      delete toast._autoHideTimer;
    }

    toast.classList.remove('show');
    toast.classList.add('hide');

    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
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
    });
  }

  clearAllToasts() {
    if (this._container) {
      this._container.innerHTML = '';
    }
  }

  destroy() {
    this.clearAllToasts();
    if (this._container && this._container.parentNode) {
      this._container.parentNode.removeChild(this._container);
    }
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
  showToast: (opts) => _getInstance().showToast(opts),
  show: (message, type = 'info', duration) => _getInstance().showToast({ message, type, duration }),
  hideToast: (toast) => _getInstance().hideToast(toast),
  showSuccess: (msg, dur) => _getInstance().showSuccess(msg, dur),
  showError: (msg, dur) => _getInstance().showError(msg, dur),
  showWarning: (msg, dur) => _getInstance().showWarning(msg, dur),
  showInfo: (msg, dur) => _getInstance().showInfo(msg, dur),
  withUndo: (msg, cb, opts) => _getInstance().withUndo(msg, cb, opts),
  clearAllToasts: () => _getInstance().clearAllToasts()
};
