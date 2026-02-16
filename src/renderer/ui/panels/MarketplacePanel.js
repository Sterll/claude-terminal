/**
 * MarketplacePanel
 * Skills marketplace browsing, search, install/uninstall
 * Extracted from renderer.js
 */

const { escapeHtml } = require('../../utils');
const { t } = require('../../i18n');
const { showConfirm } = require('../components/Modal');

let ctx = null;

let marketplaceState = {
  searchResults: [],
  featured: [],
  installed: [],
  loading: false,
  searchQuery: '',
  searchCache: new Map()
};

function init(context) {
  ctx = context;
}

function getSearchQuery() {
  return marketplaceState.searchQuery;
}

function setSearchQuery(query) {
  marketplaceState.searchQuery = query;
}

async function loadMarketplaceContent() {
  if (marketplaceState.searchQuery) {
    await searchMarketplace(marketplaceState.searchQuery);
  } else {
    await loadMarketplaceFeatured();
  }
}

async function searchMarketplace(query) {
  const list = document.getElementById('skills-list');

  const cachedResults = marketplaceState.searchCache.get(query);
  if (cachedResults) {
    marketplaceState.searchResults = cachedResults;
    renderMarketplaceCards(cachedResults, t('marketplace.searchResults'));
  } else {
    list.innerHTML = `<div class="marketplace-loading"><div class="spinner"></div>${t('common.loading')}</div>`;
  }

  try {
    const [result, installedResult] = await Promise.all([
      ctx.api.marketplace.search(query, 30),
      ctx.api.marketplace.installed()
    ]);
    if (!result.success) throw new Error(result.error);

    const newSkills = result.skills || [];
    if (installedResult.success) {
      marketplaceState.installed = installedResult.installed || [];
    }

    marketplaceState.searchCache.set(query, newSkills);

    if (JSON.stringify(newSkills) !== JSON.stringify(marketplaceState.searchResults)) {
      marketplaceState.searchResults = newSkills;
      renderMarketplaceCards(newSkills, t('marketplace.searchResults'));
    }
  } catch (e) {
    if (!cachedResults) {
      list.innerHTML = `<div class="marketplace-empty"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg><h3>${t('common.error')}</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
  }
}

async function loadMarketplaceFeatured() {
  const list = document.getElementById('skills-list');

  if (marketplaceState.featured.length > 0) {
    renderMarketplaceCards(marketplaceState.featured, t('marketplace.featured'));
  } else {
    list.innerHTML = `<div class="marketplace-loading"><div class="spinner"></div>${t('common.loading')}</div>`;
  }

  try {
    const [result, installedResult] = await Promise.all([
      ctx.api.marketplace.featured(30),
      ctx.api.marketplace.installed()
    ]);
    if (!result.success) throw new Error(result.error);

    const newSkills = result.skills || [];
    if (installedResult.success) {
      marketplaceState.installed = installedResult.installed || [];
    }

    if (JSON.stringify(newSkills) !== JSON.stringify(marketplaceState.featured)) {
      marketplaceState.featured = newSkills;
      renderMarketplaceCards(marketplaceState.featured, t('marketplace.featured'));
    }
  } catch (e) {
    if (marketplaceState.featured.length === 0) {
      list.innerHTML = `<div class="marketplace-empty"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg><h3>${t('common.error')}</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
  }
}

function isSkillInstalled(skillId) {
  try {
    const skillPath = ctx.path.join(ctx.skillsDir, skillId);
    return ctx.fs.existsSync(skillPath) && ctx.fs.existsSync(ctx.path.join(skillPath, 'SKILL.md'));
  } catch { return false; }
}

function isSkillFromMarketplace(skillId) {
  return marketplaceState.installed.some(s => s.skillId === skillId);
}

function formatInstallCount(n) {
  if (!n || n === 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toString();
}

function renderMarketplaceCards(skills, sectionTitle) {
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

  html += skills.map(skill => {
    const installed = isSkillInstalled(skill.skillId || skill.name);
    const cardClass = installed ? 'list-card marketplace-card installed' : 'list-card marketplace-card';
    const skillName = skill.name || skill.skillId;
    const initial = escapeHtml((skillName || '?').charAt(0).toUpperCase());
    return `
    <div class="${cardClass}" data-skill-id="${escapeHtml(skill.skillId || skill.name)}" data-source="${escapeHtml(skill.source || '')}" data-name="${escapeHtml(skillName)}" data-installs="${skill.installs || 0}">
      <div class="card-initial">${initial}</div>
      <div class="list-card-header">
        <div class="list-card-title">${escapeHtml(skillName)}</div>
        <div class="list-card-badge marketplace">${installed ? t('marketplace.installedBadge') : 'Skill'}</div>
      </div>
      <div class="marketplace-card-info">
        <div class="marketplace-card-stats">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
          ${formatInstallCount(skill.installs)} ${t('marketplace.installs')}
        </div>
        ${skill.source ? `<div class="marketplace-card-source">${escapeHtml(skill.source)}</div>` : ''}
      </div>
      <div class="list-card-footer">
        <button class="btn-sm btn-secondary btn-details">${t('marketplace.details')}</button>
        ${installed
          ? (isSkillFromMarketplace(skill.skillId || skill.name)
              ? `<button class="btn-sm btn-uninstall">${t('marketplace.uninstall')}</button>`
              : `<span class="marketplace-installed-badge">${t('marketplace.installedBadge')}</span>`)
          : `<button class="btn-sm btn-install">${t('marketplace.install')}</button>`
        }
      </div>
    </div>`;
  }).join('');

  html += `</div></div>`;
  list.innerHTML = html;
  bindMarketplaceCardHandlers();
}

function bindMarketplaceCardHandlers() {
  const list = document.getElementById('skills-list');

  list.querySelectorAll('.marketplace-card').forEach(card => {
    const skillId = card.dataset.skillId;
    const source = card.dataset.source;
    const name = card.dataset.name;
    const installs = parseInt(card.dataset.installs) || 0;

    const detailsBtn = card.querySelector('.btn-details');
    if (detailsBtn) {
      detailsBtn.onclick = () => showMarketplaceDetail({ skillId, source, name, installs });
    }

    const installBtn = card.querySelector('.btn-install');
    if (installBtn) {
      installBtn.onclick = async () => {
        installBtn.disabled = true;
        installBtn.textContent = t('marketplace.installing');

        try {
          const result = await ctx.api.marketplace.install({ source, skillId, name, installs });
          if (!result.success) throw new Error(result.error);
          await loadMarketplaceContent();
        } catch (e) {
          installBtn.disabled = false;
          installBtn.textContent = t('marketplace.install');
          alert(`${t('marketplace.installError')}: ${e.message}`);
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
          const result = await ctx.api.marketplace.uninstall(skillId);
          if (!result.success) throw new Error(result.error);
          await loadMarketplaceContent();
        } catch (e) {
          alert(e.message);
        }
      };
    }

    const openFolderBtn = card.querySelector('.btn-open-folder');
    if (openFolderBtn) {
      const skillPath = ctx.path.join(ctx.skillsDir, skillId);
      openFolderBtn.onclick = () => ctx.api.dialog.openInExplorer(skillPath);
    }
  });
}

async function showMarketplaceDetail(skill) {
  const { skillId, source, name, installs } = skill;
  const installed = isSkillInstalled(skillId);

  let readmeHtml = `<div class="marketplace-loading"><div class="spinner"></div>${t('common.loading')}</div>`;

  const content = `
    <div class="marketplace-detail-header">
      <div>
        <div class="marketplace-detail-title">${escapeHtml(name || skillId)}</div>
        <div class="marketplace-detail-source">${escapeHtml(source)}</div>
        <div class="marketplace-detail-stats">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
          ${formatInstallCount(installs)} ${t('marketplace.installs')}
        </div>
      </div>
    </div>
    <div class="marketplace-detail-readme" id="marketplace-readme-content">${readmeHtml}</div>
    <div class="marketplace-detail-actions">
      ${installed
        ? (isSkillFromMarketplace(skillId)
            ? `<button class="btn-primary btn-uninstall-detail" style="background: var(--danger);">${t('marketplace.uninstall')}</button>
               <button class="btn-secondary btn-open-folder-detail">${t('marketplace.openFolder')}</button>`
            : `<span class="marketplace-installed-badge">${t('marketplace.installedBadge')}</span>
               <button class="btn-secondary btn-open-folder-detail">${t('marketplace.openFolder')}</button>`)
        : `<button class="btn-primary btn-install-detail">${t('marketplace.install')}</button>`
      }
    </div>
  `;

  ctx.showModal(t('marketplace.details'), content);

  try {
    const result = await ctx.api.marketplace.readme(source, skillId);
    const readmeEl = document.getElementById('marketplace-readme-content');
    if (readmeEl) {
      if (result.success && result.readme) {
        readmeEl.textContent = result.readme;
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
      installDetailBtn.textContent = t('marketplace.installing');
      try {
        const result = await ctx.api.marketplace.install({ source, skillId, name, installs });
        if (!result.success) throw new Error(result.error);
        ctx.closeModal();
        loadMarketplaceContent();
      } catch (e) {
        installDetailBtn.disabled = false;
        installDetailBtn.textContent = t('marketplace.install');
        alert(`${t('marketplace.installError')}: ${e.message}`);
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
        await ctx.api.marketplace.uninstall(skillId);
        ctx.closeModal();
        loadMarketplaceContent();
      } catch (e) {
        alert(e.message);
      }
    };
  }

  const openFolderDetailBtn = document.querySelector('.btn-open-folder-detail');
  if (openFolderDetailBtn) {
    openFolderDetailBtn.onclick = () => ctx.api.dialog.openInExplorer(ctx.path.join(ctx.skillsDir, skillId));
  }
}

module.exports = {
  init,
  loadMarketplaceContent,
  searchMarketplace,
  loadMarketplaceFeatured,
  getSearchQuery,
  setSearchQuery
};
