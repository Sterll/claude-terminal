/**
 * The note format of an Obsidian-compatible vault, as pure functions.
 *
 * A vault is a folder of Markdown files; everything here reads or writes the
 * text conventions Obsidian documents (help.obsidian.md: Internal links,
 * Embeds, Tags, Properties, Daily notes, Templates), so a note written by this
 * app reads the same in Obsidian and the other way round:
 *
 *   - frontmatter: a YAML block between `---` lines at the very top; only the
 *     subset notes actually use is read (scalars, inline `[a, b]` lists and
 *     `- item` lists), which is what `tags` and `aliases` need;
 *   - links: `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]`, `[[Note#^id]]`,
 *     embeds `![[...]]`, and Markdown links to a `.md` file, never inside code
 *     or a `%%comment%%`;
 *   - tags: `#tag`, `#nested/tag`, at least one non-digit, case-insensitive;
 *   - link resolution: Obsidian does not document its algorithm, so this is
 *     the order its behaviour shows: the vault path, then relative to the
 *     linking note, then a path suffix, then the bare name, shortest path
 *     first among several (the result says when it had to choose);
 *   - daily note paths: the Moment.js format of `.obsidian/daily-notes.json`,
 *     `/` in it making folders, month and day names in the given locale.
 *
 * Shared verbatim by the main process and the MCP server: no Node module, no
 * DOM, no I/O.
 */

'use strict';

const NOTE_EXT = '.md';

// ── Frontmatter ─────────────────────────────────────────────────────────────

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseScalarOrList(raw) {
  const v = raw.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map(unquote).filter(Boolean);
  }
  return unquote(v);
}

/**
 * Split a note into its frontmatter and its body.
 * @param {string} text
 * @returns {{ data: Object<string, string|string[]>, body: string, hasFrontmatter: boolean }}
 */
function parseFrontmatter(text) {
  const src = String(text || '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { data: {}, body: src, hasFrontmatter: false };
  const data = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      if (!Array.isArray(data[listKey])) data[listKey] = [];
      const v = unquote(item[1]);
      if (v) data[listKey].push(v);
      continue;
    }
    const kv = /^([A-Za-z0-9_\-. ]+):\s*(.*)$/.exec(line);
    if (!kv) { listKey = null; continue; }
    const key = kv[1].trim();
    if (kv[2].trim() === '') { data[key] = []; listKey = key; continue; }
    data[key] = parseScalarOrList(kv[2]);
    listKey = null;
  }
  return { data, body: src.slice(m[0].length), hasFrontmatter: true };
}

/** A frontmatter value as a list of strings, whatever shape it was written in. */
function asList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return value.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

// ── Links and tags ──────────────────────────────────────────────────────────

/** The body with code and comments blanked out, so their contents are never read as links or tags. */
function stripCode(body) {
  return String(body || '')
    .replace(/(^|\n)(```|~~~)[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)/g, '$1')
    .replace(/%%[\s\S]*?%%/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

/**
 * Every outgoing note link of a body.
 * @returns {Array<{ target: string, subpath: string, alias: string, embed: boolean }>}
 */
function extractLinks(body) {
  const text = stripCode(body);
  const out = [];
  const wiki = /(!?)\[\[([^\[\]|#^\n]*)((?:#[^\[\]|\n]*)?)(?:\|([^\[\]\n]*))?\]\]/g;
  let m;
  while ((m = wiki.exec(text))) {
    const target = m[2].trim();
    if (!target) continue; // [[#Heading]]: a link inside the same note
    out.push({ target, subpath: m[3] || '', alias: (m[4] || '').trim(), embed: m[1] === '!' });
  }
  const md = /(!?)\[([^\]\n]*)\]\(([^)\s]+)\)/g;
  while ((m = md.exec(text))) {
    let href = m[3];
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // a URL, not a note
    const hash = href.indexOf('#');
    const subpath = hash >= 0 ? href.slice(hash) : '';
    if (hash >= 0) href = href.slice(0, hash);
    try { href = decodeURIComponent(href); } catch { /* keep it as written */ }
    if (!href || !/\.md$/i.test(href)) continue;
    out.push({ target: href, subpath, alias: m[2].trim(), embed: m[1] === '!' });
  }
  return out;
}

const TAG_RE = /(^|[\s(,;])#([\p{L}\p{N}_\-/]+)/gu;

/** Tags of a note: frontmatter `tags` plus inline `#tags`, lowercased, without `#`. */
function extractTags(body, frontmatter = {}) {
  const tags = new Set();
  for (const t of asList(frontmatter.tags)) {
    const clean = t.replace(/^#/, '').trim().toLowerCase();
    if (clean && /\D/.test(clean)) tags.add(clean);
  }
  const text = stripCode(body);
  let m;
  while ((m = TAG_RE.exec(text))) {
    const tag = m[2].replace(/\/+$/, '').toLowerCase();
    if (tag && /[^\d/]/.test(tag)) tags.add(tag);
  }
  return [...tags];
}

// ── Paths ───────────────────────────────────────────────────────────────────

/**
 * A vault-relative note path in POSIX form, or null when it is not one this
 * app will touch: absolute, climbing out with `..`, inside a dot folder
 * (`.obsidian`, `.trash`, `.git`), or carrying a control character.
 * `.md` is added when missing.
 */
function normalizeNotePath(rel) {
  if (typeof rel !== 'string') return null;
  let p = rel.replace(/\\/g, '/').trim();
  if (!p || p.length > 512 || /[\u0000-\u001f\u007f]/.test(p)) return null;
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  const parts = p.split('/').filter((s) => s !== '');
  if (!parts.length) return null;
  for (const seg of parts) {
    if (seg === '.' || seg === '..' || seg.startsWith('.')) return null;
  }
  p = parts.join('/');
  if (!/\.md$/i.test(p)) p += NOTE_EXT;
  return p;
}

/** A note name safe as a file name everywhere Obsidian syncs to. */
function sanitizeNoteTitle(title) {
  return String(title || '')
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
}

function noteName(notePath) {
  const base = String(notePath).split('/').pop() || '';
  return base.replace(/\.md$/i, '');
}

function noteFolder(notePath) {
  const parts = String(notePath).split('/');
  parts.pop();
  return parts.join('/');
}

// ── Link resolution ─────────────────────────────────────────────────────────

/**
 * A lookup over the vault's notes, built once per scan.
 * @param {string[]} paths - vault-relative POSIX paths of every note
 */
function buildLinkIndex(paths) {
  const byPath = new Map();
  const byName = new Map();
  for (const p of paths) {
    byPath.set(p.toLowerCase(), p);
    const key = noteName(p).toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(p);
  }
  for (const list of byName.values()) list.sort(comparePaths);
  return { byPath, byName, paths };
}

function comparePaths(a, b) {
  return a.split('/').length - b.split('/').length || a.length - b.length || a.localeCompare(b);
}

function joinPosix(folder, rel) {
  const out = [];
  for (const seg of `${folder ? folder + '/' : ''}${rel}`.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

/**
 * Which note a link points to.
 * @returns {{ path: string|null, ambiguous: boolean }}
 */
function resolveLink(target, sourcePath, index) {
  let t = String(target || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!t) return { path: null, ambiguous: false };
  if (!/\.md$/i.test(t)) t += NOTE_EXT;
  const lower = t.toLowerCase();

  const exact = index.byPath.get(lower);
  if (exact) return { path: exact, ambiguous: false };

  if (sourcePath) {
    const rel = joinPosix(noteFolder(sourcePath), t);
    const hit = rel && index.byPath.get(rel.toLowerCase());
    if (hit) return { path: hit, ambiguous: false };
  }

  if (t.includes('/')) {
    const suffix = '/' + lower;
    const hits = index.paths.filter((p) => p.toLowerCase().endsWith(suffix)).sort(comparePaths);
    if (hits.length) return { path: hits[0], ambiguous: hits.length > 1 };
  }

  const hits = index.byName.get(noteName(t).toLowerCase());
  if (hits && hits.length) return { path: hits[0], ambiguous: hits.length > 1 };
  return { path: null, ambiguous: false };
}

/** How a note should be linked to from elsewhere: the bare name when unique, else its path. */
function linkTextFor(notePath, index) {
  const name = noteName(notePath);
  const hits = index ? index.byName.get(name.toLowerCase()) : null;
  if (!hits || hits.length <= 1) return name;
  return notePath.replace(/\.md$/i, '');
}

// ── Dates (Moment.js format subset) ─────────────────────────────────────────

function pad(n, width) { return String(n).padStart(width, '0'); }

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return { week: Math.ceil(((d - yearStart) / 86400000 + 1) / 7), year: d.getUTCFullYear() };
}

function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date - start) / 86400000);
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function intlName(date, locale, opts) {
  try { return new Intl.DateTimeFormat(locale || 'en', opts).format(date); } catch { return new Intl.DateTimeFormat('en', opts).format(date); }
}

const TOKEN_RE = /\[([^\]]*)\]|YYYY|YY|Q|MMMM|MMM|MM|M|DDDD|DDD|Do|DD|D|dddd|ddd|dd|d|E|GGGG|gggg|WW|W|ww|w|HH|H|hh|h|mm|m|ss|s|A|a|X|x/g;

/**
 * Format a date with a Moment.js format string, the way Obsidian's daily notes
 * and templates do. Month and day names come from `Intl` in `locale`, which is
 * what Moment's locale data matches for the common languages.
 */
function formatDate(date, format, locale = 'en') {
  const d = date instanceof Date ? date : new Date(date);
  return String(format || 'YYYY-MM-DD').replace(TOKEN_RE, (tok, literal) => {
    if (literal !== undefined) return literal;
    const h = d.getHours();
    switch (tok) {
      case 'YYYY': return String(d.getFullYear());
      case 'YY': return pad(d.getFullYear() % 100, 2);
      case 'Q': return String(Math.floor(d.getMonth() / 3) + 1);
      case 'MMMM': return intlName(d, locale, { month: 'long' });
      case 'MMM': return intlName(d, locale, { month: 'short' });
      case 'MM': return pad(d.getMonth() + 1, 2);
      case 'M': return String(d.getMonth() + 1);
      case 'DDDD': return pad(dayOfYear(d), 3);
      case 'DDD': return String(dayOfYear(d));
      case 'Do': return locale && !String(locale).startsWith('en') ? String(d.getDate()) : ordinal(d.getDate());
      case 'DD': return pad(d.getDate(), 2);
      case 'D': return String(d.getDate());
      case 'dddd': return intlName(d, locale, { weekday: 'long' });
      case 'ddd': return intlName(d, locale, { weekday: 'short' });
      case 'dd': return intlName(d, locale, { weekday: 'short' }).slice(0, 2);
      case 'd': return String(d.getDay());
      case 'E': return String(d.getDay() || 7);
      case 'GGGG': case 'gggg': return String(isoWeek(d).year);
      case 'WW': case 'ww': return pad(isoWeek(d).week, 2);
      case 'W': case 'w': return String(isoWeek(d).week);
      case 'HH': return pad(h, 2);
      case 'H': return String(h);
      case 'hh': return pad(h % 12 || 12, 2);
      case 'h': return String(h % 12 || 12);
      case 'mm': return pad(d.getMinutes(), 2);
      case 'm': return String(d.getMinutes());
      case 'ss': return pad(d.getSeconds(), 2);
      case 's': return String(d.getSeconds());
      case 'A': return h < 12 ? 'AM' : 'PM';
      case 'a': return h < 12 ? 'am' : 'pm';
      case 'X': return String(Math.floor(d.getTime() / 1000));
      case 'x': return String(d.getTime());
      default: return tok;
    }
  });
}

/** True when a format names months or days, so the locale changes the file name. */
function formatUsesNames(format) {
  return /MMM|ddd|dd(?!d)/.test(String(format || '').replace(/\[[^\]]*\]/g, ''));
}

/**
 * The vault-relative path of the daily note for `date`.
 * @param {{ folder?: string, format?: string }} config - `.obsidian/daily-notes.json`
 */
function dailyNotePath(config, date, locale = 'en') {
  const format = (config && typeof config.format === 'string' && config.format.trim()) || 'YYYY-MM-DD';
  const folder = (config && typeof config.folder === 'string' ? config.folder.trim() : '').replace(/^\/+|\/+$/g, '');
  const name = formatDate(date, format, locale);
  return normalizeNotePath(folder ? `${folder}/${name}` : name);
}

/**
 * Fill an Obsidian template: `{{title}}`, `{{date}}`, `{{time}}`, and
 * `{{date:FORMAT}}` / `{{time:FORMAT}}`.
 * @param {{ dateFormat?: string, timeFormat?: string }} [templatesConfig] - `.obsidian/templates.json`
 */
function fillTemplate(template, { title = '', date = new Date(), locale = 'en', templatesConfig = {} } = {}) {
  const dateFormat = templatesConfig.dateFormat || 'YYYY-MM-DD';
  const timeFormat = templatesConfig.timeFormat || 'HH:mm';
  return String(template || '').replace(/\{\{\s*(title|date|time)(?::([^}]*))?\s*\}\}/gi, (_, key, fmt) => {
    const k = key.toLowerCase();
    if (k === 'title') return title;
    return formatDate(date, (fmt && fmt.trim()) || (k === 'date' ? dateFormat : timeFormat), locale);
  });
}

// ── Writing ─────────────────────────────────────────────────────────────────

function yamlValue(v) {
  const s = String(v);
  return /^[\w\- ./]+$/.test(s) && !/^(true|false|null|yes|no|~)$/i.test(s) && !/^\d/.test(s) ? s : JSON.stringify(s);
}

/** A frontmatter block from an object of scalars and lists. */
function buildFrontmatter(data) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlValue(item)}`);
    } else {
      lines.push(`${key}: ${yamlValue(value)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

/**
 * Insert `block` at the end of the section headed `heading` (created at the
 * end of the note when absent), or at the end of the note when no heading is
 * given. Only ever adds text: nothing the user wrote is moved or rewritten.
 */
function appendUnderHeading(text, block, heading) {
  const src = String(text || '');
  const add = String(block || '').replace(/\s+$/, '');
  if (!add) return src;
  const end = src.length && !src.endsWith('\n') ? '\n' : '';
  if (!heading) return `${src}${end}${src.trim() ? '\n' : ''}${add}\n`;

  const h = String(heading).trim().replace(/^#+\s*/, '');
  const lines = src.split('\n');
  const headRe = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = headRe.exec(lines[i]);
    if (m && m[2].trim().toLowerCase() === h.toLowerCase()) { start = i; level = m[1].length; break; }
  }
  if (start < 0) {
    return `${src}${end}${src.trim() ? '\n' : ''}## ${h}\n\n${add}\n`;
  }
  let stop = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = headRe.exec(lines[i]);
    if (m && m[1].length <= level) { stop = i; break; }
  }
  let insertAt = stop;
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  const joined = [...before, '', add, ...(after.length ? [''] : [])];
  while (after.length && after[0].trim() === '') after.shift();
  return [...joined, ...after].join('\n').replace(/\n*$/, '\n');
}

module.exports = {
  NOTE_EXT,
  parseFrontmatter,
  asList,
  stripCode,
  extractLinks,
  extractTags,
  normalizeNotePath,
  sanitizeNoteTitle,
  noteName,
  noteFolder,
  buildLinkIndex,
  resolveLink,
  linkTextFor,
  formatDate,
  formatUsesNames,
  dailyNotePath,
  fillTemplate,
  buildFrontmatter,
  appendUnderHeading,
};
