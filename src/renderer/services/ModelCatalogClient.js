/**
 * ModelCatalogClient
 *
 * Renderer-side cache for the two-tier model catalog the main process builds
 * (see src/main/services/ModelCatalogService.js). One copy shared by every
 * consumer — the chat footer, the per-project settings modal, the parallel-run
 * modal — so opening three pickers doesn't trigger three IPC round trips, and
 * they can never disagree about which models exist.
 *
 * Seeded with the static fallback so a caller that renders before the first
 * round trip returns still has something real to show.
 *
 * Loaded once, then kept current by main: `load()` shares its first answer for
 * the life of the window, so a catalog the CLI corrects later (the first
 * session start after an upgrade) arrives as a `chat-model-catalog-changed`
 * push instead. `subscribe()` is how a picker learns it has to repaint.
 */

'use strict';

const {
  FALLBACK_PRIMARY,
  LEGACY_MODELS,
  dedupeLegacy,
} = require('../../shared/model-options');

// `recommended` is the model the CLI's `default` row points at — empty offline,
// because that row is the only thing that knows it. See ModelCatalogService.
let catalog = {
  primary: FALLBACK_PRIMARY,
  legacy: dedupeLegacy(FALLBACK_PRIMARY, LEGACY_MODELS),
  recommended: '',
  source: 'fallback',
};
let inflight = null;
const listeners = new Set();
let watching = false;
// Bumped by every push. A load that started before one must not overwrite it:
// main only pushes what the running CLI just said, which outranks anything a
// load in flight is still waiting for (a failed fetch answers with the cache).
let generation = 0;

/** Adopt an answer shaped like `chat-model-catalog`'s. Ignores empty ones. */
function apply(res) {
  if (!res?.success || !Array.isArray(res.primary) || res.primary.length === 0) return false;
  catalog = {
    primary: res.primary,
    legacy: Array.isArray(res.legacy) ? res.legacy : [],
    recommended: typeof res.recommended === 'string' ? res.recommended : '',
    source: res.source || 'cli',
  };
  return true;
}

/** Subscribe to main's pushes, once per window, on first use of the bridge. */
function watch(api) {
  if (watching || typeof api?.chat?.onModelCatalogChanged !== 'function') return;
  watching = true;
  api.chat.onModelCatalogChanged((res) => {
    if (!apply(res)) return;
    generation++;
    inflight = Promise.resolve(catalog);
    for (const fn of listeners) {
      try {
        fn(catalog);
      } catch (err) {
        console.warn('[ModelCatalogClient] listener failed:', err?.message || err);
      }
    }
  });
}

/**
 * Hear about a catalog pushed after the first load.
 *
 * @param {(catalog: object) => void} fn
 * @returns {() => void} unsubscribe
 */
function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Whatever is currently known, without triggering a fetch. */
function getCatalog() {
  return catalog;
}

/** Both tiers flattened, in menu order. */
function allModels() {
  return [...catalog.primary, ...catalog.legacy];
}

/**
 * Fetch once and share the result. Failures are deliberately non-fatal: the
 * caller keeps the tier it already has rather than rendering an empty menu.
 *
 * @param {object} api The renderer API bridge (window.electron_api).
 * @param {{refresh?: boolean}} [opts]
 * @returns {Promise<object>} the catalog
 */
function load(api, { refresh = false } = {}) {
  watch(api);
  if (!refresh && inflight) return inflight;
  const startedAt = generation;
  inflight = (async () => {
    try {
      const res = await api.chat.modelCatalog({ refresh });
      if (startedAt === generation) apply(res);
    } catch (err) {
      console.warn('[ModelCatalogClient] catalog unavailable:', err?.message || err);
    }
    return catalog;
  })();
  return inflight;
}

/** Test seam. */
function _reset() {
  catalog = {
    primary: FALLBACK_PRIMARY,
    legacy: dedupeLegacy(FALLBACK_PRIMARY, LEGACY_MODELS),
    recommended: '',
    source: 'fallback',
  };
  inflight = null;
  listeners.clear();
  watching = false;
  generation = 0;
}

module.exports = { getCatalog, allModels, load, subscribe, _reset };
