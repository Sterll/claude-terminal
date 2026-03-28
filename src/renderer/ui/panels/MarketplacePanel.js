/**
 * MarketplacePanel
 * Skills marketplace browsing, search, install/uninstall
 */

const { BasePanel } = require('../../core/BasePanel');
const { escapeHtml } = require('../../utils');
const { t } = require('../../i18n');
const { showConfirm } = require('../components/Modal');
const { renderReadmeMarkdown, bindReadmeLinks } = require('../../utils/markdown');

class MarketplacePanel extends BasePanel {
  constructor(el, options = {}) {
    super(el, options);
    this._state = {
      searchResults: [],
      featured: [],
      installed: [],
      loading: false,
      searchQuery: '',
      searchCache: new Map(),
      updateStatuses: {}
    };
    this._showToast = options.showToast;
    this._showModal = options.showModal;
    this._closeModal = options.closeModal;
    this._skillsDir = options.skillsDir;
  }

  getSearchQuery() {
    return this._state.searchQuery;
  }

  setSearchQuery(query) {
    this._state.searchQuery = query;
  }

  async loadMarketplaceContent() {
    if (this._state.searchQuery) {
      await this.searchMarketplace(this._state.searchQuery);
    } else {
      await this.loadMarketplaceFeatured();
    }
    this._checkUpdates();
  }

  async _checkUpdates() {
    try {
      const result = await this.api.marketplace.checkUpdates();
      if (result.success && result.updates) {
        this._state.updateStatuses = {};
        for (const u of result.updates) {
          this._state.updateStatuses[u.skillId] = u;
        }
        this._applyUpdateBadges();
      }
    } catch { /* silent */ }
  }

  _applyUpdateBadges() {
    const cards = document.querySelectorAll('.marketplace-card.installed');
    cards.forEach(card => {
      const skillId = card.dataset.skillId;
      if (this._state.updateStatuses[skillId]) {
        const existing = card.querySelector('.update-badge');
        if (!existing) {
          const badge = document.createElement('span');
          badge.className = 'update-badge';
          badge.textContent = t('marketplace.updateAvailable');
          const header = card.querySelector('.list-card-header');
          if (header) header.appendChild(badge);
        }
        const footer = card.querySelector('.list-card-footer');
        if (footer && !footer.querySelector('.btn-update')) {
          const btn = document.createElement('button');
          btn.className = 'btn-sm btn-update';
          btn.textContent = t('marketplace.update');
          btn.onclick = async (e) => {
            e.stopPropagation();
            btn.disabled = true;
            btn.innerHTML = `<span class="btn-install-spinner"></span>${t('marketplace.updating')}`;
            try {
              const source = card.dataset.source;
              const name = card.dataset.name;
              const installs = parseInt(card.dataset.installs) || 0;
              const result = await this.api.marketplace.install({ source, skillId, name, installs });
              if (!result.success) throw new Error(result.error);
              delete this._state.updateStatuses[skillId];
              await this.loadMarketplaceContent();
            } catch (err) {
              btn.disabled = false;
              btn.textContent = t('marketplace.update');
              this._showToast({ type: 'error', title: t('marketplace.updateError'), message: err.message });
            }
          };
          footer.appendChild(btn);
        }
      }
    });
  }

  async searchMarketplace(query) {
    const list = document.getElementById('skills-list');

    const cachedResults = this._state.searchCache.get(query);
    if (cachedResults) {
      this._state.searchResults = cachedResults;
      await this._renderCards(cachedResults, t('marketplace.searchResults'));
    } else {
      list.innerHTML = `<div class="marketplace-loading"><div class="spinner"></div>${t('common.loading')}</div>`;
    }

    try {
      const [result, installedResult] = await Promise.all([
        this.api.marketplace.search(query, 30),
        this.api.marketplace.installed()
      ]);
      if (!result.success) throw new Error(result.error);

      const newSkills = result.skills || [];
      if (installedResult.success) {
        this._state.installed = installedResult.installed || [];
      }

      this._state.searchCache.set(query, newSkills);

      if (JSON.stringify(newSkills) !== JSON.stringify(this._state.searchResults)) {
        this._state.searchResults = newSkills;
        await this._renderCards(newSkills, t('marketplace.searchResults'));
      }
    } catch (e) {
      if (!cachedResults) {
        list.innerHTML = `<div class="marketplace-empty"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg><h3>${t('common.error')}</h3><p>${escapeHtml(e.message)}</p></div>`;
      }
    }
  }

  async loadMarketplaceFeatured() {
    const list = document.getElementById('skills-list');

    if (this._state.featured.length > 0) {
      await this._renderCards(this._state.featured, t('marketplace.featured'));
    } else {
      list.innerHTML = `<div class="marketplace-loading"><div class="spinner"></div>${t('common.loading')}</div>`;
    }

    try {
      const [result, installedResult] = await Promise.all([
        this.api.marketplace.featured(30),
        this.api.marketplace.installed()
      ]);
      if (!result.success) throw new Error(result.error);

      const newSkills = result.skills || [];
      if (installedResult.success) {
        this._state.installed = installedResult.installed || [];
      }

      if (JSON.stringify(newSkills) !== JSON.stringify(this._state.featured)) {
        this._state.featured = newSkills;
        await this._renderCards(this._state.featured, t('marketplace.featured'));
      }
    } catch (e) {
      if (this._state.featured.length === 0) {
        list.innerHTML = `<div class="marketplace-empty"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg><h3>${t('common.error')}</h3><p>${escapeHtml(e.message)}</p></div>`;
      }
    }
  }

  // ── Private ──

  async _isSkillInstalled(skillId) {
    try {
      const { fileExists } = require('../../utils/fs-async');
      const skillPath = this.api.path.join(this._skillsDir, skillId);
      return await fileExists(skillPath) && await fileExists(this.api.path.join(skillPath, 'SKILL.md'));
    } catch { return false; }
  }

  _isSkillFromMarketplace(skillId) {
    return this._state.installed.some(s => s.skillId === skillId);
  }

  _formatInstallCount(n) {
    if (!n || n === 0) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return n.toString();
  }

  async _renderCards(skills, sectionTitle) {
    const list = document.getElementById('skills-list');

    if (!skills || skills.length === 0) {
      list.innerHTML = `<div class="marketplace-empty">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
        <h3>${t('marketplace.noResults')}</h3>
        <p>${t('marketplace.searchHint')}</p>
      </div>`;
      return;
    }

    let html = `<div class="list-section">
      <div class="list-section-title">${escapeHtml(sectionTitle)} <span class="list-section-count">${skills.length}</span></div>
      <div class="list-section-grid">`;

    for (const skill of skills) {
      const installed = await this._isSkillInstalled(skill.skillId || skill.name);
      const cardClass = installed ? 'list-card marketplace-card installed' : 'list-card marketplace-card';
      const skillName = skill.name || skill.skillId;
      const initial = escapeHtml((skillName || '?').charAt(0).toUpperCase());
      html += `
      <div class="${cardClass}" data-skill-id="${escapeHtml(skill.skillId || skill.name)}" data-source="${escapeHtml(skill.source || '')}" data-name="${escapeHtml(skillName)}" data-installs="${skill.installs || 0}">
        <div class="card-initial">${initial}</div>
        <div class="list-card-header">
          <div class="list-card-title">${escapeHtml(skillName)}</div>
          <div class="list-card-badge marketplace">${installed ? t('marketplace.installedBadge') : 'Skill'}</div>
        </div>
        <div class="marketplace-card-info">
          <div class="marketplace-card-stats">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            ${this._formatInstallCount(skill.installs)} ${t('marketplace.installs')}
          </div>
          ${skill.source ? `<div class="marketplace-card-source">${escapeHtml(skill.source)}</div>` : ''}
        </div>
        <div class="list-card-footer">
          <button class="btn-sm btn-secondary btn-details">${t('marketplace.details')}</button>
          ${installed
            ? (this._isSkillFromMarketplace(skill.skillId || skill.name)
                ? `<button class="btn-sm btn-uninstall">${t('marketplace.uninstall')}</button>`
                : `<span class="marketplace-installed-badge">${t('marketplace.installedBadge')}</span>`)
            : `<button class="btn-sm btn-install">${t('marketplace.install')}</button>`
          }
        </div>
      </div>`;
    }

    html += `</div></div>`;
    list.innerHTML = html;
    this._bindCardHandlers();
  }

  _bindCardHandlers() {
    const list = document.getElementById('skills-list');

    list.querySelectorAll('.marketplace-card').forEach(card => {
      const skillId = card.dataset.skillId;
      const source = card.dataset.source;
      const name = card.dataset.name;
      const installs = parseInt(card.dataset.installs) || 0;

      const detailsBtn = card.querySelector('.btn-details');
      if (detailsBtn) {
        detailsBtn.onclick = () => this._showDetail({ skillId, source, name, installs });
      }

      const installBtn = card.querySelector('.btn-install');
      if (installBtn) {
        installBtn.onclick = async () => {
          installBtn.disabled = true;
          installBtn.innerHTML = `<span class="btn-install-spinner"></span>${t('marketplace.installing')}`;

          try {
            const result = await this.api.marketplace.install({ source, skillId, name, installs });
            if (!result.success) throw new Error(result.error);
            await this.loadMarketplaceContent();
          } catch (e) {
            installBtn.disabled = false;
            installBtn.textContent = t('marketplace.install');
            this._showToast({ type: 'error', title: t('marketplace.installError'), message: e.message });
          }
        };
      }

      const uninstallBtn = card.querySelector('.btn-uninstall');
      if (uninstallBtn) {
        uninstallBtn.onclick = async () => {
          const ok = await showConfirm({
            title: t('marketplace.uninstall') || 'Uninstall',
            message: t('marketplace.confirmUninstall', { name: name || skillId }),
            confirmLabel: t('marketplace.uninstall') || 'Uninstall',
            danger: true
          });
          if (!ok) return;

          try {
            const result = await this.api.marketplace.uninstall(skillId);
            if (!result.success) throw new Error(result.error);
            await this.loadMarketplaceContent();
          } catch (e) {
            this._showToast({ type: 'error', title: t('marketplace.uninstallError'), message: e.message });
          }
        };
      }

      const openFolderBtn = card.querySelector('.btn-open-folder');
      if (openFolderBtn) {
        const skillPath = this.api.path.join(this._skillsDir, skillId);
        openFolderBtn.onclick = () => this.api.dialog.openInExplorer(skillPath);
      }
    });
  }

  async _showDetail(skill) {
    const { skillId, source, name, installs } = skill;
    const installed = await this._isSkillInstalled(skillId);

    let readmeHtml = `<div class="marketplace-loading"><div class="spinner"></div>${t('common.loading')}</div>`;

    const content = `
      <div class="marketplace-detail-header">
        <div>
          <div class="marketplace-detail-title">${escapeHtml(name || skillId)}</div>
          <div class="marketplace-detail-source">${escapeHtml(source)}</div>
          <div class="marketplace-detail-stats">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            ${this._formatInstallCount(installs)} ${t('marketplace.installs')}
          </div>
        </div>
      </div>
      <div class="marketplace-detail-readme" id="marketplace-readme-content">${readmeHtml}</div>
      <div class="marketplace-detail-actions">
        ${installed
          ? (this._isSkillFromMarketplace(skillId)
              ? `<button class="btn-primary btn-uninstall-detail btn-danger-fill">${t('marketplace.uninstall')}</button>
                 <button class="btn-secondary btn-open-folder-detail">${t('marketplace.openFolder')}</button>`
              : `<span class="marketplace-installed-badge">${t('marketplace.installedBadge')}</span>
                 <button class="btn-secondary btn-open-folder-detail">${t('marketplace.openFolder')}</button>`)
          : `<button class="btn-primary btn-install-detail">${t('marketplace.install')}</button>`
        }
      </div>
    `;

    this._showModal(t('marketplace.details'), content);

    try {
      const result = await this.api.marketplace.readme(source, skillId);
      const readmeEl = document.getElementById('marketplace-readme-content');
      if (readmeEl) {
        if (result.success && result.readme) {
          readmeEl.innerHTML = renderReadmeMarkdown(result.readme);
          readmeEl.classList.add('readme-markdown');
          bindReadmeLinks(readmeEl, (url) => this.api.dialog.openExternal(url));
        } else {
          readmeEl.innerHTML = `<em>${t('marketplace.noReadme')}</em>`;
        }
      }
    } catch (e) {
      const readmeEl = document.getElementById('marketplace-readme-content');
      if (readmeEl) readmeEl.innerHTML = `<em>${t('marketplace.readmeError')}</em>`;
    }

    const installDetailBtn = document.querySelector('.btn-install-detail');
    if (installDetailBtn) {
      installDetailBtn.onclick = async () => {
        installDetailBtn.disabled = true;
        installDetailBtn.innerHTML = `<span class="btn-install-spinner"></span>${t('marketplace.installing')}`;
        try {
          const result = await this.api.marketplace.install({ source, skillId, name, installs });
          if (!result.success) throw new Error(result.error);
          this._closeModal();
          this.loadMarketplaceContent();
        } catch (e) {
          installDetailBtn.disabled = false;
          installDetailBtn.textContent = t('marketplace.install');
          this._showToast({ type: 'error', title: t('marketplace.installError'), message: e.message });
        }
      };
    }

    const uninstallDetailBtn = document.querySelector('.btn-uninstall-detail');
    if (uninstallDetailBtn) {
      uninstallDetailBtn.onclick = async () => {
        const ok = await showConfirm({
            title: t('marketplace.uninstall') || 'Uninstall',
            message: t('marketplace.confirmUninstall', { name: name || skillId }),
            confirmLabel: t('marketplace.uninstall') || 'Uninstall',
            danger: true
          });
          if (!ok) return;
        try {
          await this.api.marketplace.uninstall(skillId);
          this._closeModal();
          this.loadMarketplaceContent();
        } catch (e) {
          this._showToast({ type: 'error', title: t('marketplace.uninstallError'), message: e.message });
        }
      };
    }

    const openFolderDetailBtn = document.querySelector('.btn-open-folder-detail');
    if (openFolderDetailBtn) {
      openFolderDetailBtn.onclick = () => this.api.dialog.openInExplorer(this.api.path.join(this._skillsDir, skillId));
    }
  }
}

// ── Lazy singleton + legacy exports ──

let _instance = null;

function init(context) {
  const { getApiProvider, getContainer } = require('../../core');
  _instance = new MarketplacePanel(null, {
    api: getApiProvider(),
    container: getContainer(),
    showToast: context.showToast,
    showModal: context.showModal,
    closeModal: context.closeModal,
    skillsDir: context.skillsDir
  });
}

module.exports = {
  MarketplacePanel,
  init,
  loadMarketplaceContent: (...a) => _instance.loadMarketplaceContent(...a),
  searchMarketplace: (...a) => _instance.searchMarketplace(...a),
  loadMarketplaceFeatured: (...a) => _instance.loadMarketplaceFeatured(...a),
  getSearchQuery: () => _instance.getSearchQuery(),
  setSearchQuery: (...a) => _instance.setSearchQuery(...a)
};
