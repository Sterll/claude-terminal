/**
 * Modal Component
 * Reusable modal dialog component
 */

const { escapeHtml } = require('../../utils/dom');
const { t } = require('../../i18n');

// Detect platform for button order convention
const isWindows = typeof process !== 'undefined' ? process.platform === 'win32' : navigator.userAgent.includes('Windows');

/**
 * Create a modal element
 * @param {Object} options
 * @param {string} options.id - Modal ID
 * @param {string} options.title - Modal title
 * @param {string} options.content - Modal body content (HTML)
 * @param {Array} options.buttons - Button configurations
 * @param {string} options.size - Modal size ('small', 'medium', 'large')
 * @param {Function} options.onClose - Close callback
 * @returns {HTMLElement}
 */
function createModal({ id, title, content, buttons = [], size = 'medium', onClose }) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = id;

  const sizeClass = {
    small: 'modal-small',
    medium: 'modal-medium',
    large: 'modal-large'
  }[size] || 'modal-medium';

  const buttonsHtml = buttons.map(btn => `
    <button class="btn ${btn.primary ? 'btn-primary' : 'btn-secondary'}" data-action="${btn.action}">
      ${escapeHtml(btn.label)}
    </button>
  `).join('');

  modal.innerHTML = `
    <div class="modal ${sizeClass}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="modal-header">
        <h3>${escapeHtml(title)}</h3>
        <button class="modal-close" aria-label="${t('common.close')}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
      <div class="modal-body">
        ${content}
      </div>
      ${buttons.length > 0 ? `
        <div class="modal-footer">
          ${buttonsHtml}
        </div>
      ` : ''}
    </div>
  `;

  // Close button handler
  modal.querySelector('.modal-close').onclick = () => {
    closeModal(modal);
    if (onClose) onClose();
  };

  // Backdrop click — use closest to properly detect clicks outside modal-content
  modal.onclick = (e) => {
    if (!e.target.closest('.modal')) {
      closeModal(modal);
      if (onClose) onClose();
    }
  };

  // Button handlers
  modal.querySelectorAll('[data-action]').forEach(btn => {
    btn.onclick = () => {
      const action = btn.dataset.action;
      const buttonConfig = buttons.find(b => b.action === action);
      if (buttonConfig && buttonConfig.onClick) {
        buttonConfig.onClick(modal);
      }
    };
  });

  return modal;
}

/**
 * Get all focusable elements within a container
 */
function getFocusableElements(container) {
  return container.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
}

/**
 * Show a modal
 * @param {HTMLElement} modal
 */
function showModal(modal) {
  // Lock body scroll
  const scrollY = window.scrollY;
  modal._prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  modal._scrollY = scrollY;

  document.body.appendChild(modal);
  requestAnimationFrame(() => {
    modal.classList.add('active');
  });

  // Focus first input if exists
  const firstInput = modal.querySelector('input, select, textarea');
  if (firstInput) {
    firstInput.focus();
  }

  // Focus trap — cycle Tab within the modal
  const trapHandler = (e) => {
    if (e.key !== 'Tab') return;
    const focusable = getFocusableElements(modal);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  modal._trapHandler = trapHandler;
  document.addEventListener('keydown', trapHandler);

  // Escape key handler
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      closeModal(modal);
    }
  };
  modal._escHandler = escHandler;
  document.addEventListener('keydown', escHandler);

  // MutationObserver — resolve promise if modal is removed externally
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const removed of mutation.removedNodes) {
        if (removed === modal || removed.contains?.(modal)) {
          cleanupModal(modal);
          observer.disconnect();
          return;
        }
      }
    }
  });
  if (modal.parentNode) {
    observer.observe(modal.parentNode, { childList: true });
  }
  modal._observer = observer;
}

/**
 * Internal cleanup — removes listeners without DOM removal
 */
function cleanupModal(modal) {
  if (modal._escHandler) {
    document.removeEventListener('keydown', modal._escHandler);
    delete modal._escHandler;
  }
  if (modal._trapHandler) {
    document.removeEventListener('keydown', modal._trapHandler);
    delete modal._trapHandler;
  }
  if (modal._observer) {
    modal._observer.disconnect();
    delete modal._observer;
  }
  // Restore body scroll
  document.body.style.overflow = modal._prevOverflow || '';
  delete modal._prevOverflow;
}

/**
 * Close a modal
 * @param {HTMLElement} modal
 */
function closeModal(modal) {
  cleanupModal(modal);
  modal.classList.remove('active');
  setTimeout(() => {
    if (modal.parentNode) {
      modal.parentNode.removeChild(modal);
    }
  }, 200);
}

/**
 * Close modal by ID
 * @param {string} id
 */
function closeModalById(id) {
  const modal = document.getElementById(id);
  if (modal) {
    closeModal(modal);
  }
}

/**
 * Show a confirmation dialog
 * @param {Object} options
 * @param {string} options.title
 * @param {string} options.message
 * @param {string} options.confirmLabel
 * @param {string} options.cancelLabel
 * @param {boolean} options.danger
 * @returns {Promise<boolean>}
 */
function showConfirm({ title, message, confirmLabel = null, cancelLabel = null, danger = false }) {
  confirmLabel = confirmLabel || t('common.confirm');
  cancelLabel = cancelLabel || t('common.cancel');

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      cleanupModal(overlay);
      overlay.classList.remove('active');
      setTimeout(() => overlay.remove(), 200);
      document.removeEventListener('keydown', keyHandler);
      resolve(value);
    };

    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const iconSvg = danger
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
           <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
           <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
           <line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>
         </svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
           <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
         </svg>`;

    // Platform button order: Windows = OK left, macOS = OK right
    const cancelBtn = `<button class="confirm-btn-cancel">${escapeHtml(cancelLabel)}</button>`;
    const okBtn = `<button class="confirm-btn-ok">${escapeHtml(confirmLabel)}</button>`;
    const buttonsHtml = isWindows ? `${okBtn}${cancelBtn}` : `${cancelBtn}${okBtn}`;

    overlay.innerHTML = `
      <div class="confirm-dialog${danger ? ' confirm-danger' : ''}" role="alertdialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="confirm-icon">${iconSvg}</div>
        <div class="confirm-title">${escapeHtml(title)}</div>
        <div class="confirm-message">${escapeHtml(message)}</div>
        <div class="confirm-actions">
          ${buttonsHtml}
        </div>
      </div>
    `;

    overlay.querySelector('.confirm-btn-cancel').onclick = () => finish(false);
    overlay.querySelector('.confirm-btn-ok').onclick = () => finish(true);
    overlay.addEventListener('click', (e) => {
      if (!e.target.closest('.confirm-dialog')) finish(false);
    });

    // Lock body scroll
    overlay._prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus trap for confirm dialog
    const trapHandler = (e) => {
      if (e.key !== 'Tab') return;
      const focusable = getFocusableElements(overlay);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    overlay._trapHandler = trapHandler;
    document.addEventListener('keydown', trapHandler);

    const keyHandler = (e) => {
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter') finish(true);
    };
    document.addEventListener('keydown', keyHandler);

    // MutationObserver — resolve false if overlay removed externally
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const removed of mutation.removedNodes) {
          if (removed === overlay || removed.contains?.(overlay)) {
            observer.disconnect();
            finish(false);
            return;
          }
        }
      }
    });
    overlay._observer = observer;

    document.body.appendChild(overlay);

    observer.observe(document.body, { childList: true });

    requestAnimationFrame(() => {
      overlay.classList.add('active');
      // Focus the appropriate button (cancel on danger for safety, ok otherwise)
      const focusBtn = danger
        ? overlay.querySelector('.confirm-btn-cancel')
        : overlay.querySelector('.confirm-btn-ok');
      if (focusBtn) focusBtn.focus();
    });
  });
}

/**
 * Show a prompt dialog
 * @param {Object} options
 * @param {string} options.title
 * @param {string} options.message
 * @param {string} options.defaultValue
 * @param {string} options.placeholder
 * @returns {Promise<string|null>}
 */
function showPrompt({ title, message = '', defaultValue = '', placeholder = '' }) {
  return new Promise((resolve) => {
    const inputId = 'prompt-input-' + Date.now();

    const modal = createModal({
      id: 'prompt-modal',
      title,
      content: `
        ${message ? `<p>${escapeHtml(message)}</p>` : ''}
        <input type="text" id="${inputId}" class="input" value="${escapeHtml(defaultValue)}" placeholder="${escapeHtml(placeholder)}">
      `,
      buttons: [
        {
          label: t('common.cancel'),
          action: 'cancel',
          onClick: (m) => {
            closeModal(m);
            resolve(null);
          }
        },
        {
          label: t('common.ok'),
          action: 'confirm',
          primary: true,
          onClick: (m) => {
            const input = m.querySelector(`#${inputId}`);
            closeModal(m);
            resolve(input.value);
          }
        }
      ],
      size: 'small',
      onClose: () => resolve(null)
    });

    showModal(modal);

    // Enter key handler
    const input = modal.querySelector(`#${inputId}`);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        closeModal(modal);
        resolve(input.value);
      }
    };
  });
}

module.exports = {
  createModal,
  showModal,
  closeModal,
  closeModalById,
  showConfirm,
  showPrompt
};
