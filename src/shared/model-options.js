/**
 * model-options.js
 * Single source of truth for Claude model / effort choices.
 *
 * Two audiences, two shapes:
 *
 * 1. The `claude` workflow node (graph editor combo widgets, the rich
 *    claude-config field, and the .node.js validators in the main process)
 *    consumes the flat `CLAUDE_MODEL_VALUES` / `MODEL_OPTIONS` lists below.
 *
 * 2. The chat model picker consumes a two-tier catalog built at runtime by
 *    `ModelCatalogService`: the primary tier comes from the Claude CLI
 *    (`initializationResult().models`), so it follows CLI upgrades on its own;
 *    the legacy tier is `LEGACY_MODELS` here, curated by hand.
 *
 * Why a hand-curated legacy tier: the CLI only advertises the current lineup
 * (it dropped Fable 5 the day Fable 5.1 shipped), but it still *accepts* older
 * ids. Keeping them here is what lets "More models" stay useful without the
 * primary tier going stale.
 */

'use strict';

// Ordered list of accepted `model` property values ('' = inherit / auto).
const CLAUDE_MODEL_VALUES = [
  '',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'sonnet',
  'opus',
  'haiku',
];

// Human-readable labels, in the same order.
const MODEL_OPTIONS = [
  { value: '',                  label: 'Default (inherit)' },
  { value: 'claude-fable-5-1',  label: 'Fable 5.1' },
  { value: 'claude-fable-5',    label: 'Fable 5' },
  { value: 'claude-opus-5',     label: 'Opus 5' },
  { value: 'claude-opus-4-8',   label: 'Opus 4.8' },
  { value: 'claude-opus-4-7',   label: 'Opus 4.7' },
  { value: 'claude-sonnet-5',   label: 'Sonnet 5' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5',  label: 'Haiku 4.5' },
  { value: 'sonnet',            label: 'Sonnet (alias)' },
  { value: 'opus',              label: 'Opus (alias)' },
  { value: 'haiku',             label: 'Haiku (alias)' },
];

// Ordered list of accepted `effort` property values ('' = inherit / auto).
const EFFORT_VALUES = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

const EFFORT_OPTIONS = [
  { value: '',       label: 'Default (inherit)' },
  { value: 'low',    label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high',   label: 'High' },
  { value: 'xhigh',  label: 'XHigh' },
  { value: 'max',    label: 'Max' },
];

// ── Chat catalog ────────────────────────────────────────────────────────────

const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// xhigh arrived with Opus 4.7; anything older tops out at high/max.
const PRE_4_7_EFFORTS = ['low', 'medium', 'high', 'max'];

/**
 * Models the CLI still accepts but no longer advertises. Shaped like the SDK's
 * `ModelInfo` so both tiers render through one code path.
 */
const LEGACY_MODELS = [
  {
    value: 'claude-fable-5',
    displayName: 'Fable 5',
    description: 'Previous generation Fable',
    supportsEffort: true,
    supportedEffortLevels: ALL_EFFORTS,
    supportsAdaptiveThinking: true,
  },
  {
    value: 'claude-opus-4-8',
    displayName: 'Opus 4.8',
    description: 'Previous generation Opus',
    supportsEffort: true,
    supportedEffortLevels: ALL_EFFORTS,
    supportsAdaptiveThinking: true,
  },
  {
    value: 'claude-opus-4-7',
    displayName: 'Opus 4.7',
    description: 'Long-horizon agentic work',
    supportsEffort: true,
    supportedEffortLevels: ALL_EFFORTS,
    supportsAdaptiveThinking: true,
  },
  {
    value: 'claude-opus-4-6',
    displayName: 'Opus 4.6',
    description: 'Older Opus generation',
    supportsEffort: true,
    supportedEffortLevels: PRE_4_7_EFFORTS,
    supportsAdaptiveThinking: true,
  },
  {
    value: 'claude-sonnet-4-6',
    displayName: 'Sonnet 4.6',
    description: 'Previous generation Sonnet',
    supportsEffort: true,
    supportedEffortLevels: PRE_4_7_EFFORTS,
    supportsAdaptiveThinking: true,
  },
];

/**
 * Used only when the CLI cannot be reached (offline, first launch, a spawn
 * that failed). Deliberately short: a stale fallback that pretends to be
 * exhaustive is worse than one that obviously isn't.
 */
const FALLBACK_PRIMARY = [
  {
    value: 'claude-opus-5',
    displayName: 'Opus 5',
    description: 'Complex agentic coding and enterprise work',
    supportsEffort: true,
    supportedEffortLevels: ALL_EFFORTS,
    supportsAdaptiveThinking: true,
  },
  {
    value: 'claude-fable-5-1',
    displayName: 'Fable 5.1',
    description: 'Demanding reasoning and long-horizon agentic work',
    supportsEffort: true,
    supportedEffortLevels: ALL_EFFORTS,
    supportsAdaptiveThinking: true,
  },
  {
    value: 'claude-sonnet-5',
    displayName: 'Sonnet 5',
    description: 'Best combination of speed and intelligence',
    supportsEffort: true,
    supportedEffortLevels: ALL_EFFORTS,
    supportsAdaptiveThinking: true,
  },
  {
    value: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku 4.5',
    description: 'Fastest for quick answers',
    supportsEffort: false,
    supportedEffortLevels: [],
    supportsAdaptiveThinking: false,
  },
];

/**
 * The CLI's "whatever we currently recommend" row. Treated specially wherever a
 * stored id is resolved, because its target moves between releases.
 */
const DEFAULT_ALIAS = 'default';

/**
 * Strip a CLI variant suffix: 'claude-opus-5[1m]' -> 'claude-opus-5'.
 *
 * The CLI advertises context variants as a bracketed suffix on the id. Two ids
 * that differ only by suffix are the same model, so identity comparisons have
 * to run on the base.
 */
function baseModelId(id) {
  if (typeof id !== 'string') return '';
  const bracket = id.indexOf('[');
  return bracket === -1 ? id : id.slice(0, bracket);
}

/**
 * Find the catalog row covering `id`.
 *
 * A persisted setting can hold any of three things: the exact `value` the CLI
 * advertises ('opus[1m]'), a canonical wire id the alias resolves to
 * ('claude-opus-5'), or a legacy id chosen from the More models submenu. Match
 * in that order of specificity so an exact hit always wins over a base-id one.
 *
 * @param {Array<object>} models Catalog rows (SDK ModelInfo shape).
 * @param {string} id Persisted or requested model id.
 * @returns {object|null}
 */
function matchModel(models, id) {
  if (!Array.isArray(models) || !id) return null;
  const exact = models.find(m => m.value === id || m.resolvedModel === id);
  if (exact) return exact;

  const base = baseModelId(id);
  if (!base) return null;
  const covers = m => baseModelId(m.value) === base || baseModelId(m.resolvedModel) === base;

  // Prefer a concrete row over the `default` alias. `default` points at
  // whatever the CLI currently recommends, so resolving a stored id onto it
  // would let a later CLI release silently move a deliberate choice — while
  // the concrete row ('opus[1m]') is the same model the user actually picked.
  return models.find(m => m.value !== DEFAULT_ALIAS && covers(m))
    || models.find(covers)
    || null;
}

// A description segment that is purely pricing, e.g. "$5/$25 per Mtok".
const PRICE_SEGMENT = /^\$|per\s+Mtok/i;
// The CLI spells the large-context build into the prose too; the id already
// carries it, so repeating it in the label is noise.
const CONTEXT_NOTE = /\s*(?:with\s+1M\s+context|\(1M\s+context\))/i;

/**
 * Turn a CLI row into what the picker should actually show.
 *
 * The CLI splits the name across two fields — `displayName` is the bare family
 * ("Opus", "Fable") and the version hides in the first segment of the
 * description ("Opus 5 with 1M context · … · $5/$25 per Mtok"). Rendered as-is
 * that gives a menu of unversioned names with prices trailing every row.
 *
 * So: promote the versioned name into the label, drop the context note it
 * repeats, and strip pricing from the description. When the description's lead
 * segment isn't a name for this row at all — the `default` alias reads "Use the
 * default model (currently …)" — the label falls back to `displayName` and the
 * segment stays in the description, where it belongs.
 *
 * @param {object} m Catalog row (SDK ModelInfo shape).
 * @returns {object} a copy with `displayName`/`description` rewritten
 */
function normalizeModelRow(m) {
  if (!m || typeof m !== 'object') return m;

  const segments = String(m.description || '')
    .split('·')
    .map(s => s.trim())
    .filter(Boolean);

  const family = String(m.displayName || '').split(/[\s(]/)[0];
  const lead = segments[0] ? segments[0].replace(CONTEXT_NOTE, '').trim() : '';
  // Only treat the lead segment as a name if it names *this* family — that is
  // what separates "Opus 5 with 1M context" from "Use the default model (…)".
  const leadIsName = !!family && !!lead && lead.startsWith(family);

  const rest = (leadIsName ? segments.slice(1) : segments)
    .filter(s => !PRICE_SEGMENT.test(s));

  return {
    ...m,
    displayName: leadIsName ? lead : String(m.displayName || ''),
    description: rest.join(' · '),
  };
}

// Menu order for the primary tier, most capable first. The CLI's own order puts
// Opus ahead of Fable; we surface the more capable model first instead. Anything
// unrecognised sorts last in the order the CLI gave it.
const FAMILY_RANK = ['fable', 'opus', 'sonnet', 'haiku'];

function familyRank(m) {
  // The recommended alias keeps the top slot it holds in the CLI menu.
  if (m?.value === DEFAULT_ALIAS) return -1;
  const id = String(m?.resolvedModel || m?.value || '').toLowerCase();
  const i = FAMILY_RANK.findIndex(f => id.includes(f));
  return i === -1 ? FAMILY_RANK.length : i;
}

/**
 * Order the primary tier for display.
 *
 * Stable: models of the same family keep their CLI-given order, so a future
 * second Opus build lands next to the first rather than jumping the list.
 *
 * @param {Array<object>} models
 * @returns {Array<object>} a new, ordered array
 */
function orderPrimary(models) {
  if (!Array.isArray(models)) return [];
  return models
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (familyRank(a.m) - familyRank(b.m)) || (a.i - b.i))
    .map(({ m }) => m);
}

/**
 * Does this id name a 1M-context variant?
 *
 * The CLI expresses the large-context build as a `[1m]` suffix on the id
 * ('claude-opus-5[1m]'), so the context window is a property of the selected
 * model, not of the app's `enable1MContext` setting alone.
 */
function hasOneMContext(id) {
  return typeof id === 'string' && id.includes('[1m]');
}

/**
 * Drop legacy rows already covered by the primary tier.
 *
 * The CLI promotes models between releases — Fable 5.1 replaced Fable 5 in the
 * primary tier the moment the CLI knew about it. Without this the promoted
 * model would show up in both menus at once.
 */
function dedupeLegacy(primary, legacy) {
  const seen = new Set();
  for (const m of primary || []) {
    if (m?.value) seen.add(baseModelId(m.value));
    if (m?.resolvedModel) seen.add(baseModelId(m.resolvedModel));
  }
  return (legacy || []).filter(m => !seen.has(baseModelId(m.value)));
}

module.exports = {
  CLAUDE_MODEL_VALUES,
  MODEL_OPTIONS,
  EFFORT_VALUES,
  EFFORT_OPTIONS,
  LEGACY_MODELS,
  FALLBACK_PRIMARY,
  DEFAULT_ALIAS,
  baseModelId,
  matchModel,
  dedupeLegacy,
  hasOneMContext,
  orderPrimary,
  normalizeModelRow,
};
