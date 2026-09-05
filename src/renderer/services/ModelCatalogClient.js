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
 */

'use strict';

const {
  FALLBACK_PRIMARY,
  LEGACY_MODELS,
  dedupeLegacy,
} = require('../../shared/model-options');

let catalog = {
  primary: FALLBACK_PRIMARY,
  legacy: dedupeLegacy(FALLBACK_PRIMARY, LEGACY_MODELS),
  source: 'fallback',
};
let inflight = null;

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
  if (!refresh && inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await api.chat.modelCatalog({ refresh });
      if (res?.success && Array.isArray(res.primary) && res.primary.length) {
        catalog = {
          primary: res.primary,
          legacy: Array.isArray(res.legacy) ? res.legacy : [],
          source: res.source || 'cli',
        };
      }
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
    source: 'fallback',
  };
  inflight = null;
}

module.exports = { getCatalog, allModels, load, _reset };
