'use strict';

/**
 * Artifacts Tools Module for Claude Terminal MCP
 *
 * The artifact library: the self-contained things Claude produced inside past
 * conversations (an HTML page, an SVG, a Mermaid diagram, a long code block, a
 * file it wrote), detected by the app and kept on disk.
 *
 * These tools let a session reach back into that library — "show me the
 * dashboard I built last week", "what was in v1 of that page" — without asking
 * the user to find and paste it.
 *
 * Storage is shared with the app, not copied: both sides run
 * src/shared/artifact-store.js, so a write from either process takes the same
 * cross-process lock and neither can lose the other's update.
 */

const path = require('path');

// Resolve the shared store: packaged app (afterPack copy) → dev repo.
// Same dual-path shape automation.js uses for the task compiler. Without it the
// module still loads but every tool fails loudly rather than reading a store
// that does not exist.
let store = null;
let storeError = null;
try {
  // Packaged app: src/shared/ is copied alongside mcp-servers/
  store = require(path.join(__dirname, '..', 'shared', 'artifact-store'));
} catch (_) {
  try {
    // Dev environment: src/shared/ relative to the repo root
    store = require(path.join(__dirname, '..', '..', '..', 'src', 'shared', 'artifact-store'));
  } catch (e) {
    storeError = e.message;
    process.stderr.write(`[ct-mcp:artifacts] artifact-store unavailable, tools disabled: ${e.message}\n`);
  }
}

function log(...args) {
  process.stderr.write(`[ct-mcp:artifacts] ${args.join(' ')}\n`);
}

// -- Formatting ---------------------------------------------------------------

const KINDS = ['html', 'svg', 'mermaid', 'code', 'file'];

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso) {
  if (!iso) return 'unknown date';
  return String(iso).slice(0, 16).replace('T', ' ');
}

/** One artifact as a compact line for a list. */
function formatRow(a) {
  const version = (a.version || 1) > 1 ? ` v${a.version}` : '';
  const project = a.projectName ? ` · ${a.projectName}` : '';
  const lang = a.lang ? ` · ${a.lang}` : '';
  return `- [${a.kind}] ${a.title}${version} — ${a.id}\n`
    + `  ${a.lines} lines · ${formatBytes(a.bytes)}${lang}${project} · ${formatDate(a.createdAt)}`;
}

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

function fail(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'artifact_list',
    description:
      'List artifacts Claude produced in past conversations: HTML pages, SVGs, Mermaid diagrams, '
      + 'long code blocks, and files written. Newest first. Filter by project, kind, or session. '
      + 'By default only the latest version of each artifact is listed.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Restrict to one project (see project_list)' },
        sessionId: { type: 'string', description: 'Restrict to one chat session' },
        kind: { type: 'string', enum: KINDS, description: 'Restrict to one artifact kind' },
        limit: { type: 'number', description: 'Maximum rows to return (default 30)' },
        allVersions: {
          type: 'boolean',
          description: 'List every version instead of only the newest of each artifact',
        },
      },
    },
  },
  {
    name: 'artifact_get',
    description:
      'Read one artifact in full: its metadata and its complete source. Use the id from '
      + 'artifact_list or artifact_search.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Artifact id, e.g. art-1a2b3c4d5e6f7a8b' },
        metadataOnly: {
          type: 'boolean',
          description: 'Return only the metadata, useful when the source is large',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'artifact_search',
    description:
      'Find artifacts by title, language or project name. Use this when the user refers to '
      + 'something they remember producing ("the pricing page", "that sequence diagram") rather '
      + 'than to a specific id.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to match against title, language and project' },
        kind: { type: 'string', enum: KINDS, description: 'Restrict to one artifact kind' },
        limit: { type: 'number', description: 'Maximum rows to return (default 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'artifact_versions',
    description:
      'List every version of one artifact, oldest first. Rewrites of the same thing are grouped, '
      + 'so this is how to reach an earlier draft of a page or diagram.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Any version of the artifact' },
      },
      required: ['id'],
    },
  },
  {
    name: 'artifact_delete',
    description:
      'Delete one artifact and its stored source. Irreversible. Prefer letting the user do this '
      + 'from the Artifacts panel unless they explicitly asked you to clean up.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Artifact id to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'artifact_stats',
    description: 'Counts, total size on disk and per-kind breakdown of the artifact library.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// -- Handlers -----------------------------------------------------------------

async function handleList(args) {
  const limit = Math.max(1, Math.min(200, args.limit || 30));
  const { artifacts, total } = await store.listArtifacts({
    projectId: args.projectId,
    sessionId: args.sessionId,
    kind: args.kind,
    latestOnly: !args.allVersions,
    limit,
  });

  if (!artifacts.length) {
    return ok('No artifacts match. The library fills up as Claude produces HTML pages, diagrams, '
      + 'SVGs, long code blocks or writes files in the app.');
  }

  const shown = artifacts.length < total ? ` (showing ${artifacts.length})` : '';
  return ok(`${total} artifact(s)${shown}:\n\n${artifacts.map(formatRow).join('\n')}`);
}

async function handleGet(args) {
  const artifact = await store.getArtifact(args.id);
  if (!artifact) return fail(`No artifact with id "${args.id}". Use artifact_list to find one.`);

  const header = [
    `# ${artifact.title}`,
    '',
    `- id: ${artifact.id}`,
    `- kind: ${artifact.kind}${artifact.lang ? ` (${artifact.lang})` : ''}`,
    `- version: v${artifact.version || 1}`,
    `- size: ${artifact.lines} lines, ${formatBytes(artifact.bytes)}`,
    artifact.projectName ? `- project: ${artifact.projectName}` : null,
    `- created: ${formatDate(artifact.createdAt)}`,
  ].filter(Boolean).join('\n');

  if (args.metadataOnly) return ok(header);
  if (!artifact.source) {
    return ok(`${header}\n\nThe stored source for this artifact is missing from disk; only its metadata survives.`);
  }
  return ok(`${header}\n\n## Source\n\n${artifact.source}`);
}

async function handleSearch(args) {
  const limit = Math.max(1, Math.min(200, args.limit || 20));
  const { artifacts, total } = await store.listArtifacts({
    query: args.query,
    kind: args.kind,
    latestOnly: true,
    limit,
  });

  if (!artifacts.length) return ok(`No artifact matches "${args.query}".`);
  const shown = artifacts.length < total ? ` (showing ${artifacts.length})` : '';
  return ok(`${total} match(es) for "${args.query}"${shown}:\n\n${artifacts.map(formatRow).join('\n')}`);
}

async function handleVersions(args) {
  const artifact = await store.getArtifact(args.id);
  if (!artifact) return fail(`No artifact with id "${args.id}".`);

  const versions = await store.getVersions(artifact.groupKey);
  if (versions.length < 2) return ok(`"${artifact.title}" has a single version (${artifact.id}).`);

  return ok(`${versions.length} versions of "${artifact.title}":\n\n${versions.map(formatRow).join('\n')}`);
}

async function handleDelete(args) {
  const deleted = await store.deleteArtifact(args.id);
  if (!deleted) return fail(`No artifact with id "${args.id}".`);
  return ok(`Deleted artifact ${args.id}.`);
}

async function handleStats() {
  const stats = await store.getStats();
  const breakdown = Object.entries(stats.byKind)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `- ${kind}: ${count}`)
    .join('\n') || '- (none)';

  return ok(`Artifact library:\n\n`
    + `- total: ${stats.total}\n`
    + `- on disk: ${formatBytes(stats.bytes)}\n`
    + `- projects: ${stats.projects}\n\n`
    + `By kind:\n${breakdown}`);
}

const HANDLERS = {
  artifact_list: handleList,
  artifact_get: handleGet,
  artifact_search: handleSearch,
  artifact_versions: handleVersions,
  artifact_delete: handleDelete,
  artifact_stats: handleStats,
};

async function handle(toolName, args = {}) {
  if (!store) {
    return fail(`Artifact store unavailable: ${storeError || 'module not found'}`);
  }
  const handler = HANDLERS[toolName];
  if (!handler) return fail(`Unknown tool: ${toolName}`);

  try {
    return await handler(args);
  } catch (e) {
    log(`${toolName} failed: ${e.message}`);
    return fail(`${toolName} failed: ${e.message}`);
  }
}

async function cleanup() {
  // No handles held: every call reads and releases the index.
}

module.exports = { tools, handle, cleanup };
