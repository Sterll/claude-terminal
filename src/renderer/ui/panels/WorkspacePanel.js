/**
 * WorkspacePanel
 * Manages workspaces: project grouping, knowledge base docs, concept links.
 * Three views: list, detail, editor.
 */

const { t } = require('../../i18n');

let _ctx = null;
let _view = 'list';         // 'list' | 'detail' | 'editor'
let _container = null;
let _saveTimer = null;
let _saveIndicatorTimer = null;
let _stateUnsubscribe = null;

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return t('workspace.lastUpdated', { date: 'now' });
  if (diff < 3600000) return t('workspace.lastUpdated', { date: `${Math.floor(diff / 60000)}m` });
  if (diff < 86400000) return t('workspace.lastUpdated', { date: `${Math.floor(diff / 3600000)}h` });
  return t('workspace.lastUpdated', { date: d.toLocaleDateString() });
}

// ========== MARKDOWN PREVIEW ==========

function parseMarkdownToHtml(md) {
  try {
    const { marked } = require('marked');
    const DOMPurify = require('dompurify');
    const renderer = {
      code({ text, lang }) { return `<pre><code class="lang-${lang || ''}">${text}</code></pre>`; },
      codespan({ text }) { return `<code>${text}</code>`; },
    };
    marked.use({ renderer, gfm: true, breaks: false });
    const rawHtml = marked.parse(md);
    return DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS: ['h1','h2','h3','h4','h5','h6','p','br','strong','em','code','pre',
                     'ul','ol','li','a','table','thead','tbody','tr','th','td',
                     'blockquote','hr','span','div'],
      ALLOWED_ATTR: ['href', 'class'],
    });
  } catch {
    return `<pre>${escapeHtml(md)}</pre>`;
  }
}

// ========== ICONS ==========

const ICONS = {
  back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>',
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>',
  edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  doc: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>',
  link: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>',
  chat: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>',
  close: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>',
  arrow: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>',
};

// ========== INIT / LOAD / CLEANUP ==========

function init(ctx) {
  _ctx = ctx;
}

function loadPanel(container) {
  _container = container;
  if (!_container) return;

  // Subscribe to workspace state changes
  const wsState = require('../../state/workspace.state');
  if (_stateUnsubscribe) _stateUnsubscribe();
  _stateUnsubscribe = wsState.workspaceState.subscribe(() => {
    if (_container) render();
  });

  render();
}

function cleanup() {
  if (_saveTimer) clearTimeout(_saveTimer);
  if (_saveIndicatorTimer) clearTimeout(_saveIndicatorTimer);
  if (_stateUnsubscribe) { _stateUnsubscribe(); _stateUnsubscribe = null; }
}

// ========== RENDER DISPATCHER ==========

function render() {
  if (!_container) return;
  switch (_view) {
    case 'list': renderList(); break;
    case 'detail': renderDetail(); break;
    case 'editor': renderEditor(); break;
  }
}

// ========== LIST VIEW ==========

function renderList() {
  const wsState = require('../../state/workspace.state');
  const workspaces = wsState.workspaceState.get().workspaces || [];

  if (workspaces.length === 0) {
    _container.innerHTML = `
      <div class="workspace-header">
        <div class="workspace-header-left">
          <span class="workspace-header-title">${escapeHtml(t('workspace.title'))}</span>
        </div>
        <div class="workspace-header-actions">
          <button class="workspace-btn workspace-btn-primary" id="ws-create-btn">${ICONS.plus} ${escapeHtml(t('workspace.create'))}</button>
        </div>
      </div>
      <div class="workspace-content">
        <div class="workspace-empty">
          <svg class="workspace-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
          </svg>
          <div class="workspace-empty-title">${escapeHtml(t('workspace.noWorkspaces'))}</div>
          <div class="workspace-empty-hint">${escapeHtml(t('workspace.noWorkspacesHint'))}</div>
          <button class="workspace-btn workspace-btn-primary" id="ws-create-btn-empty">${ICONS.plus} ${escapeHtml(t('workspace.create'))}</button>
        </div>
      </div>
    `;

    bindCreate('ws-create-btn');
    bindCreate('ws-create-btn-empty');
    return;
  }

  const projectsState = require('../../state/projects.state');
  const allProjects = projectsState.projectsState.get().projects;

  const cardsHtml = workspaces.map(ws => {
    const projCount = ws.projectIds ? ws.projectIds.length : 0;
    const colorStyle = ws.color ? ` style="border-left: 3px solid ${escapeHtml(ws.color)}"` : '';
    return `
      <div class="workspace-card" data-wsid="${escapeHtml(ws.id)}"${colorStyle}>
        <div class="workspace-card-top">
          <span class="workspace-card-icon">${ws.icon || '📦'}</span>
          <span class="workspace-card-name">${escapeHtml(ws.name)}</span>
        </div>
        ${ws.description ? `<div class="workspace-card-desc">${escapeHtml(ws.description)}</div>` : ''}
        <div class="workspace-card-meta">
          <span>${escapeHtml(t('workspace.projectsCount', { count: projCount }))}</span>
          <span>${formatDate(ws.updatedAt)}</span>
        </div>
      </div>
    `;
  }).join('');

  _container.innerHTML = `
    <div class="workspace-header">
      <div class="workspace-header-left">
        <span class="workspace-header-title">${escapeHtml(t('workspace.title'))}</span>
      </div>
      <div class="workspace-header-actions">
        <button class="workspace-btn workspace-btn-primary" id="ws-create-btn">${ICONS.plus} ${escapeHtml(t('workspace.create'))}</button>
      </div>
    </div>
    <div class="workspace-content">
      <div class="workspace-cards">${cardsHtml}</div>
    </div>
  `;

  bindCreate('ws-create-btn');

  // Card click -> open detail
  _container.querySelectorAll('.workspace-card').forEach(card => {
    card.addEventListener('click', async () => {
      const wsId = card.dataset.wsid;
      const wsState = require('../../state/workspace.state');
      await wsState.setActiveWorkspace(wsId);
      _view = 'detail';
      render();
    });
  });
}

// ========== DETAIL VIEW ==========

function renderDetail() {
  const wsState = require('../../state/workspace.state');
  const state = wsState.workspaceState.get();
  const ws = wsState.getWorkspace(state.activeWorkspaceId);
  if (!ws) { _view = 'list'; renderList(); return; }

  const projectsState = require('../../state/projects.state');
  const allProjects = projectsState.projectsState.get().projects;
  const wsProjects = (ws.projectIds || []).map(id => allProjects.find(p => p.id === id)).filter(Boolean);
  const docs = state.docs || [];
  const links = state.links || [];

  // Projects section
  const projectsHtml = wsProjects.length === 0
    ? `<div style="color:var(--text-muted);font-size:var(--font-sm);padding:8px">${escapeHtml(t('workspace.noProjects'))}</div>`
    : wsProjects.map(p => `
        <div class="workspace-project-item" data-pid="${escapeHtml(p.id)}">
          <span class="workspace-project-icon">${p.icon || '📁'}</span>
          <div class="workspace-project-info">
            <div class="workspace-project-name">${escapeHtml(p.name || window.electron_nodeModules.path.basename(p.path))}</div>
            <div class="workspace-project-path">${escapeHtml(p.path)}</div>
          </div>
          <button class="workspace-project-remove" data-pid="${escapeHtml(p.id)}" title="${escapeHtml(t('workspace.removeProject'))}">${ICONS.close}</button>
        </div>
      `).join('');

  // Docs section
  const docsHtml = docs.length === 0
    ? `<div style="color:var(--text-muted);font-size:var(--font-sm);padding:8px">${escapeHtml(t('workspace.noDocs'))}</div>`
    : docs.map(d => `
        <div class="workspace-doc-item" data-docid="${escapeHtml(d.id)}">
          ${ICONS.doc}
          <span class="workspace-doc-title">${escapeHtml(d.title)}</span>
          <span class="workspace-doc-date">${formatDate(d.updatedAt)}</span>
          <button class="workspace-doc-delete" data-docid="${escapeHtml(d.id)}" title="${escapeHtml(t('workspace.deleteDoc'))}">${ICONS.close}</button>
        </div>
      `).join('');

  // Links section
  const linksHtml = links.length === 0
    ? `<div style="color:var(--text-muted);font-size:var(--font-sm);padding:8px">${escapeHtml(t('workspace.noLinks'))}</div>`
    : links.map(l => {
        const sourceName = resolveEntityName(l.sourceType, l.sourceId, wsProjects, docs);
        const targetName = resolveEntityName(l.targetType, l.targetId, wsProjects, docs);
        return `
          <div class="workspace-link-item">
            <span class="workspace-link-source">${escapeHtml(sourceName)}</span>
            <span class="workspace-link-arrow">${ICONS.arrow}</span>
            <span class="workspace-link-label">${escapeHtml(l.label)}</span>
            <span class="workspace-link-arrow">${ICONS.arrow}</span>
            <span class="workspace-link-target">${escapeHtml(targetName)}</span>
            <button class="workspace-link-delete" data-linkid="${escapeHtml(l.id)}" title="${escapeHtml(t('workspace.deleteLink'))}">${ICONS.close}</button>
          </div>
        `;
      }).join('');

  _container.innerHTML = `
    <div class="workspace-header">
      <div class="workspace-header-left">
        <button class="workspace-back-btn" id="ws-back-list" title="${escapeHtml(t('workspace.backToList'))}">${ICONS.back}</button>
        <span class="workspace-card-icon" style="font-size:1.5rem">${ws.icon || '📦'}</span>
        <span class="workspace-header-title"${ws.color ? ` style="color:${escapeHtml(ws.color)}"` : ''}>${escapeHtml(ws.name)}</span>
      </div>
      <div class="workspace-header-actions">
        <button class="workspace-btn workspace-btn-secondary workspace-btn-sm" id="ws-edit-btn">${ICONS.edit} ${escapeHtml(t('workspace.edit'))}</button>
        <button class="workspace-btn workspace-btn-danger workspace-btn-sm" id="ws-delete-btn">${ICONS.trash} ${escapeHtml(t('workspace.delete'))}</button>
      </div>
    </div>
    ${ws.description ? `<div style="padding:0 16px 8px;color:var(--text-secondary);font-size:var(--font-sm)">${escapeHtml(ws.description)}</div>` : ''}
    <div class="workspace-content">
      <div class="workspace-sections">
        <!-- Projects -->
        <div class="workspace-section">
          <div class="workspace-section-header">
            <div class="workspace-section-title">${escapeHtml(t('workspace.projects'))} <span class="workspace-section-count">(${wsProjects.length})</span></div>
            <button class="workspace-btn workspace-btn-secondary workspace-btn-sm" id="ws-add-project">${ICONS.plus} ${escapeHtml(t('workspace.addProject'))}</button>
          </div>
          <div id="ws-projects-list">${projectsHtml}</div>
        </div>

        <!-- Knowledge Base -->
        <div class="workspace-section">
          <div class="workspace-section-header">
            <div class="workspace-section-title">${escapeHtml(t('workspace.knowledgeBase'))} <span class="workspace-section-count">(${docs.length})</span></div>
            <button class="workspace-btn workspace-btn-secondary workspace-btn-sm" id="ws-new-doc">${ICONS.plus} ${escapeHtml(t('workspace.newDoc'))}</button>
          </div>
          <div id="ws-docs-list">${docsHtml}</div>
        </div>

        <!-- Concept Links -->
        <div class="workspace-section">
          <div class="workspace-section-header">
            <div class="workspace-section-title">${escapeHtml(t('workspace.conceptLinks'))} <span class="workspace-section-count">(${links.length})</span></div>
            <button class="workspace-btn workspace-btn-secondary workspace-btn-sm" id="ws-add-link">${ICONS.link} ${escapeHtml(t('workspace.addLink'))}</button>
          </div>
          <div id="ws-links-list">${linksHtml}</div>
        </div>
      </div>
    </div>
  `;

  // === Event bindings ===

  // Back to list
  document.getElementById('ws-back-list')?.addEventListener('click', () => {
    _view = 'list';
    render();
  });

  // Edit workspace
  document.getElementById('ws-edit-btn')?.addEventListener('click', () => showCreateEditModal(ws));

  // Delete workspace
  document.getElementById('ws-delete-btn')?.addEventListener('click', async () => {
    if (!confirm(t('workspace.deleteConfirm', { name: ws.name }))) return;
    await wsState.deleteWorkspace(ws.id);
    _view = 'list';
    render();
  });

  // Add project
  document.getElementById('ws-add-project')?.addEventListener('click', () => showAddProjectDropdown(ws));

  // Remove project
  _container.querySelectorAll('.workspace-project-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pid = btn.dataset.pid;
      wsState.removeProjectFromWorkspace(ws.id, pid);
    });
  });

  // New doc
  document.getElementById('ws-new-doc')?.addEventListener('click', () => showNewDocModal(ws.id));

  // Open doc in editor
  _container.querySelectorAll('.workspace-doc-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.workspace-doc-delete')) return;
      const docId = item.dataset.docid;
      wsState.workspaceState.set({ editingDocId: docId });
      _view = 'editor';
      render();
    });
  });

  // Delete doc
  _container.querySelectorAll('.workspace-doc-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const docId = btn.dataset.docid;
      const doc = wsState.getDoc(docId);
      if (!doc) return;
      if (!confirm(t('workspace.deleteDocConfirm', { title: doc.title }))) return;
      await wsState.deleteDoc(ws.id, docId);
    });
  });

  // Add link
  document.getElementById('ws-add-link')?.addEventListener('click', () => showAddLinkModal(ws.id, wsProjects, docs));

  // Delete link
  _container.querySelectorAll('.workspace-link-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await wsState.deleteLink(ws.id, btn.dataset.linkid);
    });
  });
}

function resolveEntityName(type, id, projects, docs) {
  if (type === 'project') {
    const p = projects.find(p => p.id === id);
    return p ? (p.name || window.electron_nodeModules.path.basename(p.path)) : id;
  }
  if (type === 'doc') {
    const d = docs.find(d => d.id === id);
    return d ? d.title : id;
  }
  return id;
}

// ========== EDITOR VIEW ==========

let _editorContent = '';
let _editorDocId = null;

function renderEditor() {
  const wsState = require('../../state/workspace.state');
  const state = wsState.workspaceState.get();
  const ws = wsState.getWorkspace(state.activeWorkspaceId);
  const doc = wsState.getDoc(state.editingDocId);
  if (!ws || !doc) { _view = 'detail'; render(); return; }

  _editorDocId = doc.id;

  // Load content async, then render
  wsState.readDocContent(ws.id, doc.id).then(content => {
    _editorContent = content || '';
    renderEditorWithContent(ws, doc);
  });
}

function renderEditorWithContent(ws, doc) {
  const previewHtml = parseMarkdownToHtml(_editorContent);

  _container.innerHTML = `
    <div class="workspace-header">
      <div class="workspace-header-left">
        <button class="workspace-back-btn" id="ws-back-detail" title="${escapeHtml(t('workspace.backToDetail'))}">${ICONS.back}</button>
        ${ICONS.doc}
        <span class="workspace-header-title">${escapeHtml(doc.title)}</span>
      </div>
      <div class="workspace-header-actions">
        <span class="workspace-editor-save-indicator" id="ws-save-indicator"></span>
      </div>
    </div>
    <div class="workspace-editor">
      <div class="workspace-editor-edit">
        <div class="workspace-editor-toolbar">
          <div class="workspace-editor-toolbar-left">
            <span style="font-size:var(--font-xs);color:var(--text-muted)">Markdown</span>
          </div>
          <div class="workspace-editor-toolbar-right">
            <span id="ws-editor-stats"></span>
          </div>
        </div>
        <textarea class="workspace-editor-textarea" id="ws-editor-textarea" spellcheck="false" placeholder="Write markdown...">${escapeHtml(_editorContent)}</textarea>
      </div>
      <div class="workspace-editor-preview" id="ws-editor-preview">${previewHtml}</div>
    </div>
  `;

  updateEditorStats();

  // Back to detail
  document.getElementById('ws-back-detail')?.addEventListener('click', async () => {
    // Save before leaving
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    const wsState = require('../../state/workspace.state');
    await wsState.saveDocContent(wsState.workspaceState.get().activeWorkspaceId, _editorDocId, _editorContent);
    _view = 'detail';
    render();
  });

  // Textarea input -> debounced save + live preview
  const textarea = document.getElementById('ws-editor-textarea');
  textarea?.addEventListener('input', () => {
    _editorContent = textarea.value;
    updatePreview();
    updateEditorStats();
    scheduleSave();
  });

  // Ctrl+S save
  textarea?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveNow();
    }
  });
}

function updatePreview() {
  const preview = document.getElementById('ws-editor-preview');
  if (preview) preview.innerHTML = parseMarkdownToHtml(_editorContent);
}

function updateEditorStats() {
  const stats = document.getElementById('ws-editor-stats');
  if (!stats) return;
  const lines = _editorContent.split('\n').length;
  const words = _editorContent.trim() ? _editorContent.trim().split(/\s+/).length : 0;
  stats.textContent = `${lines} lines, ${words} words`;
}

function scheduleSave() {
  const indicator = document.getElementById('ws-save-indicator');
  if (indicator) { indicator.textContent = t('workspace.unsaved'); indicator.className = 'workspace-editor-save-indicator'; }
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => saveNow(), 1000);
}

async function saveNow() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  const indicator = document.getElementById('ws-save-indicator');
  if (indicator) { indicator.textContent = t('workspace.saving'); indicator.className = 'workspace-editor-save-indicator saving'; }

  try {
    const wsState = require('../../state/workspace.state');
    const wsId = wsState.workspaceState.get().activeWorkspaceId;
    if (wsId && _editorDocId) {
      await wsState.saveDocContent(wsId, _editorDocId, _editorContent);
    }
    if (indicator) { indicator.textContent = t('workspace.saved'); indicator.className = 'workspace-editor-save-indicator saved'; }
    if (_saveIndicatorTimer) clearTimeout(_saveIndicatorTimer);
    _saveIndicatorTimer = setTimeout(() => {
      if (indicator) indicator.textContent = '';
    }, 2000);
  } catch (e) {
    console.error('Failed to save doc:', e);
    if (indicator) { indicator.textContent = 'Error'; indicator.className = 'workspace-editor-save-indicator'; }
  }
}

// ========== MODALS ==========

function showCreateEditModal(existingWs = null) {
  const modal = document.getElementById('generic-modal') || createGenericModal();
  const isEdit = !!existingWs;

  const emojis = ['📦', '🚀', '🎮', '🌐', '🛠️', '📱', '🎨', '💼', '🔬', '📊', '🎯', '🏗️'];
  const colors = ['#d97706', '#ef4444', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];

  modal.innerHTML = `
    <div class="modal-overlay" id="ws-modal-overlay">
      <div class="modal-dialog" style="width:440px">
        <div class="modal-header">
          <h3>${escapeHtml(isEdit ? t('workspace.edit') : t('workspace.create'))}</h3>
          <button class="modal-close" id="ws-modal-close">${ICONS.close}</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:14px;padding:16px">
          <div>
            <label style="font-size:var(--font-sm);color:var(--text-secondary);margin-bottom:4px;display:block">${escapeHtml(t('workspace.name'))}</label>
            <input type="text" id="ws-modal-name" class="workspace-search-input" value="${escapeHtml(existingWs?.name || '')}" placeholder="${escapeHtml(t('workspace.namePlaceholder'))}">
          </div>
          <div>
            <label style="font-size:var(--font-sm);color:var(--text-secondary);margin-bottom:4px;display:block">${escapeHtml(t('workspace.description'))}</label>
            <input type="text" id="ws-modal-desc" class="workspace-search-input" value="${escapeHtml(existingWs?.description || '')}" placeholder="${escapeHtml(t('workspace.descriptionPlaceholder'))}">
          </div>
          <div>
            <label style="font-size:var(--font-sm);color:var(--text-secondary);margin-bottom:6px;display:block">${escapeHtml(t('workspace.icon'))}</label>
            <div style="display:flex;gap:6px;flex-wrap:wrap" id="ws-modal-icons">
              ${emojis.map(e => `<button class="workspace-btn workspace-btn-secondary workspace-btn-sm ws-emoji-btn${existingWs?.icon === e ? ' active' : ''}" data-emoji="${e}" style="font-size:1.2rem;padding:6px 8px${existingWs?.icon === e ? ';border-color:var(--accent)' : ''}">${e}</button>`).join('')}
            </div>
          </div>
          <div>
            <label style="font-size:var(--font-sm);color:var(--text-secondary);margin-bottom:6px;display:block">${escapeHtml(t('workspace.color'))}</label>
            <div style="display:flex;gap:6px;flex-wrap:wrap" id="ws-modal-colors">
              ${colors.map(c => `<button class="ws-color-btn" data-color="${c}" style="width:28px;height:28px;border-radius:50%;background:${c};border:2px solid ${existingWs?.color === c ? 'var(--text-primary)' : 'transparent'};cursor:pointer"></button>`).join('')}
            </div>
          </div>
        </div>
        <div class="modal-footer" style="padding:12px 16px;display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--border-color)">
          <button class="workspace-btn workspace-btn-secondary" id="ws-modal-cancel">${isEdit ? 'Cancel' : 'Cancel'}</button>
          <button class="workspace-btn workspace-btn-primary" id="ws-modal-confirm">${isEdit ? 'Save' : 'Create'}</button>
        </div>
      </div>
    </div>
  `;

  modal.style.display = 'block';

  let selectedIcon = existingWs?.icon || '📦';
  let selectedColor = existingWs?.color || '';

  // Emoji selection
  modal.querySelectorAll('.ws-emoji-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      modal.querySelectorAll('.ws-emoji-btn').forEach(b => { b.style.borderColor = ''; b.classList.remove('active'); });
      btn.style.borderColor = 'var(--accent)';
      btn.classList.add('active');
      selectedIcon = btn.dataset.emoji;
    });
  });

  // Color selection
  modal.querySelectorAll('.ws-color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      modal.querySelectorAll('.ws-color-btn').forEach(b => b.style.borderColor = 'transparent');
      btn.style.borderColor = 'var(--text-primary)';
      selectedColor = btn.dataset.color;
    });
  });

  const closeModal = () => { modal.style.display = 'none'; };
  document.getElementById('ws-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('ws-modal-cancel')?.addEventListener('click', closeModal);
  document.getElementById('ws-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'ws-modal-overlay') closeModal();
  });

  document.getElementById('ws-modal-confirm')?.addEventListener('click', async () => {
    const name = document.getElementById('ws-modal-name')?.value?.trim();
    if (!name) return;
    const description = document.getElementById('ws-modal-desc')?.value?.trim() || '';

    const wsState = require('../../state/workspace.state');
    if (isEdit) {
      wsState.updateWorkspace(existingWs.id, { name, description, icon: selectedIcon, color: selectedColor });
    } else {
      await wsState.addWorkspace({ name, description, icon: selectedIcon, color: selectedColor });
    }
    closeModal();
    render();
  });

  // Focus name input
  setTimeout(() => document.getElementById('ws-modal-name')?.focus(), 50);
}

function createGenericModal() {
  let modal = document.getElementById('generic-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'generic-modal';
    modal.style.display = 'none';
    document.body.appendChild(modal);
  }
  return modal;
}

function showAddProjectDropdown(ws) {
  const projectsState = require('../../state/projects.state');
  const allProjects = projectsState.projectsState.get().projects;
  const available = allProjects.filter(p => !ws.projectIds.includes(p.id));

  if (available.length === 0) return;

  // Remove existing dropdown
  document.getElementById('ws-add-project-dropdown')?.remove();

  const btn = document.getElementById('ws-add-project');
  if (!btn) return;
  const rect = btn.getBoundingClientRect();

  const dropdown = document.createElement('div');
  dropdown.id = 'ws-add-project-dropdown';
  dropdown.className = 'workspace-add-project-dropdown';
  dropdown.style.position = 'fixed';
  dropdown.style.top = (rect.bottom + 4) + 'px';
  dropdown.style.left = rect.left + 'px';

  dropdown.innerHTML = available.map(p => `
    <div class="workspace-project-item" data-pid="${escapeHtml(p.id)}">
      <span class="workspace-project-icon">${p.icon || '📁'}</span>
      <div class="workspace-project-info">
        <div class="workspace-project-name">${escapeHtml(p.name || window.electron_nodeModules.path.basename(p.path))}</div>
        <div class="workspace-project-path">${escapeHtml(p.path)}</div>
      </div>
    </div>
  `).join('');

  document.body.appendChild(dropdown);

  // Click to add
  dropdown.querySelectorAll('.workspace-project-item').forEach(item => {
    item.addEventListener('click', () => {
      const wsState = require('../../state/workspace.state');
      wsState.addProjectToWorkspace(ws.id, item.dataset.pid);
      dropdown.remove();
    });
  });

  // Close on outside click
  const closeDropdown = (e) => {
    if (!dropdown.contains(e.target) && e.target !== btn) {
      dropdown.remove();
      document.removeEventListener('click', closeDropdown);
    }
  };
  setTimeout(() => document.addEventListener('click', closeDropdown), 0);
}

function showNewDocModal(workspaceId) {
  const modal = createGenericModal();
  modal.innerHTML = `
    <div class="modal-overlay" id="ws-doc-modal-overlay">
      <div class="modal-dialog" style="width:380px">
        <div class="modal-header">
          <h3>${escapeHtml(t('workspace.newDoc'))}</h3>
          <button class="modal-close" id="ws-doc-modal-close">${ICONS.close}</button>
        </div>
        <div class="modal-body" style="padding:16px">
          <label style="font-size:var(--font-sm);color:var(--text-secondary);margin-bottom:4px;display:block">${escapeHtml(t('workspace.docTitle'))}</label>
          <input type="text" id="ws-doc-title" class="workspace-search-input" placeholder="${escapeHtml(t('workspace.docTitlePlaceholder'))}">
        </div>
        <div class="modal-footer" style="padding:12px 16px;display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--border-color)">
          <button class="workspace-btn workspace-btn-secondary" id="ws-doc-cancel">Cancel</button>
          <button class="workspace-btn workspace-btn-primary" id="ws-doc-create">Create</button>
        </div>
      </div>
    </div>
  `;
  modal.style.display = 'block';

  const closeModal = () => { modal.style.display = 'none'; };
  document.getElementById('ws-doc-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('ws-doc-cancel')?.addEventListener('click', closeModal);
  document.getElementById('ws-doc-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'ws-doc-modal-overlay') closeModal();
  });

  document.getElementById('ws-doc-create')?.addEventListener('click', async () => {
    const title = document.getElementById('ws-doc-title')?.value?.trim();
    if (!title) return;
    const wsState = require('../../state/workspace.state');
    const doc = await wsState.addDoc(workspaceId, { title, content: `# ${title}\n\n` });
    closeModal();
    // Open editor for the new doc
    wsState.workspaceState.set({ editingDocId: doc.id });
    _view = 'editor';
    render();
  });

  setTimeout(() => document.getElementById('ws-doc-title')?.focus(), 50);
}

function showAddLinkModal(workspaceId, projects, docs) {
  const modal = createGenericModal();
  const entities = [
    ...projects.map(p => ({ type: 'project', id: p.id, name: p.name || window.electron_nodeModules.path.basename(p.path) })),
    ...docs.map(d => ({ type: 'doc', id: d.id, name: d.title })),
  ];
  const labels = ['implements', 'depends-on', 'related', 'extends', 'replaces'];

  const optionsHtml = entities.map(e => `<option value="${e.type}:${escapeHtml(e.id)}">${escapeHtml(e.type === 'doc' ? '📄 ' : '📁 ')}${escapeHtml(e.name)}</option>`).join('');
  const labelsHtml = labels.map(l => `<option value="${l}">${escapeHtml(t(`workspace.linkLabels.${l}`))}</option>`).join('');

  modal.innerHTML = `
    <div class="modal-overlay" id="ws-link-modal-overlay">
      <div class="modal-dialog" style="width:420px">
        <div class="modal-header">
          <h3>${escapeHtml(t('workspace.addLink'))}</h3>
          <button class="modal-close" id="ws-link-modal-close">${ICONS.close}</button>
        </div>
        <div class="modal-body" style="padding:16px;display:flex;flex-direction:column;gap:12px">
          <div>
            <label style="font-size:var(--font-sm);color:var(--text-secondary);margin-bottom:4px;display:block">${escapeHtml(t('workspace.linkSource'))}</label>
            <select id="ws-link-source" class="workspace-search-input" style="padding:6px 10px">${optionsHtml}</select>
          </div>
          <div>
            <label style="font-size:var(--font-sm);color:var(--text-secondary);margin-bottom:4px;display:block">${escapeHtml(t('workspace.linkLabel'))}</label>
            <select id="ws-link-label" class="workspace-search-input" style="padding:6px 10px">${labelsHtml}</select>
          </div>
          <div>
            <label style="font-size:var(--font-sm);color:var(--text-secondary);margin-bottom:4px;display:block">${escapeHtml(t('workspace.linkTarget'))}</label>
            <select id="ws-link-target" class="workspace-search-input" style="padding:6px 10px">${optionsHtml}</select>
          </div>
          <div>
            <label style="font-size:var(--font-sm);color:var(--text-secondary);margin-bottom:4px;display:block">${escapeHtml(t('workspace.linkDescription'))}</label>
            <input type="text" id="ws-link-desc" class="workspace-search-input" placeholder="">
          </div>
        </div>
        <div class="modal-footer" style="padding:12px 16px;display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--border-color)">
          <button class="workspace-btn workspace-btn-secondary" id="ws-link-cancel">Cancel</button>
          <button class="workspace-btn workspace-btn-primary" id="ws-link-create">${escapeHtml(t('workspace.addLink'))}</button>
        </div>
      </div>
    </div>
  `;
  modal.style.display = 'block';

  const closeModal = () => { modal.style.display = 'none'; };
  document.getElementById('ws-link-modal-close')?.addEventListener('click', closeModal);
  document.getElementById('ws-link-cancel')?.addEventListener('click', closeModal);
  document.getElementById('ws-link-modal-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'ws-link-modal-overlay') closeModal();
  });

  document.getElementById('ws-link-create')?.addEventListener('click', async () => {
    const sourceVal = document.getElementById('ws-link-source')?.value;
    const targetVal = document.getElementById('ws-link-target')?.value;
    const label = document.getElementById('ws-link-label')?.value;
    const description = document.getElementById('ws-link-desc')?.value?.trim() || '';

    if (!sourceVal || !targetVal || !label) return;

    const [sourceType, sourceId] = sourceVal.split(':');
    const [targetType, targetId] = targetVal.split(':');

    const wsState = require('../../state/workspace.state');
    await wsState.addLink(workspaceId, { sourceType, sourceId, targetType, targetId, label, description });
    closeModal();
  });
}

// ========== HELPERS ==========

function bindCreate(btnId) {
  document.getElementById(btnId)?.addEventListener('click', () => showCreateEditModal());
}

module.exports = { init, loadPanel, cleanup };
