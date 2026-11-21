/**
 * Reading and writing an Obsidian-compatible vault on disk.
 *
 * Shared verbatim by the main process (VaultService, behind the vault IPC)
 * and the MCP server (tools/vault.js), the way artifact-store.js is, so both
 * see the same notes through the same rules:
 *
 *   - Nothing outside the vault: every path is a vault-relative note path
 *     (`normalizeNotePath`: no `..`, no absolute path, no dot folder), then
 *     checked again after `realpath`, so a symlink inside the vault cannot
 *     lead out of it. Symlinks are not followed while scanning either.
 *   - Dot folders are never read or written: `.obsidian` (Obsidian's own
 *     settings, read for its conventions and never written), `.trash`, `.git`.
 *     Neither are the folders listed in Obsidian's "Excluded files".
 *   - Writes only add: a new note never replaces an existing one (a free name
 *     is found instead), and the daily note is appended to under a heading,
 *     re-read just before the write. Writes are atomic (a dot-named temp file
 *     renamed over), which Obsidian picks up like its own saves.
 *   - The `.obsidian/*.json` files are undocumented: an unreadable one means
 *     its defaults, never an error and never a rewrite.
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fmt = require('./vault-format');

const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_NOTES = 20000;
const SCAN_YIELD_EVERY = 250;

// ── Vault settings (.obsidian, read only) ───────────────────────────────────

async function readJson(file) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

async function isDirectory(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

/**
 * The conventions the vault's Obsidian settings ask for, with Obsidian's own
 * defaults where a file is missing or unreadable.
 */
async function readVaultSettings(root) {
  const dir = path.join(root, '.obsidian');
  const isObsidian = await isDirectory(dir);
  const app = (isObsidian && await readJson(path.join(dir, 'app.json'))) || {};
  const daily = (isObsidian && await readJson(path.join(dir, 'daily-notes.json'))) || {};
  const templates = (isObsidian && await readJson(path.join(dir, 'templates.json'))) || {};
  const core = (isObsidian && await readJson(path.join(dir, 'core-plugins.json'))) || null;
  const coreEnabled = (id) => {
    if (!core) return null;
    if (Array.isArray(core)) return core.includes(id);
    return typeof core[id] === 'boolean' ? core[id] : null;
  };
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    isObsidian,
    useMarkdownLinks: app.useMarkdownLinks === true,
    newFileLocation: ['root', 'current', 'folder'].includes(app.newFileLocation) ? app.newFileLocation : 'root',
    newFileFolderPath: str(app.newFileFolderPath),
    ignoreFilters: Array.isArray(app.userIgnoreFilters) ? app.userIgnoreFilters.filter((s) => typeof s === 'string') : [],
    daily: { folder: str(daily.folder), format: str(daily.format) || 'YYYY-MM-DD', template: str(daily.template), enabled: coreEnabled('daily-notes') },
    templates: { folder: str(templates.folder), dateFormat: str(templates.dateFormat) || 'YYYY-MM-DD', timeFormat: str(templates.timeFormat) || 'HH:mm' },
  };
}

/** A matcher for Obsidian's "Excluded files": folder or file paths, or `/regex/`. */
function ignoreMatcher(filters) {
  const tests = [];
  for (const f of filters || []) {
    const s = String(f).trim();
    if (!s) continue;
    const re = /^\/(.+)\/([a-z]*)$/.exec(s);
    if (re) {
      try { const r = new RegExp(re[1], re[2].replace(/[^imsu]/g, '')); tests.push((p) => r.test(p)); } catch { /* an invalid pattern excludes nothing */ }
      continue;
    }
    const prefix = s.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
    if (prefix) tests.push((p) => { const l = p.toLowerCase(); return l === prefix || l.startsWith(prefix + '/') || l === prefix + '.md'; });
  }
  return (p) => tests.some((t) => t(p));
}

// ── Which folder may be a vault ─────────────────────────────────────────────

/**
 * Whether a folder may be the vault: an existing directory, and none of the
 * places whose Markdown files are not notes or must not be offered to a model
 * wholesale (a filesystem root, the home folder itself, this app's data
 * folder, Claude's own folder, `~/.ssh`). Checked by main when connecting and
 * again by the MCP server before every use, since both read vault.json.
 */
function isAcceptableVaultRoot(dir, { home = os.homedir() } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\0')) return false;
  const resolved = path.resolve(dir);
  if (path.parse(resolved).root === resolved) return false;
  const inside = (base, p) => { const r = path.relative(base, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  if (path.relative(resolved, home) === '') return false;
  for (const name of ['.claude-terminal', '.claude', '.ssh', '.aws', '.gnupg']) {
    if (inside(path.join(home, name), resolved)) return false;
  }
  try { return fs.statSync(resolved).isDirectory(); } catch { return false; }
}

// ── Containment ─────────────────────────────────────────────────────────────

async function realRoot(root) {
  return fsp.realpath(root);
}

function within(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The absolute path of a vault note, or null when `rel` is not a note path or
 * leads outside the vault once symlinks are resolved. For a note that does not
 * exist yet, its nearest existing folder is what is checked.
 */
async function resolveNote(root, rel) {
  const note = fmt.normalizeNotePath(rel);
  if (!note) return null;
  const base = await realRoot(root);
  const abs = path.join(base, ...note.split('/'));
  let probe = abs;
  for (;;) {
    try {
      const real = await fsp.realpath(probe);
      if (!within(base, real)) return null;
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
  return { abs, rel: note };
}

// ── Scanning ────────────────────────────────────────────────────────────────

/**
 * Every note of the vault, without following symlinks, skipping dot folders
 * and excluded paths, up to `maxNotes`.
 * @returns {Promise<{ notes: Array<{ path: string, mtime: number, size: number }>, truncated: boolean }>}
 */
async function scanNotes(root, { maxNotes = DEFAULT_MAX_NOTES, ignore = () => false } = {}) {
  const notes = [];
  let truncated = false;
  let seen = 0;
  const walk = async (dirAbs, dirRel) => {
    let entries;
    try { entries = await fsp.readdir(dirAbs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (notes.length >= maxNotes) { truncated = true; return; }
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (ignore(rel)) continue;
      const abs = path.join(dirAbs, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue;
        await walk(abs, rel);
      } else if (e.isFile() && /\.md$/i.test(e.name)) {
        try {
          const st = await fsp.stat(abs);
          notes.push({ path: rel, mtime: st.mtimeMs, size: st.size });
        } catch { /* gone between readdir and stat */ }
        if (++seen % SCAN_YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
      }
    }
  };
  await walk(root, '');
  return { notes, truncated };
}

// ── Index ───────────────────────────────────────────────────────────────────

/**
 * Names, aliases, tags and links of every note, kept up to date by `refresh()`
 * which only re-reads notes whose size or mtime moved.
 */
class VaultIndex {
  constructor(root, { maxNotes = DEFAULT_MAX_NOTES } = {}) {
    this.root = root;
    this.maxNotes = maxNotes;
    this.notes = new Map(); // path -> { path, mtime, size, aliases, tags, links }
    this.settings = null;
    this.links = fmt.buildLinkIndex([]);
    this.backlinks = new Map(); // path -> Set(path)
    this.unresolved = new Map(); // target -> Set(path)
    this.truncated = false;
    this.refreshedAt = 0;
    this._refreshing = null;
  }

  refresh() {
    if (!this._refreshing) {
      this._refreshing = this._refresh().finally(() => { this._refreshing = null; });
    }
    return this._refreshing;
  }

  /** Refresh when the last one is older than `maxAgeMs`. */
  async ensureFresh(maxAgeMs = 15000) {
    if (Date.now() - this.refreshedAt > maxAgeMs) await this.refresh();
    return this;
  }

  async _refresh() {
    this.settings = await readVaultSettings(this.root);
    const ignore = ignoreMatcher(this.settings.ignoreFilters);
    const { notes, truncated } = await scanNotes(this.root, { maxNotes: this.maxNotes, ignore });
    this.truncated = truncated;
    const next = new Map();
    let read = 0;
    for (const n of notes) {
      const prev = this.notes.get(n.path);
      if (prev && prev.mtime === n.mtime && prev.size === n.size) { next.set(n.path, prev); continue; }
      const entry = { path: n.path, mtime: n.mtime, size: n.size, aliases: [], tags: [], links: [] };
      if (n.size <= MAX_NOTE_BYTES) {
        try {
          const text = await fsp.readFile(path.join(this.root, ...n.path.split('/')), 'utf8');
          const { data, body } = fmt.parseFrontmatter(text);
          entry.aliases = fmt.asList(data.aliases);
          entry.tags = fmt.extractTags(body, data);
          entry.links = fmt.extractLinks(body).map((l) => l.target);
        } catch { /* unreadable (an iCloud placeholder, a lock): indexed by name only */ }
      }
      next.set(n.path, entry);
      if (++read % SCAN_YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
    }
    this.notes = next;
    this.links = fmt.buildLinkIndex([...next.keys()]);
    const backlinks = new Map();
    const unresolved = new Map();
    for (const entry of next.values()) {
      for (const target of entry.links) {
        const { path: hit } = fmt.resolveLink(target, entry.path, this.links);
        if (hit) {
          if (hit === entry.path) continue;
          if (!backlinks.has(hit)) backlinks.set(hit, new Set());
          backlinks.get(hit).add(entry.path);
        } else {
          const key = target.toLowerCase();
          if (!unresolved.has(key)) unresolved.set(key, new Set());
          unresolved.get(key).add(entry.path);
        }
      }
    }
    this.backlinks = backlinks;
    this.unresolved = unresolved;
    this.refreshedAt = Date.now();
  }

  summary(entry) {
    return {
      path: entry.path,
      name: fmt.noteName(entry.path),
      folder: fmt.noteFolder(entry.path),
      mtime: entry.mtime,
      tags: entry.tags.slice(0, 8),
      aliases: entry.aliases.slice(0, 4),
      backlinks: this.backlinks.get(entry.path)?.size || 0,
    };
  }

  /**
   * Notes by name, alias, tag (`#tag`) or path. An empty query lists the most
   * recently modified ones.
   */
  search(query, { limit = 30 } = {}) {
    const q = String(query || '').trim().toLowerCase();
    const all = [...this.notes.values()];
    if (!q) {
      return all.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((e) => this.summary(e));
    }
    if (q.startsWith('#') && q.length > 1) {
      const tag = q.slice(1);
      return all
        .filter((e) => e.tags.some((t) => t === tag || t.startsWith(tag + '/')))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, limit)
        .map((e) => this.summary(e));
    }
    const words = q.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const e of all) {
      const name = fmt.noteName(e.path).toLowerCase();
      const p = e.path.toLowerCase();
      const aliases = e.aliases.map((a) => a.toLowerCase());
      let score = 0;
      if (name === q) score += 100;
      else if (name.startsWith(q)) score += 60;
      else if (name.includes(q)) score += 40;
      if (aliases.some((a) => a === q)) score += 80;
      else if (aliases.some((a) => a.includes(q))) score += 30;
      if (!score) {
        if (words.every((w) => p.includes(w) || aliases.some((a) => a.includes(w)) || e.tags.some((t) => t.includes(w)))) score += 15;
      }
      if (!score) continue;
      score += Math.min(10, (this.backlinks.get(e.path)?.size || 0));
      scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score || b.e.mtime - a.e.mtime);
    return scored.slice(0, limit).map(({ e }) => this.summary(e));
  }

  /**
   * Notes whose text contains every word of `query`, with the first matching
   * line. Reads the files, so it stops after `budgetMs`.
   */
  async searchContent(query, { limit = 20, budgetMs = 2500 } = {}) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return { results: [], partial: false };
    const started = Date.now();
    const results = [];
    let partial = false;
    const ordered = [...this.notes.values()].sort((a, b) => b.mtime - a.mtime);
    for (const e of ordered) {
      if (results.length >= limit) break;
      if (Date.now() - started > budgetMs) { partial = true; break; }
      if (e.size > MAX_NOTE_BYTES) continue;
      let text;
      try { text = await fsp.readFile(path.join(this.root, ...e.path.split('/')), 'utf8'); } catch { continue; }
      const lower = text.toLowerCase();
      if (!words.every((w) => lower.includes(w))) continue;
      const line = text.split('\n').find((l) => l.toLowerCase().includes(words[0])) || '';
      results.push({ ...this.summary(e), line: line.trim().slice(0, 200) });
    }
    return { results, partial };
  }

  backlinksOf(notePath) {
    return [...(this.backlinks.get(notePath) || [])].sort();
  }

  stats() {
    return {
      notes: this.notes.size,
      truncated: this.truncated,
      unresolved: this.unresolved.size,
      tags: new Set([...this.notes.values()].flatMap((e) => e.tags)).size,
      refreshedAt: this.refreshedAt,
    };
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * One note with what links to it and what it links to.
 * @returns {Promise<object|null>} null when the path is not a note of this vault
 */
async function readNote(index, rel) {
  const target = await resolveNote(index.root, rel);
  if (!target) return null;
  let st;
  try { st = await fsp.stat(target.abs); } catch { return null; }
  if (!st.isFile()) return null;
  if (st.size > MAX_NOTE_BYTES) return { path: target.rel, tooLarge: true, size: st.size };
  const content = await fsp.readFile(target.abs, 'utf8');
  const { data, body } = fmt.parseFrontmatter(content);
  const links = fmt.extractLinks(body).map((l) => ({
    target: l.target,
    alias: l.alias,
    embed: l.embed,
    path: fmt.resolveLink(l.target, target.rel, index.links).path,
  }));
  return {
    path: target.rel,
    name: fmt.noteName(target.rel),
    content,
    body,
    frontmatter: data,
    tags: fmt.extractTags(body, data),
    aliases: fmt.asList(data.aliases),
    links,
    backlinks: index.backlinksOf(target.rel),
    mtime: st.mtimeMs,
    size: st.size,
  };
}

// ── Writing ─────────────────────────────────────────────────────────────────

async function atomicWrite(abs, text) {
  const dir = path.dirname(abs);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.ct-${crypto.randomBytes(4).toString('hex')}.tmp`);
  await fsp.writeFile(tmp, text, 'utf8');
  try {
    await fsp.rename(tmp, abs);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

async function exists(abs) {
  try { await fsp.access(abs); return true; } catch { return false; }
}

/** A note path that does not exist yet: `Title.md`, else `Title 1.md`, `Title 2.md`... */
async function freeNotePath(root, folder, title) {
  const base = fmt.sanitizeNoteTitle(title) || 'Untitled';
  for (let i = 0; i < 1000; i++) {
    const name = i ? `${base} ${i}` : base;
    const target = await resolveNote(root, folder ? `${folder}/${name}` : name);
    if (!target) return null;
    if (!(await exists(target.abs))) return target;
  }
  return null;
}

/**
 * Create a new note. Never replaces one: a free name is chosen instead.
 * The folder defaults to Obsidian's "Default location for new notes".
 * @returns {Promise<{ path: string }>}
 */
async function createNote(index, { title, content = '', folder, frontmatter } = {}) {
  const settings = index.settings || await readVaultSettings(index.root);
  let dir = typeof folder === 'string' ? folder.trim().replace(/^\/+|\/+$/g, '') : null;
  if (dir === null) dir = settings.newFileLocation === 'folder' ? settings.newFileFolderPath.replace(/^\/+|\/+$/g, '') : '';
  if (dir && !fmt.normalizeNotePath(dir)) throw new Error('Invalid folder');
  const target = await freeNotePath(index.root, dir, title);
  if (!target) throw new Error('No usable note path');
  const head = frontmatter && Object.keys(frontmatter).length ? fmt.buildFrontmatter(frontmatter) : '';
  await atomicWrite(target.abs, `${head}${String(content).replace(/\s+$/, '')}\n`);
  return { path: target.rel };
}

/**
 * Append a block to the daily note of `date`, under `heading`, creating the
 * note from the vault's daily template when it does not exist yet. When the
 * format names months or days, a note already named in English or in `locale`
 * is reused rather than a second one created.
 * @returns {Promise<{ path: string, created: boolean }>}
 */
async function appendToDaily(index, { text, heading, date = new Date(), locale = 'en' } = {}) {
  if (!String(text || '').trim()) throw new Error('Nothing to append');
  const settings = await readVaultSettings(index.root);
  index.settings = settings;
  const candidates = [fmt.dailyNotePath(settings.daily, date, locale)];
  if (fmt.formatUsesNames(settings.daily.format) && locale !== 'en') candidates.push(fmt.dailyNotePath(settings.daily, date, 'en'));

  let target = null;
  for (const c of candidates) {
    const t = c && await resolveNote(index.root, c);
    if (t && await exists(t.abs)) { target = t; break; }
  }
  let created = false;
  let current = '';
  if (target) {
    current = await fsp.readFile(target.abs, 'utf8');
  } else {
    target = candidates[0] && await resolveNote(index.root, candidates[0]);
    if (!target) throw new Error('The daily note path is not inside the vault');
    created = true;
    if (settings.daily.template) {
      const tpl = await resolveNote(index.root, settings.daily.template);
      if (tpl && await exists(tpl.abs)) {
        const raw = await fsp.readFile(tpl.abs, 'utf8');
        current = fmt.fillTemplate(raw, { title: fmt.noteName(target.rel), date, locale, templatesConfig: settings.templates });
      }
    }
  }
  await atomicWrite(target.abs, fmt.appendUnderHeading(current, text, heading));
  return { path: target.rel, created };
}

module.exports = {
  MAX_NOTE_BYTES,
  isAcceptableVaultRoot,
  readVaultSettings,
  ignoreMatcher,
  resolveNote,
  scanNotes,
  VaultIndex,
  readNote,
  createNote,
  appendToDaily,
  atomicWrite,
};
