/**
 * Tab Component
 * Reusable tab navigation component
 */

const { escapeHtml } = require('../../utils/dom');
const { t } = require('../../i18n');

/**
 * Create a tab container
 * @param {Object} options
 * @param {string} options.id - Container ID
 * @param {Array} options.tabs - Tab configurations
 * @param {string} options.activeTab - Initially active tab ID
 * @param {Function} options.onTabChange - Tab change callback
 * @returns {HTMLElement}
 */
function createTabs({ id, tabs, activeTab, onTabChange }) {
  const container = document.createElement('div');
  container.className = 'tabs-container';
  container.id = id;

  // Tab headers
  const tabsHtml = tabs.map(tab => `
    <button class="tab ${tab.id === activeTab ? 'active' : ''}" data-tab="${tab.id}">
      ${tab.icon ? `<span class="tab-icon">${tab.icon}</span>` : ''}
      <span class="tab-label">${escapeHtml(tab.label)}</span>
      ${tab.badge !== undefined ? `<span class="tab-badge">${tab.badge}</span>` : ''}
      ${tab.closable ? `
        <button class="tab-close" data-tab="${tab.id}" aria-label="${t('common.close')}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      ` : ''}
    </button>
  `).join('');

  container.innerHTML = `
    <div class="tabs-header">
      ${tabsHtml}
    </div>
    <div class="tabs-content">
      ${tabs.map(tab => `
        <div class="tab-panel ${tab.id === activeTab ? 'active' : ''}" data-panel="${tab.id}">
          ${tab.content || ''}
        </div>
      `).join('')}
    </div>
  `;

  // Tab click handlers
  container.querySelectorAll('.tab').forEach(tabEl => {
    tabEl.onclick = (e) => {
      if (e.target.closest('.tab-close')) return;

      const tabId = tabEl.dataset.tab;
      activateTab(container, tabId);
      if (onTabChange) {
        onTabChange(tabId);
      }
    };
  });

  // Close button handlers
  container.querySelectorAll('.tab-close').forEach(closeBtn => {
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      const tabId = closeBtn.dataset.tab;
      if (onTabChange) {
        onTabChange(tabId, 'close');
      }
    };
  });

  return container;
}

/**
 * Activate a tab
 * @param {HTMLElement} container
 * @param {string} tabId
 */
function activateTab(container, tabId) {
  // Update tab headers
  container.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabId);
  });

  // Update tab panels
  container.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.panel === tabId);
  });
}

/**
 * Add a tab dynamically
 * @param {HTMLElement} container
 * @param {Object} tab - Tab configuration
 */
function addTab(container, tab) {
  const header = container.querySelector('.tabs-header');
  const content = container.querySelector('.tabs-content');

  // Create tab button
  const tabBtn = document.createElement('button');
  tabBtn.className = 'tab';
  tabBtn.dataset.tab = tab.id;
  tabBtn.innerHTML = `
    ${tab.icon ? `<span class="tab-icon">${tab.icon}</span>` : ''}
    <span class="tab-label">${escapeHtml(tab.label)}</span>
    ${tab.badge !== undefined ? `<span class="tab-badge">${tab.badge}</span>` : ''}
    ${tab.closable ? `
      <button class="tab-close" data-tab="${tab.id}" aria-label="${t('common.close')}">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    ` : ''}
  `;
  header.appendChild(tabBtn);

  // Create tab panel
  const panel = document.createElement('div');
  panel.className = 'tab-panel';
  panel.dataset.panel = tab.id;
  panel.innerHTML = tab.content || '';
  content.appendChild(panel);

  return { tabBtn, panel };
}

/**
 * Remove a tab
 * @param {HTMLElement} container
 * @param {string} tabId
 */
function removeTab(container, tabId) {
  const tab = container.querySelector(`.tab[data-tab="${tabId}"]`);
  const panel = container.querySelector(`.tab-panel[data-panel="${tabId}"]`);

  if (tab) tab.remove();
  if (panel) panel.remove();
}

/**
 * Update tab badge
 * @param {HTMLElement} container
 * @param {string} tabId
 * @param {string|number} badge
 */
function updateTabBadge(container, tabId, badge) {
  const tab = container.querySelector(`.tab[data-tab="${tabId}"]`);
  if (!tab) return;

  let badgeEl = tab.querySelector('.tab-badge');
  if (badge !== undefined && badge !== null) {
    if (!badgeEl) {
      badgeEl = document.createElement('span');
      badgeEl.className = 'tab-badge';
      tab.querySelector('.tab-label').after(badgeEl);
    }
    badgeEl.textContent = badge;
  } else if (badgeEl) {
    badgeEl.remove();
  }
}

/**
 * Update tab label
 * @param {HTMLElement} container
 * @param {string} tabId
 * @param {string} label
 */
function updateTabLabel(container, tabId, label) {
  const tab = container.querySelector(`.tab[data-tab="${tabId}"]`);
  if (tab) {
    const labelEl = tab.querySelector('.tab-label');
    if (labelEl) {
      labelEl.textContent = label;
    }
  }
}

/**
 * Get active tab ID
 * @param {HTMLElement} container
 * @returns {string|null}
 */
function getActiveTab(container) {
  const activeTab = container.querySelector('.tab.active');
  return activeTab ? activeTab.dataset.tab : null;
}

module.exports = {
  activateTab,
  addTab,
  removeTab,
  updateTabBadge,
  updateTabLabel,
  getActiveTab
};
