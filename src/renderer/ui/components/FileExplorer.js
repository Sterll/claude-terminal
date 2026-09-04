/**
 * FileExplorer Component
 * Displays a file tree for the selected project with preview and context menu
 * Features: multi-selection, inline rename, git status, search, drag & drop, copy/cut/paste,
 *           content search, duplicate, configurable sort & ignore patterns
 */

const { BaseComponent } = require('../../core/BaseComponent');
const { escapeHtml, debounce } = require('../../utils/dom');
const { getFileIcon, CHEVRON_ICON } = require('../../utils/fileIcons');
const { showContextMenu } = require('./ContextMenu');
const { showConfirm, showPrompt } = require('./Modal');
const Toast = require('./Toast');
const { t } = require('../../i18n');
const { fileExists, copyDirRecursive, fsp } = require('../../utils/fs-async');

// Default ignore patterns
const DEFAULT_IGNORE_PATTERNS = [
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  '.next', 'vendor', '.cache', '.idea', '.vscode',
  '.DS_Store', 'Thumbs.db', '.env.local', 'coverage',
  '.nuxt', '.output', '.turbo', '.parcel-cache'
];

// Max entries displayed per folder
const MAX_DISPLAY_ENTRIES = 500;

function getIgnorePatterns() {
  const { getSetting } = require('../../state/settings.state');
  const custom = getSetting('explorerIgnorePatterns');
  const patterns = new Set(DEFAULT_IGNORE_PATTERNS);
  if (Array.isArray(custom)) {
    for (const p of custom) {
      if (p.trim()) patterns.add(p.trim());
    }
  }
  return patterns;
}

/**
 * Ask for a file/folder name.
 *
 * Resolves to the entered string, or null when the user cancels — the same
 * contract as the native prompt() this replaces.
 *
 * Modal.showPrompt() only resolves on OK/Cancel/backdrop: its Escape handler
 * closes the dialog without settling the promise, which would leave the caller
 * awaiting forever. The capture-phase guard routes Escape to the dialog's own
 * Cancel button so Escape really cancels.
 */
function promptForName(title, message) {
  const escGuard = (e) => {
    if (e.key !== 'Escape') return;
    const promptModal = document.getElementById('prompt-modal');
    if (!promptModal) return;
    e.preventDefault();
    e.stopPropagation();
    promptModal.querySelector('[data-action="cancel"]')?.click();
  };
  document.addEventListener('keydown', escGuard, true);

  return showPrompt({ title, message })
    .finally(() => document.removeEventListener('keydown', escGuard, true));
}

function isPathSafe(targetPath, rootPath, pathModule) {
  const resolved = pathModule.resolve(targetPath);
  const root = pathModule.resolve(rootPath);
  return resolved.startsWith(root + pathModule.sep) || resolved === root;
}

function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

function isDescendant(parentPath, childPath, pathModule) {
  const resolvedParent = pathModule.resolve(parentPath);
  const resolvedChild = pathModule.resolve(childPath);
  return resolvedChild.startsWith(resolvedParent + pathModule.sep);
}

function getGitBadgeHtml(absolutePath, isDirectory, gitStatusMap, rootPath, pathModule) {
  const gitStatus = isDirectory
    ? getFolderGitStatus(absolutePath, gitStatusMap, rootPath, pathModule)
    : getGitStatusForPath(absolutePath, gitStatusMap, rootPath, pathModule);

  if (!gitStatus) return '';

  const { status, staged } = gitStatus;
  let cssClass = 'fe-git-untracked';
  if (staged) cssClass = 'fe-git-staged';
  else if (status === 'M') cssClass = 'fe-git-modified';

  if (isDirectory) {
    return `<span class="fe-git-status fe-git-dot ${cssClass}"></span>`;
  }
  return `<span class="fe-git-status ${cssClass}">${escapeHtml(status)}</span>`;
}

function getGitStatusForPath(absolutePath, gitStatusMap, rootPath, pathModule) {
  if (!rootPath) return null;
  const relativePath = pathModule.relative(rootPath, absolutePath);
  return gitStatusMap.get(relativePath) || null;
}

function getFolderGitStatus(folderAbsPath, gitStatusMap, rootPath, pathModule) {
  if (!rootPath) return null;
  const folderRel = pathModule.relative(rootPath, folderAbsPath);
  for (const [relPath, status] of gitStatusMap) {
    if (relPath.startsWith(folderRel + pathModule.sep) || relPath === folderRel) {
      return status;
    }
  }
  return null;
}

class FileExplorer extends BaseComponent {
  constructor() {
    super(null);

    this._api = window.electron_api;
    this._path = window.electron_nodeModules.path;
    this._fs = window.electron_nodeModules.fs;

    this._rootPath = null;
    this._selectedFiles = new Set();
    this._lastSelectedFile = null;
    this._expandedFolders = new Map();
    this._callbacks = {
      onOpenInTerminal: null,
      onOpenFile: null,
      onAddToChat: null
    };
    this._isVisible = false;

    // Session overlay, pushed in by FilesPanel. null = plain tree.
    this._sessionFiles = null;
    this._modifiedOnly = false;
    // Non-empty only in the Files screen's Overview: every open project drawn
    // side by side. Rendering only — see setExtraRoots.
    this._extraRoots = [];

    this._gitStatusMap = new Map();
    this._gitPollingInterval = null;

    this._searchQuery = '';
    this._searchResults = [];

    this._renameActivePath = null;

    this._draggedPaths = [];
    this._dragListenersAttached = false;
    this._contentMatchListenerAttached = false;

    this._cutPaths = [];

    this._copiedPaths = [];

    this._contentSearchQuery = '';
    this._contentSearchResults = [];
    this._isContentSearching = false;

    this._currentSortMode = 'name';

    const self = this;
    this._performSearch = debounce(async () => {
      const query = self._searchQuery.trim().toLowerCase();
      if (!query || !self._rootPath) {
        self._searchResults = [];
        self.render();
        return;
      }

      const allFiles = await self._collectAllFiles(self._rootPath);
      self._searchResults = allFiles.filter(f => f.name.toLowerCase().includes(query));
      self.render();
    }, 250);

    this._performContentSearch = debounce(async () => {
      const query = self._contentSearchQuery.trim();
      if (!query || !self._rootPath) {
        self._contentSearchResults = [];
        self._isContentSearching = false;
        self.render();
        return;
      }

      self._isContentSearching = true;
      self.render();

      const results = [];
      const allFiles = await self._collectAllFiles(self._rootPath, 3000);

      const binaryExts = new Set([
        '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
        '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
        '.zip', '.tar', '.gz', '.rar', '.7z',
        '.exe', '.dll', '.so', '.dylib', '.bin',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx',
        '.woff', '.woff2', '.ttf', '.eot', '.otf'
      ]);

      for (const file of allFiles) {
        if (results.length >= 100) break;

        const ext = self._path.extname(file.name).toLowerCase();
        if (binaryExts.has(ext)) continue;

        try {
          const content = await self._fs.promises.readFile(file.path, 'utf-8');
          const lines = content.split('\n');
          const matches = [];

          for (let i = 0; i < lines.length; i++) {
            const idx = lines[i].toLowerCase().indexOf(query.toLowerCase());
            if (idx !== -1) {
              matches.push({ line: i + 1, text: lines[i].trim().substring(0, 200) });
              if (matches.length >= 3) break;
            }
          }

          if (matches.length > 0) {
            results.push({ name: file.name, path: file.path, matches });
          }
        } catch { /* skip unreadable files */ }
      }

      self._contentSearchResults = results;
      self._isContentSearching = false;
      self.render();
    }, 400);
  }

  // ========== CALLBACKS ==========
  setCallbacks(cbs) {
    Object.assign(this._callbacks, cbs);
  }

  // ========== ROOT PATH ==========
  setRootPath(projectPath) {
    if (this._rootPath === projectPath) return;
    this._rootPath = projectPath;
    this._selectedFiles.clear();
    this._lastSelectedFile = null;
    this._expandedFolders.clear();
    this._gitStatusMap.clear();
    this._searchQuery = '';
    this._searchResults = [];
    this._cutPaths = [];
    this._copiedPaths = [];
    this._contentSearchQuery = '';
    this._contentSearchResults = [];
    // The explorer stays closed until asked for; switching projects only
    // refreshes it when it is already open.
    if (this._rootPath && this._isVisible) {
      this.render();
    }
    this._updateSearchBarVisibility();
  }

  // ========== VISIBILITY ==========
  show() {
    const panel = document.getElementById('file-explorer-panel');
    if (panel) {
      panel.style.display = 'flex';
      this._isVisible = true;
      this._startGitStatusPolling();
      this._updateSearchBarVisibility();
    }
  }

  _updateSearchBarVisibility() {
    const container = document.getElementById('fe-search-container');
    if (container) {
      container.style.display = this._rootPath ? 'flex' : 'none';
    }
  }

  hide() {
    const panel = document.getElementById('file-explorer-panel');
    if (panel) {
      panel.style.display = 'none';
      this._isVisible = false;
      this._stopGitStatusPolling();
    }
  }

  toggle() {
    if (this._isVisible) {
      this.hide();
    } else if (this._rootPath) {
      this.show();
      this.render();
    }
  }

  // ========== SESSION OVERLAY ==========
  // "What did session X change", painted onto the same tree. Pushed in by
  // FilesPanel so the tree never has to reach back up into the panel.

  /**
   * @param {{files: Map<string,object>|null, modifiedOnly: boolean}} overlay
   */
  setSessionOverlay(overlay) {
    this._sessionFiles = (overlay && overlay.files) || null;
    this._modifiedOnly = !!(overlay && overlay.modifiedOnly) && !!this._sessionFiles;
  }

  /** Per-file change stats, or null when the file is untouched. */
  _sessionChangeFor(filePath) {
    return this._sessionFiles ? this._sessionFiles.get(filePath) || null : null;
  }

  /**
   * Rolled-up counts under a folder, so a collapsed directory still shows that
   * something inside it moved.
   */
  _sessionRollupFor(dirPath) {
    if (!this._sessionFiles) return null;
    const prefix = dirPath.endsWith(this._path.sep) ? dirPath : dirPath + this._path.sep;
    let files = 0, additions = 0, deletions = 0;
    for (const [p, s] of this._sessionFiles) {
      if (!p.startsWith(prefix)) continue;
      files++; additions += s.additions; deletions += s.deletions;
    }
    return files ? { files, additions, deletions } : null;
  }

  /** True when the overlay says this node should be hidden by the filter. */
  _hiddenByFilter(item) {
    if (!this._modifiedOnly) return false;
    return item.isDirectory
      ? !this._sessionRollupFor(item.path)
      : !this._sessionChangeFor(item.path);
  }

  /**
   * Expand every folder on the way to these paths, then repaint once. Selecting
   * a session is useless if its files stay buried in collapsed directories.
   * @param {string[]} paths
   */
  async revealPaths(paths) {
    if (!this._rootPath || !paths || !paths.length) { this.render(); return; }
    const wanted = new Set();
    for (const p of paths) {
      let dir = this._path.dirname(p);
      // Walk up to the root, collecting each ancestor inside the project.
      while (dir && dir.startsWith(this._rootPath) && dir !== this._rootPath) {
        wanted.add(dir);
        const parent = this._path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    // Load shallowest first: a child's folder entry is only reachable once its
    // parent has been read.
    const ordered = [...wanted].sort((a, b) => a.length - b.length);
    for (const dir of ordered) {
      if (this._expandedFolders.get(dir)?.loaded) continue;
      try {
        const children = await this._readDirectoryAsync(dir);
        this._expandedFolders.set(dir, { children, loaded: true, loading: false });
      } catch { /* unreadable folder — skip it, the rest still expands */ }
    }
    this.render();
  }

  /**
   * Point the explorer at a project and reveal it, whether or not it was
   * already open. Unlike toggle(), this never closes — it backs the project
   * menu's "Files" entry, where the intent is always "show me the tree".
   * @param {string} projectPath
   */
  open(projectPath) {
    if (projectPath) this.setRootPath(projectPath);
    if (!this._rootPath) return;
    this.show();
    this.render();
  }

  // ========== GIT STATUS ==========
  async _refreshGitStatus() {
    if (!this._rootPath) return;
    try {
      const result = await this._api.git.statusDetailed({ projectPath: this._rootPath });
      if (!result || !result.success) return;

      this._gitStatusMap.clear();
      for (const file of result.files) {
        const normalized = file.path.replace(/\//g, this._path.sep);
        this._gitStatusMap.set(normalized, { status: file.status, staged: file.staged });
      }

      if (!this._searchQuery) {
        this._updateGitBadges();
      }
    } catch (e) {
      // Silently fail - git may not be available
    }
  }

  _startGitStatusPolling() {
    if (this._gitPollingInterval) return;
    this._refreshGitStatus();
    const self = this;
    this._gitPollingInterval = setInterval(() => self._refreshGitStatus(), 10000);
  }

  _stopGitStatusPolling() {
    if (this._gitPollingInterval) {
      clearInterval(this._gitPollingInterval);
      this._gitPollingInterval = null;
    }
  }

  _updateGitBadges() {
    const treeEl = document.getElementById('file-explorer-tree');
    if (!treeEl) return;

    const nodes = treeEl.querySelectorAll('.fe-node[data-path]');
    for (const node of nodes) {
      const nodePath = node.dataset.path;
      const isDir = node.dataset.isDir === 'true';
      const existingBadge = node.querySelector('.fe-git-status');
      const newBadgeHtml = getGitBadgeHtml(nodePath, isDir, this._gitStatusMap, this._rootPath, this._path);

      if (existingBadge) {
        if (!newBadgeHtml) {
          existingBadge.remove();
        } else {
          existingBadge.outerHTML = newBadgeHtml;
        }
      } else if (newBadgeHtml) {
        const nameEl = node.querySelector('.fe-node-name');
        if (nameEl) {
          nameEl.insertAdjacentHTML('afterend', newBadgeHtml);
        }
      }
    }
  }

  // ========== FILE SYSTEM ==========
  async _readDirectoryAsync(dirPath) {
    try {
      const exists = await this._fs.promises.access(dirPath).then(() => true).catch(() => false);
      if (!exists) return [];

      const { getSetting } = require('../../state/settings.state');
      const showDotfiles = getSetting('showDotfiles');
      const ignorePatterns = getIgnorePatterns();

      const entries = await this._fs.promises.readdir(dirPath, { withFileTypes: true });
      const result = [];
      let skipped = 0;

      for (const entry of entries) {
        if (ignorePatterns.has(entry.name)) continue;
        if (showDotfiles === false && entry.name.startsWith('.')) continue;

        if (result.length >= MAX_DISPLAY_ENTRIES) {
          skipped++;
          continue;
        }

        const fullPath = this._path.join(dirPath, entry.name);
        const item = {
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory()
        };

        if (this._currentSortMode !== 'name') {
          try {
            const stat = await this._fs.promises.stat(fullPath);
            item.size = stat.size;
            item.mtime = stat.mtimeMs;
          } catch { /* ignore stat errors */ }
        }

        result.push(item);
      }

      this._sortEntries(result);

      if (skipped > 0) {
        const truncLabel = (t('fileExplorer.truncatedItems') || '{count} more items hidden').replace('{count}', skipped);
        result.push({
          name: truncLabel,
          path: null,
          isDirectory: false,
          isTruncated: true
        });
      }

      return result;
    } catch (e) {
      return [];
    }
  }

  _sortEntries(entries) {
    const pathModule = this._path;
    const sortMode = this._currentSortMode;
    entries.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;

      switch (sortMode) {
        case 'size':
          return (b.size || 0) - (a.size || 0);
        case 'date':
          return (b.mtime || 0) - (a.mtime || 0);
        case 'type': {
          const extA = pathModule.extname(a.name).toLowerCase();
          const extB = pathModule.extname(b.name).toLowerCase();
          if (extA !== extB) return extA.localeCompare(extB);
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        }
        default:
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      }
    });
  }

  _getOrLoadFolder(folderPath) {
    let entry = this._expandedFolders.get(folderPath);
    if (entry) return entry;
    entry = { children: [], loaded: false, loading: true };
    this._expandedFolders.set(folderPath, entry);
    const self = this;
    this._readDirectoryAsync(folderPath).then(children => {
      entry.children = children;
      entry.loaded = true;
      entry.loading = false;
      self.render();
    }).catch(() => {
      entry.loaded = true;
      entry.loading = false;
      self.render();
    });
    return entry;
  }

  async _refreshFolder(folderPath) {
    const entry = this._expandedFolders.get(folderPath);
    if (entry) {
      entry.children = await this._readDirectoryAsync(folderPath);
      entry.loaded = true;
    }
  }

  async applyWatcherChanges(changes) {
    try {
      if (!this._rootPath || !changes || !changes.length) return;

      const affectedParents = new Set();

      for (const change of changes) {
        const parentDir = this._path.dirname(change.path);

        if (change.type === 'add') {
          const entry = this._expandedFolders.get(parentDir);
          if (entry && entry.loaded) {
            affectedParents.add(parentDir);
          }
        } else if (change.type === 'remove') {
          const entry = this._expandedFolders.get(parentDir);
          if (entry && entry.loaded) {
            entry.children = entry.children.filter(c => c.path !== change.path);
          }
          if (change.isDirectory) {
            const prefix = change.path + this._path.sep;
            for (const key of [...this._expandedFolders.keys()]) {
              if (key === change.path || key.startsWith(prefix)) {
                this._expandedFolders.delete(key);
              }
            }
          }
          this._selectedFiles.delete(change.path);
          if (this._lastSelectedFile === change.path) this._lastSelectedFile = null;
        }
      }

      for (const parentDir of affectedParents) {
        const entry = this._expandedFolders.get(parentDir);
        if (entry) {
          entry.children = await this._readDirectoryAsync(parentDir);
        }
      }

      this.render();
    } catch {
      // Silently ignore — stale paths, permission errors, etc.
    }
  }

  // ========== MULTI-SELECTION ==========
  _getVisibleNodePaths() {
    const paths = [];
    const self = this;
    function walk(dirPath) {
      const entry = self._expandedFolders.get(dirPath);
      if (!entry || !entry.loaded) return;
      for (const item of entry.children) {
        if (item.isTruncated) continue;
        paths.push(item.path);
        if (item.isDirectory && self._expandedFolders.has(item.path) && self._expandedFolders.get(item.path).loaded) {
          walk(item.path);
        }
      }
    }
    walk(this._rootPath);
    return paths;
  }

  _selectFile(filePath, ctrlKey, shiftKey) {
    if (shiftKey && this._lastSelectedFile) {
      const visible = this._getVisibleNodePaths();
      const startIdx = visible.indexOf(this._lastSelectedFile);
      const endIdx = visible.indexOf(filePath);
      if (startIdx !== -1 && endIdx !== -1) {
        if (!ctrlKey) this._selectedFiles.clear();
        const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        for (let i = from; i <= to; i++) {
          this._selectedFiles.add(visible[i]);
        }
      }
    } else if (ctrlKey) {
      if (this._selectedFiles.has(filePath)) {
        this._selectedFiles.delete(filePath);
      } else {
        this._selectedFiles.add(filePath);
      }
    } else {
      this._selectedFiles.clear();
      this._selectedFiles.add(filePath);
    }

    this._lastSelectedFile = filePath;
    this._updateSelectionVisuals();
  }

  _updateSelectionVisuals() {
    const treeEl = document.getElementById('file-explorer-tree');
    if (!treeEl) return;
    const nodes = treeEl.querySelectorAll('.fe-node[data-path]');
    for (const node of nodes) {
      const isCut = this._cutPaths.includes(node.dataset.path);
      const isCopied = this._copiedPaths.includes(node.dataset.path);
      node.classList.toggle('selected', this._selectedFiles.has(node.dataset.path));
      node.classList.toggle('fe-cut', isCut);
      node.classList.toggle('fe-copied', isCopied);
    }
  }

  // ========== SEARCH ==========
  async _collectAllFiles(dirPath, maxFiles = 5000) {
    const { getSetting } = require('../../state/settings.state');
    const showDotfiles = getSetting('showDotfiles');
    const ignorePatterns = getIgnorePatterns();

    const results = [];
    const queue = [dirPath];

    while (queue.length > 0 && results.length < maxFiles) {
      const dir = queue.shift();
      try {
        const names = await this._fs.promises.readdir(dir);
        for (const name of names) {
          if (ignorePatterns.has(name)) continue;
          if (showDotfiles === false && name.startsWith('.')) continue;

          const fullPath = this._path.join(dir, name);
          try {
            const stat = await this._fs.promises.stat(fullPath);
            if (stat.isDirectory()) {
              queue.push(fullPath);
            } else {
              results.push({ name, path: fullPath });
              if (results.length >= maxFiles) break;
            }
          } catch (e) { /* skip */ }
        }
      } catch (e) { /* skip */ }
    }

    return results;
  }

  _renderSearchResults() {
    if (this._searchResults.length === 0) {
      return `<div class="fe-empty">${t('fileExplorer.noResults') || 'No results'}</div>`;
    }

    const parts = [];
    for (const file of this._searchResults.slice(0, 200)) {
      const icon = getFileIcon(file.name, false, false);
      const relativePath = this._rootPath ? this._path.relative(this._rootPath, this._path.dirname(file.path)) : '';
      const isSelected = this._selectedFiles.has(file.path);

      const query = this._searchQuery.trim().toLowerCase();
      const idx = file.name.toLowerCase().indexOf(query);
      let nameHtml;
      if (idx !== -1) {
        const before = escapeHtml(file.name.slice(0, idx));
        const match = escapeHtml(file.name.slice(idx, idx + query.length));
        const after = escapeHtml(file.name.slice(idx + query.length));
        nameHtml = `${before}<span class="fe-search-highlight">${match}</span>${after}`;
      } else {
        nameHtml = escapeHtml(file.name);
      }

      parts.push(`<div class="fe-node fe-file fe-search-result ${isSelected ? 'selected' : ''}"
      data-path="${escapeHtml(file.path)}"
      data-name="${escapeHtml(file.name)}"
      data-is-dir="false"
      style="padding-left: 8px;">
      <span class="fe-node-icon">${icon}</span>
      <span class="fe-node-name">${nameHtml}</span>
      ${relativePath ? `<span class="fe-search-path">${escapeHtml(relativePath)}</span>` : ''}
    </div>`);
    }

    return parts.join('');
  }

  // ========== INLINE RENAME ==========
  _startInlineRename(filePath, fileName) {
    this._renameActivePath = filePath;
    const node = document.querySelector(`.fe-node[data-path="${CSS.escape(filePath)}"]`);
    if (!node) return;

    const nameEl = node.querySelector('.fe-node-name');
    if (!nameEl) return;

    const isDir = node.dataset.isDir === 'true';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'fe-inline-rename';
    input.value = fileName;

    if (!isDir) {
      const dotIdx = fileName.lastIndexOf('.');
      if (dotIdx > 0) {
        requestAnimationFrame(() => input.setSelectionRange(0, dotIdx));
      } else {
        requestAnimationFrame(() => input.select());
      }
    } else {
      requestAnimationFrame(() => input.select());
    }

    nameEl.replaceWith(input);
    input.focus();

    const self = this;
    const commit = async () => {
      const newName = input.value.trim();
      self._renameActivePath = null;
      if (!newName || newName === fileName) {
        self.render();
        return;
      }
      await self._executeRename(filePath, newName);
    };

    const cancel = () => {
      self._renameActivePath = null;
      self.render();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
      e.stopPropagation();
    });

    input.addEventListener('blur', cancel);
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  async _executeRename(filePath, newName) {
    const sanitized = sanitizeFileName(newName);
    const dirPath = this._path.dirname(filePath);
    const newPath = this._path.join(dirPath, sanitized);

    if (!isPathSafe(newPath, this._rootPath, this._path)) {
      Toast.showError(t('fileExplorer.errorOutsideProject'));
      this.render();
      return;
    }

    if (await fileExists(newPath)) {
      const overwrite = await showConfirm({
        title: t('fileExplorer.rename') || 'Rename',
        message: (t('fileExplorer.renameOverwriteConfirm') || 'A file named "{name}" already exists. Overwrite?').replace('{name}', sanitized),
        confirmLabel: t('fileExplorer.overwrite') || 'Overwrite',
        danger: true,
      });
      if (!overwrite) {
        this.render();
        return;
      }
      try {
        const stat = await fsp.stat(newPath);
        if (stat.isDirectory()) {
          await fsp.rm(newPath, { recursive: true, force: true });
        } else {
          await fsp.unlink(newPath);
        }
      } catch (e) {
        Toast.showError(`${t('common.error')}: ${e.message}`);
        this.render();
        return;
      }
    }

    try {
      await fsp.rename(filePath, newPath);

      if (this._expandedFolders.has(filePath)) {
        const entry = this._expandedFolders.get(filePath);
        this._expandedFolders.delete(filePath);
        this._expandedFolders.set(newPath, entry);
      }

      if (this._selectedFiles.has(filePath)) {
        this._selectedFiles.delete(filePath);
        this._selectedFiles.add(newPath);
      }
      if (this._lastSelectedFile === filePath) {
        this._lastSelectedFile = newPath;
      }

      await this._refreshFolder(dirPath);
      this.render();
      this._refreshGitStatus();
    } catch (e) {
      const userMessage = (e.code === 'EBUSY' || e.code === 'EPERM')
        ? t('fileExplorer.errorFileLocked')
        : `${t('common.error')}: ${e.message}`;
      Toast.showError(userMessage);
      this.render();
    }
  }

  // ========== KEYBOARD CUT/PASTE ==========
  _cutSelectedFiles() {
    if (this._selectedFiles.size === 0) return;
    this._cutPaths = [...this._selectedFiles];
    this._copiedPaths = [];
    this._updateSelectionVisuals();
  }

  async _pasteFiles(targetDir) {
    if (this._cutPaths.length === 0 || !targetDir) return;

    const sourcePaths = [...this._cutPaths];
    this._cutPaths = [];

    await this._moveItems(sourcePaths, targetDir);
  }

  // ========== COPY NAME GENERATION ==========
  async generateCopyName(targetDir, baseName) {
    const ext = this._path.extname(baseName);
    const nameNoExt = ext ? baseName.slice(0, -ext.length) : baseName;
    let counter = 1;
    let newPath;
    do {
      const newName = ext ? `${nameNoExt} (${counter})${ext}` : `${nameNoExt} (${counter})`;
      newPath = this._path.join(targetDir, newName);
      counter++;
    } while (await fileExists(newPath));
    return newPath;
  }

  // ========== COPY FILES ==========
  _copySelectedFiles() {
    if (this._selectedFiles.size === 0) return;
    this._copiedPaths = [...this._selectedFiles];
    this._cutPaths = [];
    this._updateSelectionVisuals();
  }

  async _pasteCopiedFiles(targetDir) {
    if (this._copiedPaths.length === 0 || !targetDir) return;

    const sourcePaths = [...this._copiedPaths];

    for (const sourcePath of sourcePaths) {
      const baseName = this._path.basename(sourcePath);
      let destPath = this._path.join(targetDir, baseName);

      if (sourcePath === destPath) continue;
      if (!isPathSafe(destPath, this._rootPath, this._path)) continue;

      if (await fileExists(destPath)) {
        destPath = await this.generateCopyName(targetDir, baseName);
      }

      try {
        const stat = await fsp.stat(sourcePath);
        if (stat.isDirectory()) {
          await copyDirRecursive(sourcePath, destPath);
        } else {
          await fsp.copyFile(sourcePath, destPath);
        }
      } catch (e) {
        // Skip failed copies
      }
    }

    await this._refreshFolder(targetDir);
    this.render();
    this._refreshGitStatus();
  }

  // ========== DUPLICATE FILE ==========
  async _duplicateFile(filePath) {
    const dirPath = this._path.dirname(filePath);
    const baseName = this._path.basename(filePath);
    const destPath = await this.generateCopyName(dirPath, baseName);

    try {
      const stat = await fsp.stat(filePath);
      if (stat.isDirectory()) {
        await copyDirRecursive(filePath, destPath);
      } else {
        await fsp.copyFile(filePath, destPath);
      }

      await this._refreshFolder(dirPath);
      this.render();

      this._selectedFiles.clear();
      this._selectedFiles.add(destPath);
      this._lastSelectedFile = destPath;
      this._updateSelectionVisuals();
      this._refreshGitStatus();
    } catch (e) {
      Toast.showError(`${t('common.error')}: ${e.message}`);
    }
  }

  // ========== CONTENT SEARCH ==========
  _renderContentSearchResults() {
    if (this._isContentSearching) {
      return `<div class="fe-empty">${t('common.loading') || 'Searching...'}</div>`;
    }
    if (this._contentSearchResults.length === 0) {
      return `<div class="fe-empty">${t('fileExplorer.noResults') || 'No results'}</div>`;
    }

    const parts = [];
    const query = this._contentSearchQuery.trim().toLowerCase();

    for (const file of this._contentSearchResults) {
      const icon = getFileIcon(file.name, false, false);
      const relativePath = this._rootPath ? this._path.relative(this._rootPath, file.path) : file.path;
      const isSelected = this._selectedFiles.has(file.path);

      parts.push(`<div class="fe-node fe-file fe-search-result ${isSelected ? 'selected' : ''}"
      data-path="${escapeHtml(file.path)}"
      data-name="${escapeHtml(file.name)}"
      data-is-dir="false"
      style="padding-left: 8px;">
      <span class="fe-node-icon">${icon}</span>
      <span class="fe-node-name">${escapeHtml(file.name)}</span>
      <span class="fe-search-path">${escapeHtml(relativePath)}</span>
    </div>`);

      for (const match of file.matches) {
        const lineText = match.text;
        const idx = lineText.toLowerCase().indexOf(query);
        let lineHtml;
        if (idx !== -1) {
          const before = escapeHtml(lineText.slice(0, idx));
          const matched = escapeHtml(lineText.slice(idx, idx + query.length));
          const after = escapeHtml(lineText.slice(idx + query.length));
          lineHtml = `${before}<span class="fe-search-highlight">${matched}</span>${after}`;
        } else {
          lineHtml = escapeHtml(lineText);
        }

        parts.push(`<div class="fe-content-match" data-path="${escapeHtml(file.path)}" data-line="${match.line}" style="padding-left: 28px;">
        <span class="fe-match-line">L${match.line}</span>
        <span class="fe-match-text">${lineHtml}</span>
      </div>`);
      }
    }

    return parts.join('');
  }

  // ========== SORT ==========
  setSortMode(mode) {
    if (this._currentSortMode === mode) return;
    this._currentSortMode = mode;
    const self = this;
    const foldersToReload = [...this._expandedFolders.keys()];
    for (const folderPath of foldersToReload) {
      const entry = this._expandedFolders.get(folderPath);
      if (entry && entry.loaded) {
        entry.loaded = false;
        entry.loading = true;
        this._readDirectoryAsync(folderPath).then(children => {
          entry.children = children;
          entry.loaded = true;
          entry.loading = false;
          self.render();
        });
      }
    }
    this.render();
  }

  // ========== EXTRA ROOTS ==========
  // The Files screen's Overview shows every open project at once. Only the
  // *rendering* is multi-root: _rootPath stays the active project, so the
  // path guards, the git poll and search keep their single, unambiguous
  // scope. Browsing another root works; writing into one does not, because
  // isPathSafe still measures against _rootPath. Refusing is the safe way to
  // be wrong here.
  setExtraRoots(paths) {
    const next = Array.isArray(paths) ? paths.filter(Boolean) : [];
    const same = next.length === this._extraRoots.length
      && next.every((p, i) => p === this._extraRoots[i]);
    if (same) return;
    this._extraRoots = next;
  }

  /** Every root to draw, active project first, in project-bar order. */
  _allRoots() {
    if (!this._extraRoots.length) return this._rootPath ? [this._rootPath] : [];
    return this._extraRoots;
  }

  // ========== RENDER ==========
  render() {
    const roots = this._allRoots();
    if (!roots.length) return;

    const treeEl = document.getElementById('file-explorer-tree');
    if (!treeEl) return;

    if (this._contentSearchQuery.trim()) {
      treeEl.innerHTML = this._renderContentSearchResults();
    } else if (this._searchQuery.trim()) {
      treeEl.innerHTML = this._renderSearchResults();
    } else if (roots.length === 1) {
      treeEl.innerHTML = this._renderTreeNodes(roots[0], 0);
    } else {
      treeEl.innerHTML = roots.map(r => this._renderRootNode(r)).join('');
    }
    this._attachListeners();
  }

  /** A project as a collapsible top-level folder, for the Overview tree. */
  _renderRootNode(rootPath) {
    const name = this._path.basename(rootPath) || rootPath;
    const isExpanded = this._expandedFolders.has(rootPath) && this._expandedFolders.get(rootPath).loaded;
    const roll = this._sessionRollupFor(rootPath);
    const badge = roll
      ? `<span class="fe-session-badge fe-session-badge--dir" title="+${roll.additions} -${roll.deletions}">${roll.files}</span>`
      : '';
    if (this._modifiedOnly && this._sessionFiles && !roll) return '';

    return `<div class="fe-node fe-dir fe-root" data-path="${escapeHtml(rootPath)}" data-name="${escapeHtml(name)}" data-is-dir="true" style="padding-left: 8px;">
      <span class="fe-node-chevron ${isExpanded ? 'expanded' : ''}">${CHEVRON_ICON}</span>
      <span class="fe-node-icon">${getFileIcon(name, true, isExpanded)}</span>
      <span class="fe-node-name" title="${escapeHtml(rootPath)}">${escapeHtml(name)}</span>
      ${badge}
    </div>${isExpanded ? this._renderTreeNodes(rootPath, 1) : ''}`;
  }

  _renderTreeNodes(dirPath, depth) {
    const entry = this._getOrLoadFolder(dirPath);
    if (!entry.children.length) {
      if (depth === 0) {
        if (!entry.loaded) {
          return `<div class="fe-empty">${t('common.loading') || 'Loading...'}</div>`;
        }
        return `<div class="fe-empty">${t('fileExplorer.emptyFolder') || 'Empty folder'}</div>`;
      }
      return '';
    }

    const parts = [];
    for (const item of entry.children) {
      if (item.isTruncated) {
        parts.push(`<div class="fe-node fe-truncated" style="padding-left: ${8 + depth * 16}px;">
        <span class="fe-node-chevron-spacer"></span>
        <span class="fe-node-name fe-truncated-label">${escapeHtml(item.name)}</span>
      </div>`);
        continue;
      }

      if (this._hiddenByFilter(item)) continue;

      const isExpanded = this._expandedFolders.has(item.path) && this._expandedFolders.get(item.path).loaded;
      const isSelected = this._selectedFiles.has(item.path);
      const isCut = this._cutPaths.includes(item.path);
      const isCopied = this._copiedPaths.includes(item.path);

      const indent = depth * 16;
      const icon = getFileIcon(item.name, item.isDirectory, isExpanded);
      const chevron = item.isDirectory
        ? `<span class="fe-node-chevron ${isExpanded ? 'expanded' : ''}">${CHEVRON_ICON}</span>`
        : `<span class="fe-node-chevron-spacer"></span>`;

      const gitBadge = getGitBadgeHtml(item.path, item.isDirectory, this._gitStatusMap, this._rootPath, this._path);
      const sessionBadge = this._sessionBadgeHtml(item);

      parts.push(`<div class="fe-node ${isSelected ? 'selected' : ''} ${isCut ? 'fe-cut' : ''} ${isCopied ? 'fe-copied' : ''} ${item.isDirectory ? 'fe-dir' : 'fe-file'}${sessionBadge ? ' fe-session-touched' : ''}"
      data-path="${escapeHtml(item.path)}"
      data-name="${escapeHtml(item.name)}"
      data-is-dir="${item.isDirectory}"
      draggable="true"
      style="padding-left: ${8 + indent}px;">
      ${chevron}
      <span class="fe-node-icon">${icon}</span>
      <span class="fe-node-name" title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</span>
      ${sessionBadge}
      ${gitBadge}
    </div>`);

      if (item.isDirectory && isExpanded) {
        parts.push(this._renderTreeNodes(item.path, depth + 1));
      }
    }

    return parts.join('');
  }

  /** `+n −m` for a touched file, or a file count for a folder holding some. */
  _sessionBadgeHtml(item) {
    if (!this._sessionFiles) return '';
    if (item.isDirectory) {
      const roll = this._sessionRollupFor(item.path);
      if (!roll) return '';
      return `<span class="fe-session-badge fe-session-badge--dir" title="${roll.files} file(s) · +${roll.additions} -${roll.deletions}">${roll.files}</span>`;
    }
    const s = this._sessionChangeFor(item.path);
    if (!s) return '';
    return `<span class="fe-session-badge" title="${s.edits} edit(s)"><span class="fe-session-add">+${s.additions}</span><span class="fe-session-del">-${s.deletions}</span></span>`;
  }

  // ========== OPEN FILE ==========
  _openFile(filePath) {
    if (this._callbacks.onOpenFile) {
      this._callbacks.onOpenFile(filePath);
    } else {
      this._api.dialog.openInEditor({ editor: 'code', path: filePath });
    }
  }

  // ========== CONTEXT MENU ==========
  _showFileContextMenu(e, filePath, isDirectory) {
    e.preventDefault();
    e.stopPropagation();
    const fileName = this._path.basename(filePath);
    const relativePath = this._rootPath ? this._path.relative(this._rootPath, filePath) : filePath;

    if (!this._selectedFiles.has(filePath)) {
      this._selectedFiles.clear();
      this._selectedFiles.add(filePath);
      this._lastSelectedFile = filePath;
      this._updateSelectionVisuals();
    }

    const items = [];
    const multiSelected = this._selectedFiles.size > 1;

    if (multiSelected) {
      items.push({
        label: `${this._selectedFiles.size} ${t('fileExplorer.selectedItems') || 'items selected'}`,
        icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z"/></svg>',
        disabled: true
      });
      items.push({ separator: true });
      items.push({
        label: t('fileExplorer.copy') || 'Copy',
        icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
        shortcut: 'Ctrl+C',
        onClick: () => this._copySelectedFiles()
      });
      items.push({
        label: t('fileExplorer.cut') || 'Cut',
        icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zM19 3l-6 6 2 2 7-7V3z"/></svg>',
        shortcut: 'Ctrl+X',
        onClick: () => this._cutSelectedFiles()
      });
      items.push({
        label: t('common.delete') || 'Delete',
        icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
        danger: true,
        onClick: () => this._promptDeleteMultiple()
      });
      showContextMenu({ x: e.clientX, y: e.clientY, items });
      return;
    }

    if (isDirectory) {
      items.push({
        label: t('fileExplorer.newFile') || 'New file',
        icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 14h-3v3h-2v-3H8v-2h3v-3h2v3h3v2zm-3-7V3.5L18.5 9H13z"/></svg>',
        onClick: () => this._promptNewFile(filePath)
      });
      items.push({
        label: t('fileExplorer.newFolder') || 'New folder',
        icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z"/></svg>',
        onClick: () => this._promptNewFolder(filePath)
      });
      items.push({ separator: true });
      if (this._cutPaths.length > 0) {
        items.push({
          label: (t('fileExplorer.pasteHere') || 'Paste here') + ` (${this._cutPaths.length})`,
          icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 2h-4.18C14.4.84 13.3 0 12 0c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 18H5V4h2v3h10V4h2v16z"/></svg>',
          shortcut: 'Ctrl+V',
          onClick: () => this._pasteFiles(filePath)
        });
        items.push({ separator: true });
      }
      if (this._copiedPaths.length > 0) {
        items.push({
          label: (t('fileExplorer.pasteHere') || 'Paste here') + ` (${this._copiedPaths.length})`,
          icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 2h-4.18C14.4.84 13.3 0 12 0c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 18H5V4h2v3h10V4h2v16z"/></svg>',
          shortcut: 'Ctrl+V',
          onClick: () => this._pasteCopiedFiles(filePath)
        });
        items.push({ separator: true });
      }
      if (this._callbacks.onOpenInTerminal) {
        items.push({
          label: t('fileExplorer.openInTerminal') || 'Open in terminal',
          icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.89 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>',
          onClick: () => this._callbacks.onOpenInTerminal(filePath)
        });
      }
      items.push({
        label: t('fileExplorer.refreshFolder') || 'Refresh',
        icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>',
        onClick: async () => { await this._refreshFolder(filePath); this.render(); }
      });
    } else {
      items.push({
        label: t('fileExplorer.openInEditor') || 'Open in editor',
        icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
        onClick: () => this._api.dialog.openInEditor({ editor: 'code', path: filePath })
      });

      if (this._callbacks.onAddToChat) {
        items.push({
          label: t('fileExplorer.addToChat') || 'Reference in chat',
          icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>',
          onClick: () => this._callbacks.onAddToChat(relativePath.replace(/\\/g, '/'), filePath)
        });
      }
    }

    items.push({ separator: true });

    items.push({
      label: t('fileExplorer.copyPath') || 'Copy absolute path',
      icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
      onClick: () => navigator.clipboard.writeText(filePath).catch(() => {})
    });
    items.push({
      label: t('fileExplorer.copyRelativePath') || 'Copy relative path',
      icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
      onClick: () => navigator.clipboard.writeText(relativePath).catch(() => {})
    });

    items.push({ separator: true });

    items.push({
      label: t('fileExplorer.copy') || 'Copy',
      icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
      shortcut: 'Ctrl+C',
      onClick: () => this._copySelectedFiles()
    });

    items.push({
      label: t('fileExplorer.cut') || 'Cut',
      icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zM19 3l-6 6 2 2 7-7V3z"/></svg>',
      shortcut: 'Ctrl+X',
      onClick: () => this._cutSelectedFiles()
    });

    items.push({
      label: t('fileExplorer.duplicate') || 'Duplicate',
      icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm-1 4l6 6v10c0 1.1-.9 2-2 2H7.99C6.89 23 6 22.1 6 21l.01-14c0-1.1.89-2 1.99-2h7zm-1 7h5.5L14 6.5V12z"/></svg>',
      onClick: () => this._duplicateFile(filePath)
    });

    items.push({
      label: t('ui.openInExplorer') || 'Reveal in Explorer',
      icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>',
      onClick: () => this._api.dialog.openInExplorer(isDirectory ? filePath : this._path.dirname(filePath))
    });

    items.push({ separator: true });

    items.push({
      label: t('fileExplorer.rename') || 'Rename',
      icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
      shortcut: 'F2',
      onClick: () => this._startInlineRename(filePath, fileName)
    });

    items.push({
      label: t('common.delete') || 'Delete',
      icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
      danger: true,
      onClick: () => this._promptDelete(filePath, fileName, isDirectory)
    });

    showContextMenu({ x: e.clientX, y: e.clientY, items });
  }

  // ========== FILE OPERATIONS ==========
  async _promptNewFile(dirPath) {
    // Resolves null on cancel, like the native prompt() it replaces, so the
    // guard below still short-circuits.
    const name = await promptForName(t('fileExplorer.newFile'), t('fileExplorer.newFilePrompt'));
    if (!name || !name.trim()) return;

    const sanitized = sanitizeFileName(name.trim());
    const fullPath = this._path.join(dirPath, sanitized);

    if (!isPathSafe(fullPath, this._rootPath, this._path)) {
      Toast.showError(t('fileExplorer.errorOutsideProject'));
      return;
    }

    try {
      await fsp.writeFile(fullPath, '', 'utf-8');
      await this._refreshFolder(dirPath);
      this.render();
      this._selectedFiles.clear();
      this._selectedFiles.add(fullPath);
      this._lastSelectedFile = fullPath;
      this._updateSelectionVisuals();
      this._refreshGitStatus();
    } catch (e) {
      Toast.showError(`${t('common.error')}: ${e.message}`);
    }
  }

  async _promptNewFolder(dirPath) {
    const name = await promptForName(t('fileExplorer.newFolder'), t('fileExplorer.newFolderPrompt'));
    if (!name || !name.trim()) return;

    const sanitized = sanitizeFileName(name.trim());
    const fullPath = this._path.join(dirPath, sanitized);

    if (!isPathSafe(fullPath, this._rootPath, this._path)) {
      Toast.showError(t('fileExplorer.errorOutsideProject'));
      return;
    }

    try {
      await fsp.mkdir(fullPath, { recursive: true });
      await this._refreshFolder(dirPath);
      this.render();
      this._refreshGitStatus();
    } catch (e) {
      Toast.showError(`${t('common.error')}: ${e.message}`);
    }
  }

  async _promptDelete(filePath, fileName, isDirectory) {
    const title = isDirectory
      ? (t('fileExplorer.deleteFolder') || 'Delete folder')
      : (t('fileExplorer.deleteFile') || 'Delete file');
    const msg = isDirectory
      ? (t('fileExplorer.deleteFolderConfirm') || 'Delete folder and all contents?') + `\n${fileName}`
      : (t('fileExplorer.deleteFileConfirm') || 'Delete file?') + `\n${fileName}`;

    const confirmed = await showConfirm({ title, message: msg, confirmLabel: t('common.delete'), danger: true });
    if (!confirmed) return;

    try {
      if (isDirectory) {
        await fsp.rm(filePath, { recursive: true, force: true });
      } else {
        await fsp.unlink(filePath);
      }

      this._expandedFolders.delete(filePath);
      this._selectedFiles.delete(filePath);
      if (this._lastSelectedFile === filePath) this._lastSelectedFile = null;

      const dirPath = this._path.dirname(filePath);
      await this._refreshFolder(dirPath);
      this.render();
      this._refreshGitStatus();
    } catch (e) {
      Toast.showError(`${t('common.error')}: ${e.message}`);
    }
  }

  async _promptDeleteMultiple() {
    const count = this._selectedFiles.size;
    const msg = (t('fileExplorer.deleteMultipleConfirm') || 'Delete {count} items?').replace('{count}', count);
    const confirmed = await showConfirm({ title: t('common.delete') || 'Delete', message: msg, confirmLabel: t('common.delete'), danger: true });
    if (!confirmed) return;

    const toDelete = [...this._selectedFiles];
    for (const filePath of toDelete) {
      try {
        const stat = await fsp.stat(filePath);
        if (stat.isDirectory()) {
          await fsp.rm(filePath, { recursive: true, force: true });
        } else {
          await fsp.unlink(filePath);
        }
        this._expandedFolders.delete(filePath);
        this._selectedFiles.delete(filePath);
      } catch (e) {
        // Continue deleting others
      }
    }

    this._lastSelectedFile = null;

    const parentDirs = new Set(toDelete.map(f => this._path.dirname(f)));
    for (const dir of parentDirs) {
      await this._refreshFolder(dir);
    }
    this.render();
    this._refreshGitStatus();
  }

  // ========== DRAG & DROP ==========
  async _moveItems(sourcePaths, targetDir) {
    for (const sourcePath of sourcePaths) {
      const baseName = this._path.basename(sourcePath);
      const destPath = this._path.join(targetDir, baseName);

      if (sourcePath === targetDir) continue;
      if (isDescendant(sourcePath, targetDir, this._path)) continue;
      if (this._path.dirname(sourcePath) === targetDir) continue;
      if (!isPathSafe(destPath, this._rootPath, this._path)) continue;

      if (await fileExists(destPath)) {
        const overwrite = await showConfirm({
          title: t('fileExplorer.rename') || 'Move',
          message: (t('fileExplorer.renameOverwriteConfirm') || 'A file named "{name}" already exists. Overwrite?').replace('{name}', baseName),
          confirmLabel: t('fileExplorer.overwrite') || 'Overwrite',
          danger: true,
        });
        if (!overwrite) continue;
        try {
          const destStat = await fsp.stat(destPath);
          if (destStat.isDirectory()) {
            await fsp.rm(destPath, { recursive: true, force: true });
          } else {
            await fsp.unlink(destPath);
          }
        } catch (e) {
          continue;
        }
      }

      try {
        await fsp.rename(sourcePath, destPath);

        if (this._expandedFolders.has(sourcePath)) {
          const entry = this._expandedFolders.get(sourcePath);
          this._expandedFolders.delete(sourcePath);
          this._expandedFolders.set(destPath, entry);
        }
        if (this._selectedFiles.has(sourcePath)) {
          this._selectedFiles.delete(sourcePath);
          this._selectedFiles.add(destPath);
        }
        if (this._lastSelectedFile === sourcePath) this._lastSelectedFile = destPath;
      } catch (e) {
        // Skip failed moves
      }
    }

    const affectedDirs = new Set();
    affectedDirs.add(targetDir);
    for (const sp of sourcePaths) affectedDirs.add(this._path.dirname(sp));
    for (const dir of affectedDirs) {
      await this._refreshFolder(dir);
    }
    this.render();
    this._refreshGitStatus();
  }

  // ========== DOTFILES TOGGLE ==========
  toggleDotfiles() {
    const { getSetting, settingsState, saveSettings } = require('../../state/settings.state');
    const current = getSetting('showDotfiles');
    settingsState.setProp('showDotfiles', !current);
    saveSettings();
    const self = this;
    for (const [folderPath, entry] of this._expandedFolders) {
      if (entry.loaded) {
        entry.loaded = false;
        entry.loading = true;
        this._readDirectoryAsync(folderPath).then(children => {
          entry.children = children;
          entry.loaded = true;
          entry.loading = false;
          self.render();
        });
      }
    }
    this.render();
  }

  // ========== EVENT HANDLING ==========
  _attachListeners() {
    const treeEl = document.getElementById('file-explorer-tree');
    if (!treeEl) return;

    treeEl.setAttribute('tabindex', '0');

    const self = this;

    treeEl.onclick = (e) => {
      const node = e.target.closest('.fe-node');
      if (!node || node.classList.contains('fe-truncated')) return;
      if (self._renameActivePath) return;

      const nodePath = node.dataset.path;
      const isDir = node.dataset.isDir === 'true';

      if (isDir) {
        if (e.ctrlKey || e.shiftKey) {
          self._selectFile(nodePath, e.ctrlKey, e.shiftKey);
        } else {
          self._toggleFolder(nodePath);
          self._selectFile(nodePath, false, false);
        }
      } else {
        self._selectFile(nodePath, e.ctrlKey, e.shiftKey);
        if (!e.ctrlKey && !e.shiftKey) {
          self._openFile(nodePath);
        }
      }
    };

    treeEl.oncontextmenu = (e) => {
      const node = e.target.closest('.fe-node');
      if (!node || node.classList.contains('fe-truncated')) {
        if (self._rootPath) {
          self._showFileContextMenu(e, self._rootPath, true);
        }
        return;
      }

      const nodePath = node.dataset.path;
      const isDir = node.dataset.isDir === 'true';
      self._showFileContextMenu(e, nodePath, isDir);
    };

    treeEl.ondblclick = (e) => {
      const node = e.target.closest('.fe-node');
      if (!node) return;
      const nodePath = node.dataset.path;
      const isDir = node.dataset.isDir === 'true';
      if (isDir) return;

      const fileName = self._path.basename(nodePath);
      const dotIdx = fileName.lastIndexOf('.');
      const ext = dotIdx !== -1 ? fileName.substring(dotIdx + 1).toLowerCase() : '';
      if (ext === 'md') {
        e.preventDefault();
        e.stopPropagation();
        const { getSetting: getSettingLocal } = require('../../state/settings.state');
        self._api.dialog.openInEditor({ editor: getSettingLocal('editor') || 'code', path: nodePath });
      }
    };

    treeEl.onkeydown = async (e) => {
      if (e.key === 'F2' && self._lastSelectedFile) {
        e.preventDefault();
        const fileName = self._path.basename(self._lastSelectedFile);
        self._startInlineRename(self._lastSelectedFile, fileName);
      }
      if (e.key === 'Delete' && self._selectedFiles.size > 0) {
        e.preventDefault();
        if (self._selectedFiles.size === 1) {
          const filePath = [...self._selectedFiles][0];
          const fileName = self._path.basename(filePath);
          let isDir = false;
          try {
            const stat = await fsp.stat(filePath);
            isDir = stat.isDirectory();
          } catch {
            // File may not exist anymore
          }
          self._promptDelete(filePath, fileName, isDir);
        } else {
          self._promptDeleteMultiple();
        }
      }
      if (e.key === 'c' && (e.ctrlKey || e.metaKey) && self._selectedFiles.size > 0) {
        e.preventDefault();
        self._copySelectedFiles();
      }
      if (e.key === 'x' && (e.ctrlKey || e.metaKey) && self._selectedFiles.size > 0) {
        e.preventDefault();
        self._cutSelectedFiles();
      }
      if (e.key === 'v' && (e.ctrlKey || e.metaKey) && (self._cutPaths.length > 0 || self._copiedPaths.length > 0)) {
        e.preventDefault();
        let targetDir = self._rootPath;
        if (self._lastSelectedFile) {
          try {
            const stat = await fsp.stat(self._lastSelectedFile);
            if (stat.isDirectory()) {
              targetDir = self._lastSelectedFile;
            } else {
              targetDir = self._path.dirname(self._lastSelectedFile);
            }
          } catch {
            targetDir = self._path.dirname(self._lastSelectedFile);
          }
        }
        if (self._cutPaths.length > 0) {
          self._pasteFiles(targetDir);
        } else {
          self._pasteCopiedFiles(targetDir);
        }
      }
    };

    if (!this._dragListenersAttached) {
      this._dragListenersAttached = true;

      treeEl.addEventListener('dragstart', (e) => {
        const node = e.target.closest('.fe-node');
        if (!node || node.classList.contains('fe-truncated')) return;

        const nodePath = node.dataset.path;

        if (self._selectedFiles.has(nodePath)) {
          self._draggedPaths = [...self._selectedFiles];
        } else {
          self._draggedPaths = [nodePath];
        }

        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', self._draggedPaths.join('\n'));
        node.classList.add('fe-dragging');

        if (self._draggedPaths.length > 1) {
          for (const dp of self._draggedPaths) {
            const el = treeEl.querySelector(`.fe-node[data-path="${CSS.escape(dp)}"]`);
            if (el) el.classList.add('fe-dragging');
          }
        }
      });

      treeEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        const node = e.target.closest('.fe-node');
        if (!node) return;

        const isDir = node.dataset.isDir === 'true';
        if (isDir) {
          const prev = treeEl.querySelector('.fe-drop-target');
          if (prev) prev.classList.remove('fe-drop-target');
          node.classList.add('fe-drop-target');
        }
      });

      treeEl.addEventListener('dragleave', (e) => {
        const node = e.target.closest('.fe-node');
        if (node) node.classList.remove('fe-drop-target');
      });

      treeEl.addEventListener('drop', (e) => {
        e.preventDefault();

        const dropTarget = treeEl.querySelector('.fe-drop-target');
        if (dropTarget) dropTarget.classList.remove('fe-drop-target');

        const node = e.target.closest('.fe-node');
        if (!node) return;

        const targetPath = node.dataset.path;
        const isDir = node.dataset.isDir === 'true';

        if (!isDir || !self._draggedPaths.length) return;

        const validPaths = self._draggedPaths.filter(p =>
          p !== targetPath &&
          !isDescendant(p, targetPath, self._path) &&
          self._path.dirname(p) !== targetPath
        );

        if (validPaths.length > 0) {
          self._moveItems(validPaths, targetPath);
        }
      });

      treeEl.addEventListener('dragend', () => {
        const dragging = treeEl.querySelectorAll('.fe-dragging');
        for (const el of dragging) el.classList.remove('fe-dragging');
        const dropTargets = treeEl.querySelectorAll('.fe-drop-target');
        for (const el of dropTargets) el.classList.remove('fe-drop-target');
        self._draggedPaths = [];
      });
    }

    const btnCollapse = document.getElementById('btn-collapse-explorer');
    if (btnCollapse) {
      btnCollapse.onclick = () => {
        for (const p of self._expandedFolders.keys()) {
          self._api.explorer.unwatchDir(p);
        }
        self._expandedFolders.clear();
        self._selectedFiles.clear();
        self._lastSelectedFile = null;
        self.render();
      };
    }

    const btnRefresh = document.getElementById('btn-refresh-explorer');
    if (btnRefresh) {
      btnRefresh.onclick = () => {
        for (const p of self._expandedFolders.keys()) {
          self._api.explorer.unwatchDir(p);
        }
        self._expandedFolders.clear();
        self.render();
        self._refreshGitStatus();
      };
    }

    const btnClose = document.getElementById('btn-close-explorer');
    if (btnClose) {
      btnClose.onclick = () => {
        self.hide();
      };
    }

    const searchInput = document.getElementById('fe-search-input');
    const searchClear = document.getElementById('fe-search-clear');
    if (searchInput) {
      searchInput.oninput = () => {
        const contentToggle = document.getElementById('fe-content-search-toggle');
        const isContentMode = contentToggle && contentToggle.classList.contains('active');

        if (isContentMode) {
          self._contentSearchQuery = searchInput.value;
          self._searchQuery = '';
          self._searchResults = [];
          if (searchClear) searchClear.style.display = self._contentSearchQuery ? 'flex' : 'none';
          self._performContentSearch();
        } else {
          self._searchQuery = searchInput.value;
          self._contentSearchQuery = '';
          self._contentSearchResults = [];
          if (searchClear) searchClear.style.display = self._searchQuery ? 'flex' : 'none';
          self._performSearch();
        }
      };

      searchInput.onkeydown = (e) => {
        if (e.key === 'Escape') {
          searchInput.value = '';
          self._searchQuery = '';
          self._searchResults = [];
          self._contentSearchQuery = '';
          self._contentSearchResults = [];
          if (searchClear) searchClear.style.display = 'none';
          self.render();
        }
      };
    }

    if (searchClear) {
      searchClear.onclick = () => {
        const input = document.getElementById('fe-search-input');
        if (input) input.value = '';
        self._searchQuery = '';
        self._searchResults = [];
        self._contentSearchQuery = '';
        self._contentSearchResults = [];
        searchClear.style.display = 'none';
        self.render();
      };
    }

    const contentToggle = document.getElementById('fe-content-search-toggle');
    if (contentToggle) {
      contentToggle.onclick = () => {
        contentToggle.classList.toggle('active');
        const input = document.getElementById('fe-search-input');
        if (input) {
          const isContent = contentToggle.classList.contains('active');
          input.placeholder = isContent
            ? (t('fileExplorer.searchContentPlaceholder') || 'Search in file contents...')
            : (t('fileExplorer.searchPlaceholder') || 'Search files...');
          if (input.value) {
            input.dispatchEvent(new Event('input'));
          }
        }
      };
    }

    const sortBtn = document.getElementById('fe-sort-btn');
    if (sortBtn) {
      sortBtn.onclick = (e) => {
        e.stopPropagation();
        const sortModes = [
          { key: 'name', label: t('fileExplorer.sortByName') || 'Name' },
          { key: 'size', label: t('fileExplorer.sortBySize') || 'Size' },
          { key: 'date', label: t('fileExplorer.sortByDate') || 'Date' },
          { key: 'type', label: t('fileExplorer.sortByType') || 'Type' },
        ];
        const menuItems = sortModes.map(m => ({
          label: m.label,
          icon: self._currentSortMode === m.key
            ? '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
            : '',
          onClick: () => self.setSortMode(m.key)
        }));
        showContextMenu({ x: e.clientX, y: e.clientY, items: menuItems });
      };
    }

    // #file-explorer-tree is a static element in index.html: re-rendering only
    // replaces its innerHTML, so listeners bound on it survive and would stack
    // up on every render() (search keystroke, folder expand, ...).
    const treeElForContent = document.getElementById('file-explorer-tree');
    if (treeElForContent && !this._contentMatchListenerAttached) {
      this._contentMatchListenerAttached = true;

      treeElForContent.addEventListener('click', (e) => {
        const matchEl = e.target.closest('.fe-content-match');
        if (matchEl) {
          const matchPath = matchEl.dataset.path;
          if (matchPath) {
            self._openFile(matchPath);
          }
        }
      });
    }
  }

  _toggleFolder(folderPath) {
    const entry = this._expandedFolders.get(folderPath);
    if (entry && entry.loaded) {
      this._expandedFolders.delete(folderPath);
      this._api.explorer.unwatchDir(folderPath);
      this.render();
    } else if (!entry) {
      this._getOrLoadFolder(folderPath);
      this._api.explorer.watchDir(folderPath);
      this.render();
    }
  }

  // ========== RESIZER ==========
  _initResizer() {
    const resizer = document.getElementById('file-explorer-resizer');
    const panel = document.getElementById('file-explorer-panel');
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

      const onMouseMove = (e) => {
        const newWidth = Math.min(500, Math.max(200, startWidth + (e.clientX - startX)));
        panel.style.width = newWidth + 'px';
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        resizer.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        const { settingsState, saveSettingsImmediate } = require('../../state/settings.state');
        settingsState.setProp('fileExplorerWidth', panel.offsetWidth);
        saveSettingsImmediate();
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    const { getSetting: getSettingForWidth, settingsState: ss, saveSettings: saveSett } = require('../../state/settings.state');
    let savedWidth = getSettingForWidth('fileExplorerWidth');
    if (!savedWidth) {
      const legacyWidth = localStorage.getItem('file-explorer-width');
      if (legacyWidth) {
        savedWidth = parseInt(legacyWidth);
        ss.setProp('fileExplorerWidth', savedWidth);
        saveSett();
        localStorage.removeItem('file-explorer-width');
      }
    }
    if (savedWidth) {
      panel.style.width = savedWidth + 'px';
    }
  }

  // ========== INIT ==========
  init() {
    this._initResizer();
    this._attachListeners();
  }

  reloadIgnorePatterns() {
    const self = this;
    for (const [folderPath, entry] of this._expandedFolders) {
      if (entry.loaded) {
        entry.loaded = false;
        entry.loading = true;
        this._readDirectoryAsync(folderPath).then(children => {
          entry.children = children;
          entry.loaded = true;
          entry.loading = false;
          self.render();
        });
      }
    }
    this.render();
  }

  // ========== DESTROY ==========
  destroy() {
    this._stopGitStatusPolling();
    super.destroy();
  }
}

// ========== SINGLETON LEGACY BRIDGE ==========
let _instance = null;
function _getInstance() { if (!_instance) _instance = new FileExplorer(); return _instance; }

module.exports = {
  FileExplorer,
  setCallbacks: (cbs) => _getInstance().setCallbacks(cbs),
  setRootPath: (projectPath) => _getInstance().setRootPath(projectPath),
  show: () => _getInstance().show(),
  hide: () => _getInstance().hide(),
  toggle: () => _getInstance().toggle(),
  open: (projectPath) => _getInstance().open(projectPath),
  render: () => _getInstance().render(),
  setSessionOverlay: (overlay) => _getInstance().setSessionOverlay(overlay),
  setExtraRoots: (paths) => _getInstance().setExtraRoots(paths),
  revealPaths: (paths) => _getInstance().revealPaths(paths),
  toggleDotfiles: () => _getInstance().toggleDotfiles(),
  init: () => _getInstance().init(),
  applyWatcherChanges: (changes) => _getInstance().applyWatcherChanges(changes),
  setSortMode: (mode) => _getInstance().setSortMode(mode),
  reloadIgnorePatterns: () => _getInstance().reloadIgnorePatterns()
};
