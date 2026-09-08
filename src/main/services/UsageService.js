/**
 * UsageService
 * Fetches Claude usage data via the OAuth API (primary) or PTY /usage command (fallback).
 */

const https = require('https');
const { readCredentials, readCredentialsForDir, tokenFromCredentials } = require('../utils/claudeCredentials');

// Per-account state.
//
// Projects pick their own account, so there is no single set of numbers to
// hold any more: figures fetched for one account are simply wrong for another.
// Everything that used to be a module-level singleton is keyed by account id,
// with the MACHINE key standing for the machine-wide login — what unbound
// projects, and the default account, actually run as.
const MACHINE = '__machine__';

let fetchInterval = null;
let _onUpdateCallback = null;
let _onLimitCallback = null;

// Which account the UI is showing. Only this one is polled: fetching every
// known account on a timer would multiply API calls by the number of accounts
// to keep numbers nobody is looking at warm.
let focusedAccount = MACHINE;

/** @type {Map<string, Object>} */
const entries = new Map();

function key(accountId) {
  return accountId || MACHINE;
}

/**
 * Per-account slot. `isStale` stays true for as long as we keep serving data
 * the API refused to confirm, so the renderer can badge the numbers instead of
 * showing them as current.
 */
function entryFor(accountId) {
  const k = key(accountId);
  let entry = entries.get(k);
  if (!entry) {
    entry = {
      accountId: accountId || null,
      usageData: null,
      lastFetch: null,
      isFetching: false,
      lastError: null,
      isStale: false,
      lastLimitNotifiedReset: null,
      tokenCache: null,
      tokenCacheUntil: 0,
      rejectedToken: null
    };
    entries.set(k, entry);
  }
  return entry;
}

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

// ── OAuth API (primary) ──

// Token cache lifetimes.
//
// Reading the store is not free on macOS: the credentials live in the login
// Keychain, in an item created by the Claude CLI whose ACL does not list this
// app, so every read that misses the cache raises a system password prompt. The
// renderer polls usage once a minute, so any TTL shorter than that expired
// before every single tick — and because the window need only be visible, not
// focused, the prompts were raised behind it and surfaced in a batch the moment
// the app came back to the front.
//
// A token is therefore held until it actually expires, and an absent or
// unreadable one is cached too, so a refusal is not retried a minute later.
const TOKEN_CACHE_MAX = 6 * 60 * 60 * 1000;   // cap for a long-lived token
const TOKEN_CACHE_BACKOFF = 15 * 60 * 1000;   // no token, or store unreadable
const TOKEN_EXPIRY_MARGIN = 60 * 1000;        // re-read shortly before expiry

/**
 * The credentials an account authenticates with: its own store when it is
 * bound to one, the machine-wide login otherwise.
 *
 * @param {string|null} accountId
 * @returns {Promise<Object|null>}
 */
function readCredentialsFor(accountId) {
  if (!accountId) return readCredentials();
  const { accountConfigDir } = require('./AccountManager');
  return readCredentialsForDir(accountConfigDir(accountId));
}

/**
 * Read the OAuth access token for an account.
 *
 * A bound account is read from its own credential directory — the same one its
 * spawned CLI authenticates against — so the figures come back for the account
 * that actually did the work. With no id, this is the machine-wide login: the
 * macOS Keychain on darwin, ~/.claude/.credentials.json elsewhere.
 *
 * @param {string|null} accountId
 * @param {boolean} [force] - skip the cache and re-read the store, for the
 *   explicit "refresh" gesture: a credential change made outside the app
 *   (`claude /login` in a terminal) leaves the cached token valid but wrong,
 *   and only a re-read can tell the two apart. Reserved for that gesture —
 *   on darwin both stores are Keychain entries, so every forced read is a
 *   password prompt, which is the whole reason the cache above is that long.
 * @returns {Promise<string|null>}
 */
async function readOAuthToken(accountId, force = false) {
  const entry = entryFor(accountId);
  const now = Date.now();
  if (!force && now < entry.tokenCacheUntil) return entry.tokenCache;

  let token = null;
  let expiresAt = null;
  try {
    const creds = await readCredentialsFor(accountId);
    token = tokenFromCredentials(creds);
    expiresAt = creds?.claudeAiOauth?.expiresAt ?? null;
  } catch (e) {
    // Store unreadable: Keychain access refused, or the file is malformed.
    // Treated as no token, and backed off, rather than retried on every tick.
  }

  if (token !== null && token === entry.rejectedToken) {
    // The store still holds the token the API just refused. Reading it again
    // buys nothing until the CLI writes a new one.
    entry.tokenCache = null;
    entry.tokenCacheUntil = now + TOKEN_CACHE_BACKOFF;
    return null;
  }

  entry.rejectedToken = null;
  entry.tokenCache = token;
  entry.tokenCacheUntil = token
    ? Math.min(expiresAt !== null ? expiresAt - TOKEN_EXPIRY_MARGIN : Infinity, now + TOKEN_CACHE_MAX)
    : now + TOKEN_CACHE_BACKOFF;
  return entry.tokenCache;
}

/**
 * Drop cached tokens and figures — for one account, or all of them.
 *
 * The numbers belong to the account they were fetched for, so serving them for
 * another would be a plain lie, and the cached token would keep querying the
 * outgoing one. Called with no id after a change to the machine-wide store,
 * which every unbound project reads.
 *
 * @param {string|null} [accountId] - omit to clear every account
 */
function invalidateCredentials(accountId) {
  const reset = (entry) => {
    entry.tokenCache = null;
    entry.tokenCacheUntil = 0;
    entry.rejectedToken = null;
    entry.usageData = null;
    entry.lastFetch = null;
    entry.isStale = false;
    entry.lastError = null;
    entry.lastLimitNotifiedReset = null;
  };
  if (accountId === undefined) {
    for (const entry of entries.values()) reset(entry);
    return;
  }
  reset(entryFor(accountId));
}

/**
 * Fallback for a response with no `limits` array — the shape the API served
 * before it described its own buckets. Only the two plan-wide windows can be
 * recovered this way: a scoped limit is unreadable without `limits`, because
 * the root key holding its number is a codename rather than a stable name.
 *
 * @param {Object} json - Raw API response
 * @returns {Array<Object>} Bucket list, possibly empty
 */
function legacyBuckets(json) {
  const out = [];
  if (typeof json?.five_hour?.utilization === 'number') {
    out.push({
      id: 'session', type: 'session', label: null, labelKey: 'ui.session',
      utilization: json.five_hour.utilization, resetsAt: json.five_hour.resets_at ?? null
    });
  }
  if (typeof json?.seven_day?.utilization === 'number') {
    out.push({
      id: 'weekly', type: 'weekly', label: null, labelKey: 'ui.weekly',
      utilization: json.seven_day.utilization, resetsAt: json.seven_day.resets_at ?? null
    });
  }
  return out;
}

/**
 * The usage buckets the titlebar renders, read from the API's `limits` array.
 *
 * The response used to carry one fixed key per bucket — `five_hour`,
 * `seven_day`, `seven_day_sonnet`. The per-model key has been null since the
 * scoped weekly limit moved off Sonnet, and the root key that now carries that
 * number is a rotating codename (`nimbus_quill` at the time of writing), so
 * neither one is readable. `limits` is the part of the response that survives a
 * model rename: the server states which limits exist and names the model each
 * scoped one applies to, so the label is data instead of a string we have to
 * ship a release to change.
 *
 * Which buckets come back is the server's call, not ours — a plan may expose
 * one scoped limit, several, or none. Only the two plan-wide windows are
 * assumed to be always present, and even those go through the same list.
 *
 * `labelKey` is set for the plan-wide buckets, whose names are ours to
 * translate; `label` for scoped ones, whose name only the server knows.
 *
 * @param {Object} json - Raw API response
 * @returns {Array<{id: string, type: string, label: string|null, labelKey: string|null,
 *                  utilization: number, resetsAt: string|null}>}
 */
function readBuckets(json) {
  if (!Array.isArray(json?.limits)) return legacyBuckets(json);

  const buckets = [];
  for (const limit of json.limits) {
    if (!limit || typeof limit.percent !== 'number') continue;
    const resetsAt = limit.resets_at ?? null;

    if (limit.kind === 'session') {
      buckets.push({
        id: 'session', type: 'session', label: null, labelKey: 'ui.session',
        utilization: limit.percent, resetsAt
      });
    } else if (limit.kind === 'weekly_all') {
      buckets.push({
        id: 'weekly', type: 'weekly', label: null, labelKey: 'ui.weekly',
        utilization: limit.percent, resetsAt
      });
    } else {
      // Every other kind is scoped to something. We can only render one the
      // server named, so an unlabelled bucket is dropped rather than shown as
      // an anonymous bar.
      const label = limit.scope?.model?.display_name;
      if (!label) continue;
      buckets.push({
        id: `scoped:${label}`, type: 'scoped', label, labelKey: null,
        utilization: limit.percent, resetsAt
      });
    }
  }

  // An empty `limits` (or one we could make nothing of) is likelier to be a
  // shape we don't understand yet than a plan with no limits at all.
  return buckets.length ? buckets : legacyBuckets(json);
}

/**
 * Fetch usage data from the OAuth API
 * @returns {Promise<Object>} Parsed usage data in standard format
 */
function fetchUsageFromAPI(token) {
  return new Promise((resolve, reject) => {
    const url = new URL(USAGE_API_URL);
    const req = https.get({
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'anthropic-beta': OAUTH_BETA_HEADER
      },
      timeout: 5000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const err = new Error(`API ${res.statusCode}: ${body.slice(0, 200)}`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        try {
          const json = JSON.parse(body);
          resolve({
            timestamp: new Date().toISOString(),
            buckets: readBuckets(json),
            extraUsage: json.extra_usage ?? null,
            _source: 'api'
          });
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('API timeout')); });
  });
}

// ── Main fetch logic ──

/**
 * Fetch usage data from the OAuth API.
 * There is no second source (the PTY fallback was removed), so a failed fetch
 * marks the cached data stale rather than silently passing it off as fresh.
 * @param {string|null} accountId
 * @param {boolean} [force] - re-read the credential store instead of trusting
 *   the cached token; see readOAuthToken().
 * @returns {Promise<Object|null>}
 */
async function fetchUsage(accountId, force = false) {
  const entry = entryFor(accountId);
  if (entry.isFetching) return entry.usageData;
  entry.isFetching = true;

  try {
    // Try OAuth API first
    const token = await readOAuthToken(entry.accountId, force);
    if (token) {
      try {
        const data = await fetchUsageFromAPI(token);
        entry.usageData = data;
        entry.lastFetch = new Date();
        entry.lastError = null;
        entry.isStale = false;
        console.log('[Usage] Fetched via API');
        if (_onUpdateCallback) _onUpdateCallback(data, entry.accountId);
        _maybeNotifyLimit(entry, data);
        return data;
      } catch (apiErr) {
        entry.lastError = apiErr.message;
        // A refused token is worth one re-read: the CLI may have rotated it.
        // readOAuthToken() stops re-reading once the store gives back this same
        // token, so this cannot turn into a Keychain prompt loop on macOS.
        if (apiErr.statusCode === 401 || apiErr.statusCode === 403) {
          entry.rejectedToken = token;
          entry.tokenCacheUntil = 0;
        }
        console.log('[Usage] API request failed:', apiErr.message);
      }
    } else {
      entry.lastError = 'No valid Claude OAuth token (missing or expired — run /login in a terminal)';
      console.log('[Usage] ' + entry.lastError);
    }

    // PTY fallback removed — launching `claude --dangerously-skip-permissions` just
    // to read usage data is a security risk. Serve cached data, flagged as stale.
    entry.isStale = true;
    if (entry.usageData) {
      console.warn('[Usage] API unavailable, serving STALE cached data:', entry.lastError);
      return entry.usageData;
    }
    console.warn('[Usage] API unavailable and no cached data:', entry.lastError);
    return null;
  } finally {
    entry.isFetching = false;
  }
}

/**
 * Point the poller at the account the UI is showing.
 *
 * Its figures are refreshed immediately: switching project tabs should not
 * leave the previous account's numbers on screen until the next tick.
 *
 * @param {string|null} accountId
 */
function setFocusedAccount(accountId) {
  const next = key(accountId);
  if (next === focusedAccount) return;
  focusedAccount = next;
  fetchUsage(accountId).catch(e => console.error('[Usage]', e.message));
}

function getFocusedAccount() {
  return focusedAccount === MACHINE ? null : focusedAccount;
}

/**
 * Start periodic fetching
 * @param {number} intervalMs - Interval (default: 10 minutes)
 */
function startPeriodicFetch(intervalMs = 600000) {
  const { isMainWindowVisible } = require('../windows/MainWindow');

  // Only the focused account is polled. Sweeping every known account on a
  // timer would multiply API calls to keep numbers nobody is looking at warm;
  // the others are refreshed on demand, when a tab or a panel asks for them.
  const tick = () => {
    if (isMainWindowVisible()) {
      fetchUsage(getFocusedAccount()).catch(e => console.error('[Usage]', e.message));
    }
  };

  setTimeout(tick, 5000);

  if (fetchInterval) clearInterval(fetchInterval);
  fetchInterval = setInterval(tick, intervalMs);
}

/**
 * Stop periodic fetching
 */
function stopPeriodicFetch() {
  if (fetchInterval) {
    clearInterval(fetchInterval);
    fetchInterval = null;
  }
}

/**
 * Get cached usage data.
 * `stale` is true when the last fetch attempt failed — `data` is then whatever
 * the API last confirmed, which may be arbitrarily old.
 * @returns {Object}
 */
function getUsageData(accountId) {
  const entry = entryFor(accountId);
  return {
    accountId: entry.accountId,
    data: entry.usageData,
    lastFetch: entry.lastFetch ? entry.lastFetch.toISOString() : null,
    isFetching: entry.isFetching,
    stale: entry.isStale,
    error: entry.lastError
  };
}

/**
 * Staleness of the most recent fetch attempt.
 * @returns {{ stale: boolean, error: string|null, lastFetch: string|null }}
 */
function getFetchState(accountId) {
  const entry = entryFor(accountId);
  return {
    stale: entry.isStale,
    error: entry.lastError,
    lastFetch: entry.lastFetch ? entry.lastFetch.toISOString() : null
  };
}

/**
 * Force refresh.
 *
 * `force` re-reads the credential store rather than trusting the cached
 * token — without it, this only re-ran the API call, so the explicit refresh
 * gesture could not notice an account swapped outside the app (`claude
 * /login` in a terminal for a bound project's own store, or for the
 * machine-wide one) until the token cache expired on its own, up to 6h later.
 * @param {string|null} [accountId]
 * @param {boolean} [force]
 * @returns {Promise<Object>}
 */
function refreshUsage(accountId, force = false) {
  return fetchUsage(accountId, force);
}

/**
 * Figures for an account, refetched only when the ones already on hand are
 * older than `maxAgeMs`.
 *
 * The settings list asks about every account at once, and it re-renders on any
 * account change — a rename, a colour, a new capture. Refetching on each of
 * those would turn a rename into one API call per account, and on macOS one
 * Keychain read per account with it, so anything recent enough is served from
 * the cache instead.
 *
 * @param {string|null} accountId
 * @param {number} [maxAgeMs] - 0 forces a fetch
 * @returns {Promise<Object>} same shape as getUsageData()
 */
async function usageForAccount(accountId, maxAgeMs = 5 * 60 * 1000) {
  const entry = entryFor(accountId);
  const age = entry.lastFetch ? Date.now() - entry.lastFetch.getTime() : Infinity;
  // `>=` so that a maxAge of 0 always refetches: figures fetched in the same
  // millisecond are not "younger than 0ms", and the explicit refresh button
  // would otherwise be a no-op on a fast machine.
  if (age >= maxAgeMs) await fetchUsage(accountId);
  return getUsageData(accountId);
}

/**
 * Called when window becomes visible - refresh if data is stale
 */
function onWindowShow() {
  const staleMinutes = 10;
  const entry = entryFor(getFocusedAccount());
  // Renamed to avoid shadowing the per-entry `isStale` (fetch-failure flag).
  const isDataOld = !entry.lastFetch || (Date.now() - entry.lastFetch.getTime() > staleMinutes * 60 * 1000);

  if (isDataOld && !entry.isFetching) {
    fetchUsage(entry.accountId).catch(e => console.error('[Usage]', e.message));
  }
}

/**
 * Register a callback to receive usage data updates (push model)
 * @param {Function} cb - Called with usage data object
 */
function onUpdate(cb) {
  _onUpdateCallback = cb;
}

/**
 * Register a callback fired when a usage threshold is crossed.
 * Invoked at most once per reset window per bucket.
 * @param {Function} cb - cb({ scope, label, utilization, resetsAt })
 */
function onLimit(cb) {
  _onLimitCallback = cb;
}

const LIMIT_THRESHOLD = 0.95; // 95%

function _maybeNotifyLimit(entry, data) {
  if (!_onLimitCallback || !Array.isArray(data?.buckets)) return;
  // Pick the most-pressured bucket, whichever ones the API sent
  const candidates = data.buckets
    .filter(b => typeof b.utilization === 'number' && b.utilization >= LIMIT_THRESHOLD)
    .sort((a, b) => b.utilization - a.utilization);
  if (!candidates.length) return;
  const top = candidates[0];
  // De-dupe per reset window, per account: the de-dupe key lives on the entry,
  // so one account hitting its limit cannot swallow the notification for
  // another that hits the same bucket in the same window.
  const dedupe = `${top.id}:${top.resetsAt || ''}`;
  if (dedupe === entry.lastLimitNotifiedReset) return;
  entry.lastLimitNotifiedReset = dedupe;
  try {
    _onLimitCallback({
      scope: top.id,
      label: top.label,
      utilization: top.utilization,
      resetsAt: top.resetsAt,
      accountId: entry.accountId
    });
  } catch (e) { console.error('[Usage] onLimit cb threw:', e.message); }
}

module.exports = {
  readBuckets,
  startPeriodicFetch,
  stopPeriodicFetch,
  getUsageData,
  getFetchState,
  refreshUsage,
  usageForAccount,
  fetchUsage,
  invalidateCredentials,
  setFocusedAccount,
  getFocusedAccount,
  onWindowShow,
  onUpdate,
  onLimit
};
