/**
 * Modal Component
 * Reusable modal dialog component
 */

const { escapeHtml } = require('../../utils/dom');
const { t } = require('../../i18n');

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

  // Overlay click handler
  modal.onclick = (e) => {
    if (e.target === modal) {
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
 * Show a modal
 * @param {HTMLElement} modal
 */
function showModal(modal) {
  document.body.appendChild(modal);
  requestAnimationFrame(() => {
    modal.classList.add('active');
  });

  // Focus first input if exists
  const firstInput = modal.querySelector('input, select, textarea');
  if (firstInput) {
    firstInput.focus();
  }

  // Escape key handler
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      closeModal(modal);
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
}

/**
 * Close a modal
 * @param {HTMLElement} modal
 */
function closeModal(modal) {
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

    overlay.innerHTML = `
      <div class="confirm-dialog${danger ? ' confirm-danger' : ''}">
        <div class="confirm-icon">${iconSvg}</div>
        <div class="confirm-title">${escapeHtml(title)}</div>
        <div class="confirm-message">${escapeHtml(message)}</div>
        <div class="confirm-actions">
          <button class="confirm-btn-cancel">${escapeHtml(cancelLabel)}</button>
          <button class="confirm-btn-ok">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;

    overlay.querySelector('.confirm-btn-cancel').onclick = () => finish(false);
    overlay.querySelector('.confirm-btn-ok').onclick = () => finish(true);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false);
    });

    const keyHandler = (e) => {
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter') finish(true);
    };
    document.addEventListener('keydown', keyHandler);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.classList.add('active');
      overlay.querySelector('.confirm-btn-cancel').focus();
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
