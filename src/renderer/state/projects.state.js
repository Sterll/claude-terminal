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

// Index Maps for O(1) lookups (invalidated on state changes)
let _projectIndex = null; // Map<id, project>
let _folderIndex = null;  // Map<id, folder>
let _countCache = null;   // Map<folderId, count>

function _invalidateIndexes() {
  _projectIndex = null;
  _folderIndex = null;
  _countCache = null;
}

function _getProjectIndex() {
  if (!_projectIndex) {
    _projectIndex = new Map();
    for (const p of projectsState.get().projects) {
      _projectIndex.set(p.id, p);
    }
  }
  return _projectIndex;
}

function _getFolderIndex() {
  if (!_folderIndex) {
    _folderIndex = new Map();
    for (const f of projectsState.get().folders) {
      _folderIndex.set(f.id, f);
    }
  }
  return _folderIndex;
}

// Intercept set/setProp to invalidate indexes synchronously
const _origSet = projectsState.set.bind(projectsState);
const _origSetProp = projectsState.setProp.bind(projectsState);
projectsState.set = function(updates) { _invalidateIndexes(); _origSet(updates); };
projectsState.setProp = function(key, value) { _invalidateIndexes(); _origSetProp(key, value); };

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
 * Generate unique task ID
 * @returns {string}
 */
function generateTaskId() {
  return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Generate unique column ID
 * @returns {string}
 */
function generateColumnId() {
  return `col-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Generate unique label ID
 * @returns {string}
 */
function generateLabelId() {
  return `lbl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

const DEFAULT_COLUMNS = [
  { id: 'col-todo',       title: 'To Do',       color: '#3b82f6', order: 0 },
  { id: 'col-inprogress', title: 'In Progress',  color: '#f59e0b', order: 1 },
  { id: 'col-done',       title: 'Done',         color: '#22c55e', order: 2 },
];

/**
 * Get folder by ID
 * @param {string} folderId
 * @returns {Object|undefined}
 */
function getFolder(folderId) {
  return _getFolderIndex().get(folderId);
}

/**
 * Get project by ID
 * @param {string} projectId
 * @returns {Object|undefined}
 */
function getProject(projectId) {
  return _getProjectIndex().get(projectId);
}

/**
 * Get project index by ID
 * @param {string} projectId
 * @returns {number}
 */
function getProjectIndex(projectId) {
  const projects = projectsState.get().projects;
  // Use index map for quick existence check, then find position
  if (!_getProjectIndex().has(projectId)) return -1;
  return projects.findIndex(p => p.id === projectId);
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
  if (!_countCache) _countCache = new Map();
  if (_countCache.has(folderId)) return _countCache.get(folderId);
  let count = getProjectsInFolder(folderId).length;
  getChildFolders(folderId).forEach(child => {
    count += countProjectsRecursive(child.id);
  });
  _countCache.set(folderId, count);
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
async function loadProjects() {
  try {
    ensureDataDir();

    if (fs.existsSync(projectsFile)) {
      const rawContent = await fs.promises.readFile(projectsFile, 'utf8');

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
      let projects, folders, rootOrder;

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
          return project;
        });
        folders = data.folders || [];
        rootOrder = data.rootOrder || [];

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

      projectsState.set({ projects, folders, rootOrder });

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
let saveRetryCount = 0;
const MAX_SAVE_RETRIES = 3;

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

  const { folders, projects, rootOrder } = projectsState.get();
  const data = { folders, projects, rootOrder };
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
      try {
        fs.copyFileSync(backupFile, projectsFile);
      } catch (backupErr) {
        console.warn('[Projects] Backup file locked or inaccessible, retrying in 100ms:', backupErr.code || backupErr.message);
        // Retry once after a short delay (Windows file lock may be transient)
        setTimeout(() => {
          try {
            if (fs.existsSync(backupFile)) {
              fs.copyFileSync(backupFile, projectsFile);
            }
          } catch (retryErr) {
            console.warn('[Projects] Backup restore failed after retry, data may need manual recovery:', retryErr.code || retryErr.message);
          }
        }, 100);
      }
    }

    // Cleanup temp file if it exists
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch (_) {}

    saveInProgress = false;

    // Retry with exponential backoff (max 3 attempts)
    if (saveRetryCount < MAX_SAVE_RETRIES) {
      saveRetryCount++;
      const delay = 200 * Math.pow(2, saveRetryCount - 1); // 200ms, 400ms, 800ms
      console.warn(`Retrying save (attempt ${saveRetryCount}/${MAX_SAVE_RETRIES}) in ${delay}ms`);
      setTimeout(saveProjectsImmediate, delay);
      return;
    }

    // All retries exhausted — notify user
    saveRetryCount = 0;
    try {
      window.electron_api.notification.show({
        title: t('errors.saveError'),
        body: t('errors.saveErrorDetail', { message: error.message })
      });
    } catch (_) {}

    // Still process any pending save
    if (pendingSave) { pendingSave = false; setTimeout(saveProjectsImmediate, 50); }
    return;
  }

  saveInProgress = false;
  saveRetryCount = 0;

  // Process queued save
  if (pendingSave) {
    pendingSave = false;
    setTimeout(saveProjectsImmediate, 50);
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

  // Deep-clone to avoid mutating existing state references
  let folders = JSON.parse(JSON.stringify(state.folders));
  let projects = JSON.parse(JSON.stringify(state.projects));
  let rootOrder = [...state.rootOrder];

  // Re-find folder in cloned array
  const clonedFolder = folders.find(f => f.id === folderId);

  // Move children folders to parent
  const childFolders = folders.filter(f => f.parentId === folderId);
  childFolders.forEach(child => {
    child.parentId = clonedFolder.parentId;
    if (clonedFolder.parentId === null) {
      rootOrder.push(child.id);
    } else {
      const newParent = folders.find(f => f.id === clonedFolder.parentId);
      if (newParent) {
        newParent.children = [...(newParent.children || []), child.id];
      }
    }
  });

  // Move projects to parent
  const childProjects = projects.filter(p => p.folderId === folderId);
  childProjects.forEach(project => {
    project.folderId = clonedFolder.parentId;
    if (clonedFolder.parentId === null) {
      rootOrder.push(project.id);
    } else {
      // Add project to new parent's children array
      const newParent = folders.find(f => f.id === clonedFolder.parentId);
      if (newParent) {
        newParent.children = [...(newParent.children || []), project.id];
      }
    }
  });

  // Remove from parent's children
  if (clonedFolder.parentId) {
    const parent = folders.find(f => f.id === clonedFolder.parentId);
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
  // Deep-clone to avoid mutating existing state references
  let folders = JSON.parse(JSON.stringify(state.folders));
  let projects = JSON.parse(JSON.stringify(state.projects));
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

// ── Tasks ──

/**
 * Get tasks for a project
 * @param {string} projectId
 * @returns {Array}
 */
function getTasks(projectId) {
  const project = getProject(projectId);
  return project?.tasks || [];
}

/**
 * Get kanban columns for a project (initialises defaults if none exist)
 * @param {string} projectId
 * @returns {Array}
 */
function getKanbanColumns(projectId) {
  const project = getProject(projectId);
  if (!project) return [...DEFAULT_COLUMNS];
  if (!project.kanbanColumns || project.kanbanColumns.length === 0) {
    updateProject(projectId, { kanbanColumns: [...DEFAULT_COLUMNS] });
    return [...DEFAULT_COLUMNS];
  }
  return [...project.kanbanColumns].sort((a, b) => a.order - b.order);
}

/**
 * Add a task to a project
 * @param {string} projectId
 * @param {{ title: string, description?: string, labels?: string[], columnId?: string, sessionId?: string, order?: number }} taskData
 * @returns {Object|null}
 */
function addTask(projectId, taskData) {
  if (!getProject(projectId)) return null;
  const columns = getKanbanColumns(projectId);
  const defaultColumn = columns[0];
  const colId = taskData.columnId || defaultColumn?.id || 'col-todo';
  const now = Date.now();
  const task = {
    id: generateTaskId(),
    title: taskData.title,
    description: taskData.description || '',
    labels: taskData.labels || [],
    columnId: colId,
    worktreePath: taskData.worktreePath || null,
    sessionIds: taskData.sessionIds || [],
    order: taskData.order ?? getTasks(projectId).filter(t => t.columnId === colId).length,
    createdAt: now,
    updatedAt: now,
  };
  const tasks = [...getTasks(projectId), task];
  updateProject(projectId, { tasks });
  return task;
}

/**
 * Update a task
 * @param {string} projectId
 * @param {string} taskId
 * @param {Object} updates
 */
function updateTask(projectId, taskId, updates) {
  const tasks = getTasks(projectId);
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  const updatedTasks = tasks.map(t =>
    t.id === taskId ? { ...t, ...updates, updatedAt: Date.now() } : t
  );
  updateProject(projectId, { tasks: updatedTasks });
}

/**
 * Delete a task
 * @param {string} projectId
 * @param {string} taskId
 */
function deleteTask(projectId, taskId) {
  const tasks = getTasks(projectId).filter(t => t.id !== taskId);
  updateProject(projectId, { tasks });
}

/**
 * Move a task to a different column and/or position
 * @param {string} projectId
 * @param {string} taskId
 * @param {string} targetColumnId
 * @param {number} targetOrder
 */
function moveTask(projectId, taskId, targetColumnId, targetOrder) {
  const tasks = getTasks(projectId);
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;

  // Validate target column exists
  const columns = getKanbanColumns(projectId);
  if (!columns.find(c => c.id === targetColumnId)) return;

  const sourceCol = task.columnId;
  const now = Date.now();

  let updated;
  if (sourceCol === targetColumnId) {
    // Same-column reorder
    const from = task.order;
    const to = targetOrder;
    updated = tasks.map(t => {
      if (t.columnId !== sourceCol) return t;
      if (t.id === taskId) return { ...t, order: to, updatedAt: now };
      if (from < to) {
        // Moving down: shift items in (from, to] up by -1
        if (t.order > from && t.order <= to) return { ...t, order: t.order - 1 };
      } else {
        // Moving up: shift items in [to, from) down by +1
        if (t.order >= to && t.order < from) return { ...t, order: t.order + 1 };
      }
      return t;
    });
  } else {
    // Cross-column move
    updated = tasks.map(t => {
      if (t.id === taskId) return { ...t, columnId: targetColumnId, order: targetOrder, updatedAt: now };
      if (t.columnId === sourceCol && t.order > task.order) return { ...t, order: t.order - 1 };
      if (t.columnId === targetColumnId && t.order >= targetOrder) return { ...t, order: t.order + 1 };
      return t;
    });
  }

  updateProject(projectId, { tasks: updated });
}

/**
 * Add a new kanban column to a project
 * @param {string} projectId
 * @param {{ title: string, color?: string }} param1
 * @returns {Object}
 */
function addKanbanColumn(projectId, { title, color = '#888' }) {
  const columns = getKanbanColumns(projectId);
  const col = { id: generateColumnId(), title, color, order: columns.length > 0 ? Math.max(...columns.map(c => c.order)) + 1 : 0 };
  updateProject(projectId, { kanbanColumns: [...columns, col] });
  return col;
}

/**
 * Update a kanban column
 * @param {string} projectId
 * @param {string} columnId
 * @param {Object} updates
 */
function updateKanbanColumn(projectId, columnId, updates) {
  const columns = getKanbanColumns(projectId);
  const updated = columns.map(c => c.id === columnId ? { ...c, ...updates } : c);
  updateProject(projectId, { kanbanColumns: updated });
}

/**
 * Delete a kanban column (only if it has no tasks)
 * @param {string} projectId
 * @param {string} columnId
 * @returns {boolean} - true if deleted, false if column has tasks
 */
function deleteKanbanColumn(projectId, columnId) {
  const tasks = getTasks(projectId);
  const hasTasks = tasks.some(t => t.columnId === columnId);
  if (hasTasks) return false;
  const columns = getKanbanColumns(projectId).filter(c => c.id !== columnId);
  const reordered = columns.map((c, i) => ({ ...c, order: i }));
  updateProject(projectId, { kanbanColumns: reordered });
  return true;
}

/**
 * Reorder kanban columns by moving a column from one position to another
 * @param {string} projectId
 * @param {string} columnId - ID of column being moved
 * @param {number} newOrder - target order index (0-based)
 */
function reorderKanbanColumns(projectId, columnId, newOrder) {
  const columns = getKanbanColumns(projectId); // already sorted by order
  const fromIndex = columns.findIndex(c => c.id === columnId);
  if (fromIndex === -1) return;
  const reordered = [...columns];
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(newOrder, 0, moved);
  const withOrder = reordered.map((c, i) => ({ ...c, order: i }));
  updateProject(projectId, { kanbanColumns: withOrder });
}

/**
 * Get kanban labels for a project
 * @param {string} projectId
 * @returns {Array}
 */
function getKanbanLabels(projectId) {
  const project = getProject(projectId);
  return project?.kanbanLabels || [];
}

/**
 * Add a kanban label to a project
 * @param {string} projectId
 * @param {{ name: string, color: string }} param1
 * @returns {Object}
 */
function addKanbanLabel(projectId, { name, color }) {
  const labels = getKanbanLabels(projectId);
  const label = { id: generateLabelId(), name, color };
  updateProject(projectId, { kanbanLabels: [...labels, label] });
  return label;
}

/**
 * Update a kanban label
 * @param {string} projectId
 * @param {string} labelId
 * @param {Object} updates
 */
function updateKanbanLabel(projectId, labelId, updates) {
  const labels = getKanbanLabels(projectId).map(l => l.id === labelId ? { ...l, ...updates } : l);
  updateProject(projectId, { kanbanLabels: labels });
}

/**
 * Delete a kanban label and remove it from all tasks
 * @param {string} projectId
 * @param {string} labelId
 */
function deleteKanbanLabel(projectId, labelId) {
  const labels = getKanbanLabels(projectId).filter(l => l.id !== labelId);
  const tasks = getTasks(projectId).map(t => ({
    ...t,
    labels: (t.labels || []).filter(id => id !== labelId)
  }));
  updateProject(projectId, { kanbanLabels: labels, tasks });
}

/**
 * Migrate legacy tasks (with status field) to the kanban model
 * @param {string} projectId
 */
function migrateTasksToKanban(projectId) {
  const project = getProject(projectId);
  if (!project) return;
  if (project.kanbanColumns && project.kanbanColumns.length > 0) return;
  const statusToColumnId = {
    'todo': 'col-todo',
    'in_progress': 'col-inprogress',
    'done': 'col-done',
  };
  const colCounters = {};
  const tasks = (project.tasks || []).map(t => {
    const colId = statusToColumnId[t.status] || 'col-todo';
    if (colCounters[colId] === undefined) colCounters[colId] = 0;
    const order = colCounters[colId]++;
    // Migrate sessionId (singular) → sessionIds (plural)
    const sessionIds = t.sessionIds ?? (t.sessionId ? [t.sessionId] : []);
    const { sessionId: _removed, ...rest } = t;
    return { ...rest, columnId: colId, description: t.description || '', labels: t.labels || [], worktreePath: t.worktreePath || null, sessionIds, order };
  });
  updateProject(projectId, { kanbanColumns: [...DEFAULT_COLUMNS], kanbanLabels: [], tasks });
}

/**
 * Normalize kanban task fields for any project (runs even if migration already done).
 * Migrates sessionId → sessionIds and ensures worktreePath exists.
 * @param {string} projectId
 */
function normalizeKanbanTaskFields(projectId) {
  const project = getProject(projectId);
  if (!project) return;
  const tasks = project.tasks || [];
  const needsNorm = tasks.some(t => t.sessionId !== undefined || t.sessionIds === undefined || t.worktreePath === undefined);
  if (!needsNorm) return;
  const normalized = tasks.map(t => {
    const sessionIds = t.sessionIds ?? (t.sessionId ? [t.sessionId] : []);
    const { sessionId: _removed, ...rest } = t;
    return { ...rest, sessionIds, worktreePath: rest.worktreePath ?? null };
  });
  updateProject(projectId, { tasks: normalized });
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
  // Tasks
  generateTaskId,
  getTasks,
  addTask,
  updateTask,
  deleteTask,
  // Kanban
  generateColumnId,
  generateLabelId,
  getKanbanColumns,
  addKanbanColumn,
  updateKanbanColumn,
  deleteKanbanColumn,
  reorderKanbanColumns,
  getKanbanLabels,
  addKanbanLabel,
  updateKanbanLabel,
  deleteKanbanLabel,
  moveTask,
  migrateTasksToKanban,
  normalizeKanbanTaskFields,
  // Visual order
  getVisualProjectOrder
};
