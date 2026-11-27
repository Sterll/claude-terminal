/**
 * Where the suggestions remember what they said: `~/.claude-terminal/discovery.json`.
 *
 * Its own file rather than settings.json because it changes often (a counting
 * rule writes on every matching prompt) and settings.json has subscribers that
 * re-render on every change. It holds no prompt text, only hashes and counts.
 *
 * Follows the rule CLAUDE.md spells out for every JSON store here: an absent
 * file is a fresh start, an unreadable one is not. Unreadable means the store
 * stays unusable for the session: the engine shows nothing (it could not
 * honour a "Don't show again" it cannot read) and nothing is ever written, so
 * the file is left exactly as found.
 *
 * Shape: { version, lastShownAt, rules: { [ruleId]: { lastShownAt, shows,
 * dismissed, acted, alreadyUses, data } }, used: { [usageKey]: firstSeenTs } }
 */

const { isMissingFile } = require('../../utils/fsErrors');

const STORE_VERSION = 1;
const SAVE_DEBOUNCE_MS = 1000;

function emptyState() {
  return { version: STORE_VERSION, lastShownAt: 0, rules: {}, used: {} };
}

/**
 * @param {Object} deps
 * @param {(file: string) => Promise<string>} deps.readFile   rejects with ENOENT when absent (as `code`, or at the head of the message when it came through the preload bridge)
 * @param {(file: string, data: object) => Promise<void>} deps.writeJSON  atomic
 * @param {string} deps.file
 * @param {number} [deps.debounceMs]
 * @param {{ warn: Function }} [deps.log]
 */
function createDiscoveryStore({ readFile, writeJSON, file, debounceMs = SAVE_DEBOUNCE_MS, log = console }) {
  let state = emptyState();
  let loaded = false;
  let unreadable = false;
  let timer = null;
  let chain = Promise.resolve();

  async function load() {
    let raw;
    try {
      raw = await readFile(file);
    } catch (err) {
      if (isMissingFile(err)) {
        state = emptyState();
        loaded = true;
        return { ok: true, fresh: true };
      }
      unreadable = true;
      log.warn?.('[discovery] store unreadable, suggestions are off for this session:', err && err.message);
      return { ok: false };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // Covers a truncated write as well as a corrupt one. Nothing is reset:
      // the next launch reads it again.
      unreadable = true;
      log.warn?.('[discovery] store unreadable, suggestions are off for this session');
      return { ok: false };
    }
    state = {
      ...emptyState(),
      ...parsed,
      rules: parsed.rules && typeof parsed.rules === 'object' ? parsed.rules : {},
      used: parsed.used && typeof parsed.used === 'object' ? parsed.used : {},
    };
    loaded = true;
    return { ok: true, fresh: false };
  }

  function save() {
    if (!loaded || unreadable) return chain;
    const snapshot = JSON.parse(JSON.stringify(state));
    chain = chain
      .catch(() => {})
      .then(() => writeJSON(file, snapshot))
      .catch((err) => log.warn?.('[discovery] could not save:', err && err.message));
    return chain;
  }

  function update(fn) {
    if (!loaded || unreadable) return;
    fn(state);
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; save(); }, debounceMs);
  }

  /** Write now (quit, tests). */
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; return save(); }
    return chain;
  }

  return {
    load,
    get: () => state,
    update,
    flush,
    isUsable: () => loaded && !unreadable,
    isUnreadable: () => unreadable,
  };
}

module.exports = { createDiscoveryStore, emptyState, STORE_VERSION };
