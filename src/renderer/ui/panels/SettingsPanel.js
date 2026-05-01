/**
 * SettingsPanel
 * Full settings tab: general, claude, github, themes, shortcuts
 * Extracted from renderer.js — migrated to OOP (BasePanel)
 */

const { BasePanel } = require('../../core/BasePanel');
const { escapeHtml } = require('../../utils');
const { t, setLanguage, getCurrentLanguage, getAvailableLanguages } = require('../../i18n');
// RemotePanel is now part of ConnectivityPanel (top-level tab)

// ── Module-level constants ──

const { BUILTIN_TOOLS } = require('../../utils/toolRegistry');

// ── Module-level pure helpers ──

function hexToRgbParts(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
}

function renderAgentColorRow(key, label, badge, color) {
  const swatchStyle = color ? `background:${color}; border-color:${color};` : '';
  return `
    <div class="agent-color-row" data-key="${escapeHtml(key)}">
      <div class="agent-color-dot" style="${swatchStyle}"></div>
      <span class="agent-color-name">${escapeHtml(label)}</span>
      ${badge ? `<span class="agent-color-badge">${escapeHtml(badge)}</span>` : ''}
      <input type="color" class="agent-color-input" value="${color || '#6366f1'}" ${color ? '' : 'data-unset="true"'}>
      ${color ? `<button class="agent-color-reset" title="${t('settings.agentColorReset')}">×</button>` : ''}
    </div>`;
}

function buildContextItemRow(item, index) {
  const typeOptions = ['file', 'folder', 'text'].map(type =>
    `<option value="${type}" ${item.type === type ? 'selected' : ''}>${type === 'file' ? t('settings.contextPackItemFile') : type === 'folder' ? t('settings.contextPackItemFolder') : t('settings.contextPackItemText')}</option>`
  ).join('');

  let valueField = '';
  if (item.type === 'file') {
    valueField = `<input type="text" class="form-input ctx-item-value" value="${escapeHtml(item.path || '')}" placeholder="${t('settings.contextPackFilePath')}" />`;
  } else if (item.type === 'folder') {
    valueField = `<input type="text" class="form-input ctx-item-value" value="${escapeHtml(item.path || '')}" placeholder="${t('settings.contextPackFolderPath')}" />
      <input type="number" class="form-input ctx-item-depth" value="${item.maxDepth || 2}" min="1" max="5" title="${t('settings.contextPackFolderDepth')}" />`;
  } else {
    valueField = `<textarea class="form-input ctx-item-value" rows="2" placeholder="${t('settings.contextPackTextContent')}">${escapeHtml(item.content || '')}</textarea>`;
  }

  return `
    <div class="ctx-item-row" data-index="${index}">
      <select class="ctx-item-type">${typeOptions}</select>
      <div class="ctx-item-value-wrap">${valueField}</div>
      <button class="ctx-item-remove" title="${t('settings.removeItem')}">&times;</button>
    </div>
  `;
}

function setupContextItemHandlers() {
  const { showConfirm } = require('../components/Modal');

  document.querySelectorAll('.ctx-item-type').forEach(select => {
    // Store current type for revert on cancel (issue 5)
    if (!select.dataset.prevType) select.dataset.prevType = select.value;

    select.onchange = async () => {
      const row = select.closest('.ctx-item-row');
      const wrap = row.querySelector('.ctx-item-value-wrap');
      const prevType = select.dataset.prevType;
      const newType = select.value;

      // Check if current value has content — confirm before clearing (issue 5)
      const valueEl = wrap.querySelector('.ctx-item-value');
      const currentValue = valueEl ? (valueEl.value || valueEl.textContent || '').trim() : '';
      if (currentValue) {
        const confirmed = await showConfirm({
          title: t('settings.contextPackItems'),
          message: t('settings.confirmTypeChange'),
        });
        if (!confirmed) {
          select.value = prevType;
          return;
        }
      }

      select.dataset.prevType = newType;
      if (newType === 'file') {
        wrap.innerHTML = `<input type="text" class="form-input ctx-item-value" value="" placeholder="${t('settings.contextPackFilePath')}" />`;
      } else if (newType === 'folder') {
        wrap.innerHTML = `<input type="text" class="form-input ctx-item-value" value="" placeholder="${t('settings.contextPackFolderPath')}" />
          <input type="number" class="form-input ctx-item-depth" value="2" min="1" max="5" title="${t('settings.contextPackFolderDepth')}" />`;
      } else {
        wrap.innerHTML = `<textarea class="form-input ctx-item-value" rows="2" placeholder="${t('settings.contextPackTextContent')}"></textarea>`;
      }
    };
  });

  // Issue 3: delete item with undo toast
  document.querySelectorAll('.ctx-item-remove').forEach(btn => {
    btn.onclick = () => {
      const row = btn.closest('.ctx-item-row');
      const container = row.parentNode;
      const nextSibling = row.nextSibling;
      const savedHtml = row.outerHTML;

      row.remove();

      const { withUndo } = require('../components/Toast');
      withUndo(t('settings.itemDeleted'), () => {
        // Restore item
        const temp = document.createElement('div');
        temp.innerHTML = savedHtml;
        const restored = temp.firstElementChild;
        if (nextSibling && container.contains(nextSibling)) {
          container.insertBefore(restored, nextSibling);
        } else {
          container.appendChild(restored);
        }
        setupContextItemHandlers();
      }, { type: 'info', duration: 5000 });
    };
  });
}

function collectContextItems() {
  const items = [];
  document.querySelectorAll('.ctx-item-row').forEach(row => {
    const type = row.querySelector('.ctx-item-type').value;
    if (type === 'file' || type === 'folder') {
      const path = row.querySelector('.ctx-item-value').value.trim();
      if (!path) return;
      const item = { type, path };
      if (type === 'folder') {
        const depthEl = row.querySelector('.ctx-item-depth');
        if (depthEl) item.maxDepth = parseInt(depthEl.value) || 2;
      }
      items.push(item);
    } else {
      const content = row.querySelector('.ctx-item-value').value.trim();
      if (!content) return;
      items.push({ type, content });
    }
  });
  return items;
}

// ── SettingsPanel class ──

/** @type {SettingsPanel|null} */
let _instance = null;

class SettingsPanel extends BasePanel {
  constructor(el, options = {}) {
    super(el, options);
    /** @type {object} full legacy context */
    this._ctx = options.ctx || null;
    /** @type {Function[]} cleanup functions for panel teardown */
    this._cleanups = [];
  }

  // ── Cleanup helpers ──

  /** Run all registered cleanups and reset the list */
  _runCleanups() {
    for (const fn of this._cleanups) {
      try { if (typeof fn === 'function') fn(); } catch (_) {}
    }
    this._cleanups = [];
  }

  // ── Library panel builder ──

  buildLibraryPanel() {
    const ContextPromptService = require('../../services/ContextPromptService');
    const projectId = require('../../state/projects.state').projectsState.get().openedProjectId || null;
    const packs = ContextPromptService.getContextPacks(projectId);
    const templates = ContextPromptService.getPromptTemplates(projectId);

    const packItems = packs.length > 0 ? packs.map(p => `
      <div class="library-item" data-id="${escapeHtml(p.id)}">
        <div class="library-item-icon context-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        </div>
        <div class="library-item-info">
          <div class="library-item-name">${escapeHtml(p.name)}${p.scope === 'project' ? `<span class="library-item-badge">${t('settings.projectBadge')}</span>` : ''}</div>
          <div class="library-item-desc">${escapeHtml(p.description || '')}</div>
          ${p.items ? `<div class="library-item-meta">${p.items.length > 1 ? t('settings.itemCountPlural', { count: p.items.length }) : t('settings.itemCount', { count: p.items.length })} &middot; ${p.items.map(i => i.type).filter((v, i, a) => a.indexOf(v) === i).join(', ')}</div>` : ''}
        </div>
        <div class="library-item-actions">
          <button class="btn-icon library-edit-pack" data-id="${escapeHtml(p.id)}" title="${escapeHtml(t('settings.editContextPack'))}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="btn-icon library-delete-pack" data-id="${escapeHtml(p.id)}" title="${escapeHtml(t('settings.confirmDeleteContextPack'))}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
        </div>
      </div>
    `).join('') : `<div class="library-empty">
      <div class="library-empty-icon context-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg></div>
      <div class="library-empty-text">${escapeHtml(t('settings.libraryEmpty'))}</div>
      <div class="library-empty-hint">${escapeHtml(t('settings.contextPacksDesc'))}</div>
    </div>`;

    const templateItems = templates.length > 0 ? templates.map(tmpl => `
      <div class="library-item" data-id="${escapeHtml(tmpl.id)}">
        <div class="library-item-icon prompt-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
        </div>
        <div class="library-item-info">
          <div class="library-item-name">${escapeHtml(tmpl.name)}${tmpl.scope === 'project' ? `<span class="library-item-badge">${t('settings.projectBadge')}</span>` : ''}</div>
          <div class="library-item-desc">${escapeHtml(tmpl.description || '')}</div>
        </div>
        <div class="library-item-actions">
          <button class="btn-icon library-edit-template" data-id="${escapeHtml(tmpl.id)}" title="${escapeHtml(t('settings.editPromptTemplate'))}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="btn-icon library-delete-template" data-id="${escapeHtml(tmpl.id)}" title="${escapeHtml(t('settings.confirmDeletePromptTemplate'))}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
        </div>
      </div>
    `).join('') : `<div class="library-empty">
      <div class="library-empty-icon prompt-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg></div>
      <div class="library-empty-text">${escapeHtml(t('settings.libraryEmpty'))}</div>
      <div class="library-empty-hint">${escapeHtml(t('settings.promptTemplatesDesc'))}</div>
    </div>`;

    return `
      <div class="settings-group">
        <div class="settings-group-header">
          <div class="settings-group-title">
            <span class="library-section-icon context-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg></span>
            ${t('settings.contextPacks')}
          </div>
          <button class="library-new-btn" id="btn-new-context-pack">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            ${t('settings.newContextPack')}
          </button>
        </div>
        <div class="settings-group-desc">${t('settings.contextPacksDesc')}</div>
        <div class="library-section">
          <div class="library-items-list">${packItems}</div>
        </div>
      </div>
      <div class="settings-group">
        <div class="settings-group-header">
          <div class="settings-group-title">
            <span class="library-section-icon prompt-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg></span>
            ${t('settings.promptTemplates')}
          </div>
          <button class="library-new-btn" id="btn-new-prompt-template">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            ${t('settings.newPromptTemplate')}
          </button>
        </div>
        <div class="settings-group-desc">${t('settings.promptTemplatesDesc')}</div>
        <div class="library-section">
          <div class="library-items-list">${templateItems}</div>
        </div>
      </div>
    `;
  }

  // ── Context Pack Modal ──

  showContextPackModal(existingPack = null) {
    const self = this;
    const { createModal, showModal, closeModal } = require('../components/Modal');
    const projectId = require('../../state/projects.state').projectsState.get().openedProjectId || null;

    const pack = existingPack || { name: '', description: '', items: [] };
    const isEdit = !!existingPack;
    const scope = existingPack?.scope || 'global';

    const itemsHtml = (pack.items || []).map((item, i) => buildContextItemRow(item, i)).join('');

    const modal = createModal({
      title: isEdit ? t('settings.editContextPack') : t('settings.newContextPack'),
      size: 'medium',
      content: `
        <div class="library-modal-form">
          <div class="form-field">
            <label>${t('settings.contextPackName')}</label>
            <input type="text" id="ctx-pack-name" class="form-input" value="${escapeHtml(pack.name)}" placeholder="${t('settings.contextPackNamePlaceholder')}" />
          </div>
          <div class="form-field">
            <label>${t('settings.contextPackDescription')}</label>
            <input type="text" id="ctx-pack-desc" class="form-input" value="${escapeHtml(pack.description || '')}" placeholder="${t('settings.contextPackDescription')}" />
          </div>
          ${projectId ? `
          <div class="form-field">
            <label>${t('settings.contextPackScope')}</label>
            <div class="form-radio-group">
              <label class="form-radio"><input type="radio" name="ctx-scope" value="global" ${scope === 'global' ? 'checked' : ''}> ${t('settings.contextPackScopeGlobal')}</label>
              <label class="form-radio"><input type="radio" name="ctx-scope" value="project" ${scope === 'project' ? 'checked' : ''}> ${t('settings.contextPackScopeProject')}</label>
            </div>
          </div>` : ''}
          <div class="form-field">
            <label>${t('settings.contextPackItems')}</label>
            <div class="ctx-items-container" id="ctx-pack-items">${itemsHtml}</div>
            <button class="ctx-add-item-btn" id="btn-add-ctx-item">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
              ${t('settings.contextPackAddItem')}
            </button>
          </div>
        </div>
      `,
      buttons: [
        { label: t('common.cancel'), action: 'cancel', onClick: () => closeModal(modal) },
        { label: t('common.save'), action: 'save', primary: true, onClick: () => {
          const nameInput = document.getElementById('ctx-pack-name');
          const name = nameInput.value.trim();
          if (!name) {
            nameInput.classList.add('error');
            let errMsg = nameInput.parentNode.querySelector('.setting-error-msg');
            if (!errMsg) {
              errMsg = document.createElement('div');
              errMsg.className = 'setting-error-msg';
              nameInput.parentNode.appendChild(errMsg);
            }
            errMsg.textContent = t('settings.nameRequired');
            nameInput.focus();
            return;
          }

          const description = document.getElementById('ctx-pack-desc').value.trim();
          const scopeEl = document.querySelector('input[name="ctx-scope"]:checked');
          const newScope = scopeEl?.value || 'global';
          const items = collectContextItems();

          const ContextPromptService = require('../../services/ContextPromptService');
          const data = { name, description, items };
          if (isEdit) data.id = pack.id;
          if (isEdit) data.createdAt = pack.createdAt;
          ContextPromptService.saveContextPack(data, newScope === 'project' ? projectId : null);

          closeModal(modal);
          self.renderSettingsTab('library');
        }}
      ]
    });

    showModal(modal);

    // Validation: clear error on input
    const nameInput = document.getElementById('ctx-pack-name');
    if (nameInput) {
      nameInput.addEventListener('input', () => {
        nameInput.classList.remove('error');
        const errMsg = nameInput.parentNode.querySelector('.setting-error-msg');
        if (errMsg) errMsg.remove();
      });
    }

    // Add item button
    const addBtn = document.getElementById('btn-add-ctx-item');
    if (addBtn) {
      addBtn.onclick = () => {
        const itemsContainer = document.getElementById('ctx-pack-items');
        const idx = itemsContainer.querySelectorAll('.ctx-item-row').length;
        itemsContainer.insertAdjacentHTML('beforeend', buildContextItemRow({ type: 'file', path: '' }, idx));
        setupContextItemHandlers();
      };
    }
    setupContextItemHandlers();
  }

  // ── Prompt Template Modal ──

  showPromptTemplateModal(existingTemplate = null) {
    const self = this;
    const { createModal, showModal, closeModal } = require('../components/Modal');
    const projectId = require('../../state/projects.state').projectsState.get().openedProjectId || null;

    const tmpl = existingTemplate || { name: '', description: '', template: '' };
    const isEdit = !!existingTemplate;
    const scope = existingTemplate?.scope || 'global';

    const modal = createModal({
      title: isEdit ? t('settings.editPromptTemplate') : t('settings.newPromptTemplate'),
      size: 'medium',
      content: `
        <div class="library-modal-form">
          <div class="form-field">
            <label>${t('settings.promptTemplateName')}</label>
            <input type="text" id="prompt-tmpl-name" class="form-input" value="${escapeHtml(tmpl.name)}" placeholder="${t('settings.templateNamePlaceholder')}" />
          </div>
          <div class="form-field">
            <label>${t('settings.promptTemplateDescription')}</label>
            <input type="text" id="prompt-tmpl-desc" class="form-input" value="${escapeHtml(tmpl.description || '')}" placeholder="${t('settings.promptTemplateDescription')}" />
          </div>
          ${projectId ? `
          <div class="form-field">
            <label>${t('settings.promptTemplateScope')}</label>
            <div class="form-radio-group">
              <label class="form-radio"><input type="radio" name="prompt-scope" value="global" ${scope === 'global' ? 'checked' : ''}> ${t('settings.contextPackScopeGlobal')}</label>
              <label class="form-radio"><input type="radio" name="prompt-scope" value="project" ${scope === 'project' ? 'checked' : ''}> ${t('settings.contextPackScopeProject')}</label>
            </div>
          </div>` : ''}
          <div class="form-field">
            <label>${t('settings.promptTemplateContent')}</label>
            <textarea id="prompt-tmpl-content" class="form-input" rows="6" placeholder="${t('settings.templateContentPlaceholder')}">${escapeHtml(tmpl.template || '')}</textarea>
            <div class="form-help">${t('settings.promptTemplateVariablesHelp')}</div>
          </div>
        </div>
      `,
      buttons: [
        { label: t('common.cancel'), action: 'cancel', onClick: () => closeModal(modal) },
        { label: t('common.save'), action: 'save', primary: true, onClick: () => {
          const tmplNameInput = document.getElementById('prompt-tmpl-name');
          const name = tmplNameInput.value.trim();
          if (!name) {
            tmplNameInput.classList.add('error');
            let errMsg = tmplNameInput.parentNode.querySelector('.setting-error-msg');
            if (!errMsg) {
              errMsg = document.createElement('div');
              errMsg.className = 'setting-error-msg';
              tmplNameInput.parentNode.appendChild(errMsg);
            }
            errMsg.textContent = t('settings.nameRequired');
            tmplNameInput.focus();
            return;
          }

          const description = document.getElementById('prompt-tmpl-desc').value.trim();
          const template = document.getElementById('prompt-tmpl-content').value;
          const scopeEl = document.querySelector('input[name="prompt-scope"]:checked');
          const newScope = scopeEl?.value || 'global';

          const ContextPromptService = require('../../services/ContextPromptService');
          const data = { name, description, template };
          if (isEdit) data.id = tmpl.id;
          if (isEdit) data.createdAt = tmpl.createdAt;
          ContextPromptService.savePromptTemplate(data, newScope === 'project' ? projectId : null);

          closeModal(modal);
          self.renderSettingsTab('library');
        }}
      ]
    });

    showModal(modal);

    // Validation: clear error on input
    const tmplNameEl = document.getElementById('prompt-tmpl-name');
    if (tmplNameEl) {
      tmplNameEl.addEventListener('input', () => {
        tmplNameEl.classList.remove('error');
        const errMsg = tmplNameEl.parentNode.querySelector('.setting-error-msg');
        if (errMsg) errMsg.remove();
      });
    }
  }

  // ── Agent Colors Panel ──

  async loadAgentsColorPanel() {
    const content = document.getElementById('agent-colors-content');
    if (!content) return;

    const { fileExists: fileExistsAsync, fsp: fspLocal } = require('../../utils/fs-async');
    const { path, os } = window.electron_nodeModules;
    const home = os.homedir();
    const agentColors = this._ctx.settingsState.get().agentColors || {};

    // Load custom agents
    const agents = [];
    const agentsDir = path.join(home, '.claude', 'agents');
    try {
      if (await fileExistsAsync(agentsDir)) {
        const entries = await fspLocal.readdir(agentsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.md')) {
            agents.push({ id: entry.name.replace(/\.md$/, ''), name: entry.name.replace(/\.md$/, '') });
          } else if (entry.isDirectory()) {
            agents.push({ id: entry.name, name: entry.name });
          }
        }
      }
    } catch { /* ignore */ }

    // Load MCPs
    const mcps = [];
    const claudeConfigFile = path.join(home, '.claude.json');
    try {
      if (await fileExistsAsync(claudeConfigFile)) {
        const config = JSON.parse(await fspLocal.readFile(claudeConfigFile, 'utf8'));
        const servers = config.mcpServers || {};
        Object.keys(servers).forEach(name => mcps.push({ id: name, name }));
      }
    } catch { /* ignore */ }

    const self = this;

    function buildSection(title, items, badge) {
      if (items.length === 0) return '';
      const rows = items.map(item => {
        const color = agentColors[item.id] || null;
        return renderAgentColorRow(item.id, item.name, badge, color);
      }).join('');
      return `
        <div class="settings-group">
          <div class="settings-group-title">${title}</div>
          <div class="settings-card agent-colors-list">${rows}</div>
        </div>`;
    }

    content.innerHTML =
      buildSection(t('settings.agentColorsBuiltin'), BUILTIN_TOOLS.map(n => ({ id: n, name: n })), null) +
      (agents.length ? buildSection(t('settings.agentColorsAgents'), agents, t('settings.agentBadgeAgent')) : '') +
      (mcps.length ? buildSection(t('settings.agentColorsMcp'), mcps, t('settings.agentBadgeMcp')) : '');

    // Save color on change
    content.querySelectorAll('.agent-color-input').forEach(input => {
      input.addEventListener('input', () => {
        const key = input.closest('.agent-color-row').dataset.key;
        const newColors = { ...self._ctx.settingsState.get().agentColors, [key]: input.value };
        self._ctx.settingsState.set({ ...self._ctx.settingsState.get(), agentColors: newColors });
        self._ctx.saveSettings();
        const dot = input.closest('.agent-color-row').querySelector('.agent-color-dot');
        if (dot) { dot.style.background = input.value; dot.style.borderColor = input.value; }
        delete input.dataset.unset;
        // Ensure reset button present
        if (!input.nextElementSibling?.classList.contains('agent-color-reset')) {
          const btn = document.createElement('button');
          btn.className = 'agent-color-reset';
          btn.title = t('settings.agentColorReset');
          btn.textContent = '×';
          input.insertAdjacentElement('afterend', btn);
          btn.addEventListener('click', () => resetAgentColor(btn));
        }
      });
    });

    content.querySelectorAll('.agent-color-reset').forEach(btn => {
      btn.addEventListener('click', () => resetAgentColor(btn));
    });

    function resetAgentColor(btn) {
      const row = btn.closest('.agent-color-row');
      const key = row.dataset.key;
      const newColors = { ...self._ctx.settingsState.get().agentColors };
      delete newColors[key];
      self._ctx.settingsState.set({ ...self._ctx.settingsState.get(), agentColors: newColors });
      self._ctx.saveSettings();
      const dot = row.querySelector('.agent-color-dot');
      if (dot) { dot.style.background = ''; dot.style.borderColor = ''; }
      const input = row.querySelector('.agent-color-input');
      if (input) input.dataset.unset = 'true';
      btn.remove();
    }
  }

  // ── Tab switching ──

  switchToSettingsTab(initialSubTab = 'general') {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.getElementById('btn-settings').classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('tab-settings').classList.add('active');
    this._ctx?.TimeTrackingDashboard?.cleanup();
    this.renderSettingsTab(initialSubTab);
  }

  // ── Main render ──

  async renderSettingsTab(initialTab = 'general') {
    const self = this;
    const container = document.getElementById('tab-settings');
    const settings = this._ctx.settingsState.get();

    let launchAtStartup = false;
    try {
      launchAtStartup = await this.api.app.getLaunchAtStartup();
    } catch (e) {
      console.error('Error getting launch at startup:', e);
    }

    let githubStatus = { authenticated: false };
    try {
      githubStatus = await this.api.github.authStatus();
    } catch (e) {
      console.error('Error getting GitHub status:', e);
    }

    let workspacesList = [];
    try {
      const res = await this.api.workspace.list();
      if (res?.success && Array.isArray(res.workspaces)) workspacesList = res.workspaces;
      else if (Array.isArray(res)) workspacesList = res;
    } catch (e) {
      console.warn('Error getting workspaces list:', e.message);
    }

    const availableLanguages = getAvailableLanguages();
    const currentLang = getCurrentLanguage();

    container.innerHTML = `
      <div class="settings-inline-wrapper">
        <div class="settings-tabs">
          <button class="settings-tab ${initialTab === 'general' ? 'active' : ''}" data-tab="general">${t('settings.tabGeneral')}</button>
          <button class="settings-tab ${initialTab === 'claude' ? 'active' : ''}" data-tab="claude">${t('settings.tabClaude')}</button>
          <button class="settings-tab ${initialTab === 'github' ? 'active' : ''}" data-tab="github">${t('settings.tabGitHub')}</button>
          <button class="settings-tab ${initialTab === 'themes' ? 'active' : ''}" data-tab="themes">${t('settings.tabThemes')}</button>
          <button class="settings-tab ${initialTab === 'shortcuts' ? 'active' : ''}" data-tab="shortcuts">${t('settings.tabShortcuts')}</button>
          <button class="settings-tab ${initialTab === 'library' ? 'active' : ''}" data-tab="library">${t('settings.tabLibrary')}</button>
          <button class="settings-tab ${initialTab === 'agents' ? 'active' : ''}" data-tab="agents">${t('settings.tabAgents')}</button>
          ${(() => {
            const registry = require('../../../project-types/registry');
            const dynamicTabs = registry.collectAllSettingsFields();
            let tabsHtml = '';
            dynamicTabs.forEach((tabData, tabId) => {
              tabsHtml += `<button class="settings-tab ${initialTab === tabId ? 'active' : ''}" data-tab="${tabId}">${tabData.label}</button>`;
            });
            return tabsHtml;
          })()}
        </div>
        <div class="settings-content">
          <!-- General Tab -->
          <div class="settings-panel ${initialTab === 'general' ? 'active' : ''}" data-panel="general">
            <div class="settings-group" data-section="appearance">
              <div class="settings-group-title">${t('settings.appearance')}</div>
              <div class="settings-card">
                <div class="settings-row">
                  <div class="settings-label">
                    <div>${t('settings.language')}</div>
                    <div class="settings-desc">${t('settings.languageDesc')}</div>
                  </div>
                  <div class="settings-dropdown" id="language-dropdown" data-value="${currentLang}">
                    <div class="settings-dropdown-trigger">
                      <span>${availableLanguages.find(l => l.code === currentLang)?.name || currentLang}</span>
                      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
                    </div>
                    <div class="settings-dropdown-menu">
                      ${availableLanguages.map(lang =>
                        `<div class="settings-dropdown-option ${currentLang === lang.code ? 'selected' : ''}" data-value="${lang.code}">
                          <span class="dropdown-check"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>
                          ${lang.name}
                        </div>`
                      ).join('')}
                    </div>
                  </div>
                </div>
                <div class="settings-row">
                  <div class="settings-label">
                    <div>${t('settings.accentColor')}</div>
                    <div class="settings-desc">${t('settings.accentColorDesc')}</div>
                  </div>
                </div>
                <div class="color-picker">
                  ${['#d97706', '#dc2626', '#db2777', '#9333ea', '#4f46e5', '#2563eb', '#0891b2', '#0d9488', '#16a34a', '#65a30d'].map(c =>
                    `<button class="color-swatch ${settings.accentColor === c ? 'selected' : ''}" style="background:${c}" data-color="${c}"></button>`
                  ).join('')}
                  <div class="color-swatch-custom ${!['#d97706', '#dc2626', '#db2777', '#9333ea', '#4f46e5', '#2563eb', '#0891b2', '#0d9488', '#16a34a', '#65a30d'].includes(settings.accentColor) ? 'selected' : ''}" style="background:${!['#d97706', '#dc2626', '#db2777', '#9333ea', '#4f46e5', '#2563eb', '#0891b2', '#0d9488', '#16a34a', '#65a30d'].includes(settings.accentColor) ? settings.accentColor : 'var(--bg-tertiary)'}">
                    <input type="color" id="custom-color-input" value="${settings.accentColor}" title="${t('settings.accentColor')}">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                  </div>
                </div>
                <div class="settings-row">
                  <div class="settings-label">
                    <div>${t('settings.terminalTheme')}</div>
                    <div class="settings-desc">${t('settings.terminalThemeDesc')}</div>
                  </div>
                  <button type="button" class="btn-outline" id="btn-go-themes">
                    ${this._ctx.TERMINAL_THEMES[settings.terminalTheme || 'claude']?.name || 'Claude'}
                  </button>
                </div>
              </div>
            </div>
            <div class="settings-group" data-section="behavior">
              <div class="settings-group-title">${t('settings.system')}</div>
              <div class="settings-card">
              <div class="settings-toggle-row">
                <div class="settings-toggle-label">
                  <div>${t('settings.launchAtStartup')}</div>
                  <div class="settings-toggle-desc">${t('settings.launchAtStartupDesc')}</div>
                </div>
                <label class="settings-toggle">
                  <input type="checkbox" id="launch-at-startup-toggle" ${launchAtStartup ? 'checked' : ''}>
                  <span class="settings-toggle-slider"></span>
                </label>
              </div>
              <div class="settings-toggle-row">
                <div class="settings-toggle-label">
                  <div>${t('settings.compactProjects')}</div>
                  <div class="settings-toggle-desc">${t('settings.compactProjectsDesc')}</div>
                </div>
                <label class="settings-toggle">
                  <input type="checkbox" id="compact-projects-toggle" ${settings.compactProjects !== false ? 'checked' : ''}>
                  <span class="settings-toggle-slider"></span>
                </label>
              </div>
              <div class="settings-toggle-row">
                <div class="settings-toggle-label">
                  <div>${t('settings.cardButtonClaude')}</div>
                  <div class="settings-toggle-desc">${t('settings.cardButtonClaudeDesc')}</div>
                </div>
                <label class="settings-toggle">
                  <input type="checkbox" id="card-button-claude-toggle" ${(settings.cardButtons?.claude !== false) ? 'checked' : ''}>
                  <span class="settings-toggle-slider"></span>
                </label>
              </div>
              <div class="settings-toggle-row">
                <div class="settings-toggle-label">
                  <div>${t('settings.cardButtonTerminal')}</div>
                  <div class="settings-toggle-desc">${t('settings.cardButtonTerminalDesc')}</div>
                </div>
                <label class="settings-toggle">
                  <input type="checkbox" id="card-button-terminal-toggle" ${(settings.cardButtons?.terminal !== false) ? 'checked' : ''}>
                  <span class="settings-toggle-slider"></span>
                </label>
              </div>
              <div class="settings-toggle-row">
                <div class="settings-toggle-label">
                  <div>${t('settings.aiCommitMessages')}</div>
                  <div class="settings-toggle-desc">${t('settings.aiCommitMessagesDesc')}</div>
                </div>
                <label class="settings-toggle">
                  <input type="checkbox" id="ai-commit-toggle" ${settings.aiCommitMessages !== false ? 'checked' : ''}>
                  <span class="settings-toggle-slider"></span>
                </label>
              </div>
              <div class="settings-row">
                <div class="settings-label">
                  <div>${t('settings.editor')}</div>
                  <div class="settings-desc">${t('settings.editorDesc')}</div>
                </div>
                <div class="settings-dropdown" id="editor-dropdown" data-value="${settings.editor || 'code'}">
                  <div class="settings-dropdown-trigger">
                    <span>${{'code':'VS Code','cursor':'Cursor','zed':'Zed','subl':'Sublime Text','webstorm':'WebStorm','idea':'IntelliJ IDEA','nvim':'Neovim','vim':'Vim','custom':t('settings.editorCustom')}[settings.editor || 'code'] || (settings.editor || 'code')}</span>
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
                  </div>
                  <div class="settings-dropdown-menu">
                    ${[{v:'code',l:'VS Code'},{v:'cursor',l:'Cursor'},{v:'zed',l:'Zed'},{v:'subl',l:'Sublime Text'},{v:'webstorm',l:'WebStorm'},{v:'idea',l:'IntelliJ IDEA'},{v:'nvim',l:'Neovim'},{v:'vim',l:'Vim'},{v:'custom',l:t('settings.editorCustom')}].map(o =>
                      `<div class="settings-dropdown-option ${(settings.editor || 'code') === o.v ? 'selected' : ''}" data-value="${o.v}">
                        <span class="dropdown-check"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>
                        ${o.l}
                      </div>`
                    ).join('')}
                  </div>
                </div>
                <div class="settings-custom-editor" id="custom-editor-row" style="display: ${settings.editor === 'custom' ? 'block' : 'none'}; margin-top: 8px;">
                  <input type="text" class="settings-input" id="custom-editor-input"
                    value="${(settings.customEditorCommand || '').replace(/"/g, '&quot;')}"
                    placeholder="${t('settings.editorCustomPlaceholder')}" />
                </div>
              </div>
              <div class="settings-row">
                <div class="settings-label">
                  <div>${t('settings.closeWindow')}</div>
                  <div class="settings-desc">${t('settings.closeWindowDesc')}</div>
                </div>
                <div class="settings-dropdown" id="close-action-dropdown" data-value="${settings.closeAction || 'ask'}">
                  <div class="settings-dropdown-trigger">
                    <span>${{'ask':t('settings.closeOptionAsk'),'minimize':t('settings.closeOptionMinimize'),'quit':t('settings.closeOptionQuit')}[settings.closeAction || 'ask']}</span>
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
                  </div>
                  <div class="settings-dropdown-menu">
                    ${[{v:'ask',l:t('settings.closeOptionAsk')},{v:'minimize',l:t('settings.closeOptionMinimize')},{v:'quit',l:t('settings.closeOptionQuit')}].map(o =>
                      `<div class="settings-dropdown-option ${(settings.closeAction || 'ask') === o.v ? 'selected' : ''}" data-value="${o.v}">
                        <span class="dropdown-check"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>
                        ${o.l}
                      </div>`
                    ).join('')}
                  </div>
                </div>
              </div>
              <div class="settings-row">
                <div class="settings-label">
                  <div>${t('settings.checkForUpdates')}</div>
                  <div class="settings-desc">${t('settings.checkForUpdatesDesc')}</div>
                </div>
                <button type="button" class="btn-outline" id="btn-check-updates">
                  ${t('settings.checkForUpdatesBtn')}
                </button>
              </div>
              </div>
            </div>
            <div class="settings-group" data-section="integration">
              <div class="settings-group-title">${t('settings.explorerGroup')}</div>
              <div class="settings-card">
                <div class="settings-toggle-row">
                  <div class="settings-toggle-label">
                    <div>${t('settings.showDotfiles')}</div>
                    <div class="settings-toggle-desc">${t('settings.showDotfilesDesc')}</div>
                  </div>
                  <label class="settings-toggle">
                    <input type="checkbox" id="show-dotfiles-toggle" ${settings.showDotfiles !== false ? 'checked' : ''}>
                    <span class="settings-toggle-slider"></span>
                  </label>
                </div>
                <div class="settings-row" style="margin-top: 8px;">
                  <div class="settings-label">
                    <div>${t('settings.explorerIgnorePatterns')}</div>
                    <div class="settings-desc">${t('settings.explorerIgnorePatternsDesc')}</div>
                  </div>
                </div>
                <div style="padding: 0 16px 12px;">
                  <input type="text" id="explorer-ignore-patterns" class="settings-input-sm" style="width: 100%;"
                    value="${escapeHtml((settings.explorerIgnorePatterns || []).join(', '))}"
                    placeholder="e.g. .env, logs, tmp">
                </div>
              </div>
            </div>
            <div class="settings-group" data-section="telemetry">
              <div class="settings-group-title">${t('settings.telemetryGroup')}</div>
              <div class="settings-card">
                <div class="settings-toggle-row">
                  <div class="settings-toggle-label">
                    <div>${t('settings.telemetryEnabled')}</div>
                    <div class="settings-toggle-desc">${t('settings.telemetryEnabledDesc')}</div>
                  </div>
                  <label class="settings-toggle">
                    <input type="checkbox" id="telemetry-enabled-toggle" ${settings.telemetryEnabled ? 'checked' : ''}>
                    <span class="settings-toggle-slider"></span>
                  </label>
                </div>
                ${settings.telemetryEnabled ? `
                <div class="settings-card-section-divider">
                  <div class="settings-toggle-row">
                    <div class="settings-toggle-label">
                      <div>${t('settings.telemetryCategoryApp')}</div>
                      <div class="settings-toggle-desc">${t('settings.telemetryCategoryAppDesc')}</div>
                    </div>
                    <label class="settings-toggle">
                      <input type="checkbox" id="telemetry-cat-app" ${settings.telemetryCategories?.app !== false ? 'checked' : ''}>
                      <span class="settings-toggle-slider"></span>
                    </label>
                  </div>
                  <div class="settings-toggle-row">
                    <div class="settings-toggle-label">
                      <div>${t('settings.telemetryCategoryFeatures')}</div>
                      <div class="settings-toggle-desc">${t('settings.telemetryCategoryFeaturesDesc')}</div>
                    </div>
                    <label class="settings-toggle">
                      <input type="checkbox" id="telemetry-cat-features" ${settings.telemetryCategories?.features !== false ? 'checked' : ''}>
                      <span class="settings-toggle-slider"></span>
                    </label>
                  </div>
                  <div class="settings-toggle-row">
                    <div class="settings-toggle-label">
                      <div>${t('settings.telemetryCategoryErrors')}</div>
                      <div class="settings-toggle-desc">${t('settings.telemetryCategoryErrorsDesc')}</div>
                    </div>
                    <label class="settings-toggle">
                      <input type="checkbox" id="telemetry-cat-errors" ${settings.telemetryCategories?.errors !== false ? 'checked' : ''}>
                      <span class="settings-toggle-slider"></span>
                    </label>
                  </div>
                </div>
                ` : ''}
              </div>
            </div>
            <div class="settings-group" data-section="automation">
              <div class="settings-group-title">${t('settings.automationGroup')}</div>
              <div class="settings-card">
                <div class="settings-toggle-row">
                  <div class="settings-toggle-label">
                    <div>${t('settings.parallelAutoKanban')}</div>
                    <div class="settings-toggle-desc">${t('settings.parallelAutoKanbanDesc')}</div>
                  </div>
                  <label class="settings-toggle">
                    <input type="checkbox" id="parallel-auto-kanban-toggle" ${settings.parallelAutoKanban ? 'checked' : ''}>
                    <span class="settings-toggle-slider"></span>
                  </label>
                </div>
                <div class="settings-row" style="display: ${settings.parallelAutoKanban ? 'flex' : 'none'};" id="parallel-kanban-col-row">
                  <div class="settings-label">
                    <div>${t('settings.parallelAutoKanbanColumn')}</div>
                    <div class="settings-desc">${t('settings.parallelAutoKanbanColumnDesc')}</div>
                  </div>
                  <input type="text" class="settings-input-sm" id="parallel-auto-kanban-column"
                    value="${escapeHtml(settings.parallelAutoKanbanColumn || 'Done')}"
                    placeholder="Done" style="width: 140px;">
                </div>
                <div class="settings-toggle-row">
                  <div class="settings-toggle-label">
                    <div>${t('settings.parallelAutoWorkspaceDoc')}</div>
                    <div class="settings-toggle-desc">${t('settings.parallelAutoWorkspaceDocDesc')}</div>
                  </div>
                  <label class="settings-toggle">
                    <input type="checkbox" id="parallel-auto-workspace-toggle" ${settings.parallelAutoWorkspaceDoc ? 'checked' : ''}>
                    <span class="settings-toggle-slider"></span>
                  </label>
                </div>
                <div class="settings-row" style="display: ${settings.parallelAutoWorkspaceDoc ? 'flex' : 'none'};" id="parallel-workspace-row">
                  <div class="settings-label">
                    <div>${t('settings.parallelWorkspaceId')}</div>
                    <div class="settings-desc">${t('settings.parallelWorkspaceIdDesc')}</div>
                  </div>
                  <div class="settings-dropdown" id="parallel-workspace-dropdown" data-value="${escapeHtml(settings.parallelWorkspaceId || '')}">
                    <div class="settings-dropdown-trigger">
                      <span>${escapeHtml((workspacesList.find(w => w.id === settings.parallelWorkspaceId)?.name) || t('settings.parallelWorkspaceNone'))}</span>
                      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
                    </div>
                    <div class="settings-dropdown-menu">
                      <div class="settings-dropdown-option ${!settings.parallelWorkspaceId ? 'selected' : ''}" data-value="">
                        <span class="dropdown-check"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>
                        ${t('settings.parallelWorkspaceNone')}
                      </div>
                      ${workspacesList.map(w => `
                        <div class="settings-dropdown-option ${settings.parallelWorkspaceId === w.id ? 'selected' : ''}" data-value="${escapeHtml(w.id)}">
                          <span class="dropdown-check"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>
                          ${escapeHtml(w.icon || '')} ${escapeHtml(w.name || w.id)}
                        </div>
                      `).join('')}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="settings-group">
              <div class="settings-group-title">${t('settings.quickActionPresets')}</div>
              <div class="settings-card">
              <div class="settings-desc" style="margin-bottom: 10px; padding: 8px 16px 0;">${t('settings.quickActionPresetsDesc')}</div>
              <div class="custom-presets-list" id="custom-presets-list">
                ${(settings.customPresets || []).map((p, i) => `
                  <div class="custom-preset-item" data-index="${i}">
                    <span class="custom-preset-icon">${this._ctx.QuickActions.QUICK_ACTION_ICONS[p.icon] || this._ctx.QuickActions.QUICK_ACTION_ICONS.play}</span>
                    <span class="custom-preset-name">${escapeHtml(p.name)}</span>
                    <code class="custom-preset-cmd">${escapeHtml(p.command)}</code>
                    <button class="custom-preset-delete" data-index="${i}" title="${t('common.delete')}">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                  </div>
                `).join('') || `<div class="custom-presets-empty">${t('settings.noCustomPresets')}</div>`}
              </div>
              <div class="custom-preset-add" id="custom-preset-add-area">
                <div class="custom-preset-add-row" id="custom-preset-form" style="display:none;">
                  <input type="text" id="new-preset-name" placeholder="${t('quickActions.namePlaceholder')}" class="settings-input-sm">
                  <input type="text" id="new-preset-command" placeholder="${t('quickActions.commandPlaceholder')}" class="settings-input-sm" style="flex:2;">
                  <select id="new-preset-icon" class="settings-select-sm">
                    ${Object.keys(this._ctx.QuickActions.QUICK_ACTION_ICONS).map(icon => `<option value="${icon}">${icon}</option>`).join('')}
                  </select>
                  <button class="btn-accent-sm" id="btn-save-preset">${t('common.save')}</button>
                  <button class="btn-ghost-sm" id="btn-cancel-preset">${t('common.cancel')}</button>
                </div>
                <button class="quick-action-add-btn" id="btn-add-preset" style="width:100%;">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                  <span>${t('settings.addPreset')}</span>
                </button>
              </div>
              </div>
            </div>
            <div class="settings-group">
              <div class="settings-group-title">${t('settings.importExportGroup')}</div>
              <div class="settings-card">
                <div class="settings-row">
                  <div class="settings-label">
                    <div>${t('settings.exportSettings')}</div>
                    <div class="settings-desc">${t('settings.exportSettingsDesc')}</div>
                  </div>
                  <button type="button" class="btn-outline" id="btn-export-settings">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                    ${t('settings.exportBtn')}
                  </button>
                </div>
                <div class="settings-row">
                  <div class="settings-label">
                    <div>${t('settings.importSettings')}</div>
                    <div class="settings-desc">${t('settings.importSettingsDesc')}</div>
                  </div>
                  <button type="button" class="btn-outline" id="btn-import-settings">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg>
                    ${t('settings.importBtn')}
                  </button>
                </div>
              </div>
            </div>
            <div class="settings-group">
              <div class="settings-group-title">${t('settings.aboutGroup')}</div>
              <div class="settings-card">
                <div class="settings-row">
                  <div class="settings-label">
                    <div>${t('settings.rerunSetup')}</div>
                    <div class="settings-desc">${t('settings.rerunSetupDesc')}</div>
                  </div>
                  <button type="button" class="btn-outline" id="btn-rerun-setup">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>
                    ${t('settings.rerunSetupBtn')}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <!-- Claude Tab -->
          <div class="settings-panel ${initialTab === 'claude' ? 'active' : ''}" data-panel="claude">
            <div class="settings-group" data-section="accounts">
              <div class="settings-group-title">${t('settings.accountsGroup') || 'Claude accounts'}</div>
              <div class="settings-card">
                <div class="settings-desc" style="padding: 8px 16px;">${t('settings.accountsDesc') || 'Save the credentials currently active in ~/.claude/.credentials.json so you can switch between them when one hits its usage limit. Run "claude /login" in a terminal to add a new account.'}</div>
                <div class="accounts-list" id="claude-accounts-list">
                  <div class="settings-desc" style="padding: 12px 16px;">${t('common.loading') || 'Loading…'}</div>
                </div>
                <div style="display: flex; gap: 8px; padding: 8px 16px 16px;">
                  <button class="btn btn-secondary" id="btn-account-capture">${t('accounts.captureCurrent') || 'Save current account'}</button>
                </div>
              </div>
            </div>
            <div class="settings-group">
              <div class="settings-group-title">${t('settings.executionMode')}</div>
              <div class="settings-card">
              <div class="execution-mode-selector">
                <div class="execution-mode-card ${!settings.skipPermissions ? 'selected' : ''}" data-mode="safe">
                  <div class="execution-mode-icon safe">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>
                  </div>
                  <div class="execution-mode-content">
                    <div class="execution-mode-title">${t('settings.modeSafe')}</div>
                    <div class="execution-mode-desc">${t('settings.modeSafeDesc')}</div>
                  </div>
                  <div class="execution-mode-check"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>
                </div>
                <div class="execution-mode-card ${settings.skipPermissions ? 'selected' : ''}" data-mode="dangerous">
                  <div class="execution-mode-icon dangerous">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L1 21h22L12 2zm0 3.99L19.53 19H4.47L12 5.99zM11 10v4h2v-4h-2zm0 6v2h2v-2h-2z"/></svg>
                  </div>
                  <div class="execution-mode-content">
                    <div class="execution-mode-title">${t('settings.modeAutonomous')}</div>
                    <div class="execution-mode-desc">${t('settings.modeAutonomousDesc')}</div>
                    <div class="execution-mode-flag">--dangerously-skip-permissions</div>
                  </div>
                  <div class="execution-mode-check"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>
                </div>
              </div>
              <div class="settings-warning" id="dangerous-warning" style="display: ${settings.skipPermissions ? 'flex' : 'none'};">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L1 21h22L12 2zm0 3.99L19.53 19H4.47L12 5.99zM11 10v4h2v-4h-2zm0 6v2h2v-2h-2z"/></svg>
                <span>${t('settings.modeAutonomousWarning')}</span>
              </div>
              </div>
            </div>
            <div class="settings-group">
              <div class="settings-group-title">${t('settings.defaultTerminalMode')}</div>
              <div class="settings-card">
              <div class="execution-mode-selector">
                <div class="execution-mode-card terminal-mode-card ${(settings.defaultTerminalMode || 'terminal') === 'terminal' ? 'selected' : ''}" data-terminal-mode="terminal">
                  <div class="execution-mode-icon neutral">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v12zm-2-1h-6v-2h6v2zM7.5 17l-1.41-1.41L8.67 13l-2.59-2.59L7.5 9l4 4-4 4z"/></svg>
                  </div>
                  <div class="execution-mode-content">
                    <div class="execution-mode-title">${t('settings.modeTerminal')}</div>
                    <div class="execution-mode-desc">${t('settings.modeTerminalDesc')}</div>
                  </div>
                  <div class="execution-mode-check"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>
                </div>
                <div class="execution-mode-card terminal-mode-card ${settings.defaultTerminalMode === 'chat' ? 'selected' : ''}" data-terminal-mode="chat">
                  <div class="execution-mode-icon neutral">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
                  </div>
                  <div class="execution-mode-content">
                    <div class="execution-mode-title">${t('settings.modeChat')}</div>
                    <div class="execution-mode-desc">${t('settings.modeChatDesc')}</div>
                  </div>
                  <div class="execution-mode-check"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>
                </div>
              </div>
              </div>
              <div class="settings-toggle-row" style="margin-top: 12px;">
                <div class="settings-toggle-label">
                  <div>${t('settings.restoreTerminalSessions')}</div>
                  <div class="settings-toggle-desc">${t('settings.restoreTerminalSessionsDesc')}</div>
                </div>
                <label class="settings-toggle">
                  <input type="checkbox" id="restore-sessions-toggle" ${settings.restoreTerminalSessions !== false ? 'checked' : ''}>
                  <span class="settings-toggle-slider"></span>
                </label>
              </div>
            </div>
            <div class="settings-group">
              <div class="settings-group-title">${t('settings.terminalGroup')}</div>
              <div class="settings-card">
                <div class="settings-toggle-row">
                  <div class="settings-toggle-label">
                    <div>${t('settings.showTabModeToggle')}</div>
                    <div class="settings-toggle-desc">${t('settings.showTabModeToggleDesc')}</div>
                  </div>
                  <label class="settings-toggle">
                    <input type="checkbox" id="show-tab-mode-toggle" ${settings.showTabModeToggle !== false ? 'checked' : ''}>
                    <span class="settings-toggle-slider"></span>
                  </label>
                </div>
                <div class="settings-toggle-row">
                  <div class="settings-toggle-label">
                    <div>${t('settings.tabRenameOnSlashCommand')}</div>
                    <div class="settings-toggle-desc">${t('settings.tabRenameOnSlashCommandDesc')}</div>
                  </div>
                  <label class="settings-toggle">
                    <input type="checkbox" id="tab-rename-slash-toggle" ${settings.tabRenameOnSlashCommand ? 'checked' : ''}>
                    <span class="settings-toggle-slider"></span>
                  </label>
                </div>
                <div class="settings-toggle-row">
                  <div class="settings-toggle-label">
                    <div>${t('settings.aiTabNaming')}</div>
                    <div class="settings-toggle-desc">${t('settings.aiTabNamingDesc')}</div>
                  </div>
                  <label class="settings-toggle">
                    <input type="checkbox" id="ai-tab-naming-toggle" ${settings.aiTabNaming !== false ? 'checked' : ''}>
                    <span class="settings-toggle-slider"></span>
                  </label>
                </div>
                <div class="settings-toggle-row">
                  <div class="settings-toggle-label">
                    <div>${t('settings.enableFollowupSuggestions')}</div>
                    <div class="settings-toggle-desc">${t('settings.enableFollowupSuggestionsDesc')}</div>
                  </div>
                  <label class="settings-toggle">
                    <input type="checkbox" id="followup-suggestions-toggle" ${settings.enableFollowupSuggestions !== false ? 'checked' : ''}>
                    <span class="settings-toggle-slider"></span>
                  </label>
                </div>
                <div class="settings-toggle-row">
                  <div class="settings-toggle-label">
                    <div>${t('settings.enhancePrompts')}</div>
                    <div class="settings-toggle-desc">${t('settings.enhancePromptsDesc')}</div>
                  </div>
                  <label class="settings-toggle">
                    <input type="checkbox" id="enhance-prompts-toggle" ${settings.enhancePrompts ? 'checked' : ''}>
                    <span class="settings-toggle-slider"></span>
                  </label>
                </div>
                <div class="settings-toggle-row">
                  <div class="settings-toggle-info">
                    <div>${t('settings.autoClaudeMdUpdate')}</div>
                    <div class="settings-toggle-desc">${t('settings.autoClaudeMdUpdateDesc')}</div>
                  </div>
                  <label class="settings-toggle">
                    <input type="checkbox" id="auto-claude-md-toggle" ${settings.autoClaudeMdUpdate !== false ? 'checked' : ''}>
                    <span class="settings-toggle-slider"></span>
                  </label>
                </div>
              </div>
            </div>
            <div class="settings-group">
              <div class="settings-group-title">${t('settings.personaGroup')}</div>
              <div class="settings-card persona-card">
                <div class="persona-field">
                  <label for="persona-name-input">${t('settings.personaName')}</label>
                  <input type="text" id="persona-name-input" class="persona-input" value="${escapeHtml(settings.personaName || '')}" placeholder="${t('settings.personaNamePlaceholder')}" />
                </div>
                <div class="persona-field">
                  <label for="persona-instructions-input">${t('settings.personaInstructions')}</label>
                  <textarea id="persona-instructions-input" class="persona-input" rows="3" placeholder="${t('settings.personaInstructionsPlaceholder')}">${escapeHtml(settings.personaInstructions || '')}</textarea>
                </div>
                <div class="persona-help">${t('settings.personaHelp')}</div>
              </div>
            </div>
            <div class="settings-group">
              <div class="settings-group-title">${t('settings.hooks.title')}</div>
              <div class="settings-card">
              <div class="settings-toggle-row">
                <div class="settings-toggle-label">
                  <div>${t('settings.hooks.enable')}</div>
                  <div class="settings-toggle-desc">${t('settings.hooks.description')}</div>
                </div>
                <label class="settings-toggle">
                  <input type="checkbox" id="hooks-enabled-toggle" ${settings.hooksEnabled ? 'checked' : ''}>
                  <span class="settings-toggle-slider"></span>
                </label>
              </div>
              </div>
            </div>
            <div class="settings-group">
              <div class="settings-group-title">${t('settings.advanced')}</div>
              <div class="settings-card">
              <div class="settings-toggle-row">
                <div class="settings-toggle-label">
                  <div>${t('settings.enable1MContext')}</div>
                  <div class="settings-toggle-desc">${t('settings.enable1MContextDesc')}</div>
                </div>
                <label class="settings-toggle">
                  <input type="checkbox" id="enable-1m-context-toggle" ${settings.enable1MContext ? 'checked' : ''}>
                  <span class="settings-toggle-slider"></span>
                </label>
              </div>
              </div>
            </div>
          </div>
          <!-- GitHub Tab -->
          <div class="settings-panel ${initialTab === 'github' ? 'active' : ''}" data-panel="github">
            <div class="settings-group">
              <div class="settings-group-title">${t('settings.githubAccount')}</div>
              <div class="settings-card">
              <div class="github-account-card" id="github-account-card">
                ${githubStatus.authenticated ? `
                  <div class="github-account-connected">
                    <div class="github-account-info">
                      <img src="${githubStatus.avatar_url || ''}" alt="" class="github-avatar" onerror="this.style.display='none'">
                      <div class="github-account-details">
                        <div class="github-account-name">${githubStatus.name || githubStatus.login}</div>
                        <div class="github-account-login">@${githubStatus.login}</div>
                      </div>
                    </div>
                    <button type="button" class="btn-outline-danger btn-sm" id="btn-github-disconnect">${t('settings.githubDisconnect')}</button>
                  </div>
                ` : `
                  <div class="github-account-disconnected">
                    <div class="github-account-message">
                      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                      <div>
                        <div class="github-account-title">${t('settings.githubConnectTitle')}</div>
                        <div class="github-account-desc">${t('settings.githubConnectDesc')}</div>
                      </div>
                    </div>
                  </div>
                  <div class="github-token-form">
                    <div class="github-token-input-group">
                      <input type="password" id="github-token-input" class="github-token-input" placeholder="ghp_xxxxxxxxxxxx">
                      <button type="button" class="btn-github-connect" id="btn-github-connect">${t('settings.githubConnect')}</button>
                    </div>
                    <div class="github-token-help">
                      <a href="#" id="github-token-help-link">${t('settings.githubTokenHelp')}</a>
                    </div>
                  </div>
                `}
              </div>
              <div class="github-device-flow-container" id="github-device-flow" style="display: none;"></div>
              </div>
            </div>
            <div class="settings-group">
              <div class="settings-group-title">${t('settings.githubEnterprise') || 'GitHub Enterprise'}</div>
              <div class="settings-card">
                <div class="settings-row">
                  <div class="settings-row-label">
                    <div class="settings-toggle-label">${t('settings.githubApiUrl') || 'API URL'}</div>
                    <div class="settings-toggle-desc">${t('settings.githubApiUrlDesc') || 'For GitHub Enterprise Server (e.g. https://github.mycompany.com/api/v3)'}</div>
                  </div>
                  <input type="text" class="settings-input" id="settings-github-api-url" value="${escapeHtml(settings.githubApiUrl || 'https://api.github.com')}" placeholder="https://api.github.com" style="width: 300px;">
                </div>
                <div class="settings-row">
                  <div class="settings-row-label">
                    <div class="settings-toggle-label">${t('settings.githubHostname') || 'Hostname'}</div>
                    <div class="settings-toggle-desc">${t('settings.githubHostnameDesc') || 'GitHub hostname used for remote URL detection'}</div>
                  </div>
                  <input type="text" class="settings-input" id="settings-github-hostname" value="${escapeHtml(settings.githubHostname || 'github.com')}" placeholder="github.com" style="width: 300px;">
                </div>
              </div>
            </div>
          </div>
          <!-- Themes Tab -->
          <div class="settings-panel ${initialTab === 'themes' ? 'active' : ''}" data-panel="themes">
            <div class="settings-group">
              <div class="settings-group-title">${t('settings.themesTitle')}</div>
              <div class="settings-desc" style="margin-bottom: 12px; color: var(--text-muted); font-size: 12px;">${t('settings.themesDesc')}</div>
              <div class="theme-grid" id="theme-grid">
                ${Object.entries(this._ctx.TERMINAL_THEMES).map(([id, theme]) => {
                  const isSelected = settings.terminalTheme === id || (!settings.terminalTheme && id === 'claude');
                  const colors = [theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan];
                  return `<div class="theme-card ${isSelected ? 'selected' : ''}" data-theme-id="${id}">
                    <div class="theme-card-preview" style="background:${theme.background}">
                      <span class="theme-card-cursor" style="background:${theme.cursor}"></span>
                      <span class="theme-card-text" style="color:${theme.foreground}">~$&nbsp;</span>
                      <span class="theme-card-text" style="color:${theme.green}">node</span>
                    </div>
                    <div class="theme-card-colors">
                      ${colors.map(c => `<span class="theme-card-swatch" style="background:${c}"></span>`).join('')}
                    </div>
                    <div class="theme-card-name">${theme.name}</div>
                  </div>`;
                }).join('')}
              </div>
            </div>
          </div>
          <!-- Shortcuts Tab -->
          <div class="settings-panel ${initialTab === 'shortcuts' ? 'active' : ''}" data-panel="shortcuts">
            ${this._ctx.ShortcutsManager.renderShortcutsPanel()}
          </div>
          <div class="settings-panel ${initialTab === 'library' ? 'active' : ''}" data-panel="library">
            ${this.buildLibraryPanel()}
          </div>
          <div class="settings-panel ${initialTab === 'agents' ? 'active' : ''}" data-panel="agents">
            <div id="agent-colors-content"><div class="settings-loading-hint">${t('common.loading')}</div></div>
          </div>
          ${(() => {
            const registry = require('../../../project-types/registry');
            const dynamicTabs = registry.collectAllSettingsFields();
            let panelsHtml = '';
            dynamicTabs.forEach((tabData, tabId) => {
              let sectionsHtml = '';
              tabData.sections.forEach((section) => {
                const sectionName = section.typeName.includes('.') ? t(section.typeName) || section.typeName : section.typeName;
                let fieldsHtml = '';
                for (const field of section.fields) {
                  const fieldLabel = field.labelKey ? t(field.labelKey) || field.label : field.label;
                  const fieldDesc = field.descKey ? t(field.descKey) || field.description : field.description;
                  const currentValue = self._ctx.settingsState.get()[field.key];
                  const value = currentValue !== undefined ? currentValue : field.default;
                  if (field.type === 'toggle') {
                    fieldsHtml += `
                      <div class="settings-toggle-row">
                        <div class="settings-toggle-label">
                          <div>${fieldLabel}</div>
                          ${fieldDesc ? `<div class="settings-toggle-desc">${fieldDesc}</div>` : ''}
                        </div>
                        <label class="settings-toggle">
                          <input type="checkbox" class="dynamic-setting-toggle" data-setting-key="${field.key}" ${value ? 'checked' : ''}>
                          <span class="settings-toggle-slider"></span>
                        </label>
                      </div>`;
                  }
                }
                sectionsHtml += `
                  <div class="settings-group">
                    <div class="settings-group-title">${sectionName}</div>
                    <div class="settings-card">
                    ${fieldsHtml}
                    </div>
                  </div>`;
              });
              // Inject core performance settings into the performance tab
              let coreHtml = '';
              if (tabId === 'performance') {
                coreHtml = `
                  <div class="settings-group">
                    <div class="settings-group-title">${t('settings.performanceAnimations')}</div>
                    <div class="settings-card">
                      <div class="settings-toggle-row">
                        <div class="settings-toggle-label">
                          <div>${t('settings.reduceMotion')}</div>
                          <div class="settings-toggle-desc">${t('settings.reduceMotionDesc')}</div>
                        </div>
                        <label class="settings-toggle">
                          <input type="checkbox" id="reduce-motion-toggle" ${settings.reduceMotion ? 'checked' : ''}>
                          <span class="settings-toggle-slider"></span>
                        </label>
                      </div>
                    </div>
                  </div>`;
              }
              panelsHtml += `
                <div class="settings-panel ${initialTab === tabId ? 'active' : ''}" data-panel="${tabId}">
                  ${coreHtml}${sectionsHtml}
                </div>`;
            });
            return panelsHtml;
          })()}
        </div>
      </div>
    `;

    // Tab switching
    container.querySelectorAll('.settings-tab').forEach(tab => {
      tab.onclick = () => {
        container.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        container.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        container.querySelector(`.settings-panel[data-panel="${tab.dataset.tab}"]`)?.classList.add('active');
        if (tab.dataset.tab === 'agents') self.loadAgentsColorPanel();
      };
    });

    if (initialTab === 'agents') this.loadAgentsColorPanel();

    this._ctx.ShortcutsManager.setupShortcutsPanelHandlers();

    // Custom presets management
    const addPresetBtn = document.getElementById('btn-add-preset');
    const presetForm = document.getElementById('custom-preset-form');
    const cancelPresetBtn = document.getElementById('btn-cancel-preset');
    const savePresetBtn = document.getElementById('btn-save-preset');

    if (addPresetBtn) {
      addPresetBtn.onclick = () => {
        presetForm.style.display = 'flex';
        addPresetBtn.style.display = 'none';
        document.getElementById('new-preset-name').focus();
      };
    }

    if (cancelPresetBtn) {
      cancelPresetBtn.onclick = () => {
        presetForm.style.display = 'none';
        addPresetBtn.style.display = '';
      };
    }

    if (savePresetBtn) {
      savePresetBtn.onclick = () => {
        const name = document.getElementById('new-preset-name').value.trim();
        const command = document.getElementById('new-preset-command').value.trim();
        const icon = document.getElementById('new-preset-icon').value;
        if (!name || !command) return;

        const currentPresets = self._ctx.settingsState.get().customPresets || [];
        const updated = [...currentPresets, { name, command, icon }];
        self._ctx.settingsState.set({ ...self._ctx.settingsState.get(), customPresets: updated });
        self._ctx.saveSettings();
        self.renderSettingsTab('general');
      };
    }

    container.querySelectorAll('.custom-preset-delete').forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.index);
        const currentPresets = [...(self._ctx.settingsState.get().customPresets || [])];
        currentPresets.splice(idx, 1);
        self._ctx.settingsState.set({ ...self._ctx.settingsState.get(), customPresets: currentPresets });
        self._ctx.saveSettings();
        self.renderSettingsTab('general');
      };
    });

    container.querySelectorAll('.execution-mode-card:not(.terminal-mode-card)').forEach(card => {
      card.onclick = () => {
        container.querySelectorAll('.execution-mode-card:not(.terminal-mode-card)').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        document.getElementById('dangerous-warning').style.display = card.dataset.mode === 'dangerous' ? 'flex' : 'none';
      };
    });

    // Claude accounts section — wire async list + actions
    this._wireAccountsSection(container);

    container.querySelectorAll('.terminal-mode-card').forEach(card => {
      card.onclick = () => {
        container.querySelectorAll('.terminal-mode-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
      };
    });

    container.querySelectorAll('.color-swatch').forEach(swatch => {
      swatch.onclick = () => {
        container.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
        container.querySelector('.color-swatch-custom')?.classList.remove('selected');
        swatch.classList.add('selected');
      };
    });

    const customColorInput = document.getElementById('custom-color-input');
    const customSwatch = container.querySelector('.color-swatch-custom');
    if (customColorInput && customSwatch) {
      // Live preview while picking (no save)
      customColorInput.oninput = (e) => {
        const color = e.target.value;
        customSwatch.style.background = color;
        container.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
        customSwatch.classList.add('selected');
        self._ctx.applyAccentColor(color);
      };
      // Save only when picker closes
      customColorInput.onchange = () => saveSettingsHandler();
      customSwatch.onclick = (e) => {
        if (e.target === customColorInput) return;
        customColorInput.click();
      };
    }

    container.querySelectorAll('.theme-card').forEach(card => {
      card.onclick = () => {
        container.querySelectorAll('.theme-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        const themeId = card.dataset.themeId;
        self._ctx.TerminalManager.updateAllTerminalsTheme(themeId);
        const btn = document.getElementById('btn-go-themes');
        if (btn) {
          const themeName = self._ctx.TERMINAL_THEMES[themeId]?.name || themeId;
          btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg> ${themeName}`;
        }
      };
    });

    const btnGoThemes = document.getElementById('btn-go-themes');
    if (btnGoThemes) {
      btnGoThemes.onclick = () => {
        container.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        container.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
        container.querySelector('.settings-tab[data-tab="themes"]')?.classList.add('active');
        container.querySelector('.settings-panel[data-panel="themes"]')?.classList.add('active');
      };
    }

    const btnCheckUpdates = document.getElementById('btn-check-updates');
    if (btnCheckUpdates) {
      btnCheckUpdates.onclick = async () => {
        const originalText = btnCheckUpdates.innerHTML;
        btnCheckUpdates.disabled = true;
        btnCheckUpdates.innerHTML = `<span class="btn-spinner"></span> ${t('settings.checking')}`;
        try {
          const result = await self.api.updates.checkForUpdates();
          if (result?.success && result.version) {
            btnCheckUpdates.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> v${result.version}`;
          } else {
            btnCheckUpdates.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> ${t('settings.upToDate')}`;
          }
        } catch (e) {
          btnCheckUpdates.innerHTML = originalText;
        }
        setTimeout(() => {
          btnCheckUpdates.disabled = false;
          btnCheckUpdates.innerHTML = originalText;
        }, 5000);
      };
    }

    async function setupGitHubAuth() {
      const connectBtn = document.getElementById('btn-github-connect');
      const disconnectBtn = document.getElementById('btn-github-disconnect');
      const tokenInput = document.getElementById('github-token-input');
      const helpLink = document.getElementById('github-token-help-link');

      if (connectBtn && tokenInput) {
        connectBtn.onclick = async () => {
          const token = tokenInput.value.trim();
          if (!token) {
            tokenInput.focus();
            tokenInput.classList.add('error');
            setTimeout(() => tokenInput.classList.remove('error'), 1000);
            return;
          }

          connectBtn.disabled = true;
          connectBtn.innerHTML = '<span class="btn-spinner"></span>';

          try {
            const result = await self.api.github.setToken(token);
            if (result.success && result.authenticated) {
              self.renderSettingsTab('github');
            } else {
              tokenInput.classList.add('error');
              tokenInput.value = '';
              tokenInput.placeholder = t('settings.githubTokenInvalid');
              setTimeout(() => {
                tokenInput.classList.remove('error');
                tokenInput.placeholder = 'ghp_xxxxxxxxxxxx';
              }, 2000);
              connectBtn.disabled = false;
              connectBtn.innerHTML = t('settings.githubConnect');
            }
          } catch (e) {
            connectBtn.disabled = false;
            connectBtn.innerHTML = t('settings.githubConnect');
          }
        };

        tokenInput.onkeydown = (e) => {
          if (e.key === 'Enter') connectBtn.click();
        };
      }

      if (helpLink) {
        helpLink.onclick = (e) => {
          e.preventDefault();
          self.api.github.openAuthUrl('https://github.com/settings/tokens/new?scopes=repo&description=Claude%20Terminal');
        };
      }

      if (disconnectBtn) {
        disconnectBtn.onclick = async () => {
          await self.api.github.logout();
          self.renderSettingsTab('github');
        };
      }
    }
    setupGitHubAuth();

    // GitHub Enterprise settings
    const gheApiUrlInput = document.getElementById('settings-github-api-url');
    const gheHostnameInput = document.getElementById('settings-github-hostname');
    const saveGheSettings = () => {
      const { settingsState } = require('../../state');
      const apiUrl = gheApiUrlInput?.value?.trim() || 'https://api.github.com';
      const hostname = gheHostnameInput?.value?.trim() || 'github.com';
      settingsState.saveSetting('githubApiUrl', apiUrl);
      settingsState.saveSetting('githubHostname', hostname);
      self.api.github.configure({ githubApiUrl: apiUrl, githubHostname: hostname });
    };
    if (gheApiUrlInput) gheApiUrlInput.addEventListener('change', saveGheSettings);
    if (gheHostnameInput) gheHostnameInput.addEventListener('change', saveGheSettings);

    // Library tab handlers
    const btnNewPack = document.getElementById('btn-new-context-pack');
    if (btnNewPack) btnNewPack.onclick = () => self.showContextPackModal();

    const btnNewTemplate = document.getElementById('btn-new-prompt-template');
    if (btnNewTemplate) btnNewTemplate.onclick = () => self.showPromptTemplateModal();

    container.querySelectorAll('.library-edit-pack').forEach(btn => {
      btn.onclick = () => {
        const ContextPromptService = require('../../services/ContextPromptService');
        const pack = ContextPromptService.getContextPack(btn.dataset.id);
        if (pack) self.showContextPackModal(pack);
      };
    });
    container.querySelectorAll('.library-delete-pack').forEach(btn => {
      btn.onclick = async () => {
        const { showConfirm } = require('../components/Modal');
        const confirmed = await showConfirm({ title: t('settings.contextPacks'), message: t('settings.confirmDeleteContextPack'), confirmLabel: t('common.delete') });
        if (!confirmed) return;
        const ContextPromptService = require('../../services/ContextPromptService');
        await ContextPromptService.deleteContextPack(btn.dataset.id);
        self.renderSettingsTab('library');
      };
    });
    container.querySelectorAll('.library-edit-template').forEach(btn => {
      btn.onclick = () => {
        const ContextPromptService = require('../../services/ContextPromptService');
        const tmpl = ContextPromptService.getPromptTemplate(btn.dataset.id);
        if (tmpl) self.showPromptTemplateModal(tmpl);
      };
    });
    container.querySelectorAll('.library-delete-template').forEach(btn => {
      btn.onclick = async () => {
        const { showConfirm } = require('../components/Modal');
        const confirmed = await showConfirm({ title: t('settings.promptTemplates'), message: t('settings.confirmDeletePromptTemplate'), confirmLabel: t('common.delete') });
        if (!confirmed) return;
        const ContextPromptService = require('../../services/ContextPromptService');
        await ContextPromptService.deletePromptTemplate(btn.dataset.id);
        self.renderSettingsTab('library');
      };
    });

    container.querySelectorAll('.settings-dropdown').forEach(dropdown => {
      const trigger = dropdown.querySelector('.settings-dropdown-trigger');
      const menu = dropdown.querySelector('.settings-dropdown-menu');
      trigger.onclick = (e) => {
        e.stopPropagation();
        container.querySelectorAll('.settings-dropdown.open').forEach(d => { if (d !== dropdown) d.classList.remove('open'); });
        const wasOpen = dropdown.classList.contains('open');
        dropdown.classList.toggle('open');
        if (!wasOpen) {
          const rect = trigger.getBoundingClientRect();
          menu.style.top = (rect.bottom + 4) + 'px';
          menu.style.right = (window.innerWidth - rect.right) + 'px';
          menu.style.minWidth = rect.width + 'px';
        }
      };
      menu.querySelectorAll('.settings-dropdown-option').forEach(opt => {
        opt.onclick = (e) => {
          e.stopPropagation();
          const value = opt.dataset.value;
          dropdown.dataset.value = value;
          trigger.querySelector('span').textContent = opt.textContent.trim();
          menu.querySelectorAll('.settings-dropdown-option').forEach(o => o.classList.remove('selected'));
          opt.classList.add('selected');
          dropdown.classList.remove('open');
          setTimeout(() => saveSettingsHandler(), 50);
        };
      });
    });
    // Show/hide custom editor input when editor dropdown changes
    const editorDropdownEl = document.getElementById('editor-dropdown');
    if (editorDropdownEl) {
      const observer = new MutationObserver(() => {
        const customRow = document.getElementById('custom-editor-row');
        if (customRow) {
          customRow.style.display = editorDropdownEl.dataset.value === 'custom' ? 'block' : 'none';
        }
      });
      observer.observe(editorDropdownEl, { attributes: true, attributeFilter: ['data-value'] });
    }

    // Issue 7: centralized cleanup — tear down previous listeners before registering new ones
    this._runCleanups();

    const closeDropdowns = () => container.querySelectorAll('.settings-dropdown.open').forEach(d => d.classList.remove('open'));
    document.addEventListener('click', closeDropdowns);
    const scrollParent = container.closest('.tab-content, .content-area, #settings-tab');
    scrollParent?.addEventListener('scroll', closeDropdowns, { passive: true });
    this._cleanups.push(() => {
      document.removeEventListener('click', closeDropdowns);
      scrollParent?.removeEventListener('scroll', closeDropdowns);
    });

    // Issue 1: subscribe to save flush for toast notification
    const { onSaveFlush } = require('../../state/settings.state');
    const unsubFlush = onSaveFlush(({ success, error }) => {
      if (success) {
        const { showSuccess } = require('../components/Toast');
        showSuccess(t('settings.saved'), 2000);
      } else {
        const { showError } = require('../components/Toast');
        showError(t('settings.saveError'), 4000);
      }
    });
    this._cleanups.push(unsubFlush);

    // Issue 6: watch for project changes — invalidate scope radio if project closes
    const { projectsState } = require('../../state/projects.state');
    const unsubProjects = projectsState.subscribe(() => {
      const currentProjectId = projectsState.get().openedProjectId;
      const scopeRadios = container.querySelectorAll('input[name="ctx-scope"], input[name="prompt-scope"]');
      scopeRadios.forEach(radio => {
        if (radio.value === 'project') {
          const label = radio.closest('.form-radio');
          if (!currentProjectId) {
            radio.disabled = true;
            if (label) label.style.opacity = '0.4';
            // Force global if project scope was selected
            if (radio.checked) {
              const globalRadio = radio.closest('.form-radio-group')?.querySelector('input[value="global"]');
              if (globalRadio) globalRadio.checked = true;
            }
          } else {
            radio.disabled = false;
            if (label) label.style.opacity = '';
          }
        }
      });
    });
    this._cleanups.push(unsubProjects);

    const saveSettingsHandler = async () => {
      const selectedMode = container.querySelector('.execution-mode-card:not(.terminal-mode-card).selected');
      const selectedTerminalMode = container.querySelector('.terminal-mode-card.selected');
      const closeActionDropdown = document.getElementById('close-action-dropdown');
      const selectedThemeCard = container.querySelector('.theme-card.selected');
      const languageDropdown = document.getElementById('language-dropdown');
      const newTerminalTheme = selectedThemeCard?.dataset.themeId || 'claude';
      const newLanguage = languageDropdown?.dataset.value || getCurrentLanguage();

      let accentColor = settings.accentColor;
      const selectedSwatch = container.querySelector('.color-swatch.selected');
      const customSwatchSelected = container.querySelector('.color-swatch-custom.selected');
      if (selectedSwatch) {
        accentColor = selectedSwatch.dataset.color;
      } else if (customSwatchSelected) {
        accentColor = document.getElementById('custom-color-input')?.value || settings.accentColor;
      }

      const compactProjectsToggle = document.getElementById('compact-projects-toggle');
      const newCompactProjects = compactProjectsToggle ? compactProjectsToggle.checked : true;
      const cardClaudeToggle = document.getElementById('card-button-claude-toggle');
      const cardTerminalToggle = document.getElementById('card-button-terminal-toggle');
      const newCardButtons = {
        claude: cardClaudeToggle ? cardClaudeToggle.checked : true,
        terminal: cardTerminalToggle ? cardTerminalToggle.checked : true,
      };
      const restoreSessionsToggle = document.getElementById('restore-sessions-toggle');
      const newRestoreTerminalSessions = restoreSessionsToggle ? restoreSessionsToggle.checked : true;
      const reduceMotionToggle = document.getElementById('reduce-motion-toggle');
      const newReduceMotion = reduceMotionToggle ? reduceMotionToggle.checked : false;
      const aiCommitToggle = document.getElementById('ai-commit-toggle');
      const newAiCommitMessages = aiCommitToggle ? aiCommitToggle.checked : true;
      const tabRenameSlashToggle = document.getElementById('tab-rename-slash-toggle');
      const newTabRenameOnSlashCommand = tabRenameSlashToggle ? tabRenameSlashToggle.checked : false;
      const aiTabNamingToggle = document.getElementById('ai-tab-naming-toggle');
      const newAiTabNaming = aiTabNamingToggle ? aiTabNamingToggle.checked : true;
      const followupSuggestionsToggle = document.getElementById('followup-suggestions-toggle');
      const newEnableFollowupSuggestions = followupSuggestionsToggle ? followupSuggestionsToggle.checked : true;
      const enhancePromptsToggle = document.getElementById('enhance-prompts-toggle');
      const newEnhancePrompts = enhancePromptsToggle ? enhancePromptsToggle.checked : false;
      const autoClaudeMdToggle = document.getElementById('auto-claude-md-toggle');
      const newAutoClaudeMd = autoClaudeMdToggle ? autoClaudeMdToggle.checked : true;
      const hooksToggle = document.getElementById('hooks-enabled-toggle');
      const newHooksEnabled = hooksToggle ? hooksToggle.checked : settings.hooksEnabled;
      const context1MToggle = document.getElementById('enable-1m-context-toggle');
      const newEnable1MContext = context1MToggle ? context1MToggle.checked : settings.enable1MContext || false;
      const showDotfilesToggle = document.getElementById('show-dotfiles-toggle');
      const newShowDotfiles = showDotfilesToggle ? showDotfilesToggle.checked : true;
      const ignorePatternsInput = document.getElementById('explorer-ignore-patterns');
      const newIgnorePatterns = ignorePatternsInput
        ? ignorePatternsInput.value.split(',').map(s => s.trim()).filter(Boolean)
        : (settings.explorerIgnorePatterns || []);
      const showTabModeToggleEl = document.getElementById('show-tab-mode-toggle');
      const newShowTabModeToggle = showTabModeToggleEl ? showTabModeToggleEl.checked : true;
      const telemetryEnabledToggle = document.getElementById('telemetry-enabled-toggle');
      const newTelemetryEnabled = telemetryEnabledToggle ? telemetryEnabledToggle.checked : false;
      const telemetryCatApp = document.getElementById('telemetry-cat-app');
      const telemetryCatFeatures = document.getElementById('telemetry-cat-features');
      const telemetryCatErrors = document.getElementById('telemetry-cat-errors');
      const newTelemetryCategories = {
        app: telemetryCatApp ? telemetryCatApp.checked : true,
        features: telemetryCatFeatures ? telemetryCatFeatures.checked : true,
        errors: telemetryCatErrors ? telemetryCatErrors.checked : true
      };

      const parallelAutoKanbanToggle = document.getElementById('parallel-auto-kanban-toggle');
      const newParallelAutoKanban = parallelAutoKanbanToggle ? parallelAutoKanbanToggle.checked : false;
      const parallelAutoKanbanColumnInput = document.getElementById('parallel-auto-kanban-column');
      const newParallelAutoKanbanColumn = parallelAutoKanbanColumnInput
        ? parallelAutoKanbanColumnInput.value.trim() || 'Done'
        : (settings.parallelAutoKanbanColumn || 'Done');
      const parallelAutoWorkspaceToggle = document.getElementById('parallel-auto-workspace-toggle');
      const newParallelAutoWorkspaceDoc = parallelAutoWorkspaceToggle ? parallelAutoWorkspaceToggle.checked : false;
      const parallelWorkspaceDropdown = document.getElementById('parallel-workspace-dropdown');
      const newParallelWorkspaceId = parallelWorkspaceDropdown?.dataset.value || settings.parallelWorkspaceId || '';

      const personaNameInput = document.getElementById('persona-name-input');
      const personaInstructionsInput = document.getElementById('persona-instructions-input');

      const editorDropdown = document.getElementById('editor-dropdown');
      const customEditorInput = document.getElementById('custom-editor-input');
      const newSettings = {
        editor: editorDropdown?.dataset.value || settings.editor || 'code',
        customEditorCommand: customEditorInput ? customEditorInput.value.trim() : (settings.customEditorCommand || ''),
        skipPermissions: selectedMode?.dataset.mode === 'dangerous',
        accentColor,
        closeAction: closeActionDropdown?.dataset.value || 'ask',
        terminalTheme: newTerminalTheme,
        language: newLanguage,
        compactProjects: newCompactProjects,
        cardButtons: newCardButtons,
        restoreTerminalSessions: newRestoreTerminalSessions,
        reduceMotion: newReduceMotion,
        aiCommitMessages: newAiCommitMessages,
        defaultTerminalMode: selectedTerminalMode?.dataset.terminalMode || 'terminal',
        hooksEnabled: newHooksEnabled,
        enable1MContext: newEnable1MContext,
        showDotfiles: newShowDotfiles,
        explorerIgnorePatterns: newIgnorePatterns,
        showTabModeToggle: newShowTabModeToggle,
        tabRenameOnSlashCommand: newTabRenameOnSlashCommand,
        aiTabNaming: newAiTabNaming,
        enableFollowupSuggestions: newEnableFollowupSuggestions,
        enhancePrompts: newEnhancePrompts,
        autoClaudeMdUpdate: newAutoClaudeMd,
        telemetryEnabled: newTelemetryEnabled,
        telemetryCategories: newTelemetryCategories,
        parallelAutoKanban: newParallelAutoKanban,
        parallelAutoKanbanColumn: newParallelAutoKanbanColumn,
        parallelAutoWorkspaceDoc: newParallelAutoWorkspaceDoc,
        parallelWorkspaceId: newParallelWorkspaceId,
        personaName: personaNameInput ? personaNameInput.value.trim() : (settings.personaName || ''),
        personaInstructions: personaInstructionsInput ? personaInstructionsInput.value : (settings.personaInstructions || '')
      };

      container.querySelectorAll('.dynamic-setting-toggle').forEach(toggle => {
        newSettings[toggle.dataset.settingKey] = toggle.checked;
      });

      self._ctx.settingsState.set(newSettings);

      if (newLanguage !== getCurrentLanguage()) {
        self._ctx.saveSettingsImmediate();
        setLanguage(newLanguage);
        location.reload();
        return;
      }

      self._ctx.saveSettings();

      document.body.classList.toggle('compact-projects', newCompactProjects);
      document.body.classList.toggle('reduce-motion', newReduceMotion);
      document.body.classList.toggle('hide-tab-mode-toggle', !newShowTabModeToggle);
      self._ctx.applyAccentColor(newSettings.accentColor);

      if (newTerminalTheme !== settings.terminalTheme) {
        self._ctx.TerminalManager.updateAllTerminalsTheme(newTerminalTheme);
      }

      const launchAtStartupToggle = document.getElementById('launch-at-startup-toggle');
      if (launchAtStartupToggle) {
        try {
          await self.api.app.setLaunchAtStartup(launchAtStartupToggle.checked);
        } catch (e) {
          console.error('Error setting launch at startup:', e);
        }
      }

      if (newHooksEnabled !== settings.hooksEnabled) {
        try {
          if (newHooksEnabled) {
            await self.api.hooks.install();
          } else {
            await self.api.hooks.remove();
          }
        } catch (e) {
          console.error('Error toggling hooks:', e);
        }
        const { switchProvider } = require('../../../renderer/events');
        switchProvider(newHooksEnabled ? 'hooks' : 'scraping');
      }

      // Toast is now triggered by onSaveFlush callback (issue 1) — no premature toast here
    };

    const autoSave = () => saveSettingsHandler();
    container.querySelectorAll('.settings-toggle input, .settings-select').forEach(el => {
      el.addEventListener('change', autoSave);
    });
    container.querySelectorAll('.execution-mode-card, .terminal-mode-card, .theme-card, .color-swatch').forEach(el => {
      el.addEventListener('click', () => setTimeout(autoSave, 50));
    });
    // Persona fields: save on blur (not every keystroke)
    const personaNameEl = document.getElementById('persona-name-input');
    const personaInstructionsEl = document.getElementById('persona-instructions-input');
    if (personaNameEl) personaNameEl.addEventListener('blur', autoSave);
    if (personaInstructionsEl) personaInstructionsEl.addEventListener('blur', autoSave);

    // Re-render settings when telemetry master toggle changes (to show/hide sub-toggles)
    const telemetryMasterToggle = document.getElementById('telemetry-enabled-toggle');
    if (telemetryMasterToggle) {
      telemetryMasterToggle.addEventListener('change', () => {
        setTimeout(() => self.renderSettingsTab('general'), 100);
      });
    }

    // Show/hide conditional rows when automation toggles change (no full re-render)
    const parallelKanbanToggle = document.getElementById('parallel-auto-kanban-toggle');
    if (parallelKanbanToggle) {
      parallelKanbanToggle.addEventListener('change', () => {
        const row = document.getElementById('parallel-kanban-col-row');
        if (row) row.style.display = parallelKanbanToggle.checked ? 'flex' : 'none';
      });
    }
    const parallelWorkspaceToggle = document.getElementById('parallel-auto-workspace-toggle');
    if (parallelWorkspaceToggle) {
      parallelWorkspaceToggle.addEventListener('change', () => {
        const row = document.getElementById('parallel-workspace-row');
        if (row) row.style.display = parallelWorkspaceToggle.checked ? 'flex' : 'none';
      });
    }
    // Save on blur for the column text input
    const parallelColumnInput = document.getElementById('parallel-auto-kanban-column');
    if (parallelColumnInput) parallelColumnInput.addEventListener('blur', autoSave);

    // Issue 4: Re-run setup wizard
    const btnRerunSetup = document.getElementById('btn-rerun-setup');
    if (btnRerunSetup) {
      btnRerunSetup.onclick = () => {
        self.api.setupWizard.rerun();
      };
    }

    // Export settings
    const btnExportSettings = document.getElementById('btn-export-settings');
    if (btnExportSettings) {
      btnExportSettings.onclick = async () => {
        const settings = self._ctx.settingsState.get();
        const exportData = {
          _exportVersion: 1,
          _appVersion: await self.api.app.getVersion(),
          _exportedAt: new Date().toISOString(),
          settings
        };
        const content = JSON.stringify(exportData, null, 2);
        const filePath = await self.api.dialog.saveFileDialog({
          defaultPath: `claude-terminal-settings-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (filePath) {
          try {
            const { fsp: fspExport } = require('../../utils/fs-async');
            await fspExport.writeFile(filePath, content, 'utf8');
            const { showSuccess } = require('../components/Toast');
            showSuccess(t('settings.exportSuccess'));
          } catch (err) {
            console.error('Export settings error:', err);
            const { showError } = require('../components/Toast');
            showError(t('settings.importError'));
          }
        }
      };
    }

    // Import settings
    const btnImportSettings = document.getElementById('btn-import-settings');
    if (btnImportSettings) {
      btnImportSettings.onclick = async () => {
        const filePath = await self.api.dialog.selectFile({
          filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (!filePath) return;
        try {
          const { fsp: fspImport } = require('../../utils/fs-async');
          const raw = await fspImport.readFile(filePath, 'utf8');
          const data = JSON.parse(raw);

          // Accept both wrapped format { settings: {...} } and raw settings object
          const importedSettings = data.settings || data;
          if (typeof importedSettings !== 'object' || Array.isArray(importedSettings)) {
            throw new Error('Invalid settings format');
          }

          // Merge with defaults: only keep known keys
          const { defaultSettings } = require('../../state/settings.state');
          const validKeys = Object.keys(defaultSettings);
          const merged = { ...defaultSettings };
          for (const key of validKeys) {
            if (key in importedSettings) {
              merged[key] = importedSettings[key];
            }
          }

          self._ctx.settingsState.set(merged);
          self._ctx.saveSettingsImmediate();
          self._ctx.applyAccentColor(merged.accentColor);

          const { showSuccess } = require('../components/Toast');
          showSuccess(t('settings.importSuccess'));

          // Re-render to reflect imported settings
          self.renderSettingsTab('general');
        } catch (err) {
          console.error('Import settings error:', err);
          const { showError } = require('../components/Toast');
          showError(t('settings.importError'));
        }
      };
    }
  }

  // ── Claude accounts section ──

  async _wireAccountsSection(container) {
    const listEl = container.querySelector('#claude-accounts-list');
    if (!listEl) return;
    const captureBtn = container.querySelector('#btn-account-capture');

    const renderList = async () => {
      const res = await this.api.accounts.list();
      if (!res.success) {
        listEl.innerHTML = `<div class="settings-desc" style="padding: 12px 16px; color: var(--danger);">${escapeHtml(res.error || 'Failed to load accounts')}</div>`;
        return;
      }
      const { accounts, activeId, hasCredentials } = res.data;
      if (!accounts.length) {
        listEl.innerHTML = `
          <div class="settings-desc" style="padding: 12px 16px;">
            ${escapeHtml(t('accounts.emptyHint') || 'No saved accounts yet. Open a terminal, run "claude /login", then click "Save current account".')}
          </div>`;
        if (captureBtn) captureBtn.disabled = !hasCredentials;
        return;
      }
      listEl.innerHTML = accounts.map(a => `
        <div class="account-row${a.id === activeId ? ' active' : ''}" data-id="${a.id}">
          <div class="account-row-main">
            <div class="account-row-name">${escapeHtml(a.name)}</div>
            <div class="account-row-meta">${escapeHtml((a.fingerprint || '').slice(0, 8))}${a.lastUsedAt ? ` &middot; ${escapeHtml(new Date(a.lastUsedAt).toLocaleString())}` : ''}</div>
          </div>
          <div class="account-row-buttons">
            ${a.id === activeId
              ? `<span class="account-row-status">${escapeHtml(t('accounts.active') || 'Active')}</span>`
              : `<button class="btn btn-secondary btn-sm" data-action="switch" data-id="${a.id}">${escapeHtml(t('accounts.switch') || 'Switch')}</button>`}
            <button class="btn btn-secondary btn-sm" data-action="rename" data-id="${a.id}">${escapeHtml(t('common.rename') || 'Rename')}</button>
            <button class="btn btn-secondary btn-sm" data-action="remove" data-id="${a.id}">${escapeHtml(t('common.delete') || 'Delete')}</button>
          </div>
        </div>
      `).join('');
      if (captureBtn) captureBtn.disabled = !hasCredentials;
    };

    listEl.onclick = async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === 'switch') {
        btn.disabled = true;
        const r = await this.api.accounts.switch(id);
        if (!r.success) { alert(r.error || 'Switch failed'); btn.disabled = false; return; }
        await renderList();
      } else if (action === 'rename') {
        const { showPrompt } = require('../components/Modal');
        const newName = await showPrompt({
          title: t('common.rename') || 'Rename',
          defaultValue: btn.closest('.account-row')?.querySelector('.account-row-name')?.textContent || ''
        });
        if (!newName) return;
        const r = await this.api.accounts.rename(id, newName);
        if (!r.success) { alert(r.error || 'Rename failed'); return; }
        await renderList();
      } else if (action === 'remove') {
        const { showConfirm } = require('../components/Modal');
        const ok = await showConfirm({
          title: t('common.delete') || 'Delete',
          message: t('accounts.removeConfirm') || 'Remove this saved account? The credentials will be deleted from local storage.'
        });
        if (!ok) return;
        const r = await this.api.accounts.remove(id);
        if (!r.success) { alert(r.error || 'Remove failed'); return; }
        await renderList();
      }
    };

    if (captureBtn) {
      captureBtn.onclick = async () => {
        const { showPrompt } = require('../components/Modal');
        const name = await showPrompt({
          title: t('accounts.captureTitle') || 'Save current account',
          message: t('accounts.captureMessage') || 'Give this account a name. The credentials currently active in ~/.claude/.credentials.json will be saved under this name.',
          placeholder: 'e.g. Personal, Work…'
        });
        if (!name) return;
        const r = await this.api.accounts.capture(name);
        if (!r.success) { alert(r.error || 'Capture failed'); return; }
        await renderList();
      };
    }

    // Live refresh when accounts change elsewhere (e.g. via switch modal)
    const unsub = this.api.accounts.onChanged(() => renderList());
    this._cleanups.push(unsub);

    await renderList();
  }

  // ── BasePanel lifecycle ──

  destroy() {
    this._runCleanups();
    super.destroy();
  }
}

// ── Legacy bridge ──

function init(context) {
  const el = document.getElementById('tab-settings');
  _instance = new SettingsPanel(el, {
    api: context.api,
    ctx: context
  });
}

function switchToSettingsTab(initialSubTab = 'general') {
  _instance?.switchToSettingsTab(initialSubTab);
}

function renderSettingsTab(initialTab = 'general') {
  _instance?.renderSettingsTab(initialTab);
}

function cleanup() {
  _instance?._runCleanups();
}

module.exports = { SettingsPanel, init, switchToSettingsTab, renderSettingsTab, cleanup };
