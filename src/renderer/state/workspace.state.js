/**
 * Workspace State Module
 * Manages workspaces, knowledge base docs, and concept links
 */

const { fs, path } = window.electron_nodeModules;
const { fileExists, atomicWriteJSON, atomicWrite, safeReadJSON } = require('../utils/fs-async');
const fsp = require('../utils/fs-async').fsp;
const { State } = require('./State');
const { workspacesFile, workspacesDir } = require('../utils/paths');

// Initial state
const initialState = {
  workspaces: [],
  activeWorkspaceId: null,
  docs: [],           // Docs of the active workspace (loaded on demand)
  links: [],          // Links of the active workspace
  editingDocId: null
};

const workspaceState = new State(initialState);

// Index Maps for O(1) lookups
let _workspaceIndex = null; // Map<id, workspace>
let _docIndex = null;       // Map<id, doc>

function _invalidateIndexes() {
  _workspaceIndex = null;
  _docIndex = null;
}

function _getWorkspaceIndex() {
  if (!_workspaceIndex) {
    _workspaceIndex = new Map();
    for (const w of workspaceState.get().workspaces) {
      _workspaceIndex.set(w.id, w);
    }
  }
  return _workspaceIndex;
}

function _getDocIndex() {
  if (!_docIndex) {
    _docIndex = new Map();
    for (const d of workspaceState.get().docs) {
      _docIndex.set(d.id, d);
    }
  }
  return _docIndex;
}

// Intercept set/setProp to invalidate indexes
const _origSet = workspaceState.set.bind(workspaceState);
const _origSetProp = workspaceState.setProp.bind(workspaceState);
workspaceState.set = function(updates) { _invalidateIndexes(); _origSet(updates); };
workspaceState.setProp = function(key, value) { _invalidateIndexes(); _origSetProp(key, value); };

// --- ID Generators ---

function generateWorkspaceId() {
  return `ws-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function generateDocId() {
  return `doc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function generateLinkId() {
  return `link-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// --- Getters ---

function getWorkspace(id) {
  return _getWorkspaceIndex().get(id);
}

function getDoc(id) {
  return _getDocIndex().get(id);
}

function getWorkspacesForProject(projectId) {
  return workspaceState.get().workspaces.filter(w => w.projectIds && w.projectIds.includes(projectId));
}

// --- Persistence (debounced, atomic) ---

let saveDebounceTimer = null;
const SAVE_DEBOUNCE_MS = 500;
let saveInProgress = false;
let pendingSave = false;
let saveRetryCount = 0;
const MAX_SAVE_RETRIES = 3;

function saveWorkspaces() {
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    if (saveInProgress) { pendingSave = true; return; }
    saveWorkspacesImmediate();
  }, SAVE_DEBOUNCE_MS);
}

async function saveWorkspacesImmediate() {
  if (saveInProgress) { pendingSave = true; return; }
  saveInProgress = true;

  const { workspaces } = workspaceState.get();
  try {
    await atomicWriteJSON(workspacesFile, { workspaces });
  } catch (error) {
    console.error('Failed to save workspaces:', error);
    saveInProgress = false;

    if (saveRetryCount < MAX_SAVE_RETRIES) {
      saveRetryCount++;
      const delay = 200 * Math.pow(2, saveRetryCount - 1);
      setTimeout(saveWorkspacesImmediate, delay);
      return;
    }

    saveRetryCount = 0;
    try {
      window.electron_api.notification.show({
        title: 'Save Error',
        body: `Failed to save workspaces: ${error.message}`
      });
    } catch (_) {}

    if (pendingSave) { pendingSave = false; setTimeout(saveWorkspacesImmediate, 50); }
    return;
  }

  saveInProgress = false;
  saveRetryCount = 0;
  if (pendingSave) { pendingSave = false; setTimeout(saveWorkspacesImmediate, 50); }
}

// --- Load ---

async function loadWorkspaces() {
  try {
    await fsp.mkdir(workspacesDir, { recursive: true });

    if (await fileExists(workspacesFile)) {
      const data = await safeReadJSON(workspacesFile);
      if (data && Array.isArray(data.workspaces)) {
        workspaceState.set({ workspaces: data.workspaces });
      } else {
        workspaceState.set({ workspaces: [] });
      }
    }
  } catch (e) {
    console.error('Error loading workspaces:', e);
    workspaceState.set({ workspaces: [] });
  }
}

// --- Workspace CRUD ---

async function addWorkspace({ name, description = '', icon = '', color = '' }) {
  const id = generateWorkspaceId();
  const now = Date.now();
  const workspace = {
    id, name, description, icon, color,
    projectIds: [],
    createdAt: now,
    updatedAt: now
  };

  // Create workspace directory structure
  const wsDir = path.join(workspacesDir, id);
  const docsDir = path.join(wsDir, 'docs');
  await fsp.mkdir(docsDir, { recursive: true });

  // Create initial docs-index.json and links.json
  const readmeId = generateDocId();
  const docsIndex = {
    docs: [{
      id: readmeId,
      title: 'README',
      filename: 'README.md',
      tags: [],
      summary: '',
      createdAt: now,
      updatedAt: now
    }]
  };
  await atomicWriteJSON(path.join(wsDir, 'docs-index.json'), docsIndex);
  await atomicWriteJSON(path.join(wsDir, 'links.json'), { links: [] });
  await atomicWrite(path.join(docsDir, 'README.md'), `# ${name}\n\n${description || 'Workspace knowledge base.'}\n`);

  const workspaces = [...workspaceState.get().workspaces, workspace];
  workspaceState.set({ workspaces });
  saveWorkspaces();
  return workspace;
}

function updateWorkspace(id, updates) {
  const workspaces = workspaceState.get().workspaces.map(w => {
    if (w.id !== id) return w;
    return { ...w, ...updates, updatedAt: Date.now() };
  });
  workspaceState.set({ workspaces });
  saveWorkspaces();
}

async function deleteWorkspace(id) {
  const workspaces = workspaceState.get().workspaces.filter(w => w.id !== id);
  workspaceState.set({ workspaces });

  // Clear active if it was this workspace
  if (workspaceState.get().activeWorkspaceId === id) {
    workspaceState.set({ activeWorkspaceId: null, docs: [], links: [], editingDocId: null });
  }

  // Remove workspace directory
  const wsDir = path.join(workspacesDir, id);
  try {
    await fsp.rm(wsDir, { recursive: true, force: true });
  } catch (e) {
    console.error('Failed to delete workspace directory:', e);
  }

  saveWorkspaces();
}

// --- Project Association ---

function addProjectToWorkspace(workspaceId, projectId) {
  const workspaces = workspaceState.get().workspaces.map(w => {
    if (w.id !== workspaceId) return w;
    if (w.projectIds.includes(projectId)) return w;
    return { ...w, projectIds: [...w.projectIds, projectId], updatedAt: Date.now() };
  });
  workspaceState.set({ workspaces });
  saveWorkspaces();
}

function removeProjectFromWorkspace(workspaceId, projectId) {
  const workspaces = workspaceState.get().workspaces.map(w => {
    if (w.id !== workspaceId) return w;
    return { ...w, projectIds: w.projectIds.filter(id => id !== projectId), updatedAt: Date.now() };
  });
  workspaceState.set({ workspaces });
  saveWorkspaces();
}

// --- Active Workspace (loads docs/links on demand) ---

async function setActiveWorkspace(id) {
  workspaceState.set({ activeWorkspaceId: id, editingDocId: null });
  if (id) {
    await loadWorkspaceDocs(id);
    await loadWorkspaceLinks(id);
  } else {
    workspaceState.set({ docs: [], links: [] });
  }
}

async function loadWorkspaceDocs(workspaceId) {
  const indexPath = path.join(workspacesDir, workspaceId, 'docs-index.json');
  try {
    const data = await safeReadJSON(indexPath);
    workspaceState.set({ docs: (data && data.docs) || [] });
  } catch {
    workspaceState.set({ docs: [] });
  }
}

async function loadWorkspaceLinks(workspaceId) {
  const linksPath = path.join(workspacesDir, workspaceId, 'links.json');
  try {
    const data = await safeReadJSON(linksPath);
    workspaceState.set({ links: (data && data.links) || [] });
  } catch {
    workspaceState.set({ links: [] });
  }
}

// --- Docs CRUD ---

async function saveDocsIndex(workspaceId, docs) {
  const indexPath = path.join(workspacesDir, workspaceId, 'docs-index.json');
  await atomicWriteJSON(indexPath, { docs });
}

function sanitizeFilename(title) {
  return title
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .substring(0, 100);
}

async function addDoc(workspaceId, { title, content = '', tags = [] }) {
  const id = generateDocId();
  const now = Date.now();
  const filename = sanitizeFilename(title) + '.md';
  const doc = { id, title, filename, tags, summary: content.substring(0, 200), createdAt: now, updatedAt: now };

  const docs = [...workspaceState.get().docs, doc];
  workspaceState.set({ docs });

  // Write file + index
  const docPath = path.join(workspacesDir, workspaceId, 'docs', filename);
  await atomicWrite(docPath, content);
  await saveDocsIndex(workspaceId, docs);

  // Update workspace timestamp
  updateWorkspace(workspaceId, {});

  return doc;
}

async function updateDoc(workspaceId, docId, { title, content, tags }) {
  const docs = workspaceState.get().docs.map(d => {
    if (d.id !== docId) return d;
    const updated = { ...d, updatedAt: Date.now() };
    if (title !== undefined) {
      updated.title = title;
      // Note: filename stays the same to avoid breaking links
    }
    if (tags !== undefined) updated.tags = tags;
    if (content !== undefined) updated.summary = content.substring(0, 200);
    return updated;
  });
  workspaceState.set({ docs });
  await saveDocsIndex(workspaceId, docs);

  // Write content if provided
  if (content !== undefined) {
    const doc = docs.find(d => d.id === docId);
    if (doc) {
      const docPath = path.join(workspacesDir, workspaceId, 'docs', doc.filename);
      await atomicWrite(docPath, content);
    }
  }

  updateWorkspace(workspaceId, {});
}

async function deleteDoc(workspaceId, docId) {
  const doc = getDoc(docId);
  const docs = workspaceState.get().docs.filter(d => d.id !== docId);
  workspaceState.set({ docs });

  if (doc) {
    const docPath = path.join(workspacesDir, workspaceId, 'docs', doc.filename);
    try { await fsp.unlink(docPath); } catch {}
  }

  await saveDocsIndex(workspaceId, docs);

  // Also remove any links referencing this doc
  const links = workspaceState.get().links.filter(l =>
    !(l.sourceType === 'doc' && l.sourceId === docId) &&
    !(l.targetType === 'doc' && l.targetId === docId)
  );
  workspaceState.set({ links });
  await saveLinksFile(workspaceId, links);

  // Clear editing if this doc was being edited
  if (workspaceState.get().editingDocId === docId) {
    workspaceState.set({ editingDocId: null });
  }

  updateWorkspace(workspaceId, {});
}

async function readDocContent(workspaceId, docId) {
  const doc = getDoc(docId);
  if (!doc) return null;
  const docPath = path.join(workspacesDir, workspaceId, 'docs', doc.filename);
  try {
    return await fsp.readFile(docPath, 'utf8');
  } catch {
    return null;
  }
}

async function saveDocContent(workspaceId, docId, content) {
  const doc = getDoc(docId);
  if (!doc) return;
  const docPath = path.join(workspacesDir, workspaceId, 'docs', doc.filename);
  await atomicWrite(docPath, content);

  // Update summary in index
  const docs = workspaceState.get().docs.map(d => {
    if (d.id !== docId) return d;
    return { ...d, summary: content.substring(0, 200), updatedAt: Date.now() };
  });
  workspaceState.set({ docs });
  await saveDocsIndex(workspaceId, docs);
}

// --- Links CRUD ---

async function saveLinksFile(workspaceId, links) {
  const linksPath = path.join(workspacesDir, workspaceId, 'links.json');
  await atomicWriteJSON(linksPath, { links });
}

async function addLink(workspaceId, { sourceType, sourceId, targetType, targetId, label, description = '' }) {
  const id = generateLinkId();
  const link = { id, sourceType, sourceId, targetType, targetId, label, description, createdAt: Date.now() };
  const links = [...workspaceState.get().links, link];
  workspaceState.set({ links });
  await saveLinksFile(workspaceId, links);
  updateWorkspace(workspaceId, {});
  return link;
}

async function deleteLink(workspaceId, linkId) {
  const links = workspaceState.get().links.filter(l => l.id !== linkId);
  workspaceState.set({ links });
  await saveLinksFile(workspaceId, links);
  updateWorkspace(workspaceId, {});
}

module.exports = {
  workspaceState,
  // ID generators
  generateWorkspaceId,
  generateDocId,
  generateLinkId,
  // Getters
  getWorkspace,
  getDoc,
  getWorkspacesForProject,
  // Load / Save
  loadWorkspaces,
  saveWorkspaces,
  saveWorkspacesImmediate,
  // Workspace CRUD
  addWorkspace,
  updateWorkspace,
  deleteWorkspace,
  // Project association
  addProjectToWorkspace,
  removeProjectFromWorkspace,
  // Active workspace
  setActiveWorkspace,
  loadWorkspaceDocs,
  loadWorkspaceLinks,
  // Docs CRUD
  addDoc,
  updateDoc,
  deleteDoc,
  readDocContent,
  saveDocContent,
  // Links CRUD
  addLink,
  deleteLink
};
