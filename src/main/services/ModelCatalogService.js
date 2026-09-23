/**
 * ModelCatalogService
 *
 * Builds the two-tier model catalog the chat picker renders:
 *
 *   primary — whatever the Claude CLI advertises for this account
 *             (`initializationResult().models`), minus its `default` alias.
 *             Follows CLI upgrades on its own, which is the whole point:
 *             hard-coded lists went stale the day Fable 5.1 shipped.
 *   legacy  — the hand-curated `LEGACY_MODELS` list, minus anything the
 *             primary tier already covers. The CLI drops older models from its
 *             menu but still accepts their ids, so these stay usable.
 *
 * Alongside them, `recommended` names the model the CLI's `default` row points
 * at. The picker shows that model by name when nothing has been chosen, rather
 * than offering the alias as an entry of its own.
 *
 * Three ways the primary tier gets filled, cheapest first:
 *
 *   1. `ingestInitResult()` — free. ChatService hands over the init result it
 *      already has whenever a session starts. No extra process, no round trip.
 *   2. The disk cache — survives restarts, so a cold launch renders the real
 *      menu instead of the fallback.
 *   3. `_fetcher()` — spawns a throwaway CLI just to read its init result.
 *      Costs a process spawn, so it only runs when 1 and 2 came up empty or
 *      the caller explicitly asked to refresh.
 *
 * A failed fetch never downgrades a cache we already have: stale-but-real
 * beats the static fallback, which exists only for a first launch with no
 * reachable CLI.
 *
 * The cache is keyed on the CLI's version as well as its age. The model list
 * is compiled into the binary the SDK ships, so after an app update swaps that
 * binary, a catalog written minutes before the update is young but describes a
 * CLI that is gone. Opus 5.5 shipped that way, and the picker kept saying
 * "Opus 5" for the model it was actually running. A version mismatch counts as
 * an empty cache, so the first launch after an update asks the new CLI.
 *
 * Whenever a refresh changes what the catalog says, `onChange` listeners hear
 * about it. The renderer loads its copy once per window, so without that push
 * a catalog corrected by the first session start would never reach the chip.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { dataDir, ensureDataDir } = require('../utils/paths');
const {
  LEGACY_MODELS,
  FALLBACK_PRIMARY,
  dedupeLegacy,
  dropDefaultAlias,
  normalizeModelRow,
  orderPrimary,
  recommendedModelId,
} = require('../../shared/model-options');

const CACHE_FILE = path.join(dataDir, 'model-catalog.json');

// Backstop only. The ingest path keeps the cache fresh whenever the user
// actually chats, so this just bounds how stale a dormant install can get.
const TTL_MS = 6 * 60 * 60 * 1000;

class ModelCatalogService {
  constructor() {
    this._cache = null;
    this._inflight = null;
    this._fetcher = null;
    this._restored = false;
    this._cliVersion = null;
    this._listeners = new Set();
  }

  /**
   * Inject the raw fetch. ChatService owns SDK loading, CLI path resolution and
   * runtime detection; duplicating any of that here would mean two things to
   * keep in sync, and would make this service untestable without Electron.
   *
   * @param {() => Promise<{models: Array}>} fn
   */
  setFetcher(fn) {
    this._fetcher = typeof fn === 'function' ? fn : null;
  }

  /**
   * Version of the CLI binary every catalog is read from. Injected for the same
   * reason as the fetcher: resolving the binary needs Electron. Unknown (null)
   * keeps the old age-only rule rather than refetching on every launch.
   *
   * @param {string|null} version
   */
  setCliVersion(version) {
    this._cliVersion = typeof version === 'string' && version ? version : null;
  }

  /**
   * Hear about every refresh that changes the catalog's contents.
   *
   * @param {(catalog: object) => void} fn receives the same shape as getCatalog()
   * @returns {() => void} unsubscribe
   */
  onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /**
   * Free refresh path — feed the catalog from a session that just started.
   * Ignores empty payloads so a degraded init can't blank a good cache.
   *
   * @param {object} init SDKControlInitializeResponse
   */
  ingestInitResult(init) {
    const models = init && Array.isArray(init.models) ? init.models : null;
    if (!models || models.length === 0) return;
    // Compare against what is on disk, not against nothing: a session can start
    // before any picker asked for the catalog.
    if (!this._restored) this._restore();
    this._store(models);
  }

  /**
   * @param {{refresh?: boolean}} [opts] `refresh: true` bypasses a fresh cache
   *   and forces a fetch (used by an explicit "reload models" action).
   * @returns {Promise<object>} `{ primary, legacy, fetchedAt, source, stale }`
   */
  async getCatalog({ refresh = false } = {}) {
    if (!this._restored) this._restore();

    if (!refresh && this._isFresh()) return this._shape(this._cache, 'cache');
    if (!this._fetcher) return this._shape(this._cache, this._cache ? 'cache' : 'fallback');

    // Collapse concurrent callers onto one spawn — several pickers opening at
    // once must not each start a CLI.
    if (!this._inflight) {
      this._inflight = this._fetch().finally(() => { this._inflight = null; });
    }
    return this._inflight;
  }

  async _fetch() {
    try {
      const raw = await this._fetcher();
      const models = raw && Array.isArray(raw.models) ? raw.models : null;
      if (!models || models.length === 0) throw new Error('CLI returned no models');
      this._store(models);
      return this._shape(this._cache, 'cli');
    } catch (err) {
      console.warn('[ModelCatalog] fetch failed:', err?.message || err);
      // Keep serving whatever we had. Only a truly empty cache falls back.
      return this._shape(this._cache, this._cache ? 'cache' : 'fallback');
    }
  }

  _isFresh() {
    return !!this._cache
      && (Date.now() - this._cache.fetchedAt) < TTL_MS
      && this._sameCli(this._cache);
  }

  /**
   * Was this catalog read from the CLI we are running now? A cache written
   * before this field existed carries no version, and counts as another CLI.
   */
  _sameCli(cache) {
    return !this._cliVersion || cache.cliVersion === this._cliVersion;
  }

  /**
   * Adopt a catalog the CLI just produced, and tell listeners when it differs
   * from the one we held.
   */
  _store(models) {
    const changed = !this._cache || JSON.stringify(this._cache.primary) !== JSON.stringify(models);
    this._cache = { primary: models, fetchedAt: Date.now(), cliVersion: this._cliVersion };
    this._persist();
    if (changed) this._emit();
  }

  _emit() {
    if (this._listeners.size === 0) return;
    const catalog = this._shape(this._cache, 'cli');
    for (const fn of this._listeners) {
      try {
        fn(catalog);
      } catch (err) {
        console.warn('[ModelCatalog] change listener failed:', err?.message || err);
      }
    }
  }

  /**
   * @param {object|null} cache
   * @param {'cli'|'cache'|'fallback'} source
   */
  _shape(cache, source) {
    const usingFallback = source === 'fallback' || !cache;
    const raw = usingFallback ? FALLBACK_PRIMARY : cache.primary;
    // Normalize and order on read, not on write: the cache keeps the CLI's raw
    // rows, so changing a label or the menu order doesn't require busting every
    // stored catalog. Reading the recommendation before dropping the CLI's
    // `default` row is what lets that row inform the picker without being one
    // of its entries — a menu line reading "Default (recommended)" says less
    // than the name of the model it stands for.
    const recommended = recommendedModelId(raw);
    const primary = orderPrimary(dropDefaultAlias(raw).map(normalizeModelRow));
    return {
      primary,
      legacy: dedupeLegacy(primary, LEGACY_MODELS),
      recommended,
      fetchedAt: usingFallback ? null : cache.fetchedAt,
      source: usingFallback ? 'fallback' : source,
      stale: !usingFallback && ((Date.now() - cache.fetchedAt) >= TTL_MS || !this._sameCli(cache)),
    };
  }

  _restore() {
    this._restored = true;
    try {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (Array.isArray(raw?.primary) && raw.primary.length > 0 && typeof raw.fetchedAt === 'number') {
        this._cache = {
          primary: raw.primary,
          fetchedAt: raw.fetchedAt,
          cliVersion: typeof raw.cliVersion === 'string' ? raw.cliVersion : null,
        };
      }
    } catch (_) {
      // Absent or corrupt cache is the normal first-launch path, not an error.
    }
  }

  _persist() {
    if (!this._cache) return;
    try {
      ensureDataDir();
      // Atomic write (temp + rename) per the app's file-I/O convention: a
      // half-written catalog would be parsed as corrupt on next launch.
      const tmp = `${CACHE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this._cache, null, 2), 'utf8');
      fs.renameSync(tmp, CACHE_FILE);
    } catch (err) {
      console.warn('[ModelCatalog] persist failed:', err?.message || err);
    }
  }

  /** Test seam. */
  _reset() {
    this._cache = null;
    this._inflight = null;
    this._fetcher = null;
    this._restored = false;
    this._cliVersion = null;
    this._listeners = new Set();
  }
}

module.exports = new ModelCatalogService();
module.exports.ModelCatalogService = ModelCatalogService;
module.exports.CACHE_FILE = CACHE_FILE;
module.exports.TTL_MS = TTL_MS;
