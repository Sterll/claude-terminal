/**
 * Workspace Service
 * Handles workspace data operations in the main process.
 * Used by IPC handlers and MCP tools for filesystem access.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const dataDir = path.join(os.homedir(), '.claude-terminal');
const workspacesFile = path.join(dataDir, 'workspaces.json');
const workspacesDir = path.join(dataDir, 'workspaces');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadWorkspaces() {
  try {
    if (fs.existsSync(workspacesFile)) {
      const data = JSON.parse(fs.readFileSync(workspacesFile, 'utf8'));
      return data.workspaces || [];
    }
  } catch (e) {
    console.error('[WorkspaceService] Error loading workspaces:', e.message);
  }
  return [];
}

function getWorkspace(id) {
  const workspaces = loadWorkspaces();
  return workspaces.find(w => w.id === id) || workspaces.find(w => w.name.toLowerCase() === id.toLowerCase());
}

function getWorkspaceDocsIndex(workspaceId) {
  const indexPath = path.join(workspacesDir, workspaceId, 'docs-index.json');
  try {
    if (fs.existsSync(indexPath)) {
      return JSON.parse(fs.readFileSync(indexPath, 'utf8')).docs || [];
    }
  } catch (e) {
    console.error('[WorkspaceService] Error reading docs index:', e.message);
  }
  return [];
}

function readDoc(workspaceId, docIdOrName) {
  const docs = getWorkspaceDocsIndex(workspaceId);
  const doc = docs.find(d =>
    d.id === docIdOrName ||
    d.title.toLowerCase() === docIdOrName.toLowerCase() ||
    d.filename.toLowerCase() === docIdOrName.toLowerCase()
  );
  if (!doc) return null;

  const docPath = path.join(workspacesDir, workspaceId, 'docs', doc.filename);
  try {
    return { doc, content: fs.readFileSync(docPath, 'utf8') };
  } catch {
    return { doc, content: null };
  }
}

function writeDoc(workspaceId, title, content) {
  ensureDir(path.join(workspacesDir, workspaceId, 'docs'));

  const docs = getWorkspaceDocsIndex(workspaceId);
  let doc = docs.find(d =>
    d.title.toLowerCase() === title.toLowerCase() ||
    d.filename.toLowerCase() === (title.toLowerCase().replace(/[^a-z0-9-]/g, '-') + '.md')
  );

  const now = Date.now();
  if (doc) {
    // Update existing
    doc.updatedAt = now;
    doc.summary = content.substring(0, 200);
  } else {
    // Create new
    const filename = title.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, '-').toLowerCase().substring(0, 100) + '.md';
    doc = {
      id: `doc-${now}-${Math.random().toString(36).substr(2, 9)}`,
      title,
      filename,
      tags: [],
      summary: content.substring(0, 200),
      createdAt: now,
      updatedAt: now
    };
    docs.push(doc);
  }

  // Write content
  const docPath = path.join(workspacesDir, workspaceId, 'docs', doc.filename);
  const tmpPath = docPath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, docPath);

  // Save index
  const indexPath = path.join(workspacesDir, workspaceId, 'docs-index.json');
  const tmpIndex = indexPath + '.tmp';
  fs.writeFileSync(tmpIndex, JSON.stringify({ docs }, null, 2), 'utf8');
  fs.renameSync(tmpIndex, indexPath);

  return doc;
}

function deleteDoc(workspaceId, docIdOrName) {
  const docs = getWorkspaceDocsIndex(workspaceId);
  const docIdx = docs.findIndex(d =>
    d.id === docIdOrName ||
    d.title.toLowerCase() === docIdOrName.toLowerCase() ||
    d.filename.toLowerCase() === docIdOrName.toLowerCase()
  );
  if (docIdx === -1) return false;

  const doc = docs[docIdx];
  docs.splice(docIdx, 1);

  // Remove file
  const docPath = path.join(workspacesDir, workspaceId, 'docs', doc.filename);
  try { fs.unlinkSync(docPath); } catch {}

  // Save index
  const indexPath = path.join(workspacesDir, workspaceId, 'docs-index.json');
  const tmpIndex = indexPath + '.tmp';
  fs.writeFileSync(tmpIndex, JSON.stringify({ docs }, null, 2), 'utf8');
  fs.renameSync(tmpIndex, indexPath);

  return true;
}

function searchDocs(workspaceId, query) {
  const docs = getWorkspaceDocsIndex(workspaceId);
  const q = query.toLowerCase();
  const results = [];

  for (const doc of docs) {
    const titleMatch = doc.title.toLowerCase().includes(q);
    const docPath = path.join(workspacesDir, workspaceId, 'docs', doc.filename);
    let contentMatch = false;
    let snippet = '';

    try {
      const content = fs.readFileSync(docPath, 'utf8');
      const idx = content.toLowerCase().indexOf(q);
      if (idx !== -1) {
        contentMatch = true;
        const start = Math.max(0, idx - 50);
        const end = Math.min(content.length, idx + query.length + 50);
        snippet = (start > 0 ? '...' : '') + content.substring(start, end) + (end < content.length ? '...' : '');
      }
    } catch {}

    if (titleMatch || contentMatch) {
      results.push({ doc, titleMatch, contentMatch, snippet });
    }
  }

  return results;
}

function getWorkspaceLinks(workspaceId) {
  const linksPath = path.join(workspacesDir, workspaceId, 'links.json');
  try {
    if (fs.existsSync(linksPath)) {
      return JSON.parse(fs.readFileSync(linksPath, 'utf8')).links || [];
    }
  } catch {}
  return [];
}

function addLink(workspaceId, { sourceType, sourceId, targetType, targetId, label, description = '' }) {
  const links = getWorkspaceLinks(workspaceId);
  const link = {
    id: `link-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    sourceType, sourceId, targetType, targetId, label, description,
    createdAt: Date.now()
  };
  links.push(link);

  const linksPath = path.join(workspacesDir, workspaceId, 'links.json');
  const tmp = linksPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ links }, null, 2), 'utf8');
  fs.renameSync(tmp, linksPath);

  return link;
}

function getWorkspaceOverview(workspaceId) {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) return null;

  const docs = getWorkspaceDocsIndex(workspaceId);
  const links = getWorkspaceLinks(workspaceId);

  return { workspace, docs, links };
}

module.exports = {
  loadWorkspaces,
  getWorkspace,
  getWorkspaceDocsIndex,
  readDoc,
  writeDoc,
  deleteDoc,
  searchDocs,
  getWorkspaceLinks,
  addLink,
  getWorkspaceOverview,
  workspacesDir
};
