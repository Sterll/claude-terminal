/**
 * ModelCatalogService
 *
 * Builds the two-tier model catalog the chat picker renders:
 *
 *   primary — whatever the Claude CLI advertises for this account
 *             (`initializationResult().models`). Follows CLI upgrades on its
 *             own, which is the whole point: hard-coded lists went stale the
 *             day Fable 5.1 shipped.
 *   legacy  — the hand-curated `LEGACY_MODELS` list, minus anything the
 *             primary tier already covers. The CLI drops older models from its
 *             menu but still accepts their ids, so these stay usable.
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
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { dataDir, ensureDataDir } = require('../utils/paths');
const {
  LEGACY_MODELS,
  FALLBACK_PRIMARY,
  dedupeLegacy,
  normalizeModelRow,
  orderPrimary,
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
   * Free refresh path — feed the catalog from a session that just started.
   * Ignores empty payloads so a degraded init can't blank a good cache.
   *
   * @param {object} init SDKControlInitializeResponse
   */
  ingestInitResult(init) {
    const models = init && Array.isArray(init.models) ? init.models : null;
    if (!models || models.length === 0) return;
    this._cache = { primary: models, fetchedAt: Date.now() };
    this._persist();
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
      this._cache = { primary: models, fetchedAt: Date.now() };
      this._persist();
      return this._shape(this._cache, 'cli');
    } catch (err) {
      console.warn('[ModelCatalog] fetch failed:', err?.message || err);
      // Keep serving whatever we had. Only a truly empty cache falls back.
      return this._shape(this._cache, this._cache ? 'cache' : 'fallback');
    }
  }

  _isFresh() {
    return !!this._cache && (Date.now() - this._cache.fetchedAt) < TTL_MS;
  }

  /**
   * @param {object|null} cache
   * @param {'cli'|'cache'|'fallback'} source
   */
  _shape(cache, source) {
    const usingFallback = source === 'fallback' || !cache;
    // Normalize and order on read, not on write: the cache keeps the CLI's raw
    // rows, so changing a label or the menu order doesn't require busting every
    // stored catalog.
    const primary = orderPrimary(
      (usingFallback ? FALLBACK_PRIMARY : cache.primary).map(normalizeModelRow)
    );
    return {
      primary,
      legacy: dedupeLegacy(primary, LEGACY_MODELS),
      fetchedAt: usingFallback ? null : cache.fetchedAt,
      source: usingFallback ? 'fallback' : source,
      stale: !usingFallback && (Date.now() - cache.fetchedAt) >= TTL_MS,
    };
  }

  _restore() {
    this._restored = true;
    try {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (Array.isArray(raw?.primary) && raw.primary.length > 0 && typeof raw.fetchedAt === 'number') {
        this._cache = { primary: raw.primary, fetchedAt: raw.fetchedAt };
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
  }
}

module.exports = new ModelCatalogService();
module.exports.ModelCatalogService = ModelCatalogService;
module.exports.CACHE_FILE = CACHE_FILE;
module.exports.TTL_MS = TTL_MS;
