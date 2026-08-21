/**
 * MemoryEditor Panel
 * CLAUDE.md editor with templates, markdown preview, and search
 * Supports: global CLAUDE.md, rules.md, settings, commands,
 *           per-project CLAUDE.md (repo), private CLAUDE.md, auto-memory folder
 */

const { BasePanel } = require('../../core/BasePanel');
const { escapeHtml } = require('../../utils');
const { t } = require('../../i18n');
const { projectsState } = require('../../state');
const { fileExists, fsp } = require('../../utils/fs-async');

// ── Path encoding (mirrors claude.ipc.js) ──

function encodeProjectPath(projectPath) {
  const MAX_LEN = 200;
  const encoded = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (encoded.length <= MAX_LEN) return encoded;
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = ((hash << 5) - hash + projectPath.charCodeAt(i)) | 0;
  }
  return `${encoded.slice(0, MAX_LEN)}-${Math.abs(hash).toString(36)}`;
}

// ── Module-level constants ──

const MEMORY_TEMPLATES = {
  minimal: {
    nameKey: 'memory.templates.minimal',
    icon: '\u{1F4DD}',
    content: `# {PROJECT_NAME}

## Description
Decrivez votre projet ici.

## Instructions
- Preferez TypeScript a JavaScript
- Utilisez des noms de variables explicites
`
  },
  fullstack: {
    nameKey: 'memory.templates.fullstack',
    icon: '\u{1F680}',
    content: `# {PROJECT_NAME}

## Architecture
- Frontend: React/Vue/Svelte
- Backend: Node.js/Express
- Database: PostgreSQL/MongoDB

## Conventions de code
- Utilisez ESLint et Prettier
- Commits en francais avec emojis
- Tests unitaires obligatoires

## Structure des dossiers
\`\`\`
src/
  components/   # Composants UI
  services/     # Logique metier
  utils/        # Fonctions utilitaires
  types/        # Types TypeScript
\`\`\`

## Commandes utiles
\`\`\`bash
npm run dev     # Developpement
npm run build   # Production
npm run test    # Tests
\`\`\`
`
  },
  fivem: {
    nameKey: 'memory.templates.fivem',
    icon: '\u{1F3AE}',
    content: `# {PROJECT_NAME}

## Type de Resource
Resource FiveM (client/server/shared)

## Framework
- ESX / QBCore / Standalone

## Structure
\`\`\`
client/     # Code client (NUI, events)
server/     # Code serveur (database, callbacks)
shared/     # Code partage (config, utils)
html/       # Interface NUI (HTML/CSS/JS)
\`\`\`

## Conventions FiveM
- Prefixer les events: \`{resource}:{event}\`
- Utiliser les callbacks pour les requetes serveur
- Optimiser les threads (pas de Wait(0) sans raison)
- Nettoyer les entities au stop de la resource

## Database
- Utiliser oxmysql pour les requetes async
- Preparer les statements pour eviter les injections
`
  },
  api: {
    nameKey: 'memory.templates.api',
    icon: '\u{1F50C}',
    content: `# {PROJECT_NAME}

## Type
API REST

## Endpoints
Document your endpoints here:
- \`GET /api/v1/...\`
- \`POST /api/v1/...\`

## Authentication
- JWT / API Keys / OAuth2

## Conventions
- Versionning des endpoints (/v1/, /v2/)
- Reponses JSON standardisees
- Gestion des erreurs coherente
- Rate limiting

## Documentation
Generer la doc Swagger/OpenAPI
`
  },
  library: {
    nameKey: 'memory.templates.library',
    icon: '\u{1F4E6}',
    content: `# {PROJECT_NAME}

## Type
Package NPM / Librairie

## Installation
\`\`\`bash
npm install {PROJECT_NAME}
\`\`\`

## API publique
Documentez les fonctions exportees ici.

## Conventions
- Exports nommes preferes aux exports default
- Types TypeScript inclus
- Tests avec couverture > 80%
- Changelog maintenu
- Semver respecte
`
  }
};

// ── Module-level pure functions ──

function parseMarkdownToHtml(md) {
  const { Marked } = require('marked');
  const DOMPurify = require('dompurify');

  // Use a separate Marked instance to avoid polluting the global singleton
  // (which is configured by the chat markdown renderer with custom block renderers)
  const memoryMarked = new Marked();

  const renderer = {
    code({ text, lang }) {
      return `<pre class="code-block"><code class="lang-${lang || ''}">${text}</code></pre>`;
    },
    codespan({ text }) {
      return `<code class="inline-code">${text}</code>`;
    },
    link({ href, text }) {
      return `<a href="${href}" class="memory-link">${text}</a>`;
    },
    table({ header, rows }) {
      const headerHtml = header.map(h => `<th>${h.text}</th>`).join('');
      const rowsHtml = rows.map(row => `<tr>${row.map(cell => `<td>${cell.text}</td>`).join('')}</tr>`).join('');
      return `<table class="memory-table"><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table>`;
    },
    listitem({ text }) {
      return `<li>${text}</li>\n`;
    }
  };

  memoryMarked.use({ renderer, gfm: true, breaks: false });
  const rawHtml = memoryMarked.parse(md);
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: ['h1','h2','h3','h4','h5','h6','p','br','strong','em','code','pre',
                   'ul','ol','li','a','table','thead','tbody','tr','th','td','mark',
                   'blockquote','hr','span','div'],
    ALLOWED_ATTR: ['href', 'class'],
    ALLOW_DATA_ATTR: false
  });
}

function calculateMemoryStats(content, source) {
  if (source === 'settings' || source === 'commands') {
    try {
      const json = JSON.parse(content);
      const keys = Object.keys(json).length;
      return `<span class="memory-stat"><span class="stat-value">${keys}</span> ${t('memory.keys')}</span>`;
    } catch {
      return '';
    }
  }

  const lines = content.split('\n').length;
  const words = content.split(/\s+/).filter(w => w.length > 0).length;
  const sections = (content.match(/^##\s/gm) || []).length;
  const codeBlocks = (content.match(/```/g) || []).length / 2;

  let html = `
    <span class="memory-stat"><span class="stat-value">${lines}</span> ${t('memory.lines')}</span>
    <span class="memory-stat"><span class="stat-value">${words}</span> ${t('memory.words')}</span>
  `;

  if (sections > 0) {
    html += `<span class="memory-stat"><span class="stat-value">${sections}</span> ${t('memory.sections')}</span>`;
  }
  if (codeBlocks > 0) {
    html += `<span class="memory-stat"><span class="stat-value">${Math.floor(codeBlocks)}</span> ${t('memory.codeBlocks')}</span>`;
  }

  return html;
}

// ── MemoryEditor class ──

class MemoryEditor extends BasePanel {
  constructor(el, options = {}) {
    super(el, options);
    this._showModal = options.showModal || null;
    this._closeModal = options.closeModal || null;
    this._showToast = options.showToast || null;
    this._state = {
      currentSource: 'global',
      currentProject: null,
      currentMemoryFile: null,
      content: '',
      isEditing: false,
      listenersAttached: false,
      fileExists: false,
      searchQuery: '',
      expandedProjects: new Set(),
      knowledge: { enabled: true, entries: [], currentEntryId: null, editing: false, draft: null }
    };
  }

  // ── Path helpers ──

  _getClaudeDir() {
    return this.api.path.join(this.api.os.homedir(), '.claude');
  }

  _getGlobalClaudeMd() {
    return this.api.path.join(this._getClaudeDir(), 'CLAUDE.md');
  }

  _getRulesMd() {
    return this.api.path.join(this._getClaudeDir(), 'rules.md');
  }

  _getClaudeSettingsJson() {
    return this.api.path.join(this._getClaudeDir(), 'settings.json');
  }

  _getProjectEncodedDir(projectPath) {
    return this.api.path.join(this._getClaudeDir(), 'projects', encodeProjectPath(projectPath));
  }

  _getProjectPrivateClaudeMd(projectPath) {
    return this.api.path.join(this._getProjectEncodedDir(projectPath), 'CLAUDE.md');
  }

  _getProjectMemoryDir(projectPath) {
    return this.api.path.join(this._getProjectEncodedDir(projectPath), 'memory');
  }

  // ── Public entry points ──

  async loadMemory() {
    await this._loadKnowledgeIndex();
    await this.renderMemorySources();
    await this.loadMemoryContent('global');
    this.setupMemoryEventListeners();
    this.initMemorySidebarResizer();
  }

  // ── Sidebar resizer ──

  initMemorySidebarResizer() {
    const resizer = document.getElementById('memory-sidebar-resizer');
    const panel = document.querySelector('.memory-sidebar');
    if (!resizer || !panel) return;

    let startX, startWidth;

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startWidth = panel.offsetWidth;
      resizer.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMouseMove = (ev) => {
        const newWidth = Math.min(500, Math.max(150, startWidth + (ev.clientX - startX)));
        panel.style.width = newWidth + 'px';
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        resizer.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        const { settingsState, saveSettingsImmediate } = require('../../state/settings.state');
        settingsState.setProp('memorySidebarWidth', panel.offsetWidth);
        saveSettingsImmediate();
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // ── Source list rendering ──

  async renderMemorySources(filter = '') {
    const projectsList = document.getElementById('memory-projects-list');
    const projects = projectsState.get().projects;
    const searchQuery = filter.toLowerCase();

    // Update active states for global items ("knowledge-entry" keeps its parent lit)
    const activeSource = this._state.currentSource === 'knowledge-entry' ? 'knowledge' : this._state.currentSource;
    document.querySelectorAll('#memory-sources-list > .memory-source-item').forEach(item => {
      const source = item.dataset.source;
      item.classList.toggle('active', source === activeSource && this._state.currentProject === null);
    });

    const countBadge = document.getElementById('knowledge-count');
    if (countBadge) {
      const count = this._state.knowledge.entries.length;
      countBadge.textContent = String(count);
      countBadge.style.display = count > 0 ? '' : 'none';
      countBadge.classList.toggle('disabled', !this._state.knowledge.enabled);
    }

    if (projects.length === 0) {
      projectsList.innerHTML = `<div class="memory-no-projects">${t('memory.noProjects')}</div>`;
      return;
    }

    const filteredProjects = projects.map((p, i) => ({ ...p, index: i }))
      .filter(p => !searchQuery || p.name.toLowerCase().includes(searchQuery));

    if (filteredProjects.length === 0) {
      projectsList.innerHTML = `<div class="memory-no-projects">${t('memory.noResults', { query: escapeHtml(filter) })}</div>`;
      return;
    }

    const htmlParts = [];
    for (const p of filteredProjects) {
      const claudeMdPath = this.api.path.join(p.path, 'CLAUDE.md');
      const hasClaudeMd = await fileExists(claudeMdPath);

      const privateClaudeMdPath = this._getProjectPrivateClaudeMd(p.path);
      const hasPrivateClaudeMd = await fileExists(privateClaudeMdPath);

      const memoryDir = this._getProjectMemoryDir(p.path);
      let memoryFiles = [];
      try {
        if (await fileExists(memoryDir)) {
          memoryFiles = (await fsp.readdir(memoryDir)).filter(f => f.endsWith('.md'));
        }
      } catch { /* ignore */ }
      const hasMemory = memoryFiles.length > 0;

      const isExpanded = this._state.expandedProjects.has(p.index);
      const isProjectActive = this._state.currentProject === p.index;

      // Build children
      let childrenHtml = '';
      if (isExpanded) {
        // CLAUDE.md (repo)
        const claudeActive = isProjectActive && this._state.currentSource === 'project' ? 'active' : '';
        childrenHtml += `
          <div class="memory-source-item memory-child-item ${claudeActive}" data-source="project" data-project="${p.index}">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
            <span>CLAUDE.md</span>
            ${hasClaudeMd ? '' : '<span class="memory-child-missing">--</span>'}
          </div>
        `;

        // Private CLAUDE.md
        const privateActive = isProjectActive && this._state.currentSource === 'project-private' ? 'active' : '';
        childrenHtml += `
          <div class="memory-source-item memory-child-item ${privateActive}" data-source="project-private" data-project="${p.index}">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
            <span>${t('memory.privateInstructions')}</span>
            ${hasPrivateClaudeMd ? '' : '<span class="memory-child-missing">--</span>'}
          </div>
        `;

        // Auto Memory folder
        const memoryActive = isProjectActive && (this._state.currentSource === 'project-memory' || this._state.currentSource === 'project-memory-file') ? 'active' : '';
        childrenHtml += `
          <div class="memory-source-item memory-child-item ${memoryActive}" data-source="project-memory" data-project="${p.index}">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6 10H6v-2h8v2zm4-4H6v-2h12v2z"/></svg>
            <span>${t('memory.autoMemory')}</span>
            ${hasMemory ? `<span class="memory-badge memory">${memoryFiles.length}</span>` : '<span class="memory-child-missing">--</span>'}
          </div>
        `;
      }

      htmlParts.push(`
        <div class="memory-project-group ${isExpanded ? 'expanded' : ''}">
          <div class="memory-project-header" data-project="${p.index}">
            <svg class="memory-chevron" viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>
            <span>${escapeHtml(p.name)}</span>
            <div class="memory-source-badges">
              ${hasClaudeMd ? '<span class="memory-badge" title="CLAUDE.md">MD</span>' : ''}
              ${hasPrivateClaudeMd ? '<span class="memory-badge private" title="Private">PV</span>' : ''}
              ${hasMemory ? '<span class="memory-badge memory" title="Memory">' + memoryFiles.length + '</span>' : ''}
            </div>
          </div>
          <div class="memory-project-children">
            ${childrenHtml}
          </div>
        </div>
      `);
    }
    projectsList.innerHTML = htmlParts.join('');
  }

  // ── Content loading ──

  async loadMemoryContent(source, projectIndex = null) {
    this._state.currentSource = source;
    this._state.currentProject = projectIndex;
    this._state.isEditing = false;

    // Global knowledge lives outside the CLAUDE.md file model: it owns its own
    // toolbar and editor inside the content area.
    if (source === 'knowledge' || source === 'knowledge-entry') {
      await this._loadKnowledgeView(source);
      await this.renderMemorySources(this._state.searchQuery);
      return;
    }

    // Reset memory file if switching away from memory-file
    if (source !== 'project-memory-file') {
      this._state.currentMemoryFile = null;
    }

    const titleEl = document.getElementById('memory-title');
    const pathEl = document.getElementById('memory-path');
    const contentEl = document.getElementById('memory-content');
    const statsEl = document.getElementById('memory-stats');
    const editBtn = document.getElementById('btn-memory-edit');
    const createBtn = document.getElementById('btn-memory-create');
    const templateBtn = document.getElementById('btn-memory-template');

    let filePath = '';
    let title = '';
    let content = '';
    let fileFound = false;

    try {
      if (source === 'global') {
        filePath = this._getGlobalClaudeMd();
        title = t('memory.globalMemory');
        fileFound = await fileExists(filePath);
        if (fileFound) content = await fsp.readFile(filePath, 'utf8');

      } else if (source === 'rules') {
        filePath = this._getRulesMd();
        title = t('memory.globalRules');
        fileFound = await fileExists(filePath);
        if (fileFound) content = await fsp.readFile(filePath, 'utf8');

      } else if (source === 'settings') {
        filePath = this._getClaudeSettingsJson();
        title = t('memory.claudeSettings');
        fileFound = await fileExists(filePath);
        if (fileFound) {
          const jsonContent = JSON.parse(await fsp.readFile(filePath, 'utf8'));
          content = JSON.stringify(jsonContent, null, 2);
        } else {
          content = '{}';
        }

      } else if (source === 'commands') {
        filePath = this._getClaudeSettingsJson();
        title = t('memory.allowedCommands');
        fileFound = await fileExists(filePath);
        if (fileFound) {
          const jsonContent = JSON.parse(await fsp.readFile(filePath, 'utf8'));
          content = JSON.stringify(jsonContent.allowedCommands || jsonContent.permissions || {}, null, 2);
        } else {
          content = '{}';
        }

      } else if (source === 'project' && projectIndex !== null) {
        const project = projectsState.get().projects[projectIndex];
        if (project) {
          filePath = this.api.path.join(project.path, 'CLAUDE.md');
          title = `${project.name} \u2014 CLAUDE.md`;
          fileFound = await fileExists(filePath);
          if (fileFound) content = await fsp.readFile(filePath, 'utf8');
        }

      } else if (source === 'project-private' && projectIndex !== null) {
        const project = projectsState.get().projects[projectIndex];
        if (project) {
          filePath = this._getProjectPrivateClaudeMd(project.path);
          title = `${project.name} \u2014 ${t('memory.privateInstructions')}`;
          fileFound = await fileExists(filePath);
          if (fileFound) content = await fsp.readFile(filePath, 'utf8');
        }

      } else if (source === 'project-memory' && projectIndex !== null) {
        const project = projectsState.get().projects[projectIndex];
        if (project) {
          filePath = this._getProjectMemoryDir(project.path);
          title = `${project.name} \u2014 ${t('memory.autoMemory')}`;
          fileFound = await fileExists(filePath);
          // Content handled specially in renderMemoryContent
        }

      } else if (source === 'project-memory-file' && projectIndex !== null) {
        const project = projectsState.get().projects[projectIndex];
        if (project && this._state.currentMemoryFile) {
          filePath = this.api.path.join(this._getProjectMemoryDir(project.path), this._state.currentMemoryFile);
          title = `${project.name} \u2014 ${this._state.currentMemoryFile}`;
          fileFound = await fileExists(filePath);
          if (fileFound) content = await fsp.readFile(filePath, 'utf8');
        }
      }
    } catch (e) {
      content = t('memory.errorLoading', { message: e.message });
    }

    this._state.content = content;
    this._state.fileExists = fileFound;

    titleEl.textContent = title;
    pathEl.textContent = filePath.replace(this.api.os.homedir(), '~');

    // Show/hide buttons based on context
    const isMarkdownSource = ['global', 'rules', 'project', 'project-private', 'project-memory-file'].includes(source);
    editBtn.style.display = (isMarkdownSource && fileFound) ? 'flex' : 'none';
    createBtn.style.display = (isMarkdownSource && !fileFound) ? 'flex' : 'none';
    templateBtn.style.display = (isMarkdownSource && this._state.isEditing) ? 'flex' : 'none';

    if (isMarkdownSource) {
      editBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg> ${t('memory.edit')}`;
    }

    // Render stats
    if (fileFound && content && source !== 'project-memory') {
      const stats = calculateMemoryStats(content, source);
      statsEl.innerHTML = stats;
      statsEl.style.display = 'flex';
    } else {
      statsEl.style.display = 'none';
    }

    await this.renderMemoryContent(content, source, fileFound);
    await this.renderMemorySources(this._state.searchQuery);
  }

  // ── Content rendering ──

  async renderMemoryContent(content, source, fileExists = true) {
    const contentEl = document.getElementById('memory-content');

    // Memory folder → show file grid
    if (source === 'project-memory') {
      await this._renderMemoryFileGrid(contentEl, fileExists);
      return;
    }

    if (!fileExists) {
      const isProject = source === 'project';
      const isPrivate = source === 'project-private';
      const isRules = source === 'rules';
      const isMemoryFile = source === 'project-memory-file';

      let emptyTitle = t('memory.noClaudeMd');
      let emptyHint = '';
      let showTemplates = true;

      if (isRules) {
        emptyTitle = t('memory.noRulesMd');
        emptyHint = t('memory.rulesHint');
        showTemplates = false;
      } else if (isPrivate) {
        emptyTitle = t('memory.noPrivateClaudeMd');
        const projectName = (this._state.currentProject !== null
          ? projectsState.get().projects[this._state.currentProject]?.name
          : null) || t('memory.defaultProjectName');
        emptyHint = t('memory.createPrivate', { name: escapeHtml(projectName) });
      } else if (isMemoryFile) {
        emptyTitle = t('memory.noMemoryFiles');
        showTemplates = false;
      } else {
        const projectName = isProject && this._state.currentProject !== null
          ? projectsState.get().projects[this._state.currentProject]?.name || t('memory.defaultProjectName')
          : t('memory.globalSection');
        emptyHint = t('memory.createHint', { name: escapeHtml(projectName) });
      }

      contentEl.innerHTML = `
        <div class="memory-empty-state">
          <div class="memory-empty-icon">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
          </div>
          <h3>${emptyTitle}</h3>
          <p>${emptyHint}</p>
          ${showTemplates ? `
          <div class="memory-empty-templates">
            <p class="template-hint">${t('memory.chooseTemplate')}</p>
            <div class="template-grid">
              ${Object.entries(MEMORY_TEMPLATES).map(([key, tpl]) => `
                <button class="template-card" data-template="${key}">
                  <span class="template-icon">${tpl.icon}</span>
                  <span class="template-name">${escapeHtml(t(tpl.nameKey))}</span>
                </button>
              `).join('')}
            </div>
          </div>
          ` : `
          <button class="btn-primary btn-create" id="btn-empty-create">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            <span>${isRules ? t('memory.createRules') : t('memory.edit')}</span>
          </button>
          `}
        </div>
      `;

      contentEl.querySelectorAll('.template-card').forEach(card => {
        card.onclick = async () => await this.createMemoryFromTemplate(card.dataset.template);
      });

      const emptyCreateBtn = contentEl.querySelector('#btn-empty-create');
      if (emptyCreateBtn) {
        emptyCreateBtn.onclick = async () => {
          if (isRules) {
            await this._createEmptyFile(this._getRulesMd(), `# Rules\n\n## Code\n- Write clean, readable code\n`);
          }
          await this.loadMemoryContent(this._state.currentSource, this._state.currentProject);
        };
      }

      return;
    }

    if (source === 'settings' || source === 'commands') {
      contentEl.innerHTML = `<pre class="memory-json">${escapeHtml(content)}</pre>`;
      return;
    }

    // Parse markdown and render with search highlighting
    let html = parseMarkdownToHtml(content);

    if (this._state.searchQuery) {
      const regex = new RegExp(`(${escapeHtml(this._state.searchQuery)})`, 'gi');
      html = html.replace(regex, '<mark class="search-highlight">$1</mark>');
    }

    // Add back button for memory file view
    let backBtn = '';
    if (source === 'project-memory-file') {
      backBtn = `
        <button class="memory-back-btn" id="btn-memory-back">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          ${t('memory.backToMemory')}
        </button>
      `;
    }

    contentEl.innerHTML = `${backBtn}<div class="memory-markdown">${html}</div>`;

    if (source === 'project-memory-file') {
      const backBtnEl = document.getElementById('btn-memory-back');
      if (backBtnEl) {
        backBtnEl.onclick = () => {
          this.loadMemoryContent('project-memory', this._state.currentProject);
        };
      }
    }
  }

  // ── Memory file grid rendering ──

  async _renderMemoryFileGrid(contentEl, dirExists) {
    if (!dirExists) {
      contentEl.innerHTML = `
        <div class="memory-empty-state">
          <div class="memory-empty-icon">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>
          </div>
          <h3>${t('memory.noMemoryFiles')}</h3>
          <p>${t('memory.autoMemory')}</p>
        </div>
      `;
      return;
    }

    const project = projectsState.get().projects[this._state.currentProject];
    if (!project) return;

    const memoryDir = this._getProjectMemoryDir(project.path);
    let files = [];
    try {
      files = (await fsp.readdir(memoryDir)).filter(f => f.endsWith('.md'));
    } catch { /* ignore */ }

    if (files.length === 0) {
      contentEl.innerHTML = `
        <div class="memory-empty-state">
          <div class="memory-empty-icon">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>
          </div>
          <h3>${t('memory.noMemoryFiles')}</h3>
        </div>
      `;
      return;
    }

    // Get file stats
    const fileInfos = [];
    for (const f of files) {
      const fp = this.api.path.join(memoryDir, f);
      try {
        const stat = await fsp.stat(fp);
        const content = await fsp.readFile(fp, 'utf8');
        const lines = content.split('\n').length;
        const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('#')) || '';
        fileInfos.push({ name: f, lines, size: stat.size, modified: stat.mtime, preview: firstLine.trim().slice(0, 80) });
      } catch {
        fileInfos.push({ name: f, lines: 0, size: 0, modified: new Date(), preview: '' });
      }
    }
    fileInfos.sort((a, b) => {
      // MEMORY.md first, then alphabetical
      if (a.name === 'MEMORY.md') return -1;
      if (b.name === 'MEMORY.md') return 1;
      return a.name.localeCompare(b.name);
    });

    contentEl.innerHTML = `
      <div class="memory-file-grid">
        ${fileInfos.map(f => `
          <div class="memory-file-card" data-file="${escapeHtml(f.name)}">
            <div class="memory-file-card-icon">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
            </div>
            <div class="memory-file-card-info">
              <span class="memory-file-name">${escapeHtml(f.name)}</span>
              <span class="memory-file-meta">${f.lines} ${t('memory.lines')}</span>
              ${f.preview ? `<span class="memory-file-preview">${escapeHtml(f.preview)}</span>` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `;

    contentEl.querySelectorAll('.memory-file-card').forEach(card => {
      card.onclick = () => {
        this._state.currentMemoryFile = card.dataset.file;
        this.loadMemoryContent('project-memory-file', this._state.currentProject);
      };
    });
  }

  // ── Global knowledge ──

  async _loadKnowledgeIndex() {
    try {
      const res = await this.api.knowledge.list();
      if (res && res.success) {
        this._state.knowledge.enabled = res.enabled !== false;
        this._state.knowledge.entries = res.entries || [];
      }
    } catch (e) {
      console.error('[MemoryEditor] knowledge list failed:', e);
    }
  }

  _findKnowledgeEntry(id) {
    return this._state.knowledge.entries.find(e => e.id === id) || null;
  }

  /** Prepare the header chrome, then render either the grid or a single entry. */
  async _loadKnowledgeView(source) {
    await this._loadKnowledgeIndex();

    const kn = this._state.knowledge;
    const entry = source === 'knowledge-entry' ? this._findKnowledgeEntry(kn.currentEntryId) : null;

    document.getElementById('memory-title').textContent = entry
      ? `${t('knowledge.title')} — ${entry.title}`
      : t('knowledge.title');
    document.getElementById('memory-path').textContent = '~/.claude-terminal/knowledge';

    // The generic CLAUDE.md toolbar does not apply here.
    document.getElementById('memory-stats').style.display = 'none';
    document.getElementById('btn-memory-edit').style.display = 'none';
    document.getElementById('btn-memory-create').style.display = 'none';
    document.getElementById('btn-memory-template').style.display = 'none';

    const contentEl = document.getElementById('memory-content');
    if (source === 'knowledge-entry' && (entry || kn.editing)) {
      await this._renderKnowledgeEntry(contentEl, entry);
    } else {
      kn.currentEntryId = null;
      kn.editing = false;
      this._state.currentSource = 'knowledge';
      this._renderKnowledgeGrid(contentEl);
    }
  }

  _renderKnowledgeGrid(contentEl) {
    const kn = this._state.knowledge;
    const query = this._state.searchQuery.toLowerCase();
    const entries = query
      ? kn.entries.filter(e =>
          (e.title || '').toLowerCase().includes(query) ||
          (e.summary || '').toLowerCase().includes(query) ||
          (e.aliases || []).some(a => a.toLowerCase().includes(query)) ||
          (e.tags || []).some(tag => tag.toLowerCase().includes(query)))
      : kn.entries;

    const cards = entries.map(e => {
      const aliases = (e.aliases || []).length
        ? `<span class="knowledge-card-aliases">${t('knowledge.aliasesLabel')}: ${escapeHtml(e.aliases.join(', '))}</span>`
        : '';
      const tags = (e.tags || []).map(tag => `<span class="knowledge-tag">${escapeHtml(tag)}</span>`).join('');
      return `
        <div class="knowledge-card ${e.pinned ? 'pinned' : ''}" data-id="${escapeHtml(e.id)}">
          <div class="knowledge-card-head">
            <span class="knowledge-card-title">${escapeHtml(e.title)}</span>
            <button class="knowledge-pin-btn ${e.pinned ? 'on' : ''}" data-pin="${escapeHtml(e.id)}"
                    title="${e.pinned ? t('knowledge.unpin') : t('knowledge.pin')}">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
            </button>
          </div>
          <span class="knowledge-card-cat">${escapeHtml(t(`knowledge.categories.${e.category || 'other'}`))}</span>
          ${e.summary ? `<p class="knowledge-card-summary">${escapeHtml(e.summary)}</p>` : ''}
          ${aliases}
          ${tags ? `<div class="knowledge-card-tags">${tags}</div>` : ''}
        </div>
      `;
    }).join('');

    contentEl.innerHTML = `
      <div class="knowledge-view">
        <div class="knowledge-toolbar">
          <label class="knowledge-toggle">
            <input type="checkbox" id="knowledge-enabled" ${kn.enabled ? 'checked' : ''}>
            <span>${t('knowledge.injectToggle')}</span>
          </label>
          <div class="knowledge-toolbar-actions">
            <button class="btn-secondary" id="btn-knowledge-preview">${t('knowledge.preview')}</button>
            <button class="btn-primary" id="btn-knowledge-new">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
              <span>${t('knowledge.newEntry')}</span>
            </button>
          </div>
        </div>
        <p class="knowledge-hint">${t('knowledge.injectHint')}</p>
        ${entries.length
          ? `<div class="knowledge-grid">${cards}</div>`
          : `<div class="memory-empty-state">
               <div class="memory-empty-icon">
                 <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3L1 9l11 6 9-4.91V17h2V9L12 3zM5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82z"/></svg>
               </div>
               <h3>${t('knowledge.empty')}</h3>
               <p>${t('knowledge.emptyHint')}</p>
             </div>`}
      </div>
    `;

    const enabledEl = contentEl.querySelector('#knowledge-enabled');
    if (enabledEl) {
      enabledEl.onchange = async () => {
        try {
          await this.api.knowledge.setEnabled(enabledEl.checked);
          this._state.knowledge.enabled = enabledEl.checked;
          await this.renderMemorySources(this._state.searchQuery);
        } catch (e) {
          if (this._showToast) this._showToast({ type: 'error', title: e.message });
        }
      };
    }

    const newBtn = contentEl.querySelector('#btn-knowledge-new');
    if (newBtn) {
      newBtn.onclick = () => {
        this._state.knowledge.currentEntryId = null;
        this._state.knowledge.editing = true;
        this._state.knowledge.draft = null;
        this.loadMemoryContent('knowledge-entry');
      };
    }

    const previewBtn = contentEl.querySelector('#btn-knowledge-preview');
    if (previewBtn) previewBtn.onclick = () => this._showKnowledgePreview();

    contentEl.querySelectorAll('.knowledge-pin-btn').forEach(btn => {
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        const id = btn.dataset.pin;
        const entry = this._findKnowledgeEntry(id);
        if (!entry) return;
        try {
          await this.api.knowledge.setPinned(id, !entry.pinned);
          await this.loadMemoryContent('knowledge');
        } catch (e) {
          if (this._showToast) this._showToast({ type: 'error', title: e.message });
        }
      };
    });

    contentEl.querySelectorAll('.knowledge-card').forEach(card => {
      card.onclick = () => {
        this._state.knowledge.currentEntryId = card.dataset.id;
        this._state.knowledge.editing = false;
        this.loadMemoryContent('knowledge-entry');
      };
    });
  }

  async _renderKnowledgeEntry(contentEl, entry) {
    const kn = this._state.knowledge;
    const backBtn = `
      <button class="memory-back-btn" id="btn-knowledge-back">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
        ${t('knowledge.back')}
      </button>
    `;

    if (kn.editing) {
      const draft = kn.draft || entry || {};
      const categories = ['server', 'service', 'person', 'convention', 'stack', 'other'];
      let body = draft.content;
      if (body === undefined && entry) {
        const res = await this.api.knowledge.get(entry.id);
        body = res && res.success ? res.entry.content : '';
      }

      contentEl.innerHTML = `
        <div class="knowledge-view">
          ${backBtn}
          <div class="knowledge-form">
            <div class="knowledge-form-row">
              <label>${t('knowledge.fields.title')}</label>
              <input type="text" id="kn-title" value="${escapeHtml(draft.title || '')}"
                     placeholder="${escapeHtml(t('knowledge.placeholders.title'))}">
            </div>
            <div class="knowledge-form-row">
              <label>${t('knowledge.fields.summary')}</label>
              <input type="text" id="kn-summary" value="${escapeHtml(draft.summary || '')}"
                     placeholder="${escapeHtml(t('knowledge.placeholders.summary'))}">
            </div>
            <div class="knowledge-form-grid">
              <div class="knowledge-form-row">
                <label>${t('knowledge.fields.category')}</label>
                <select id="kn-category">
                  ${categories.map(c => `<option value="${c}" ${(draft.category || 'other') === c ? 'selected' : ''}>${escapeHtml(t(`knowledge.categories.${c}`))}</option>`).join('')}
                </select>
              </div>
              <div class="knowledge-form-row">
                <label>${t('knowledge.fields.aliases')}</label>
                <input type="text" id="kn-aliases" value="${escapeHtml((draft.aliases || []).join(', '))}"
                       placeholder="${escapeHtml(t('knowledge.placeholders.aliases'))}">
              </div>
              <div class="knowledge-form-row">
                <label>${t('knowledge.fields.tags')}</label>
                <input type="text" id="kn-tags" value="${escapeHtml((draft.tags || []).join(', '))}"
                       placeholder="${escapeHtml(t('knowledge.placeholders.tags'))}">
              </div>
            </div>
            <label class="knowledge-toggle knowledge-pin-toggle">
              <input type="checkbox" id="kn-pinned" ${draft.pinned ? 'checked' : ''}>
              <span>${t('knowledge.pinnedLabel')}</span>
            </label>
            <p class="knowledge-hint">${t('knowledge.pinnedHint')}</p>
            <textarea class="memory-editor knowledge-body" id="kn-content"
                      placeholder="${escapeHtml(t('knowledge.placeholders.content'))}">${escapeHtml(body || '')}</textarea>
            <div class="knowledge-form-actions">
              <button class="btn-secondary" id="btn-kn-cancel">${t('common.cancel')}</button>
              <button class="btn-primary" id="btn-kn-save">${t('knowledge.save')}</button>
            </div>
          </div>
        </div>
      `;

      contentEl.querySelector('#btn-kn-cancel').onclick = () => {
        kn.editing = false;
        kn.draft = null;
        this.loadMemoryContent(entry ? 'knowledge-entry' : 'knowledge');
      };
      contentEl.querySelector('#btn-kn-save').onclick = () => this._saveKnowledgeEntry(entry);
      contentEl.querySelector('#btn-knowledge-back').onclick = () => {
        kn.editing = false;
        kn.draft = null;
        this.loadMemoryContent('knowledge');
      };
      return;
    }

    if (!entry) {
      this.loadMemoryContent('knowledge');
      return;
    }

    const res = await this.api.knowledge.get(entry.id);
    const content = res && res.success ? res.entry.content : '';
    const chips = [
      `<span class="knowledge-chip">${escapeHtml(t(`knowledge.categories.${entry.category || 'other'}`))}</span>`,
      entry.pinned ? `<span class="knowledge-chip pinned">${t('knowledge.pinned')}</span>` : '',
      ...(entry.aliases || []).map(a => `<span class="knowledge-chip alias">${escapeHtml(a)}</span>`),
      ...(entry.tags || []).map(tag => `<span class="knowledge-tag">${escapeHtml(tag)}</span>`)
    ].filter(Boolean).join('');

    contentEl.innerHTML = `
      <div class="knowledge-view">
        ${backBtn}
        <div class="knowledge-entry-header">
          <h3>${escapeHtml(entry.title)}</h3>
          <div class="knowledge-entry-actions">
            <button class="btn-secondary btn-danger-outline" id="btn-kn-delete">${t('knowledge.delete')}</button>
            <button class="btn-primary" id="btn-kn-edit">${t('common.edit')}</button>
          </div>
        </div>
        ${entry.summary ? `<p class="knowledge-entry-summary">${escapeHtml(entry.summary)}</p>` : ''}
        <div class="knowledge-chips">${chips}</div>
        <div class="memory-markdown">${parseMarkdownToHtml(content)}</div>
      </div>
    `;

    contentEl.querySelector('#btn-knowledge-back').onclick = () => this.loadMemoryContent('knowledge');
    contentEl.querySelector('#btn-kn-edit').onclick = () => {
      kn.editing = true;
      kn.draft = { ...entry, content };
      this.loadMemoryContent('knowledge-entry');
    };
    contentEl.querySelector('#btn-kn-delete').onclick = () => this._confirmKnowledgeDelete(entry);
  }

  async _saveKnowledgeEntry(entry) {
    const value = (id) => {
      const el = document.getElementById(id);
      return el ? el.value : '';
    };
    const title = value('kn-title').trim();
    if (!title) {
      if (this._showToast) this._showToast({ type: 'error', title: t('knowledge.titleRequired') });
      return;
    }

    const params = {
      id: entry ? entry.id : undefined,
      title,
      summary: value('kn-summary'),
      category: value('kn-category'),
      aliases: value('kn-aliases'),
      tags: value('kn-tags'),
      pinned: !!document.getElementById('kn-pinned')?.checked,
      content: value('kn-content')
    };

    try {
      const res = await this.api.knowledge.write(params);
      if (!res || !res.success) throw new Error((res && res.error) || 'unknown error');
      this._state.knowledge.editing = false;
      this._state.knowledge.draft = null;
      this._state.knowledge.currentEntryId = res.entry.id;
      await this.loadMemoryContent('knowledge-entry');
      if (this._showToast) this._showToast({ type: 'success', title: t('knowledge.saved') });
    } catch (e) {
      if (this._showToast) this._showToast({ type: 'error', title: t('knowledge.errorSaving', { message: e.message }) });
    }
  }

  _confirmKnowledgeDelete(entry) {
    if (!this._showModal) return;
    this._showModal(t('knowledge.delete'), `
      <p style="margin-bottom:16px;color:var(--text-secondary)">
        ${t('knowledge.deleteConfirm', { name: escapeHtml(entry.title) })}
      </p>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn-secondary" id="kn-del-cancel">${t('common.cancel')}</button>
        <button class="btn-primary btn-danger" id="kn-del-confirm">${t('knowledge.delete')}</button>
      </div>
    `);

    const cancel = document.getElementById('kn-del-cancel');
    const confirm = document.getElementById('kn-del-confirm');
    if (cancel) cancel.onclick = () => this._closeModal();
    if (confirm) {
      confirm.onclick = async () => {
        try {
          await this.api.knowledge.delete(entry.id);
          this._closeModal();
          this._state.knowledge.currentEntryId = null;
          await this.loadMemoryContent('knowledge');
        } catch (e) {
          if (this._showToast) this._showToast({ type: 'error', title: e.message });
        }
      };
    }
  }

  async _showKnowledgePreview() {
    if (!this._showModal) return;
    let block = '';
    try {
      const res = await this.api.knowledge.preview();
      block = (res && res.success ? res.block : '') || '';
    } catch (e) {
      block = '';
    }
    this._showModal(t('knowledge.previewTitle'), `
      <p style="margin-bottom:12px;color:var(--text-secondary)">${t('knowledge.previewHint')}</p>
      <pre class="memory-json">${escapeHtml(block || t('knowledge.previewEmpty'))}</pre>
    `);
  }

  // ── Helper: create empty file ──

  async _createEmptyFile(filePath, defaultContent = '') {
    const dir = this.api.path.dirname(filePath);
    if (!await fileExists(dir)) {
      await fsp.mkdir(dir, { recursive: true });
    }
    await fsp.writeFile(filePath, defaultContent, 'utf8');
  }

  // ── Template creation ──

  async createMemoryFromTemplate(templateKey) {
    const template = MEMORY_TEMPLATES[templateKey];
    if (!template) return;

    let projectName = t('memory.defaultProjectName');
    const source = this._state.currentSource;

    if ((source === 'project' || source === 'project-private') && this._state.currentProject !== null) {
      const project = projectsState.get().projects[this._state.currentProject];
      if (project) projectName = project.name;
    } else if (source === 'global') {
      projectName = t('memory.globalInstructionsTitle');
    }

    const content = template.content.replace(/\{PROJECT_NAME\}/g, projectName);

    let filePath = '';
    if (source === 'global') {
      filePath = this._getGlobalClaudeMd();
      const claudeDir = this._getClaudeDir();
      if (!await fileExists(claudeDir)) {
        await fsp.mkdir(claudeDir, { recursive: true });
      }
    } else if (source === 'project' && this._state.currentProject !== null) {
      const project = projectsState.get().projects[this._state.currentProject];
      if (project) filePath = this.api.path.join(project.path, 'CLAUDE.md');
    } else if (source === 'project-private' && this._state.currentProject !== null) {
      const project = projectsState.get().projects[this._state.currentProject];
      if (project) {
        filePath = this._getProjectPrivateClaudeMd(project.path);
        const dir = this.api.path.dirname(filePath);
        if (!await fileExists(dir)) {
          await fsp.mkdir(dir, { recursive: true });
        }
      }
    }

    if (filePath) {
      try {
        await fsp.writeFile(filePath, content, 'utf8');
        await this.loadMemoryContent(this._state.currentSource, this._state.currentProject);
      } catch (e) {
        if (this._showToast) this._showToast({ type: 'error', title: t('memory.errorCreating', { message: e.message }) });
      }
    }
  }

  // ── Event listeners ──

  setupMemoryEventListeners() {
    if (this._state.listenersAttached) return;
    this._state.listenersAttached = true;

    const searchInput = document.getElementById('memory-search-input');
    if (searchInput) {
      searchInput.oninput = async (e) => {
        this._state.searchQuery = e.target.value;
        await this.renderMemorySources(e.target.value);
        if (this._state.currentSource === 'knowledge') {
          this._renderKnowledgeGrid(document.getElementById('memory-content'));
          return;
        }
        if (this._state.fileExists) {
          await this.renderMemoryContent(this._state.content, this._state.currentSource, this._state.fileExists);
        }
      };
    }

    document.getElementById('memory-sources-list').onclick = async (e) => {
      const item = e.target.closest('.memory-source-item');
      if (item) {
        const source = item.dataset.source;
        const projectIndex = item.dataset.project !== undefined ? parseInt(item.dataset.project) : null;
        await this.loadMemoryContent(source, projectIndex);
        return;
      }

      // Handle project group header click (expand/collapse)
      const header = e.target.closest('.memory-project-header');
      if (header) {
        const projectIndex = parseInt(header.dataset.project);
        if (this._state.expandedProjects.has(projectIndex)) {
          this._state.expandedProjects.delete(projectIndex);
        } else {
          this._state.expandedProjects.add(projectIndex);
        }
        await this.renderMemorySources(this._state.searchQuery);
      }
    };

    document.getElementById('btn-memory-refresh').onclick = async () => {
      await this.loadMemoryContent(this._state.currentSource, this._state.currentProject);
    };

    document.getElementById('btn-memory-open').onclick = async () => {
      let filePath = '';
      const source = this._state.currentSource;

      if (source === 'global') {
        filePath = this._getGlobalClaudeMd();
      } else if (source === 'knowledge' || source === 'knowledge-entry') {
        filePath = this.api.path.join(this.api.os.homedir(), '.claude-terminal', 'knowledge');
      } else if (source === 'rules') {
        filePath = this._getRulesMd();
      } else if (source === 'settings' || source === 'commands') {
        filePath = this._getClaudeSettingsJson();
      } else if (source === 'project' && this._state.currentProject !== null) {
        const project = projectsState.get().projects[this._state.currentProject];
        if (project) filePath = this.api.path.join(project.path, 'CLAUDE.md');
      } else if (source === 'project-private' && this._state.currentProject !== null) {
        const project = projectsState.get().projects[this._state.currentProject];
        if (project) filePath = this._getProjectPrivateClaudeMd(project.path);
      } else if (source === 'project-memory' && this._state.currentProject !== null) {
        const project = projectsState.get().projects[this._state.currentProject];
        if (project) filePath = this._getProjectMemoryDir(project.path);
      } else if (source === 'project-memory-file' && this._state.currentProject !== null) {
        const project = projectsState.get().projects[this._state.currentProject];
        if (project && this._state.currentMemoryFile) {
          filePath = this.api.path.join(this._getProjectMemoryDir(project.path), this._state.currentMemoryFile);
        }
      }

      if (filePath) {
        if (!await fileExists(filePath)) {
          filePath = this.api.path.dirname(filePath);
        }
        this.api.dialog.openInExplorer(filePath);
      }
    };

    document.getElementById('btn-memory-create').onclick = async () => {
      const source = this._state.currentSource;
      if (source === 'rules') {
        await this._createEmptyFile(this._getRulesMd(), `# Rules\n\n## Code\n- Write clean, readable code\n`);
        await this.loadMemoryContent('rules');
      } else if (source === 'project-private' && this._state.currentProject !== null) {
        await this.createMemoryFromTemplate('minimal');
      } else {
        await this.createMemoryFromTemplate('minimal');
      }
    };

    document.getElementById('btn-memory-template').onclick = () => {
      this.showTemplateModal();
    };

    document.getElementById('btn-memory-edit').onclick = async () => {
      if (this._state.currentSource === 'settings' || this._state.currentSource === 'commands') {
        const filePath = this._getClaudeSettingsJson();
        if (await fileExists(filePath)) {
          this.api.dialog.openInExplorer(filePath);
        }
        return;
      }

      if (this._state.isEditing) {
        await this.saveMemoryEdit();
      } else {
        this.enterMemoryEditMode();
      }
    };
  }

  // ── Template modal ──

  showTemplateModal() {
    const templatesHtml = Object.entries(MEMORY_TEMPLATES).map(([key, tpl]) => `
      <div class="template-option" data-template="${key}">
        <span class="template-icon">${tpl.icon}</span>
        <div class="template-info">
          <div class="template-name">${escapeHtml(t(tpl.nameKey))}</div>
          <div class="template-preview">${tpl.content.split('\n').slice(0, 3).join(' ').substring(0, 80)}...</div>
        </div>
      </div>
    `).join('');

    this._showModal(t('memory.insertTemplate'), `
      <p style="margin-bottom: 16px; color: var(--text-secondary);">${t('memory.templateInsertHint')}</p>
      <div class="template-list">${templatesHtml}</div>
    `);

    document.querySelectorAll('.template-option').forEach(opt => {
      opt.onclick = () => {
        const template = MEMORY_TEMPLATES[opt.dataset.template];
        if (template) {
          const editor = document.getElementById('memory-editor');
          if (editor) {
            const pos = editor.selectionStart;
            const before = editor.value.substring(0, pos);
            const after = editor.value.substring(pos);
            editor.value = before + template.content + after;
            editor.focus();
          }
        }
        this._closeModal();
      };
    });
  }

  // ── Edit mode ──

  enterMemoryEditMode() {
    this._state.isEditing = true;
    const contentEl = document.getElementById('memory-content');
    const editBtn = document.getElementById('btn-memory-edit');

    contentEl.innerHTML = `
      <textarea class="memory-editor" id="memory-editor">${escapeHtml(this._state.content)}</textarea>
    `;

    editBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
      ${t('memory.save')}
    `;

    const editor = document.getElementById('memory-editor');
    editor.addEventListener('input', () => {
      const isDirty = editor.value !== this._state.content;
      editBtn.classList.toggle('memory-dirty', isDirty);
    });
    editor.focus();
  }

  async saveMemoryEdit() {
    const editor = document.getElementById('memory-editor');
    if (!editor) return;

    const newContent = editor.value;
    let filePath = '';
    const source = this._state.currentSource;

    if (source === 'global') {
      filePath = this._getGlobalClaudeMd();
      const claudeDir = this._getClaudeDir();
      if (!await fileExists(claudeDir)) {
        await fsp.mkdir(claudeDir, { recursive: true });
      }
    } else if (source === 'rules') {
      filePath = this._getRulesMd();
    } else if (source === 'project' && this._state.currentProject !== null) {
      const project = projectsState.get().projects[this._state.currentProject];
      if (project) filePath = this.api.path.join(project.path, 'CLAUDE.md');
    } else if (source === 'project-private' && this._state.currentProject !== null) {
      const project = projectsState.get().projects[this._state.currentProject];
      if (project) {
        filePath = this._getProjectPrivateClaudeMd(project.path);
        const dir = this.api.path.dirname(filePath);
        if (!await fileExists(dir)) {
          await fsp.mkdir(dir, { recursive: true });
        }
      }
    } else if (source === 'project-memory-file' && this._state.currentProject !== null) {
      const project = projectsState.get().projects[this._state.currentProject];
      if (project && this._state.currentMemoryFile) {
        filePath = this.api.path.join(this._getProjectMemoryDir(project.path), this._state.currentMemoryFile);
      }
    }

    if (filePath) {
      try {
        await fsp.writeFile(filePath, newContent, 'utf8');
        this._state.content = newContent;
      } catch (e) {
        if (this._showToast) this._showToast({ type: 'error', title: t('memory.errorSaving', { message: e.message }) });
        return;
      }
    }

    this._state.isEditing = false;
    const editBtn = document.getElementById('btn-memory-edit');
    editBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
      ${t('memory.edit')}
    `;

    await this.renderMemoryContent(newContent, this._state.currentSource);
  }
}

// ── Lazy singleton + legacy exports ──

let _instance = null;

function _ensureInstance(context) {
  if (!_instance) {
    const { getApiProvider, getContainer } = require('../../core');
    _instance = new MemoryEditor(null, {
      api: getApiProvider(),
      container: getContainer(),
      showModal: context.showModal,
      closeModal: context.closeModal,
      showToast: context.showToast
    });
  }
  return _instance;
}

module.exports = {
  MemoryEditor,
  init: (context) => {
    _ensureInstance(context);
    _instance._showModal = context.showModal;
    _instance._closeModal = context.closeModal;
    _instance._showToast = context.showToast;
  },
  loadMemory: () => {
    if (_instance) return _instance.loadMemory();
  }
};
