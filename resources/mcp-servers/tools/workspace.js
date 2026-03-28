'use strict';

/**
 * Workspace Tools Module for Claude Terminal MCP
 *
 * Provides workspace management, knowledge base documents, cross-entity
 * linking, and search.  Reads/writes CT_DATA_DIR/workspaces.json and
 * per-workspace directories with atomic writes.
 */

const fs = require('fs');
const path = require('path');

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:workspace] ${args.join(' ')}\n`);
}

// -- Data access --------------------------------------------------------------

function getDataDir() {
  return process.env.CT_DATA_DIR || '';
}

function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function atomicWriteText(filePath, text) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, filePath);
}

function loadJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    log('Error reading', filePath + ':', e.message);
  }
  return fallback;
}

// -- Workspace helpers --------------------------------------------------------

function loadWorkspaces() {
  return loadJson(path.join(getDataDir(), 'workspaces.json'), { workspaces: [] });
}

function saveWorkspaces(data) {
  atomicWrite(path.join(getDataDir(), 'workspaces.json'), data);
}

function findWorkspace(nameOrId) {
  const data = loadWorkspaces();
  return data.workspaces.find(w =>
    w.id === nameOrId ||
    (w.name || '').toLowerCase() === (nameOrId || '').toLowerCase()
  );
}

function workspaceDir(workspaceId) {
  return path.join(getDataDir(), 'workspaces', workspaceId);
}

function loadDocsIndex(workspaceId) {
  return loadJson(path.join(workspaceDir(workspaceId), 'docs-index.json'), { docs: [] });
}

function saveDocsIndex(workspaceId, data) {
  atomicWrite(path.join(workspaceDir(workspaceId), 'docs-index.json'), data);
}

function loadLinks(workspaceId) {
  return loadJson(path.join(workspaceDir(workspaceId), 'links.json'), { links: [] });
}

function saveLinks(workspaceId, data) {
  atomicWrite(path.join(workspaceDir(workspaceId), 'links.json'), data);
}

function loadProjects() {
  return loadJson(path.join(getDataDir(), 'projects.json'), { projects: [], folders: [], rootOrder: [] });
}

function findDoc(docsIndex, docRef) {
  return docsIndex.docs.find(d =>
    d.id === docRef ||
    (d.title || '').toLowerCase() === (docRef || '').toLowerCase() ||
    (d.filename || '').toLowerCase() === (docRef || '').toLowerCase()
  );
}

/**
 * Build a safe filename from a title.  Strips non-alphanumeric characters
 * (except dashes, underscores, and spaces), collapses whitespace to dashes,
 * and appends .md.
 */
function titleToFilename(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) + '.md';
}

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'workspace_list',
    description: 'List all workspaces with their project counts and document counts.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'workspace_info',
    description: 'Get detailed info about a workspace: metadata, projects (resolved names/paths), documents, and concept links.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace name or ID' },
      },
      required: ['workspace'],
    },
  },
  {
    name: 'workspace_read_doc',
    description: 'Read a knowledge base document from a workspace. Returns the full markdown content.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace name or ID' },
        doc:       { type: 'string', description: 'Document title, filename, or ID' },
      },
      required: ['workspace', 'doc'],
    },
  },
  {
    name: 'workspace_write_doc',
    description: 'Create or update a knowledge base document in a workspace. If a document with the same title already exists it is updated; otherwise a new document is created.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace name or ID' },
        title:     { type: 'string', description: 'Document title' },
        content:   { type: 'string', description: 'Markdown content' },
        tags:      { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorisation' },
        summary:   { type: 'string', description: 'Optional short summary' },
      },
      required: ['workspace', 'title', 'content'],
    },
  },
  {
    name: 'workspace_search',
    description: 'Search across all documents in a workspace. Performs case-insensitive matching in titles and content, returning matching documents with snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace name or ID' },
        query:     { type: 'string', description: 'Search query (case-insensitive)' },
      },
      required: ['workspace', 'query'],
    },
  },
  {
    name: 'workspace_add_link',
    description: 'Add a concept link between two entities (documents or projects) inside a workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace:   { type: 'string', description: 'Workspace name or ID' },
        source:      { type: 'string', description: 'Source entity name (document title or project name)' },
        target:      { type: 'string', description: 'Target entity name (document title or project name)' },
        label:       { type: 'string', description: 'Relationship label (e.g. "depends-on", "related-to")' },
        description: { type: 'string', description: 'Optional description of the relationship' },
      },
      required: ['workspace', 'source', 'target', 'label'],
    },
  },
];

// -- Entity resolution --------------------------------------------------------

/**
 * Resolve an entity reference to { type, id, name }.
 * Searches docs in the workspace first, then projects.
 */
function resolveEntity(workspaceId, ref) {
  // Check docs
  const docsIndex = loadDocsIndex(workspaceId);
  const doc = findDoc(docsIndex, ref);
  if (doc) return { type: 'doc', id: doc.id, name: doc.title };

  // Check projects
  const projectsData = loadProjects();
  const project = projectsData.projects.find(p =>
    p.id === ref ||
    (p.name || '').toLowerCase() === (ref || '').toLowerCase() ||
    path.basename(p.path || '').toLowerCase() === (ref || '').toLowerCase()
  );
  if (project) return { type: 'project', id: project.id, name: project.name || path.basename(project.path || '?') };

  return null;
}

// -- Search helpers -----------------------------------------------------------

/**
 * Extract a short snippet around the first occurrence of `query` in `text`.
 * Returns up to ~120 characters of context.
 */
function extractSnippet(text, query, maxLen) {
  maxLen = maxLen || 120;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return null;

  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + query.length + 80);
  let snippet = text.slice(start, end).replace(/\n/g, ' ').trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';
  return snippet;
}

// -- Tool handler -------------------------------------------------------------

async function handle(name, args) {
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  try {
    // ── workspace_list ──────────────────────────────────────────────────
    if (name === 'workspace_list') {
      const data = loadWorkspaces();
      const workspaces = data.workspaces || [];

      if (!workspaces.length) return ok('No workspaces configured.');

      const lines = workspaces.map(w => {
        const docsIndex = loadDocsIndex(w.id);
        const docCount = (docsIndex.docs || []).length;
        const projectCount = (w.projectIds || []).length;

        const parts = [`${w.name}`];
        parts.push(`  ID: ${w.id}`);
        if (w.description) parts.push(`  Description: ${w.description}`);
        parts.push(`  Projects: ${projectCount}`);
        parts.push(`  Documents: ${docCount}`);
        if (w.color) parts.push(`  Color: ${w.color}`);
        if (w.icon) parts.push(`  Icon: ${w.icon}`);
        return parts.join('\n');
      });

      return ok(`Workspaces (${workspaces.length}):\n\n${lines.join('\n\n')}`);
    }

    // ── workspace_info ──────────────────────────────────────────────────
    if (name === 'workspace_info') {
      if (!args.workspace) return fail('Missing required parameter: workspace');

      const w = findWorkspace(args.workspace);
      if (!w) return fail(`Workspace "${args.workspace}" not found. Use workspace_list to see available workspaces.`);

      let output = `# ${w.name}\n`;
      output += `ID: ${w.id}\n`;
      if (w.description) output += `Description: ${w.description}\n`;
      if (w.color) output += `Color: ${w.color}\n`;
      if (w.icon) output += `Icon: ${w.icon}\n`;
      output += `Created: ${w.createdAt || 'unknown'}\n`;
      output += `Updated: ${w.updatedAt || 'unknown'}\n`;

      // Resolve projects
      const projectIds = w.projectIds || [];
      if (projectIds.length) {
        const projectsData = loadProjects();
        output += `\n## Projects (${projectIds.length})\n`;
        for (const pid of projectIds) {
          const p = projectsData.projects.find(proj => proj.id === pid);
          if (p) {
            output += `  - ${p.name || path.basename(p.path || '?')} (${p.path || '?'})\n`;
          } else {
            output += `  - [unresolved: ${pid}]\n`;
          }
        }
      } else {
        output += `\n## Projects\n  (none)\n`;
      }

      // Documents
      const docsIndex = loadDocsIndex(w.id);
      const docs = docsIndex.docs || [];
      if (docs.length) {
        output += `\n## Documents (${docs.length})\n`;
        for (const d of docs) {
          const tagStr = (d.tags && d.tags.length) ? ` [${d.tags.join(', ')}]` : '';
          output += `  - ${d.title}${tagStr}`;
          if (d.summary) output += ` — ${d.summary}`;
          output += '\n';
        }
      } else {
        output += `\n## Documents\n  (none)\n`;
      }

      // Links
      const linksData = loadLinks(w.id);
      const links = linksData.links || [];
      if (links.length) {
        output += `\n## Links (${links.length})\n`;
        for (const l of links) {
          output += `  - [${l.sourceType}] ${l.sourceId} --${l.label}--> [${l.targetType}] ${l.targetId}`;
          if (l.description) output += ` (${l.description})`;
          output += '\n';
        }
      } else {
        output += `\n## Links\n  (none)\n`;
      }

      return ok(output);
    }

    // ── workspace_read_doc ──────────────────────────────────────────────
    if (name === 'workspace_read_doc') {
      if (!args.workspace) return fail('Missing required parameter: workspace');
      if (!args.doc) return fail('Missing required parameter: doc');

      const w = findWorkspace(args.workspace);
      if (!w) return fail(`Workspace "${args.workspace}" not found. Use workspace_list to see available workspaces.`);

      const docsIndex = loadDocsIndex(w.id);
      const doc = findDoc(docsIndex, args.doc);
      if (!doc) {
        const available = (docsIndex.docs || []).map(d => d.title).join(', ');
        return fail(`Document "${args.doc}" not found in workspace "${w.name}". Available: ${available || 'none'}`);
      }

      const docPath = path.join(workspaceDir(w.id), 'docs', doc.filename);
      if (!fs.existsSync(docPath)) {
        return fail(`Document file not found on disk: ${doc.filename}. The index may be stale.`);
      }

      const content = fs.readFileSync(docPath, 'utf8');

      let header = `# ${doc.title}\n`;
      if (doc.tags && doc.tags.length) header += `Tags: ${doc.tags.join(', ')}\n`;
      if (doc.summary) header += `Summary: ${doc.summary}\n`;
      header += `Updated: ${doc.updatedAt || doc.createdAt || 'unknown'}\n`;
      header += `${'─'.repeat(50)}\n\n`;

      return ok(header + content);
    }

    // ── workspace_write_doc ─────────────────────────────────────────────
    if (name === 'workspace_write_doc') {
      if (!args.workspace) return fail('Missing required parameter: workspace');
      if (!args.title) return fail('Missing required parameter: title');
      if (!args.content) return fail('Missing required parameter: content');

      const w = findWorkspace(args.workspace);
      if (!w) return fail(`Workspace "${args.workspace}" not found. Use workspace_list to see available workspaces.`);

      const docsIndex = loadDocsIndex(w.id);
      const now = new Date().toISOString();
      const existing = findDoc(docsIndex, args.title);

      if (existing) {
        // Update existing document
        const docPath = path.join(workspaceDir(w.id), 'docs', existing.filename);
        atomicWriteText(docPath, args.content);

        existing.updatedAt = now;
        if (args.tags !== undefined) existing.tags = args.tags || [];
        if (args.summary !== undefined) existing.summary = args.summary || '';
        saveDocsIndex(w.id, docsIndex);

        return ok(`Document updated: "${existing.title}" in workspace "${w.name}".\n  File: ${existing.filename}\n  Updated: ${now}`);
      }

      // Create new document
      const filename = titleToFilename(args.title);

      // Ensure unique filename
      let finalFilename = filename;
      const docsDir = path.join(workspaceDir(w.id), 'docs');
      if (fs.existsSync(path.join(docsDir, filename))) {
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);
        finalFilename = `${base}-${Date.now()}${ext}`;
      }

      const docPath = path.join(docsDir, finalFilename);
      atomicWriteText(docPath, args.content);

      const newDoc = {
        id:        generateId('doc'),
        title:     args.title.trim(),
        filename:  finalFilename,
        tags:      args.tags || [],
        summary:   args.summary || '',
        createdAt: now,
        updatedAt: now,
      };
      docsIndex.docs.push(newDoc);
      saveDocsIndex(w.id, docsIndex);

      return ok(`Document created: "${newDoc.title}" in workspace "${w.name}".\n  File: ${newDoc.filename}\n  ID: ${newDoc.id}\n  Created: ${now}`);
    }

    // ── workspace_search ────────────────────────────────────────────────
    if (name === 'workspace_search') {
      if (!args.workspace) return fail('Missing required parameter: workspace');
      if (!args.query) return fail('Missing required parameter: query');

      const w = findWorkspace(args.workspace);
      if (!w) return fail(`Workspace "${args.workspace}" not found. Use workspace_list to see available workspaces.`);

      const docsIndex = loadDocsIndex(w.id);
      const docs = docsIndex.docs || [];
      const query = args.query.toLowerCase();
      const results = [];

      for (const doc of docs) {
        const titleMatch = (doc.title || '').toLowerCase().includes(query);
        const tagMatch = (doc.tags || []).some(t => t.toLowerCase().includes(query));

        // Read content for content search
        let contentSnippet = null;
        const docPath = path.join(workspaceDir(w.id), 'docs', doc.filename);
        try {
          if (fs.existsSync(docPath)) {
            const content = fs.readFileSync(docPath, 'utf8');
            contentSnippet = extractSnippet(content, args.query);
            const contentMatch = content.toLowerCase().includes(query);

            if (titleMatch || tagMatch || contentMatch) {
              results.push({
                title: doc.title,
                filename: doc.filename,
                matchIn: [
                  titleMatch ? 'title' : null,
                  tagMatch ? 'tags' : null,
                  contentMatch ? 'content' : null,
                ].filter(Boolean),
                snippet: contentSnippet,
                tags: doc.tags || [],
              });
            }
          }
        } catch (e) {
          // If we can't read the file, still check title/tag match
          if (titleMatch || tagMatch) {
            results.push({
              title: doc.title,
              filename: doc.filename,
              matchIn: [titleMatch ? 'title' : null, tagMatch ? 'tags' : null].filter(Boolean),
              snippet: null,
              tags: doc.tags || [],
            });
          }
        }
      }

      if (!results.length) {
        return ok(`No documents matching "${args.query}" in workspace "${w.name}".`);
      }

      const lines = results.map(r => {
        const parts = [`${r.title}`];
        parts.push(`  Matched in: ${r.matchIn.join(', ')}`);
        if (r.tags.length) parts.push(`  Tags: ${r.tags.join(', ')}`);
        if (r.snippet) parts.push(`  Snippet: ${r.snippet}`);
        return parts.join('\n');
      });

      return ok(`Search results for "${args.query}" in "${w.name}" (${results.length} matches):\n\n${lines.join('\n\n')}`);
    }

    // ── workspace_add_link ──────────────────────────────────────────────
    if (name === 'workspace_add_link') {
      if (!args.workspace) return fail('Missing required parameter: workspace');
      if (!args.source) return fail('Missing required parameter: source');
      if (!args.target) return fail('Missing required parameter: target');
      if (!args.label) return fail('Missing required parameter: label');

      const w = findWorkspace(args.workspace);
      if (!w) return fail(`Workspace "${args.workspace}" not found. Use workspace_list to see available workspaces.`);

      const sourceEntity = resolveEntity(w.id, args.source);
      if (!sourceEntity) {
        return fail(`Source "${args.source}" not found. It must be a document title or project name within the workspace.`);
      }

      const targetEntity = resolveEntity(w.id, args.target);
      if (!targetEntity) {
        return fail(`Target "${args.target}" not found. It must be a document title or project name within the workspace.`);
      }

      const linksData = loadLinks(w.id);
      const now = new Date().toISOString();

      const newLink = {
        id:          generateId('link'),
        sourceType:  sourceEntity.type,
        sourceId:    sourceEntity.name,
        targetType:  targetEntity.type,
        targetId:    targetEntity.name,
        label:       args.label.trim(),
        description: (args.description || '').trim(),
        createdAt:   now,
      };

      linksData.links.push(newLink);
      saveLinks(w.id, linksData);

      return ok(
        `Link created in workspace "${w.name}":\n` +
        `  [${sourceEntity.type}] ${sourceEntity.name} --${newLink.label}--> [${targetEntity.type}] ${targetEntity.name}\n` +
        (newLink.description ? `  Description: ${newLink.description}\n` : '') +
        `  ID: ${newLink.id}`
      );
    }

    return fail(`Unknown workspace tool: ${name}`);
  } catch (error) {
    log(`Error in ${name}:`, error.message);
    return fail(`Workspace error: ${error.message}`);
  }
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {}

// -- Exports ------------------------------------------------------------------

module.exports = { tools, handle, cleanup };
