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
 *
 * A markdown file has two readings and the pane offers both. "Rendered" is the
 * default because that is what a README is for; "Source" is what you want the
 * moment the rendering is the thing you are editing, and the markdown viewer
 * in a terminal tab has had that toggle all along. The two live in the same
 * mode group as the diff, so a file the session touched can be read three
 * ways from one control.
 */

const { escapeHtml, highlight, getFileIcon } = require('../../utils');
const { t } = require('../../i18n');
const DiffRenderer = require('../../services/DiffRenderer');
const MarkdownRenderer = require('../../services/MarkdownRenderer');
const { getSetting, setSetting } = require('../../state');
const { openInEditor } = require('../../utils/editor');

// Reading a whole file into the DOM has a ceiling; past this we show the head
// and point at the editor.
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_LINES = 5000;

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'avif']);
const HANDOFF_EXTS = new Set(['pdf', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'flac', 'aac', 'ogg', 'obj', 'stl', 'gltf', 'glb']);
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx']);

const ICONS = {
  reload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>',
  openTab: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  openEditor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg>',
  split: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="1"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
  unified: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="1"/><line x1="3" y1="12" x2="21" y2="12"/></svg>',
};

let _state = null; // { filePath, change, mode, diffMode }

function extOf(filePath) {
  const base = String(filePath || '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

function isMarkdown(filePath) {
  return MARKDOWN_EXTS.has(extOf(filePath));
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Which readings this file offers, in tab order.
 *
 * `content` is always one of them; it is only worth *showing* the group when
 * there is somewhere else to go, which is what keeps a plain .js file free of
 * a one-button tablist.
 */
function _modesFor(filePath, change) {
  const modes = ['content'];
  if (isMarkdown(filePath)) modes.push('source');
  if (change) modes.push('diff');
  return modes;
}

function _modeLabel(mode, filePath) {
  if (mode === 'diff') return t('files.viewDiff');
  if (mode === 'source') return t('files.viewSource');
  return isMarkdown(filePath) ? t('files.viewRendered') : t('files.viewContent');
}

function _headerHtml(filePath, change, mode, diffMode, meta) {
  const base = filePath.split(/[\\/]/).pop();
  const dir = filePath.slice(0, filePath.length - base.length);
  const icon = getFileIcon(base, false, false);

  const stats = change
    ? `<span class="fv-stats"><span class="chat-change-add">+${change.additions}</span><span class="chat-change-del">-${change.deletions}</span></span>`
    : (meta ? `<span class="fv-meta">${escapeHtml(meta)}</span>` : '');

  const modes = _modesFor(filePath, change);
  const modeToggle = modes.length > 1 ? `
    <div class="fv-modes" role="tablist">
      ${modes.map(m => `<button class="fv-mode${mode === m ? ' active' : ''}" data-mode="${m}" role="tab" aria-selected="${mode === m}">${escapeHtml(_modeLabel(m, filePath))}</button>`).join('')}
    </div>` : '';

  const diffLayout = (change && mode === 'diff') ? `
    <button class="fv-action" data-action="toggle-split" title="${escapeHtml(t('files.toggleSplit'))}">
      ${diffMode === 'split' ? ICONS.split : ICONS.unified}
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
      <button class="fv-action" data-action="reload" title="${escapeHtml(t('files.reloadFromDisk'))}">
        ${ICONS.reload}
      </button>
      <button class="fv-action" data-action="open-tab" title="${escapeHtml(t('files.openInTab'))}">
        ${ICONS.openTab}
      </button>
      <button class="fv-action" data-action="open-editor" title="${escapeHtml(t('files.openInEditor'))}">
        ${ICONS.openEditor}
      </button>
    </div>`;
}

/** Line-numbered, syntax-highlighted text. The fallback for everything that is
 *  not an image, a handoff format or rendered markdown. */
function _textBodyHtml(content, ext) {
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

async function _bodyHtml(filePath, change, mode, diffMode) {
  if (mode === 'diff') {
    if (!change || !change.hunks || !change.hunks.length) {
      return `<div class="fv-empty">${escapeHtml(t('chat.noDiffAvailable'))}</div>`;
    }
    return DiffRenderer.renderPatch(change.hunks, { filePath, mode: diffMode });
  }

  const ext = extOf(filePath);
  const fileUrl = 'file:///' + filePath.replace(/\\/g, '/').replace(/^\//, '');

  // Source mode is only ever reachable for markdown, so these two never apply
  // to it; guarding anyway keeps the branch honest if the mode ever widens.
  if (mode !== 'source') {
    if (IMAGE_EXTS.has(ext)) {
      return `<div class="fv-media"><img src="${escapeHtml(fileUrl)}" alt="${escapeHtml(filePath)}" draggable="false" /></div>`;
    }
    if (HANDOFF_EXTS.has(ext)) {
      return `<div class="fv-empty">
        <p>${escapeHtml(t('files.previewInTab'))}</p>
        <button class="fv-handoff" data-action="open-tab">${escapeHtml(t('files.openInTab'))}</button>
      </div>`;
    }
  }

  const { fs } = window.electron_nodeModules;
  let content;
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_CONTENT_BYTES) {
      return `<div class="fv-empty"><p>${escapeHtml(t('files.tooLarge', { size: fmtSize(stat.size) }))}</p>
        <button class="fv-handoff" data-action="open-editor">${escapeHtml(t('files.openInEditor'))}</button></div>`;
    }
    content = await fs.promises.readFile(filePath, 'utf8');
  } catch (e) {
    return `<div class="fv-empty fv-error">${escapeHtml(e.message)}</div>`;
  }

  if (isMarkdown(filePath) && mode !== 'source') {
    try {
      // `chat-msg-content` is where every markdown rule in the app lives
      // (headings, lists, blockquotes, tables). The class this used to carry,
      // `chat-markdown`, matches nothing in any stylesheet, so the pane was
      // painting correct markup with browser-default typography and no
      // spacing at all.
      return `<div class="fv-markdown chat-msg-content">${MarkdownRenderer.render(content)}</div>`;
    } catch {
      // Fall through to the plain-text path rather than showing nothing.
    }
  }

  return _textBodyHtml(content, ext);
}

function _wire(container, project) {
  // The copy button, the line-numbers toggle and the block collapsers that
  // MarkdownRenderer emits are inert markup on their own: they all rely on the
  // delegated handler this installs. The pane painted them without it, so they
  // were visible, hoverable and dead.
  // Guarded because _wire() runs for every file opened in the pane and
  // attachInteractivity() adds a listener rather than replacing one: stacked
  // handlers would copy once per file previously viewed there.
  if (!container.dataset.interactivityAttached) {
    container.dataset.interactivityAttached = 'true';
    MarkdownRenderer.attachInteractivity(container);
  }

  container.onclick = async (e) => {
    const btn = e.target.closest('[data-mode], [data-action]');
    if (!btn || !_state) return;

    if (btn.dataset.mode) {
      if (btn.dataset.mode === _state.mode) return;
      _state.mode = btn.dataset.mode;
      // Remembered so reading a second markdown file does not put the reader
      // back in a view they just switched out of.
      //
      // Only from a markdown file: a touched `.js` also has a `content` mode
      // (its half of Content | Diff), and leaving Diff on one would otherwise
      // reset a saved "Source" preference that has nothing to do with it.
      if (isMarkdown(_state.filePath)
        && (btn.dataset.mode === 'source' || btn.dataset.mode === 'content')) {
        setSetting('filesMarkdownMode', btn.dataset.mode === 'source' ? 'source' : 'rendered');
      }
      await _paint(container, project);
      return;
    }

    switch (btn.dataset.action) {
      case 'toggle-split':
        _state.diffMode = _state.diffMode === 'split' ? 'unified' : 'split';
        setSetting('filesDiffMode', _state.diffMode);
        await _paint(container, project);
        break;
      case 'reload':
        // Nothing is cached here, so a repaint *is* a reload: the body is read
        // off disk every time. Keeping the scroll position is what makes it
        // usable while editing the file in another window.
        await _paint(container, project, { keepScroll: true });
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
        openInEditor(_state.filePath);
        break;
    }
  };
}

async function _paint(container, project, opts = {}) {
  const { filePath, change, mode, diffMode } = _state;
  const keepScroll = opts.keepScroll ? (container.querySelector('.fv-body')?.scrollTop || 0) : 0;

  container.innerHTML = _headerHtml(filePath, change, mode, diffMode, null)
    + `<div class="fv-body"><div class="fv-empty">${escapeHtml(t('common.loading'))}</div></div>`;
  const body = await _bodyHtml(filePath, change, mode, diffMode);
  // A different file may have been picked while we read this one.
  if (_state.filePath !== filePath || _state.mode !== mode) return;
  const bodyEl = container.querySelector('.fv-body');
  if (!bodyEl) return;
  bodyEl.innerHTML = body;
  // Mermaid diagrams, math and HTML previews are placeholders until this runs.
  MarkdownRenderer.postProcess(bodyEl);
  if (keepScroll) bodyEl.scrollTop = keepScroll;
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
  const markdownSource = isMarkdown(filePath) && getSetting('filesMarkdownMode') === 'source';
  _state = {
    filePath,
    change: opts.change || null,
    mode: opts.change && opts.initialMode === 'diff' ? 'diff' : (markdownSource ? 'source' : 'content'),
    diffMode: getSetting('filesDiffMode') === 'split' ? 'split' : 'unified',
  };
  _wire(container, opts.project);
  await _paint(container, opts.project);
}

module.exports = { render };
