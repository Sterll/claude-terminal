'use strict';

/**
 * artifact-schema.js
 * The parts of the artifact model that carry no I/O: kinds, identity, and the
 * naming rules for blobs.
 *
 * Split out of artifact-store.js because the renderer needs computeId() to
 * derive the same ids as the store, but is bundled for the browser by esbuild
 * and cannot require fs/os. Everything here must stay dependency-free.
 *
 * Shared between the renderer, the main process and the MCP server.
 */

/**
 * Artifact kinds, in the order the UI lists them.
 *
 * `published` is the odd one out and the only explicit one: it comes from the
 * Agent SDK's `Artifact` tool, which uploads an .html or .md file to claude.ai
 * and hands back a shareable URL. Every other kind is inferred from the
 * rendered transcript. Published artifacts therefore carry `url`, `description`
 * and `favicon`, which nothing else has.
 */
const KINDS = ['published', 'html', 'svg', 'mermaid', 'code', 'file'];

/**
 * FNV-1a, 32-bit, hex. Not a cryptographic hash and does not need to be: it
 * only has to make "same content" collide and "different content" not, over a
 * few thousand entries. Kept here so the renderer, the main process and the MCP
 * tools all derive identical ids from identical content.
 */
function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Stable id for a piece of content. Same content in, same id out — which is
 * what makes re-harvesting a replayed conversation idempotent.
 *
 * Two independent hashes widen the id from 32 to 64 bits, so collisions stay
 * negligible across the few thousand artifacts the store holds.
 */
function computeId(kind, source) {
  const s = String(source ?? '');
  return `art-${hashString(`${kind} ${s}`)}${hashString(`${s.length}:${s}`)}`;
}

/**
 * Group successive versions of the same artifact together. Artifacts sharing a
 * groupKey are v1, v2, v3… of one thing rather than unrelated entries.
 */
function computeGroupKey(projectId, kind, title) {
  return hashString(`${projectId || ''} ${kind} ${String(title || '').trim().toLowerCase()}`);
}

const EXT_BY_LANG = {
  javascript: 'js', js: 'js', jsx: 'jsx', typescript: 'ts', ts: 'ts', tsx: 'tsx',
  python: 'py', py: 'py', rust: 'rs', go: 'go', java: 'java', kotlin: 'kt',
  ruby: 'rb', php: 'php', csharp: 'cs', cpp: 'cpp', c: 'c', swift: 'swift',
  lua: 'lua', sql: 'sql', bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh',
  json: 'json', yaml: 'yml', yml: 'yml', toml: 'toml', xml: 'xml',
  html: 'html', css: 'css', scss: 'scss', markdown: 'md', md: 'md',
};

/** Extension a blob is stored under, so the blobs folder stays browsable. */
function extensionFor(kind, lang, title) {
  // A published artifact is whatever file was uploaded: .html or .md.
  if (kind === 'published') return String(lang).toLowerCase() === 'markdown' ? 'md' : 'html';
  if (kind === 'html') return 'html';
  if (kind === 'svg') return 'svg';
  if (kind === 'mermaid') return 'mmd';
  if (kind === 'file') {
    const fromTitle = String(title || '').split('.').pop();
    if (fromTitle && fromTitle !== title && /^[a-z0-9]{1,8}$/i.test(fromTitle)) return fromTitle.toLowerCase();
    return 'txt';
  }
  return EXT_BY_LANG[String(lang || '').toLowerCase()] || 'txt';
}

module.exports = {
  KINDS,
  hashString,
  computeId,
  computeGroupKey,
  extensionFor,
};
