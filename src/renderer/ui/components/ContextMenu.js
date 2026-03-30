/**
 * Context Menu Component
 * Right-click context menu functionality
 */

const { BaseComponent } = require('../../core/BaseComponent');
const { escapeHtml } = require('../../utils/dom');
const { t } = require('../../i18n');

class ContextMenu extends BaseComponent {
  constructor() {
    super(null);
    this._currentMenu = null;
    this._handleClickOutside = this._handleClickOutside.bind(this);
    this._handleEscape = this._handleEscape.bind(this);
  }

  showContextMenu({ x, y, items, target }) {
    this.hideContextMenu();

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

    menu.style.display = 'block';
    menu.style.opacity = '0';
    menu.style.pointerEvents = 'none';
    document.body.appendChild(menu);

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

    menu.querySelectorAll('.context-menu-item:not([disabled])').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const index = parseInt(btn.dataset.index);
        const item = items[index];
        if (item && item.onClick) {
          item.onClick(target);
        }
        this.hideContextMenu();
      };
    });

    menu.style.display = '';
    menu.style.opacity = '';
    menu.style.pointerEvents = '';
    requestAnimationFrame(() => {
      menu.classList.add('show');
    });

    this._currentMenu = menu;

    document.addEventListener('click', this._handleClickOutside);
    document.addEventListener('contextmenu', this._handleClickOutside);
    document.addEventListener('keydown', this._handleEscape);
  }

  hideContextMenu() {
    if (this._currentMenu) {
      const menuToRemove = this._currentMenu;
      this._currentMenu = null;
      menuToRemove.classList.remove('show');
      setTimeout(() => {
        if (menuToRemove.parentNode) {
          menuToRemove.parentNode.removeChild(menuToRemove);
        }
      }, 150);

      document.removeEventListener('click', this._handleClickOutside);
      document.removeEventListener('contextmenu', this._handleClickOutside);
      document.removeEventListener('keydown', this._handleEscape);
    }
  }

  _handleClickOutside(e) {
    if (this._currentMenu && !this._currentMenu.contains(e.target)) {
      this.hideContextMenu();
    }
  }

  _handleEscape(e) {
    if (e.key === 'Escape') {
      this.hideContextMenu();
    }
  }

  setupContextMenu(element, getItems, getTarget) {
    element.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const target = getTarget ? getTarget(e) : null;
      const items = getItems(target, e);

      if (items && items.length > 0) {
        this.showContextMenu({
          x: e.clientX,
          y: e.clientY,
          items,
          target
        });
      }
    });
  }

  destroy() {
    this.hideContextMenu();
    super.destroy();
  }
}

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

// ── Singleton + legacy bridge ──
let _instance = null;
function _getInstance() {
  if (!_instance) _instance = new ContextMenu();
  return _instance;
}

module.exports = {
  ContextMenu,
  showContextMenu: (opts) => _getInstance().showContextMenu(opts),
  hideContextMenu: () => _getInstance().hideContextMenu(),
  setupContextMenu: (el, getItems, getTarget) => _getInstance().setupContextMenu(el, getItems, getTarget),
  MenuItems
};
