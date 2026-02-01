/**
 * Context Menu Component
 * Right-click context menu functionality
 */

const { escapeHtml } = require('../../utils/dom');
const { t } = require('../../i18n');

// Current context menu state
let currentMenu = null;

/**
 * Create and show a context menu
 * @param {Object} options
 * @param {number} options.x - X position
 * @param {number} options.y - Y position
 * @param {Array} options.items - Menu items
 * @param {Object} options.target - Target data
 */
function showContextMenu({ x, y, items, target }) {
  // Close existing menu
  hideContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  const itemsHtml = items.map((item, index) => {
    if (item.separator) {
      return '<div class="context-menu-separator"></div>';
    }

    const disabled = item.disabled ? 'disabled' : '';
    const danger = item.danger ? 'danger' : '';

    return `
      <button class="context-menu-item ${disabled} ${danger}" data-index="${index}" ${disabled ? 'disabled' : ''}>
        ${item.icon ? `<span class="context-menu-icon">${item.icon}</span>` : ''}
        <span class="context-menu-label">${escapeHtml(item.label)}</span>
        ${item.shortcut ? `<span class="context-menu-shortcut">${escapeHtml(item.shortcut)}</span>` : ''}
      </button>
    `;
  }).join('');

  menu.innerHTML = itemsHtml;

  // Position menu
  document.body.appendChild(menu);

  // Adjust position if menu would go off screen
  const rect = menu.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  if (x + rect.width > viewportWidth) {
    x = x - rect.width;
    if (x < 4) x = 4;
  }
  if (y + rect.height > viewportHeight) {
    y = y - rect.height;
    if (y < 4) y = 4;
  }

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  // Item click handlers
  menu.querySelectorAll('.context-menu-item:not([disabled])').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const index = parseInt(btn.dataset.index);
      const item = items[index];
      if (item && item.onClick) {
        item.onClick(target);
      }
      hideContextMenu();
    };
  });

  // Show with animation
  requestAnimationFrame(() => {
    menu.classList.add('show');
  });

  currentMenu = menu;

  // Close handlers
  document.addEventListener('click', handleClickOutside);
  document.addEventListener('contextmenu', handleClickOutside);
  document.addEventListener('keydown', handleEscape);
}

/**
 * Hide context menu
 */
function hideContextMenu() {
  if (currentMenu) {
    currentMenu.classList.remove('show');
    setTimeout(() => {
      if (currentMenu && currentMenu.parentNode) {
        currentMenu.parentNode.removeChild(currentMenu);
      }
      currentMenu = null;
    }, 150);

    document.removeEventListener('click', handleClickOutside);
    document.removeEventListener('contextmenu', handleClickOutside);
    document.removeEventListener('keydown', handleEscape);
  }
}

/**
 * Handle click outside menu
 * @param {Event} e
 */
function handleClickOutside(e) {
  if (currentMenu && !currentMenu.contains(e.target)) {
    hideContextMenu();
  }
}

/**
 * Handle escape key
 * @param {KeyboardEvent} e
 */
function handleEscape(e) {
  if (e.key === 'Escape') {
    hideContextMenu();
  }
}

/**
 * Setup context menu on element
 * @param {HTMLElement} element
 * @param {Function} getItems - Function that returns items array
 * @param {Function} getTarget - Function that returns target data
 */
function setupContextMenu(element, getItems, getTarget) {
  element.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const target = getTarget ? getTarget(e) : null;
    const items = getItems(target, e);

    if (items && items.length > 0) {
      showContextMenu({
        x: e.clientX,
        y: e.clientY,
        items,
        target
      });
    }
  });
}

/**
 * Create common menu item configurations
 */
const MenuItems = {
  separator: () => ({ separator: true }),

  rename: (onClick) => ({
    label: t('common.rename'),
    icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
    onClick
  }),

  delete: (onClick) => ({
    label: t('common.delete'),
    icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
    danger: true,
    onClick
  }),

  openFolder: (onClick) => ({
    label: t('projects.openFolder'),
    icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7l2 2h5v12zm0-12h-5l-2-2H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2z"/></svg>',
    onClick
  }),

  newFolder: (onClick) => ({
    label: t('projects.newFolder'),
    icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z"/></svg>',
    onClick
  })
};

module.exports = {
  showContextMenu,
  hideContextMenu,
  setupContextMenu,
  MenuItems
};
