/**
 * Reading the context window's occupancy, for the gauge and its overlay.
 *
 * Everything here is a pure read of what the CLI reported — the drawing stays
 * in ChatView, which owns the popover element. Splitting it that way is what
 * makes the one genuinely tricky part testable: deciding which of the CLI's
 * rows count as *used*.
 */

const { escapeHtml } = require('../../../utils');
const { t } = require('../../../i18n');

/** "371.3k", "1M", "820" — the compact shape the overlay reads in. */
function formatTokenCount(n) {
  const round = (v) => String(Math.round(v * 10) / 10);
  if (n >= 1e6) return `${round(n / 1e6)}M`;
  if (n >= 1000) return `${round(n / 1000)}k`;
  return String(Math.round(n));
}

/** "371.3k / 1M (37%)" */
function contextSummaryText(used, limit) {
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
  return `${formatTokenCount(used)} / ${formatTokenCount(limit)} (${pct}%)`;
}

function contextSummaryHtml(used, limit) {
  return `
      <div class="ccp-header">
        <span class="ccp-title">${escapeHtml(t('chat.contextWindowUsage') || 'Context window')}</span>
        <span class="ccp-total">${escapeHtml(contextSummaryText(used, limit))}</span>
      </div>`;
}

/**
 * Rows the CLI reports that are not occupancy: what is left, and the slice it
 * holds back for a compaction. Both belong to the window, neither is in use,
 * and listing them next to "Messages" would read as if they were.
 */
const CONTEXT_FREE_ROW = /^(free|autocompact|compaction)/i;

/**
 * Categories, from whichever shape the CLI answered in.
 *
 * `getContextUsage()` returns `categories: [{ name, tokens, isDeferred }]`.
 * The map-of-numbers this used to read never existed on that response, so
 * `Object.entries` walked an array, `Number({...})` came back NaN, every row
 * was filtered out and the overlay stayed on its header — the breakdown had
 * simply never drawn. Both shapes are accepted so an older CLI still renders.
 */
function contextUsageRows(usage) {
  const raw = usage.categories || usage.breakdown || {};
  const rows = Array.isArray(raw)
    ? raw.map(c => ({
        name: String(c?.name || ''),
        tokens: Number(c?.tokens) || 0,
        kind: c?.kind,
        deferred: !!c?.isDeferred
      }))
    : Object.entries(raw).map(([name, tokens]) => ({
        name: name.replace(/_/g, ' '),
        tokens: Number(tokens) || 0
      }));
  return rows
    .filter(r => r.tokens > 0
      && !r.deferred
      && (r.kind ? r.kind === 'used' : !CONTEXT_FREE_ROW.test(r.name)))
    .sort((a, b) => b.tokens - a.tokens);
}

module.exports = {
  formatTokenCount,
  contextSummaryText,
  contextSummaryHtml,
  contextUsageRows,
  CONTEXT_FREE_ROW,
};
