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

async function ensureDir(dir) {
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (e) {
    // ignore if already exists
  }
}

async function loadWorkspaces() {
  try {
    const raw = await fs.promises.readFile(workspacesFile, 'utf8');
    const data = JSON.parse(raw);
    return data.workspaces || [];
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('[WorkspaceService] Error loading workspaces:', e.message);
    }
    return [];
  }
}

async function getWorkspace(id) {
  const workspaces = await loadWorkspaces();
  return workspaces.find(w => w.id === id) || workspaces.find(w => w.name.toLowerCase() === id.toLowerCase());
}

async function getWorkspaceDocsIndex(workspaceId) {
  const indexPath = path.join(workspacesDir, workspaceId, 'docs-index.json');
  try {
    const raw = await fs.promises.readFile(indexPath, 'utf8');
    return JSON.parse(raw).docs || [];
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('[WorkspaceService] Error reading docs index:', e.message);
    }
    return [];
  }
}

async function readDoc(workspaceId, docIdOrName) {
  const docs = await getWorkspaceDocsIndex(workspaceId);
  const doc = docs.find(d =>
    d.id === docIdOrName ||
    d.title.toLowerCase() === docIdOrName.toLowerCase() ||
    d.filename.toLowerCase() === docIdOrName.toLowerCase()
  );
  if (!doc) return null;

  const docPath = path.join(workspacesDir, workspaceId, 'docs', doc.filename);
  try {
    return { doc, content: await fs.promises.readFile(docPath, 'utf8') };
  } catch {
    return { doc, content: null };
  }
}

async function writeDoc(workspaceId, title, content) {
  await ensureDir(path.join(workspacesDir, workspaceId, 'docs'));

  const docs = await getWorkspaceDocsIndex(workspaceId);
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
  await fs.promises.writeFile(tmpPath, content, 'utf8');
  await fs.promises.rename(tmpPath, docPath);

  // Save index
  const indexPath = path.join(workspacesDir, workspaceId, 'docs-index.json');
  const tmpIndex = indexPath + '.tmp';
  await fs.promises.writeFile(tmpIndex, JSON.stringify({ docs }, null, 2), 'utf8');
  await fs.promises.rename(tmpIndex, indexPath);

  return doc;
}

async function deleteDoc(workspaceId, docIdOrName) {
  const docs = await getWorkspaceDocsIndex(workspaceId);
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
  try { await fs.promises.unlink(docPath); } catch {}

  // Save index
  const indexPath = path.join(workspacesDir, workspaceId, 'docs-index.json');
  const tmpIndex = indexPath + '.tmp';
  await fs.promises.writeFile(tmpIndex, JSON.stringify({ docs }, null, 2), 'utf8');
  await fs.promises.rename(tmpIndex, indexPath);

  return true;
}

async function searchDocs(workspaceId, query) {
  const docs = await getWorkspaceDocsIndex(workspaceId);
  const q = query.toLowerCase();
  const results = [];

  // Read all doc contents in parallel
  const readPromises = docs.map(async (doc) => {
    const docPath = path.join(workspacesDir, workspaceId, 'docs', doc.filename);
    try {
      return await fs.promises.readFile(docPath, 'utf8');
    } catch {
      return null;
    }
  });

  const contents = await Promise.all(readPromises);

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const titleMatch = doc.title.toLowerCase().includes(q);
    let contentMatch = false;
    let snippet = '';

    const content = contents[i];
    if (content) {
      const idx = content.toLowerCase().indexOf(q);
      if (idx !== -1) {
        contentMatch = true;
        const start = Math.max(0, idx - 50);
        const end = Math.min(content.length, idx + query.length + 50);
        snippet = (start > 0 ? '...' : '') + content.substring(start, end) + (end < content.length ? '...' : '');
      }
    }

    if (titleMatch || contentMatch) {
      results.push({ doc, titleMatch, contentMatch, snippet });
    }
  }

  return results;
}

async function getWorkspaceLinks(workspaceId) {
  const linksPath = path.join(workspacesDir, workspaceId, 'links.json');
  try {
    const raw = await fs.promises.readFile(linksPath, 'utf8');
    return JSON.parse(raw).links || [];
  } catch {
    return [];
  }
}

async function addLink(workspaceId, { sourceType, sourceId, targetType, targetId, label, description = '' }) {
  const links = await getWorkspaceLinks(workspaceId);
  const link = {
    id: `link-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    sourceType, sourceId, targetType, targetId, label, description,
    createdAt: Date.now()
  };
  links.push(link);

  const linksPath = path.join(workspacesDir, workspaceId, 'links.json');
  const tmp = linksPath + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify({ links }, null, 2), 'utf8');
  await fs.promises.rename(tmp, linksPath);

  return link;
}

async function getWorkspaceOverview(workspaceId) {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) return null;

  const [docs, links] = await Promise.all([
    getWorkspaceDocsIndex(workspaceId),
    getWorkspaceLinks(workspaceId),
  ]);

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
