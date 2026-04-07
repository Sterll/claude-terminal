/**
 * ProjectList Component
 * Renders the project tree with folders and projects
 */

const { BaseComponent } = require('../../core/BaseComponent');
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
  getEditorCommand,
  // Archive
  archiveProject,
  unarchiveProject,
  getArchivedCount,
  // Tags
  getProjectTags,
  setProjectTags,
  getAllTags,
  // Project settings
  getProjectSettings,
  setProjectSettings,
} = require('../../state');
const { escapeHtml } = require('../../utils');
const { sanitizeColor } = require('../../utils/color');
const { formatDuration } = require('../../utils/format');
const { t } = require('../../i18n');
const CustomizePicker = require('./CustomizePicker');
const { createModal, showModal, closeModal } = require('./Modal');
const Toast = require('./Toast');
const registry = require('../../../project-types/registry');
const menuIcons = require('../icons/menuIcons');
const { getWorkspacesForProject } = require('../../state/workspace.state');

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
  list.querySelectorAll('.drag-over, .drop-before, .drop-after, .drop-into, .drop-invalid-hover').forEach(el => {
    el.classList.remove('drag-over', 'drop-before', 'drop-after', 'drop-into', 'drop-invalid-hover');
  });
}

class ProjectList extends BaseComponent {
  constructor() {
    super(null);

    this._api = window.electron_api;

    // Local state
    this._dragState = { dragging: null, dropTarget: null };
    this._showArchived = false;
    this._selectedTagFilter = null;
    this._callbacks = {
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
    this._fivemServers = new Map();
    this._gitOperations = new Map();
    this._gitRepoStatus = new Map();
    // More-actions menu handlers
    this._moreActionsCloseHandler = null;
    this._moreActionsEscapeHandler = null;

    // Drag and drop cleanup
    this._dndCleanup = null;

    // Tooltip state
    this._activeTooltip = null;
    this._tooltipTimeout = null;
    this._tooltipDelegationSetup = false;

    // Render scheduling
    this._renderScheduled = false;

    // Search debounce
    this._searchDebounce = null;

    // Close menus on outside click
    const self = this;
    this._outsideClickHandler = (e) => {
      if (!e.target.closest('.more-actions')) self.closeAllMoreActionsMenus();
    };
    document.addEventListener('click', this._outsideClickHandler);

    // Search filter
    this._searchInput = document.getElementById('projects-search-input');
    this._searchClear = document.getElementById('projects-search-clear');

    if (this._searchInput) {
      this.on(this._searchInput, 'input', () => {
        clearTimeout(self._searchDebounce);
        self._searchDebounce = setTimeout(() => {
          self.render();
          if (self._searchClear) self._searchClear.style.display = self._searchInput.value ? '' : 'none';
        }, 150);
      });
    }

    if (this._searchClear) {
      this.on(this._searchClear, 'click', () => {
        if (self._searchInput) {
          self._searchInput.value = '';
          self._searchClear.style.display = 'none';
          self.render();
        }
      });
    }
  }

  setExternalState(state) {
    if (state.fivemServers) this._fivemServers = state.fivemServers;
    if (state.gitOperations) this._gitOperations = state.gitOperations;
    if (state.gitRepoStatus) this._gitRepoStatus = state.gitRepoStatus;
  }

  setCallbacks(cbs) {
    Object.assign(this._callbacks, cbs);
  }

  closeAllMoreActionsMenus() {
    document.querySelectorAll('.more-actions-menu.active').forEach(menu => menu.classList.remove('active'));
    if (this._moreActionsCloseHandler) {
      document.removeEventListener('click', this._moreActionsCloseHandler, true);
      this._moreActionsCloseHandler = null;
    }
    if (this._moreActionsEscapeHandler) {
      document.removeEventListener('keydown', this._moreActionsEscapeHandler);
      this._moreActionsEscapeHandler = null;
    }
  }

  _setupMoreActionsCloseListeners(menuEl, triggerBtn) {
    const self = this;
    // Remove any existing handlers first
    if (this._moreActionsCloseHandler) {
      document.removeEventListener('click', this._moreActionsCloseHandler, true);
    }
    if (this._moreActionsEscapeHandler) {
      document.removeEventListener('keydown', this._moreActionsEscapeHandler);
    }

    this._moreActionsCloseHandler = (e) => {
      if (!menuEl.contains(e.target) && !triggerBtn.contains(e.target)) {
        self.closeAllMoreActionsMenus();
      }
    };
    this._moreActionsEscapeHandler = (e) => {
      if (e.key === 'Escape') {
        self.closeAllMoreActionsMenus();
      }
    };

    // Delay attaching so the opening click doesn't immediately close
    setTimeout(() => {
      document.addEventListener('click', self._moreActionsCloseHandler, true);
      document.addEventListener('keydown', self._moreActionsEscapeHandler);
    }, 100);
  }

  _renderFolderHtml(folder, depth, searchQuery = '') {
    const projectCount = countProjectsRecursive(folder.id);
    const childFolders = getChildFolders(folder.id);
    const childProjects = getProjectsInFolder(folder.id);
    const hasChildren = childFolders.length > 0 || childProjects.length > 0;
    const folderColor = folder.color || null;

    let childrenHtml = '';
    // When searching, always expand folders to show matching children
    const isExpanded = searchQuery ? true : !folder.collapsed;
    if (isExpanded) {
      const children = folder.children || [];
      const renderedIds = new Set();

      // Render items in children order (both folders and projects)
      children.forEach(childId => {
        const childFolder = getFolder(childId);
        if (childFolder) {
          const subHtml = this._renderFolderHtml(childFolder, depth + 1, searchQuery);
          if (subHtml) {
            childrenHtml += subHtml;
            renderedIds.add(childId);
          }
        } else {
          const childProject = getProject(childId);
          if (childProject && childProject.folderId === folder.id) {
            if (!this._showArchived && childProject.archived) { renderedIds.add(childId); }
            else if (this._selectedTagFilter && !(childProject.tags || []).includes(this._selectedTagFilter)) { renderedIds.add(childId); }
            else if (searchQuery && !childProject.name.toLowerCase().includes(searchQuery) && !childProject.path.toLowerCase().includes(searchQuery)) { renderedIds.add(childId); }
            else { childrenHtml += this._renderProjectHtml(childProject, depth + 1); renderedIds.add(childId); }
          }
        }
      });

      // Render any projects not in children array (legacy data)
      childProjects.forEach(project => {
        if (!renderedIds.has(project.id)) {
          if (!this._showArchived && project.archived) return;
          if (this._selectedTagFilter && !(project.tags || []).includes(this._selectedTagFilter)) return;
          if (searchQuery && !project.name.toLowerCase().includes(searchQuery) && !project.path.toLowerCase().includes(searchQuery)) return;
          childrenHtml += this._renderProjectHtml(project, depth + 1);
        }
      });
    }

    // When searching, skip folders with no matching content
    const folderNameMatches = searchQuery && folder.name.toLowerCase().includes(searchQuery);
    if (searchQuery && !childrenHtml && !folderNameMatches) return '';

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

  _renderProjectHtml(project, depth) {
    const projectIndex = getProjectIndex(project.id);
    const terminalStats = this._callbacks.getTerminalStatsForProject(projectIndex);
    const isSelected = projectsState.get().selectedProjectFilter === projectIndex;
    const typeHandler = registry.get(project.type);
    const fivemStatus = this._fivemServers.get(projectIndex)?.status || 'stopped';
    const gitOps = this._gitOperations.get(project.id) || { pulling: false, pushing: false };
    const isGitRepo = this._gitRepoStatus.get(project.id)?.isGitRepo || false;
    const isRunning = fivemStatus === 'running';
    const isStarting = fivemStatus === 'starting';
    const projectColor = project.color || null;

    const typeCtx = { project, projectIndex, fivemStatus, isRunning, isStarting, projectColor, escapeHtml, t };

    // Claude terminal button (always present)
    const claudeBtn = `
    <button class="btn-action-icon btn-claude" data-project-id="${project.id}" title="${t('projects.openClaude')}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
    </button>`;

    // Get additional action buttons from type handler
    const typeSidebarButtons = typeHandler.getSidebarButtons(typeCtx) || '';
    const primaryActionsHtml = typeSidebarButtons + claudeBtn;

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
      <div class="more-actions-section-label">${t('projects.sectionGit')}</div>
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
      </button>`;
    }

    // Open section
    menuItemsHtml += `
    <div class="more-actions-section-label">${t('projects.sectionOpen')}</div>
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
    </button>`;

    // Project section
    menuItemsHtml += `
    <div class="more-actions-section-label">${t('projects.sectionProject')}</div>
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
    <button class="more-actions-item btn-chat-settings" data-project-id="${project.id}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
      ${t('projects.chatSettings')}
    </button>
    <button class="more-actions-item btn-manage-tags" data-project-id="${project.id}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg>
      ${t('projects.tags')}
    </button>
    <button class="more-actions-item btn-rename-project" data-project-id="${project.id}">
      ${menuIcons.rename}
      ${t('common.rename')}
    </button>
    <button class="more-actions-item btn-add-to-workspace" data-project-id="${project.id}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm11 0v3h-3v2h3v3h2v-3h3v-2h-3v-3h-2z"/></svg>
      ${t('workspace.addToWorkspace')}
    </button>
    <div class="more-actions-divider"></div>
    <button class="more-actions-item btn-archive-project" data-project-id="${project.id}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/></svg>
      ${project.archived ? t('projects.unarchive') : t('projects.archive')}
    </button>
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
    const gitBranch = this._gitRepoStatus.get(project.id)?.branch || null;

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
    <div class="project-item ${isSelected ? 'active' : ''} ${project.archived ? 'archived' : ''} ${typeHandler.getProjectItemClass(typeCtx)}"
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
          ${(() => { const pws = getWorkspacesForProject(project.id); return pws.length > 0 ? `<span class="project-workspace-badge" title="${escapeHtml(pws.map(w => w.name).join(', '))}" style="color: ${sanitizeColor(pws[0].color) || 'var(--accent)'}">${escapeHtml(pws[0].icon || t('workspace.badge'))}</span>` : ''; })()}
        </div>
        <div class="project-path">${escapeHtml(project.path)}</div>
        ${hasTime ? `<div class="project-time">
          <span class="time-today" title="${t('common.today')}">${formatDuration(times.today)}</span>
          <span class="time-separator">\u2022</span>
          <span class="time-total" title="${t('common.total')}">${formatDuration(times.total)}</span>
        </div>` : ''}
        ${(() => { const tags = project.tags || []; return tags.length > 0 ? `<div class="project-tags">${tags.map(tag => `<span class="project-tag-chip">${escapeHtml(tag)}</span>`).join('')}</div>` : ''; })()}
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

  _setupDragAndDrop(list) {
    const self = this;
    // Remove previous delegated listeners (prevents stacking on re-render)
    if (this._dndCleanup) {
      this._dndCleanup();
      this._dndCleanup = null;
    }

    function onDragStart(e) {
      const el = e.target.closest('[draggable="true"]');
      if (!el) return;
      e.stopPropagation();
      const projectId = el.dataset.projectId;
      const folderId = el.dataset.folderId;
      if (projectId) self._dragState.dragging = { type: 'project', id: projectId };
      else if (folderId) self._dragState.dragging = { type: 'folder', id: folderId };
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', '');

      // Mark list as drag-active and flag invalid drop targets
      list.classList.add('drag-active');
      if (self._dragState.dragging.type === 'folder') {
        list.querySelectorAll('.folder-item').forEach(f => {
          const fId = f.dataset.folderId;
          if (fId === self._dragState.dragging.id || isDescendantOf(fId, self._dragState.dragging.id)) {
            f.classList.add('drop-invalid');
          }
        });
      }
    }

    function onDragEnd(e) {
      const el = e.target.closest('[draggable="true"]');
      if (el) el.classList.remove('dragging');
      self._dragState.dragging = null;
      self._dragState.dropTarget = null;
      clearDropIndicators(list);
      list.classList.remove('drag-active');
      list.querySelectorAll('.drop-invalid').forEach(el => el.classList.remove('drop-invalid'));
    }

    let _lastDragOver = 0;
    function onDragOver(e) {
      if (!self._dragState.dragging) return;

      // Throttle dragover to avoid excessive repaints
      const now = Date.now();
      if (now - _lastDragOver < 50) {
        e.preventDefault();
        return;
      }
      _lastDragOver = now;

      // Folder header
      const folderHeader = e.target.closest('.folder-header');
      if (folderHeader) {
        e.preventDefault();
        e.stopPropagation();
        const folder = folderHeader.closest('.folder-item');
        const folderId = folder?.dataset.folderId;
        if (self._dragState.dragging.type === 'folder' && folderId) {
          if (self._dragState.dragging.id === folderId || isDescendantOf(folderId, self._dragState.dragging.id)) {
            e.dataTransfer.dropEffect = 'none';
            clearDropIndicators(list);
            folderHeader.classList.add('drop-invalid-hover');
            self._dragState.dropTarget = { type: 'folder', id: folderId, position: 'invalid' };
            return;
          }
        }
        e.dataTransfer.dropEffect = 'move';
        clearDropIndicators(list);
        const position = getDropPosition(e, folderHeader, true);
        folderHeader.classList.add(`drop-${position}`);
        self._dragState.dropTarget = { type: 'folder', id: folderId, position };
        return;
      }

      // Project item
      const project = e.target.closest('.project-item');
      if (project) {
        e.preventDefault();
        e.stopPropagation();
        const projectId = project.dataset.projectId;
        if (self._dragState.dragging.id === projectId) {
          e.dataTransfer.dropEffect = 'none';
          return;
        }
        e.dataTransfer.dropEffect = 'move';
        clearDropIndicators(list);
        const position = getDropPosition(e, project, false);
        project.classList.add(`drop-${position}`);
        self._dragState.dropTarget = { type: 'project', id: projectId, position };
        return;
      }

      // Root drop zone
      const rootZone = e.target.closest('.drop-zone-root');
      if (rootZone) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearDropIndicators(list);
        rootZone.classList.add('drag-over');
        self._dragState.dropTarget = { type: 'root', id: null };
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
      if (!self._dragState.dragging || !self._dragState.dropTarget) {
        // Root drop zone (no dropTarget set yet for simple drops)
        if (e.target.closest('.drop-zone-root') && self._dragState.dragging) {
          moveItemToFolder(self._dragState.dragging.type, self._dragState.dragging.id, null);
          self._dragState.dragging = null;
          self._dragState.dropTarget = null;
          if (self._callbacks.onRenderProjects) self._callbacks.onRenderProjects();
        }
        return;
      }

      const { position } = self._dragState.dropTarget;
      if (position === 'invalid') {
        Toast.showToast({ message: t('projects.dropInvalidNesting'), type: 'warning' });
        self._dragState.dragging = null;
        self._dragState.dropTarget = null;
        return;
      }
      if (self._dragState.dropTarget.type === 'folder') {
        if (position === 'into') {
          if (self._dragState.dragging.type === 'folder' && self._dragState.dragging.id === self._dragState.dropTarget.id) return;
          moveItemToFolder(self._dragState.dragging.type, self._dragState.dragging.id, self._dragState.dropTarget.id);
        } else {
          reorderItem(self._dragState.dragging.type, self._dragState.dragging.id, self._dragState.dropTarget.id, position);
        }
      } else if (self._dragState.dropTarget.type === 'project') {
        reorderItem(self._dragState.dragging.type, self._dragState.dragging.id, self._dragState.dropTarget.id, position);
      } else if (self._dragState.dropTarget.type === 'root') {
        moveItemToFolder(self._dragState.dragging.type, self._dragState.dragging.id, null);
      }

      self._dragState.dragging = null;
      self._dragState.dropTarget = null;
      if (self._callbacks.onRenderProjects) self._callbacks.onRenderProjects();
    }

    list.addEventListener('dragstart', onDragStart);
    list.addEventListener('dragend', onDragEnd);
    list.addEventListener('dragover', onDragOver);
    list.addEventListener('dragleave', onDragLeave);
    list.addEventListener('drop', onDrop);

    this._dndCleanup = () => {
      list.removeEventListener('dragstart', onDragStart);
      list.removeEventListener('dragend', onDragEnd);
      list.removeEventListener('dragover', onDragOver);
      list.removeEventListener('dragleave', onDragLeave);
      list.removeEventListener('drop', onDrop);
    };
  }

  _removeActiveTooltip() {
    if (this._activeTooltip) {
      this._activeTooltip.remove();
      this._activeTooltip = null;
    }
    clearTimeout(this._tooltipTimeout);
  }

  _setupCompactTooltips(list) {
    if (this._tooltipDelegationSetup) return;
    this._tooltipDelegationSetup = true;
    const self = this;

    list.addEventListener('mouseover', (e) => {
      const item = e.target.closest('.project-item');
      if (!item || item.classList.contains('active')) return;
      if (!document.body.classList.contains('compact-projects')) return;
      if (self._activeTooltip && self._activeTooltip._forProjectId === item.dataset.projectId) return;

      const tooltipSource = item.querySelector('.project-tooltip');
      if (!tooltipSource || !tooltipSource.innerHTML.trim()) return;

      clearTimeout(self._tooltipTimeout);
      self._tooltipTimeout = setTimeout(() => {
        self._removeActiveTooltip();

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
        self._activeTooltip = tooltip;
      }, 300);
    });

    list.addEventListener('mouseout', (e) => {
      const item = e.target.closest('.project-item');
      if (item && !item.contains(e.relatedTarget)) {
        self._removeActiveTooltip();
      }
    });
  }

  _showProjectSettings(project) {
    const self = this;
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
            if (self._callbacks.onRenderProjects) self._callbacks.onRenderProjects();
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

  _attachListeners(list) {
    const self = this;
    // === SINGLE DELEGATED CLICK HANDLER ===
    list.onclick = (e) => {
      const target = e.target;

      // Folder chevron
      const chevron = target.closest('.folder-chevron');
      if (chevron) {
        e.stopPropagation();
        toggleFolderCollapse(chevron.closest('.folder-item').dataset.folderId);
        if (self._callbacks.onRenderProjects) self._callbacks.onRenderProjects();
        return;
      }

      // Folder header (not chevron, not button)
      const folderHeader = target.closest('.folder-header');
      if (folderHeader && !target.closest('button')) {
        toggleFolderCollapse(folderHeader.closest('.folder-item').dataset.folderId);
        if (self._callbacks.onRenderProjects) self._callbacks.onRenderProjects();
        return;
      }

      // Any button click
      const btn = target.closest('button');
      if (btn) {
        e.stopPropagation();
        const projectId = btn.dataset.projectId;

        // Close more-actions menu for any menu item click
        if (btn.classList.contains('more-actions-item')) {
          self.closeAllMoreActionsMenus();
        }

        if (btn.classList.contains('btn-claude')) {
          const project = getProject(projectId);
          const projectIndex = getProjectIndex(projectId);
          setSelectedProjectFilter(projectIndex);
          if (self._callbacks.onRenderProjects) self._callbacks.onRenderProjects();
          if (self._callbacks.onCreateTerminal) self._callbacks.onCreateTerminal(project);
        } else if (btn.classList.contains('btn-git-pull')) {
          if (self._callbacks.onGitPull) self._callbacks.onGitPull(projectId);
        } else if (btn.classList.contains('btn-git-push')) {
          if (self._callbacks.onGitPush) self._callbacks.onGitPush(projectId);
        } else if (btn.classList.contains('btn-new-worktree')) {
          const project = getProject(projectId);
          self.closeAllMoreActionsMenus();
          if (self._callbacks.onNewWorktree) self._callbacks.onNewWorktree(project);
        } else if (btn.classList.contains('btn-basic-terminal')) {
          const project = getProject(projectId);
          const projectIndex = getProjectIndex(projectId);
          setSelectedProjectFilter(projectIndex);
          self.closeAllMoreActionsMenus();
          if (self._callbacks.onRenderProjects) self._callbacks.onRenderProjects();
          if (self._callbacks.onCreateBasicTerminal) self._callbacks.onCreateBasicTerminal(project);
        } else if (btn.classList.contains('btn-open-folder')) {
          const project = getProject(projectId);
          if (project) self._api.dialog.openInExplorer(project.path);
        } else if (btn.classList.contains('btn-open-editor')) {
          const project = getProject(projectId);
          if (!project) return;
          const editor = getProjectEditor(projectId) || getSetting('editor') || 'code';
          self.closeAllMoreActionsMenus();
          self._api.dialog.openInEditor({ editor: getEditorCommand(editor), path: project.path });
        } else if (btn.classList.contains('btn-delete-project')) {
          self.closeAllMoreActionsMenus();
          if (self._callbacks.onDeleteProject) self._callbacks.onDeleteProject(projectId);
        } else if (btn.classList.contains('btn-rename-project')) {
          self.closeAllMoreActionsMenus();
          if (self._callbacks.onRenameProject) self._callbacks.onRenameProject(projectId);
        } else if (btn.classList.contains('btn-more-actions')) {
          const menu = btn.nextElementSibling;
          const isActive = menu.classList.contains('active');
          self.closeAllMoreActionsMenus();
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
            self._setupMoreActionsCloseListeners(menu, btn);
          }
        } else if (btn.classList.contains('btn-folder-color')) {
          const folderId = btn.dataset.folderId;
          const folder = getFolder(folderId);
          if (folder) {
            CustomizePicker.show(btn, 'folder', folderId, folder, {
              onColorChange: (id, color) => { setFolderColor(id, color); if (self._callbacks.onRenderProjects) self._callbacks.onRenderProjects(); },
              onIconChange: (id, icon) => { setFolderIcon(id, icon); if (self._callbacks.onRenderProjects) self._callbacks.onRenderProjects(); },
              onClose: () => {}
            });
          }
        } else if (btn.classList.contains('btn-project-settings')) {
          const project = getProject(projectId);
          self.closeAllMoreActionsMenus();
          if (project) self._showProjectSettings(project);
        } else if (btn.classList.contains('btn-add-to-workspace')) {
          self.closeAllMoreActionsMenus();
          self._showAddToWorkspaceMenu(btn, projectId);
        } else if (btn.classList.contains('btn-archive-project')) {
          const project = getProject(projectId);
          self.closeAllMoreActionsMenus();
          if (project) {
            if (project.archived) { unarchiveProject(projectId); } else { archiveProject(projectId); }
            if (self._callbacks.onRenderProjects) self._callbacks.onRenderProjects();
          }
        } else if (btn.classList.contains('btn-chat-settings')) {
          const project = getProject(projectId);
          self.closeAllMoreActionsMenus();
          if (project) self._showChatSettingsModal(project);
        } else if (btn.classList.contains('btn-manage-tags')) {
          const project = getProject(projectId);
          self.closeAllMoreActionsMenus();
          if (project) self._showTagsModal(project);
        } else if (btn.classList.contains('btn-toggle-archived')) {
          self._showArchived = !self._showArchived;
          if (self._callbacks.onRenderProjects) self._callbacks.onRenderProjects();
        } else if (btn.classList.contains('btn-clear-tag-filter')) {
          self._selectedTagFilter = null;
          if (self._callbacks.onRenderProjects) self._callbacks.onRenderProjects();
        } else if (btn.classList.contains('btn-customize-project')) {
          const project = getProject(projectId);
          self.closeAllMoreActionsMenus();
          if (project) {
            CustomizePicker.show(btn, 'project', projectId, project, {
              onColorChange: (id, color) => { setProjectColor(id, color); if (self._callbacks.onRenderProjects) self._callbacks.onRenderProjects(); },
              onIconChange: (id, icon) => { setProjectIcon(id, icon); if (self._callbacks.onRenderProjects) self._callbacks.onRenderProjects(); },
              onClose: () => {}
            });
          }
        }
        return;
      }

      // Tag filter chip click
      const tagChip = target.closest('.tag-filter-option');
      if (tagChip) {
        self._selectedTagFilter = tagChip.dataset.tag;
        if (self._callbacks.onRenderProjects) self._callbacks.onRenderProjects();
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
        document.getElementById('terminals-container').style.display = '';
        document.getElementById('terminals-tabs').style.display = '';
        if (self._callbacks.onFilterTerminals) self._callbacks.onFilterTerminals(projectIndex);
        if (self._callbacks.onRenderProjects) self._callbacks.onRenderProjects();
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
        self.closeAllMoreActionsMenus();

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
            if (self._callbacks.onRenderProjects) self._callbacks.onRenderProjects();
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

        self.closeAllMoreActionsMenus();

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
      ...this._callbacks,
      onStartFivem: (projectId) => { if (self._callbacks.onStartFivem) self._callbacks.onStartFivem(getProjectIndex(projectId)); },
      onStopFivem: (projectId) => { if (self._callbacks.onStopFivem) self._callbacks.onStopFivem(getProjectIndex(projectId)); },
      onOpenFivemConsole: (projectId) => { if (self._callbacks.onOpenFivemConsole) self._callbacks.onOpenFivemConsole(getProjectIndex(projectId)); }
    };
    registry.getAll().forEach(typeHandler => {
      typeHandler.bindSidebarEvents(list, typeCallbacks);
    });

    // Compact tooltip (hover on non-active projects)
    this._setupCompactTooltips(list);

    // Drag & Drop
    this._setupDragAndDrop(list);
  }

  _showChatSettingsModal(project) {
    const settings = getProjectSettings(project.id);
    const models = [
      { value: '', label: t('projects.useGlobal') },
      { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { value: 'claude-opus-4-6', label: 'Opus 4.6' },
      { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    ];
    const efforts = [
      { value: '', label: t('projects.useGlobal') },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' },
    ];

    const modelOptions = models.map(m => `<option value="${m.value}" ${(settings.chatModel || '') === m.value ? 'selected' : ''}>${m.label}</option>`).join('');
    const effortOptions = efforts.map(e => `<option value="${e.value}" ${(settings.effortLevel || '') === e.value ? 'selected' : ''}>${e.label}</option>`).join('');

    const modal = createModal({
      id: 'chat-settings-modal',
      title: `${t('projects.chatSettingsTitle')} — ${escapeHtml(project.name)}`,
      content: `<div class="project-settings-form">
      <div class="project-settings-field">
        <label class="project-settings-label">${t('projects.chatModel')}</label>
        <select id="cs-model" class="project-settings-input">${modelOptions}</select>
      </div>
      <div class="project-settings-field">
        <label class="project-settings-label">${t('projects.effortLevel')}</label>
        <select id="cs-effort" class="project-settings-input">${effortOptions}</select>
      </div>
      <div class="project-settings-field">
        <label class="project-settings-label">${t('projects.skipPermissions')}</label>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
          <select id="cs-skip" class="project-settings-input">
            <option value="" ${settings.skipPermissions === null || settings.skipPermissions === undefined ? 'selected' : ''}>${t('projects.useGlobal')}</option>
            <option value="true" ${settings.skipPermissions === true ? 'selected' : ''}>On</option>
            <option value="false" ${settings.skipPermissions === false ? 'selected' : ''}>Off</option>
          </select>
        </div>
      </div>
    </div>`,
      buttons: [
        { label: t('common.cancel'), action: 'cancel', onClick: (m) => closeModal(m) },
        { label: t('common.save'), action: 'save', primary: true, onClick: (m) => {
          const model = m.querySelector('#cs-model').value || null;
          const effort = m.querySelector('#cs-effort').value || null;
          const skipVal = m.querySelector('#cs-skip').value;
          const skip = skipVal === '' ? null : skipVal === 'true';
          setProjectSettings(project.id, { chatModel: model, effortLevel: effort, skipPermissions: skip });
          closeModal(m);
          Toast.show(t('settings.saved'), 'success');
        }},
      ],
      size: 'small'
    });
    showModal(modal);
  }

  _showTagsModal(project) {
    const self = this;
    const tags = [...getProjectTags(project.id)];
    const allExisting = getAllTags();

    function renderTagsList() {
      return tags.length === 0
        ? `<div style="color:var(--text-muted);font-size:var(--font-xs);padding:8px 0">${t('projects.noTags')}</div>`
        : tags.map(tag => `<span class="project-tag-chip tag-removable">${escapeHtml(tag)} <button class="btn-remove-tag" data-tag="${escapeHtml(tag)}">&times;</button></span>`).join('');
    }

    const suggestionsHtml = allExisting.filter(t => !tags.includes(t)).slice(0, 10).map(tag =>
      `<span class="project-tag-chip tag-suggestion" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</span>`
    ).join('');

    const modal = createModal({
      id: 'tags-modal',
      title: `${t('projects.tags')} — ${escapeHtml(project.name)}`,
      content: `<div style="display:flex;flex-direction:column;gap:12px">
      <div>
        <div class="tags-list" id="tags-list">${renderTagsList()}</div>
      </div>
      <div style="display:flex;gap:8px">
        <input id="tag-input" class="project-settings-input" placeholder="${t('projects.addTag')}" style="flex:1" maxlength="30" />
        <button class="btn-primary" id="btn-add-tag" style="padding:4px 12px">${t('common.add')}</button>
      </div>
      ${suggestionsHtml ? `<div><div style="font-size:var(--font-2xs);color:var(--text-muted);margin-bottom:4px">${t('projects.existingTags')}</div><div class="tags-suggestions">${suggestionsHtml}</div></div>` : ''}
    </div>`,
      buttons: [
        { label: t('common.close'), action: 'close', onClick: (m) => { setProjectTags(project.id, tags); closeModal(m); if (self._callbacks.onRenderProjects) self._callbacks.onRenderProjects(); }},
      ],
      size: 'small'
    });

    showModal(modal);

    const tagInput = modal.querySelector('#tag-input');
    const tagsList = modal.querySelector('#tags-list');

    function addTag(value) {
      const v = value.trim().toLowerCase();
      if (!v || tags.includes(v)) return;
      tags.push(v);
      tagsList.innerHTML = renderTagsList();
      bindTagRemoveButtons();
      tagInput.value = '';
      tagInput.focus();
    }

    function bindTagRemoveButtons() {
      tagsList.querySelectorAll('.btn-remove-tag').forEach(btn => {
        btn.onclick = () => {
          const idx = tags.indexOf(btn.dataset.tag);
          if (idx >= 0) tags.splice(idx, 1);
          tagsList.innerHTML = renderTagsList();
          bindTagRemoveButtons();
        };
      });
    }
    bindTagRemoveButtons();

    modal.querySelector('#btn-add-tag').onclick = () => addTag(tagInput.value);
    tagInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(tagInput.value); } });
    modal.querySelectorAll('.tag-suggestion').forEach(chip => {
      chip.onclick = () => addTag(chip.dataset.tag);
    });
  }

  render() {
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    const self = this;
    requestAnimationFrame(() => self._renderNow());
  }

  _renderNow() {
    this._renderScheduled = false;
    this._removeActiveTooltip();
    const list = document.getElementById('projects-list');
    if (!list) return;
    const state = projectsState.get();

    if (state.projects.length === 0 && state.folders.length === 0) {
      const self = this;
      list.innerHTML = `
      <div class="empty-state small">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>
        <p>${t('projects.noProjects')}</p>
        <p class="hint">${t('projects.emptyGuide')}</p>
        <button class="empty-state-cta" id="empty-add-project">
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          ${t('projects.addFirstProject')}
        </button>
        <button class="empty-state-link" id="empty-add-folder">${t('projects.orCreateFolder')}</button>
      </div>`;
      // Attach CTA handlers
      list.querySelector('#empty-add-project')?.addEventListener('click', () => {
        document.getElementById('btn-new-project')?.click();
      });
      list.querySelector('#empty-add-folder')?.addEventListener('click', () => {
        if (self._callbacks.onCreateFolder) self._callbacks.onCreateFolder();
      });
      return;
    }

    // Search filter
    const searchInput = document.getElementById('projects-search-input');
    const searchQuery = searchInput?.value?.trim().toLowerCase() || '';

    // Tag filter bar
    let html = '';
    const allTags = getAllTags();
    if (allTags.length > 0 || this._selectedTagFilter) {
      html += `<div class="tag-filter-bar">`;
      if (this._selectedTagFilter) {
        html += `<span class="tag-filter-active"><span class="project-tag-chip">${escapeHtml(this._selectedTagFilter)}</span><button class="btn-clear-tag-filter" title="${t('projects.clearTagFilter')}">&times;</button></span>`;
      } else {
        html += allTags.slice(0, 8).map(tag => `<span class="project-tag-chip tag-filter-option" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</span>`).join('');
      }
      html += `</div>`;
    }

    state.rootOrder.forEach(itemId => {
      const folder = getFolder(itemId);
      if (folder) {
        const folderHtml = this._renderFolderHtml(folder, 0, searchQuery);
        if (folderHtml) html += folderHtml;
      } else {
        const project = getProject(itemId);
        if (project) {
          if (!this._showArchived && project.archived) return;
          if (this._selectedTagFilter && !(project.tags || []).includes(this._selectedTagFilter)) return;
          if (searchQuery && !project.name.toLowerCase().includes(searchQuery) && !project.path.toLowerCase().includes(searchQuery)) return;
          html += this._renderProjectHtml(project, 0);
        }
      }
    });

    // Search empty state
    if (searchQuery && !html) {
      list.innerHTML = `
      <div class="empty-state small">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
        <p>${t('projects.noProjects')}</p>
      </div>`;
      return;
    }

    // Archive toggle
    const archivedCount = getArchivedCount();
    if (archivedCount > 0) {
      html += `<button class="btn-toggle-archived">${this._showArchived ? t('projects.hideArchived') : t('projects.showArchived', { count: archivedCount })}</button>`;
    }

    html += `<div class="drop-zone-root" data-target="root"></div>`;
    list.innerHTML = html;
    this._attachListeners(list);
  }

  _showAddToWorkspaceMenu(anchorEl, projectId) {
    const { workspaceState, addProjectToWorkspace } = require('../../state/workspace.state');
    const workspaces = workspaceState.get().workspaces || [];
    const alreadyIn = getWorkspacesForProject(projectId).map(w => w.id);

    if (workspaces.length === 0) {
      Toast.showToast({ message: t('workspace.noWorkspaces'), type: 'info' });
      return;
    }

    const menu = document.createElement('div');
    menu.className = 'editor-context-menu';
    menu.style.cssText = `position:fixed;z-index:10001;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:8px;padding:4px 0;min-width:200px;box-shadow:0 8px 24px rgba(0,0,0,0.4);`;

    let itemsHtml = '';
    for (const ws of workspaces) {
      const isIn = alreadyIn.includes(ws.id);
      itemsHtml += `<button class="editor-ctx-item" data-ws-id="${ws.id}" ${isIn ? 'disabled' : ''} style="display:flex;align-items:center;gap:8px;width:100%;padding:6px 12px;background:none;border:none;color:${isIn ? 'var(--text-muted)' : 'var(--text-primary)'};cursor:${isIn ? 'default' : 'pointer'};font-size:13px;text-align:left;">
        <span style="width:16px;text-align:center;">${isIn ? '&#10003;' : (ws.icon || '&#128193;')}</span>
        ${escapeHtml(ws.name)}
      </button>`;
    }
    menu.innerHTML = itemsHtml;

    document.body.appendChild(menu);

    const anchorRect = anchorEl.getBoundingClientRect();
    menu.style.left = `${anchorRect.right + 4}px`;
    menu.style.top = `${anchorRect.top}px`;

    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) menu.style.left = `${anchorRect.left - menuRect.width - 4}px`;
    if (menuRect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - menuRect.height - 4}px`;

    menu.onclick = (ev) => {
      const item = ev.target.closest('.editor-ctx-item');
      if (item && !item.disabled) {
        const wsId = item.dataset.wsId;
        addProjectToWorkspace(wsId, projectId);
        menu.remove();
        Toast.showToast({ message: t('workspace.projectsCount', { count: '1' }) + ' +', type: 'success' });
        if (this._callbacks.onRenderProjects) this._callbacks.onRenderProjects();
      }
    };
    menu.onmouseover = (ev) => {
      const item = ev.target.closest('.editor-ctx-item');
      if (item && !item.disabled) item.style.background = 'var(--bg-hover)';
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
  }

  destroy() {
    document.removeEventListener('click', this._outsideClickHandler);
    this.closeAllMoreActionsMenus();
    if (this._dndCleanup) {
      this._dndCleanup();
      this._dndCleanup = null;
    }
    this._removeActiveTooltip();
    clearTimeout(this._searchDebounce);
    super.destroy();
  }
}

// ── Singleton & legacy bridge ──────────────────────────────────
let _instance = null;
function _getInstance() { if (!_instance) _instance = new ProjectList(); return _instance; }

function render() { _getInstance().render(); }
function setCallbacks(cbs) { _getInstance().setCallbacks(cbs); }
function setExternalState(state) { _getInstance().setExternalState(state); }
function closeAllMoreActionsMenus() { _getInstance().closeAllMoreActionsMenus(); }

module.exports = {
  ProjectList,
  render,
  setCallbacks,
  setExternalState,
  closeAllMoreActionsMenus
};
