'use strict';

/**
 * Knowledge Tools Module for Claude Terminal MCP
 *
 * Global knowledge base: facts that hold across every project (a dedicated
 * server, a VPS, a domain, a client, an internal convention). The same files
 * back the Global Knowledge section of the app's Memory panel.
 *
 * Storage: CT_DATA_DIR/knowledge/index.json + knowledge/entries/<slug>.md
 */

const fs = require('fs');
const path = require('path');

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:knowledge] ${args.join(' ')}\n`);
}

// -- Data access --------------------------------------------------------------

const CATEGORIES = ['server', 'service', 'person', 'convention', 'stack', 'other'];

function knowledgeDir() {
  return path.join(process.env.CT_DATA_DIR || '', 'knowledge');
}

function entriesDir() {
  return path.join(knowledgeDir(), 'entries');
}

function indexFile() {
  return path.join(knowledgeDir(), 'index.json');
}

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

function atomicWriteText(filePath, text) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, filePath);
}

function loadIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    return {
      version: parsed.version || 1,
      enabled: parsed.enabled !== false,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch (e) {
    if (e.code !== 'ENOENT') log('index.json unreadable:', e.message);
    return { version: 1, enabled: true, entries: [] };
  }
}

function saveIndex(index) {
  atomicWriteText(indexFile(), JSON.stringify(index, null, 2));
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

function readContent(entry) {
  try {
    return fs.readFileSync(path.join(entriesDir(), `${entry.slug}.md`), 'utf8');
  } catch {
    return '';
  }
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(v => v.trim()).filter(Boolean);
  return [];
}

function extractSnippet(text, needle, maxLen) {
  maxLen = maxLen || 160;
  const idx = text.toLowerCase().indexOf(needle);
  if (idx === -1) return text.slice(0, maxLen).replace(/\n/g, ' ').trim();
  const start = Math.max(0, idx - 50);
  const end = Math.min(text.length, idx + needle.length + 90);
  let snippet = text.slice(start, end).replace(/\n/g, ' ').trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';
  return snippet;
}

function formatMeta(entry) {
  const parts = [];
  if (entry.category) parts.push(`category: ${entry.category}`);
  if ((entry.aliases || []).length) parts.push(`aliases: ${entry.aliases.join(', ')}`);
  if ((entry.tags || []).length) parts.push(`tags: ${entry.tags.join(', ')}`);
  if (entry.pinned) parts.push('pinned: always loaded');
  return parts.join(' | ');
}

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'knowledge_list',
    description: 'List every entry of the global knowledge base — facts that apply across ALL projects (dedicated servers, VPS, domains, clients, internal conventions). Returns titles, aliases, categories and summaries, not full bodies. Use knowledge_get to read one.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: `Optional filter: ${CATEGORIES.join(', ')}` },
        tag: { type: 'string', description: 'Optional tag filter' },
      },
    },
  },
  {
    name: 'knowledge_get',
    description: 'Read one entry of the global knowledge base in full. Call this BEFORE answering a question that touches a machine, service, client or convention listed by knowledge_list — the index one-liners are pointers, not the facts.',
    inputSchema: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: 'Entry title, alias, slug or ID' },
      },
      required: ['entry'],
    },
  },
  {
    name: 'knowledge_search',
    description: 'Search the global knowledge base (titles, aliases, tags, summaries and bodies) and return matching entries with snippets. Use it when the user mentions something that sounds like shared infrastructure or a recurring entity but you do not know which entry covers it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'knowledge_write',
    description: 'Create or update an entry in the global knowledge base. Use it when the user states a durable, cross-project fact (server IP, deploy procedure, client context, naming convention). An entry with the same title is updated, not duplicated. Do NOT store secrets, passwords or private keys.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Entry title, e.g. "Dedicated server OVH"' },
        content: { type: 'string', description: 'Markdown body with the facts' },
        summary: { type: 'string', description: 'One-line summary shown in the always-loaded index' },
        category: { type: 'string', description: `One of: ${CATEGORIES.join(', ')}` },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
        aliases: { type: 'array', items: { type: 'string' }, description: 'Other names the user calls it, e.g. "le dédié", "prod"' },
        pinned: { type: 'boolean', description: 'If true the full body is injected into every session instead of only the index line. Keep it for short, high-value entries.' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'knowledge_delete',
    description: 'Delete an entry from the global knowledge base. Only use it when the user explicitly asks to forget something.',
    inputSchema: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: 'Entry title, alias, slug or ID' },
      },
      required: ['entry'],
    },
  },
];

// -- Tool handler -------------------------------------------------------------

async function handle(name, args) {
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  try {
    if (!process.env.CT_DATA_DIR) {
      return fail('CT_DATA_DIR is not set, cannot reach the knowledge base.');
    }

    // ── knowledge_list ──────────────────────────────────────────────────
    if (name === 'knowledge_list') {
      const index = loadIndex();
      let entries = index.entries;

      if (args.category) {
        const cat = String(args.category).toLowerCase();
        entries = entries.filter(e => (e.category || '').toLowerCase() === cat);
      }
      if (args.tag) {
        const tag = String(args.tag).toLowerCase();
        entries = entries.filter(e => (e.tags || []).some(t => t.toLowerCase() === tag));
      }

      if (!entries.length) return ok('The global knowledge base is empty.');

      entries = [...entries].sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return (a.title || '').localeCompare(b.title || '');
      });

      const lines = entries.map(e => {
        const meta = formatMeta(e);
        const parts = [`${e.pinned ? '📌 ' : ''}${e.title}`];
        if (meta) parts.push(`  ${meta}`);
        if (e.summary) parts.push(`  ${e.summary}`);
        return parts.join('\n');
      });

      return ok(
        `Global knowledge (${entries.length} entries)` +
        (index.enabled ? '' : ' — injection into CLAUDE.md is currently disabled') +
        `:\n\n${lines.join('\n\n')}\n\nRead one in full with knowledge_get.`
      );
    }

    // ── knowledge_get ───────────────────────────────────────────────────
    if (name === 'knowledge_get') {
      if (!args.entry) return fail('Missing required parameter: entry');

      const index = loadIndex();
      const entry = findEntry(index, args.entry);
      if (!entry) {
        const available = index.entries.map(e => e.title).join(', ');
        return fail(`Entry "${args.entry}" not found. Available: ${available || 'none'}`);
      }

      const meta = formatMeta(entry);
      let output = `# ${entry.title}\n`;
      if (meta) output += `${meta}\n`;
      if (entry.summary) output += `\n${entry.summary}\n`;
      output += `\n---\n\n${readContent(entry).trim()}\n`;
      return ok(output);
    }

    // ── knowledge_search ────────────────────────────────────────────────
    if (name === 'knowledge_search') {
      if (!args.query) return fail('Missing required parameter: query');

      const index = loadIndex();
      const needle = String(args.query).toLowerCase();
      const results = [];

      for (const entry of index.entries) {
        const inTitle = (entry.title || '').toLowerCase().includes(needle);
        const inAlias = (entry.aliases || []).some(a => a.toLowerCase().includes(needle));
        const inTags = (entry.tags || []).some(t => t.toLowerCase().includes(needle));
        const inSummary = (entry.summary || '').toLowerCase().includes(needle);
        const content = readContent(entry);
        const inContent = content.toLowerCase().includes(needle);

        if (inTitle || inAlias || inTags || inSummary || inContent) {
          results.push({
            title: entry.title,
            matchIn: [
              inTitle ? 'title' : null,
              inAlias ? 'aliases' : null,
              inTags ? 'tags' : null,
              inSummary ? 'summary' : null,
              inContent ? 'content' : null,
            ].filter(Boolean),
            snippet: inContent ? extractSnippet(content, needle) : (entry.summary || ''),
          });
        }
      }

      if (!results.length) return ok(`No knowledge entry matching "${args.query}".`);

      const lines = results.map(r => {
        const parts = [r.title];
        parts.push(`  Matched in: ${r.matchIn.join(', ')}`);
        if (r.snippet) parts.push(`  ${r.snippet}`);
        return parts.join('\n');
      });

      return ok(`Knowledge matches for "${args.query}" (${results.length}):\n\n${lines.join('\n\n')}`);
    }

    // ── knowledge_write ─────────────────────────────────────────────────
    if (name === 'knowledge_write') {
      if (!args.title) return fail('Missing required parameter: title');
      if (args.content === undefined) return fail('Missing required parameter: content');

      const index = loadIndex();
      const now = new Date().toISOString();
      const existing = findEntry(index, args.title);

      if (existing) {
        const previousSlug = existing.slug;
        existing.title = String(args.title).trim();
        existing.slug = slugify(existing.title);
        if (index.entries.some(e => e.id !== existing.id && e.slug === existing.slug)) {
          existing.slug = `${existing.slug}-${existing.id.slice(-5)}`;
        }
        if (args.category !== undefined) {
          existing.category = CATEGORIES.includes(args.category) ? args.category : 'other';
        }
        if (args.tags !== undefined) existing.tags = normalizeList(args.tags);
        if (args.aliases !== undefined) existing.aliases = normalizeList(args.aliases);
        if (args.summary !== undefined) existing.summary = String(args.summary || '').trim();
        if (args.pinned !== undefined) existing.pinned = !!args.pinned;
        existing.updatedAt = now;

        atomicWriteText(path.join(entriesDir(), `${existing.slug}.md`), args.content);
        if (previousSlug !== existing.slug) {
          try { fs.unlinkSync(path.join(entriesDir(), `${previousSlug}.md`)); } catch { /* already gone */ }
        }
        saveIndex(index);
        syncToClaudeMd(index);

        return ok(`Knowledge entry updated: "${existing.title}"${existing.pinned ? ' (pinned — loaded in every session)' : ''}.`);
      }

      const cleanTitle = String(args.title).trim();
      const entry = {
        id: generateId(),
        title: cleanTitle,
        slug: slugify(cleanTitle),
        category: CATEGORIES.includes(args.category) ? args.category : 'other',
        tags: normalizeList(args.tags),
        aliases: normalizeList(args.aliases),
        summary: String(args.summary || '').trim(),
        pinned: !!args.pinned,
        createdAt: now,
        updatedAt: now,
      };
      if (index.entries.some(e => e.slug === entry.slug)) {
        entry.slug = `${entry.slug}-${entry.id.slice(-5)}`;
      }

      atomicWriteText(path.join(entriesDir(), `${entry.slug}.md`), args.content);
      index.entries.push(entry);
      saveIndex(index);
      syncToClaudeMd(index);

      return ok(
        `Knowledge entry created: "${entry.title}" (${entry.category}).\n` +
        (entry.pinned
          ? 'Pinned: its full body is now loaded in every project session.'
          : 'Indexed: every session sees its one-line summary and can read it with knowledge_get.')
      );
    }

    // ── knowledge_delete ────────────────────────────────────────────────
    if (name === 'knowledge_delete') {
      if (!args.entry) return fail('Missing required parameter: entry');

      const index = loadIndex();
      const entry = findEntry(index, args.entry);
      if (!entry) return fail(`Entry "${args.entry}" not found.`);

      index.entries = index.entries.filter(e => e.id !== entry.id);
      try { fs.unlinkSync(path.join(entriesDir(), `${entry.slug}.md`)); } catch { /* already gone */ }
      saveIndex(index);
      syncToClaudeMd(index);

      return ok(`Knowledge entry deleted: "${entry.title}".`);
    }

    return fail(`Unknown knowledge tool: ${name}`);
  } catch (error) {
    log(`Error in ${name}:`, error.message);
    return fail(`Knowledge error: ${error.message}`);
  }
}

// -- CLAUDE.md sync -----------------------------------------------------------
//
// Mirrors src/main/services/KnowledgeService.js so an entry written from a chat
// or terminal session takes effect in the next session without the app running.

const BLOCK_START = '<!-- CLAUDE-TERMINAL:KNOWLEDGE:START -->';
const BLOCK_END = '<!-- CLAUDE-TERMINAL:KNOWLEDGE:END -->';

function buildContextBlock(index) {
  if (!index.enabled || !index.entries.length) return '';

  const pinned = index.entries.filter(e => e.pinned);
  const rest = index.entries.filter(e => !e.pinned);
  const lines = [
    '# Global Knowledge (Claude Terminal)',
    '',
    'Facts shared across every project of this machine. Managed by Claude Terminal —',
    'do not edit this block by hand, it is regenerated on every change.',
    '',
  ];

  if (pinned.length) {
    lines.push('## Always loaded', '');
    for (const entry of pinned) {
      const content = readContent(entry).trim();
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

function syncToClaudeMd(index) {
  try {
    const target = path.join(require('os').homedir(), '.claude', 'CLAUDE.md');
    const block = buildContextBlock(index);

    let existing = '';
    try { existing = fs.readFileSync(target, 'utf8'); } catch (e) {
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
      return;
    }

    if (existing) {
      try { fs.writeFileSync(target + '.bak', existing, 'utf8'); } catch { /* best effort */ }
    }
    atomicWriteText(target, next);
  } catch (e) {
    log('CLAUDE.md sync failed:', e.message);
  }
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {}

// -- Exports ------------------------------------------------------------------

module.exports = { tools, handle, cleanup };
