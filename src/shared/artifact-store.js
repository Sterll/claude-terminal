'use strict';

/**
 * artifact-store.js
 * The on-disk store for chat artifacts, shared between the Electron main
 * process and the MCP server process.
 *
 *     ~/.claude-terminal/artifacts/
 *     ├── index.json          { version, artifacts: [meta] }
 *     └── blobs/<id>.<ext>    the raw source of one artifact
 *
 * An artifact is a self-contained thing Claude produced inside a conversation:
 * an HTML page, an SVG, a Mermaid diagram, a substantial code block, or a file
 * it wrote. The renderer detects them; this module is only responsible for
 * keeping them on disk and answering questions about them.
 *
 * Two invariants make the rest of the feature simple:
 *
 *   1. `id` is derived from a hash of (kind + source) by the caller, so saving
 *      the same artifact twice is idempotent. That is what lets the renderer
 *      re-harvest a whole conversation on every session resume without ever
 *      creating duplicates.
 *   2. `groupKey` is a hash of (projectId + kind + title). Artifacts sharing a
 *      groupKey are successive VERSIONS of one thing, numbered from 1. Three
 *      rewrites of the same dashboard.html are one artifact with v1/v2/v3, not
 *      three unrelated entries.
 *
 * Why this lives in src/shared: the MCP server runs as a plain `node` process
 * and cannot require from inside app.asar, but scripts/copy-mcp-shared.js
 * copies src/shared next to it at package time. Both sides therefore run the
 * same code and honour the same lock, which is the only way a read-modify-write
 * from the MCP process cannot lose an update written by the app (and vice
 * versa). Requires nothing outside node builtins, on purpose.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

// Identity and naming live in artifact-schema.js: the renderer needs the same
// computeId() but is bundled for the browser and cannot require fs/os.
const { KINDS, hashString, computeId, computeGroupKey, extensionFor } = require('./artifact-schema');

// Same resolution the MCP tools use (see tools/_projectsCache.js), so an
// overridden data dir keeps the app and the MCP process pointed at one store.
const DATA_DIR = process.env.CT_DATA_DIR || path.join(os.homedir(), '.claude-terminal');
const ARTIFACTS_DIR = path.join(DATA_DIR, 'artifacts');
const BLOBS_DIR = path.join(ARTIFACTS_DIR, 'blobs');
const INDEX_FILE = path.join(ARTIFACTS_DIR, 'index.json');
const LOCK_FILE = `${INDEX_FILE}.lock`;

// Total artifacts kept. Beyond this the oldest are evicted with their blobs:
// the store is a convenience cache over conversations, not an archive of record.
const MAX_ARTIFACTS = 2000;
// A single blob larger than this is not worth keeping — a 2 MB HTML page is
// already far past anything a preview pane can usefully show.
const MAX_BLOB_BYTES = 2 * 1024 * 1024;

// ── Cross-process lock ───────────────────────────────────────────────────────
// Same protocol as src/main/utils/fileLock.js (atomic 'wx' create, break when
// stale). Reimplemented here rather than required so that the MCP process, which
// cannot reach src/main, runs the identical implementation instead of a copy
// that can drift.

const LOCK_STALE_MS = 15000;
const LOCK_GIVE_UP_MS = 30000;
const LOCK_STEP_MS = 25;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function acquireLock() {
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      try { fs.writeSync(fd, `${process.pid} ${Date.now()}`); } catch { /* non-fatal */ }
      return fd;
    } catch (e) {
      if (e.code !== 'EEXIST') return null; // e.g. ENOENT on the dir — proceed unlocked
      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      } catch {
        continue; // vanished between open and stat
      }
      if (ageMs > LOCK_STALE_MS) {
        try { fs.unlinkSync(LOCK_FILE); } catch { /* someone else broke it */ }
        continue;
      }
      if (Date.now() - start > LOCK_GIVE_UP_MS) {
        try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
        try { return fs.openSync(LOCK_FILE, 'wx'); } catch { return null; }
      }
      await sleep(LOCK_STEP_MS);
    }
  }
}

function releaseLock(fd) {
  if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

/** Run `fn` holding the index lock. Best-effort: never hangs. */
async function withLock(fn) {
  await ensureDirs();
  const fd = await acquireLock();
  try {
    return await fn();
  } finally {
    releaseLock(fd);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function ensureDirs() {
  await fsp.mkdir(BLOBS_DIR, { recursive: true });
}

/** Atomic write: temp file + rename, so a crash never truncates the target. */
async function atomicWriteText(filePath, text) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, filePath);
}

function blobPath(meta) {
  return path.join(BLOBS_DIR, meta.blob || `${meta.id}.txt`);
}

// ── Index ────────────────────────────────────────────────────────────────────

const EMPTY_INDEX = { version: 1, artifacts: [] };

async function loadIndex() {
  try {
    const raw = await fsp.readFile(INDEX_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version || 1,
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
    };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('[Artifacts] index.json unreadable, starting empty:', e.message);
    }
    return { ...EMPTY_INDEX, artifacts: [] };
  }
}

async function saveIndex(index) {
  await ensureDirs();
  await atomicWriteText(INDEX_FILE, JSON.stringify(index, null, 2));
}

/**
 * Drop the oldest artifacts once the store exceeds MAX_ARTIFACTS, blobs
 * included. Mutates `index` and returns the number evicted.
 */
async function pruneIndex(index) {
  const excess = index.artifacts.length - MAX_ARTIFACTS;
  if (excess <= 0) return 0;
  const byAge = [...index.artifacts].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const doomed = byAge.slice(0, excess);
  const doomedIds = new Set(doomed.map(a => a.id));
  index.artifacts = index.artifacts.filter(a => !doomedIds.has(a.id));
  await Promise.all(doomed.map(async (meta) => {
    try { await fsp.unlink(blobPath(meta)); } catch { /* already gone */ }
  }));
  return doomed.length;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Insert an artifact, or return the existing one untouched when its id is
 * already known. Idempotent by design — the renderer calls this for every
 * artifact it sees, including on every conversation replay.
 *
 * @returns {Promise<{artifact: object, created: boolean, skipped?: string}>}
 */
async function saveArtifact(input) {
  const source = String(input?.source ?? '');
  const kind = KINDS.includes(input?.kind) ? input.kind : 'code';
  if (!source.trim()) return { artifact: null, created: false, skipped: 'empty' };

  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > MAX_BLOB_BYTES) return { artifact: null, created: false, skipped: 'too-large' };

  const id = input.id || computeId(kind, source);

  return withLock(async () => {
    const index = await loadIndex();
    const existing = index.artifacts.find(a => a.id === id);
    if (existing) return { artifact: existing, created: false };

    const title = String(input.title || 'Untitled').trim().slice(0, 200);
    const groupKey = computeGroupKey(input.projectId, kind, title);
    // Versions are numbered per group, so a rewrite of the same thing lands as
    // v2 rather than as a second card in the grid.
    const version = index.artifacts.reduce(
      (max, a) => (a.groupKey === groupKey ? Math.max(max, a.version || 1) : max), 0
    ) + 1;

    const meta = {
      id,
      projectId: input.projectId || null,
      projectName: input.projectName || null,
      sessionId: input.sessionId || null,
      kind,
      title,
      lang: input.lang || null,
      bytes,
      lines: source.split('\n').length,
      groupKey,
      version,
      messageIndex: Number.isInteger(input.messageIndex) ? input.messageIndex : null,
      createdAt: input.createdAt || new Date().toISOString(),
      blob: `${id}.${extensionFor(kind, input.lang, title)}`,
    };

    await atomicWriteText(blobPath(meta), source);
    index.artifacts.push(meta);
    const evicted = await pruneIndex(index);
    await saveIndex(index);
    if (evicted) console.log(`[Artifacts] pruned ${evicted} artifact(s) over the ${MAX_ARTIFACTS} cap`);
    return { artifact: meta, created: true };
  });
}

/**
 * Insert many artifacts under a single lock acquisition.
 *
 * The renderer harvests a whole conversation at once when a session is resumed,
 * which can be dozens of artifacts. Routing those through saveArtifact() one by
 * one would take the cross-process lock and rewrite index.json once per
 * artifact; this does it once for the batch.
 *
 * @returns {Promise<{created: object[], skipped: number}>}
 */
async function saveMany(inputs) {
  const list = Array.isArray(inputs) ? inputs : [];
  if (!list.length) return { created: [], skipped: 0 };

  return withLock(async () => {
    const index = await loadIndex();
    const known = new Set(index.artifacts.map(a => a.id));
    // Highest version seen per group, seeded from disk and advanced as the batch
    // is applied, so several versions arriving together still number correctly.
    const versionByGroup = new Map();
    for (const a of index.artifacts) {
      versionByGroup.set(a.groupKey, Math.max(versionByGroup.get(a.groupKey) || 0, a.version || 1));
    }

    const created = [];
    let skipped = 0;
    const writes = [];

    for (const input of list) {
      const source = String(input?.source ?? '');
      const kind = KINDS.includes(input?.kind) ? input.kind : 'code';
      const bytes = Buffer.byteLength(source, 'utf8');
      if (!source.trim() || bytes > MAX_BLOB_BYTES) { skipped++; continue; }

      const id = input.id || computeId(kind, source);
      if (known.has(id)) { skipped++; continue; }
      known.add(id);

      const title = String(input.title || 'Untitled').trim().slice(0, 200);
      const groupKey = computeGroupKey(input.projectId, kind, title);
      const version = (versionByGroup.get(groupKey) || 0) + 1;
      versionByGroup.set(groupKey, version);

      const meta = {
        id,
        projectId: input.projectId || null,
        projectName: input.projectName || null,
        sessionId: input.sessionId || null,
        kind,
        title,
        lang: input.lang || null,
        bytes,
        lines: source.split('\n').length,
        groupKey,
        version,
        messageIndex: Number.isInteger(input.messageIndex) ? input.messageIndex : null,
        createdAt: input.createdAt || new Date().toISOString(),
        blob: `${id}.${extensionFor(kind, input.lang, title)}`,
      };
      writes.push(atomicWriteText(blobPath(meta), source));
      index.artifacts.push(meta);
      created.push(meta);
    }

    if (!created.length) return { created: [], skipped };

    await Promise.all(writes);
    await pruneIndex(index);
    await saveIndex(index);
    return { created, skipped };
  });
}

/**
 * List artifact metadata, newest first. All filters are optional and combine.
 * @param {{projectId?: string, kind?: string, sessionId?: string,
 *          query?: string, limit?: number, offset?: number,
 *          latestOnly?: boolean}} [options]
 */
async function listArtifacts(options = {}) {
  const index = await loadIndex();
  let rows = index.artifacts;

  if (options.projectId) rows = rows.filter(a => a.projectId === options.projectId);
  if (options.sessionId) rows = rows.filter(a => a.sessionId === options.sessionId);
  if (options.kind) rows = rows.filter(a => a.kind === options.kind);
  if (options.query) {
    const needle = String(options.query).toLowerCase();
    rows = rows.filter(a =>
      String(a.title || '').toLowerCase().includes(needle) ||
      String(a.lang || '').toLowerCase().includes(needle) ||
      String(a.projectName || '').toLowerCase().includes(needle)
    );
  }

  rows = [...rows].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  // Collapse version chains down to their newest member, the way the grid shows
  // one card per artifact with a v1/v2/v3 switcher inside it.
  if (options.latestOnly) {
    const best = new Map();
    for (const row of rows) {
      const current = best.get(row.groupKey);
      if (!current || (row.version || 1) > (current.version || 1)) best.set(row.groupKey, row);
    }
    rows = [...best.values()].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  const total = rows.length;
  const offset = Math.max(0, options.offset || 0);
  const limit = options.limit != null ? Math.max(0, options.limit) : rows.length;
  return { artifacts: rows.slice(offset, offset + limit), total };
}

/** One artifact, metadata plus its source. Null when unknown. */
async function getArtifact(id) {
  const index = await loadIndex();
  const meta = index.artifacts.find(a => a.id === id);
  if (!meta) return null;
  let source = '';
  try {
    source = await fsp.readFile(blobPath(meta), 'utf8');
  } catch (e) {
    // The index survived but the blob did not: report the metadata rather than
    // failing the whole call, so the UI can still offer to delete the entry.
    console.warn(`[Artifacts] blob missing for ${id}:`, e.message);
  }
  return { ...meta, source };
}

/** Every version of an artifact, oldest first. */
async function getVersions(groupKey) {
  const index = await loadIndex();
  return index.artifacts
    .filter(a => a.groupKey === groupKey)
    .sort((a, b) => (a.version || 1) - (b.version || 1));
}

/** Delete one artifact and its blob. Returns false when it was already gone. */
async function deleteArtifact(id) {
  return withLock(async () => {
    const index = await loadIndex();
    const meta = index.artifacts.find(a => a.id === id);
    if (!meta) return false;
    index.artifacts = index.artifacts.filter(a => a.id !== id);
    try { await fsp.unlink(blobPath(meta)); } catch { /* already gone */ }
    await saveIndex(index);
    return true;
  });
}

/**
 * Delete every artifact matching a filter. Used by "clear this project" and by
 * the MCP cleanup tool. Returns how many went.
 */
async function deleteWhere({ projectId, sessionId, kind } = {}) {
  if (!projectId && !sessionId && !kind) throw new Error('deleteWhere requires at least one filter');
  return withLock(async () => {
    const index = await loadIndex();
    const doomed = index.artifacts.filter(a =>
      (!projectId || a.projectId === projectId) &&
      (!sessionId || a.sessionId === sessionId) &&
      (!kind || a.kind === kind)
    );
    if (!doomed.length) return 0;
    const doomedIds = new Set(doomed.map(a => a.id));
    index.artifacts = index.artifacts.filter(a => !doomedIds.has(a.id));
    await Promise.all(doomed.map(async (meta) => {
      try { await fsp.unlink(blobPath(meta)); } catch { /* already gone */ }
    }));
    await saveIndex(index);
    return doomed.length;
  });
}

/** Counts and total size, for the library header. */
async function getStats() {
  const index = await loadIndex();
  const byKind = Object.fromEntries(KINDS.map(k => [k, 0]));
  const projects = new Set();
  let bytes = 0;
  for (const a of index.artifacts) {
    if (byKind[a.kind] !== undefined) byKind[a.kind]++;
    if (a.projectId) projects.add(a.projectId);
    bytes += a.bytes || 0;
  }
  return { total: index.artifacts.length, byKind, bytes, projects: projects.size };
}

module.exports = {
  // paths, exported for tests and for the MCP tool's error messages
  ARTIFACTS_DIR,
  BLOBS_DIR,
  INDEX_FILE,
  KINDS,
  MAX_ARTIFACTS,
  MAX_BLOB_BYTES,
  // pure helpers, shared with the renderer's detection pass
  hashString,
  computeId,
  computeGroupKey,
  extensionFor,
  // store
  saveArtifact,
  saveMany,
  listArtifacts,
  getArtifact,
  getVersions,
  deleteArtifact,
  deleteWhere,
  getStats,
};
