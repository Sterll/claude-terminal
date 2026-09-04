/**
 * ArtifactsPanel
 *
 * The artifact library: everything Claude has produced across every session and
 * every project, not just the conversation currently open. The per-session view
 * lives in the chat's Artifacts tab (ChatView); this is the archive behind it.
 *
 * Reads the same store the chat writes to (src/shared/artifact-store.js via the
 * `artifacts` IPC namespace), and refreshes on `artifacts-changed` so a delete
 * made by an MCP tool in another process shows up here without a manual reload.
 *
 * Selection is by group rather than by row: the list shows one entry per
 * artifact with a v1/v2/v3 switcher, because a rewritten page is the same
 * artifact, not a new one.
 */

const { t } = require('../../i18n');
const { escapeHtml } = require('../../utils');
const MarkdownRenderer = require('../../services/MarkdownRenderer');

const api = window.electron_api;

let _container = null;
let _unsubscribeChanged = null;
// The list currently displayed: newest version of each artifact, filtered.
let _rows = [];
let _versions = [];
let _selectedId = null;
let _filter = { query: '', kind: '', projectId: '' };
let _stats = null;
let _loadError = null;

const KIND_LABEL = {
  html: 'HTML', svg: 'SVG', mermaid: 'Diagram', code: 'Code', file: 'File',
};

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
    const [listRes, statsRes] = await Promise.all([
      api.artifacts.list({ ...(_filter.query ? { query: _filter.query } : {}),
                           ...(_filter.kind ? { kind: _filter.kind } : {}),
                           ...(_filter.projectId ? { projectId: _filter.projectId } : {}),
                           latestOnly: true }),
      api.artifacts.stats(),
    ]);
    if (!listRes.success) throw new Error(listRes.error);
    _rows = listRes.artifacts || [];
    _stats = statsRes.success ? statsRes.stats : null;
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
  const kinds = ['', 'html', 'svg', 'mermaid', 'code', 'file'];
  const kindOptions = kinds.map(k => `
    <option value="${k}"${_filter.kind === k ? ' selected' : ''}>
      ${escapeHtml(k ? (KIND_LABEL[k] || k) : (t('artifacts.allKinds') || 'All kinds'))}
    </option>`).join('');

  const projects = [...new Map(_rows.map(r => [r.projectId, r.projectName])).entries()]
    .filter(([id]) => id);
  const projectOptions = [`<option value="">${escapeHtml(t('artifacts.allProjects') || 'All projects')}</option>`]
    .concat(projects.map(([id, name]) => `
      <option value="${escapeHtml(id)}"${_filter.projectId === id ? ' selected' : ''}>${escapeHtml(name || id)}</option>`))
    .join('');

  _container.innerHTML = `
    <div class="artifacts-panel">
      <div class="artifacts-header">
        <h2 class="artifacts-title">${escapeHtml(t('artifacts.libraryTitle') || 'Artifacts')}</h2>
        ${_stats ? `
          <div class="artifacts-stats">
            <span><strong>${_stats.total}</strong> ${escapeHtml(t('artifacts.stored') || 'stored')}</span>
            <span><strong>${_formatBytes(_stats.bytes)}</strong></span>
            <span><strong>${_stats.projects}</strong> ${escapeHtml(t('artifacts.projects') || 'projects')}</span>
          </div>` : ''}
      </div>

      ${_loadError ? `<div class="artifacts-error">${escapeHtml(_loadError)}</div>` : ''}

      <div class="artifacts-toolbar">
        <input type="search" class="artifacts-search" id="artifacts-search"
               placeholder="${escapeHtml(t('common.search') || 'Search')}"
               value="${escapeHtml(_filter.query)}" spellcheck="false" />
        <select class="artifacts-select" id="artifacts-kind">${kindOptions}</select>
        <select class="artifacts-select" id="artifacts-project">${projectOptions}</select>
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
    listEl.innerHTML = `<div class="artifacts-empty">${escapeHtml(t('artifacts.emptyLibrary') || 'No artifacts yet. They appear here as Claude produces them.')}</div>`;
    return;
  }

  listEl.innerHTML = _rows.map((a) => `
    <button class="artifacts-row${a.id === _selectedId ? ' active' : ''}" data-id="${escapeHtml(a.id)}">
      <span class="artifacts-row-kind" data-kind="${escapeHtml(a.kind)}">${escapeHtml(KIND_LABEL[a.kind] || a.kind)}</span>
      <span class="artifacts-row-main">
        <span class="artifacts-row-title">${escapeHtml(a.title)}</span>
        <span class="artifacts-row-meta">
          ${a.projectName ? `<span>${escapeHtml(a.projectName)}</span><span class="artifacts-dot">•</span>` : ''}
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
    detailEl.innerHTML = `<div class="artifacts-empty">${escapeHtml(t('artifacts.selectPrompt') || 'Select an artifact to preview it.')}</div>`;
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
        <span class="artifacts-row-kind" data-kind="${escapeHtml(artifact.kind)}">${escapeHtml(KIND_LABEL[artifact.kind] || artifact.kind)}</span>
        <span class="artifacts-detail-title" title="${escapeHtml(artifact.title)}">${escapeHtml(artifact.title)}</span>
      </div>
      <div class="artifacts-detail-meta">
        ${artifact.projectName ? `<span>${escapeHtml(artifact.projectName)}</span>` : ''}
        <span>${_formatBytes(artifact.bytes)}</span>
        <span>${artifact.lines} ${escapeHtml(t('artifacts.lines') || 'lines')}</span>
      </div>
      ${versionChips}
      <div class="artifacts-detail-actions">
        <button class="artifacts-btn" data-action="copy">${escapeHtml(t('common.copy') || 'Copy')}</button>
        <button class="artifacts-btn" data-action="save">${escapeHtml(t('artifacts.saveAs') || 'Save as...')}</button>
        <button class="artifacts-btn artifacts-btn--danger" data-action="delete">${escapeHtml(t('common.delete') || 'Delete')}</button>
      </div>
    </div>
    <div class="artifacts-detail-body" id="artifacts-detail-body"></div>
  `;

  const bodyEl = detailEl.querySelector('#artifacts-detail-body');
  bodyEl.innerHTML = MarkdownRenderer.render(_asMarkdown(artifact));
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

  _container.querySelector('#artifacts-kind')?.addEventListener('change', (e) => {
    _filter.kind = e.target.value;
    _load();
  });

  _container.querySelector('#artifacts-project')?.addEventListener('change', (e) => {
    _filter.projectId = e.target.value;
    _load();
  });

  _container.querySelector('#artifacts-list')?.addEventListener('click', (e) => {
    const row = e.target.closest('.artifacts-row');
    if (row?.dataset.id) _select(row.dataset.id);
  });
}

// ── Panel API ───────────────────────────────────────────────────────────────

function loadPanel(container) {
  _container = container;
  _load();

  // MCP tools mutate the store from another process; the main process watches
  // index.json and forwards the change here.
  if (!_unsubscribeChanged && api?.artifacts?.onChanged) {
    _unsubscribeChanged = api.artifacts.onChanged(() => {
      if (_container) _load();
    });
  }
}

function cleanup() {
  if (_unsubscribeChanged) {
    _unsubscribeChanged();
    _unsubscribeChanged = null;
  }
}

module.exports = { loadPanel, cleanup };
