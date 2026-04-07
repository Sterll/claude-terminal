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

  _renderSkillCard(s, isPlugin) {
    const desc = (s.description && s.description !== '---' && s.description !== t('common.noDescription')) ? escapeHtml(s.description) : '';
    const initial = escapeHtml((s.name || '?').charAt(0).toUpperCase());
    const cardClass = isPlugin ? 'list-card plugin-card' : 'list-card';
    const badge = isPlugin
      ? `<div class="list-card-badge plugin">Plugin</div>`
      : `<div class="list-card-badge">${t('skillsAgents.skill')}</div>`;
    const filePath = s.filePath ? s.filePath.replace(/"/g, '&quot;') : '';

    return `
    <div class="${cardClass}" data-path="${s.path.replace(/"/g, '&quot;')}" data-file-path="${filePath}" data-skill-id="${escapeHtml(s.id)}" data-is-plugin="${isPlugin}">
      <div class="card-initial">${initial}</div>
      <div class="list-card-header">
        <div class="list-card-title">${escapeHtml(s.name)}</div>
        ${badge}
      </div>
      ${desc ? `<div class="list-card-desc">${desc}</div>` : ''}
      <div class="list-card-footer">
        ${!isPlugin && filePath ? `<button class="btn-sm btn-accent btn-edit">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          ${t('common.edit')}
        </button>` : ''}
        <button class="btn-sm btn-secondary btn-open">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
          ${t('marketplace.openFolder')}
        </button>
        ${!isPlugin ? `<button class="btn-sm btn-delete btn-del" title="${t('common.delete')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>` : ''}
      </div>
    </div>`;
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

    let html = '';

    if (localSkills.length > 0) {
      html += `<div class="list-section">
        <div class="list-section-title">${t('skillsAgents.local')} <span class="list-section-count">${localSkills.length}</span></div>
        <div class="list-section-grid">`;
      html += localSkills.map(s => this._renderSkillCard(s, false)).join('');
      html += `</div></div>`;
    }

    Object.entries(pluginsBySource).forEach(([source, skills]) => {
      html += `<div class="list-section">
        <div class="list-section-title"><span class="plugin-badge">Plugin</span> ${escapeHtml(source)} <span class="list-section-count">${skills.length}</span></div>
        <div class="list-section-grid">`;
      html += skills.map(s => this._renderSkillCard(s, true)).join('');
      html += `</div></div>`;
    });

    list.innerHTML = html;

    list.querySelectorAll('.list-card').forEach(card => {
      card.querySelector('.btn-open').onclick = () => this.api.dialog.openInExplorer(card.dataset.path);
      const editBtn = card.querySelector('.btn-edit');
      if (editBtn) {
        editBtn.onclick = () => {
          const fp = card.dataset.filePath;
          if (fp) this._showEditorModal('skill', card.dataset.skillId, fp);
        };
      }
      const delBtn = card.querySelector('.btn-del');
      if (delBtn) {
        delBtn.onclick = async () => {
          const ok = await showConfirm({ title: t('skillsAgents.deleteSkill') || 'Delete skill', message: t('skillsAgents.confirmDeleteSkill'), confirmLabel: t('common.delete'), danger: true });
          if (ok) { await this.api.fs.promises.rm(card.dataset.path, { recursive: true, force: true }); this.loadSkills(); }
        };
      }
    });
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

    let html = `<div class="list-section">
      <div class="list-section-title">${t('skillsAgents.agents')} <span class="list-section-count">${this._state.agents.length}</span></div>
      <div class="list-section-grid">`;
    html += this._state.agents.map(a => {
      const desc = (a.description && a.description !== '---' && a.description !== t('common.noDescription')) ? escapeHtml(a.description) : '';
      const initial = escapeHtml((a.name || '?').charAt(0).toUpperCase());
      const filePath = a.filePath ? a.filePath.replace(/"/g, '&quot;') : '';
      const toolChips = (a.tools && a.tools.length > 0)
        ? `<div class="skill-sections agent-tools">${a.tools.slice(0, 5).map(tool => `<span class="skill-section-chip agent-tool-chip">${escapeHtml(tool)}</span>`).join('')}</div>`
        : '';
      return `
      <div class="list-card agent-card" data-path="${a.path.replace(/"/g, '&quot;')}" data-file-path="${filePath}" data-agent-id="${escapeHtml(a.id)}">
        <div class="card-initial">${initial}</div>
        <div class="list-card-header">
          <div class="list-card-title">${escapeHtml(a.name)}</div>
          <div class="list-card-badge agent">${t('skillsAgents.agent')}</div>
        </div>
        ${desc ? `<div class="list-card-desc">${desc}</div>` : ''}
        ${toolChips}
        <div class="list-card-footer">
          ${filePath ? `<button class="btn-sm btn-accent btn-edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            ${t('common.edit')}
          </button>` : ''}
          <button class="btn-sm btn-secondary btn-open">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            ${t('marketplace.openFolder')}
          </button>
          <button class="btn-sm btn-delete btn-del" title="${t('common.delete')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');
    html += `</div></div>`;

    list.innerHTML = html;

    list.querySelectorAll('.list-card').forEach(card => {
      card.querySelector('.btn-open').onclick = () => this.api.dialog.openInExplorer(card.dataset.path);
      const editBtn = card.querySelector('.btn-edit');
      if (editBtn) {
        editBtn.onclick = () => {
          const fp = card.dataset.filePath;
          if (fp) this._showEditorModal('agent', card.dataset.agentId, fp);
        };
      }
      card.querySelector('.btn-del').onclick = async () => {
        const ok = await showConfirm({ title: t('skillsAgents.deleteAgent') || 'Delete agent', message: t('skillsAgents.confirmDeleteAgent'), confirmLabel: t('common.delete'), danger: true });
        if (ok) { await this.api.fs.promises.rm(card.dataset.path, { recursive: true, force: true }); this.loadAgents(); }
      };
    });
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
            this.api.dialog.openInEditor({ editor: this._getSetting('editor') || 'code', path: filePath });
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
