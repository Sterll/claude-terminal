/**
 * CostService
 *
 * Puts a dollar figure on what Claude Code consumed on this machine, split by
 * account, project, model and day. The source is the transcripts Claude Code
 * already writes under `~/.claude/projects/**\/*.jsonl`: every assistant line
 * carries the `usage` block the API returned, so nothing has to be collected
 * that is not already on disk.
 *
 * The dollar figure is the API list price of those tokens (`model-pricing.js`).
 * On a subscription nothing is billed; the figure is the proxy for how much of
 * the plan's limit the tokens drew, and it is what `ccusage` reports too.
 *
 * Three things shaped this file:
 *
 *   - The transcripts do not say which account made a request. Two accounts
 *     share `~/.claude`, and only the credential store differs. Attribution is
 *     therefore reconstructed, most specific first: the account a chat session
 *     was started on (recorded here as it starts), the project's binding, then
 *     whichever account held the machine-wide login at that moment. The last one
 *     is only known from the moment this service first ran; anything older is
 *     attributed to the account live at that point and flagged as estimated.
 *
 *   - Claude Code writes one message several times as it streams, and the early
 *     copies carry a partial `output_tokens`. Keeping the first copy, as
 *     `ccusage` does, undercounts; each field keeps its maximum instead.
 *
 *   - The transcripts weigh hundreds of megabytes. The first scan reads them in
 *     chunks and yields between them so the main process keeps answering; after
 *     that, only the bytes appended since the last scan are read.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { costOf, priceFor, normalizeModelId } = require('../../shared/model-pricing');
const { encodeProjectPath } = require('../../shared/session-dirs');

const CHUNK_BYTES = 4 * 1024 * 1024;
const SESSION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const UNKNOWN_ACCOUNT = 'unknown';

function projectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function dataDir() {
  return path.join(os.homedir(), '.claude-terminal');
}

function timelineFile() {
  return path.join(dataDir(), 'cost', 'account-timeline.json');
}

// file path -> { size, mtimeMs, offset, dir, messages: Map<key, record> }
const _files = new Map();
let _scanPromise = null;
let _timeline = null;
// Set once the timeline file turns out to be unreadable: from then on it is
// never rewritten, so a half-written file cannot be replaced by an empty one.
let _timelineUnreadable = false;

// ── Account timeline ────────────────────────────────────────────────────────

function emptyTimeline(liveId) {
  return { version: 1, seededAt: Date.now(), live: [{ at: 0, id: liveId || null }], sessions: {} };
}

function currentLiveId() {
  try {
    const index = JSON.parse(fs.readFileSync(path.join(dataDir(), 'accounts', 'index.json'), 'utf8'));
    return index.liveId ?? index.activeId ?? null;
  } catch {
    return null;
  }
}

function loadTimeline() {
  if (_timeline) return _timeline;
  const file = timelineFile();
  if (!fs.existsSync(file)) {
    _timeline = emptyTimeline(currentLiveId());
    saveTimeline();
    return _timeline;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed.live) || typeof parsed.sessions !== 'object' || !parsed.sessions) {
      throw new Error('unexpected shape');
    }
    _timeline = parsed;
  } catch (err) {
    console.warn('[CostService] account timeline unreadable, attribution falls back to the live account:', err.message);
    _timelineUnreadable = true;
    _timeline = emptyTimeline(currentLiveId());
  }
  return _timeline;
}

function saveTimeline() {
  if (_timelineUnreadable || !_timeline) return;
  const file = timelineFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cutoff = Date.now() - SESSION_RETENTION_MS;
    for (const [id, entries] of Object.entries(_timeline.sessions)) {
      const last = entries[entries.length - 1];
      if (!last || last.at < cutoff) delete _timeline.sessions[id];
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(_timeline));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn('[CostService] could not save account timeline:', err.message);
  }
}

/**
 * The account now holding the machine-wide login changed.
 * @param {string|null} id
 */
function noteLiveAccount(id) {
  const timeline = loadTimeline();
  const last = timeline.live[timeline.live.length - 1];
  if (last && last.id === (id || null)) return;
  timeline.live.push({ at: Date.now(), id: id || null });
  saveTimeline();
}

/**
 * A chat session started, or restarted, on an account. `accountId` null means
 * it runs on the machine-wide login.
 * @param {string} sessionId - the CLI session id (the transcript's file name)
 * @param {string|null} accountId
 */
function noteSessionAccount(sessionId, accountId) {
  if (!sessionId) return;
  const timeline = loadTimeline();
  const entries = timeline.sessions[sessionId] || (timeline.sessions[sessionId] = []);
  const last = entries[entries.length - 1];
  if (last && last.accountId === (accountId || null)) return;
  entries.push({ at: Date.now(), accountId: accountId || null });
  saveTimeline();
}

function liveAt(timeline, t) {
  let id = null;
  for (const entry of timeline.live) {
    if (entry.at <= t) id = entry.id;
    else break;
  }
  return id;
}

function sessionAccountAt(timeline, sessionId, t) {
  const entries = sessionId && timeline.sessions[sessionId];
  if (!entries) return undefined;
  let hit;
  for (const entry of entries) {
    if (entry.at <= t) hit = entry;
    else break;
  }
  return hit;
}

// ── Transcript scanning ─────────────────────────────────────────────────────

async function listTranscripts(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.jsonl')) out.push(full);
    }
  }
  await walk(root);
  return out;
}

/**
 * Parse one transcript line into a usage record, or null.
 * @param {string} line
 */
function parseLine(line) {
  if (line.indexOf('"usage"') === -1) return null;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const message = obj?.message;
  const usage = message?.usage;
  if (!usage || obj.type !== 'assistant') return null;
  const model = message.model;
  if (!model || model === '<synthetic>') return null;
  const t = Date.parse(obj.timestamp);
  if (!Number.isFinite(t)) return null;

  const creation = usage.cache_creation || null;
  const write1h = creation?.ephemeral_1h_input_tokens || 0;
  const write5m = creation
    ? (creation.ephemeral_5m_input_tokens || 0)
    : (usage.cache_creation_input_tokens || 0);

  return {
    key: `${message.id || ''}:${obj.requestId || obj.uuid || ''}`,
    t,
    s: obj.sessionId || null,
    m: model,
    f: usage.speed === 'fast',
    i: usage.input_tokens || 0,
    o: usage.output_tokens || 0,
    w5: write5m,
    w1: write1h,
    r: usage.cache_read_input_tokens || 0,
  };
}

function mergeRecord(messages, rec) {
  const prev = messages.get(rec.key);
  if (!prev) {
    messages.set(rec.key, rec);
    return;
  }
  // Streaming copies of one message: every counter only grows.
  prev.i = Math.max(prev.i, rec.i);
  prev.o = Math.max(prev.o, rec.o);
  prev.w5 = Math.max(prev.w5, rec.w5);
  prev.w1 = Math.max(prev.w1, rec.w1);
  prev.r = Math.max(prev.r, rec.r);
}

const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));

/**
 * Read `file` from `state.offset` to its current end, one chunk at a time.
 * Only complete lines are consumed; a line still being written is left for the
 * next scan.
 */
async function readAppended(file, state, size) {
  const handle = await fs.promises.open(file, 'r');
  try {
    let position = state.offset;
    let carry = Buffer.alloc(0);
    while (position < size) {
      const length = Math.min(CHUNK_BYTES, size - position);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const lastNewline = buf.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        carry = buf;
        continue;
      }
      const text = buf.toString('utf8', 0, lastNewline);
      carry = buf.subarray(lastNewline + 1);
      for (const line of text.split('\n')) {
        const rec = parseLine(line);
        if (rec) mergeRecord(state.messages, rec);
      }
      state.offset = position - carry.length;
      await yieldToLoop();
    }
  } finally {
    await handle.close();
  }
}

async function scanOnce() {
  const root = projectsRoot();
  const files = await listTranscripts(root);
  const present = new Set(files);
  for (const file of _files.keys()) {
    if (!present.has(file)) _files.delete(file);
  }
  for (const file of files) {
    let stat;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      continue;
    }
    let state = _files.get(file);
    // A file that shrank was rewritten: start it over.
    if (state && stat.size < state.offset) state = null;
    if (!state) {
      state = {
        offset: 0,
        size: 0,
        mtimeMs: 0,
        dir: path.relative(root, file).split(path.sep)[0],
        messages: new Map(),
      };
      _files.set(file, state);
    }
    if (stat.size === state.size && stat.mtimeMs === state.mtimeMs) continue;
    try {
      await readAppended(file, state, stat.size);
    } catch (err) {
      console.warn(`[CostService] could not read ${file}:`, err.message);
    }
    state.size = stat.size;
    state.mtimeMs = stat.mtimeMs;
  }
}

/** Bring the in-memory index up to date. Concurrent callers share one scan. */
function scan() {
  if (!_scanPromise) {
    _scanPromise = scanOnce().finally(() => { _scanPromise = null; });
  }
  return _scanPromise;
}

// ── Report ──────────────────────────────────────────────────────────────────

function readProjects() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir(), 'projects.json'), 'utf8'));
    return Array.isArray(raw) ? raw : (raw.projects || []);
  } catch {
    return [];
  }
}

function readAccounts() {
  try {
    const index = JSON.parse(fs.readFileSync(path.join(dataDir(), 'accounts', 'index.json'), 'utf8'));
    return (index.accounts || []).map(a => ({ id: a.id, name: a.name, color: a.color || null }));
  } catch {
    return [];
  }
}

/**
 * A readable name for a transcript directory nobody registered as a project:
 * the encoded path minus the encoded home directory in front of it.
 */
function fallbackName(dir) {
  const home = encodeProjectPath(os.homedir());
  const rest = dir.startsWith(home) ? dir.slice(home.length).replace(/^-+/, '') : dir;
  return rest || dir;
}

function localDay(t) {
  const d = new Date(t);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function emptyTotals() {
  return { cost: 0, tokens: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 };
}

function addTo(totals, rec, cost) {
  totals.cost += cost;
  totals.input += rec.i;
  totals.output += rec.o;
  totals.cacheWrite += rec.w5 + rec.w1;
  totals.cacheRead += rec.r;
  totals.tokens += rec.i + rec.o + rec.w5 + rec.w1 + rec.r;
  totals.messages += 1;
}

/**
 * Aggregate every message whose timestamp falls in [from, to).
 *
 * @param {{ from?: number, to?: number, accountId?: string|null }} [range] - epoch ms,
 *   open-ended when omitted; `accountId` keeps only what is attributed to it
 * @returns {Promise<Object>}
 */
async function getReport({ from = 0, to = Infinity, accountId: onlyAccount = null } = {}) {
  await scan();
  const timeline = loadTimeline();

  const projects = readProjects();
  const byDir = new Map();
  for (const project of projects) {
    if (!project?.path) continue;
    byDir.set(encodeProjectPath(project.path), project);
  }

  const accounts = readAccounts();
  const knownAccounts = new Set(accounts.map(a => a.id));

  const totals = emptyTotals();
  const accountsAgg = new Map();
  const projectsAgg = new Map();
  const modelsAgg = new Map();
  const daysAgg = new Map();
  const unpriced = new Set();
  let estimatedCost = 0;
  let firstSeen = Infinity;
  let lastSeen = 0;

  for (const state of _files.values()) {
    const project = byDir.get(state.dir) || null;
    const binding = project?.accountId || null;
    for (const rec of state.messages.values()) {
      if (rec.t < from || rec.t >= to) continue;
      // Attribution, most specific first.
      let accountId;
      let estimated = false;
      const session = sessionAccountAt(timeline, rec.s, rec.t);
      if (session && session.accountId) {
        accountId = session.accountId;
      } else if (!session && binding) {
        accountId = binding;
      } else {
        accountId = liveAt(timeline, rec.t);
        if (rec.t < timeline.seededAt) estimated = true;
      }
      if (!accountId || !knownAccounts.has(accountId)) accountId = UNKNOWN_ACCOUNT;
      if (onlyAccount && accountId !== onlyAccount) continue;

      const cost = costOf(rec.m, { input: rec.i, output: rec.o, cacheWrite5m: rec.w5, cacheWrite1h: rec.w1, cacheRead: rec.r }, { fast: rec.f });
      if (cost === null) unpriced.add(rec.m);
      const value = cost || 0;
      if (estimated) estimatedCost += value;

      addTo(totals, rec, value);
      firstSeen = Math.min(firstSeen, rec.t);
      lastSeen = Math.max(lastSeen, rec.t);

      if (!accountsAgg.has(accountId)) accountsAgg.set(accountId, emptyTotals());
      addTo(accountsAgg.get(accountId), rec, value);

      if (!projectsAgg.has(state.dir)) {
        projectsAgg.set(state.dir, {
          ...emptyTotals(),
          key: state.dir,
          projectId: project?.id || null,
          name: project?.name || fallbackName(state.dir),
          boundAccountId: binding,
          byAccount: {},
        });
      }
      const p = projectsAgg.get(state.dir);
      addTo(p, rec, value);
      p.byAccount[accountId] = (p.byAccount[accountId] || 0) + value;

      const modelId = normalizeModelId(rec.m);
      if (!modelsAgg.has(modelId)) {
        modelsAgg.set(modelId, { ...emptyTotals(), model: modelId, estimatedPrice: !!priceFor(rec.m)?.estimated });
      }
      addTo(modelsAgg.get(modelId), rec, value);

      const day = localDay(rec.t);
      if (!daysAgg.has(day)) daysAgg.set(day, { date: day, cost: 0, byAccount: {} });
      const d = daysAgg.get(day);
      d.cost += value;
      d.byAccount[accountId] = (d.byAccount[accountId] || 0) + value;
    }
  }

  const byCost = (a, b) => b.cost - a.cost;
  return {
    generatedAt: Date.now(),
    range: { from: Number.isFinite(from) ? from : null, to: Number.isFinite(to) ? to : null },
    firstSeen: Number.isFinite(firstSeen) ? firstSeen : null,
    lastSeen: lastSeen || null,
    totals,
    accounts,
    byAccount: [...accountsAgg.entries()].map(([id, agg]) => ({ id, ...agg })).sort(byCost),
    byProject: [...projectsAgg.values()].sort(byCost),
    byModel: [...modelsAgg.values()].sort(byCost),
    byDay: [...daysAgg.values()].sort((a, b) => a.date.localeCompare(b.date)),
    attribution: { trackedSince: timeline.seededAt, estimatedCost },
    unpricedModels: [...unpriced],
  };
}

/** Test hook: forget everything held in memory. */
function _reset() {
  _files.clear();
  _timeline = null;
  _timelineUnreadable = false;
  _scanPromise = null;
}

module.exports = {
  getReport,
  scan,
  noteLiveAccount,
  noteSessionAccount,
  UNKNOWN_ACCOUNT,
  _reset,
  _parseLine: parseLine,
};
