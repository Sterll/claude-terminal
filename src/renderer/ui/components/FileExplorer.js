/**
 * FileExplorer Component
 * Displays a file tree for the selected project with preview and context menu
 * Features: multi-selection, inline rename, git status, search, drag & drop, copy/cut/paste,
 *           content search, duplicate, configurable sort & ignore patterns
 */

const api = window.electron_api;
const { path, fs } = window.electron_nodeModules;
const { fileExists, copyDirRecursive, fsp } = require('../../utils/fs-async');
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
let _dragListenersAttached = false;

// Keyboard cut/paste state
let cutPaths = [];

// Copy state (distinct from cut - copies files instead of moving)
let copiedPaths = [];

// Content search state
let contentSearchQuery = '';
let contentSearchResults = [];
let isContentSearching = false;

// Sort state
let currentSortMode = 'name'; // 'name' | 'size' | 'date' | 'type'

// Default ignore patterns
const DEFAULT_IGNORE_PATTERNS = [
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  '.next', 'vendor', '.cache', '.idea', '.vscode',
  '.DS_Store', 'Thumbs.db', '.env.local', 'coverage',
  '.nuxt', '.output', '.turbo', '.parcel-cache'
];

// Active ignore patterns (merges default + user-configured)
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
  cutPaths = [];
  copiedPaths = [];
  contentSearchQuery = '';
  contentSearchResults = [];
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

    const { getSetting } = require('../../state/settings.state');
    const showDotfiles = getSetting('showDotfiles');
    const ignorePatterns = getIgnorePatterns();

    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const result = [];
    let skipped = 0;

    for (const entry of entries) {
      if (ignorePatterns.has(entry.name)) continue;
      if (showDotfiles === false && entry.name.startsWith('.')) continue;

      if (result.length >= MAX_DISPLAY_ENTRIES) {
        skipped++;
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);
      const item = {
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory()
      };

      // Fetch stat info for sort modes other than name
      if (currentSortMode !== 'name') {
        try {
          const stat = await fs.promises.stat(fullPath);
          item.size = stat.size;
          item.mtime = stat.mtimeMs;
        } catch { /* ignore stat errors */ }
      }

      result.push(item);
    }

    sortEntries(result);

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

function sortEntries(entries) {
  entries.sort((a, b) => {
    // Always directories first
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;

    switch (currentSortMode) {
      case 'size':
        return (b.size || 0) - (a.size || 0);
      case 'date':
        return (b.mtime || 0) - (a.mtime || 0);
      case 'type': {
        const extA = path.extname(a.name).toLowerCase();
        const extB = path.extname(b.name).toLowerCase();
        if (extA !== extB) return extA.localeCompare(extB);
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      }
      default: // 'name'
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    }
  });
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

async function applyWatcherChanges(changes) {
  try {
    if (!rootPath || !changes || !changes.length) return;

    const affectedParents = new Set();

    for (const change of changes) {
      const parentDir = path.dirname(change.path);

      if (change.type === 'add') {
        // Only re-read parent if it's a tracked (loaded) folder
        const entry = expandedFolders.get(parentDir);
        if (entry && entry.loaded) {
          affectedParents.add(parentDir);
        }
        // If parent is untracked/collapsed, no action — loads fresh from disk when expanded
      } else if (change.type === 'remove') {
        // Remove the deleted item from parent's children array
        const entry = expandedFolders.get(parentDir);
        if (entry && entry.loaded) {
          entry.children = entry.children.filter(c => c.path !== change.path);
        }
        // For directory deletion: remove the folder AND all descendants from expandedFolders
        if (change.isDirectory) {
          const prefix = change.path + path.sep;
          for (const key of [...expandedFolders.keys()]) {
            if (key === change.path || key.startsWith(prefix)) {
              expandedFolders.delete(key);
            }
          }
        }
        // Clean up selection state for deleted items
        selectedFiles.delete(change.path);
        if (lastSelectedFile === change.path) lastSelectedFile = null;
      }
    }

    // Re-read affected parent directories for additions (to get correctly sorted, stat-complete children)
    for (const parentDir of affectedParents) {
      const entry = expandedFolders.get(parentDir);
      if (entry) {
        entry.children = await readDirectoryAsync(parentDir);
      }
    }

    // Single render call after all patches applied
    render();
  } catch {
    // Silently ignore — stale paths, permission errors, etc.
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
    const isCut = cutPaths.includes(node.dataset.path);
    const isCopied = copiedPaths.includes(node.dataset.path);
    node.classList.toggle('selected', selectedFiles.has(node.dataset.path));
    node.classList.toggle('fe-cut', isCut);
    node.classList.toggle('fe-copied', isCopied);
  }
}

// ========== SEARCH ==========
async function collectAllFiles(dirPath, maxFiles = 5000) {
  const { getSetting } = require('../../state/settings.state');
  const showDotfiles = getSetting('showDotfiles');
  const ignorePatterns = getIgnorePatterns();

  const results = [];
  const queue = [dirPath];

  while (queue.length > 0 && results.length < maxFiles) {
    const dir = queue.shift();
    try {
      const names = await fs.promises.readdir(dir);
      for (const name of names) {
        if (ignorePatterns.has(name)) continue;
        if (showDotfiles === false && name.startsWith('.')) continue;

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

  // Check if target already exists — ask for confirmation
  if (await fileExists(newPath)) {
    const overwrite = await showConfirm({
      title: t('fileExplorer.rename') || 'Rename',
      message: (t('fileExplorer.renameOverwriteConfirm') || 'A file named "{name}" already exists. Overwrite?').replace('{name}', sanitized),
      confirmLabel: t('fileExplorer.overwrite') || 'Overwrite',
      danger: true,
    });
    if (!overwrite) {
      render();
      return;
    }
    // Remove existing target before rename
    try {
      const stat = await fsp.stat(newPath);
      if (stat.isDirectory()) {
        await fsp.rm(newPath, { recursive: true, force: true });
      } else {
        await fsp.unlink(newPath);
      }
    } catch (e) {
      alert(`Error removing existing file: ${e.message}`);
      render();
      return;
    }
  }

  try {
    await fsp.rename(filePath, newPath);

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

// ========== KEYBOARD CUT/PASTE ==========
function cutSelectedFiles() {
  if (selectedFiles.size === 0) return;
  cutPaths = [...selectedFiles];
  copiedPaths = []; // Clear copy if cutting
  updateSelectionVisuals();
}

async function pasteFiles(targetDir) {
  if (cutPaths.length === 0 || !targetDir) return;

  const sourcePaths = [...cutPaths];
  cutPaths = [];

  await moveItems(sourcePaths, targetDir);
}

// ========== COPY FILES ==========
function copySelectedFiles() {
  if (selectedFiles.size === 0) return;
  copiedPaths = [...selectedFiles];
  cutPaths = []; // Clear cut if copying
  updateSelectionVisuals();
}

async function pasteCopiedFiles(targetDir) {
  if (copiedPaths.length === 0 || !targetDir) return;

  const sourcePaths = [...copiedPaths];

  for (const sourcePath of sourcePaths) {
    const baseName = path.basename(sourcePath);
    let destPath = path.join(targetDir, baseName);

    if (sourcePath === destPath) continue;
    if (!isPathSafe(destPath)) continue;

    // If destination exists, generate unique name
    if (await fileExists(destPath)) {
      destPath = await generateCopyName(targetDir, baseName);
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

  await refreshFolder(targetDir);
  render();
  refreshGitStatus();
}

async function generateCopyName(targetDir, baseName) {
  const ext = path.extname(baseName);
  const nameNoExt = ext ? baseName.slice(0, -ext.length) : baseName;
  let counter = 1;
  let newPath;
  do {
    const newName = ext ? `${nameNoExt} (${counter})${ext}` : `${nameNoExt} (${counter})`;
    newPath = path.join(targetDir, newName);
    counter++;
  } while (await fileExists(newPath));
  return newPath;
}

// ========== DUPLICATE FILE ==========
async function duplicateFile(filePath) {
  const dirPath = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const destPath = await generateCopyName(dirPath, baseName);

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      await copyDirRecursive(filePath, destPath);
    } else {
      await fsp.copyFile(filePath, destPath);
    }

    await refreshFolder(dirPath);
    render();

    // Select the new file
    selectedFiles.clear();
    selectedFiles.add(destPath);
    lastSelectedFile = destPath;
    updateSelectionVisuals();
    refreshGitStatus();
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
}

// ========== CONTENT SEARCH ==========
const performContentSearch = debounce(async () => {
  const query = contentSearchQuery.trim();
  if (!query || !rootPath) {
    contentSearchResults = [];
    isContentSearching = false;
    render();
    return;
  }

  isContentSearching = true;
  render();

  const results = [];
  const allFiles = await collectAllFiles(rootPath, 3000);

  // Binary file extensions to skip
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

    const ext = path.extname(file.name).toLowerCase();
    if (binaryExts.has(ext)) continue;

    try {
      const content = await fs.promises.readFile(file.path, 'utf-8');
      const lines = content.split('\n');
      const matches = [];

      for (let i = 0; i < lines.length; i++) {
        const idx = lines[i].toLowerCase().indexOf(query.toLowerCase());
        if (idx !== -1) {
          matches.push({ line: i + 1, text: lines[i].trim().substring(0, 200) });
          if (matches.length >= 3) break; // Max 3 matches per file
        }
      }

      if (matches.length > 0) {
        results.push({ name: file.name, path: file.path, matches });
      }
    } catch { /* skip unreadable files */ }
  }

  contentSearchResults = results;
  isContentSearching = false;
  render();
}, 400);

function renderContentSearchResults() {
  if (isContentSearching) {
    return `<div class="fe-empty">${t('common.loading') || 'Searching...'}</div>`;
  }
  if (contentSearchResults.length === 0) {
    return `<div class="fe-empty">${t('fileExplorer.noResults') || 'No results'}</div>`;
  }

  const parts = [];
  const query = contentSearchQuery.trim().toLowerCase();

  for (const file of contentSearchResults) {
    const icon = getFileIcon(file.name, false, false);
    const relativePath = rootPath ? path.relative(rootPath, file.path) : file.path;
    const isSelected = selectedFiles.has(file.path);

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
      // Highlight matching text in line
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
function setSortMode(mode) {
  if (currentSortMode === mode) return;
  currentSortMode = mode;
  // Reload all expanded folders with new sort
  const foldersToReload = [...expandedFolders.keys()];
  for (const folderPath of foldersToReload) {
    const entry = expandedFolders.get(folderPath);
    if (entry && entry.loaded) {
      entry.loaded = false;
      entry.loading = true;
      readDirectoryAsync(folderPath).then(children => {
        entry.children = children;
        entry.loaded = true;
        entry.loading = false;
        render();
      });
    }
  }
  render();
}

// ========== RENDER ==========
function render() {
  if (!rootPath) return;

  const treeEl = document.getElementById('file-explorer-tree');
  if (!treeEl) return;

  if (contentSearchQuery.trim()) {
    treeEl.innerHTML = renderContentSearchResults();
  } else if (searchQuery.trim()) {
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
    const isCut = cutPaths.includes(item.path);
    const isCopied = copiedPaths.includes(item.path);

    const indent = depth * 16;
    const icon = getFileIcon(item.name, item.isDirectory, isExpanded);
    const chevron = item.isDirectory
      ? `<span class="fe-node-chevron ${isExpanded ? 'expanded' : ''}">${CHEVRON_ICON}</span>`
      : `<span class="fe-node-chevron-spacer"></span>`;

    const gitBadge = getGitBadgeHtml(item.path, item.isDirectory);

    parts.push(`<div class="fe-node ${isSelected ? 'selected' : ''} ${isCut ? 'fe-cut' : ''} ${isCopied ? 'fe-copied' : ''} ${item.isDirectory ? 'fe-dir' : 'fe-file'}"
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
      label: t('fileExplorer.copy') || 'Copy',
      icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
      shortcut: 'Ctrl+C',
      onClick: () => copySelectedFiles()
    });
    items.push({
      label: t('fileExplorer.cut') || 'Cut',
      icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zM19 3l-6 6 2 2 7-7V3z"/></svg>',
      shortcut: 'Ctrl+X',
      onClick: () => cutSelectedFiles()
    });
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
    if (cutPaths.length > 0) {
      items.push({
        label: (t('fileExplorer.pasteHere') || 'Paste here') + ` (${cutPaths.length})`,
        icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 2h-4.18C14.4.84 13.3 0 12 0c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 18H5V4h2v3h10V4h2v16z"/></svg>',
        shortcut: 'Ctrl+V',
        onClick: () => pasteFiles(filePath)
      });
      items.push({ separator: true });
    }
    if (copiedPaths.length > 0) {
      items.push({
        label: (t('fileExplorer.pasteHere') || 'Paste here') + ` (${copiedPaths.length})`,
        icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 2h-4.18C14.4.84 13.3 0 12 0c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 18H5V4h2v3h10V4h2v16z"/></svg>',
        shortcut: 'Ctrl+V',
        onClick: () => pasteCopiedFiles(filePath)
      });
      items.push({ separator: true });
    }
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
    label: t('fileExplorer.copy') || 'Copy',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
    shortcut: 'Ctrl+C',
    onClick: () => copySelectedFiles()
  });

  items.push({
    label: t('fileExplorer.cut') || 'Cut',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zM19 3l-6 6 2 2 7-7V3z"/></svg>',
    shortcut: 'Ctrl+X',
    onClick: () => cutSelectedFiles()
  });

  items.push({
    label: t('fileExplorer.duplicate') || 'Duplicate',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm-1 4l6 6v10c0 1.1-.9 2-2 2H7.99C6.89 23 6 22.1 6 21l.01-14c0-1.1.89-2 1.99-2h7zm-1 7h5.5L14 6.5V12z"/></svg>',
    onClick: () => duplicateFile(filePath)
  });

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
    await fsp.writeFile(fullPath, '', 'utf-8');
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
    await fsp.mkdir(fullPath, { recursive: true });
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
      await fsp.rm(filePath, { recursive: true, force: true });
    } else {
      await fsp.unlink(filePath);
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
      const stat = await fsp.stat(filePath);
      if (stat.isDirectory()) {
        await fsp.rm(filePath, { recursive: true, force: true });
      } else {
        await fsp.unlink(filePath);
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

    // If destination already exists, ask user to confirm overwrite
    if (await fileExists(destPath)) {
      const overwrite = await showConfirm({
        title: t('fileExplorer.rename') || 'Move',
        message: (t('fileExplorer.renameOverwriteConfirm') || 'A file named "{name}" already exists. Overwrite?').replace('{name}', baseName),
        confirmLabel: t('fileExplorer.overwrite') || 'Overwrite',
        danger: true,
      });
      if (!overwrite) continue;
      // Remove existing target before move
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

// ========== DOTFILES TOGGLE ==========
function toggleDotfiles() {
  const { getSetting, settingsState, saveSettings } = require('../../state/settings.state');
  const current = getSetting('showDotfiles');
  settingsState.setProp('showDotfiles', !current);
  saveSettings();
  // Reload all expanded folders
  for (const [folderPath, entry] of expandedFolders) {
    if (entry.loaded) {
      entry.loaded = false;
      entry.loading = true;
      readDirectoryAsync(folderPath).then(children => {
        entry.children = children;
        entry.loaded = true;
        entry.loading = false;
        render();
      });
    }
  }
  render();
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

  // Double-click: open .md files in external editor
  treeEl.ondblclick = (e) => {
    const node = e.target.closest('.fe-node');
    if (!node) return;
    const nodePath = node.dataset.path;
    const isDir = node.dataset.isDir === 'true';
    if (isDir) return; // Dirs toggle on single click; ignore double-click

    const fileName = path.basename(nodePath);
    const dotIdx = fileName.lastIndexOf('.');
    const ext = dotIdx !== -1 ? fileName.substring(dotIdx + 1).toLowerCase() : '';
    if (ext === 'md') {
      e.preventDefault();
      e.stopPropagation();
      const { getSetting: getSettingLocal } = require('../../state/settings.state');
      api.dialog.openInEditor({ editor: getSettingLocal('editor') || 'code', path: nodePath });
    }
  };

  // Keyboard: F2 for rename, Delete key, Ctrl+X/Ctrl+V for cut/paste
  treeEl.onkeydown = async (e) => {
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
        let isDir = false;
        try {
          const stat = await fsp.stat(filePath);
          isDir = stat.isDirectory();
        } catch (e) { /* file may not exist */ }
        promptDelete(filePath, fileName, isDir);
      } else {
        promptDeleteMultiple();
      }
    }
    // Ctrl+C: copy selected files
    if (e.key === 'c' && (e.ctrlKey || e.metaKey) && selectedFiles.size > 0) {
      e.preventDefault();
      copySelectedFiles();
    }
    // Ctrl+X: cut selected files
    if (e.key === 'x' && (e.ctrlKey || e.metaKey) && selectedFiles.size > 0) {
      e.preventDefault();
      cutSelectedFiles();
    }
    // Ctrl+V: paste (cut takes priority over copy)
    if (e.key === 'v' && (e.ctrlKey || e.metaKey) && (cutPaths.length > 0 || copiedPaths.length > 0)) {
      e.preventDefault();
      let targetDir = rootPath;
      if (lastSelectedFile) {
        try {
          const stat = await fsp.stat(lastSelectedFile);
          if (stat.isDirectory()) {
            targetDir = lastSelectedFile;
          } else {
            targetDir = path.dirname(lastSelectedFile);
          }
        } catch (e) {
          targetDir = path.dirname(lastSelectedFile);
        }
      }
      if (cutPaths.length > 0) {
        pasteFiles(targetDir);
      } else {
        pasteCopiedFiles(targetDir);
      }
    }
  };

  // Drag & drop (event delegation) — attach only once to avoid listener accumulation
  if (!_dragListenersAttached) {
    _dragListenersAttached = true;

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
  }

  // Header buttons
  const btnCollapse = document.getElementById('btn-collapse-explorer');
  if (btnCollapse) {
    btnCollapse.onclick = () => {
      for (const p of expandedFolders.keys()) {
        api.explorer.unwatchDir(p);
      }
      expandedFolders.clear();
      selectedFiles.clear();
      lastSelectedFile = null;
      render();
    };
  }

  const btnRefresh = document.getElementById('btn-refresh-explorer');
  if (btnRefresh) {
    btnRefresh.onclick = () => {
      for (const p of expandedFolders.keys()) {
        api.explorer.unwatchDir(p);
      }
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
      const contentToggle = document.getElementById('fe-content-search-toggle');
      const isContentMode = contentToggle && contentToggle.classList.contains('active');

      if (isContentMode) {
        contentSearchQuery = searchInput.value;
        searchQuery = '';
        searchResults = [];
        if (searchClear) searchClear.style.display = contentSearchQuery ? 'flex' : 'none';
        performContentSearch();
      } else {
        searchQuery = searchInput.value;
        contentSearchQuery = '';
        contentSearchResults = [];
        if (searchClear) searchClear.style.display = searchQuery ? 'flex' : 'none';
        performSearch();
      }
    };

    searchInput.onkeydown = (e) => {
      if (e.key === 'Escape') {
        searchInput.value = '';
        searchQuery = '';
        searchResults = [];
        contentSearchQuery = '';
        contentSearchResults = [];
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
      contentSearchQuery = '';
      contentSearchResults = [];
      searchClear.style.display = 'none';
      render();
    };
  }

  // Content search toggle
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
        // Re-trigger search if there's a query
        if (input.value) {
          input.dispatchEvent(new Event('input'));
        }
      }
    };
  }

  // Sort dropdown
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
        icon: currentSortMode === m.key
          ? '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
          : '',
        onClick: () => setSortMode(m.key)
      }));
      showContextMenu({ x: e.clientX, y: e.clientY, items: menuItems });
    };
  }

  // Content match click handler (open file at line)
  const treeElForContent = document.getElementById('file-explorer-tree');
  if (treeElForContent) {
    treeElForContent.addEventListener('click', (e) => {
      const matchEl = e.target.closest('.fe-content-match');
      if (matchEl) {
        const matchPath = matchEl.dataset.path;
        if (matchPath) {
          openFile(matchPath);
        }
      }
    });
  }
}

function toggleFolder(folderPath) {
  const entry = expandedFolders.get(folderPath);
  if (entry && entry.loaded) {
    expandedFolders.delete(folderPath);
    api.explorer.unwatchDir(folderPath);
    render();
  } else if (!entry) {
    // Not loaded yet - start loading
    getOrLoadFolder(folderPath);
    api.explorer.watchDir(folderPath);
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

  // Restore saved width (migrate from localStorage if needed)
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
  toggleDotfiles,
  init,
  applyWatcherChanges,
  setSortMode,
  reloadIgnorePatterns: () => {
    // Reload all expanded folders when ignore patterns change
    for (const [folderPath, entry] of expandedFolders) {
      if (entry.loaded) {
        entry.loaded = false;
        entry.loading = true;
        readDirectoryAsync(folderPath).then(children => {
          entry.children = children;
          entry.loaded = true;
          entry.loading = false;
          render();
        });
      }
    }
    render();
  }
};
