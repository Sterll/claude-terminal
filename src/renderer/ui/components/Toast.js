/**
 * Toast Component
 * Notification toast messages
 */

const { escapeHtml } = require('../../utils/dom');
const { t } = require('../../i18n');

// Toast container element
let toastContainer = null;

// Max visible toasts — oldest are evicted when exceeded
const MAX_VISIBLE_TOASTS = 5;

/**
 * Initialize toast container
 */
function initToastContainer() {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    toastContainer.setAttribute('role', 'status');
    toastContainer.setAttribute('aria-live', 'polite');
    toastContainer.setAttribute('aria-relevant', 'additions');
    document.body.appendChild(toastContainer);
  }
}

/**
 * Calculate auto-hide duration based on message length.
 * Min 3s, +1s per 50 characters, max 10s.
 */
function calculateDuration(message, type) {
  const baseDuration = 3000;
  const perCharChunk = Math.floor(message.length / 50);
  const computed = baseDuration + perCharChunk * 1000;
  return Math.min(computed, 10000);
}

/**
 * Evict oldest toasts when stack exceeds MAX_VISIBLE_TOASTS.
 */
function enforceStackLimit() {
  if (!toastContainer) return;
  const toasts = toastContainer.querySelectorAll('.toast');
  const overflow = toasts.length - MAX_VISIBLE_TOASTS;
  if (overflow > 0) {
    for (let i = 0; i < overflow; i++) {
      hideToast(toasts[i]);
    }
  }
}

/**
 * Show a toast message
 * @param {Object} options
 * @param {string} options.message - Toast message
 * @param {string} options.type - Toast type ('success', 'error', 'warning', 'info')
 * @param {number} options.duration - Duration in ms (0 for persistent, undefined for auto-calculated)
 * @param {string} options.action - Action button label
 * @param {Function} options.onAction - Action button callback
 * @returns {HTMLElement}
 */
function showToast({ message, type = 'info', duration, action, onAction }) {
  initToastContainer();

  // Auto-calculate duration if not explicitly provided
  if (duration === undefined) {
    duration = calculateDuration(message, type);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'alert');

  const icons = {
    success: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>'
  };

  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
    ${action ? `<button class="toast-action">${escapeHtml(action)}</button>` : ''}
    <button class="toast-close" aria-label="${t('common.close')}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
    </button>
  `;

  // Close button handler
  toast.querySelector('.toast-close').onclick = () => {
    hideToast(toast);
  };

  // Action button handler
  if (action && onAction) {
    toast.querySelector('.toast-action').onclick = () => {
      onAction();
      hideToast(toast);
    };
  }

  toastContainer.appendChild(toast);

  // Enforce stack limit — evict oldest if over max
  enforceStackLimit();

  // Animate in
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  // Auto hide with hover-to-pause
  if (duration > 0) {
    let timerId = null;
    let remaining = duration;
    let startTime = Date.now();

    const startTimer = () => {
      startTime = Date.now();
      timerId = setTimeout(() => {
        hideToast(toast);
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

    // Store cleanup ref so hideToast can clear
    toast._autoHideTimer = () => {
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
    };
  }

  return toast;
}

/**
 * Hide a toast
 * @param {HTMLElement} toast
 */
function hideToast(toast) {
  if (toast._hiding) return;
  toast._hiding = true;

  // Clear auto-hide timer if any
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

/**
 * Show success toast
 * @param {string} message
 * @param {number} duration
 */
function showSuccess(message, duration) {
  return showToast({ message, type: 'success', duration });
}

/**
 * Show error toast
 * @param {string} message
 * @param {number} duration
 */
function showError(message, duration) {
  return showToast({ message, type: 'error', duration });
}

/**
 * Show warning toast
 * @param {string} message
 * @param {number} duration
 */
function showWarning(message, duration) {
  return showToast({ message, type: 'warning', duration });
}

/**
 * Show info toast
 * @param {string} message
 * @param {number} duration
 */
function showInfo(message, duration) {
  return showToast({ message, type: 'info', duration });
}

/**
 * Show a toast with an "Undo" action button.
 * @param {string} message
 * @param {Function} undoCallback - Called when user clicks Undo
 * @param {Object} options - Additional toast options (type, duration)
 * @returns {HTMLElement}
 */
function withUndo(message, undoCallback, { type = 'info', duration } = {}) {
  return showToast({
    message,
    type,
    duration: duration !== undefined ? duration : 8000,
    action: t('toast.undo') || 'Undo',
    onAction: undoCallback,
  });
}

/**
 * Clear all toasts
 */
function clearAllToasts() {
  if (toastContainer) {
    toastContainer.innerHTML = '';
  }
}

module.exports = {
  showToast,
  hideToast,
  showSuccess,
  showError,
  showWarning,
  showInfo,
  withUndo,
  clearAllToasts
};
