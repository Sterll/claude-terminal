/**
 * File Viewer
 *
 * The right-hand pane of the Files screen: a file's contents, or — when the
 * selected session touched it — the diff that session applied.
 *
 * Scope is deliberate. Text, markdown and images render here; PDF, 3D models,
 * audio and video hand off to `openFileTab`, which already carries the
 * bootstrapping those need. Duplicating it would be a lot of code for formats
 * you rarely browse a diff of.
 */

const { escapeHtml, highlight, getFileIcon } = require('../../utils');
const { t } = require('../../i18n');
const api = window.electron_api;
const DiffRenderer = require('../../services/DiffRenderer');
const MarkdownRenderer = require('../../services/MarkdownRenderer');
const { getSetting } = require('../../state');

// Reading a whole file into the DOM has a ceiling; past this we show the head
// and point at the editor.
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_LINES = 5000;

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'avif']);
const HANDOFF_EXTS = new Set(['pdf', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'flac', 'aac', 'ogg', 'obj', 'stl', 'gltf', 'glb']);

let _state = null; // { filePath, change, mode, diffMode }

function extOf(filePath) {
  const base = String(filePath || '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function _headerHtml(filePath, change, mode, diffMode, meta) {
  const base = filePath.split(/[\\/]/).pop();
  const dir = filePath.slice(0, filePath.length - base.length);
  const icon = getFileIcon(base, false, false);

  const stats = change
    ? `<span class="fv-stats"><span class="chat-change-add">+${change.additions}</span><span class="chat-change-del">-${change.deletions}</span></span>`
    : (meta ? `<span class="fv-meta">${escapeHtml(meta)}</span>` : '');

  // Only a file the session touched has a diff to switch to.
  const modeToggle = change ? `
    <div class="fv-modes" role="tablist">
      <button class="fv-mode${mode === 'content' ? ' active' : ''}" data-mode="content" role="tab">${escapeHtml(t('files.viewContent'))}</button>
      <button class="fv-mode${mode === 'diff' ? ' active' : ''}" data-mode="diff" role="tab">${escapeHtml(t('files.viewDiff'))}</button>
    </div>` : '';

  const diffLayout = (change && mode === 'diff') ? `
    <button class="fv-action" data-action="toggle-split" title="${escapeHtml(t('files.toggleSplit'))}">
      ${diffMode === 'split'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="1"/><line x1="12" y1="4" x2="12" y2="20"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="1"/><line x1="3" y1="12" x2="21" y2="12"/></svg>'}
    </button>` : '';

  return `
    <div class="fv-header">
      <span class="fv-icon">${icon}</span>
      <span class="fv-path" title="${escapeHtml(filePath)}">
        <span class="fv-base">${escapeHtml(base)}</span><span class="fv-dir">${escapeHtml(dir)}</span>
      </span>
      ${stats}
      ${modeToggle}
      ${diffLayout}
      <button class="fv-action" data-action="open-tab" title="${escapeHtml(t('files.openInTab'))}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </button>
      <button class="fv-action" data-action="open-editor" title="${escapeHtml(t('files.openInEditor'))}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg>
      </button>
    </div>`;
}

async function _bodyHtml(filePath, change, mode, diffMode) {
  if (mode === 'diff') {
    if (!change || !change.hunks || !change.hunks.length) {
      return `<div class="fv-empty">${escapeHtml(t('chat.noDiffAvailable'))}</div>`;
    }
    return DiffRenderer.renderPatch(change.hunks, { filePath, mode: diffMode });
  }

  const ext = extOf(filePath);
  const fileUrl = 'file:///' + filePath.replace(/\\/g, '/').replace(/^\//, '');

  if (IMAGE_EXTS.has(ext)) {
    return `<div class="fv-media"><img src="${escapeHtml(fileUrl)}" alt="${escapeHtml(filePath)}" draggable="false" /></div>`;
  }
  if (HANDOFF_EXTS.has(ext)) {
    return `<div class="fv-empty">
      <p>${escapeHtml(t('files.previewInTab'))}</p>
      <button class="fv-handoff" data-action="open-tab">${escapeHtml(t('files.openInTab'))}</button>
    </div>`;
  }

  const { fs } = window.electron_nodeModules;
  let content;
  let size = 0;
  try {
    const stat = await fs.promises.stat(filePath);
    size = stat.size;
    if (size > MAX_CONTENT_BYTES) {
      return `<div class="fv-empty"><p>${escapeHtml(t('files.tooLarge', { size: fmtSize(size) }))}</p>
        <button class="fv-handoff" data-action="open-editor">${escapeHtml(t('files.openInEditor'))}</button></div>`;
    }
    content = await fs.promises.readFile(filePath, 'utf8');
  } catch (e) {
    return `<div class="fv-empty fv-error">${escapeHtml(e.message)}</div>`;
  }

  if (ext === 'md') {
    try {
      return `<div class="fv-markdown chat-markdown">${MarkdownRenderer.render(content)}</div>`;
    } catch {
      // Fall through to the plain-text path rather than showing nothing.
    }
  }

  let lines = content.split('\n');
  let truncated = 0;
  if (lines.length > MAX_CONTENT_LINES) {
    truncated = lines.length - MAX_CONTENT_LINES;
    lines = lines.slice(0, MAX_CONTENT_LINES);
  }
  const shown = lines.join('\n');
  const nums = lines.map((_, i) => `<span class="fv-ln">${i + 1}</span>`).join('');
  return `<div class="fv-code">
      <div class="fv-lines">${nums}</div>
      <pre class="fv-pre"><code>${highlight(shown, ext)}</code></pre>
    </div>
    ${truncated ? `<div class="fv-truncated">${escapeHtml(t('files.linesTruncated', { count: truncated }))}</div>` : ''}`;
}

function _wire(container, project) {
  container.onclick = async (e) => {
    const btn = e.target.closest('[data-mode], [data-action]');
    if (!btn || !_state) return;

    if (btn.dataset.mode) {
      if (btn.dataset.mode === _state.mode) return;
      _state.mode = btn.dataset.mode;
      await _paint(container, project);
      return;
    }

    switch (btn.dataset.action) {
      case 'toggle-split':
        _state.diffMode = _state.diffMode === 'split' ? 'unified' : 'split';
        await _paint(container, project);
        break;
      case 'open-tab': {
        // Required lazily: TerminalManager pulls in a large graph, and the
        // Files screen must not drag it in just to be mounted.
        const TerminalManager = require('./TerminalManager');
        TerminalManager.openFileTab(_state.filePath, project);
        document.querySelector('.nav-tab[data-tab="claude"]')?.click();
        break;
      }
      case 'open-editor':
        api.dialog.openInEditor({
          editor: getSetting('editor') || 'code',
          path: _state.filePath,
        });
        break;
    }
  };
}

async function _paint(container, project) {
  const { filePath, change, mode, diffMode } = _state;
  container.innerHTML = _headerHtml(filePath, change, mode, diffMode, null)
    + `<div class="fv-body"><div class="fv-empty">${escapeHtml(t('common.loading'))}</div></div>`;
  const body = await _bodyHtml(filePath, change, mode, diffMode);
  // A different file may have been picked while we read this one.
  if (_state.filePath !== filePath || _state.mode !== mode) return;
  const bodyEl = container.querySelector('.fv-body');
  if (bodyEl) bodyEl.innerHTML = body;
}

/**
 * Show a file.
 * @param {HTMLElement} container
 * @param {string} filePath
 * @param {object} [opts]
 * @param {object} [opts.project]
 * @param {object} [opts.change] - session change entry, with `hunks`
 * @param {'content'|'diff'} [opts.initialMode]
 */
async function render(container, filePath, opts = {}) {
  _state = {
    filePath,
    change: opts.change || null,
    mode: opts.change && opts.initialMode === 'diff' ? 'diff' : 'content',
    diffMode: getSetting('filesDiffMode') === 'split' ? 'split' : 'unified',
  };
  _wire(container, opts.project);
  await _paint(container, opts.project);
}

module.exports = { render };
