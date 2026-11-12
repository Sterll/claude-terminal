/**
 * ModelAccessService
 *
 * Which models an account may run, read from the Models API (`GET /v1/models`)
 * with that account's own OAuth token.
 *
 * It exists for the models the CLI never puts in its menu. Mythos is reserved
 * to the accounts admitted to it, and nothing the CLI reports tells those
 * accounts apart: on CLI 0.3.322 an admitted account (one Claude Desktop shows
 * Mythos 5.2 and 5.1 to) gets no Mythos row in `initializationResult().models`,
 * its bootstrap caches carry none, and the usage API has no Mythos limit. The
 * Models API does list them, for that account and not for one without access,
 * and the CLI accepts the id once it is picked.
 *
 * It also covers the CLI's menu lagging behind a release. That menu comes from
 * a per-account server answer, and on 2026-11-12 CLI 0.3.322 still offered
 * Fable 5.1, and no Fable 5.2, to accounts this list names Fable 5.2 for.
 *
 * The token comes from UsageService's reader, never from the credential store
 * directly: that reader's cache and back-off are what keep macOS from raising a
 * Keychain prompt on every call.
 *
 * Fails closed. No token, an HTTP error, a timeout: the answer is the last list
 * this account got, or `null`, and a `null` adds nothing to the picker.
 */

'use strict';

const https = require('https');

const MODELS_URL = new URL('https://api.anthropic.com/v1/models?limit=100');
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const API_VERSION = '2023-06-01';

// Access changes rarely; a model gained mid-day shows up on the next restart.
const TTL_MS = 6 * 60 * 60 * 1000;
// A failure is retried sooner, but not on every picker open.
const RETRY_MS = 10 * 60 * 1000;

const cache = new Map();

function keyOf(accountId) {
  return accountId || '';
}

/**
 * @param {string} token
 * @returns {Promise<string[]>} the model ids the account may run
 */
function requestModelIds(token) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: MODELS_URL.hostname,
      path: MODELS_URL.pathname + MODELS_URL.search,
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
        'anthropic-version': API_VERSION,
      },
      timeout: 5000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Models API ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try {
          const data = JSON.parse(body)?.data;
          if (!Array.isArray(data)) return reject(new Error('Models API returned no list'));
          resolve(data.map(m => m?.id).filter(id => typeof id === 'string'));
        } catch (e) {
          reject(new Error(`Models API parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Models API timeout')); });
  });
}

/**
 * The model ids `accountId` may run, or null when that cannot be told.
 *
 * @param {string|null} accountId - null for the machine-wide login
 * @returns {Promise<string[]|null>}
 */
function modelIdsFor(accountId) {
  const key = keyOf(accountId);
  const entry = cache.get(key) || { ids: null, until: 0, inflight: null };
  if (entry.inflight) return entry.inflight;
  if (Date.now() < entry.until) return Promise.resolve(entry.ids);

  entry.inflight = (async () => {
    let fresh = null;
    try {
      const token = await require('./UsageService').readOAuthToken(accountId || null);
      if (token) fresh = await requestModelIds(token);
    } catch (err) {
      console.warn('[ModelAccess] model list unavailable:', err?.message || err);
    }
    // A failed read keeps what this account got last time.
    entry.ids = fresh || entry.ids;
    entry.until = Date.now() + (fresh ? TTL_MS : RETRY_MS);
    entry.inflight = null;
    return entry.ids;
  })();
  cache.set(key, entry);
  return entry.inflight;
}

/** Test seam. */
function _reset() {
  cache.clear();
}

module.exports = { modelIdsFor, _reset, TTL_MS, RETRY_MS };
