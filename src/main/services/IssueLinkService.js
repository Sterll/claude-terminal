'use strict';
/**
 * Which tickets belong to which Claude session.
 *
 * `~/.claude-terminal/issue-links.json`, keyed by session. A chat tab has no
 * CLI session id until its first message, so a tab starts under a provisional
 * key (`tab:<id>`) and is `rekey`ed to the real id when the CLI reports it; a
 * fork `copy`s its parent's links instead, the parent keeping its own.
 *
 * Each link has a status:
 * - `linked`: shown in the session's Tickets tab.
 * - `suggested`: found by automatic detection, waiting for the user to say
 *   yes in the chat. Never shown as linked until then.
 * - `dismissed`: the user said no, or unlinked it. Detection never proposes it
 *   again for this session; only an explicit link brings it back.
 *
 * Every change is broadcast as `issue-links-changed` so the chat tab and the
 * Tickets screen follow without polling.
 *
 * Detection runs in main and can finish after the tab moved: a prompt scanned
 * under `tab:<id>` may only be suggested once its tracker answered, by which
 * time the rekey has happened. Each rekey is remembered, and a write to a key
 * that moved lands on the key it moved to, where the tab now listens. A
 * provisional entry that never moved (its tab closed before its first
 * message) is dropped after a week: nothing will ever read it again.
 */

const fsp = require('fs').promises;
const path = require('path');
const { dataDir } = require('../utils/paths');
const { parseRef } = require('../../shared/issue-trackers');

const STORE_FILE = path.join(dataDir, 'issue-links.json');
const STORE_VERSION = 1;
const STATUSES = ['linked', 'suggested', 'dismissed'];
const SOURCES = ['manual', 'mention', 'start', 'tool', 'prompt', 'branch', 'pr'];
const KEY = /^[A-Za-z0-9:_.-]{1,128}$/;
const MAX_EVIDENCE = 300;
const PROVISIONAL = 'tab:';
const PROVISIONAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ALIASES = 500;

function cleanKey(key) {
  return typeof key === 'string' && KEY.test(key) ? key : null;
}

function cleanLink(raw) {
  const ref = typeof raw?.ref === 'string' && parseRef(raw.ref) ? raw.ref : null;
  if (!ref) return null;
  return {
    ref,
    connectionId: typeof raw.connectionId === 'string' ? raw.connectionId : null,
    title: typeof raw.title === 'string' ? raw.title.slice(0, 300) : null,
    source: SOURCES.includes(raw.source) ? raw.source : 'manual',
    evidence: typeof raw.evidence === 'string' ? raw.evidence.slice(0, MAX_EVIDENCE) : null,
  };
}

/**
 * @param {{ storePath: string, now?: () => string, broadcast?: (sessionKey: string) => void }} deps
 */
function createIssueLinkService({ storePath, now = () => new Date().toISOString(), broadcast = () => {} }) {
  let queue = Promise.resolve();
  const aliases = new Map(); // provisional key → the session id it moved to

  /** Where writes to `key` go: the key it was rekeyed to, if it was. */
  function resolveKey(key) {
    let current = key;
    for (let hops = 0; hops < 5 && aliases.has(current); hops++) current = aliases.get(current);
    return current;
  }

  /** Provisional entries that never moved and have not changed for a week belong to no tab. */
  function pruneProvisional(store) {
    const cutoff = Date.parse(now()) - PROVISIONAL_TTL_MS;
    if (!Number.isFinite(cutoff)) return;
    for (const [key, session] of Object.entries(store.sessions)) {
      if (!key.startsWith(PROVISIONAL)) continue;
      const at = Date.parse(session?.updatedAt);
      if (!Number.isFinite(at) || at < cutoff) delete store.sessions[key];
    }
  }
  function exclusive(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  /** Absent is empty; unreadable throws rather than letting the next write wipe it. */
  async function readStore() {
    let raw;
    try {
      raw = await fsp.readFile(storePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { version: STORE_VERSION, sessions: {} };
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Refusing to modify ${path.basename(storePath)}: it is not valid JSON (${err.message})`, { cause: err });
    }
    if (!parsed || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) {
      throw new Error(`Refusing to modify ${path.basename(storePath)}: it has no sessions map`);
    }
    pruneProvisional(parsed);
    return parsed;
  }

  async function writeStore(store) {
    await fsp.mkdir(path.dirname(storePath), { recursive: true });
    const tmp = `${storePath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
    try {
      await fsp.copyFile(storePath, `${storePath}.bak`);
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[IssueLinks] Could not back up ${path.basename(storePath)}: ${err.message}`);
    }
    await fsp.rename(tmp, storePath);
  }

  /** Read-modify-write one session; `fn` returns true when it changed something. */
  function mutate(sessionKey, fn) {
    const cleaned = cleanKey(sessionKey);
    if (!cleaned) return Promise.reject(new Error('Invalid session key'));
    return exclusive(async () => {
      // Resolved here, in the queue: a rekey queued ahead of this write has run by now.
      const key = resolveKey(cleaned);
      const store = await readStore();
      const session = store.sessions[key] || { links: [] };
      const changed = fn(session);
      if (changed) {
        session.updatedAt = now();
        store.sessions[key] = session;
        store.version = STORE_VERSION;
        await writeStore(store);
        broadcast(key);
      }
      return session.links.slice();
    });
  }

  /** Put a link in `status`, adding it when absent. */
  function setStatus(session, link, status, { force }) {
    const existing = session.links.find((l) => l.ref === link.ref);
    if (existing) {
      if (!force && existing.status !== 'suggested') return false;
      if (existing.status === status) return false;
      Object.assign(existing, { status, at: now() });
      if (link.title) existing.title = link.title;
      return true;
    }
    session.links.push({ ...link, status, at: now() });
    return true;
  }

  return {
    async get(sessionKey) {
      const key = cleanKey(sessionKey);
      if (!key) return [];
      const store = await readStore();
      return (store.sessions[key]?.links || []).slice();
    },

    /** An explicit link: wins over a suggestion and over a past dismissal. */
    link(sessionKey, raw, { projectId = null } = {}) {
      const link = cleanLink(raw);
      if (!link) return Promise.reject(new Error('Invalid ticket reference'));
      return mutate(sessionKey, (session) => {
        if (projectId && !session.projectId) session.projectId = projectId;
        return setStatus(session, link, 'linked', { force: true });
      });
    },

    /** Automatic detection: only a ticket this session has never seen becomes a suggestion. */
    async suggest(sessionKey, raw) {
      const link = cleanLink(raw);
      if (!link) throw new Error('Invalid ticket reference');
      let added = false;
      await mutate(sessionKey, (session) => {
        if (session.links.some((l) => l.ref === link.ref)) return false;
        session.links.push({ ...link, status: 'suggested', at: now() });
        added = true;
        return true;
      });
      return added;
    },

    /** The user said yes to suggestions. */
    confirm(sessionKey, refs) {
      const wanted = new Set(Array.isArray(refs) ? refs : [refs]);
      return mutate(sessionKey, (session) => {
        let changed = false;
        for (const l of session.links) {
          if (wanted.has(l.ref) && l.status === 'suggested') {
            Object.assign(l, { status: 'linked', at: now() });
            changed = true;
          }
        }
        return changed;
      });
    },

    /** The user said no to suggestions, or unlinked: never proposed again here. */
    dismiss(sessionKey, refs) {
      const wanted = new Set(Array.isArray(refs) ? refs : [refs]);
      return mutate(sessionKey, (session) => {
        let changed = false;
        for (const l of session.links) {
          if (wanted.has(l.ref) && l.status !== 'dismissed') {
            Object.assign(l, { status: 'dismissed', at: now() });
            changed = true;
          }
        }
        return changed;
      });
    },

    /** A tab got its CLI session id: move its provisional links there. */
    rekey(from, to) {
      const a = cleanKey(from);
      const b = cleanKey(to);
      if (!a || !b || a === b) return Promise.resolve(false);
      return exclusive(async () => {
        // Remembered even when nothing is stored yet: the tab's first detection may still be in flight.
        aliases.set(a, b);
        if (aliases.size > MAX_ALIASES) aliases.delete(aliases.keys().next().value);
        const store = await readStore();
        const moving = store.sessions[a];
        if (!moving) return false;
        const target = store.sessions[b] || { links: [] };
        for (const l of moving.links) if (!target.links.some((x) => x.ref === l.ref)) target.links.push(l);
        if (!target.projectId && moving.projectId) target.projectId = moving.projectId;
        target.updatedAt = now();
        store.sessions[b] = target;
        delete store.sessions[a];
        await writeStore(store);
        broadcast(b);
        return true;
      });
    },

    /**
     * A fork starts with its parent's links; the parent keeps them. A ticket
     * the fork already has (detected under its new id first) keeps the fork's
     * own status.
     */
    copy(from, to) {
      const a = cleanKey(from);
      const b = cleanKey(to);
      if (!a || !b || a === b) return Promise.resolve(false);
      return exclusive(async () => {
        const store = await readStore();
        const source = store.sessions[a];
        if (!source) return false;
        const target = store.sessions[b] || { projectId: null, links: [] };
        const adding = source.links.filter((l) => !target.links.some((x) => x.ref === l.ref));
        if (!adding.length) return false;
        target.links.push(...adding.map((l) => ({ ...l })));
        if (!target.projectId) target.projectId = source.projectId || null;
        target.updatedAt = now();
        store.sessions[b] = target;
        await writeStore(store);
        broadcast(b);
        return true;
      });
    },

    /** How many sessions each ticket is linked to, for the Tickets screen. */
    async counts() {
      const store = await readStore();
      const counts = {};
      for (const session of Object.values(store.sessions)) {
        for (const l of session.links || []) {
          if (l.status === 'linked') counts[l.ref] = (counts[l.ref] || 0) + 1;
        }
      }
      return counts;
    },
  };
}

function broadcastToWindows(sessionKey) {
  try {
    const { BrowserWindow } = require('electron');
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('issue-links-changed', { sessionKey });
    }
  } catch {
    // No windows (tests, shutdown): nothing to tell.
  }
}

const service = createIssueLinkService({ storePath: STORE_FILE, broadcast: broadcastToWindows });

module.exports = service;
module.exports.createIssueLinkService = createIssueLinkService;
module.exports.STATUSES = STATUSES;
module.exports.SOURCES = SOURCES;
