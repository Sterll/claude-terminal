/**
 * MemoryEditor Panel
 * CLAUDE.md editor with templates, markdown preview, and search
 * Extracted from renderer.js
 */

const { escapeHtml } = require('../../utils');
const { t } = require('../../i18n');
const { projectsState } = require('../../state');

const api = window.electron_api;
const { path, fs, process: nodeProcess } = window.electron_nodeModules;

let showModal = null;
let closeModal = null;

const memoryState = {
  currentSource: 'global',
  currentProject: null,
  content: '',
  isEditing: false,
  listenersAttached: false,
  fileExists: false,
  searchQuery: ''
};

const MEMORY_TEMPLATES = {
  minimal: {
    name: 'Minimal',
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
    name: 'Fullstack',
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
    name: 'FiveM Resource',
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
    name: 'API REST',
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
    name: 'Librairie/Package',
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

function getClaudeDir() {
  return path.join(window.electron_nodeModules.os.homedir(), '.claude');
}

function getGlobalClaudeMd() {
  return path.join(getClaudeDir(), 'CLAUDE.md');
}

function getClaudeSettingsJson() {
  return path.join(getClaudeDir(), 'settings.json');
}

function init(context) {
  showModal = context.showModal;
  closeModal = context.closeModal;
}

async function loadMemory() {
  renderMemorySources();
  await loadMemoryContent('global');
  setupMemoryEventListeners();
}

function renderMemorySources(filter = '') {
  const projectsList = document.getElementById('memory-projects-list');
  const projects = projectsState.get().projects;
  const searchQuery = filter.toLowerCase();

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

  projectsList.innerHTML = filteredProjects.map(p => {
    const claudeMdPath = path.join(p.path, 'CLAUDE.md');
    const hasClaudeMd = fs.existsSync(claudeMdPath);
    const claudeIgnorePath = path.join(p.path, '.claudeignore');
    const hasClaudeIgnore = fs.existsSync(claudeIgnorePath);
    const localClaudeDir = path.join(p.path, '.claude');
    const hasLocalSettings = fs.existsSync(path.join(localClaudeDir, 'settings.json'));

    return `
      <div class="memory-source-item ${memoryState.currentSource === 'project' && memoryState.currentProject === p.index ? 'active' : ''}"
           data-source="project" data-project="${p.index}">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/>
        </svg>
        <span>${escapeHtml(p.name)}</span>
        <div class="memory-source-badges">
          ${hasClaudeMd ? '<span class="memory-badge" title="CLAUDE.md">MD</span>' : ''}
          ${hasClaudeIgnore ? '<span class="memory-badge ignore" title=".claudeignore">IG</span>' : ''}
          ${hasLocalSettings ? '<span class="memory-badge settings" title="Settings locaux">\u2699</span>' : ''}
        </div>
      </div>
    `;
  }).join('');

  // Update active states for global, settings, and commands
  document.querySelectorAll('#memory-sources-list > .memory-source-item').forEach(item => {
    const source = item.dataset.source;
    const isActive = source === memoryState.currentSource &&
      (memoryState.currentSource !== 'project' || parseInt(item.dataset.project) === memoryState.currentProject);
    item.classList.toggle('active', isActive);
  });
}

async function loadMemoryContent(source, projectIndex = null) {
  memoryState.currentSource = source;
  memoryState.currentProject = projectIndex;
  memoryState.isEditing = false;

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
  let fileExists = false;

  try {
    if (source === 'global') {
      filePath = getGlobalClaudeMd();
      title = t('memory.globalMemory');
      fileExists = fs.existsSync(filePath);
      if (fileExists) {
        content = await fs.promises.readFile(filePath, 'utf8');
      } else {
        content = '';
      }
    } else if (source === 'settings') {
      filePath = getClaudeSettingsJson();
      title = t('memory.claudeSettings');
      fileExists = fs.existsSync(filePath);
      if (fileExists) {
        const jsonContent = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
        content = JSON.stringify(jsonContent, null, 2);
      } else {
        content = '{}';
      }
    } else if (source === 'commands') {
      filePath = getClaudeSettingsJson();
      title = t('memory.allowedCommands');
      fileExists = fs.existsSync(filePath);
      if (fileExists) {
        const jsonContent = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
        content = JSON.stringify(jsonContent.allowedCommands || jsonContent.permissions || {}, null, 2);
      } else {
        content = '{}';
      }
    } else if (source === 'project' && projectIndex !== null) {
      const project = projectsState.get().projects[projectIndex];
      if (project) {
        filePath = path.join(project.path, 'CLAUDE.md');
        title = project.name;
        fileExists = fs.existsSync(filePath);
        if (fileExists) {
          content = await fs.promises.readFile(filePath, 'utf8');
        } else {
          content = '';
        }
      }
    }
  } catch (e) {
    content = t('memory.errorLoading', { message: e.message });
  }

  memoryState.content = content;
  memoryState.fileExists = fileExists;

  titleEl.textContent = title;
  pathEl.textContent = filePath.replace(window.electron_nodeModules.os.homedir(), '~');

  // Show/hide buttons based on context
  const isMarkdownSource = source === 'global' || source === 'project';
  editBtn.style.display = (isMarkdownSource && fileExists) ? 'flex' : 'none';
  createBtn.style.display = (isMarkdownSource && !fileExists) ? 'flex' : 'none';
  templateBtn.style.display = (isMarkdownSource && memoryState.isEditing) ? 'flex' : 'none';

  if (isMarkdownSource) {
    editBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg> ${t('memory.edit')}`;
  }

  // Render stats
  if (fileExists && content) {
    const stats = calculateMemoryStats(content, source);
    statsEl.innerHTML = stats;
    statsEl.style.display = 'flex';
  } else {
    statsEl.style.display = 'none';
  }

  renderMemoryContent(content, source, fileExists);
  renderMemorySources(memoryState.searchQuery);
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

function renderMemoryContent(content, source, fileExists = true) {
  const contentEl = document.getElementById('memory-content');

  if (!fileExists) {
    const isProject = source === 'project';
    const projectName = isProject && memoryState.currentProject !== null
      ? projectsState.get().projects[memoryState.currentProject]?.name || 'Projet'
      : 'Global';

    contentEl.innerHTML = `
      <div class="memory-empty-state">
        <div class="memory-empty-icon">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
        </div>
        <h3>${t('memory.noClaudeMd')}</h3>
        <p>${t('memory.createHint', { name: escapeHtml(projectName) })}</p>
        <div class="memory-empty-templates">
          <p class="template-hint">${t('memory.chooseTemplate')}</p>
          <div class="template-grid">
            ${Object.entries(MEMORY_TEMPLATES).map(([key, tpl]) => `
              <button class="template-card" data-template="${key}">
                <span class="template-icon">${tpl.icon}</span>
                <span class="template-name">${tpl.name}</span>
              </button>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    contentEl.querySelectorAll('.template-card').forEach(card => {
      card.onclick = async () => await createMemoryFromTemplate(card.dataset.template);
    });
    return;
  }

  if (source === 'settings' || source === 'commands') {
    contentEl.innerHTML = `<pre class="memory-json">${escapeHtml(content)}</pre>`;
    return;
  }

  // Parse markdown and render with search highlighting
  let html = parseMarkdownToHtml(content);

  // Highlight search terms if any
  if (memoryState.searchQuery) {
    const regex = new RegExp(`(${escapeHtml(memoryState.searchQuery)})`, 'gi');
    html = html.replace(regex, '<mark class="search-highlight">$1</mark>');
  }

  contentEl.innerHTML = `<div class="memory-markdown">${html}</div>`;
}

function parseMarkdownToHtml(md) {
  const { marked } = require('marked');

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

  marked.use({ renderer, gfm: true, breaks: false });
  return marked.parse(md);
}

async function createMemoryFromTemplate(templateKey) {
  const template = MEMORY_TEMPLATES[templateKey];
  if (!template) return;

  let projectName = 'Mon Projet';
  if (memoryState.currentSource === 'project' && memoryState.currentProject !== null) {
    const project = projectsState.get().projects[memoryState.currentProject];
    if (project) projectName = project.name;
  } else if (memoryState.currentSource === 'global') {
    projectName = 'Instructions Globales Claude';
  }

  const content = template.content.replace(/\{PROJECT_NAME\}/g, projectName);

  let filePath = '';
  if (memoryState.currentSource === 'global') {
    filePath = getGlobalClaudeMd();
    const claudeDir = getClaudeDir();
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
  } else if (memoryState.currentSource === 'project' && memoryState.currentProject !== null) {
    const project = projectsState.get().projects[memoryState.currentProject];
    if (project) filePath = path.join(project.path, 'CLAUDE.md');
  }

  if (filePath) {
    try {
      fs.writeFileSync(filePath, content, 'utf8');
      await loadMemoryContent(memoryState.currentSource, memoryState.currentProject);
    } catch (e) {
      alert(t('memory.errorCreating', { message: e.message }));
    }
  }
}

function setupMemoryEventListeners() {
  if (memoryState.listenersAttached) return;
  memoryState.listenersAttached = true;

  const searchInput = document.getElementById('memory-search-input');
  if (searchInput) {
    searchInput.oninput = (e) => {
      memoryState.searchQuery = e.target.value;
      renderMemorySources(e.target.value);
      if (memoryState.fileExists) {
        renderMemoryContent(memoryState.content, memoryState.currentSource, memoryState.fileExists);
      }
    };
  }

  document.getElementById('memory-sources-list').onclick = async (e) => {
    const item = e.target.closest('.memory-source-item');
    if (!item) return;

    const source = item.dataset.source;
    const projectIndex = item.dataset.project !== undefined ? parseInt(item.dataset.project) : null;
    await loadMemoryContent(source, projectIndex);
  };

  document.getElementById('btn-memory-refresh').onclick = async () => {
    await loadMemoryContent(memoryState.currentSource, memoryState.currentProject);
  };

  document.getElementById('btn-memory-open').onclick = () => {
    let filePath = '';
    if (memoryState.currentSource === 'global') {
      filePath = getGlobalClaudeMd();
    } else if (memoryState.currentSource === 'settings' || memoryState.currentSource === 'commands') {
      filePath = getClaudeSettingsJson();
    } else if (memoryState.currentSource === 'project' && memoryState.currentProject !== null) {
      const project = projectsState.get().projects[memoryState.currentProject];
      if (project) filePath = path.join(project.path, 'CLAUDE.md');
    }

    if (filePath) {
      if (!fs.existsSync(filePath)) {
        filePath = path.dirname(filePath);
      }
      api.dialog.openInExplorer(filePath);
    }
  };

  document.getElementById('btn-memory-create').onclick = async () => {
    await createMemoryFromTemplate('minimal');
  };

  document.getElementById('btn-memory-template').onclick = () => {
    showTemplateModal();
  };

  document.getElementById('btn-memory-edit').onclick = () => {
    if (memoryState.currentSource === 'settings' || memoryState.currentSource === 'commands') {
      const filePath = getClaudeSettingsJson();
      if (fs.existsSync(filePath)) {
        api.dialog.openInExplorer(filePath);
      }
      return;
    }

    if (memoryState.isEditing) {
      saveMemoryEdit();
    } else {
      enterMemoryEditMode();
    }
  };
}

function showTemplateModal() {
  const templatesHtml = Object.entries(MEMORY_TEMPLATES).map(([key, tpl]) => `
    <div class="template-option" data-template="${key}">
      <span class="template-icon">${tpl.icon}</span>
      <div class="template-info">
        <div class="template-name">${tpl.name}</div>
        <div class="template-preview">${tpl.content.split('\n').slice(0, 3).join(' ').substring(0, 80)}...</div>
      </div>
    </div>
  `).join('');

  showModal(t('memory.insertTemplate'), `
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
      closeModal();
    };
  });
}

function enterMemoryEditMode() {
  memoryState.isEditing = true;
  const contentEl = document.getElementById('memory-content');
  const editBtn = document.getElementById('btn-memory-edit');

  contentEl.innerHTML = `
    <textarea class="memory-editor" id="memory-editor">${escapeHtml(memoryState.content)}</textarea>
  `;

  editBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
    ${t('memory.save')}
  `;

  document.getElementById('memory-editor').focus();
}

function saveMemoryEdit() {
  const editor = document.getElementById('memory-editor');
  if (!editor) return;

  const newContent = editor.value;
  let filePath = '';

  if (memoryState.currentSource === 'global') {
    filePath = getGlobalClaudeMd();
    const claudeDir = getClaudeDir();
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
  } else if (memoryState.currentSource === 'project' && memoryState.currentProject !== null) {
    const project = projectsState.get().projects[memoryState.currentProject];
    if (project) filePath = path.join(project.path, 'CLAUDE.md');
  }

  if (filePath) {
    try {
      fs.writeFileSync(filePath, newContent, 'utf8');
      memoryState.content = newContent;
    } catch (e) {
      alert(t('memory.errorSaving', { message: e.message }));
      return;
    }
  }

  memoryState.isEditing = false;
  const editBtn = document.getElementById('btn-memory-edit');
  editBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
    ${t('memory.edit')}
  `;

  renderMemoryContent(newContent, memoryState.currentSource);
}

module.exports = { init, loadMemory };
