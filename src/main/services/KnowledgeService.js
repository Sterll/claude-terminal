/**
 * KnowledgeService
 *
 * Global knowledge base: facts that apply to every project, not just one.
 * Typical entries: a dedicated server, a VPS, a domain, a client, a naming
 * convention, an internal service.
 *
 * Storage: ~/.claude-terminal/knowledge/
 *   index.json          { version, enabled, entries: [meta] }
 *   entries/<slug>.md   markdown body of one entry
 *
 * Availability in every session comes from two complementary channels:
 *   1. A generated block in ~/.claude/CLAUDE.md (read by both the chat SDK and
 *      the Claude CLI running in a terminal). Pinned entries go in full, the
 *      others only as a one-line index.
 *   2. The knowledge_* MCP tools, which read the same files on demand.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { dataDir, claudeDir } = require('../utils/paths');

const KNOWLEDGE_DIR = path.join(dataDir, 'knowledge');
const ENTRIES_DIR = path.join(KNOWLEDGE_DIR, 'entries');
const INDEX_FILE = path.join(KNOWLEDGE_DIR, 'index.json');
const GLOBAL_CLAUDE_MD = path.join(claudeDir, 'CLAUDE.md');

const BLOCK_START = '<!-- CLAUDE-TERMINAL:KNOWLEDGE:START -->';
const BLOCK_END = '<!-- CLAUDE-TERMINAL:KNOWLEDGE:END -->';

const CATEGORIES = ['server', 'service', 'person', 'convention', 'stack', 'other'];

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId() {
  return `kn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function slugify(title) {
  const base = String(title || '')
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return base || 'entry';
}

async function ensureDirs() {
  await fsp.mkdir(ENTRIES_DIR, { recursive: true });
}

/** Atomic write: temp file + rename, so a crash never truncates the target. */
async function atomicWriteText(filePath, text) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, filePath);
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(',').map(v => v.trim()).filter(Boolean);
  }
  return [];
}

// ── Index ────────────────────────────────────────────────────────────────────

const EMPTY_INDEX = { version: 1, enabled: true, entries: [] };

async function loadIndex() {
  try {
    const raw = await fsp.readFile(INDEX_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version || 1,
      enabled: parsed.enabled !== false,
      entries: Array.isArray(parsed.entries) ? parsed.entries : []
    };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('[Knowledge] index.json unreadable, starting empty:', e.message);
    }
    return { ...EMPTY_INDEX, entries: [] };
  }
}

async function saveIndex(index) {
  await ensureDirs();
  await atomicWriteText(INDEX_FILE, JSON.stringify(index, null, 2));
}

function findEntry(index, ref) {
  if (!ref) return null;
  const needle = String(ref).toLowerCase();
  return index.entries.find(e =>
    e.id === ref ||
    e.slug === needle ||
    (e.title || '').toLowerCase() === needle ||
    (e.aliases || []).some(a => a.toLowerCase() === needle)
  ) || null;
}

function entryFilePath(entry) {
  return path.join(ENTRIES_DIR, `${entry.slug}.md`);
}

async function readEntryContent(entry) {
  try {
    return await fsp.readFile(entryFilePath(entry), 'utf8');
  } catch {
    return '';
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** List entry metadata (no bodies). */
async function listEntries() {
  const index = await loadIndex();
  const entries = [...index.entries].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (a.title || '').localeCompare(b.title || '');
  });
  return { enabled: index.enabled, entries };
}

/** Read one entry, metadata + markdown body. */
async function getEntry(ref) {
  const index = await loadIndex();
  const entry = findEntry(index, ref);
  if (!entry) return null;
  return { ...entry, content: await readEntryContent(entry) };
}

/**
 * Create or update an entry. Matching is done on id first, then title/alias,
 * so writing twice with the same title updates instead of duplicating.
 */
async function writeEntry({ id, title, content, category, tags, aliases, summary, pinned }) {
  if (!title || !String(title).trim()) throw new Error('Title is required');

  await ensureDirs();
  const index = await loadIndex();
  const now = new Date().toISOString();
  const existing = id ? index.entries.find(e => e.id === id) : findEntry(index, title);

  if (existing) {
    const previousSlug = existing.slug;
    existing.title = String(title).trim();
    existing.slug = slugify(existing.title);

    // Keep slugs unique when a rename collides with another entry.
    if (index.entries.some(e => e.id !== existing.id && e.slug === existing.slug)) {
      existing.slug = `${existing.slug}-${existing.id.slice(-5)}`;
    }
    if (category !== undefined) existing.category = CATEGORIES.includes(category) ? category : 'other';
    if (tags !== undefined) existing.tags = normalizeList(tags);
    if (aliases !== undefined) existing.aliases = normalizeList(aliases);
    if (summary !== undefined) existing.summary = String(summary || '').trim();
    if (pinned !== undefined) existing.pinned = !!pinned;
    existing.updatedAt = now;

    const previousPath = path.join(ENTRIES_DIR, `${previousSlug}.md`);
    // On a rename with no new body, carry the old body over to the new file
    // before removing the old one — otherwise the entry loses its content.
    let body = content;
    if (body === undefined && previousSlug !== existing.slug) {
      try { body = await fsp.readFile(previousPath, 'utf8'); } catch { body = ''; }
    }
    if (body !== undefined) {
      await atomicWriteText(entryFilePath(existing), body);
    }
    if (previousSlug !== existing.slug) {
      try { await fsp.unlink(previousPath); } catch { /* already gone */ }
    }

    await saveIndex(index);
    await syncToClaudeMd();
    return existing;
  }

  const cleanTitle = String(title).trim();
  let slug = slugify(cleanTitle);
  const newEntry = {
    id: generateId(),
    title: cleanTitle,
    slug,
    category: CATEGORIES.includes(category) ? category : 'other',
    tags: normalizeList(tags),
    aliases: normalizeList(aliases),
    summary: String(summary || '').trim(),
    pinned: !!pinned,
    createdAt: now,
    updatedAt: now
  };
  if (index.entries.some(e => e.slug === slug)) {
    newEntry.slug = `${slug}-${newEntry.id.slice(-5)}`;
  }

  await atomicWriteText(entryFilePath(newEntry), content || `# ${cleanTitle}\n`);
  index.entries.push(newEntry);
  await saveIndex(index);
  await syncToClaudeMd();
  return newEntry;
}

async function deleteEntry(ref) {
  const index = await loadIndex();
  const entry = findEntry(index, ref);
  if (!entry) return false;

  index.entries = index.entries.filter(e => e.id !== entry.id);
  try { await fsp.unlink(entryFilePath(entry)); } catch { /* already gone */ }
  await saveIndex(index);
  await syncToClaudeMd();
  return true;
}

async function setPinned(ref, pinned) {
  const index = await loadIndex();
  const entry = findEntry(index, ref);
  if (!entry) return null;
  entry.pinned = !!pinned;
  entry.updatedAt = new Date().toISOString();
  await saveIndex(index);
  await syncToClaudeMd();
  return entry;
}

/** Enable/disable the whole CLAUDE.md injection without deleting anything. */
async function setEnabled(enabled) {
  const index = await loadIndex();
  index.enabled = !!enabled;
  await saveIndex(index);
  await syncToClaudeMd();
  return index.enabled;
}

/** Case-insensitive search over title, aliases, tags, summary and body. */
async function searchEntries(query) {
  const index = await loadIndex();
  const needle = String(query || '').toLowerCase().trim();
  if (!needle) return [];

  const results = [];
  for (const entry of index.entries) {
    const inTitle = (entry.title || '').toLowerCase().includes(needle);
    const inAlias = (entry.aliases || []).some(a => a.toLowerCase().includes(needle));
    const inTags = (entry.tags || []).some(t => t.toLowerCase().includes(needle));
    const inSummary = (entry.summary || '').toLowerCase().includes(needle);
    const content = await readEntryContent(entry);
    const inContent = content.toLowerCase().includes(needle);

    if (inTitle || inAlias || inTags || inSummary || inContent) {
      results.push({
        ...entry,
        matchIn: [
          inTitle ? 'title' : null,
          inAlias ? 'aliases' : null,
          inTags ? 'tags' : null,
          inSummary ? 'summary' : null,
          inContent ? 'content' : null
        ].filter(Boolean),
        snippet: inContent ? extractSnippet(content, needle) : (entry.summary || '')
      });
    }
  }
  return results;
}

function extractSnippet(text, needle, maxLen = 160) {
  const idx = text.toLowerCase().indexOf(needle);
  if (idx === -1) return text.slice(0, maxLen).replace(/\n/g, ' ').trim();
  const start = Math.max(0, idx - 50);
  const end = Math.min(text.length, idx + needle.length + 90);
  let snippet = text.slice(start, end).replace(/\n/g, ' ').trim();
  if (start > 0) snippet = `...${snippet}`;
  if (end < text.length) snippet = `${snippet}...`;
  return snippet;
}

// ── CLAUDE.md sync ───────────────────────────────────────────────────────────

/**
 * Build the markdown block injected into the global CLAUDE.md.
 * Pinned entries are inlined in full; the rest is a compact index Claude can
 * expand on demand through the knowledge_get MCP tool.
 */
async function buildContextBlock() {
  const index = await loadIndex();
  if (!index.enabled || index.entries.length === 0) return '';

  const pinned = index.entries.filter(e => e.pinned);
  const rest = index.entries.filter(e => !e.pinned);
  const lines = [
    '# Global Knowledge (Claude Terminal)',
    '',
    'Facts shared across every project of this machine. Managed by Claude Terminal —',
    'do not edit this block by hand, it is regenerated on every change.',
    ''
  ];

  if (pinned.length) {
    lines.push('## Always loaded', '');
    for (const entry of pinned) {
      const content = (await readEntryContent(entry)).trim();
      const aliases = (entry.aliases || []).length ? ` (also called: ${entry.aliases.join(', ')})` : '';
      lines.push(`### ${entry.title}${aliases}`);
      if (entry.summary) lines.push(`_${entry.summary}_`, '');
      if (content) lines.push(content, '');
    }
  }

  if (rest.length) {
    lines.push('## Available on demand', '');
    lines.push(
      'Read one with the `knowledge_get` tool (MCP server `claude-terminal`), or find one',
      'with `knowledge_search`. Read the relevant entry BEFORE answering a question that',
      'touches it — the one-liners below are only pointers, not the full facts.',
      ''
    );
    for (const entry of rest) {
      const aliases = (entry.aliases || []).length ? ` (aka ${entry.aliases.join(', ')})` : '';
      const tags = (entry.tags || []).length ? ` [${entry.tags.join(', ')}]` : '';
      const summary = entry.summary ? ` — ${entry.summary}` : '';
      lines.push(`- **${entry.title}**${aliases}${tags}${summary}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Write the generated block into ~/.claude/CLAUDE.md between markers, leaving
 * every hand-written line of that file untouched. An empty block removes the
 * section entirely.
 */
async function syncToClaudeMd() {
  const block = await buildContextBlock();

  let existing = '';
  try {
    existing = await fsp.readFile(GLOBAL_CLAUDE_MD, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const startIdx = existing.indexOf(BLOCK_START);
  const endIdx = existing.indexOf(BLOCK_END);
  const hasBlock = startIdx !== -1 && endIdx !== -1 && endIdx > startIdx;

  const wrapped = block ? `${BLOCK_START}\n${block}\n${BLOCK_END}` : '';
  let next;

  if (hasBlock) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + BLOCK_END.length);
    next = wrapped
      ? `${before}${wrapped}${after}`
      : `${before.replace(/\n+$/, '\n')}${after.replace(/^\n+/, '')}`;
  } else if (wrapped) {
    const separator = existing && !existing.endsWith('\n') ? '\n\n' : existing ? '\n' : '';
    next = `${existing}${separator}${wrapped}\n`;
  } else {
    return { synced: false, path: GLOBAL_CLAUDE_MD };
  }

  // Keep a single backup of the previous state before rewriting a user file.
  if (existing) {
    try { await fsp.writeFile(`${GLOBAL_CLAUDE_MD}.bak`, existing, 'utf8'); } catch { /* best effort */ }
  }
  await atomicWriteText(GLOBAL_CLAUDE_MD, next);
  return { synced: true, path: GLOBAL_CLAUDE_MD };
}

module.exports = {
  CATEGORIES,
  listEntries,
  getEntry,
  writeEntry,
  deleteEntry,
  setPinned,
  setEnabled,
  searchEntries,
  buildContextBlock,
  syncToClaudeMd,
  // Exposed for tests
  _paths: { KNOWLEDGE_DIR, ENTRIES_DIR, INDEX_FILE, GLOBAL_CLAUDE_MD },
  _markers: { BLOCK_START, BLOCK_END }
};
