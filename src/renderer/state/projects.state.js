/**
 * Projects State Module
 * Manages projects and folders state
 */

// Use preload API for Node.js modules
const { fs, path } = window.electron_nodeModules;
const { State } = require('./State');
const { projectsFile, dataDir } = require('../utils/paths');
const { t } = require('../i18n');

// Initial state
const initialState = {
  projects: [],
  folders: [],
  rootOrder: [],
  selectedProjectFilter: null,
  openedProjectId: null
};

const projectsState = new State(initialState);

/**
 * Generate unique folder ID
 * @returns {string}
 */
function generateFolderId() {
  return `folder-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Generate unique project ID
 * @returns {string}
 */
function generateProjectId() {
  return `project-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Get folder by ID
 * @param {string} folderId
 * @returns {Object|undefined}
 */
function getFolder(folderId) {
  return projectsState.get().folders.find(f => f.id === folderId);
}

/**
 * Get project by ID
 * @param {string} projectId
 * @returns {Object|undefined}
 */
function getProject(projectId) {
  return projectsState.get().projects.find(p => p.id === projectId);
}

/**
 * Get project index by ID
 * @param {string} projectId
 * @returns {number}
 */
function getProjectIndex(projectId) {
  return projectsState.get().projects.findIndex(p => p.id === projectId);
}

/**
 * Get child folders of a parent
 * @param {string|null} parentId
 * @returns {Array}
 */
function getChildFolders(parentId) {
  return projectsState.get().folders.filter(f => f.parentId === parentId);
}

/**
 * Get projects in a folder
 * @param {string|null} folderId
 * @returns {Array}
 */
function getProjectsInFolder(folderId) {
  return projectsState.get().projects.filter(p => p.folderId === folderId);
}

/**
 * Count projects recursively in a folder
 * @param {string} folderId
 * @returns {number}
 */
function countProjectsRecursive(folderId) {
  let count = getProjectsInFolder(folderId).length;
  getChildFolders(folderId).forEach(child => {
    count += countProjectsRecursive(child.id);
  });
  return count;
}

/**
 * Check if folder is descendant of another
 * @param {string} folderId
 * @param {string} ancestorId
 * @returns {boolean}
 */
function isDescendantOf(folderId, ancestorId) {
  let current = getFolder(folderId);
  while (current) {
    if (current.parentId === ancestorId) return true;
    current = getFolder(current.parentId);
  }
  return false;
}

/**
 * Ensure data directory exists
 */
function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

/**
 * Create backup of corrupted file
 * @param {string} filePath - Path to corrupted file
 * @returns {string|null} - Backup path or null if failed
 */
function createCorruptedBackup(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const backupPath = `${filePath}.corrupted.${Date.now()}`;
      fs.copyFileSync(filePath, backupPath);
      return backupPath;
    }
  } catch (e) {
    console.error('Failed to create backup of corrupted file:', e);
  }
  return null;
}

/**
 * Load projects from file
 */
function loadProjects() {
  try {
    ensureDataDir();

    if (fs.existsSync(projectsFile)) {
      const rawContent = fs.readFileSync(projectsFile, 'utf8');

      // Check for empty or whitespace-only file
      if (!rawContent || !rawContent.trim()) {
        console.warn('Projects file is empty, starting fresh');
        projectsState.set({ projects: [], folders: [], rootOrder: [] });
        return;
      }

      let data;
      try {
        data = JSON.parse(rawContent);
      } catch (parseError) {
        // JSON is corrupted - create backup and notify
        console.error('Projects file is corrupted:', parseError);
        const backupPath = createCorruptedBackup(projectsFile);

        // Show notification to user via preload API (if available)
        try {
          window.electron_api.notification.show({
            title: t('errors.corruptedFile'),
            body: backupPath
              ? t('errors.backupCreated', { filename: path.basename(backupPath) })
              : t('errors.backupFailed')
          });
        } catch (apiError) {
          // API not available, just log
          console.error('Could not notify user of corruption');
        }

        projectsState.set({ projects: [], folders: [], rootOrder: [] });
        return;
      }

      let needsSave = false;
      let projects, folders, rootOrder, globalTimeTracking;

      if (Array.isArray(data)) {
        // Old format: migrate
        projects = data.map((p, i) => ({
          ...p,
          type: p.type || 'standalone',
          id: p.id || `project-${Date.now()}-${i}`,
          folderId: p.folderId !== undefined ? p.folderId : null
        }));
        folders = [];
        rootOrder = projects.map(p => p.id);
        needsSave = true;
      } else {
        // New format
        projects = (data.projects || []).map((p, i) => {
          const project = { ...p };
          if (!project.type) {
            project.type = 'standalone';
            needsSave = true;
          }
          if (!project.id) {
            project.id = `project-${Date.now()}-${i}`;
            needsSave = true;
          }
          if (project.folderId === undefined) {
            project.folderId = null;
            needsSave = true;
          }
          // Migration: Initialize timeTracking if not present
          if (!project.timeTracking) {
            project.timeTracking = {
              totalTime: 0,
              todayTime: 0,
              lastActiveDate: null,
              sessions: []
            };
            needsSave = true;
          }
          return project;
        });
        folders = data.folders || [];
        rootOrder = data.rootOrder || [];
        globalTimeTracking = data.globalTimeTracking || null;

        // Ensure all root-level items are in rootOrder
        const rootItems = new Set(rootOrder);
        folders.filter(f => f.parentId === null).forEach(f => {
          if (!rootItems.has(f.id)) {
            rootOrder.push(f.id);
            needsSave = true;
          }
        });
        projects.filter(p => p.folderId === null).forEach(p => {
          if (!rootItems.has(p.id)) {
            rootOrder.push(p.id);
            needsSave = true;
          }
        });

        // Migration: Ensure projects in folders are in their parent's children array
        projects.filter(p => p.folderId !== null).forEach(p => {
          const parentFolder = folders.find(f => f.id === p.folderId);
          if (parentFolder) {
            parentFolder.children = parentFolder.children || [];
            if (!parentFolder.children.includes(p.id)) {
              parentFolder.children.push(p.id);
              needsSave = true;
            }
          }
        });
      }

      const stateToSet = { projects, folders, rootOrder };
      if (globalTimeTracking) {
        stateToSet.globalTimeTracking = globalTimeTracking;
      }
      projectsState.set(stateToSet);

      if (needsSave) {
        saveProjects();
      }
    }
  } catch (e) {
    console.error('Error loading projects:', e);

    // Create backup before resetting
    createCorruptedBackup(projectsFile);

    projectsState.set({ projects: [], folders: [], rootOrder: [] });
  }
}

// Debounce timer for save operations
let saveDebounceTimer = null;
const SAVE_DEBOUNCE_MS = 500;
let saveInProgress = false;
let pendingSave = false;

/**
 * Save projects to file (debounced, atomic write)
 */
function saveProjects() {
  // Clear existing debounce timer
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
  }

  saveDebounceTimer = setTimeout(() => {
    if (saveInProgress) {
      // Another save is running, queue for after it finishes
      pendingSave = true;
      return;
    }
    saveProjectsImmediate();
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Save projects immediately (atomic write pattern with lock)
 */
function saveProjectsImmediate() {
  if (saveInProgress) {
    pendingSave = true;
    return;
  }

  saveInProgress = true;

  const { folders, projects, rootOrder, globalTimeTracking } = projectsState.get();
  const data = { folders, projects, rootOrder };

  // Include global time tracking if present
  if (globalTimeTracking) {
    data.globalTimeTracking = globalTimeTracking;
  }
  const tempFile = `${projectsFile}.tmp`;
  const backupFile = `${projectsFile}.bak`;

  try {
    ensureDataDir();

    // Create backup before writing
    if (fs.existsSync(projectsFile)) {
      try { fs.copyFileSync(projectsFile, backupFile); } catch (_) {}
    }

    // Write to temporary file first
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));

    // Atomic rename (on most filesystems this is atomic)
    fs.renameSync(tempFile, projectsFile);

    // Remove backup on success
    try { if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile); } catch (_) {}
  } catch (error) {
    console.error('Failed to save projects:', error);

    // Restore from backup if save failed
    if (fs.existsSync(backupFile)) {
      try { fs.copyFileSync(backupFile, projectsFile); } catch (_) {}
    }

    // Cleanup temp file if it exists
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch (cleanupError) {
      // Ignore cleanup errors
    }

    // Try to notify user
    try {
      window.electron_api.notification.show({
        title: t('errors.saveError'),
        body: t('errors.saveErrorDetail', { message: error.message })
      });
    } catch (apiError) {
      // API not available
    }
  } finally {
    saveInProgress = false;

    // Process queued save
    if (pendingSave) {
      pendingSave = false;
      setTimeout(saveProjectsImmediate, 50);
    }
  }
}

/**
 * Create a new folder
 * @param {string} name
 * @param {string|null} parentId
 * @returns {Object}
 */
function createFolder(name, parentId = null) {
  const state = projectsState.get();
  const folder = {
    id: generateFolderId(),
    name,
    parentId,
    collapsed: false,
    children: []
  };

  const folders = [...state.folders, folder];
  let rootOrder = [...state.rootOrder];

  if (parentId === null) {
    rootOrder.unshift(folder.id);
  } else {
    const parent = folders.find(f => f.id === parentId);
    if (parent) {
      parent.children = [...(parent.children || []), folder.id];
    }
  }

  projectsState.set({ folders, rootOrder });
  saveProjects();
  return folder;
}

/**
 * Delete a folder
 * @param {string} folderId
 */
function deleteFolder(folderId) {
  const state = projectsState.get();
  const folder = state.folders.find(f => f.id === folderId);
  if (!folder) return;

  let folders = [...state.folders];
  let projects = [...state.projects];
  let rootOrder = [...state.rootOrder];

  // Move children folders to parent
  const childFolders = folders.filter(f => f.parentId === folderId);
  childFolders.forEach(child => {
    child.parentId = folder.parentId;
    if (folder.parentId === null) {
      rootOrder.push(child.id);
    } else {
      const newParent = folders.find(f => f.id === folder.parentId);
      if (newParent) {
        newParent.children = [...(newParent.children || []), child.id];
      }
    }
  });

  // Move projects to parent
  const childProjects = projects.filter(p => p.folderId === folderId);
  childProjects.forEach(project => {
    project.folderId = folder.parentId;
    if (folder.parentId === null) {
      rootOrder.push(project.id);
    } else {
      // Add project to new parent's children array
      const newParent = folders.find(f => f.id === folder.parentId);
      if (newParent) {
        newParent.children = [...(newParent.children || []), project.id];
      }
    }
  });

  // Remove from parent's children
  if (folder.parentId) {
    const parent = folders.find(f => f.id === folder.parentId);
    if (parent && parent.children) {
      parent.children = parent.children.filter(id => id !== folderId);
    }
  }

  // Remove from rootOrder
  rootOrder = rootOrder.filter(id => id !== folderId);

  // Remove folder
  folders = folders.filter(f => f.id !== folderId);

  projectsState.set({ folders, projects, rootOrder });
  saveProjects();
}

/**
 * Rename a folder
 * @param {string} folderId
 * @param {string} newName
 */
function renameFolder(folderId, newName) {
  const state = projectsState.get();
  const folders = state.folders.map(f =>
    f.id === folderId ? { ...f, name: newName } : f
  );
  projectsState.set({ folders });
  saveProjects();
}

/**
 * Rename a project
 * @param {string} projectId
 * @param {string} newName
 */
function renameProject(projectId, newName) {
  const state = projectsState.get();
  const projects = state.projects.map(p =>
    p.id === projectId ? { ...p, name: newName } : p
  );
  projectsState.set({ projects });
  saveProjects();
}

/**
 * Set folder color
 * @param {string} folderId
 * @param {string|null} color - Hex color or null to reset
 */
function setFolderColor(folderId, color) {
  const state = projectsState.get();
  const folders = state.folders.map(f =>
    f.id === folderId ? { ...f, color: color || undefined } : f
  );
  projectsState.set({ folders });
  saveProjects();
}

/**
 * Set project color
 * @param {string} projectId
 * @param {string|null} color - Hex color or null to reset
 */
function setProjectColor(projectId, color) {
  const state = projectsState.get();
  const projects = state.projects.map(p =>
    p.id === projectId ? { ...p, color: color || undefined } : p
  );
  projectsState.set({ projects });
  saveProjects();
}

/**
 * Set project icon
 * @param {string} projectId
 * @param {string|null} icon - Emoji icon or null to reset
 */
function setProjectIcon(projectId, icon) {
  const state = projectsState.get();
  const projects = state.projects.map(p =>
    p.id === projectId ? { ...p, icon: icon || undefined } : p
  );
  projectsState.set({ projects });
  saveProjects();
}

/**
 * Set folder icon
 * @param {string} folderId
 * @param {string|null} icon - Emoji icon or null to reset
 */
function setFolderIcon(folderId, icon) {
  const state = projectsState.get();
  const folders = state.folders.map(f =>
    f.id === folderId ? { ...f, icon: icon || undefined } : f
  );
  projectsState.set({ folders });
  saveProjects();
}

/**
 * Toggle folder collapsed state
 * @param {string} folderId
 */
function toggleFolderCollapse(folderId) {
  const state = projectsState.get();
  const folders = state.folders.map(f =>
    f.id === folderId ? { ...f, collapsed: !f.collapsed } : f
  );
  projectsState.set({ folders });
  saveProjects();
}

/**
 * Add a new project
 * @param {Object} projectData
 * @returns {Object}
 */
function addProject(projectData) {
  const state = projectsState.get();
  const project = {
    id: generateProjectId(),
    type: 'standalone',
    folderId: null,
    ...projectData
  };

  const projects = [...state.projects, project];
  const rootOrder = [...state.rootOrder, project.id];

  projectsState.set({ projects, rootOrder });
  saveProjects();
  return project;
}

/**
 * Update a project
 * @param {string} projectId
 * @param {Object} updates
 */
function updateProject(projectId, updates) {
  const state = projectsState.get();
  const projects = state.projects.map(p =>
    p.id === projectId ? { ...p, ...updates } : p
  );
  projectsState.set({ projects });
  saveProjects();
}

/**
 * Delete a project
 * @param {string} projectId
 */
function deleteProject(projectId) {
  const state = projectsState.get();
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return;

  let rootOrder = [...state.rootOrder];
  let folders = [...state.folders];

  if (project.folderId === null) {
    rootOrder = rootOrder.filter(id => id !== projectId);
  } else {
    // Remove from parent's children array
    const parent = folders.find(f => f.id === project.folderId);
    if (parent && parent.children) {
      parent.children = parent.children.filter(id => id !== projectId);
    }
  }

  const projects = state.projects.filter(p => p.id !== projectId);
  projectsState.set({ projects, folders, rootOrder });
  saveProjects();
}

/**
 * Move item to folder
 * @param {string} itemType - 'folder' or 'project'
 * @param {string} itemId
 * @param {string|null} targetFolderId
 */
function moveItemToFolder(itemType, itemId, targetFolderId) {
  const state = projectsState.get();
  let folders = [...state.folders];
  let projects = [...state.projects];
  let rootOrder = [...state.rootOrder];

  if (itemType === 'folder') {
    const folder = folders.find(f => f.id === itemId);
    if (!folder) return;

    // Prevent moving into itself or descendants
    if (targetFolderId === itemId || isDescendantOf(targetFolderId, itemId)) return;

    // Remove from old parent
    if (folder.parentId === null) {
      rootOrder = rootOrder.filter(id => id !== itemId);
    } else {
      const oldParent = folders.find(f => f.id === folder.parentId);
      if (oldParent && oldParent.children) {
        oldParent.children = oldParent.children.filter(id => id !== itemId);
      }
    }

    // Add to new parent
    folder.parentId = targetFolderId;
    if (targetFolderId === null) {
      rootOrder.push(itemId);
    } else {
      const newParent = folders.find(f => f.id === targetFolderId);
      if (newParent) {
        newParent.children = [...(newParent.children || []), itemId];
        newParent.collapsed = false;
      }
    }
  } else if (itemType === 'project') {
    const project = projects.find(p => p.id === itemId);
    if (!project) return;

    const oldFolderId = project.folderId;

    // Remove from old location
    if (oldFolderId === null) {
      rootOrder = rootOrder.filter(id => id !== itemId);
    } else {
      // Remove from old parent's children
      const oldParent = folders.find(f => f.id === oldFolderId);
      if (oldParent && oldParent.children) {
        oldParent.children = oldParent.children.filter(id => id !== itemId);
      }
    }

    // Add to new location
    project.folderId = targetFolderId;
    if (targetFolderId === null) {
      rootOrder.push(itemId);
    } else {
      const newParent = folders.find(f => f.id === targetFolderId);
      if (newParent) {
        newParent.children = [...(newParent.children || []), itemId];
        newParent.collapsed = false;
      }
    }
  }

  projectsState.set({ folders, projects, rootOrder });
  saveProjects();
}

/**
 * Reorder item relative to another item
 * @param {string} itemType - 'folder' or 'project'
 * @param {string} itemId - Item being moved
 * @param {string} targetId - Item to position relative to
 * @param {string} position - 'before' or 'after'
 */
function reorderItem(itemType, itemId, targetId, position) {
  const state = projectsState.get();
  let folders = [...state.folders];
  let projects = [...state.projects];
  let rootOrder = [...state.rootOrder];

  // Get target item info
  const targetFolder = folders.find(f => f.id === targetId);
  const targetProject = projects.find(p => p.id === targetId);
  const targetParentId = targetFolder ? targetFolder.parentId : (targetProject ? targetProject.folderId : null);

  // Get source item
  const sourceFolder = itemType === 'folder' ? folders.find(f => f.id === itemId) : null;
  const sourceProject = itemType === 'project' ? projects.find(p => p.id === itemId) : null;

  if (!sourceFolder && !sourceProject) return;
  if (!targetFolder && !targetProject) return;

  // Prevent folder from being moved into its descendants
  if (sourceFolder && targetFolder && isDescendantOf(targetId, itemId)) return;

  const sourceParentId = sourceFolder ? sourceFolder.parentId : (sourceProject ? sourceProject.folderId : null);

  // Remove from old location
  if (sourceParentId === null) {
    rootOrder = rootOrder.filter(id => id !== itemId);
  } else {
    const oldParent = folders.find(f => f.id === sourceParentId);
    if (oldParent && oldParent.children) {
      oldParent.children = oldParent.children.filter(id => id !== itemId);
    }
  }

  // Update parent reference
  if (sourceFolder) {
    sourceFolder.parentId = targetParentId;
  } else if (sourceProject) {
    sourceProject.folderId = targetParentId;
  }

  // Insert at new position
  if (targetParentId === null) {
    // Target is at root level
    const targetIndex = rootOrder.indexOf(targetId);
    const insertIndex = position === 'before' ? targetIndex : targetIndex + 1;
    rootOrder.splice(insertIndex, 0, itemId);
  } else {
    // Target is inside a folder - children contains both folders and projects
    const parentFolder = folders.find(f => f.id === targetParentId);
    if (parentFolder) {
      parentFolder.children = parentFolder.children || [];
      let targetIndex = parentFolder.children.indexOf(targetId);
      // If target not in children (legacy data), find position based on item order
      if (targetIndex === -1) {
        // Add target to children if it belongs to this folder
        if ((targetFolder && targetFolder.parentId === targetParentId) ||
            (targetProject && targetProject.folderId === targetParentId)) {
          parentFolder.children.push(targetId);
          targetIndex = parentFolder.children.length - 1;
        } else {
          targetIndex = parentFolder.children.length;
        }
      }
      const insertIndex = position === 'before' ? targetIndex : targetIndex + 1;
      parentFolder.children.splice(insertIndex, 0, itemId);
      parentFolder.collapsed = false;
    }
  }

  projectsState.set({ folders, projects, rootOrder });
  saveProjects();
}

/**
 * Set selected project filter
 * @param {number|null} projectIndex
 */
function setSelectedProjectFilter(projectIndex) {
  projectsState.setProp('selectedProjectFilter', projectIndex);
}

/**
 * Set opened project ID
 * @param {string|null} projectId
 */
function setOpenedProjectId(projectId) {
  projectsState.setProp('openedProjectId', projectId);
}

/**
 * Get quick actions for a project
 * @param {string} projectId
 * @returns {Array}
 */
function getQuickActions(projectId) {
  const project = getProject(projectId);
  return project?.quickActions || [];
}

/**
 * Set quick actions for a project
 * @param {string} projectId
 * @param {Array} actions - Array of { id, name, command, icon }
 */
function setQuickActions(projectId, actions) {
  const state = projectsState.get();
  const projects = state.projects.map(p =>
    p.id === projectId ? { ...p, quickActions: actions } : p
  );
  projectsState.set({ projects });
  saveProjects();
}

/**
 * Add a quick action to a project
 * @param {string} projectId
 * @param {Object} action - { name, command, icon }
 * @returns {Object} The created action with id
 */
function addQuickAction(projectId, action) {
  const actions = getQuickActions(projectId);
  const newAction = {
    id: `qa-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    ...action
  };
  setQuickActions(projectId, [...actions, newAction]);
  return newAction;
}

/**
 * Update a quick action
 * @param {string} projectId
 * @param {string} actionId
 * @param {Object} updates
 */
function updateQuickAction(projectId, actionId, updates) {
  const actions = getQuickActions(projectId);
  const updatedActions = actions.map(a =>
    a.id === actionId ? { ...a, ...updates } : a
  );
  setQuickActions(projectId, updatedActions);
}

/**
 * Delete a quick action
 * @param {string} projectId
 * @param {string} actionId
 */
function deleteQuickAction(projectId, actionId) {
  const actions = getQuickActions(projectId);
  setQuickActions(projectId, actions.filter(a => a.id !== actionId));
}

/**
 * Reorder quick actions
 * @param {string} projectId
 * @param {number} fromIndex
 * @param {number} toIndex
 */
function reorderQuickActions(projectId, fromIndex, toIndex) {
  const actions = [...getQuickActions(projectId)];
  const [removed] = actions.splice(fromIndex, 1);
  actions.splice(toIndex, 0, removed);
  setQuickActions(projectId, actions);
}

/**
 * Set preferred editor for a project
 * @param {string} projectId
 * @param {string|null} editor - 'code' | 'cursor' | 'webstorm' | 'idea' | null (global default)
 */
function setProjectEditor(projectId, editor) {
  const state = projectsState.get();
  const projects = state.projects.map(p =>
    p.id === projectId ? { ...p, preferredEditor: editor || undefined } : p
  );
  projectsState.set({ projects });
  saveProjects();
}

/**
 * Get preferred editor for a project
 * @param {string} projectId
 * @returns {string|null} - Editor key or null if using global default
 */
function getProjectEditor(projectId) {
  const project = getProject(projectId);
  return project?.preferredEditor || null;
}

/**
 * Get projects in visual display order (flattened from rootOrder + folder children)
 * @returns {Array<Object>} - Projects in the order they appear in the sidebar
 */
function getVisualProjectOrder() {
  const state = projectsState.get();
  const result = [];

  function collectFromItems(itemIds) {
    for (const itemId of itemIds) {
      const folder = state.folders.find(f => f.id === itemId);
      if (folder) {
        collectFromItems(folder.children || []);
        // Also collect legacy projects not in children array
        state.projects.forEach(p => {
          if (p.folderId === folder.id && !(folder.children || []).includes(p.id)) {
            result.push(p);
          }
        });
      } else {
        const project = state.projects.find(p => p.id === itemId);
        if (project) result.push(project);
      }
    }
  }

  collectFromItems(state.rootOrder || []);
  return result;
}

module.exports = {
  projectsState,
  generateFolderId,
  generateProjectId,
  getFolder,
  getProject,
  getProjectIndex,
  getChildFolders,
  getProjectsInFolder,
  countProjectsRecursive,
  isDescendantOf,
  loadProjects,
  saveProjects,
  saveProjectsImmediate,
  createFolder,
  deleteFolder,
  renameFolder,
  renameProject,
  setFolderColor,
  setProjectColor,
  setProjectIcon,
  setFolderIcon,
  toggleFolderCollapse,
  addProject,
  updateProject,
  deleteProject,
  moveItemToFolder,
  reorderItem,
  setSelectedProjectFilter,
  setOpenedProjectId,
  // Quick Actions
  getQuickActions,
  setQuickActions,
  addQuickAction,
  updateQuickAction,
  deleteQuickAction,
  reorderQuickActions,
  // Editor per project
  setProjectEditor,
  getProjectEditor,
  // Visual order
  getVisualProjectOrder
};
