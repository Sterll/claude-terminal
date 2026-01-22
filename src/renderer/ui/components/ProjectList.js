/**
 * ProjectList Component
 * Renders the project tree with folders and projects
 */

const { ipcRenderer } = require('electron');
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
  setProjectColor
} = require('../../state');
const { escapeHtml } = require('../../utils');

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
  onDeleteProject: null,
  onRenameProject: null,
  onRenderProjects: null,
  countTerminalsForProject: () => 0
};

// External state references
let fivemServers = new Map();
let gitOperations = new Map();
let gitRepoStatus = new Map();

/**
 * Set external state references
 */
function setExternalState(state) {
  if (state.fivemServers) fivemServers = state.fivemServers;
  if (state.gitOperations) gitOperations = state.gitOperations;
  if (state.gitRepoStatus) gitRepoStatus = state.gitRepoStatus;
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

// Available colors for folder/project customization
const ITEM_COLORS = [
  { name: 'Default', value: null },
  { name: 'Rouge', value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Ambre', value: '#f59e0b' },
  { name: 'Jaune', value: '#eab308' },
  { name: 'Lime', value: '#84cc16' },
  { name: 'Vert', value: '#22c55e' },
  { name: 'Emeraude', value: '#10b981' },
  { name: 'Cyan', value: '#06b6d4' },
  { name: 'Bleu', value: '#3b82f6' },
  { name: 'Indigo', value: '#6366f1' },
  { name: 'Violet', value: '#8b5cf6' },
  { name: 'Fuchsia', value: '#d946ef' },
  { name: 'Rose', value: '#ec4899' }
];

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
    (folder.children || []).forEach(childId => {
      const childFolder = getFolder(childId);
      if (childFolder) childrenHtml += renderFolderHtml(childFolder, depth + 1);
    });
    childProjects.forEach(project => {
      childrenHtml += renderProjectHtml(project, depth + 1);
    });
  }

  const colorStyle = folderColor ? `style="color: ${folderColor}"` : '';
  const colorIndicator = folderColor ? `<span class="color-indicator" style="background: ${folderColor}"></span>` : '';

  return `
    <div class="folder-item" data-folder-id="${folder.id}" data-depth="${depth}" draggable="true">
      <div class="folder-header" style="padding-left: ${depth * 16 + 8}px;">
        <span class="folder-chevron ${folder.collapsed ? 'collapsed' : ''} ${!hasChildren ? 'hidden' : ''}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
        </span>
        ${colorIndicator}
        <svg class="folder-icon" viewBox="0 0 24 24" fill="currentColor" ${colorStyle}><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
        <span class="folder-name">${escapeHtml(folder.name)}</span>
        <span class="folder-count">${projectCount}</span>
        <button class="btn-folder-color" data-folder-id="${folder.id}" title="Changer la couleur">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>
        </button>
      </div>
      <div class="folder-children ${folder.collapsed ? 'collapsed' : ''}">${childrenHtml}</div>
    </div>`;
}

/**
 * Render project HTML
 */
function renderProjectHtml(project, depth) {
  const projectIndex = getProjectIndex(project.id);
  const terminalCount = callbacks.countTerminalsForProject(projectIndex);
  const isSelected = projectsState.get().selectedProjectFilter === projectIndex;
  const isFivem = project.type === 'fivem';
  const fivemStatus = fivemServers.get(projectIndex)?.status || 'stopped';
  const gitOps = gitOperations.get(project.id) || { pulling: false, pushing: false };
  const isGitRepo = gitRepoStatus.get(project.id)?.isGitRepo || false;
  const isRunning = fivemStatus === 'running';
  const isStarting = fivemStatus === 'starting';
  const projectColor = project.color || null;

  let primaryActionsHtml = '';
  if (isFivem) {
    if (isRunning || isStarting) {
      primaryActionsHtml = `
        <button class="btn-action-icon btn-fivem-console" data-project-id="${project.id}" title="Console serveur">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
        </button>
        <button class="btn-action-primary btn-fivem-stop" data-project-id="${project.id}" title="Arreter le serveur">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>
        </button>`;
    } else {
      primaryActionsHtml = `
        <button class="btn-action-primary btn-fivem-start" data-project-id="${project.id}" title="Demarrer le serveur">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>`;
    }
  } else {
    primaryActionsHtml = `
      <button class="btn-action-icon btn-claude" data-project-id="${project.id}" title="Ouvrir Claude Code">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
      </button>`;
  }

  // Color picker for menu
  const colorPickerHtml = `
    <div class="more-actions-item color-picker-row" data-project-id="${project.id}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>
      <span>Couleur</span>
      <div class="color-picker-swatches">
        ${ITEM_COLORS.map(c => `<button class="color-swatch-mini ${c.value === projectColor ? 'selected' : ''} ${!c.value ? 'default' : ''}" data-color="${c.value || ''}" title="${c.name}" ${c.value ? `style="background: ${c.value}"` : ''}></button>`).join('')}
      </div>
    </div>`;

  let menuItemsHtml = '';
  if (isFivem) {
    menuItemsHtml += `
      <button class="more-actions-item btn-claude" data-project-id="${project.id}">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
        Claude Code
      </button>`;
  }
  if (isGitRepo) {
    menuItemsHtml += `
      <button class="more-actions-item btn-git-pull ${gitOps.pulling ? 'loading' : ''}" data-project-id="${project.id}" ${gitOps.pulling ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
        Git Pull
      </button>
      <button class="more-actions-item btn-git-push ${gitOps.pushing ? 'loading' : ''}" data-project-id="${project.id}" ${gitOps.pushing ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 4v2h14V4H5zm0 10h4v6h6v-6h4l-7-7-7 7z"/></svg>
        Git Push
      </button>
      <div class="more-actions-divider"></div>`;
  }
  menuItemsHtml += `
    <button class="more-actions-item btn-basic-terminal" data-project-id="${project.id}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 19V7H4v12h16m0-16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16m-7 14v-2h5v2h-5m-3.42-4L5.57 9H8.4l3.3 3.3c.39.39.39 1.03 0 1.42L8.42 17H5.59l4-4z"/></svg>
      Terminal basique
    </button>
    <button class="more-actions-item btn-open-folder" data-project-id="${project.id}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7l2 2h5v12zm0-12h-5l-2-2H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2z"/></svg>
      Ouvrir le dossier
    </button>
    ${colorPickerHtml}
    <div class="more-actions-divider"></div>
    <button class="more-actions-item btn-rename-project" data-project-id="${project.id}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
      Renommer
    </button>
    <div class="more-actions-divider"></div>
    <button class="more-actions-item danger btn-delete-project" data-project-id="${project.id}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
      Supprimer
    </button>`;

  const statusIndicator = isFivem ? `<span class="fivem-status-dot ${fivemStatus}" title="${fivemStatus === 'stopped' ? 'Arrete' : fivemStatus === 'starting' ? 'Demarrage...' : 'En cours'}"></span>` : '';
  const colorIndicator = projectColor ? `<span class="color-indicator" style="background: ${projectColor}"></span>` : '';
  const iconColorStyle = projectColor ? `style="color: ${projectColor}"` : '';

  return `
    <div class="project-item ${isSelected ? 'active' : ''} ${isFivem ? 'fivem-project' : ''}"
         data-project-id="${project.id}" data-depth="${depth}" draggable="true"
         style="margin-left: ${depth * 16}px;">
      <div class="project-info">
        <div class="project-name">
          ${colorIndicator}
          ${isFivem ? `${statusIndicator}<svg viewBox="0 0 24 24" fill="currentColor" class="fivem-icon" ${iconColorStyle}><path d="M21 16V4H3v12h18m0-14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7v2h2v2H8v-2h2v-2H3a2 2 0 0 1-2-2V4c0-1.11.89-2 2-2h18M5 6h9v5H5V6m10 0h4v2h-4V6m4 3v5h-4V9h4M5 12h4v2H5v-2m5 0h4v2h-4v-2z"/></svg>` : `<svg viewBox="0 0 24 24" fill="currentColor" ${iconColorStyle}><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>`}
          <span>${escapeHtml(project.name)}</span>
          ${!isFivem && terminalCount > 0 ? `<span class="terminal-count">${terminalCount}</span>` : ''}
        </div>
        <div class="project-path">${escapeHtml(project.path)}</div>
      </div>
      <div class="project-actions">
        ${primaryActionsHtml}
        <div class="more-actions">
          <button class="btn-more-actions" title="Plus d'actions">
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
 * Setup drag and drop for project list
 */
function setupDragAndDrop(list) {
  // Drag start for all draggable items
  list.querySelectorAll('[draggable="true"]').forEach(el => {
    el.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      const projectId = el.dataset.projectId;
      const folderId = el.dataset.folderId;
      if (projectId) dragState.dragging = { type: 'project', id: projectId };
      else if (folderId) dragState.dragging = { type: 'folder', id: folderId };
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', '');
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      dragState.dragging = null;
      dragState.dropTarget = null;
      clearDropIndicators(list);
    });
  });

  // Handle drag over folders
  list.querySelectorAll('.folder-item').forEach(folder => {
    const folderHeader = folder.querySelector('.folder-header');

    folderHeader.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!dragState.dragging) return;

      const folderId = folder.dataset.folderId;

      // Prevent dropping folder into itself or descendants
      if (dragState.dragging.type === 'folder') {
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
    });

    folderHeader.addEventListener('dragleave', (e) => {
      if (!folderHeader.contains(e.relatedTarget)) {
        folderHeader.classList.remove('drop-before', 'drop-after', 'drop-into');
      }
    });

    folderHeader.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearDropIndicators(list);

      if (!dragState.dragging || !dragState.dropTarget) return;

      const { position } = dragState.dropTarget;
      const targetFolderId = folder.dataset.folderId;

      if (position === 'into') {
        // Move into folder
        moveItemToFolder(dragState.dragging.type, dragState.dragging.id, targetFolderId);
      } else {
        // Reorder before/after
        reorderItem(dragState.dragging.type, dragState.dragging.id, targetFolderId, position);
      }

      dragState.dragging = null;
      dragState.dropTarget = null;
      if (callbacks.onRenderProjects) callbacks.onRenderProjects();
    });
  });

  // Handle drag over projects
  list.querySelectorAll('.project-item').forEach(project => {
    project.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!dragState.dragging) return;

      // Prevent dropping on itself
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
    });

    project.addEventListener('dragleave', (e) => {
      if (!project.contains(e.relatedTarget)) {
        project.classList.remove('drop-before', 'drop-after');
      }
    });

    project.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearDropIndicators(list);

      if (!dragState.dragging || !dragState.dropTarget) return;

      const { position } = dragState.dropTarget;
      const targetProjectId = project.dataset.projectId;

      // Reorder relative to project
      reorderItem(dragState.dragging.type, dragState.dragging.id, targetProjectId, position);

      dragState.dragging = null;
      dragState.dropTarget = null;
      if (callbacks.onRenderProjects) callbacks.onRenderProjects();
    });
  });

  // Root drop zone (for moving to root level at the end)
  const rootDropZone = list.querySelector('.drop-zone-root');
  if (rootDropZone) {
    rootDropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDropIndicators(list);
      rootDropZone.classList.add('drag-over');
      dragState.dropTarget = { type: 'root', id: null };
    });

    rootDropZone.addEventListener('dragleave', () => {
      rootDropZone.classList.remove('drag-over');
    });

    rootDropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      clearDropIndicators(list);
      if (!dragState.dragging) return;
      moveItemToFolder(dragState.dragging.type, dragState.dragging.id, null);
      dragState.dragging = null;
      dragState.dropTarget = null;
      if (callbacks.onRenderProjects) callbacks.onRenderProjects();
    });
  }
}

/**
 * Attach all event listeners to project list
 */
function attachListeners(list) {
  // Folder click - toggle collapse
  list.querySelectorAll('.folder-header').forEach(header => {
    header.onclick = (e) => {
      if (!e.target.closest('.folder-chevron')) {
        toggleFolderCollapse(header.closest('.folder-item').dataset.folderId);
        if (callbacks.onRenderProjects) callbacks.onRenderProjects();
      }
    };
  });

  list.querySelectorAll('.folder-chevron').forEach(chevron => {
    chevron.onclick = (e) => {
      e.stopPropagation();
      toggleFolderCollapse(chevron.closest('.folder-item').dataset.folderId);
      if (callbacks.onRenderProjects) callbacks.onRenderProjects();
    };
  });

  // Project click - filter terminals
  list.querySelectorAll('.project-item').forEach(item => {
    item.onclick = (e) => {
      if (!e.target.closest('button')) {
        const projectId = item.dataset.projectId;
        const projectIndex = getProjectIndex(projectId);
        setSelectedProjectFilter(projectIndex);
        setOpenedProjectId(null);
        document.getElementById('project-detail-view').style.display = 'none';
        document.getElementById('terminals-container').style.display = '';
        document.getElementById('terminals-tabs').style.display = '';
        if (callbacks.onFilterTerminals) callbacks.onFilterTerminals(projectIndex);
        if (callbacks.onRenderProjects) callbacks.onRenderProjects();
      }
    };
  });

  // Claude button
  list.querySelectorAll('.btn-claude').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const projectId = btn.dataset.projectId;
      const project = getProject(projectId);
      const projectIndex = getProjectIndex(projectId);
      setSelectedProjectFilter(projectIndex);
      if (callbacks.onRenderProjects) callbacks.onRenderProjects();
      if (callbacks.onCreateTerminal) callbacks.onCreateTerminal(project);
    };
  });

  // FiveM buttons
  list.querySelectorAll('.btn-fivem-start').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); if (callbacks.onStartFivem) callbacks.onStartFivem(getProjectIndex(btn.dataset.projectId)); };
  });
  list.querySelectorAll('.btn-fivem-stop').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); if (callbacks.onStopFivem) callbacks.onStopFivem(getProjectIndex(btn.dataset.projectId)); };
  });
  list.querySelectorAll('.btn-fivem-console').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); if (callbacks.onOpenFivemConsole) callbacks.onOpenFivemConsole(getProjectIndex(btn.dataset.projectId)); };
  });

  // Git buttons
  list.querySelectorAll('.btn-git-pull').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); if (callbacks.onGitPull) callbacks.onGitPull(btn.dataset.projectId); };
  });
  list.querySelectorAll('.btn-git-push').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); if (callbacks.onGitPush) callbacks.onGitPush(btn.dataset.projectId); };
  });

  // Basic terminal
  list.querySelectorAll('.btn-basic-terminal').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const projectId = btn.dataset.projectId;
      const project = getProject(projectId);
      const projectIndex = getProjectIndex(projectId);
      setSelectedProjectFilter(projectIndex);
      closeAllMoreActionsMenus();
      if (callbacks.onRenderProjects) callbacks.onRenderProjects();
      if (callbacks.onCreateBasicTerminal) callbacks.onCreateBasicTerminal(project);
    };
  });

  // Open folder
  list.querySelectorAll('.btn-open-folder').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const project = getProject(btn.dataset.projectId);
      if (project) ipcRenderer.send('open-in-explorer', project.path);
    };
  });

  // Delete project
  list.querySelectorAll('.btn-delete-project').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      closeAllMoreActionsMenus();
      if (callbacks.onDeleteProject) callbacks.onDeleteProject(btn.dataset.projectId);
    };
  });

  // Rename project
  list.querySelectorAll('.btn-rename-project').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      closeAllMoreActionsMenus();
      if (callbacks.onRenameProject) callbacks.onRenameProject(btn.dataset.projectId);
    };
  });

  // More actions dropdown
  list.querySelectorAll('.btn-more-actions').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const menu = btn.nextElementSibling;
      const isActive = menu.classList.contains('active');
      closeAllMoreActionsMenus();
      if (!isActive) {
        const btnRect = btn.getBoundingClientRect();
        menu.style.visibility = 'hidden';
        menu.classList.add('active');
        const menuWidth = menu.offsetWidth;
        menu.classList.remove('active');
        menu.style.visibility = '';
        let left = btnRect.right - menuWidth;
        if (left < 0) left = btnRect.left;
        menu.style.top = `${btnRect.bottom + 4}px`;
        menu.style.left = `${left}px`;
        menu.classList.add('active');
      }
    };
  });

  list.querySelectorAll('.more-actions-item').forEach(item => {
    item.addEventListener('click', () => closeAllMoreActionsMenus());
  });

  // Folder color button
  list.querySelectorAll('.btn-folder-color').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const folderId = btn.dataset.folderId;
      showColorPicker(btn, 'folder', folderId);
    };
  });

  // Project color swatches in menu
  list.querySelectorAll('.color-picker-row .color-swatch-mini').forEach(swatch => {
    swatch.onclick = (e) => {
      e.stopPropagation();
      const projectId = swatch.closest('.color-picker-row').dataset.projectId;
      const color = swatch.dataset.color || null;
      setProjectColor(projectId, color);
      closeAllMoreActionsMenus();
      if (callbacks.onRenderProjects) callbacks.onRenderProjects();
    };
  });

  // Drag & Drop
  setupDragAndDrop(list);
}

// Color picker popup state
let activeColorPicker = null;

/**
 * Show color picker popup for folders
 */
function showColorPicker(button, itemType, itemId) {
  // Close existing picker
  hideColorPicker();

  const rect = button.getBoundingClientRect();
  const item = itemType === 'folder' ? getFolder(itemId) : getProject(itemId);
  const currentColor = item?.color || null;

  const picker = document.createElement('div');
  picker.className = 'color-picker-popup';
  picker.innerHTML = `
    <div class="color-picker-popup-title">Couleur</div>
    <div class="color-picker-popup-grid">
      ${ITEM_COLORS.map(c => `
        <button class="color-swatch-popup ${c.value === currentColor ? 'selected' : ''} ${!c.value ? 'default' : ''}"
                data-color="${c.value || ''}" title="${c.name}"
                ${c.value ? `style="background: ${c.value}"` : ''}>
        </button>
      `).join('')}
    </div>
  `;

  // Position popup
  picker.style.position = 'fixed';
  picker.style.top = `${rect.bottom + 4}px`;
  picker.style.left = `${rect.left}px`;
  picker.style.zIndex = '1002';

  document.body.appendChild(picker);
  activeColorPicker = picker;

  // Handle clicks on swatches
  picker.querySelectorAll('.color-swatch-popup').forEach(swatch => {
    swatch.onclick = (e) => {
      e.stopPropagation();
      const color = swatch.dataset.color || null;
      if (itemType === 'folder') {
        setFolderColor(itemId, color);
      } else {
        setProjectColor(itemId, color);
      }
      hideColorPicker();
      if (callbacks.onRenderProjects) callbacks.onRenderProjects();
    };
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', handleOutsideClick);
  }, 0);
}

function handleOutsideClick(e) {
  if (activeColorPicker && !activeColorPicker.contains(e.target)) {
    hideColorPicker();
  }
}

function hideColorPicker() {
  if (activeColorPicker) {
    activeColorPicker.remove();
    activeColorPicker = null;
    document.removeEventListener('click', handleOutsideClick);
  }
}

/**
 * Render the project list
 */
function render() {
  const list = document.getElementById('projects-list');
  const state = projectsState.get();

  if (state.projects.length === 0 && state.folders.length === 0) {
    list.innerHTML = `
      <div class="empty-state small">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>
        <p>Aucun projet</p>
        <p class="hint">Cliquez sur + pour ajouter</p>
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
