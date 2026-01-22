/**
 * Projects State Module
 * Manages projects and folders state
 */

const fs = require('fs');
const { State } = require('./State');
const { projectsFile } = require('../utils/paths');

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
 * Load projects from file
 */
function loadProjects() {
  try {
    if (fs.existsSync(projectsFile)) {
      const data = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
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
      }

      projectsState.set({ projects, folders, rootOrder });

      if (needsSave) {
        saveProjects();
      }
    }
  } catch (e) {
    console.error('Error loading projects:', e);
    projectsState.set({ projects: [], folders: [], rootOrder: [] });
  }
}

/**
 * Save projects to file
 */
function saveProjects() {
  const { folders, projects, rootOrder } = projectsState.get();
  const data = { folders, projects, rootOrder };
  fs.writeFileSync(projectsFile, JSON.stringify(data, null, 2));
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

  let rootOrder = state.rootOrder;
  if (project.folderId === null) {
    rootOrder = rootOrder.filter(id => id !== projectId);
  }

  const projects = state.projects.filter(p => p.id !== projectId);
  projectsState.set({ projects, rootOrder });
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

    // Remove from rootOrder if was at root
    if (project.folderId === null) {
      rootOrder = rootOrder.filter(id => id !== itemId);
    }

    // Add to new location
    project.folderId = targetFolderId;
    if (targetFolderId === null) {
      rootOrder.push(itemId);
    } else {
      const newParent = folders.find(f => f.id === targetFolderId);
      if (newParent) {
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
    // Target is inside a folder
    const parentFolder = folders.find(f => f.id === targetParentId);
    if (parentFolder) {
      parentFolder.children = parentFolder.children || [];
      const targetIndex = parentFolder.children.indexOf(targetId);
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
  createFolder,
  deleteFolder,
  renameFolder,
  renameProject,
  setFolderColor,
  setProjectColor,
  toggleFolderCollapse,
  addProject,
  updateProject,
  deleteProject,
  moveItemToFolder,
  reorderItem,
  setSelectedProjectFilter,
  setOpenedProjectId
};
