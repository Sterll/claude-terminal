/**
 * CustomizePicker Component
 * Elegant popover for customizing project/folder colors and icons
 */

const { t } = require('../../i18n');

// Extended color palette with semantic groupings - keys for translation
const COLOR_PALETTE = {
  neutral: [
    { nameKey: 'customize.default', value: null },
    { nameKey: 'customize.colors.gray', value: '#6b7280' },
    { nameKey: 'customize.colors.slate', value: '#64748b' },
  ],
  warm: [
    { nameKey: 'customize.colors.red', value: '#ef4444' },
    { nameKey: 'customize.colors.pink', value: '#f43f5e' },
    { nameKey: 'customize.colors.orange', value: '#f97316' },
    { nameKey: 'customize.colors.amber', value: '#f59e0b' },
    { nameKey: 'customize.colors.yellow', value: '#eab308' },
  ],
  cool: [
    { nameKey: 'customize.colors.lime', value: '#84cc16' },
    { nameKey: 'customize.colors.green', value: '#22c55e' },
    { nameKey: 'customize.colors.emerald', value: '#10b981' },
    { nameKey: 'customize.colors.cyan', value: '#06b6d4' },
    { nameKey: 'customize.colors.blue', value: '#3b82f6' },
  ],
  vibrant: [
    { nameKey: 'customize.colors.indigo', value: '#6366f1' },
    { nameKey: 'customize.colors.violet', value: '#8b5cf6' },
    { nameKey: 'customize.colors.fuchsia', value: '#d946ef' },
    { nameKey: 'customize.colors.hotPink', value: '#ec4899' },
  ]
};

// Extended icon library with categories - use translation keys
const ICON_LIBRARY = {
  development: {
    labelKey: 'customize.iconCategories.development',
    icons: [
      { nameKey: 'customize.icons.code', value: '💻' },
      { nameKey: 'customize.icons.terminal', value: '⌨️' },
      { nameKey: 'customize.icons.bug', value: '🐛' },
      { nameKey: 'customize.icons.git', value: '🔀' },
      { nameKey: 'customize.icons.api', value: '🔌' },
      { nameKey: 'customize.icons.database', value: '🗄️' },
      { nameKey: 'customize.icons.server', value: '🖥️' },
      { nameKey: 'customize.icons.package', value: '📦' },
    ]
  },
  web: {
    labelKey: 'customize.iconCategories.webMobile',
    icons: [
      { nameKey: 'customize.icons.web', value: '🌐' },
      { nameKey: 'customize.icons.mobile', value: '📱' },
      { nameKey: 'customize.icons.responsive', value: '📲' },
      { nameKey: 'customize.icons.browser', value: '🖼️' },
      { nameKey: 'customize.icons.link', value: '🔗' },
      { nameKey: 'customize.icons.cloud', value: '☁️' },
    ]
  },
  creative: {
    labelKey: 'customize.iconCategories.creative',
    icons: [
      { nameKey: 'customize.icons.design', value: '🎨' },
      { nameKey: 'customize.icons.photo', value: '📷' },
      { nameKey: 'customize.icons.video', value: '🎬' },
      { nameKey: 'customize.icons.music', value: '🎵' },
      { nameKey: 'customize.icons.game', value: '🎮' },
      { nameKey: 'customize.icons.3d', value: '🧊' },
    ]
  },
  business: {
    labelKey: 'customize.iconCategories.business',
    icons: [
      { nameKey: 'customize.icons.chart', value: '📊' },
      { nameKey: 'customize.icons.money', value: '💰' },
      { nameKey: 'customize.icons.shop', value: '🛒' },
      { nameKey: 'customize.icons.mail', value: '📧' },
      { nameKey: 'customize.icons.calendar', value: '📅' },
      { nameKey: 'customize.icons.task', value: '✅' },
    ]
  },
  tech: {
    labelKey: 'customize.iconCategories.techAi',
    icons: [
      { nameKey: 'customize.icons.ai', value: '🤖' },
      { nameKey: 'customize.icons.chip', value: '🔲' },
      { nameKey: 'customize.icons.security', value: '🔒' },
      { nameKey: 'customize.icons.network', value: '🌍' },
      { nameKey: 'customize.icons.speed', value: '⚡' },
      { nameKey: 'customize.icons.lab', value: '🧪' },
    ]
  },
  symbols: {
    labelKey: 'customize.iconCategories.symbols',
    icons: [
      { nameKey: 'customize.icons.star', value: '⭐' },
      { nameKey: 'customize.icons.heart', value: '❤️' },
      { nameKey: 'customize.icons.fire', value: '🔥' },
      { nameKey: 'customize.icons.diamond', value: '💎' },
      { nameKey: 'customize.icons.crown', value: '👑' },
      { nameKey: 'customize.icons.rocket', value: '🚀' },
      { nameKey: 'customize.icons.target', value: '🎯' },
      { nameKey: 'customize.icons.trophy', value: '🏆' },
    ]
  }
};

// Active picker state
let activePicker = null;
let previewState = { originalColor: null, originalIcon: null };

/**
 * Get all colors as flat array
 */
function getAllColors() {
  return Object.values(COLOR_PALETTE).flat();
}

/**
 * Check if a color is in the preset palette
 */
function isPresetColor(color) {
  if (!color) return false;
  const allColors = getAllColors();
  return allColors.some(c => c.value && c.value.toLowerCase() === color.toLowerCase());
}

/**
 * Create the picker HTML
 */
function createPickerHtml(itemType, item) {
  const currentColor = item?.color || null;
  const currentIcon = item?.icon || null;
  const itemName = item?.name || 'Item';

  // Generate preview
  const previewIcon = currentIcon || (itemType === 'folder' ? '📁' : '📄');
  const previewColor = currentColor || 'var(--text-primary)';

  return `
    <div class="customize-picker" data-item-type="${itemType}">
      <!-- Header with preview -->
      <div class="customize-picker-header">
        <div class="customize-picker-preview" style="--preview-color: ${previewColor}">
          <span class="customize-picker-preview-icon">${previewIcon}</span>
        </div>
        <div class="customize-picker-title">
          <span class="customize-picker-name">${escapeHtml(itemName)}</span>
          <span class="customize-picker-subtitle">${t('customize.title')}</span>
        </div>
        <button class="customize-picker-close" aria-label="${t('common.close')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <!-- Tabs -->
      <div class="customize-picker-tabs">
        <button class="customize-picker-tab active" data-tab="colors">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>
          </svg>
          ${t('customize.color')}
        </button>
        <button class="customize-picker-tab" data-tab="icons">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/>
          </svg>
          ${t('customize.icon')}
        </button>
      </div>

      <!-- Tab content -->
      <div class="customize-picker-content">
        <!-- Colors panel -->
        <div class="customize-picker-panel active" data-panel="colors">
          ${Object.entries(COLOR_PALETTE).map(([group, colors]) => `
            <div class="customize-picker-group">
              <div class="customize-picker-colors">
                ${colors.map(c => `
                  <button class="customize-color-btn ${c.value === currentColor ? 'selected' : ''} ${!c.value ? 'default' : ''}"
                          data-color="${c.value || ''}"
                          title="${t(c.nameKey)}"
                          ${c.value ? `style="--swatch-color: ${c.value}"` : ''}>
                    ${c.value === currentColor ? '<svg class="check-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>' : ''}
                  </button>
                `).join('')}
              </div>
            </div>
          `).join('')}
          <!-- Custom color picker -->
          <div class="customize-picker-group customize-picker-custom-group">
            <div class="customize-picker-custom-row">
              <div class="customize-color-custom ${currentColor && !isPresetColor(currentColor) ? 'selected' : ''}"
                   style="--swatch-color: ${currentColor && !isPresetColor(currentColor) ? currentColor : '#808080'}">
                <input type="color" class="customize-color-input" value="${currentColor || '#808080'}" title="${t('customize.chooseColor')}">
                <svg class="plus-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                ${currentColor && !isPresetColor(currentColor) ? '<svg class="check-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>' : ''}
              </div>
              <span class="customize-picker-custom-label">${t('customize.custom')}</span>
            </div>
          </div>
        </div>

        <!-- Icons panel -->
        <div class="customize-picker-panel" data-panel="icons">
          <div class="customize-picker-icon-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
            </svg>
            <input type="text" placeholder="${t('customize.searchIcon')}" class="customize-icon-search-input">
          </div>

          <div class="customize-picker-icon-categories">
            <!-- Default/Reset option -->
            <div class="customize-picker-icon-category">
              <button class="customize-icon-btn reset-icon ${!currentIcon ? 'selected' : ''}" data-icon="" title="${t('customize.default')}">
                <span class="customize-icon-emoji">${itemType === 'folder' ? '📁' : '📄'}</span>
                ${!currentIcon ? '<span class="check-badge">✓</span>' : ''}
              </button>
            </div>

            ${Object.entries(ICON_LIBRARY).map(([key, category]) => `
              <div class="customize-picker-icon-category" data-category="${key}">
                <div class="customize-picker-icon-category-label">${t(category.labelKey)}</div>
                <div class="customize-picker-icon-grid">
                  ${category.icons.map(icon => `
                    <button class="customize-icon-btn ${icon.value === currentIcon ? 'selected' : ''}"
                            data-icon="${icon.value}"
                            title="${t(icon.nameKey)}">
                      <span class="customize-icon-emoji">${icon.value}</span>
                      ${icon.value === currentIcon ? '<span class="check-badge">✓</span>' : ''}
                    </button>
                  `).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Position the picker relative to a target element
 */
function positionPicker(picker, targetRect) {
  const pickerRect = picker.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const padding = 12;

  // Try to position to the right of the target
  let left = targetRect.right + padding;
  let top = targetRect.top;

  // If it would overflow right, position to the left
  if (left + pickerRect.width > viewportWidth - padding) {
    left = targetRect.left - pickerRect.width - padding;
  }

  // If it would overflow left, center it
  if (left < padding) {
    left = Math.max(padding, (viewportWidth - pickerRect.width) / 2);
  }

  // If it would overflow bottom, adjust top
  if (top + pickerRect.height > viewportHeight - padding) {
    top = Math.max(padding, viewportHeight - pickerRect.height - padding);
  }

  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;
}

/**
 * Show the customize picker
 * @param {HTMLElement} target - Element to position relative to
 * @param {string} itemType - 'folder' or 'project'
 * @param {string} itemId - Item ID
 * @param {Object} item - Item data
 * @param {Object} callbacks - { onColorChange, onIconChange, onClose }
 */
function show(target, itemType, itemId, item, callbacks) {
  // Close existing picker
  hide();

  // Store original values for preview restoration
  previewState = {
    originalColor: item?.color || null,
    originalIcon: item?.icon || null
  };

  // Create backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'customize-picker-backdrop';
  document.body.appendChild(backdrop);

  // Create picker container
  const container = document.createElement('div');
  container.className = 'customize-picker-container';
  container.innerHTML = createPickerHtml(itemType, item);
  document.body.appendChild(container);

  const picker = container.querySelector('.customize-picker');
  activePicker = { container, backdrop, itemId, itemType, callbacks };

  // Position picker
  const targetRect = target.getBoundingClientRect();
  requestAnimationFrame(() => {
    positionPicker(container, targetRect);
    container.classList.add('visible');
  });

  // Setup event handlers
  setupEventHandlers(picker, itemType, itemId, item, callbacks);

  // Close on backdrop click
  backdrop.onclick = () => hide();

  // Close on Escape
  const escHandler = (e) => {
    if (e.key === 'Escape') hide();
  };
  document.addEventListener('keydown', escHandler);
  activePicker.escHandler = escHandler;
}

/**
 * Setup all event handlers for the picker
 */
function setupEventHandlers(picker, itemType, itemId, item, callbacks) {
  // Tab switching
  picker.querySelectorAll('.customize-picker-tab').forEach(tab => {
    tab.onclick = () => {
      picker.querySelectorAll('.customize-picker-tab').forEach(t => t.classList.remove('active'));
      picker.querySelectorAll('.customize-picker-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      picker.querySelector(`[data-panel="${tab.dataset.tab}"]`).classList.add('active');
    };
  });

  // Close button
  picker.querySelector('.customize-picker-close').onclick = () => hide();

  // Color selection
  picker.querySelectorAll('.customize-color-btn').forEach(btn => {
    btn.onclick = () => {
      const color = btn.dataset.color || null;

      // Update UI - clear all selections including custom
      picker.querySelectorAll('.customize-color-btn').forEach(b => {
        b.classList.remove('selected');
        b.innerHTML = '';
      });
      const customColorEl = picker.querySelector('.customize-color-custom');
      if (customColorEl) {
        customColorEl.classList.remove('selected');
        const checkIcon = customColorEl.querySelector('.check-icon');
        if (checkIcon) checkIcon.remove();
      }

      btn.classList.add('selected');
      btn.innerHTML = '<svg class="check-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

      // Update preview
      const preview = picker.querySelector('.customize-picker-preview');
      preview.style.setProperty('--preview-color', color || 'var(--text-primary)');

      // Callback
      if (callbacks.onColorChange) {
        callbacks.onColorChange(itemId, color);
      }
    };
  });

  // Custom color picker
  const customColorInput = picker.querySelector('.customize-color-input');
  const customColorEl = picker.querySelector('.customize-color-custom');
  if (customColorInput && customColorEl) {
    customColorInput.oninput = (e) => {
      const color = e.target.value;

      // Update UI - clear preset selections
      picker.querySelectorAll('.customize-color-btn').forEach(b => {
        b.classList.remove('selected');
        b.innerHTML = '';
      });

      // Update custom swatch
      customColorEl.style.setProperty('--swatch-color', color);
      customColorEl.classList.add('selected');
      if (!customColorEl.querySelector('.check-icon')) {
        customColorEl.insertAdjacentHTML('beforeend', '<svg class="check-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>');
      }

      // Update preview
      const preview = picker.querySelector('.customize-picker-preview');
      preview.style.setProperty('--preview-color', color);

      // Callback
      if (callbacks.onColorChange) {
        callbacks.onColorChange(itemId, color);
      }
    };

    customColorEl.onclick = (e) => {
      if (e.target === customColorInput) return;
      customColorInput.click();
    };
  }

  // Icon selection
  picker.querySelectorAll('.customize-icon-btn').forEach(btn => {
    btn.onclick = () => {
      const icon = btn.dataset.icon || null;

      // Update UI
      picker.querySelectorAll('.customize-icon-btn').forEach(b => {
        b.classList.remove('selected');
        const badge = b.querySelector('.check-badge');
        if (badge) badge.remove();
      });
      btn.classList.add('selected');
      if (!btn.querySelector('.check-badge')) {
        btn.insertAdjacentHTML('beforeend', '<span class="check-badge">✓</span>');
      }

      // Update preview
      const previewIcon = picker.querySelector('.customize-picker-preview-icon');
      previewIcon.textContent = icon || (itemType === 'folder' ? '📁' : '📄');

      // Callback
      if (callbacks.onIconChange) {
        callbacks.onIconChange(itemId, icon);
      }
    };
  });

  // Icon search
  const searchInput = picker.querySelector('.customize-icon-search-input');
  if (searchInput) {
    searchInput.oninput = (e) => {
      const query = e.target.value.toLowerCase().trim();
      picker.querySelectorAll('.customize-picker-icon-category[data-category]').forEach(cat => {
        const buttons = cat.querySelectorAll('.customize-icon-btn');
        let hasVisible = false;

        buttons.forEach(btn => {
          const name = btn.title.toLowerCase();
          const matches = !query || name.includes(query);
          btn.style.display = matches ? '' : 'none';
          if (matches) hasVisible = true;
        });

        cat.style.display = hasVisible ? '' : 'none';
      });
    };
  }
}

/**
 * Hide the picker
 */
function hide() {
  if (!activePicker) return;

  const { container, backdrop, escHandler, callbacks } = activePicker;

  container.classList.remove('visible');
  backdrop.classList.add('hiding');

  setTimeout(() => {
    container.remove();
    backdrop.remove();
  }, 200);

  if (escHandler) {
    document.removeEventListener('keydown', escHandler);
  }

  if (callbacks?.onClose) {
    callbacks.onClose();
  }

  activePicker = null;
}

/**
 * Check if picker is currently visible
 */
function isVisible() {
  return activePicker !== null;
}

module.exports = {
  show,
  hide,
  isVisible,
  COLOR_PALETTE,
  ICON_LIBRARY
};
