/**
 * ProjectList Component
 * Renders the project tree with folders and projects
 */

// Use preload API instead of direct ipcRenderer
const api = window.electron_api;
const {
  projectsState,
  getFolder,
  getProject,
  getProjectIndex,
  getChildFolders,
  getProjectsInFolder,
  countProjectsRecursive,
  toggleFolderCollapse,
  moveItemToFolder,
  reorderItem,
  isDescendantOf,
  setSelectedProjectFilter,
  setOpenedProjectId,
  setFolderColor,
  setProjectColor,
  setProjectIcon,
  setFolderIcon,
  updateProject,
  getProjectTimes,
  getProjectEditor,
  setProjectEditor,
  getSetting,
  EDITOR_OPTIONS,
  getEditorCommand
} = require('../../state');
const { escapeHtml } = require('../../utils');
const { sanitizeColor } = require('../../utils/color');
const { formatDuration } = require('../../utils/format');
const { t } = require('../../i18n');
const CustomizePicker = require('./CustomizePicker');
const { createModal, showModal, closeModal } = require('./Modal');
const registry = require('../../../project-types/registry');
const menuIcons = require('../icons/menuIcons');

// Local state
let dragState = { dragging: null, dropTarget: null };
let callbacks = {
  onCreateTerminal: null,
  onCreateBasicTerminal: null,
  onStartFivem: null,
  onStopFivem: null,
  onOpenFivemConsole: null,
  onGitPull: null,
  onGitPush: null,
  onNewWorktree: null,
  onDeleteProject: null,
  onRenameProject: null,
  onRenderProjects: null,
  countTerminalsForProject: () => 0,
  getTerminalStatsForProject: () => ({ total: 0, working: 0 })
};

// External state references
let fivemServers = new Map();
let gitOperations = new Map();
let gitRepoStatus = new Map();
let cloudUploadStatus = new Map();
let cloudConnected = false;

/**
 * Set external state references
 */
function setExternalState(state) {
  if (state.fivemServers) fivemServers = state.fivemServers;
  if (state.gitOperations) gitOperations = state.gitOperations;
  if (state.gitRepoStatus) gitRepoStatus = state.gitRepoStatus;
  if (state.cloudUploadStatus) cloudUploadStatus = state.cloudUploadStatus;
  if (state.cloudConnected !== undefined) cloudConnected = state.cloudConnected;
}

/**
 * Set callbacks for project actions
 */
function setCallbacks(cbs) {
  Object.assign(callbacks, cbs);
}

/**
 * Close all more actions menus
 */
function closeAllMoreActionsMenus() {
  document.querySelectorAll('.more-actions-menu.active').forEach(menu => menu.classList.remove('active'));
}

/**
 * Render folder HTML
 */
function renderFolderHtml(folder, depth) {
  const projectCount = countProjectsRecursive(folder.id);
  const childFolders = getChildFolders(folder.id);
  const childProjects = getProjectsInFolder(folder.id);
  const hasChildren = childFolders.length > 0 || childProjects.length > 0;
  const folderColor = folder.color || null;

  let childrenHtml = '';
  if (!folder.collapsed) {
    const children = folder.children || [];
    const renderedIds = new Set();

    // Render items in children order (both folders and projects)
    children.forEach(childId => {
      const childFolder = getFolder(childId);
      if (childFolder) {
        childrenHtml += renderFolderHtml(childFolder, depth + 1);
        renderedIds.add(childId);
      } else {
        const childProject = getProject(childId);
        if (childProject && childProject.folderId === folder.id) {
          childrenHtml += renderProjectHtml(childProject, depth + 1);
          renderedIds.add(childId);
        }
      }
    });

    // Render any projects not in children array (legacy data)
    childProjects.forEach(project => {
      if (!renderedIds.has(project.id)) {
        childrenHtml += renderProjectHtml(project, depth + 1);
      }
    });
  }

  const safeFolderColor = sanitizeColor(folderColor);
  const colorStyle = safeFolderColor ? `style="color: ${safeFolderColor}"` : '';
  const colorIndicator = safeFolderColor ? `<span class="color-indicator" style="background: ${safeFolderColor}"></span>` : '';
  const folderIcon = folder.icon || null;

  // Build folder icon HTML - show custom emoji or default folder icon
  const folderIconHtml = folderIcon
    ? `<span class="folder-emoji-icon">${escapeHtml(folderIcon)}</span>`
    : `<svg class="folder-icon" viewBox="0 0 24 24" fill="currentColor" ${colorStyle}><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;

  return `
    <div class="folder-item" data-folder-id="${folder.id}" data-depth="${depth}" draggable="true">
      <div class="folder-header" style="padding-left: ${depth * 16 + 8}px;">
        <span class="folder-chevron ${folder.collapsed ? 'collapsed' : ''} ${!hasChildren ? 'hidden' : ''}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
        </span>
        ${colorIndicator}
        ${folderIconHtml}
        <span class="folder-name">${escapeHtml(folder.name)}</span>
        <span class="folder-count">${projectCount}</span>
        <button class="btn-folder-color" data-folder-id="${folder.id}" title="${t('projects.customize')}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>
        </button>
      </div>
      <div class="folder-children ${folder.collapsed ? 'collapsed' : ''}">${childrenHtml}</div>
    </div>`;
}

/**
 * Render cloud sync badge with status-aware tooltip.
 */
function _renderCloudBadge(projectId) {
  const st = cloudUploadStatus.get(projectId);
  if (!st) return '';

  if (st.uploading || st.autoSyncing) {
    return '<span class="project-cloud-badge uploading" title="Cloud upload...">&#8679;</span>';
  }
  if (st.lastError) {
    const ago = _formatTimeAgo(st.lastError.timestamp);
    const tip = `${t('cloud.syncErrorTooltip', { ago, error: st.lastError.message })}`;
    return `<span class="project-cloud-badge error" title="${escapeHtml(tip)}">&#9888;</span>`;
  }
  if (st.synced) {
    const tip = st.lastSync ? `${t('cloud.syncedTooltip')} \u2022 ${_formatTimeAgo(st.lastSync)}` : t('cloud.syncedTooltip');
    return `<span class="project-cloud-badge synced" title="${escapeHtml(tip)}">&#10003;</span>`;
  }
  return '';
}

function _formatTimeAgo(ts) {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return t('cloud.timeJustNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('cloud.timeMinAgo', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('cloud.timeHourAgo', { count: hr });
  const days = Math.floor(hr / 24);
  return t('cloud.timeDayAgo', { count: days });
}

/**
 * Render project HTML
 */
function renderProjectHtml(project, depth) {
  const projectIndex = getProjectIndex(project.id);
  const terminalStats = callbacks.getTerminalStatsForProject(projectIndex);
  const isSelected = projectsState.get().selectedProjectFilter === projectIndex;
  const typeHandler = registry.get(project.type);
  const fivemStatus = fivemServers.get(projectIndex)?.status || 'stopped';
  const gitOps = gitOperations.get(project.id) || { pulling: false, pushing: false };
  const isGitRepo = gitRepoStatus.get(project.id)?.isGitRepo || false;
  const isRunning = fivemStatus === 'running';
  const isStarting = fivemStatus === 'starting';
  const projectColor = project.color || null;

  const typeCtx = { project, projectIndex, fivemStatus, isRunning, isStarting, projectColor, escapeHtml, t };

  // Claude terminal button (always present)
  const claudeBtn = `
    <button class="btn-action-icon btn-claude" data-project-id="${project.id}" title="${t('projects.openClaude')}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
    </button>`;

  // Cloud sync button (pending, syncing, or error)
  const cloudStatus = cloudUploadStatus.get(project.id);
  let cloudSyncBtn = '';
  if (cloudStatus?.syncing) {
    cloudSyncBtn = `<button class="btn-action-icon btn-cloud-sync syncing" data-project-id="${project.id}" title="${t('cloud.syncApply')}..." disabled>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/><polyline points="21 3 21 9 15 9"/></svg>
      </button>`;
  } else if (cloudStatus?.pendingChanges) {
    cloudSyncBtn = `<button class="btn-action-icon btn-cloud-sync pending" data-project-id="${project.id}" title="${t('cloud.pendingBadge', { count: cloudStatus?.pendingCount || 0 })}">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>`;
  } else if (cloudStatus?.lastError) {
    const errAgo = _formatTimeAgo(cloudStatus.lastError.timestamp);
    cloudSyncBtn = `<button class="btn-action-icon btn-cloud-sync error" data-project-id="${project.id}" title="${escapeHtml(t('cloud.syncErrorTooltip', { ago: errAgo, error: cloudStatus.lastError.message }))}">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </button>`;
  } else if (cloudConnected && !cloudStatus?.synced) {
    // Direct upload button when project is not yet synced to cloud
    cloudSyncBtn = `<button class="btn-action-icon btn-cloud-upload-direct" data-project-id="${project.id}" title="${t('cloud.uploadTitle')}">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        </button>`;
  }

  // Get additional action buttons from type handler
  const typeSidebarButtons = typeHandler.getSidebarButtons(typeCtx) || '';
  const primaryActionsHtml = cloudSyncBtn + typeSidebarButtons + claudeBtn;

  // Customize button for menu (opens the CustomizePicker)
  const projectIcon = project.icon || null;
  const customizePreview = projectIcon || '📁';
  const safeProjectColor = sanitizeColor(projectColor);
  const customizeColorDot = safeProjectColor ? `<span class="customize-preview-dot" style="background: ${safeProjectColor}"></span>` : '';

  let menuItemsHtml = '';
  const typeMenuItems = typeHandler.getMenuItems ? typeHandler.getMenuItems(typeCtx) : '';
  if (typeMenuItems) {
    menuItemsHtml += typeMenuItems;
  }
  // Git operations section
  if (isGitRepo) {
    menuItemsHtml += `
      <button class="more-actions-item btn-git-pull ${gitOps.pulling ? 'loading' : ''}" data-project-id="${project.id}" ${gitOps.pulling ? 'disabled' : ''}>
        ${menuIcons.gitPull}
        ${t('projects.gitPull')}
      </button>
      <button class="more-actions-item btn-git-push ${gitOps.pushing ? 'loading' : ''}" data-project-id="${project.id}" ${gitOps.pushing ? 'disabled' : ''}>
        ${menuIcons.gitPush}
        ${t('projects.gitPush')}
      </button>
      <button class="more-actions-item btn-new-worktree" data-project-id="${project.id}">
        ${menuIcons.gitBranch}
        ${t('projects.newWorktree')}
      </button>
      <div class="more-actions-divider"></div>`;
  }

  // Main actions section
  menuItemsHtml += `
    <button class="more-actions-item btn-basic-terminal" data-project-id="${project.id}">
      ${menuIcons.terminal}
      ${t('projects.basicTerminal')}
    </button>
    <button class="more-actions-item btn-open-folder" data-project-id="${project.id}">
      ${menuIcons.folderOpen}
      ${t('projects.openFolder')}
    </button>
    <button class="more-actions-item btn-open-editor" data-project-id="${project.id}">
      ${menuIcons.code}
      ${t('projects.openInEditor', { editor: (EDITOR_OPTIONS.find(e => e.value === (getProjectEditor(project.id) || getSetting('editor'))) || EDITOR_OPTIONS[0]).label })}
    </button>
    ${cloudConnected ? (cloudUploadStatus.get(project.id)?.synced
      ? `<button class="more-actions-item btn-cloud-upload" data-project-id="${project.id}">
      ${menuIcons.cloudUpload}
      ${t('cloud.resyncBtn')}
    </button>
    <button class="more-actions-item danger btn-cloud-delete" data-project-id="${project.id}">
      ${menuIcons.trash}
      ${t('cloud.deleteTitle')}
    </button>`
      : `<button class="more-actions-item btn-cloud-upload" data-project-id="${project.id}">
      ${menuIcons.cloudUpload}
      ${t('cloud.uploadTitle')}
    </button>`) : ''}
    <div class="more-actions-divider"></div>
    ${(() => {
      const typeSettings = typeHandler.getProjectSettings(project);
      return typeSettings && typeSettings.length > 0 ? `
    <button class="more-actions-item btn-project-settings" data-project-id="${project.id}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>
      ${t('projects.settings')}
    </button>` : '';
    })()}
    <button class="more-actions-item btn-customize-project" data-project-id="${project.id}">
      ${menuIcons.palette}
      ${t('projects.customize')}
    </button>
    <button class="more-actions-item btn-rename-project" data-project-id="${project.id}">
      ${menuIcons.rename}
      ${t('common.rename')}
    </button>
    <div class="more-actions-divider"></div>
    <button class="more-actions-item danger btn-delete-project" data-project-id="${project.id}">
      ${menuIcons.trash}
      ${t('common.delete')}
    </button>`;

  const statusIndicator = typeHandler.getStatusIndicator(typeCtx);
  const colorIndicator = projectColor ? `<span class="color-indicator" style="background: ${projectColor}"></span>` : '';

  // Get time tracking data
  const times = getProjectTimes(project.id);
  const hasTime = times.total > 0 || times.today > 0;
  const iconColorStyle = safeProjectColor ? `style="color: ${safeProjectColor}"` : '';
  const gitBranch = gitRepoStatus.get(project.id)?.branch || null;

  // Build project icon HTML
  let projectIconHtml;
  const typeIcon = typeHandler.getProjectIcon(typeCtx);
  if (typeIcon) {
    projectIconHtml = `${statusIndicator}${typeIcon}`;
  } else if (projectIcon) {
    projectIconHtml = `<span class="project-emoji-icon">${escapeHtml(projectIcon)}</span>`;
  } else {
    projectIconHtml = `<svg viewBox="0 0 24 24" fill="currentColor" ${iconColorStyle}><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>`;
  }

  // Build tooltip lines for compact hover
  let tooltipLines = [];
  tooltipLines.push(`<div class="project-tooltip-path">${escapeHtml(project.path)}</div>`);
  if (gitBranch) {
    tooltipLines.push(`<div class="project-tooltip-branch"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M6 2a4 4 0 0 0-1 7.874V14a1 1 0 0 0 1 1h3a2 2 0 0 1 2 2v.126A4.002 4.002 0 0 0 10 24a4 4 0 0 0 1-7.874V17a4 4 0 0 0-4-4H6V9.874A4.002 4.002 0 0 0 6 2zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm5 16a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg> ${escapeHtml(gitBranch)}</div>`);
  }
  if (hasTime) {
    tooltipLines.push(`<div class="project-tooltip-time">${formatDuration(times.today)} ${t('common.today')} \u2022 ${formatDuration(times.total)} ${t('common.total')}</div>`);
  }
  if (terminalStats.total > 0) {
    tooltipLines.push(`<div class="project-tooltip-terminals">${terminalStats.working}/${terminalStats.total} terminaux</div>`);
  }
  const tooltipHtml = `<div class="project-tooltip">${tooltipLines.join('')}</div>`;

  return `
    <div class="project-item ${isSelected ? 'active' : ''} ${typeHandler.getProjectItemClass(typeCtx)}"
         data-project-id="${project.id}" data-depth="${depth}" draggable="true" tabindex="0"
         style="margin-left: ${depth * 16}px;">
      ${tooltipHtml}
      <div class="project-info">
        <div class="project-name">
          ${colorIndicator}
          ${projectIconHtml}
          <span>${escapeHtml(project.name)}</span>
          ${terminalStats.total > 0 ? `<span class="terminal-count"><span class="working-count">${terminalStats.working}</span><span class="count-separator">/</span><span class="total-count">${terminalStats.total}</span></span>` : ''}
          ${project.isWorktree && project.worktreeBranch ? `<span class="project-worktree-badge" title="Worktree: ${escapeHtml(project.worktreeBranch)}">${escapeHtml(project.worktreeBranch)}</span>` : project.isWorktree ? '<span class="project-worktree-badge" title="Worktree">WT</span>' : ''}
          ${_renderCloudBadge(project.id)}
        </div>
        <div class="project-path">${escapeHtml(project.path)}</div>
        ${hasTime ? `<div class="project-time">
          <span class="time-today" title="${t('common.today')}">${formatDuration(times.today)}</span>
          <span class="time-separator">\u2022</span>
          <span class="time-total" title="${t('common.total')}">${formatDuration(times.total)}</span>
        </div>` : ''}
      </div>
      <div class="project-actions">
        ${primaryActionsHtml}
        <div class="more-actions">
          <button class="btn-more-actions" title="${t('projects.moreActions')}">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>
          </button>
          <div class="more-actions-menu">${menuItemsHtml}</div>
        </div>
      </div>
    </div>`;
}

/**
 * Get drop position based on mouse Y relative to element
 * @param {DragEvent} e
 * @param {HTMLElement} el
 * @param {boolean} isFolder - Folders have a "middle" zone for dropping into
 * @returns {'before'|'after'|'into'}
 */
function getDropPosition(e, el, isFolder) {
  const rect = el.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const height = rect.height;

  if (isFolder) {
    // For folders: top 25% = before, middle 50% = into, bottom 25% = after
    if (y < height * 0.25) return 'before';
    if (y > height * 0.75) return 'after';
    return 'into';
  } else {
    // For projects: top 50% = before, bottom 50% = after
    return y < height * 0.5 ? 'before' : 'after';
  }
}

/**
 * Clear all drop indicators
 */
function clearDropIndicators(list) {
  list.querySelectorAll('.drag-over, .drop-before, .drop-after, .drop-into').forEach(el => {
    el.classList.remove('drag-over', 'drop-before', 'drop-after', 'drop-into');
  });
}

/**
 * Setup drag and drop for project list using event delegation.
 * Attaches a single set of listeners on the list container instead of per-element.
 * Safe to call on every render — old listeners are removed first.
 */
let _dndCleanup = null;

function setupDragAndDrop(list) {
  // Remove previous delegated listeners (prevents stacking on re-render)
  if (_dndCleanup) {
    _dndCleanup();
    _dndCleanup = null;
  }

  function onDragStart(e) {
    const el = e.target.closest('[draggable="true"]');
    if (!el) return;
    e.stopPropagation();
    const projectId = el.dataset.projectId;
    const folderId = el.dataset.folderId;
    if (projectId) dragState.dragging = { type: 'project', id: projectId };
    else if (folderId) dragState.dragging = { type: 'folder', id: folderId };
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
  }

  function onDragEnd(e) {
    const el = e.target.closest('[draggable="true"]');
    if (el) el.classList.remove('dragging');
    dragState.dragging = null;
    dragState.dropTarget = null;
    clearDropIndicators(list);
  }

  function onDragOver(e) {
    if (!dragState.dragging) return;

    // Folder header
    const folderHeader = e.target.closest('.folder-header');
    if (folderHeader) {
      e.preventDefault();
      e.stopPropagation();
      const folder = folderHeader.closest('.folder-item');
      const folderId = folder?.dataset.folderId;
      if (dragState.dragging.type === 'folder' && folderId) {
        if (dragState.dragging.id === folderId || isDescendantOf(folderId, dragState.dragging.id)) {
          e.dataTransfer.dropEffect = 'none';
          return;
        }
      }
      e.dataTransfer.dropEffect = 'move';
      clearDropIndicators(list);
      const position = getDropPosition(e, folderHeader, true);
      folderHeader.classList.add(`drop-${position}`);
      dragState.dropTarget = { type: 'folder', id: folderId, position };
      return;
    }

    // Project item
    const project = e.target.closest('.project-item');
    if (project) {
      e.preventDefault();
      e.stopPropagation();
      const projectId = project.dataset.projectId;
      if (dragState.dragging.id === projectId) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }
      e.dataTransfer.dropEffect = 'move';
      clearDropIndicators(list);
      const position = getDropPosition(e, project, false);
      project.classList.add(`drop-${position}`);
      dragState.dropTarget = { type: 'project', id: projectId, position };
      return;
    }

    // Root drop zone
    const rootZone = e.target.closest('.drop-zone-root');
    if (rootZone) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDropIndicators(list);
      rootZone.classList.add('drag-over');
      dragState.dropTarget = { type: 'root', id: null };
    }
  }

  function onDragLeave(e) {
    const folderHeader = e.target.closest('.folder-header');
    if (folderHeader && !folderHeader.contains(e.relatedTarget)) {
      folderHeader.classList.remove('drop-before', 'drop-after', 'drop-into');
      return;
    }
    const project = e.target.closest('.project-item');
    if (project && !project.contains(e.relatedTarget)) {
      project.classList.remove('drop-before', 'drop-after');
      return;
    }
    const rootZone = e.target.closest('.drop-zone-root');
    if (rootZone) {
      rootZone.classList.remove('drag-over');
    }
  }

  function onDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    clearDropIndicators(list);
    if (!dragState.dragging || !dragState.dropTarget) {
      // Root drop zone (no dropTarget set yet for simple drops)
      if (e.target.closest('.drop-zone-root') && dragState.dragging) {
        moveItemToFolder(dragState.dragging.type, dragState.dragging.id, null);
        dragState.dragging = null;
        dragState.dropTarget = null;
        if (callbacks.onRenderProjects) callbacks.onRenderProjects();
      }
      return;
    }

    const { position } = dragState.dropTarget;
    if (dragState.dropTarget.type === 'folder') {
      if (position === 'into') {
        moveItemToFolder(dragState.dragging.type, dragState.dragging.id, dragState.dropTarget.id);
      } else {
        reorderItem(dragState.dragging.type, dragState.dragging.id, dragState.dropTarget.id, position);
      }
    } else if (dragState.dropTarget.type === 'project') {
      reorderItem(dragState.dragging.type, dragState.dragging.id, dragState.dropTarget.id, position);
    } else if (dragState.dropTarget.type === 'root') {
      moveItemToFolder(dragState.dragging.type, dragState.dragging.id, null);
    }

    dragState.dragging = null;
    dragState.dropTarget = null;
    if (callbacks.onRenderProjects) callbacks.onRenderProjects();
  }

  list.addEventListener('dragstart', onDragStart);
  list.addEventListener('dragend', onDragEnd);
  list.addEventListener('dragover', onDragOver);
  list.addEventListener('dragleave', onDragLeave);
  list.addEventListener('drop', onDrop);

  _dndCleanup = () => {
    list.removeEventListener('dragstart', onDragStart);
    list.removeEventListener('dragend', onDragEnd);
    list.removeEventListener('dragover', onDragOver);
    list.removeEventListener('dragleave', onDragLeave);
    list.removeEventListener('drop', onDrop);
  };
}

/**
 * Setup compact mode tooltips (floating, position: fixed)
 * Uses delegated mouseover/mouseout on the list container (set up once)
 */
let _activeTooltip = null;
let _tooltipTimeout = null;
let _tooltipDelegationSetup = false;

function removeActiveTooltip() {
  if (_activeTooltip) {
    _activeTooltip.remove();
    _activeTooltip = null;
  }
  clearTimeout(_tooltipTimeout);
}

function setupCompactTooltips(list) {
  if (_tooltipDelegationSetup) return;
  _tooltipDelegationSetup = true;

  list.addEventListener('mouseover', (e) => {
    const item = e.target.closest('.project-item');
    if (!item || item.classList.contains('active')) return;
    if (!document.body.classList.contains('compact-projects')) return;
    if (_activeTooltip && _activeTooltip._forProjectId === item.dataset.projectId) return;

    const tooltipSource = item.querySelector('.project-tooltip');
    if (!tooltipSource || !tooltipSource.innerHTML.trim()) return;

    clearTimeout(_tooltipTimeout);
    _tooltipTimeout = setTimeout(() => {
      removeActiveTooltip();

      const rect = item.getBoundingClientRect();
      const tooltip = document.createElement('div');
      tooltip.className = 'project-tooltip-floating';
      tooltip.innerHTML = tooltipSource.innerHTML;
      tooltip._forProjectId = item.dataset.projectId;
      document.body.appendChild(tooltip);

      const tooltipRect = tooltip.getBoundingClientRect();
      let left = rect.right + 8;
      let top = rect.top + (rect.height / 2) - (tooltipRect.height / 2);

      if (left + tooltipRect.width > window.innerWidth) {
        left = rect.left - tooltipRect.width - 8;
        tooltip.classList.add('tooltip-left');
      }
      if (top < 4) top = 4;
      if (top + tooltipRect.height > window.innerHeight - 4) {
        top = window.innerHeight - tooltipRect.height - 4;
      }

      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
      _activeTooltip = tooltip;
    }, 300);
  });

  list.addEventListener('mouseout', (e) => {
    const item = e.target.closest('.project-item');
    if (item && !item.contains(e.relatedTarget)) {
      removeActiveTooltip();
    }
  });
}

/**
 * Show project settings modal
 */
function showProjectSettings(project) {
  const typeHandler = registry.get(project.type);
  const fields = typeHandler.getProjectSettings(project);
  if (!fields || fields.length === 0) return;

  const fieldsHtml = fields.map(field => {
    const value = project[field.key] || '';
    return `
      <div class="project-settings-field">
        <label class="project-settings-label">${t(field.labelKey) || field.key}</label>
        <input type="text"
               data-settings-key="${field.key}"
               value="${escapeHtml(String(value))}"
               placeholder="${escapeHtml(field.placeholder || '')}"
               class="project-settings-input" />
        ${field.hintKey ? `<small class="project-settings-hint">${t(field.hintKey)}</small>` : ''}
      </div>
    `;
  }).join('');

  const modal = createModal({
    id: 'project-settings-modal',
    title: `${t('projects.settings')} — ${escapeHtml(project.name)}`,
    content: `<div class="project-settings-form">${fieldsHtml}</div>`,
    buttons: [
      {
        label: t('common.cancel'),
        action: 'cancel',
        onClick: (m) => closeModal(m)
      },
      {
        label: t('common.save'),
        action: 'save',
        primary: true,
        onClick: (m) => {
          const updates = {};
          fields.forEach(field => {
            const input = m.querySelector(`[data-settings-key="${field.key}"]`);
            if (input) {
              const val = input.value.trim();
              updates[field.key] = val || undefined;
            }
          });
          updateProject(project.id, updates);
          closeModal(m);
          if (callbacks.onRenderProjects) callbacks.onRenderProjects();
        }
      }
    ],
    size: 'small'
  });

  // Enter key to save
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      modal.querySelector('[data-action="save"]').click();
    }
  });

  showModal(modal);
}

/**
 * Attach all event listeners to project list
 * Uses event delegation: 2 handlers on the container instead of N*15 per-element listeners
 */
function attachListeners(list) {
  // === SINGLE DELEGATED CLICK HANDLER ===
  list.onclick = (e) => {
    const target = e.target;

    // Folder chevron
    const chevron = target.closest('.folder-chevron');
    if (chevron) {
      e.stopPropagation();
      toggleFolderCollapse(chevron.closest('.folder-item').dataset.folderId);
      if (callbacks.onRenderProjects) callbacks.onRenderProjects();
      return;
    }

    // Folder header (not chevron, not button)
    const folderHeader = target.closest('.folder-header');
    if (folderHeader && !target.closest('button')) {
      toggleFolderCollapse(folderHeader.closest('.folder-item').dataset.folderId);
      if (callbacks.onRenderProjects) callbacks.onRenderProjects();
      return;
    }

    // Any button click
    const btn = target.closest('button');
    if (btn) {
      e.stopPropagation();
      const projectId = btn.dataset.projectId;

      // Close more-actions menu for any menu item click
      if (btn.classList.contains('more-actions-item')) {
        closeAllMoreActionsMenus();
      }

      if (btn.classList.contains('btn-claude')) {
        const project = getProject(projectId);
        const projectIndex = getProjectIndex(projectId);
        setSelectedProjectFilter(projectIndex);
        if (callbacks.onRenderProjects) callbacks.onRenderProjects();
        if (callbacks.onCreateTerminal) callbacks.onCreateTerminal(project);
      } else if (btn.classList.contains('btn-git-pull')) {
        if (callbacks.onGitPull) callbacks.onGitPull(projectId);
      } else if (btn.classList.contains('btn-git-push')) {
        if (callbacks.onGitPush) callbacks.onGitPush(projectId);
      } else if (btn.classList.contains('btn-new-worktree')) {
        const project = getProject(projectId);
        closeAllMoreActionsMenus();
        if (callbacks.onNewWorktree) callbacks.onNewWorktree(project);
      } else if (btn.classList.contains('btn-basic-terminal')) {
        const project = getProject(projectId);
        const projectIndex = getProjectIndex(projectId);
        setSelectedProjectFilter(projectIndex);
        closeAllMoreActionsMenus();
        if (callbacks.onRenderProjects) callbacks.onRenderProjects();
        if (callbacks.onCreateBasicTerminal) callbacks.onCreateBasicTerminal(project);
      } else if (btn.classList.contains('btn-open-folder')) {
        const project = getProject(projectId);
        if (project) api.dialog.openInExplorer(project.path);
      } else if (btn.classList.contains('btn-open-editor')) {
        const project = getProject(projectId);
        if (!project) return;
        const editor = getProjectEditor(projectId) || getSetting('editor') || 'code';
        closeAllMoreActionsMenus();
        api.dialog.openInEditor({ editor: getEditorCommand(editor), path: project.path });
      } else if (btn.classList.contains('btn-delete-project')) {
        closeAllMoreActionsMenus();
        if (callbacks.onDeleteProject) callbacks.onDeleteProject(projectId);
      } else if (btn.classList.contains('btn-rename-project')) {
        closeAllMoreActionsMenus();
        if (callbacks.onRenameProject) callbacks.onRenameProject(projectId);
      } else if (btn.classList.contains('btn-more-actions')) {
        const menu = btn.nextElementSibling;
        const isActive = menu.classList.contains('active');
        closeAllMoreActionsMenus();
        if (!isActive) {
          const btnRect = btn.getBoundingClientRect();
          menu.style.visibility = 'hidden';
          menu.classList.add('active');
          const menuWidth = menu.offsetWidth;
          const menuHeight = menu.offsetHeight;
          menu.classList.remove('active');
          menu.style.visibility = '';
          let left = btnRect.right - menuWidth;
          if (left < 0) left = btnRect.left;
          const viewportHeight = window.innerHeight;
          let top;
          if (btnRect.bottom + menuHeight + 4 > viewportHeight) {
            top = btnRect.top - menuHeight - 4;
            if (top < 0) top = 4;
          } else {
            top = btnRect.bottom + 4;
          }
          menu.style.top = `${top}px`;
          menu.style.left = `${left}px`;
          menu.classList.add('active');
        }
      } else if (btn.classList.contains('btn-folder-color')) {
        const folderId = btn.dataset.folderId;
        const folder = getFolder(folderId);
        if (folder) {
          CustomizePicker.show(btn, 'folder', folderId, folder, {
            onColorChange: (id, color) => { setFolderColor(id, color); if (callbacks.onRenderProjects) callbacks.onRenderProjects(); },
            onIconChange: (id, icon) => { setFolderIcon(id, icon); if (callbacks.onRenderProjects) callbacks.onRenderProjects(); },
            onClose: () => {}
          });
        }
      } else if (btn.classList.contains('btn-project-settings')) {
        const project = getProject(projectId);
        closeAllMoreActionsMenus();
        if (project) showProjectSettings(project);
      } else if (btn.classList.contains('btn-cloud-upload') || btn.classList.contains('btn-cloud-upload-direct')) {
        closeAllMoreActionsMenus();
        if (callbacks.onCloudUpload) callbacks.onCloudUpload(projectId);
      } else if (btn.classList.contains('btn-cloud-delete')) {
        closeAllMoreActionsMenus();
        if (callbacks.onCloudDelete) callbacks.onCloudDelete(projectId);
      } else if (btn.classList.contains('btn-cloud-sync')) {
        if (callbacks.onCloudSync) callbacks.onCloudSync(projectId);
      } else if (btn.classList.contains('btn-customize-project')) {
        const project = getProject(projectId);
        closeAllMoreActionsMenus();
        if (project) {
          CustomizePicker.show(btn, 'project', projectId, project, {
            onColorChange: (id, color) => { setProjectColor(id, color); if (callbacks.onRenderProjects) callbacks.onRenderProjects(); },
            onIconChange: (id, icon) => { setProjectIcon(id, icon); if (callbacks.onRenderProjects) callbacks.onRenderProjects(); },
            onClose: () => {}
          });
        }
      }
      return;
    }

    // Project item click (when no button was clicked)
    const projectItem = target.closest('.project-item');
    if (projectItem) {
      const projectId = projectItem.dataset.projectId;
      const projectIndex = getProjectIndex(projectId);
      setSelectedProjectFilter(projectIndex);
      setOpenedProjectId(null);
      document.getElementById('project-detail-view').style.display = 'none';
      document.getElementById('split-pane-area').style.display = '';
      if (callbacks.onFilterTerminals) callbacks.onFilterTerminals(projectIndex);
      if (callbacks.onRenderProjects) callbacks.onRenderProjects();
    }
  };

  // === SINGLE DELEGATED CONTEXTMENU HANDLER ===
  list.oncontextmenu = (e) => {
    // Editor button right-click → editor picker
    const editorBtn = e.target.closest('.btn-open-editor');
    if (editorBtn) {
      e.preventDefault();
      e.stopPropagation();
      const projectId = editorBtn.dataset.projectId;
      const currentEditor = getProjectEditor(projectId);
      closeAllMoreActionsMenus();

      document.querySelectorAll('.editor-context-menu').forEach(m => m.remove());

      const menu = document.createElement('div');
      menu.className = 'editor-context-menu';
      menu.style.cssText = `position:fixed;top:${e.clientY}px;left:${e.clientX}px;z-index:10000;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;padding:4px 0;min-width:180px;box-shadow:0 8px 24px rgba(0,0,0,0.4);`;

      const globalEditor = getSetting('editor') || 'code';
      const globalLabel = (EDITOR_OPTIONS.find(e => e.value === globalEditor) || EDITOR_OPTIONS[0]).label;
      let itemsHtml = `<button class="editor-ctx-item" data-editor="" style="display:flex;align-items:center;gap:8px;width:100%;padding:6px 12px;background:none;border:none;color:var(--text-primary);cursor:pointer;font-size:13px;text-align:left;">
        <span style="width:16px;text-align:center;">${!currentEditor ? '✓' : ''}</span>
        ${t('projects.globalDefault')} (${globalLabel})
      </button>`;
      itemsHtml += '<div style="height:1px;background:var(--border-color);margin:4px 0;"></div>';

      EDITOR_OPTIONS.forEach(opt => {
        const isSelected = currentEditor === opt.value;
        itemsHtml += `<button class="editor-ctx-item" data-editor="${opt.value}" style="display:flex;align-items:center;gap:8px;width:100%;padding:6px 12px;background:none;border:none;color:var(--text-primary);cursor:pointer;font-size:13px;text-align:left;">
          <span style="width:16px;text-align:center;">${isSelected ? '✓' : ''}</span>
          ${opt.label}
        </button>`;
      });

      menu.innerHTML = itemsHtml;
      document.body.appendChild(menu);

      const menuRect = menu.getBoundingClientRect();
      if (menuRect.right > window.innerWidth) menu.style.left = `${window.innerWidth - menuRect.width - 8}px`;
      if (menuRect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - menuRect.height - 8}px`;

      // Delegated handler for editor context menu items
      menu.onclick = (ev) => {
        const item = ev.target.closest('.editor-ctx-item');
        if (item) {
          setProjectEditor(projectId, item.dataset.editor || null);
          menu.remove();
          if (callbacks.onRenderProjects) callbacks.onRenderProjects();
        }
      };
      menu.onmouseover = (ev) => {
        const item = ev.target.closest('.editor-ctx-item');
        if (item) item.style.background = 'var(--bg-hover)';
      };
      menu.onmouseout = (ev) => {
        const item = ev.target.closest('.editor-ctx-item');
        if (item) item.style.background = 'none';
      };

      const closeMenu = (ev) => {
        if (!menu.contains(ev.target)) {
          menu.remove();
          document.removeEventListener('click', closeMenu, true);
        }
      };
      setTimeout(() => document.addEventListener('click', closeMenu, true), 0);
      return;
    }

    // Project item right-click → more-actions menu at cursor
    const projectItem = e.target.closest('.project-item');
    if (projectItem) {
      e.preventDefault();
      e.stopPropagation();
      const moreBtn = projectItem.querySelector('.btn-more-actions');
      if (!moreBtn) return;
      const menu = moreBtn.nextElementSibling;
      if (!menu) return;

      closeAllMoreActionsMenus();

      menu.style.visibility = 'hidden';
      menu.classList.add('active');
      const menuWidth = menu.offsetWidth;
      const menuHeight = menu.offsetHeight;
      menu.classList.remove('active');
      menu.style.visibility = '';

      let left = e.clientX;
      let top = e.clientY;
      if (left + menuWidth > window.innerWidth) left = window.innerWidth - menuWidth - 4;
      if (left < 0) left = 4;
      if (top + menuHeight > window.innerHeight) top = window.innerHeight - menuHeight - 4;
      if (top < 0) top = 4;

      menu.style.top = `${top}px`;
      menu.style.left = `${left}px`;
      menu.classList.add('active');
    }
  };

  // Type-specific sidebar events (plugin system - keep per-render)
  const typeCallbacks = {
    ...callbacks,
    onStartFivem: (projectId) => { if (callbacks.onStartFivem) callbacks.onStartFivem(getProjectIndex(projectId)); },
    onStopFivem: (projectId) => { if (callbacks.onStopFivem) callbacks.onStopFivem(getProjectIndex(projectId)); },
    onOpenFivemConsole: (projectId) => { if (callbacks.onOpenFivemConsole) callbacks.onOpenFivemConsole(getProjectIndex(projectId)); }
  };
  registry.getAll().forEach(typeHandler => {
    typeHandler.bindSidebarEvents(list, typeCallbacks);
  });

  // Compact tooltip (hover on non-active projects)
  setupCompactTooltips(list);

  // Drag & Drop
  setupDragAndDrop(list);
}

/**
 * Render the project list (debounced via rAF to avoid redundant renders)
 */
let _renderScheduled = false;

function render() {
  if (_renderScheduled) return;
  _renderScheduled = true;
  requestAnimationFrame(_renderNow);
}

function _renderNow() {
  _renderScheduled = false;
  removeActiveTooltip();
  const list = document.getElementById('projects-list');
  if (!list) return;
  const state = projectsState.get();

  if (state.projects.length === 0 && state.folders.length === 0) {
    list.innerHTML = `
      <div class="empty-state small">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>
        <p>${t('projects.noProjects')}</p>
        <p class="hint">${t('projects.addHint')}</p>
      </div>`;
    return;
  }

  let html = '';
  state.rootOrder.forEach(itemId => {
    const folder = getFolder(itemId);
    if (folder) {
      html += renderFolderHtml(folder, 0);
    } else {
      const project = getProject(itemId);
      if (project) html += renderProjectHtml(project, 0);
    }
  });
  html += `<div class="drop-zone-root" data-target="root"></div>`;
  list.innerHTML = html;
  attachListeners(list);
}

// Close menus on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.more-actions')) closeAllMoreActionsMenus();
});

module.exports = {
  render,
  setCallbacks,
  setExternalState,
  closeAllMoreActionsMenus
};
