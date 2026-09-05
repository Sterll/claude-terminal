/**
 * ArtifactsPanel
 *
 * The gallery of PUBLISHED artifacts for the current project — the local
 * equivalent of the artifact list in Claude Desktop. These come from the Agent
 * SDK's `Artifact` tool, which uploads an .html or .md file to claude.ai and
 * returns a shareable URL, so each one has a real title, a subtitle, a
 * browser-tab emoji and a link that opens in a browser.
 *
 * Deliberately NOT the extracts. The store also holds everything harvested from
 * conversations (HTML blocks, diagrams, long code blocks, written files), but
 * those belong to the conversation that produced them and are shown in the
 * chat's Documents tab. Listing both here would blur two different things: one
 * is something the user published on purpose, the other is a by-product of a
 * chat. They stay in the store for the artifact_* MCP tools, which is what lets
 * a later session find a page built weeks ago.
 *
 * Scope comes from the project bar, never from a picker of its own: artifacts
 * belong to a project, so the panel follows the same "work in this project"
 * switch the Git and Dashboard tabs follow (see applyProjectContext in
 * renderer.js). A panel-local project dropdown would have been a second,
 * competing notion of "current project".
 *
 * Refreshes on `artifacts-changed`, so a publish made in a chat — or a delete
 * made by an MCP tool in another process — shows up without a manual reload.
 *
 * Selection is by group rather than by row: the list shows one entry per
 * artifact with a v1/v2/v3 switcher, because a republished page is a new
 * version of the same artifact, not a new one.
 */

const { t } = require('../../i18n');
const { escapeHtml } = require('../../utils');
const MarkdownRenderer = require('../../services/MarkdownRenderer');

const api = window.electron_api;

let _container = null;
let _unsubscribeChanged = null;
// The project the panel is scoped to, mirrored from the project bar.
let _project = null;
// The list currently displayed: newest version of each artifact, filtered.
let _rows = [];
let _versions = [];
let _selectedId = null;
let _filter = { query: '' };
let _loadError = null;

const LANG_BY_EXT = {
  js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', py: 'python',
  rs: 'rust', go: 'go', java: 'java', rb: 'ruby', php: 'php', cs: 'csharp',
  cpp: 'cpp', c: 'c', lua: 'lua', sql: 'sql', sh: 'bash', json: 'json',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml', css: 'css',
  scss: 'scss', md: 'markdown', html: 'html', svg: 'svg',
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function _timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return '';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
}

function _formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function _errorText(e) {
  return String((e && e.message) || e || '')
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim();
}

/**
 * Fence an artifact back into markdown so the normal renderer displays it.
 * Same trick as the chat's split-pane: the HTML preview, Mermaid renderer, SVG
 * sanitizer and syntax highlighter already exist as markdown blocks, and
 * re-rendering re-registers the ct-preview:// document rather than reusing a
 * URL that the bounded preview LRU may already have evicted.
 */
function _asMarkdown(artifact) {
  const langByKind = { html: 'html', svg: 'svg', mermaid: 'mermaid' };
  let lang = langByKind[artifact.kind] || artifact.lang || '';
  if (artifact.kind === 'file') {
    const ext = String(artifact.title || '').split('.').pop().toLowerCase();
    lang = LANG_BY_EXT[ext] || '';
  }
  const longestRun = (artifact.source.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${lang}\n${artifact.source}\n${fence}`;
}

// ── Data ────────────────────────────────────────────────────────────────────

async function _load() {
  if (!api?.artifacts) {
    _loadError = 'Artifact store unavailable';
    _render();
    return;
  }
  try {
    const listRes = await api.artifacts.list({
      // No project on the bar means nothing is scoped yet, not "show me
      // everything" — an unscoped list here would contradict the tab living in
      // the Project section.
      projectId: _project?.id || '__none__',
      // Published only. Conversation extracts live in the chat's Documents tab;
      // this screen is the published gallery.
      kind: 'published',
      ...(_filter.query ? { query: _filter.query } : {}),
      latestOnly: true,
    });
    if (!listRes.success) throw new Error(listRes.error);
    _rows = listRes.artifacts || [];
    _loadError = null;
  } catch (e) {
    console.error('[ArtifactsPanel] load failed:', e);
    _loadError = _errorText(e);
  }
  // Drop a selection that no longer has a home in the list — either it was
  // deleted elsewhere, or the filter just excluded it. An older version stays
  // selected as long as its group is still listed.
  const selectedGroup = [..._rows, ..._versions].find(a => a.id === _selectedId)?.groupKey;
  if (_selectedId && !_rows.some(r => r.groupKey === selectedGroup)) {
    _selectedId = null;
    _versions = [];
  }
  _render();
}

async function _select(id) {
  _selectedId = id;
  const row = _rows.find(r => r.id === id) || _versions.find(v => v.id === id);
  if (row) {
    const res = await api.artifacts.versions(row.groupKey);
    _versions = res.success ? res.versions : [];
  }
  _renderList();
  _renderDetail();
}

// ── Render ──────────────────────────────────────────────────────────────────

function _render() {
  if (!_container) return;
  // No kind filter: this screen is published artifacts only, so the picker
  // would have had a single entry.
  _container.innerHTML = `
    <div class="artifacts-panel">
      <div class="artifacts-header">
        <h2 class="artifacts-title">${escapeHtml(t('artifacts.libraryTitle') || 'Artifacts')}</h2>
        <div class="artifacts-stats">
          <span><strong>${_rows.length}</strong> ${escapeHtml(t('artifacts.publishedCount') || 'published in this project')}</span>
        </div>
      </div>

      ${_loadError ? `<div class="artifacts-error">${escapeHtml(_loadError)}</div>` : ''}

      <div class="artifacts-toolbar">
        <input type="search" class="artifacts-search" id="artifacts-search"
               placeholder="${escapeHtml(t('common.search') || 'Search')}"
               value="${escapeHtml(_filter.query)}" spellcheck="false" />
      </div>

      <div class="artifacts-body">
        <div class="artifacts-list" id="artifacts-list"></div>
        <div class="artifacts-detail" id="artifacts-detail"></div>
      </div>
    </div>
  `;

  _renderList();
  _renderDetail();
  _bind();
}

function _renderList() {
  const listEl = _container?.querySelector('#artifacts-list');
  if (!listEl) return;

  if (!_rows.length) {
    listEl.innerHTML = `<div class="artifacts-empty">${escapeHtml(t('artifacts.emptyLibrary') || 'No published artifacts in this project. They appear here when Claude publishes a page with the Artifact tool.')}</div>`;
    return;
  }

  // Every row is a publish, so the emoji the Artifact tool carries is the
  // identity — the format badge falls back only when a publish had none.
  listEl.innerHTML = _rows.map((a) => `
    <button class="artifacts-row${a.id === _selectedId ? ' active' : ''}" data-id="${escapeHtml(a.id)}">
      ${a.favicon
        ? `<span class="artifacts-row-favicon">${escapeHtml(a.favicon)}</span>`
        : `<span class="artifacts-row-kind" data-kind="published">${escapeHtml(a.lang === 'markdown' ? 'MD' : 'HTML')}</span>`}
      <span class="artifacts-row-main">
        <span class="artifacts-row-title">${escapeHtml(a.title)}</span>
        ${a.description ? `<span class="artifacts-row-desc">${escapeHtml(a.description)}</span>` : ''}
        <span class="artifacts-row-meta">
          <span>${a.lines} ${escapeHtml(t('artifacts.lines') || 'lines')}</span>
          <span class="artifacts-dot">•</span>
          <span>${escapeHtml(_timeAgo(a.createdAt))}</span>
        </span>
      </span>
      ${(a.version || 1) > 1 ? `<span class="artifacts-row-version">v${a.version}</span>` : ''}
    </button>`).join('');
}

async function _renderDetail() {
  const detailEl = _container?.querySelector('#artifacts-detail');
  if (!detailEl) return;

  if (!_selectedId) {
    detailEl.innerHTML = _rows.length
      ? `<div class="artifacts-empty">${escapeHtml(t('artifacts.selectPrompt') || 'Select an artifact to preview it.')}</div>`
      : '';
    return;
  }

  const requestedId = _selectedId;
  const res = await api.artifacts.get(requestedId);
  // Two renders can be in flight (a click while a refresh is loading); the
  // slower one must not paint over the newer selection.
  if (requestedId !== _selectedId) return;
  if (!res.success) {
    detailEl.innerHTML = `<div class="artifacts-error">${escapeHtml(res.error)}</div>`;
    return;
  }
  const artifact = res.artifact;

  const versionChips = _versions.length > 1
    ? `<div class="artifacts-versions">${_versions.map(v => `
        <button class="artifacts-version${v.id === _selectedId ? ' active' : ''}" data-version-id="${escapeHtml(v.id)}"
                title="${escapeHtml(_timeAgo(v.createdAt))}">v${v.version}</button>`).join('')}</div>`
    : '';

  detailEl.innerHTML = `
    <div class="artifacts-detail-head">
      <div class="artifacts-detail-title-row">
        ${artifact.favicon
          ? `<span class="artifacts-row-favicon">${escapeHtml(artifact.favicon)}</span>`
          : `<span class="artifacts-row-kind" data-kind="published">${escapeHtml(artifact.lang === 'markdown' ? 'MD' : 'HTML')}</span>`}
        <span class="artifacts-detail-title" title="${escapeHtml(artifact.title)}">${escapeHtml(artifact.title)}</span>
      </div>
      ${artifact.description ? `<div class="artifacts-detail-desc">${escapeHtml(artifact.description)}</div>` : ''}
      <div class="artifacts-detail-meta">
        <span>${_formatBytes(artifact.bytes)}</span>
        <span>${artifact.lines} ${escapeHtml(t('artifacts.lines') || 'lines')}</span>
        ${artifact.url ? `<span class="artifacts-detail-url" title="${escapeHtml(artifact.url)}">${escapeHtml(artifact.url)}</span>` : ''}
      </div>
      ${versionChips}
      <div class="artifacts-detail-actions">
        <button class="artifacts-btn" data-action="copy">${escapeHtml(t('common.copy') || 'Copy')}</button>
        <button class="artifacts-btn" data-action="save">${escapeHtml(t('artifacts.saveAs') || 'Save as...')}</button>
        ${artifact.url ? `<button class="artifacts-btn" data-action="open-url">${escapeHtml(t('artifacts.openPublished') || 'Open published page')}</button>` : ''}
        <button class="artifacts-btn artifacts-btn--danger" data-action="delete">${escapeHtml(t('common.delete') || 'Delete')}</button>
      </div>
    </div>
    <div class="artifacts-detail-body" id="artifacts-detail-body"></div>
  `;

  const bodyEl = detailEl.querySelector('#artifacts-detail-body');
  // A published Markdown page IS a document — render it as one rather than
  // fencing it into a code block showing its own syntax.
  const isMarkdownDoc = artifact.kind === 'published' && artifact.lang === 'markdown';
  bodyEl.innerHTML = MarkdownRenderer.render(isMarkdownDoc ? artifact.source : _asMarkdown(artifact));
  bodyEl.classList.toggle('artifacts-doc', isMarkdownDoc);
  MarkdownRenderer.postProcess(bodyEl);

  detailEl.querySelector('.artifacts-detail-head').addEventListener('click', (e) => {
    const version = e.target.closest('[data-version-id]');
    if (version) { _select(version.dataset.versionId); return; }
    const btn = e.target.closest('[data-action]');
    if (btn) _runAction(btn.dataset.action, artifact);
  });
}

async function _runAction(action, artifact) {
  const Toast = require('../components/Toast');
  switch (action) {
    case 'copy':
      try {
        await navigator.clipboard.writeText(artifact.source);
        Toast.showToast({ message: t('common.copied') || 'Copied', type: 'success' });
      } catch (e) {
        Toast.showToast({ message: _errorText(e), type: 'error' });
      }
      break;
    case 'save': {
      const filePath = await api.dialog.saveFileDialog({
        title: t('artifacts.saveAs') || 'Save as...',
        defaultPath: artifact.title,
      });
      if (!filePath) break;
      try {
        const { fsp } = require('../../utils/fs-async');
        await fsp.writeFile(filePath, artifact.source, 'utf8');
        Toast.showToast({ message: t('artifacts.saved') || 'Artifact saved', type: 'success' });
      } catch (e) {
        Toast.showToast({ message: _errorText(e), type: 'error' });
      }
      break;
    }
    case 'open-url':
      if (artifact.url) api.dialog.openExternal(artifact.url);
      break;
    case 'delete': {
      const res = await api.artifacts.delete(artifact.id);
      if (!res.success) {
        Toast.showToast({ message: res.error, type: 'error' });
        break;
      }
      _selectedId = null;
      _versions = [];
      await _load();
      break;
    }
    default:
      break;
  }
}

function _bind() {
  const searchEl = _container.querySelector('#artifacts-search');
  let debounce = null;
  searchEl?.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      _filter.query = searchEl.value.trim();
      _load();
    }, 200);
  });

  _container.querySelector('#artifacts-list')?.addEventListener('click', (e) => {
    const row = e.target.closest('.artifacts-row');
    if (row?.dataset.id) _select(row.dataset.id);
  });
}

// ── Panel API ───────────────────────────────────────────────────────────────

function loadPanel(container, project = null) {
  _container = container;
  _project = project;

  // Markdown block handlers (Preview/Code toggle, viewport buttons, copy,
  // external links) are delegated per container and postProcess() does not set
  // them up. Attached on the panel root, which survives every re-render, and
  // guarded so re-entering the tab does not stack listeners.
  if (!container.dataset.interactivityAttached) {
    container.dataset.interactivityAttached = 'true';
    MarkdownRenderer.attachInteractivity(container);
  }

  _load();

  // MCP tools mutate the store from another process; the main process watches
  // index.json and forwards the change here.
  if (!_unsubscribeChanged && api?.artifacts?.onChanged) {
    _unsubscribeChanged = api.artifacts.onChanged(() => {
      if (_container) _load();
    });
  }
}

/**
 * Follow the project bar. Called from applyProjectContext when the user
 * switches project while this tab is showing; a no-op otherwise, since
 * loadPanel() re-reads the bar on activate.
 */
function setProject(project) {
  if (!_container) return;
  if (_project?.id === project?.id) return;
  _project = project;
  _selectedId = null;
  _versions = [];
  _load();
}

function cleanup() {
  if (_unsubscribeChanged) {
    _unsubscribeChanged();
    _unsubscribeChanged = null;
  }
}

module.exports = { loadPanel, setProject, cleanup };
