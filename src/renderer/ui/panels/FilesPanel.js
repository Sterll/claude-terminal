/**
 * Files Panel
 *
 * The file explorer as a screen of its own, rather than a third column docked
 * into the Claude layout behind an unlabelled glyph. Two panes: the project
 * tree on the left, the file it selects on the right.
 *
 * The tree is still FileExplorer — 60 KB of working behaviour (ignore patterns,
 * git badges, content search, rename/create/delete, drag & drop) that would be
 * silly to rewrite. It binds to fixed ids (`file-explorer-tree`,
 * `fe-search-*`…), so this panel renders that markup and then hands over. Its
 * listeners are `onclick =` assignments re-applied on every render(), which is
 * what makes mounting it late safe.
 *
 * The session picker overlays "what did session X change" onto the same tree:
 * touched files get a +/- badge, and selecting one opens its diff rather than
 * its contents.
 */

const FileExplorer = require('../components/FileExplorer');
const FileViewer = require('../components/FileViewer');
const { escapeHtml } = require('../../utils');
const { t } = require('../../i18n');
const { getOpenProjects } = require('../../state');

const api = window.electron_api;

let _root = null;
let _project = null;
let _mounted = false;
// 'project' = the active project's tree. 'overview' = every open project at
// once, the same scope split the Dashboard has.
let _scope = 'project';

// ── Session overlay state ──
// null = show the plain tree; otherwise the sessionId whose changes decorate it.
let _sessionId = null;
let _sessionLabel = '';
let _sessionFiles = null;   // Map<path, {additions, deletions, edits, hunks}>
let _sessions = null;       // cached picker list
let _loadingSession = false;
let _modifiedOnly = false;
let _selectedPath = null;

const ICONS = {
  collapse: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 18.59L8.83 20 12 16.83 15.17 20l1.41-1.41L12 14l-4.59 4.59zM16.59 5.41L15.17 4 12 7.17 8.83 4 7.41 5.41 12 10l4.59-4.59z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>',
  chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  sort: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M3 6h18M3 12h12M3 18h6"/></svg>',
  close: '<svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 106 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>',
  diff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M5 8h14M5 16h14"/></svg>',
};

/** "il y a 3 h" style label, so the session order is visible in the menu. */
function _relativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!then || Number.isNaN(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 60) return t('time.minutesAgo', { count: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t('time.hoursAgo', { count: hours });
  return t('time.daysAgo', { count: Math.round(hours / 24) });
}

function _screenHtml() {
  return `
    <div class="files-screen">
      <div class="files-toolbar">
        <!-- No project selector here: the project bar above the screen is the
             one control for that, shared with Claude, Git, Dashboard and the
             rest of the Project group. A second one would be a second truth. -->
        <div class="files-picker files-picker--session" id="files-session">
          <button class="files-picker-btn" id="files-session-btn" aria-haspopup="menu" aria-expanded="false">
            <span class="files-picker-icon">${ICONS.history}</span>
            <span class="files-picker-caption">${escapeHtml(t('files.sessionCaption'))}</span>
            <span class="files-picker-value" id="files-session-label">${escapeHtml(t('files.noSession'))}</span>
            <span class="files-picker-arrow">${ICONS.chevronDown}</span>
          </button>
          <div class="files-picker-menu files-picker-menu--wide" id="files-session-menu" role="menu" hidden></div>
        </div>

        <span class="files-session-totals" id="files-session-totals"></span>
        <div class="files-toolbar-spacer"></div>
        <button class="btn-icon" id="btn-collapse-explorer" title="${escapeHtml(t('ui.collapseAll'))}">${ICONS.collapse}</button>
        <button class="btn-icon" id="btn-refresh-explorer" title="${escapeHtml(t('common.refresh'))}">${ICONS.refresh}</button>
      </div>

      <div class="files-body">
        <div class="files-tree-pane" id="file-explorer-panel">
          <div class="fe-search-container" id="fe-search-container">
            <span class="fe-search-icon">${ICONS.search}</span>
            <input type="text" id="fe-search-input" class="fe-search-input" placeholder="${escapeHtml(t('fileExplorer.searchPlaceholder'))}">
            <button class="fe-content-search-toggle" id="fe-content-search-toggle" title="${escapeHtml(t('fileExplorer.searchContentToggle'))}">${ICONS.file}</button>
            <button class="fe-sort-btn" id="fe-sort-btn" title="${escapeHtml(t('fileExplorer.sortFiles'))}">${ICONS.sort}</button>
            <!-- Sits with the other tree filters rather than up in the toolbar:
                 it narrows the same tree the search box does. -->
            <button class="fe-modified-btn" id="fe-modified-btn" title="${escapeHtml(t('files.modifiedOnly'))}" hidden>${ICONS.diff}</button>
            <button class="fe-search-clear" id="fe-search-clear" title="${escapeHtml(t('ui.clearSearch'))}" style="display: none;">${ICONS.close}</button>
          </div>
          <div class="file-explorer-tree" id="file-explorer-tree"></div>
          <div class="panel-resizer" id="file-explorer-resizer"></div>
        </div>
        <div class="files-viewer-pane" id="files-viewer"></div>
      </div>
    </div>`;
}

/** Empty-state when no project is open — the tree has nothing to point at. */
function _noProjectHtml() {
  return `<div class="files-empty">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
    <p>${escapeHtml(t('files.noProject'))}</p>
  </div>`;
}

// ── Session overlay ──────────────────────────────────────────────────────────

/**
 * Push the overlay down into the tree rather than having the tree reach back up
 * for it — FilesPanel already requires FileExplorer, and the reverse would be a
 * cycle.
 */
function _pushOverlay() {
  FileExplorer.setSessionOverlay({
    files: _sessionFiles,
    modifiedOnly: _modifiedOnly && !!_sessionFiles,
  });
}

function getSessionChange(path) {
  return _sessionFiles ? _sessionFiles.get(path) || null : null;
}

async function _loadSessions() {
  if (_sessions) return _sessions;
  try {
    const list = await api.claude.sessions(_project.path) || [];
    // The API already orders by real last activity; sorting again keeps the
    // menu right even if that ever changes upstream.
    _sessions = [...list].sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0));
  } catch {
    _sessions = [];
  }
  return _sessions;
}

function _sessionText(session) {
  const raw = session.summary || session.firstPrompt || session.sessionId || '';
  const line = raw.replace(/\s+/g, ' ').trim();
  if (!line) return session.sessionId.slice(0, 8);
  return line.length > 70 ? line.slice(0, 67) + '…' : line;
}

async function selectSession(sessionId, label) {
  _sessionId = sessionId || null;
  _sessionLabel = label || '';
  _sessionFiles = null;
  _selectedPath = null;

  const labelEl = document.getElementById('files-session-label');
  if (labelEl) labelEl.textContent = _sessionId ? _sessionLabel : t('files.noSession');
  // The picker reads as "on" while a session is driving the tree.
  document.getElementById('files-session')?.classList.toggle('active', !!_sessionId);

  const modifiedBtn = document.getElementById('fe-modified-btn');
  if (modifiedBtn) {
    modifiedBtn.hidden = !_sessionId;
    if (!_sessionId) modifiedBtn.classList.remove('active');
  }
  if (!_sessionId) _modifiedOnly = false;

  _renderTotals();
  _renderViewerPlaceholder();

  if (!_sessionId) {
    _pushOverlay();
    FileExplorer.render();
    return;
  }

  _loadingSession = true;
  try {
    const res = await api.claude.sessionChanges({ projectPath: _project.path, sessionId: _sessionId });
    if (_sessionId !== sessionId) return; // a later pick won the race
    _sessionFiles = new Map((res && res.success ? res.files : []).map(f => [f.path, f]));
  } catch {
    if (_sessionId === sessionId) _sessionFiles = new Map();
  } finally {
    if (_sessionId === sessionId) {
      _loadingSession = false;
      _renderTotals();
      _pushOverlay();
      // Expanding down to every touched file is what makes the overlay legible;
      // otherwise the badges stay hidden inside collapsed folders.
      await FileExplorer.revealPaths([..._sessionFiles.keys()]);
    }
  }
}

function _renderTotals() {
  const el = document.getElementById('files-session-totals');
  if (!el) return;
  if (!_sessionId) { el.innerHTML = ''; return; }
  if (_loadingSession) { el.textContent = t('common.loading'); return; }
  if (!_sessionFiles || _sessionFiles.size === 0) {
    el.textContent = t('files.sessionNoChanges');
    return;
  }
  let add = 0, del = 0;
  for (const s of _sessionFiles.values()) { add += s.additions; del += s.deletions; }
  el.innerHTML = `<span class="files-totals-count">${_sessionFiles.size} ${escapeHtml(t('files.filesTouched'))}</span>
    <span class="chat-change-add">+${add}</span><span class="chat-change-del">-${del}</span>`;
}

// ── Viewer ───────────────────────────────────────────────────────────────────

function _renderViewerPlaceholder() {
  const pane = document.getElementById('files-viewer');
  if (!pane) return;
  pane.innerHTML = `<div class="files-empty">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
    <p>${escapeHtml(t('files.pickAFile'))}</p>
  </div>`;
}

async function openFile(filePath) {
  const pane = document.getElementById('files-viewer');
  if (!pane) return;
  _selectedPath = filePath;
  const change = getSessionChange(filePath);
  // A file this session touched opens on its diff: that is what you came for.
  await FileViewer.render(pane, filePath, {
    project: _project,
    change,
    initialMode: change ? 'diff' : 'content',
    sessionLabel: _sessionLabel,
  });
}

// ── Mount / lifecycle ────────────────────────────────────────────────────────

// Two actions need the host: opening a folder as a terminal, and mentioning a
// file in the active chat. Everything else the panel handles itself.
const _hostCallbacks = { onOpenInTerminal: null, onAddToChat: null };
function setCallbacks(cbs) { Object.assign(_hostCallbacks, cbs); }

function _closeMenus() {
  const menu = document.getElementById('files-session-menu');
  if (menu && !menu.hidden) {
    menu.hidden = true;
    document.getElementById('files-session-btn')?.setAttribute('aria-expanded', 'false');
  }
}

function _wireSessionPicker() {
  const btn = document.getElementById('files-session-btn');
  const menu = document.getElementById('files-session-menu');
  if (!btn || !menu) return;

  btn.onclick = async (e) => {
    e.stopPropagation();
    if (!menu.hidden) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); return; }
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    menu.innerHTML = `<div class="files-picker-loading">${escapeHtml(t('common.loading'))}</div>`;
    const sessions = await _loadSessions();
    if (menu.hidden) return;
    const items = [
      `<button class="files-picker-item${_sessionId ? '' : ' active'}" data-sid="" role="menuitem">
        <span class="files-picker-item-text">${escapeHtml(t('files.noSession'))}</span>
        <span class="files-picker-item-hint">${escapeHtml(t('files.noSessionHint'))}</span>
      </button>`,
      '<div class="files-picker-divider"></div>',
    ];
    for (const s of sessions) {
      const text = _sessionText(s);
      items.push(`<button class="files-picker-item${_sessionId === s.sessionId ? ' active' : ''}" data-sid="${escapeHtml(s.sessionId)}" role="menuitem" title="${escapeHtml(text)}">
        <span class="files-picker-item-text">${escapeHtml(text)}</span>
        <span class="files-picker-item-hint">${escapeHtml(_relativeTime(s.modified))}</span>
      </button>`);
    }
    menu.innerHTML = items.join('');
  };

  menu.onclick = (e) => {
    const item = e.target.closest('.files-picker-item');
    if (!item) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    selectSession(item.dataset.sid || null, item.querySelector('.files-picker-item-text')?.textContent || '');
  };
}

function _wireModifiedFilter() {
  const btn = document.getElementById('fe-modified-btn');
  if (!btn) return;
  btn.onclick = () => {
    _modifiedOnly = !_modifiedOnly;
    btn.classList.toggle('active', _modifiedOnly);
    _pushOverlay();
    FileExplorer.render();
  };
}

function _wireToolbar() {
  _wireSessionPicker();
  _wireModifiedFilter();
}

/**
 * Switch between the active project's tree and every open project at once.
 *
 * Overview drops the session picker rather than disabling it: a session
 * belongs to one project, so with several on screen the control has no single
 * answer to give. Any overlay in force is cleared with it.
 *
 * @param {'project'|'overview'} scope
 */
function setScope(scope) {
  const next = scope === 'overview' ? 'overview' : 'project';
  if (next === _scope) return;
  _scope = next;
  if (!_mounted) return;

  document.getElementById('files-session')?.toggleAttribute('hidden', _scope === 'overview');
  if (_scope === 'overview') {
    // Clearing through selectSession also resets the label, the filter button
    // and the totals, so nothing stale is left pointing at one project.
    selectSession(null, '');
  }
  _applyRoots();
  _renderViewerPlaceholder();
  FileExplorer.render();
}

/** Point the tree at one project, or at all of the open ones. */
function _applyRoots() {
  if (_scope === 'overview') {
    FileExplorer.setExtraRoots(getOpenProjects().map(p => p.path));
  } else {
    FileExplorer.setExtraRoots([]);
  }
}

// Dismissing the picker from anywhere, registered once.
document.addEventListener('click', (e) => {
  if (e.target.closest('#files-session')) return;
  _closeMenus();
});

/**
 * Build the screen and hand the tree over to FileExplorer. Safe to call on
 * every activate: it only rebuilds when the project changed.
 */
function loadPanel(root, project) {
  _root = root;
  const changedProject = !_project || !project || _project.path !== project.path;
  _project = project || null;

  if (!_project) {
    root.innerHTML = _noProjectHtml();
    _mounted = false;
    return;
  }

  if (!_mounted || changedProject) {
    root.innerHTML = _screenHtml();
    _mounted = true;
    _wireToolbar();
    if (changedProject) {
      _sessionId = null;
      _sessionLabel = '';
      _sessionFiles = null;
      _sessions = null;
      _modifiedOnly = false;
      _selectedPath = null;
    }
    _renderViewerPlaceholder();
    // The tree markup exists now, so FileExplorer can bind to it. Clicking a
    // file lands in this screen's viewer rather than opening a session tab.
    FileExplorer.setCallbacks({
      onOpenFile: openFile,
      onOpenInTerminal: (p) => _hostCallbacks.onOpenInTerminal?.(p),
      onAddToChat: (rel, full) => _hostCallbacks.onAddToChat?.(rel, full),
    });
    FileExplorer.init();
  }

  const sessionLabel = document.getElementById('files-session-label');
  if (sessionLabel) sessionLabel.textContent = _sessionId ? _sessionLabel : t('files.noSession');
  document.getElementById('files-session')?.toggleAttribute('hidden', _scope === 'overview');

  _pushOverlay();
  // _rootPath stays the active project even in Overview: it is what the path
  // guards and the git poll measure against.
  FileExplorer.setRootPath(_project.path);
  _applyRoots();
  FileExplorer.show();
  FileExplorer.render();
}

function onDeactivate() {
  FileExplorer.hide();
}

function cleanup() {
  FileExplorer.hide();
  _mounted = false;
}

module.exports = {
  loadPanel,
  setCallbacks,
  setScope,
  onDeactivate,
  cleanup,
  openFile,
  selectSession,
  getSessionChange,
};
