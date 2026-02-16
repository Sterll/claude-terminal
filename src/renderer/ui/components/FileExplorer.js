/**
 * FileExplorer Component
 * Displays a file tree for the selected project with preview and context menu
 * Features: multi-selection, inline rename, git status, search, drag & drop
 */

const api = window.electron_api;
const { path, fs } = window.electron_nodeModules;
const { escapeHtml, debounce } = require('../../utils/dom');
const { getFileIcon, CHEVRON_ICON } = require('../../utils/fileIcons');
const { showContextMenu } = require('./ContextMenu');
const { showConfirm } = require('./Modal');
const { t } = require('../../i18n');

// ========== STATE ==========
let rootPath = null;
let selectedFiles = new Set();
let lastSelectedFile = null;
let expandedFolders = new Map(); // path -> { children: [...], loaded: bool }
let callbacks = {
  onOpenInTerminal: null,
  onOpenFile: null
};
let isVisible = false;
let manuallyHidden = false;

// Git status state
let gitStatusMap = new Map(); // relativePath -> { status, staged }
let gitPollingInterval = null;

// Search state
let searchQuery = '';
let searchResults = [];

// Inline rename state
let renameActivePath = null;

// Drag & drop state
let draggedPaths = [];

// Patterns to ignore
const IGNORE_PATTERNS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  '.next', 'vendor', '.cache', '.idea', '.vscode',
  '.DS_Store', 'Thumbs.db', '.env.local', 'coverage',
  '.nuxt', '.output', '.turbo', '.parcel-cache'
]);

// Max entries displayed per folder
const MAX_DISPLAY_ENTRIES = 500;

// ========== CALLBACKS ==========
function setCallbacks(cbs) {
  Object.assign(callbacks, cbs);
}

// ========== PATH VALIDATION ==========
function isPathSafe(targetPath) {
  const resolved = path.resolve(targetPath);
  const root = path.resolve(rootPath);
  return resolved.startsWith(root + path.sep) || resolved === root;
}

function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

// ========== ROOT PATH ==========
function setRootPath(projectPath) {
  if (rootPath === projectPath) return;
  rootPath = projectPath;
  selectedFiles.clear();
  lastSelectedFile = null;
  expandedFolders.clear();
  gitStatusMap.clear();
  searchQuery = '';
  searchResults = [];
  if (rootPath && !manuallyHidden) {
    show();
    render();
  }
  updateSearchBarVisibility();
}

// ========== VISIBILITY ==========
function show() {
  const panel = document.getElementById('file-explorer-panel');
  if (panel) {
    panel.style.display = 'flex';
    isVisible = true;
    startGitStatusPolling();
    updateSearchBarVisibility();
  }
}

function updateSearchBarVisibility() {
  const container = document.getElementById('fe-search-container');
  if (container) {
    container.style.display = rootPath ? 'flex' : 'none';
  }
}

function hide() {
  const panel = document.getElementById('file-explorer-panel');
  if (panel) {
    panel.style.display = 'none';
    isVisible = false;
    stopGitStatusPolling();
  }
}

function toggle() {
  if (isVisible) {
    hide();
    manuallyHidden = true;
  } else if (rootPath) {
    manuallyHidden = false;
    show();
    render();
  }
}

// ========== GIT STATUS ==========
async function refreshGitStatus() {
  if (!rootPath) return;
  try {
    const result = await api.git.statusDetailed({ projectPath: rootPath });
    if (!result || !result.success) return;

    gitStatusMap.clear();
    for (const file of result.files) {
      // Normalize path separators for consistent lookup
      const normalized = file.path.replace(/\//g, path.sep);
      gitStatusMap.set(normalized, { status: file.status, staged: file.staged });
    }

    // Update badges without full re-render if tree is showing
    if (!searchQuery) {
      updateGitBadges();
    }
  } catch (e) {
    // Silently fail - git may not be available
  }
}

function startGitStatusPolling() {
  if (gitPollingInterval) return;
  refreshGitStatus();
  gitPollingInterval = setInterval(refreshGitStatus, 10000);
}

function stopGitStatusPolling() {
  if (gitPollingInterval) {
    clearInterval(gitPollingInterval);
    gitPollingInterval = null;
  }
}

function getGitStatusForPath(absolutePath) {
  if (!rootPath) return null;
  const relativePath = path.relative(rootPath, absolutePath);
  return gitStatusMap.get(relativePath) || null;
}

function getFolderGitStatus(folderAbsPath) {
  if (!rootPath) return null;
  const folderRel = path.relative(rootPath, folderAbsPath);
  // Check if any file in the map is under this folder
  for (const [relPath, status] of gitStatusMap) {
    if (relPath.startsWith(folderRel + path.sep) || relPath === folderRel) {
      return status;
    }
  }
  return null;
}

function getGitBadgeHtml(absolutePath, isDirectory) {
  const gitStatus = isDirectory
    ? getFolderGitStatus(absolutePath)
    : getGitStatusForPath(absolutePath);

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

function updateGitBadges() {
  const treeEl = document.getElementById('file-explorer-tree');
  if (!treeEl) return;

  const nodes = treeEl.querySelectorAll('.fe-node[data-path]');
  for (const node of nodes) {
    const nodePath = node.dataset.path;
    const isDir = node.dataset.isDir === 'true';
    const existingBadge = node.querySelector('.fe-git-status');
    const newBadgeHtml = getGitBadgeHtml(nodePath, isDir);

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
async function readDirectoryAsync(dirPath) {
  try {
    const exists = await fs.promises.access(dirPath).then(() => true).catch(() => false);
    if (!exists) return [];

    const names = await fs.promises.readdir(dirPath);
    const result = [];
    let skipped = 0;

    for (const name of names) {
      if (IGNORE_PATTERNS.has(name)) continue;
      if (name.startsWith('.') && name !== '.env' && name !== '.gitignore') continue;

      if (result.length >= MAX_DISPLAY_ENTRIES) {
        skipped++;
        continue;
      }

      try {
        const fullPath = path.join(dirPath, name);
        const stat = await fs.promises.stat(fullPath);
        result.push({
          name,
          path: fullPath,
          isDirectory: stat.isDirectory()
        });
      } catch (e) {
        // Skip entries we can't stat
      }
    }

    // Sort: directories first, then alphabetical
    result.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    if (skipped > 0) {
      result.push({
        name: `... +${skipped} more items`,
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

function getOrLoadFolder(folderPath) {
  let entry = expandedFolders.get(folderPath);
  if (entry) return entry; // Already loaded or loading - don't restart
  // Return placeholder synchronously, load async in background
  entry = { children: [], loaded: false, loading: true };
  expandedFolders.set(folderPath, entry);
  readDirectoryAsync(folderPath).then(children => {
    entry.children = children;
    entry.loaded = true;
    entry.loading = false;
    render();
  }).catch(() => {
    entry.loaded = true;
    entry.loading = false;
    render();
  });
  return entry;
}

async function refreshFolder(folderPath) {
  const entry = expandedFolders.get(folderPath);
  if (entry) {
    entry.children = await readDirectoryAsync(folderPath);
    entry.loaded = true;
  }
}

// ========== MULTI-SELECTION ==========
function getVisibleNodePaths() {
  const paths = [];
  function walk(dirPath) {
    const entry = expandedFolders.get(dirPath);
    if (!entry || !entry.loaded) return;
    for (const item of entry.children) {
      if (item.isTruncated) continue;
      paths.push(item.path);
      if (item.isDirectory && expandedFolders.has(item.path) && expandedFolders.get(item.path).loaded) {
        walk(item.path);
      }
    }
  }
  walk(rootPath);
  return paths;
}

function selectFile(filePath, ctrlKey, shiftKey) {
  if (shiftKey && lastSelectedFile) {
    // Range selection
    const visible = getVisibleNodePaths();
    const startIdx = visible.indexOf(lastSelectedFile);
    const endIdx = visible.indexOf(filePath);
    if (startIdx !== -1 && endIdx !== -1) {
      if (!ctrlKey) selectedFiles.clear();
      const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
      for (let i = from; i <= to; i++) {
        selectedFiles.add(visible[i]);
      }
    }
  } else if (ctrlKey) {
    // Toggle selection
    if (selectedFiles.has(filePath)) {
      selectedFiles.delete(filePath);
    } else {
      selectedFiles.add(filePath);
    }
  } else {
    // Single selection
    selectedFiles.clear();
    selectedFiles.add(filePath);
  }

  lastSelectedFile = filePath;
  updateSelectionVisuals();
}

function updateSelectionVisuals() {
  const treeEl = document.getElementById('file-explorer-tree');
  if (!treeEl) return;
  const nodes = treeEl.querySelectorAll('.fe-node[data-path]');
  for (const node of nodes) {
    node.classList.toggle('selected', selectedFiles.has(node.dataset.path));
  }
}

// ========== SEARCH ==========
async function collectAllFiles(dirPath, maxFiles = 5000) {
  const results = [];
  const queue = [dirPath];

  while (queue.length > 0 && results.length < maxFiles) {
    const dir = queue.shift();
    try {
      const names = await fs.promises.readdir(dir);
      for (const name of names) {
        if (IGNORE_PATTERNS.has(name)) continue;
        if (name.startsWith('.') && name !== '.env' && name !== '.gitignore') continue;

        const fullPath = path.join(dir, name);
        try {
          const stat = await fs.promises.stat(fullPath);
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

const performSearch = debounce(async () => {
  const query = searchQuery.trim().toLowerCase();
  if (!query || !rootPath) {
    searchResults = [];
    render();
    return;
  }

  const allFiles = await collectAllFiles(rootPath);
  searchResults = allFiles.filter(f => f.name.toLowerCase().includes(query));
  render();
}, 250);

function renderSearchResults() {
  if (searchResults.length === 0) {
    return `<div class="fe-empty">${t('fileExplorer.noResults') || 'No results'}</div>`;
  }

  const parts = [];
  for (const file of searchResults.slice(0, 200)) {
    const icon = getFileIcon(file.name, false, false);
    const relativePath = rootPath ? path.relative(rootPath, path.dirname(file.path)) : '';
    const isSelected = selectedFiles.has(file.path);

    // Highlight matching part
    const query = searchQuery.trim().toLowerCase();
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
function startInlineRename(filePath, fileName) {
  renameActivePath = filePath;
  const node = document.querySelector(`.fe-node[data-path="${CSS.escape(filePath)}"]`);
  if (!node) return;

  const nameEl = node.querySelector('.fe-node-name');
  if (!nameEl) return;

  const isDir = node.dataset.isDir === 'true';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'fe-inline-rename';
  input.value = fileName;

  // Select name without extension for files
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

  const commit = async () => {
    const newName = input.value.trim();
    renameActivePath = null;
    if (!newName || newName === fileName) {
      render();
      return;
    }
    await executeRename(filePath, newName);
  };

  const cancel = () => {
    renameActivePath = null;
    render();
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

async function executeRename(filePath, newName) {
  const sanitized = sanitizeFileName(newName);
  const dirPath = path.dirname(filePath);
  const newPath = path.join(dirPath, sanitized);

  if (!isPathSafe(newPath)) {
    alert('Cannot rename outside the project folder.');
    render();
    return;
  }

  if (fs.existsSync(newPath)) {
    alert('A file or folder with this name already exists.');
    render();
    return;
  }

  try {
    fs.renameSync(filePath, newPath);

    if (expandedFolders.has(filePath)) {
      const entry = expandedFolders.get(filePath);
      expandedFolders.delete(filePath);
      expandedFolders.set(newPath, entry);
    }

    if (selectedFiles.has(filePath)) {
      selectedFiles.delete(filePath);
      selectedFiles.add(newPath);
    }
    if (lastSelectedFile === filePath) {
      lastSelectedFile = newPath;
    }

    await refreshFolder(dirPath);
    render();
    refreshGitStatus();
  } catch (e) {
    const userMessage = (e.code === 'EBUSY' || e.code === 'EPERM')
      ? 'File is locked by another process. Close it and try again.'
      : `Error: ${e.message}`;
    alert(userMessage);
    render();
  }
}

// ========== RENDER ==========
function render() {
  if (!rootPath) return;

  const treeEl = document.getElementById('file-explorer-tree');
  if (!treeEl) return;

  if (searchQuery.trim()) {
    treeEl.innerHTML = renderSearchResults();
  } else {
    treeEl.innerHTML = renderTreeNodes(rootPath, 0);
  }
  attachListeners();
}

function renderTreeNodes(dirPath, depth) {
  const entry = getOrLoadFolder(dirPath);
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

    const isExpanded = expandedFolders.has(item.path) && expandedFolders.get(item.path).loaded;
    const isSelected = selectedFiles.has(item.path);

    const indent = depth * 16;
    const icon = getFileIcon(item.name, item.isDirectory, isExpanded);
    const chevron = item.isDirectory
      ? `<span class="fe-node-chevron ${isExpanded ? 'expanded' : ''}">${CHEVRON_ICON}</span>`
      : `<span class="fe-node-chevron-spacer"></span>`;

    const gitBadge = getGitBadgeHtml(item.path, item.isDirectory);

    parts.push(`<div class="fe-node ${isSelected ? 'selected' : ''} ${item.isDirectory ? 'fe-dir' : 'fe-file'}"
      data-path="${escapeHtml(item.path)}"
      data-name="${escapeHtml(item.name)}"
      data-is-dir="${item.isDirectory}"
      draggable="true"
      style="padding-left: ${8 + indent}px;">
      ${chevron}
      <span class="fe-node-icon">${icon}</span>
      <span class="fe-node-name" title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</span>
      ${gitBadge}
    </div>`);

    if (item.isDirectory && isExpanded) {
      parts.push(renderTreeNodes(item.path, depth + 1));
    }
  }

  return parts.join('');
}

// ========== OPEN FILE ==========
function openFile(filePath) {
  if (callbacks.onOpenFile) {
    callbacks.onOpenFile(filePath);
  } else {
    // Fallback: open in default editor
    api.dialog.openInEditor({ editor: 'code', path: filePath });
  }
}

// ========== CONTEXT MENU ==========
function showFileContextMenu(e, filePath, isDirectory) {
  e.preventDefault();
  e.stopPropagation();
  const fileName = path.basename(filePath);
  const relativePath = rootPath ? path.relative(rootPath, filePath) : filePath;

  // If right-click on unselected item, select only that one
  if (!selectedFiles.has(filePath)) {
    selectedFiles.clear();
    selectedFiles.add(filePath);
    lastSelectedFile = filePath;
    updateSelectionVisuals();
  }

  const items = [];
  const multiSelected = selectedFiles.size > 1;

  if (multiSelected) {
    // Multi-selection context menu
    items.push({
      label: `${selectedFiles.size} ${t('fileExplorer.selectedItems') || 'items selected'}`,
      icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z"/></svg>',
      disabled: true
    });
    items.push({ separator: true });
    items.push({
      label: t('common.delete') || 'Delete',
      icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
      danger: true,
      onClick: () => promptDeleteMultiple()
    });
    showContextMenu({ x: e.clientX, y: e.clientY, items });
    return;
  }

  if (isDirectory) {
    items.push({
      label: t('fileExplorer.newFile') || 'New file',
      icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 14h-3v3h-2v-3H8v-2h3v-3h2v3h3v2zm-3-7V3.5L18.5 9H13z"/></svg>',
      onClick: () => promptNewFile(filePath)
    });
    items.push({
      label: t('fileExplorer.newFolder') || 'New folder',
      icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z"/></svg>',
      onClick: () => promptNewFolder(filePath)
    });
    items.push({ separator: true });
    if (callbacks.onOpenInTerminal) {
      items.push({
        label: t('fileExplorer.openInTerminal') || 'Open in terminal',
        icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.89 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>',
        onClick: () => callbacks.onOpenInTerminal(filePath)
      });
    }
    items.push({
      label: t('fileExplorer.refreshFolder') || 'Refresh',
      icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>',
      onClick: async () => { await refreshFolder(filePath); render(); }
    });
  } else {
    items.push({
      label: t('fileExplorer.openInEditor') || 'Open in editor',
      icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
      onClick: () => api.dialog.openInEditor({ editor: 'code', path: filePath })
    });
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
    label: t('ui.openInExplorer') || 'Reveal in Explorer',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>',
    onClick: () => api.dialog.openInExplorer(isDirectory ? filePath : path.dirname(filePath))
  });

  items.push({ separator: true });

  items.push({
    label: t('fileExplorer.rename') || 'Rename',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
    shortcut: 'F2',
    onClick: () => startInlineRename(filePath, fileName)
  });

  items.push({
    label: t('common.delete') || 'Delete',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
    danger: true,
    onClick: () => promptDelete(filePath, fileName, isDirectory)
  });

  showContextMenu({ x: e.clientX, y: e.clientY, items });
}

// ========== FILE OPERATIONS ==========
async function promptNewFile(dirPath) {
  const name = prompt(t('fileExplorer.newFilePrompt') || 'File name:');
  if (!name || !name.trim()) return;

  const sanitized = sanitizeFileName(name.trim());
  const fullPath = path.join(dirPath, sanitized);

  if (!isPathSafe(fullPath)) {
    alert('Cannot create files outside the project folder.');
    return;
  }

  try {
    fs.writeFileSync(fullPath, '', 'utf-8');
    await refreshFolder(dirPath);
    render();
    selectedFiles.clear();
    selectedFiles.add(fullPath);
    lastSelectedFile = fullPath;
    updateSelectionVisuals();
    refreshGitStatus();
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
}

async function promptNewFolder(dirPath) {
  const name = prompt(t('fileExplorer.newFolderPrompt') || 'Folder name:');
  if (!name || !name.trim()) return;

  const sanitized = sanitizeFileName(name.trim());
  const fullPath = path.join(dirPath, sanitized);

  if (!isPathSafe(fullPath)) {
    alert('Cannot create folders outside the project folder.');
    return;
  }

  try {
    fs.mkdirSync(fullPath, { recursive: true });
    await refreshFolder(dirPath);
    render();
    refreshGitStatus();
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
}

async function promptDelete(filePath, fileName, isDirectory) {
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
      fs.rmSync(filePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(filePath);
    }

    expandedFolders.delete(filePath);
    selectedFiles.delete(filePath);
    if (lastSelectedFile === filePath) lastSelectedFile = null;

    const dirPath = path.dirname(filePath);
    await refreshFolder(dirPath);
    render();
    refreshGitStatus();
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
}

async function promptDeleteMultiple() {
  const count = selectedFiles.size;
  const msg = (t('fileExplorer.deleteMultipleConfirm') || 'Delete {count} items?').replace('{count}', count);
  const confirmed = await showConfirm({ title: t('common.delete') || 'Delete', message: msg, confirmLabel: t('common.delete'), danger: true });
  if (!confirmed) return;

  const toDelete = [...selectedFiles];
  for (const filePath of toDelete) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        fs.rmSync(filePath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(filePath);
      }
      expandedFolders.delete(filePath);
      selectedFiles.delete(filePath);
    } catch (e) {
      // Continue deleting others
    }
  }

  lastSelectedFile = null;

  // Refresh all parent folders
  const parentDirs = new Set(toDelete.map(f => path.dirname(f)));
  for (const dir of parentDirs) {
    await refreshFolder(dir);
  }
  render();
  refreshGitStatus();
}

// ========== DRAG & DROP ==========
function isDescendant(parentPath, childPath) {
  const resolvedParent = path.resolve(parentPath);
  const resolvedChild = path.resolve(childPath);
  return resolvedChild.startsWith(resolvedParent + path.sep);
}

async function moveItems(sourcePaths, targetDir) {
  for (const sourcePath of sourcePaths) {
    const baseName = path.basename(sourcePath);
    const destPath = path.join(targetDir, baseName);

    // Validation
    if (sourcePath === targetDir) continue;
    if (isDescendant(sourcePath, targetDir)) continue;
    if (path.dirname(sourcePath) === targetDir) continue;
    if (!isPathSafe(destPath)) continue;
    if (fs.existsSync(destPath)) continue;

    try {
      fs.renameSync(sourcePath, destPath);

      if (expandedFolders.has(sourcePath)) {
        const entry = expandedFolders.get(sourcePath);
        expandedFolders.delete(sourcePath);
        expandedFolders.set(destPath, entry);
      }
      if (selectedFiles.has(sourcePath)) {
        selectedFiles.delete(sourcePath);
        selectedFiles.add(destPath);
      }
      if (lastSelectedFile === sourcePath) lastSelectedFile = destPath;
    } catch (e) {
      // Skip failed moves
    }
  }

  // Refresh affected folders
  const affectedDirs = new Set();
  affectedDirs.add(targetDir);
  for (const sp of sourcePaths) affectedDirs.add(path.dirname(sp));
  for (const dir of affectedDirs) {
    await refreshFolder(dir);
  }
  render();
  refreshGitStatus();
}

// ========== EVENT HANDLING ==========
function attachListeners() {
  const treeEl = document.getElementById('file-explorer-tree');
  if (!treeEl) return;

  treeEl.setAttribute('tabindex', '0');

  // Use event delegation - click
  treeEl.onclick = (e) => {
    const node = e.target.closest('.fe-node');
    if (!node || node.classList.contains('fe-truncated')) return;
    if (renameActivePath) return; // Don't interfere with rename

    const nodePath = node.dataset.path;
    const isDir = node.dataset.isDir === 'true';

    if (isDir) {
      if (e.ctrlKey || e.shiftKey) {
        selectFile(nodePath, e.ctrlKey, e.shiftKey);
      } else {
        toggleFolder(nodePath);
        selectFile(nodePath, false, false);
      }
    } else {
      selectFile(nodePath, e.ctrlKey, e.shiftKey);
      if (!e.ctrlKey && !e.shiftKey) {
        openFile(nodePath);
      }
    }
  };

  // Context menu
  treeEl.oncontextmenu = (e) => {
    const node = e.target.closest('.fe-node');
    if (!node || node.classList.contains('fe-truncated')) {
      if (rootPath) {
        showFileContextMenu(e, rootPath, true);
      }
      return;
    }

    const nodePath = node.dataset.path;
    const isDir = node.dataset.isDir === 'true';
    showFileContextMenu(e, nodePath, isDir);
  };

  // Keyboard: F2 for rename, Delete key
  treeEl.onkeydown = (e) => {
    if (e.key === 'F2' && lastSelectedFile) {
      e.preventDefault();
      const fileName = path.basename(lastSelectedFile);
      startInlineRename(lastSelectedFile, fileName);
    }
    if (e.key === 'Delete' && selectedFiles.size > 0) {
      e.preventDefault();
      if (selectedFiles.size === 1) {
        const filePath = [...selectedFiles][0];
        const fileName = path.basename(filePath);
        const isDir = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
        promptDelete(filePath, fileName, isDir);
      } else {
        promptDeleteMultiple();
      }
    }
  };

  // Drag & drop (event delegation)
  treeEl.addEventListener('dragstart', (e) => {
    const node = e.target.closest('.fe-node');
    if (!node || node.classList.contains('fe-truncated')) return;

    const nodePath = node.dataset.path;

    // If dragging a selected item, drag all selected items
    if (selectedFiles.has(nodePath)) {
      draggedPaths = [...selectedFiles];
    } else {
      draggedPaths = [nodePath];
    }

    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedPaths.join('\n'));
    node.classList.add('fe-dragging');

    // Mark all dragged items
    if (draggedPaths.length > 1) {
      for (const dp of draggedPaths) {
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
      // Remove previous drop target
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

    // Clean up
    const dropTarget = treeEl.querySelector('.fe-drop-target');
    if (dropTarget) dropTarget.classList.remove('fe-drop-target');

    const node = e.target.closest('.fe-node');
    if (!node) return;

    const targetPath = node.dataset.path;
    const isDir = node.dataset.isDir === 'true';

    if (!isDir || !draggedPaths.length) return;

    // Validate moves
    const validPaths = draggedPaths.filter(p =>
      p !== targetPath &&
      !isDescendant(p, targetPath) &&
      path.dirname(p) !== targetPath
    );

    if (validPaths.length > 0) {
      moveItems(validPaths, targetPath);
    }
  });

  treeEl.addEventListener('dragend', () => {
    // Clean all drag states
    const dragging = treeEl.querySelectorAll('.fe-dragging');
    for (const el of dragging) el.classList.remove('fe-dragging');
    const dropTargets = treeEl.querySelectorAll('.fe-drop-target');
    for (const el of dropTargets) el.classList.remove('fe-drop-target');
    draggedPaths = [];
  });

  // Header buttons
  const btnCollapse = document.getElementById('btn-collapse-explorer');
  if (btnCollapse) {
    btnCollapse.onclick = () => {
      expandedFolders.clear();
      selectedFiles.clear();
      lastSelectedFile = null;
      render();
    };
  }

  const btnRefresh = document.getElementById('btn-refresh-explorer');
  if (btnRefresh) {
    btnRefresh.onclick = () => {
      expandedFolders.clear();
      render();
      refreshGitStatus();
    };
  }

  const btnClose = document.getElementById('btn-close-explorer');
  if (btnClose) {
    btnClose.onclick = () => {
      hide();
      manuallyHidden = true;
    };
  }

  // Search input
  const searchInput = document.getElementById('fe-search-input');
  const searchClear = document.getElementById('fe-search-clear');
  if (searchInput) {
    searchInput.oninput = () => {
      searchQuery = searchInput.value;
      if (searchClear) searchClear.style.display = searchQuery ? 'flex' : 'none';
      performSearch();
    };

    searchInput.onkeydown = (e) => {
      if (e.key === 'Escape') {
        searchInput.value = '';
        searchQuery = '';
        searchResults = [];
        if (searchClear) searchClear.style.display = 'none';
        render();
      }
    };
  }

  if (searchClear) {
    searchClear.onclick = () => {
      const input = document.getElementById('fe-search-input');
      if (input) input.value = '';
      searchQuery = '';
      searchResults = [];
      searchClear.style.display = 'none';
      render();
    };
  }
}

function toggleFolder(folderPath) {
  const entry = expandedFolders.get(folderPath);
  if (entry && entry.loaded) {
    expandedFolders.delete(folderPath);
    render();
  } else if (!entry) {
    // Not loaded yet - start loading
    getOrLoadFolder(folderPath);
    render(); // Show loading state immediately
  }
  // If entry exists but still loading, do nothing - render will happen when loaded
}

// ========== RESIZER ==========
function initResizer() {
  const resizer = document.getElementById('file-explorer-resizer');
  const panel = document.getElementById('file-explorer-panel');
  if (!resizer || !panel) return;

  let startX, startWidth;

  resizer.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (e) => {
      const newWidth = Math.min(500, Math.max(200, startWidth + (e.clientX - startX)));
      panel.style.width = newWidth + 'px';
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('file-explorer-width', panel.offsetWidth);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  // Restore saved width
  const savedWidth = localStorage.getItem('file-explorer-width');
  if (savedWidth) {
    panel.style.width = savedWidth + 'px';
  }
}

// ========== INIT ==========
function init() {
  initResizer();
  attachListeners();
}

// ========== EXPORTS ==========
module.exports = {
  setCallbacks,
  setRootPath,
  show,
  hide,
  toggle,
  init
};
