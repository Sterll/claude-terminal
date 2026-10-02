/**
 * SkillsAgentsPanel
 * Skills & Agents browsing, rendering, and management
 */

const { BasePanel } = require('../../core/BasePanel');
const { escapeHtml } = require('../../utils');
const { t } = require('../../i18n');
const { showConfirm, createModal, showModal, closeModal } = require('../components/Modal');
const { loadSkills: loadSkillsService, getSkills, writeSkillContent } = require('../../services/SkillService');
const { loadAgents: loadAgentsService, getAgents, writeAgentContent } = require('../../services/AgentService');
const { renderReadmeMarkdown } = require('../../utils/markdown');
const { highlight } = require('../../utils/syntaxHighlight');

class SkillsAgentsPanel extends BasePanel {
  constructor(el, options = {}) {
    super(el, options);
    this._state = {
      skills: [],
      agents: [],
      activeSubTab: 'local',
      initialized: false
    };
    this._marketplaceSearchTimeout = null;
    this._skillsDir = options.skillsDir;
    this._agentsDir = options.agentsDir;
    this._getSetting = options.getSetting;
    this._showToast = options.showToast;
    this._loadMarketplaceContent = options.loadMarketplaceContent;
    this._searchMarketplace = options.searchMarketplace;
    this._loadMarketplaceFeatured = options.loadMarketplaceFeatured;
    this._setMarketplaceSearchQuery = options.setMarketplaceSearchQuery;
  }

  async loadSkills() {
    if (!this._state.initialized) {
      this._state.initialized = true;
      this._setupSkillsSubTabs();
    }

    if (this._state.activeSubTab === 'local') {
      await this._loadLocalSkills();
    } else {
      await this._loadMarketplaceContent();
    }
  }

  async loadAgents() {
    await loadAgentsService();
    this._state.agents = getAgents();
    this._renderAgents();
  }

  // ── Private ──

  async _loadLocalSkills() {
    await loadSkillsService();
    this._state.skills = getSkills();
    this._renderSkills();
  }

  _setupSkillsSubTabs() {
    document.querySelectorAll('.skills-sub-tab').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.skills-sub-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._state.activeSubTab = btn.dataset.subtab;

        const newSkillBtn = document.getElementById('btn-new-skill');
        const searchContainer = document.getElementById('skills-marketplace-search');

        if (btn.dataset.subtab === 'local') {
          newSkillBtn.style.display = '';
          searchContainer.style.display = 'none';
        } else {
          newSkillBtn.style.display = 'none';
          searchContainer.style.display = 'flex';
        }

        this.loadSkills();
      };
    });

    const input = document.getElementById('marketplace-search-input');
    if (input) {
      input.addEventListener('input', () => {
        clearTimeout(this._marketplaceSearchTimeout);
        const query = input.value.trim();
        this._setMarketplaceSearchQuery(query);

        this._marketplaceSearchTimeout = setTimeout(() => {
          if (query.length >= 2) {
            this._searchMarketplace(query);
          } else if (query.length === 0) {
            this._loadMarketplaceFeatured();
          }
        }, 300);
      });
    }
  }

  // ── Lists ──
  //
  // One card shape for skills and agents: name, two lines of description, the
  // agent's tools as chips, and the actions as icons. The whole card opens the
  // editor, since that is what a click on a skill is for nine times out of ten.

  static ICONS = {
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  };

  _description(item) {
    const d = item.description;
    if (!d || d === '---' || d === t('common.noDescription')) return '';
    // Cards show the opening of the description; the rest is in the editor.
    return String(d).split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  }

  _renderCard(item, { kind, readOnly = false }) {
    const ICONS = SkillsAgentsPanel.ICONS;
    const desc = this._description(item);
    const filePath = item.filePath ? escapeHtml(item.filePath) : '';
    const tools = kind === 'agent' && item.tools?.length
      ? `<div class="sa-card-tools">${item.tools.slice(0, 4).map(tool => `<span class="sa-chip">${escapeHtml(tool)}</span>`).join('')}${item.tools.length > 4 ? `<span class="sa-chip more">+${item.tools.length - 4}</span>` : ''}</div>`
      : '';
    const search = `${item.name || ''} ${desc} ${(item.tools || []).join(' ')}`.toLowerCase();
    return `
      <div class="sa-card${filePath && !readOnly ? ' editable' : ''}" data-kind="${kind}" data-id="${escapeHtml(item.id)}"
           data-path="${escapeHtml(item.path)}" data-file-path="${filePath}" data-search="${escapeHtml(search)}">
        <div class="sa-card-head">
          <span class="sa-card-name">${escapeHtml(item.name)}</span>
          <span class="sa-card-actions">
            ${filePath && !readOnly ? `<button class="sa-icon-btn" data-action="edit" title="${escapeHtml(t('common.edit'))}">${ICONS.edit}</button>` : ''}
            <button class="sa-icon-btn" data-action="open" title="${escapeHtml(t('marketplace.openFolder'))}">${ICONS.folder}</button>
            ${!readOnly ? `<button class="sa-icon-btn danger" data-action="delete" title="${escapeHtml(t('common.delete'))}">${ICONS.trash}</button>` : ''}
          </span>
        </div>
        <div class="sa-card-desc${desc ? '' : ' empty'}">${desc ? escapeHtml(desc) : escapeHtml(t('common.noDescription'))}</div>
        ${tools}
      </div>`;
  }

  _renderSection(title, items, opts, badge = '') {
    return `
      <div class="list-section sa-section">
        <div class="list-section-title">${badge}${escapeHtml(title)} <span class="list-section-count">${items.length}</span></div>
        <div class="sa-grid">${items.map(item => this._renderCard(item, opts)).join('')}</div>
      </div>`;
  }

  _renderToolbar(kind, count) {
    const placeholder = kind === 'skill' ? t('skillsAgents.filterSkills') : t('skillsAgents.filterAgents');
    return `
      <div class="sa-toolbar">
        <label class="sa-search">
          ${SkillsAgentsPanel.ICONS.search}
          <input type="text" class="sa-search-input" placeholder="${escapeHtml(placeholder)}" data-total="${count}">
        </label>
      </div>
      <div class="sa-no-match" hidden>${escapeHtml(t('skillsAgents.noMatch'))}</div>`;
  }

  /** Filtering hides cards in place: no re-render, so focus stays in the field. */
  _bindList(list, reload) {
    const input = list.querySelector('.sa-search-input');
    if (input) {
      input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        let shown = 0;
        list.querySelectorAll('.sa-section').forEach(section => {
          let visible = 0;
          section.querySelectorAll('.sa-card').forEach(card => {
            const hit = !q || card.dataset.search.includes(q);
            card.hidden = !hit;
            if (hit) visible++;
          });
          section.hidden = visible === 0;
          shown += visible;
        });
        list.querySelector('.sa-no-match').hidden = shown > 0;
      });
    }

    list.addEventListener('click', async (e) => {
      const card = e.target.closest('.sa-card');
      if (!card) return;
      const action = e.target.closest('[data-action]')?.dataset.action
        || (card.classList.contains('editable') ? 'edit' : 'open');
      e.stopPropagation();
      if (action === 'open') {
        this.api.dialog.openInExplorer(card.dataset.path);
      } else if (action === 'edit') {
        if (card.dataset.filePath) this._showEditorModal(card.dataset.kind, card.dataset.id, card.dataset.filePath);
      } else if (action === 'delete') {
        const isSkill = card.dataset.kind === 'skill';
        const ok = await showConfirm({
          title: isSkill ? (t('skillsAgents.deleteSkill') || 'Delete skill') : (t('skillsAgents.deleteAgent') || 'Delete agent'),
          message: isSkill ? t('skillsAgents.confirmDeleteSkill') : t('skillsAgents.confirmDeleteAgent'),
          confirmLabel: t('common.delete'),
          danger: true,
        });
        if (ok) {
          await this.api.fs.promises.rm(card.dataset.path, { recursive: true, force: true });
          reload();
        }
      }
    });
  }

  _renderSkills() {
    const list = document.getElementById('skills-list');
    if (this._state.skills.length === 0) {
      list.innerHTML = `<div class="empty-list">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
        <h3>${t('skillsAgents.noSkills')}</h3>
        <p>${t('skillsAgents.noSkillsHint')}</p>
        <div style="display: flex; gap: 8px; margin-top: 12px">
          <button class="btn-primary btn-sm" id="skills-empty-create">${t('skillsAgents.createFirstSkill')}</button>
          <button class="btn-secondary btn-sm" id="skills-empty-marketplace">${t('ui.skillsMarketplace') || 'Marketplace'}</button>
        </div>
      </div>`;
      const createBtn = document.getElementById('skills-empty-create');
      if (createBtn) {
        createBtn.onclick = () => document.getElementById('btn-new-skill')?.click();
      }
      const marketplaceBtn = document.getElementById('skills-empty-marketplace');
      if (marketplaceBtn) {
        marketplaceBtn.onclick = () => {
          const mpTab = document.querySelector('.skills-sub-tab[data-subtab="marketplace"]');
          if (mpTab) mpTab.click();
        };
      }
      return;
    }

    const localSkills = this._state.skills.filter(s => !s.isPlugin);
    const pluginSkills = this._state.skills.filter(s => s.isPlugin);
    const pluginsBySource = {};
    pluginSkills.forEach(s => {
      if (!pluginsBySource[s.sourceLabel]) pluginsBySource[s.sourceLabel] = [];
      pluginsBySource[s.sourceLabel].push(s);
    });

    let html = this._renderToolbar('skill', this._state.skills.length);
    if (localSkills.length > 0) {
      html += this._renderSection(t('skillsAgents.local'), localSkills, { kind: 'skill' });
    }
    Object.entries(pluginsBySource).forEach(([source, skills]) => {
      html += this._renderSection(source, skills, { kind: 'skill', readOnly: true }, '<span class="plugin-badge">Plugin</span> ');
    });

    // A fresh element drops the delegated listener of the previous render.
    const fresh = list.cloneNode(false);
    list.replaceWith(fresh);
    fresh.innerHTML = html;
    this._bindList(fresh, () => this.loadSkills());
  }

  _renderAgents() {
    const list = document.getElementById('agents-list');
    if (this._state.agents.length === 0) {
      list.innerHTML = `<div class="empty-list">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM8 17.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5zM9.5 8c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5S9.5 9.38 9.5 8zm6.5 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
        <h3>${t('skillsAgents.noAgents')}</h3>
        <p>${t('skillsAgents.noAgentsHint')}</p>
        <button class="btn-primary btn-sm" id="agents-empty-create" style="margin-top: 12px">${t('skillsAgents.createFirstAgent')}</button>
      </div>`;
      const createBtn = document.getElementById('agents-empty-create');
      if (createBtn) {
        createBtn.onclick = () => document.getElementById('btn-new-agent')?.click();
      }
      return;
    }

    const html = this._renderToolbar('agent', this._state.agents.length)
      + this._renderSection(t('skillsAgents.agents'), this._state.agents, { kind: 'agent' });
    const fresh = list.cloneNode(false);
    list.replaceWith(fresh);
    fresh.innerHTML = html;
    this._bindList(fresh, () => this.loadAgents());
  }

  async _showEditorModal(type, id, filePath) {
    let content;
    try {
      content = await this.api.fs.promises.readFile(filePath, 'utf8');
    } catch {
      content = '';
    }

    const editorId = `editor-${Date.now()}`;
    const previewId = `preview-${Date.now()}`;
    const shortPath = filePath.replace(this.api.os.homedir(), '~').replace(/\\/g, '/');
    const titleKey = type === 'skill' ? (t('skillsAgents.editSkill') || 'Edit Skill') : (t('skillsAgents.editAgent') || 'Edit Agent');

    const highlightId = `highlight-${Date.now()}`;
    const gutterId = `gutter-${Date.now()}`;

    const modalContent = `
      <div class="skill-editor-container">
        <div class="skill-editor-pane">
          <div class="skill-editor-pane-header">
            <span>${t('skillsAgents.editor') || 'Editor'}</span>
            <span class="skill-editor-path" title="${escapeHtml(filePath)}">${escapeHtml(shortPath)}</span>
          </div>
          <div class="skill-editor-code-wrap">
            <div class="skill-editor-gutter" id="${gutterId}"></div>
            <div class="skill-editor-overlay-wrap">
              <pre class="skill-editor-highlight" id="${highlightId}"><code></code></pre>
              <textarea class="skill-editor-textarea" id="${editorId}" spellcheck="false">${escapeHtml(content)}</textarea>
            </div>
          </div>
        </div>
        <div class="skill-editor-divider"></div>
        <div class="skill-editor-pane">
          <div class="skill-editor-pane-header">
            <span>${t('skillsAgents.preview') || 'Preview'}</span>
          </div>
          <div class="skill-editor-preview readme-markdown" id="${previewId}"></div>
        </div>
      </div>
    `;

    const modal = createModal({
      id: 'skill-editor-modal',
      title: titleKey,
      content: modalContent,
      buttons: [
        {
          label: t('skillsAgents.openExternal') || 'Open in editor',
          action: 'external',
          onClick: () => {
            require('../../utils/editor').openInEditor(filePath, { editor: this._getSetting('editor') });
          }
        },
        {
          label: t('common.save') || 'Save',
          action: 'save',
          primary: true,
          onClick: async (m) => {
            const editorEl = m.querySelector(`#${editorId}`);
            const newContent = editorEl.value;
            let success;
            if (type === 'skill') {
              success = await writeSkillContent(id, newContent);
            } else {
              success = await writeAgentContent(id, newContent);
            }
            if (success) {
              closeModal(m);
              if (type === 'skill') this.loadSkills();
              else this.loadAgents();
              this._hotReloadSessions(type);
            }
          }
        }
      ],
      size: 'large'
    });

    showModal(modal);

    const editorEl = modal.querySelector(`#${editorId}`);
    const previewEl = modal.querySelector(`#${previewId}`);
    const highlightEl = modal.querySelector(`#${highlightId}`);
    const gutterEl = modal.querySelector(`#${gutterId}`);
    const codeEl = highlightEl.querySelector('code');

    // Sync highlighted overlay + line numbers
    function updateHighlight() {
      const code = editorEl.value;
      codeEl.innerHTML = highlight(code, 'md') + '\n';
      // Line numbers
      const lines = code.split('\n');
      gutterEl.innerHTML = lines.map((_, i) => `<span>${i + 1}</span>`).join('');
    }

    let previewTimeout;
    function updatePreview() {
      previewEl.innerHTML = renderReadmeMarkdown(editorEl.value);
    }

    updateHighlight();
    updatePreview();

    editorEl.addEventListener('input', () => {
      updateHighlight();
      clearTimeout(previewTimeout);
      previewTimeout = setTimeout(updatePreview, 150);
    });

    // Scroll sync: textarea -> highlight + gutter
    editorEl.addEventListener('scroll', () => {
      highlightEl.scrollTop = editorEl.scrollTop;
      highlightEl.scrollLeft = editorEl.scrollLeft;
      gutterEl.scrollTop = editorEl.scrollTop;
    });

    editorEl.focus();

    // Tab key inserts 2 spaces
    editorEl.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = editorEl.selectionStart;
        const end = editorEl.selectionEnd;
        editorEl.value = editorEl.value.substring(0, start) + '  ' + editorEl.value.substring(end);
        editorEl.selectionStart = editorEl.selectionEnd = start + 2;
        editorEl.dispatchEvent(new Event('input'));
      }
      // Ctrl+S to save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        modal.querySelector('[data-action="save"]').click();
      }
    });
  }

  /**
   * Hot-reload skills/agents into any live chat session so edits take effect
   * without restarting the conversation (SDK 0.3+). No-op when no session is
   * active — the next chat will read the fresh files from disk anyway.
   */
  async _hotReloadSessions(type) {
    try {
      // Skills reload via reloadSkills; agents are refreshed via reloadPlugins.
      const res = type === 'skill'
        ? await this.api.chat.reloadSkills()
        : await this.api.chat.reloadPlugins();
      if (res?.success && res.reloaded > 0 && this._showToast) {
        this._showToast({
          type: 'success',
          title: t('skillsAgents.hotReloaded', { count: res.reloaded })
            || `Reloaded in ${res.reloaded} active session(s)`,
        });
      }
    } catch (_) { /* best effort */ }
  }
}

// ── Lazy singleton + legacy exports ──

let _instance = null;

function init(context) {
  const { getApiProvider, getContainer } = require('../../core');
  _instance = new SkillsAgentsPanel(null, {
    api: getApiProvider(),
    container: getContainer(),
    skillsDir: context.skillsDir,
    agentsDir: context.agentsDir,
    getSetting: context.getSetting,
    showToast: context.showToast,
    loadMarketplaceContent: context.loadMarketplaceContent,
    searchMarketplace: context.searchMarketplace,
    loadMarketplaceFeatured: context.loadMarketplaceFeatured,
    setMarketplaceSearchQuery: context.setMarketplaceSearchQuery
  });
}

module.exports = {
  SkillsAgentsPanel,
  init,
  loadSkills: (...a) => _instance.loadSkills(...a),
  loadAgents: (...a) => _instance.loadAgents(...a)
};
