/**
 * PluginsPanel
 * Plugin discovery, installation, and management
 */

const { BasePanel } = require('../../core/BasePanel');
const { escapeHtml } = require('../../utils');
const { t } = require('../../i18n');
const { showConfirm } = require('../components/Modal');
const { renderReadmeMarkdown, bindReadmeLinks } = require('../../utils/markdown');

const PLUGIN_CATEGORIES = {
  all: { label: 'All', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z"/></svg>' },
  development: { label: 'Dev', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>' },
  productivity: { label: 'Productivity', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>' },
  testing: { label: 'Testing', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19.8 18.4L14 10.67V6.5l1.35-1.69c.26-.33.03-.81-.39-.81H9.04c-.42 0-.65.48-.39.81L10 6.5v4.17L4.2 18.4c-.49.66-.02 1.6.8 1.6h14c.82 0 1.29-.94.8-1.6z"/></svg>' },
  security: { label: 'Security', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>' },
  design: { label: 'Design', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 22C6.49 22 2 17.51 2 12S6.49 2 12 2s10 4.04 10 9c0 3.31-2.69 6-6 6h-1.77c-.28 0-.5.22-.5.5 0 .12.05.23.13.33.41.47.64 1.06.64 1.67A2.5 2.5 0 0112 22zm0-18c-4.41 0-8 3.59-8 8s3.59 8 8 8c.28 0 .5-.22.5-.5a.54.54 0 00-.14-.35c-.41-.46-.63-1.05-.63-1.65a2.5 2.5 0 012.5-2.5H16c2.21 0 4-1.79 4-4 0-3.86-3.59-7-8-7z"/><circle cx="6.5" cy="11.5" r="1.5"/><circle cx="9.5" cy="7.5" r="1.5"/><circle cx="14.5" cy="7.5" r="1.5"/><circle cx="17.5" cy="11.5" r="1.5"/></svg>' },
  database: { label: 'Database', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 3C7.58 3 4 4.79 4 7v10c0 2.21 3.58 4 8 4s8-1.79 8-4V7c0-2.21-3.58-4-8-4zm6 14c0 .5-2.13 2-6 2s-6-1.5-6-2v-2.23c1.61.78 3.72 1.23 6 1.23s4.39-.45 6-1.23V17zm0-5c0 .5-2.13 2-6 2s-6-1.5-6-2V9.77C7.61 10.55 9.72 11 12 11s4.39-.45 6-1.23V12zm-6-3c-3.87 0-6-1.5-6-2s2.13-2 6-2 6 1.5 6 2-2.13 2-6 2z"/></svg>' },
  deployment: { label: 'Deploy', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>' },
  monitoring: { label: 'Monitor', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/></svg>' },
  learning: { label: 'Learning', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82zM12 3L1 9l11 6 9-4.91V17h2V9L12 3z"/></svg>' },
  other: { label: 'Other', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>' }
};

class PluginsPanel extends BasePanel {
  constructor(el, options = {}) {
    super(el, options);
    this._state = {
      activeSubTab: 'discover',
      initialized: false,
      data: {
        catalog: [],
        installed: [],
        marketplaces: [],
        searchQuery: '',
        activeCategory: 'all'
      },
      updateStatuses: {}
    };
    this._showToast = options.showToast;
    this._showModal = options.showModal;
    this._closeModal = options.closeModal;
  }

  async loadPlugins() {
    if (!this._state.initialized) {
      this._state.initialized = true;
      this._setupSubTabs();
      this._setupSearch();
      this._renderCategoryFilter();
    }

    const content = document.getElementById('plugins-content');
    content.innerHTML = `<div class="plugins-loading"><div class="spinner"></div>${t('common.loading')}</div>`;

    try {
      const [catalogRes, installedRes, mpRes] = await Promise.all([
        this.api.plugins.catalog(),
        this.api.plugins.installed(),
        this.api.plugins.marketplaces()
      ]);

      if (catalogRes.success) this._state.data.catalog = catalogRes.catalog;
      if (installedRes.success) this._state.data.installed = installedRes.installed;
      if (mpRes.success) this._state.data.marketplaces = mpRes.marketplaces;

      this._renderContent();
      this._checkUpdates();
    } catch (e) {
      content.innerHTML = `<div class="plugins-empty-state"><h3>${t('common.error')}</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
  }

  async _checkUpdates() {
    try {
      const result = await this.api.plugins.checkUpdates();
      if (result.success && result.updates) {
        this._state.updateStatuses = {};
        for (const u of result.updates) {
          this._state.updateStatuses[u.pluginKey || u.name] = u;
        }
        this._applyUpdateBadges();
      }
    } catch { /* silent */ }
  }

  _applyUpdateBadges() {
    document.querySelectorAll('.plugin-installed-item').forEach(item => {
      const pluginName = item.dataset.pluginName;
      const marketplace = item.dataset.marketplace;
      const key = `${pluginName}@${marketplace}`;
      const update = this._state.updateStatuses[key] || this._state.updateStatuses[pluginName];
      if (update) {
        const nameRow = item.querySelector('.plugin-installed-name-row');
        if (nameRow && !nameRow.querySelector('.update-badge')) {
          const badge = document.createElement('span');
          badge.className = 'update-badge';
          badge.textContent = t('plugins.updateAvailable');
          nameRow.appendChild(badge);
        }
        const actions = item.querySelector('.plugin-installed-actions');
        if (actions && !actions.querySelector('.btn-update')) {
          const btn = document.createElement('button');
          btn.className = 'btn-sm btn-update';
          btn.title = t('plugins.update');
          btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
          btn.onclick = async (e) => {
            e.stopPropagation();
            btn.disabled = true;
            try {
              const result = await this.api.plugins.install(marketplace, pluginName);
              if (result.success) {
                delete this._state.updateStatuses[key];
                delete this._state.updateStatuses[pluginName];
                this._showToast({ type: 'success', title: t('plugins.updateSuccess', { name: pluginName }) });
                await this.loadPlugins();
              } else {
                throw new Error(result.error);
              }
            } catch (err) {
              btn.disabled = false;
              this._showToast({ type: 'error', title: t('plugins.updateError'), message: err.message });
            }
          };
          actions.insertBefore(btn, actions.firstChild);
        }
      }
    });

    document.querySelectorAll('.plugin-card.is-installed').forEach(card => {
      const pluginName = card.dataset.pluginName;
      const marketplace = card.dataset.marketplace;
      const key = `${pluginName}@${marketplace}`;
      const update = this._state.updateStatuses[key] || this._state.updateStatuses[pluginName];
      if (update && !card.querySelector('.update-badge')) {
        const badge = document.createElement('span');
        badge.className = 'update-badge';
        badge.textContent = t('plugins.updateAvailable');
        const top = card.querySelector('.plugin-card-top');
        if (top) top.appendChild(badge);
      }
    });
  }

  // ── Private ──

  _setupSubTabs() {
    document.querySelectorAll('.plugins-sub-tab').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.plugins-sub-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._state.activeSubTab = btn.dataset.subtab;

        const searchContainer = document.getElementById('plugins-search-container');
        const catFilter = document.getElementById('plugins-category-filter');
        if (btn.dataset.subtab === 'discover') {
          searchContainer.style.display = 'flex';
          catFilter.style.display = 'flex';
        } else {
          searchContainer.style.display = btn.dataset.subtab === 'installed' ? 'flex' : 'none';
          catFilter.style.display = 'none';
        }

        this._renderContent();
      };
    });
  }

  _setupSearch() {
    let timeout;
    const input = document.getElementById('plugins-search-input');
    if (input) {
      input.addEventListener('input', () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          this._state.data.searchQuery = input.value.trim().toLowerCase();
          this._renderContent();
        }, 200);
      });
    }
  }

  _renderCategoryFilter() {
    const container = document.getElementById('plugins-category-filter');
    if (!container) return;

    let html = '';
    for (const [key, cat] of Object.entries(PLUGIN_CATEGORIES)) {
      const active = key === this._state.data.activeCategory ? 'active' : '';
      html += `<button class="plugin-cat-pill ${active}" data-category="${key}">${cat.label}</button>`;
    }
    container.innerHTML = html;

    container.querySelectorAll('.plugin-cat-pill').forEach(btn => {
      btn.onclick = () => {
        container.querySelectorAll('.plugin-cat-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._state.data.activeCategory = btn.dataset.category;
        this._renderContent();
      };
    });
  }

  _renderContent() {
    const tab = this._state.activeSubTab;
    if (tab === 'discover') this._renderDiscover();
    else if (tab === 'installed') this._renderInstalled();
    else if (tab === 'marketplaces') this._renderMarketplaces();
  }

  _formatInstalls(n) {
    if (!n || n === 0) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return n.toString();
  }

  _renderDiscover() {
    const content = document.getElementById('plugins-content');
    let plugins = [...this._state.data.catalog];

    const query = this._state.data.searchQuery;
    if (query) {
      plugins = plugins.filter(p =>
        p.name.toLowerCase().includes(query) ||
        p.description.toLowerCase().includes(query) ||
        (p.category || '').toLowerCase().includes(query)
      );
    }

    const cat = this._state.data.activeCategory;
    if (cat !== 'all') {
      plugins = plugins.filter(p => (p.category || 'other') === cat);
    }

    if (plugins.length === 0) {
      content.innerHTML = `<div class="plugins-empty-state">
        <svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48" opacity="0.3"><path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/></svg>
        <h3>${t('plugins.noResults')}</h3>
        <p>${t('plugins.trySearch')}</p>
      </div>`;
      return;
    }

    let html = `<div class="plugins-grid">`;
    html += plugins.map((plugin, i) => {
      const catInfo = PLUGIN_CATEGORIES[plugin.category] || PLUGIN_CATEGORIES.other;
      const isInstalled = plugin.installed;
      const tags = (plugin.tags || []).map(tg => `<span class="plugin-tag">${escapeHtml(tg)}</span>`).join('');
      const lspBadge = plugin.hasLsp ? '<span class="plugin-tag lsp">LSP</span>' : '';
      const initial = escapeHtml(plugin.name.charAt(0).toUpperCase());

      return `<div class="plugin-card ${isInstalled ? 'is-installed' : ''}" data-plugin-name="${escapeHtml(plugin.name)}" data-marketplace="${escapeHtml(plugin.marketplace)}" data-category="${plugin.category}" style="animation-delay: ${Math.min(i * 25, 500)}ms">
        <div class="plugin-card-top">
          <div class="plugin-card-icon" data-category="${plugin.category}"><span class="plugin-card-initial">${initial}</span></div>
          <div class="plugin-card-meta">
            <div class="plugin-card-name">${escapeHtml(plugin.name)}</div>
            <div class="plugin-card-author">${plugin.author ? escapeHtml(plugin.author.name || '') : escapeHtml(plugin.marketplace)}</div>
          </div>
          ${isInstalled ? `<span class="plugin-installed-badge">${t('plugins.installedBadge')}</span>` : ''}
        </div>
        <div class="plugin-card-desc">${escapeHtml(plugin.description)}</div>
        <div class="plugin-card-footer">
          <div class="plugin-card-tags">${lspBadge}${tags}<span class="plugin-cat-badge" data-category="${plugin.category}">${escapeHtml(catInfo.label)}</span></div>
          <div class="plugin-card-right">
            <div class="plugin-card-installs">
              <svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11" opacity="0.5"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              <span class="plugin-installs-count">${this._formatInstalls(plugin.installs)}</span>
            </div>
            ${!isInstalled ? `<button class="btn-plugin-install" data-name="${escapeHtml(plugin.name)}" data-marketplace="${escapeHtml(plugin.marketplace)}">${t('plugins.install')}</button>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');
    html += `</div>`;

    content.innerHTML = html;
    this._bindCardHandlers();
  }

  _renderInstalled() {
    const content = document.getElementById('plugins-content');
    let plugins = [...this._state.data.installed];

    const query = this._state.data.searchQuery;
    if (query) {
      plugins = plugins.filter(p =>
        p.name.toLowerCase().includes(query) ||
        p.description.toLowerCase().includes(query)
      );
    }

    if (plugins.length === 0) {
      content.innerHTML = `<div class="plugins-empty-state">
        <svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48" opacity="0.3"><path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/></svg>
        <h3>${t('plugins.noInstalled')}</h3>
        <p>${t('plugins.installHint')}</p>
      </div>`;
      return;
    }

    let html = `<div class="plugins-installed-list">`;
    html += plugins.map((plugin, i) => {
      const installDate = plugin.installedAt ? new Date(plugin.installedAt).toLocaleDateString() : '';
      const updateDate = plugin.lastUpdated ? new Date(plugin.lastUpdated).toLocaleDateString() : '';
      const { skills, agents, commands, hooks } = plugin.contents || {};

      const contentBadges = [];
      if (skills) contentBadges.push(`<span class="plugin-content-badge skills">${skills} skill${skills > 1 ? 's' : ''}</span>`);
      if (agents) contentBadges.push(`<span class="plugin-content-badge agents">${agents} agent${agents > 1 ? 's' : ''}</span>`);
      if (commands) contentBadges.push(`<span class="plugin-content-badge commands">${commands} cmd</span>`);
      if (hooks) contentBadges.push(`<span class="plugin-content-badge hooks">hooks</span>`);

      return `<div class="plugin-installed-item" data-plugin-name="${escapeHtml(plugin.pluginName)}" data-marketplace="${escapeHtml(plugin.marketplace)}" data-path="${escapeHtml(plugin.installPath)}" style="animation-delay: ${i * 50}ms">
        <div class="plugin-installed-main">
          <div class="plugin-installed-icon">${escapeHtml(plugin.name.charAt(0).toUpperCase())}</div>
          <div class="plugin-installed-info">
            <div class="plugin-installed-name-row">
              <span class="plugin-installed-name">${escapeHtml(plugin.name)}</span>
              <span class="plugin-installed-version">v${escapeHtml(plugin.version)}</span>
              <span class="plugin-installed-marketplace">${escapeHtml(plugin.marketplace)}</span>
            </div>
            <div class="plugin-installed-desc">${escapeHtml(plugin.description)}</div>
            <div class="plugin-installed-meta">
              <div class="plugin-installed-contents">${contentBadges.join('')}</div>
              <span class="plugin-installed-date" title="${t('plugins.installedOn')}: ${installDate}${updateDate ? ' | ' + t('plugins.updatedOn') + ': ' + updateDate : ''}">
                <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
                ${installDate}
              </span>
              ${plugin.installs ? `<span class="plugin-installed-downloads">${this._formatInstalls(plugin.installs)} ${t('plugins.installs')}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="plugin-installed-actions">
          <button class="btn-sm btn-secondary btn-plugin-folder" title="${t('plugins.openFolder')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
          </button>
          ${plugin.homepage ? `<button class="btn-sm btn-secondary btn-plugin-homepage" title="Homepage" data-url="${escapeHtml(plugin.homepage)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </button>` : ''}
          <button class="btn-sm btn-danger btn-plugin-uninstall" title="${t('plugins.uninstall')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');
    html += `</div>`;

    content.innerHTML = html;
    this._bindInstalledHandlers();
  }

  _renderMarketplaces() {
    const content = document.getElementById('plugins-content');
    const mps = this._state.data.marketplaces;

    let html = `<div class="plugin-add-marketplace-bar">
      <div class="plugin-add-mp-input-group">
        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" opacity="0.4"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
        <input type="text" id="plugin-mp-url-input" placeholder="${t('plugins.addMarketplacePlaceholder')}" spellcheck="false">
      </div>
      <button class="btn-plugin-add-mp" id="btn-add-marketplace">${t('plugins.addMarketplace')}</button>
    </div>`;

    if (mps.length === 0) {
      html += `<div class="plugins-empty-state">
        <h3>${t('plugins.noMarketplaces')}</h3>
        <p>${t('plugins.addMarketplaceHint')}</p>
      </div>`;
    } else {
      html += `<div class="plugins-marketplaces-grid">`;
      html += mps.map((mp, i) => {
        const isOfficial = mp.name === 'claude-plugins-official';
        return `<div class="plugin-marketplace-card ${isOfficial ? 'official' : ''}" style="animation-delay: ${i * 80}ms">
          <div class="plugin-mp-header">
            <div class="plugin-mp-icon">${isOfficial ? '<svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28"><path d="M12 2L3 7v10l9 5 9-5V7l-9-5zm0 2.18l6 3.33v6.98l-6 3.33-6-3.33V7.51l6-3.33z"/></svg>' : '<svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>'}</div>
            <div class="plugin-mp-info">
              <div class="plugin-mp-name">${escapeHtml(mp.name)}</div>
              <div class="plugin-mp-stats">${mp.pluginCount} ${t('plugins.plugins')}</div>
            </div>
            ${isOfficial ? `<span class="plugin-mp-official-badge">${t('plugins.official')}</span>` : ''}
          </div>
          <div class="plugin-mp-details">
            ${mp.repoUrl ? `<div class="plugin-mp-repo">
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
              <span>${escapeHtml(mp.repoUrl)}</span>
            </div>` : ''}
            <div class="plugin-mp-updated">
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
              ${t('plugins.lastSynced')}: ${mp.lastUpdated ? new Date(mp.lastUpdated).toLocaleDateString() : t('plugins.never')}
            </div>
          </div>
        </div>`;
      }).join('');
      html += `</div>`;
    }

    content.innerHTML = html;
    this._bindAddMarketplaceHandler();
  }

  _bindAddMarketplaceHandler() {
    const btn = document.getElementById('btn-add-marketplace');
    const input = document.getElementById('plugin-mp-url-input');
    if (!btn || !input) return;

    const doAdd = async () => {
      const url = input.value.trim();
      if (!url) return;

      btn.disabled = true;
      btn.textContent = t('plugins.adding');
      input.disabled = true;

      try {
        const result = await this.api.plugins.addMarketplace(url);
        if (result.success) {
          this._showToast({ type: 'success', title: t('plugins.addMarketplaceSuccess') });
          input.value = '';
          await this.loadPlugins();
        } else {
          this._showToast({ type: 'error', title: t('plugins.addMarketplaceError'), message: result.error || '' });
          btn.disabled = false;
          btn.textContent = t('plugins.addMarketplace');
          input.disabled = false;
        }
      } catch (e) {
        this._showToast({ type: 'error', title: t('plugins.addMarketplaceError'), message: e.message });
        btn.disabled = false;
        btn.textContent = t('plugins.addMarketplace');
        input.disabled = false;
      }
    };

    btn.onclick = doAdd;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doAdd();
    });
  }

  _bindCardHandlers() {
    document.querySelectorAll('.plugin-card').forEach(card => {
      card.onclick = async () => {
        const pluginName = card.dataset.pluginName;
        const marketplace = card.dataset.marketplace;
        const plugin = this._state.data.catalog.find(p => p.name === pluginName && p.marketplace === marketplace);
        if (plugin) this._showPluginDetail(plugin);
      };
    });

    document.querySelectorAll('.btn-plugin-install').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        this._handleInstall(btn.dataset.name, btn.dataset.marketplace, btn);
      };
    });
  }

  _bindInstalledHandlers() {
    document.querySelectorAll('.plugin-installed-item').forEach(item => {
      const folderBtn = item.querySelector('.btn-plugin-folder');
      if (folderBtn) {
        folderBtn.onclick = (e) => {
          e.stopPropagation();
          this.api.dialog.openInExplorer(item.dataset.path);
        };
      }
      const homepageBtn = item.querySelector('.btn-plugin-homepage');
      if (homepageBtn) {
        homepageBtn.onclick = (e) => {
          e.stopPropagation();
          require('electron').shell.openExternal(homepageBtn.dataset.url);
        };
      }
      const uninstallBtn = item.querySelector('.btn-plugin-uninstall');
      if (uninstallBtn) {
        uninstallBtn.onclick = async (e) => {
          e.stopPropagation();
          const pluginName = item.dataset.pluginName;
          const marketplace = item.dataset.marketplace;
          const pluginKey = `${pluginName}@${marketplace}`;

          const confirmed = await showConfirm({
            title: t('plugins.uninstall'),
            message: t('plugins.confirmUninstall', { name: pluginName }),
            confirmLabel: t('plugins.uninstall'),
            danger: true
          });
          if (!confirmed) return;

          uninstallBtn.disabled = true;
          try {
            const result = await this.api.plugins.uninstall(pluginKey);
            if (result.success) {
              this._showToast({ type: 'success', title: t('plugins.uninstallSuccess', { name: pluginKey }) });
              await this.loadPlugins();
            } else {
              this._showToast({ type: 'error', title: t('plugins.uninstallError'), message: result.error || '' });
              uninstallBtn.disabled = false;
            }
          } catch (err) {
            this._showToast({ type: 'error', title: t('plugins.uninstallError'), message: err.message });
            uninstallBtn.disabled = false;
          }
        };
      }
    });
  }

  async _handleInstall(pluginName, marketplace, btn) {
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-install-spinner"></span>${t('plugins.installing')}`;
    btn.classList.add('installing');

    try {
      const result = await this.api.plugins.install(marketplace, pluginName);
      if (result.success) {
        this._showToast({ type: 'success', title: t('plugins.installSuccess', { name: pluginName }) });
        await this.loadPlugins();
      } else {
        this._showToast({ type: 'error', title: t('plugins.installError'), message: result.error || '' });
        btn.disabled = false;
        btn.textContent = originalText;
        btn.classList.remove('installing');
      }
    } catch (e) {
      this._showToast({ type: 'error', title: t('plugins.installError'), message: e.message });
      btn.disabled = false;
      btn.textContent = originalText;
      btn.classList.remove('installing');
    }
  }

  async _showPluginDetail(plugin) {
    const isInstalled = this._state.data.installed.some(p => p.pluginName === plugin.name);
    const installedInfo = this._state.data.installed.find(p => p.pluginName === plugin.name);
    const catInfo = PLUGIN_CATEGORIES[plugin.category] || PLUGIN_CATEGORIES.other;

    const modalContent = `
      <div class="plugin-detail">
        <div class="plugin-detail-header">
          <div class="plugin-detail-icon" data-category="${plugin.category}">${catInfo.icon}</div>
          <div>
            <div class="plugin-detail-name">${escapeHtml(plugin.name)}</div>
            <div class="plugin-detail-author">${plugin.author ? escapeHtml(plugin.author.name || '') : ''} &middot; ${escapeHtml(plugin.marketplace)}</div>
            <div class="plugin-detail-stats">
              <span>${this._formatInstalls(plugin.installs)} ${t('plugins.installs')}</span>
              ${plugin.version ? `<span>v${escapeHtml(plugin.version)}</span>` : ''}
              <span class="plugin-cat-badge" data-category="${plugin.category}">${escapeHtml(catInfo.label)}</span>
              ${plugin.hasLsp ? '<span class="plugin-tag lsp">LSP</span>' : ''}
              ${(plugin.tags || []).map(tg => `<span class="plugin-tag">${escapeHtml(tg)}</span>`).join('')}
            </div>
          </div>
        </div>
        <div class="plugin-detail-desc">${escapeHtml(plugin.description)}</div>
        ${isInstalled && installedInfo ? `
          <div class="plugin-detail-installed-info">
            <div class="plugin-detail-installed-badge">${t('plugins.installedBadge')}</div>
            <span>v${escapeHtml(installedInfo.version)} &middot; ${new Date(installedInfo.installedAt).toLocaleDateString()}</span>
            ${installedInfo.contents ? `<div class="plugin-installed-contents-detail">
              ${installedInfo.contents.skills ? `<span>${installedInfo.contents.skills} skills</span>` : ''}
              ${installedInfo.contents.agents ? `<span>${installedInfo.contents.agents} agents</span>` : ''}
              ${installedInfo.contents.commands ? `<span>${installedInfo.contents.commands} commands</span>` : ''}
              ${installedInfo.contents.hooks ? `<span>hooks</span>` : ''}
            </div>` : ''}
          </div>
        ` : ''}
        <div class="plugin-detail-readme" id="plugin-detail-readme">
          <div class="plugins-loading"><div class="spinner"></div>${t('plugins.loadingReadme')}</div>
        </div>
        <div class="plugin-detail-actions">
          ${isInstalled
            ? `<button class="btn-secondary btn-plugin-open-folder-detail">${t('plugins.openFolder')}</button>
               <button class="btn-danger btn-plugin-uninstall-detail">${t('plugins.uninstall')}</button>`
            : `<button class="btn-primary btn-plugin-install-detail" data-name="${escapeHtml(plugin.name)}" data-marketplace="${escapeHtml(plugin.marketplace)}">${t('plugins.install')}</button>`
          }
          ${plugin.homepage ? `<button class="btn-secondary btn-plugin-homepage-detail" data-url="${escapeHtml(plugin.homepage)}">${t('plugins.viewOnGithub')}</button>` : ''}
        </div>
      </div>
    `;

    this._showModal(plugin.name, modalContent);

    try {
      const result = await this.api.plugins.readme(plugin.marketplace, plugin.name);
      const readmeEl = document.getElementById('plugin-detail-readme');
      if (readmeEl) {
        if (result.success && result.readme) {
          readmeEl.innerHTML = renderReadmeMarkdown(result.readme);
          readmeEl.classList.add('readme-markdown');
          bindReadmeLinks(readmeEl, (url) => require('electron').shell.openExternal(url));
        } else {
          readmeEl.innerHTML = `<em>${t('plugins.noReadme')}</em>`;
        }
      }
    } catch {
      const readmeEl = document.getElementById('plugin-detail-readme');
      if (readmeEl) readmeEl.innerHTML = `<em>${t('plugins.readmeError')}</em>`;
    }

    const folderBtn = document.querySelector('.btn-plugin-open-folder-detail');
    if (folderBtn && installedInfo) {
      folderBtn.onclick = () => this.api.dialog.openInExplorer(installedInfo.installPath);
    }
    const homepageBtn = document.querySelector('.btn-plugin-homepage-detail');
    if (homepageBtn) {
      homepageBtn.onclick = () => require('electron').shell.openExternal(homepageBtn.dataset.url);
    }
    const installDetailBtn = document.querySelector('.btn-plugin-install-detail');
    if (installDetailBtn) {
      installDetailBtn.onclick = () => this._handleInstall(installDetailBtn.dataset.name, installDetailBtn.dataset.marketplace, installDetailBtn);
    }
    const uninstallDetailBtn = document.querySelector('.btn-plugin-uninstall-detail');
    if (uninstallDetailBtn && installedInfo) {
      uninstallDetailBtn.onclick = async () => {
        const pluginKey = `${plugin.name}@${installedInfo.marketplace}`;
        const confirmed = await showConfirm({
          title: t('plugins.uninstall'),
          message: t('plugins.confirmUninstall', { name: plugin.name }),
          confirmLabel: t('plugins.uninstall'),
          danger: true
        });
        if (!confirmed) return;

        uninstallDetailBtn.disabled = true;
        uninstallDetailBtn.textContent = t('plugins.uninstalling');
        try {
          const result = await this.api.plugins.uninstall(pluginKey);
          if (result.success) {
            this._showToast({ type: 'success', title: t('plugins.uninstallSuccess') });
            this._closeModal();
            await this.loadPlugins();
          } else {
            this._showToast({ type: 'error', title: t('plugins.uninstallError'), message: result.error || '' });
            uninstallDetailBtn.disabled = false;
            uninstallDetailBtn.textContent = t('plugins.uninstall');
          }
        } catch (err) {
          this._showToast({ type: 'error', title: t('plugins.uninstallError'), message: err.message });
          uninstallDetailBtn.disabled = false;
          uninstallDetailBtn.textContent = t('plugins.uninstall');
        }
      };
    }
  }
}

// ── Lazy singleton + legacy exports ──

let _instance = null;

function init(context) {
  const { getApiProvider, getContainer } = require('../../core');
  _instance = new PluginsPanel(null, {
    api: getApiProvider(),
    container: getContainer(),
    showToast: context.showToast,
    showModal: context.showModal,
    closeModal: context.closeModal
  });
}

module.exports = {
  PluginsPanel,
  init,
  loadPlugins: (...a) => _instance.loadPlugins(...a)
};
