/**
 * An account's usage figures, drawn wherever one account is chosen over
 * another: the account list in Settings, and the switch offer a usage limit
 * opens in a chat tab.
 *
 * The second one is why this is a module. The offer listed accounts by name
 * only, so moving a project off an account that had run out meant picking the
 * next one blind, and possibly onto one that had run out too. The bars are the
 * ones Settings already drew; they moved here rather than being copied, since
 * a copy is how Settings came to spell its reset countdown in French or
 * English and nothing else.
 */

const { t } = require('../../i18n');
const { escapeHtml } = require('../../utils/dom');
const { modelFamily } = require('../../../shared/model-options');
const { formatResetCountdown } = require('./usageChip');

/**
 * When a limit window resets, in ms, or Infinity when the API did not say.
 * @param {Object} bucket
 * @returns {number}
 */
function resetTime(bucket) {
  const at = bucket?.resetsAt ? new Date(bucket.resetsAt).getTime() : NaN;
  return Number.isFinite(at) ? at : Infinity;
}

/**
 * "2d 5h" until a bucket resets, or '' when there is no reset ahead of us.
 * @param {Object} bucket
 * @param {number} [now]
 * @returns {string}
 */
function formatBucketReset(bucket, now = Date.now()) {
  const at = resetTime(bucket);
  return Number.isFinite(at) ? formatResetCountdown(at - now) : '';
}

/**
 * One usage bucket, in the markup the titlebar bars already use so both read
 * the same: blue for the session window, purple for the weekly one, and the
 * warning / danger tints above 70% and 90%.
 *
 * A scoped bucket is named by the API, so its label is escaped rather than
 * translated: it is data, not a string we ship.
 *
 * @param {Object} bucket
 * @param {number} [now]
 * @returns {string}
 */
function buildUsageBucketHtml(bucket, now = Date.now()) {
  const percent = typeof bucket.utilization === 'number' ? Math.round(bucket.utilization) : null;
  const level = percent === null ? '' : percent >= 90 ? ' danger' : percent >= 70 ? ' warning' : '';
  const label = bucket.labelKey ? t(bucket.labelKey) : (bucket.label || '');
  const reset = formatBucketReset(bucket, now);
  return `
    <div class="usage-item" data-type="${escapeHtml(bucket.type || '')}">
      <div class="usage-header">
        <span class="usage-label">${escapeHtml(label)}</span>
        <span class="usage-value">
          <span class="usage-percent">${percent === null ? '--' : `${percent}%`}</span>
          <span class="usage-reset">${escapeHtml(reset)}</span>
        </span>
      </div>
      <div class="usage-bar-container">
        <div class="usage-bar${level}" style="width: ${Math.min(percent ?? 0, 100)}%"></div>
      </div>
    </div>`;
}

/**
 * The usage strip of one account.
 *
 * An account nobody has run lately has no usable token of its own, and no
 * amount of retrying will produce one, so that case says what to do about it
 * rather than showing bars stuck at zero, which would read as "plenty left".
 *
 * @param {Object|null|undefined} usage - one entry of the accounts-usage map;
 *   absent while it is still being read
 * @returns {string}
 */
function buildAccountUsageHtml(usage) {
  if (!usage) {
    return `<div class="account-usage-note">${escapeHtml(t('accounts.usageLoading') || 'Reading usage…')}</div>`;
  }
  const buckets = usage.data?.buckets;
  if (!Array.isArray(buckets) || !buckets.length) {
    return `<div class="account-usage-note" title="${escapeHtml(usage.error || '')}">${escapeHtml(t('accounts.usageUnavailable') || 'Usage unavailable - run "claude /login" on this account')}</div>`;
  }
  const now = Date.now();
  return `
    <div class="account-usage-bars${usage.stale ? ' stale' : ''}"${usage.stale ? ` title="${escapeHtml(t('accounts.usageStale') || 'The API could not confirm these figures')}"` : ''}>
      ${buckets.map(b => buildUsageBucketHtml(b, now)).join('')}
    </div>`;
}

/**
 * The limit that stops an account taking over a conversation, or null when
 * nothing does.
 *
 * A limit blocks when it is full and its window has not rolled over. The
 * plan-wide windows block whatever the model; one the API scopes to a model
 * blocks only a conversation on that model, which is why a full Fable limit
 * greys an account out for a Fable tab and not for a Sonnet one. Without a
 * model, no scoped limit blocks: there is nothing to say it applies.
 *
 * "Full" is the figure as displayed, rounded: a row reading 100% that still
 * let itself be picked would be the one thing worse than no figures at all.
 *
 * Stale figures still count. Within a window usage only goes up, so a full
 * bar the API last confirmed stays full until the reset time passes, and that
 * is checked. An account whose figures could not be read at all blocks
 * nothing: unknown is not the same as spent.
 *
 * @param {Object|null|undefined} usage - one entry of the accounts-usage map
 * @param {{model?: string|null, now?: number}} [opts]
 * @returns {Object|null} the full bucket that frees up last, since that is
 *   when the account becomes usable again
 */
function blockingLimit(usage, { model = null, now = Date.now() } = {}) {
  const buckets = usage?.data?.buckets;
  if (!Array.isArray(buckets)) return null;
  const family = modelFamily(model || '');
  const full = buckets.filter((b) => {
    if (typeof b?.utilization !== 'number' || Math.round(b.utilization) < 100) return false;
    // Past its reset, the figure describes the window before this one.
    if (resetTime(b) <= now) return false;
    if (b.type !== 'scoped') return true;
    return !!family && modelFamily(b.label || '') === family;
  });
  return full.sort((a, b) => resetTime(b) - resetTime(a))[0] || null;
}

module.exports = {
  buildUsageBucketHtml,
  buildAccountUsageHtml,
  blockingLimit,
  formatBucketReset,
};
