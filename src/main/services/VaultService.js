/**
 * The user's notes vault (Obsidian-compatible): which folder it is, and the
 * index over it that the Notes screen, the `@vault` mention and the session
 * brief's "save to today's note" go through.
 *
 * Which folder is the vault is decided here and only here. It is stored in
 * `~/.claude-terminal/vault.json`, a main-process file the renderer can
 * neither read nor write (rendererSecurity blocks it), and it only ever comes
 * from a folder dialog shown by main or from Obsidian's own list of vaults.
 * The renderer names notes by vault-relative path; it never names a folder,
 * and it gets no filesystem grant on the vault: every read and write is done
 * here, through src/shared/vault-store.js and its containment rules. The MCP
 * server reads the same file to find the vault (tools/vault.js).
 *
 * Obsidian itself is never required: the vault is plain Markdown. When it is
 * installed, its vault list (`obsidian.json`, read only) offers the vaults to
 * connect and "Open in Obsidian" hands a note to it over its URI scheme.
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { dataDir, settingsFile } = require('../utils/paths');
const store = require('../../shared/vault-store');
const fmt = require('../../shared/vault-format');

const CONFIG_FILE = path.join(dataDir, 'vault.json');
const DEFAULT_HEADING = 'Claude Terminal';

let config;          // undefined: not loaded yet; null: no vault
let configError = null;
let index = null;

// ── Config ──────────────────────────────────────────────────────────────────

function loadConfig() {
  if (config !== undefined) return config;
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    config = parsed && typeof parsed.path === 'string' ? parsed : null;
    configError = null;
  } catch (e) {
    // Absent is "no vault". Unreadable is reported, and the file is left
    // alone until the user connects a vault again on purpose.
    if (e.code !== 'ENOENT') configError = 'The vault settings file is unreadable';
    config = null;
  }
  return config;
}

function saveConfig(next) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  config = next;
  configError = null;
}

/** See vault-store.isAcceptableVaultRoot. */
function isAcceptableVault(dir) {
  return store.isAcceptableVaultRoot(dir);
}

function getIndex() {
  const cfg = loadConfig();
  if (!cfg) return null;
  if (!index || index.root !== cfg.path) index = new store.VaultIndex(cfg.path);
  return index;
}

// ── Obsidian's vault list (read only) ───────────────────────────────────────

function obsidianConfigCandidates() {
  const home = os.homedir();
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json')];
  if (process.platform === 'win32') return [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'obsidian', 'obsidian.json')];
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    path.join(xdg, 'obsidian', 'obsidian.json'),
    path.join(home, '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json'),
    path.join(home, 'snap', 'obsidian', 'current', '.config', 'obsidian', 'obsidian.json'),
  ];
}

/** The vaults Obsidian knows on this machine, most recently opened first. */
async function knownVaults() {
  const out = [];
  const seen = new Set();
  for (const file of obsidianConfigCandidates()) {
    let parsed;
    try { parsed = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { continue; }
    const vaults = parsed && typeof parsed.vaults === 'object' ? parsed.vaults : {};
    for (const [id, v] of Object.entries(vaults)) {
      if (!v || typeof v.path !== 'string' || seen.has(v.path)) continue;
      seen.add(v.path);
      out.push({ id, name: path.basename(v.path), path: v.path, ts: Number(v.ts) || 0, available: isAcceptableVault(v.path) });
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

// ── Connecting ──────────────────────────────────────────────────────────────

async function connect(dir) {
  if (!isAcceptableVault(dir)) throw new Error('This folder cannot be used as a vault');
  const root = await fsp.realpath(dir);
  const previous = loadConfig();
  saveConfig({
    path: root,
    connectedAt: new Date().toISOString(),
    mcpRead: previous?.mcpRead !== false,
    mcpWrite: false,
    dailyHeading: previous?.dailyHeading || DEFAULT_HEADING,
  });
  index = null;
  return status();
}

async function connectKnown(id) {
  const vault = (await knownVaults()).find((v) => v.id === id);
  if (!vault) throw new Error('Unknown vault');
  return connect(vault.path);
}

function disconnect() {
  try { fs.unlinkSync(CONFIG_FILE); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  config = null;
  configError = null;
  index = null;
  return { connected: false };
}

function setOptions({ mcpRead, mcpWrite, dailyHeading } = {}) {
  const cfg = loadConfig();
  if (!cfg) throw new Error('No vault connected');
  const next = { ...cfg };
  if (typeof mcpRead === 'boolean') next.mcpRead = mcpRead;
  if (typeof mcpWrite === 'boolean') next.mcpWrite = mcpWrite;
  if (typeof dailyHeading === 'string') next.dailyHeading = dailyHeading.replace(/[\r\n#]/g, ' ').trim().slice(0, 80) || DEFAULT_HEADING;
  saveConfig(next);
  return status();
}

// ── Queries ─────────────────────────────────────────────────────────────────

async function status({ refresh = false } = {}) {
  const cfg = loadConfig();
  if (!cfg) return { connected: false, error: configError };
  if (!isAcceptableVault(cfg.path)) {
    return { connected: true, missing: true, name: path.basename(cfg.path), path: cfg.path };
  }
  const idx = getIndex();
  if (refresh) await idx.refresh(); else await idx.ensureFresh();
  return {
    connected: true,
    missing: false,
    name: path.basename(cfg.path),
    path: cfg.path,
    isObsidian: idx.settings?.isObsidian || false,
    daily: idx.settings?.daily || null,
    mcpRead: cfg.mcpRead !== false,
    mcpWrite: cfg.mcpWrite === true,
    dailyHeading: cfg.dailyHeading || DEFAULT_HEADING,
    ...idx.stats(),
  };
}

async function requireIndex() {
  const idx = getIndex();
  if (!idx) throw new Error('No vault connected');
  if (!isAcceptableVault(idx.root)) throw new Error('The vault folder is missing');
  await idx.ensureFresh();
  return idx;
}

async function search(query, { content = false, limit = 30 } = {}) {
  const idx = await requireIndex();
  const q = String(query || '').slice(0, 200);
  if (content) return idx.searchContent(q, { limit: Math.min(50, limit) });
  // An empty query lists notes for the @vault dropdown, which filters them itself.
  return { results: idx.search(q, { limit: Math.min(q ? 200 : 5000, limit) }), partial: false };
}

async function read(notePath) {
  const idx = await requireIndex();
  const note = await store.readNote(idx, notePath);
  if (!note) throw new Error('Note not found');
  return note;
}

/** The note a link points to, from the note it is written in. */
async function resolve(target, fromPath) {
  const idx = await requireIndex();
  return fmt.resolveLink(target, fromPath || null, idx.links);
}

function appLanguage() {
  try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')).language || 'en'; } catch { return 'en'; }
}

async function appendDaily({ text, heading } = {}) {
  const idx = await requireIndex();
  const cfg = loadConfig();
  const block = String(text || '').slice(0, 20000);
  const result = await store.appendToDaily(idx, {
    text: block,
    heading: heading || cfg.dailyHeading || DEFAULT_HEADING,
    locale: appLanguage(),
  });
  idx.refreshedAt = 0;
  return result;
}

async function createNote({ title, content, folder, tags } = {}) {
  const idx = await requireIndex();
  const frontmatter = {};
  const tagList = Array.isArray(tags) ? tags.map((t) => String(t).replace(/^#/, '').trim()).filter((t) => /^[\p{L}\p{N}_\-/]+$/u.test(t)).slice(0, 10) : [];
  if (tagList.length) frontmatter.tags = tagList;
  frontmatter.created = new Date().toISOString().slice(0, 10);
  frontmatter.source = 'Claude Terminal';
  const result = await store.createNote(idx, {
    title,
    content: String(content || '').slice(0, 200000),
    folder: typeof folder === 'string' ? folder : undefined,
    frontmatter,
  });
  idx.refreshedAt = 0;
  return result;
}

/**
 * The `obsidian://open` URI for a note of the vault. The note is checked to be
 * inside the vault first; the URI only ever carries its absolute path.
 */
async function obsidianUri(notePath) {
  const idx = await requireIndex();
  const target = await store.resolveNote(idx.root, notePath);
  if (!target) throw new Error('Note not found');
  return `obsidian://open?path=${encodeURIComponent(target.abs)}`;
}

function vaultRoot() {
  const cfg = loadConfig();
  return cfg && isAcceptableVault(cfg.path) ? cfg.path : null;
}

/** For tests: forget what was loaded. */
function _reset() {
  config = undefined;
  configError = null;
  index = null;
}

module.exports = {
  CONFIG_FILE,
  DEFAULT_HEADING,
  isAcceptableVault,
  knownVaults,
  connect,
  connectKnown,
  disconnect,
  setOptions,
  status,
  search,
  read,
  resolve,
  appendDaily,
  createNote,
  obsidianUri,
  vaultRoot,
  _reset,
};
