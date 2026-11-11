/**
 * Contextual feature suggestions: the engine.
 *
 * Most people never open most of the sidebar, and a list of features is the
 * one thing nobody reads. What does work is naming a feature at the moment it
 * answers the problem in front of the user: a third Claude tab on one project
 * is when Control Tower makes sense, not the day it shipped.
 *
 * This file is the part that decides *whether* to speak, and it knows nothing
 * about any feature. A rule (see `rules/`) says when it applies; the engine
 * owns every reason to stay quiet, in this order:
 *
 *  1. the store could not be read (then nothing is shown and nothing written:
 *     a dismissal that cannot be honoured is not a reason to nag again);
 *  2. the user turned suggestions off in the Settings;
 *  3. the rule was dismissed ("Don't show again"), acted on ("Show me"),
 *     shown `maxShows` times already, or is inside its own cooldown;
 *  4. the user already uses the feature (a usage key the app recorded, or the
 *     rule's own live `isUsed` probe, remembered once true);
 *  5. another suggestion was shown in the last 24 hours, whichever rule it was.
 *
 * A rule that matches while the user is busy (a turn running, a card waiting
 * for an answer, a modal open, the window in the background, the first
 * minutes after launch) is held as the one pending suggestion and offered on
 * the next `flush()` once that clears, for up to PENDING_TTL_MS. Everything is
 * re-checked at that point, so a pending suggestion never outlives a dismissal
 * or the daily cap.
 *
 * Rendering and navigation are the host's (see `index.js`), the same split
 * WhatsNew uses: the engine hands over a description and three callbacks.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** At most one suggestion in any 24 hours, all rules together. */
const DAILY_CAP_MS = DAY_MS;

/** How long a match waits for the user to be free before it is dropped. */
const PENDING_TTL_MS = 10 * 60 * 1000;

/** Quiet period after launch: nobody wants a tip on the way in. */
const DEFAULT_STARTUP_GRACE_MS = 90 * 1000;

const RULE_DEFAULTS = {
  cooldownDays: 30,
  maxShows: 3,
  actionLabelKey: 'discovery.showMe',
};

/**
 * Check a rule's shape once, at construction, so a malformed entry fails the
 * test suite rather than a user's session.
 * @param {object} rule
 */
function validateRule(rule) {
  const where = rule && rule.id ? `rule "${rule.id}"` : 'a rule';
  if (!rule || typeof rule.id !== 'string' || !rule.id) throw new Error(`Discovery: ${where} has no id`);
  if (!Array.isArray(rule.triggers) || rule.triggers.length === 0) throw new Error(`Discovery: ${where} has no triggers`);
  if (typeof rule.condition !== 'function') throw new Error(`Discovery: ${where} has no condition`);
  if (typeof rule.titleKey !== 'string' || typeof rule.bodyKey !== 'string') throw new Error(`Discovery: ${where} needs titleKey and bodyKey`);
  if (!rule.action || typeof rule.action.type !== 'string') throw new Error(`Discovery: ${where} has no action`);
  if (rule.usedWhen && !Array.isArray(rule.usedWhen)) throw new Error(`Discovery: ${where} usedWhen must be an array`);
}

/**
 * @typedef {Object} DiscoveryStore
 * @property {() => boolean} isUsable  loaded, and not unreadable
 * @property {() => object} get        { lastShownAt, rules: { [id]: {...} }, used: { [key]: ts } }
 * @property {(fn: (state: object) => void) => void} update
 */

/**
 * @param {Object} deps
 * @param {object[]} deps.rules
 * @param {DiscoveryStore} deps.store
 * @param {() => boolean} deps.isEnabled            the global Settings switch
 * @param {() => (string|null)} deps.busyReason      why now is a bad moment, or null
 * @param {(suggestion: object, handlers: object) => void} deps.present
 * @param {object} [deps.ctx]                        handed to every rule
 * @param {() => number} [deps.now]
 * @param {number} [deps.startupGraceMs]
 * @param {{ warn: Function }} [deps.log]
 */
function createDiscoveryEngine({
  rules,
  store,
  isEnabled,
  busyReason,
  present,
  ctx = {},
  now = Date.now,
  startupGraceMs = DEFAULT_STARTUP_GRACE_MS,
  log = console,
}) {
  const startedAt = now();
  const byId = new Map();
  const byTrigger = new Map();
  for (const raw of rules) {
    validateRule(raw);
    if (byId.has(raw.id)) throw new Error(`Discovery: duplicate rule id "${raw.id}"`);
    const rule = { ...RULE_DEFAULTS, usedWhen: [], ...raw };
    byId.set(rule.id, rule);
    for (const trigger of rule.triggers) {
      if (!byTrigger.has(trigger)) byTrigger.set(trigger, []);
      byTrigger.get(trigger).push(rule);
    }
  }

  /** @type {{ rule: object, verdict: object, at: number } | null} */
  let pending = null;
  /** Id of the suggestion on screen, if any: one at a time. */
  let showing = null;
  /** Rules whose async condition is in flight, so a burst of signals evaluates once. */
  const evaluating = new Set();

  function ruleState(id) {
    return (store.get().rules || {})[id] || {};
  }

  function updateRule(id, fn) {
    store.update((state) => {
      if (!state.rules || typeof state.rules !== 'object') state.rules = {};
      const entry = state.rules[id] || (state.rules[id] = {});
      fn(entry, state);
    });
  }

  function isFeatureUsed(rule) {
    if (ruleState(rule.id).alreadyUses) return true;
    const used = store.get().used || {};
    return rule.usedWhen.some((key) => !!used[key]);
  }

  /** Why this rule may not speak at all right now, regardless of the moment. */
  function ruleBlock(rule) {
    if (!store.isUsable()) return 'store';
    if (!isEnabled()) return 'disabled';
    const rs = ruleState(rule.id);
    if (rs.dismissed) return 'dismissed';
    if (rs.acted) return 'acted';
    if ((rs.shows || 0) >= rule.maxShows) return 'retired';
    if (rs.lastShownAt && now() - rs.lastShownAt < rule.cooldownDays * DAY_MS) return 'cooldown';
    if (isFeatureUsed(rule)) return 'used';
    return null;
  }

  function capBlock() {
    const last = store.get().lastShownAt || 0;
    return last && now() - last < DAILY_CAP_MS ? 'daily-cap' : null;
  }

  /** What a rule sees: the host context plus a persisted scratch space of its own. */
  function ruleCtx(rule) {
    return {
      ...ctx,
      now,
      memory: {
        get: () => ({ ...(ruleState(rule.id).data || {}) }),
        set: (data) => updateRule(rule.id, (entry) => { entry.data = data; }),
      },
    };
  }

  /** `true` or `{ params, bodyKey }` from a condition, normalised. */
  function normaliseVerdict(verdict) {
    if (verdict === true) return { params: {} };
    if (verdict && typeof verdict === 'object') {
      return { params: verdict.params || {}, bodyKey: verdict.bodyKey || null, titleKey: verdict.titleKey || null };
    }
    return null;
  }

  async function evaluate(rule, payload) {
    if (evaluating.has(rule.id)) return false;
    evaluating.add(rule.id);
    try {
      const context = ruleCtx(rule);
      // The condition runs first even though it can be the dearer call: some
      // rules count occurrences in their memory, and a count that skipped the
      // times the gate was shut would never reach its threshold.
      const verdict = normaliseVerdict(await rule.condition(payload, context));
      if (!verdict) return false;
      if (rule.isUsed && await rule.isUsed(context)) {
        updateRule(rule.id, (entry) => { entry.alreadyUses = true; });
        return false;
      }
      // Anything may have changed while the condition was awaited.
      if (ruleBlock(rule) || capBlock()) return false;
      pending = { rule, verdict, at: now() };
      flush();
      return true;
    } catch (err) {
      log.warn?.(`[discovery] rule ${rule.id} failed:`, err && err.message);
      return false;
    } finally {
      evaluating.delete(rule.id);
    }
  }

  /**
   * A signal from the app. Cheap gates first: this is called from hot paths
   * (every context gauge repaint, every tab state change).
   * @param {string} type
   * @param {object} [payload]
   * @returns {Promise<boolean>} whether a suggestion was queued
   */
  async function signal(type, payload = {}) {
    const candidates = byTrigger.get(type);
    if (!candidates || !store.isUsable() || !isEnabled()) return false;
    if (capBlock() || pending || showing) {
      // Still let counting rules count: their threshold must not depend on
      // whether another suggestion happened to be on screen.
      for (const rule of candidates) {
        if (rule.countsWhileQuiet && !ruleBlock(rule)) {
          try { await rule.condition(payload, ruleCtx(rule)); } catch { /* counted best-effort */ }
        }
      }
      return false;
    }
    for (const rule of candidates) {
      if (ruleBlock(rule)) continue;
      if (await evaluate(rule, payload)) return true;
    }
    return false;
  }

  /**
   * Offer the pending suggestion if this is a good moment. Called by the host
   * whenever the moment may have changed (a turn ended, focus came back) and
   * on a slow timer.
   * @returns {boolean} whether something was presented
   */
  function flush() {
    if (!pending || showing) return false;
    if (now() - pending.at > PENDING_TTL_MS) { pending = null; return false; }
    if (ruleBlock(pending.rule) || capBlock()) { pending = null; return false; }
    if (now() - startedAt < startupGraceMs) return false;
    let busy;
    try { busy = busyReason(); } catch { busy = 'unknown'; }
    if (busy) return false;

    const { rule, verdict } = pending;
    pending = null;
    const shownAt = now();
    store.update((state) => { state.lastShownAt = shownAt; });
    updateRule(rule.id, (entry) => {
      entry.lastShownAt = shownAt;
      entry.shows = (entry.shows || 0) + 1;
    });
    showing = rule.id;

    const suggestion = {
      id: rule.id,
      titleKey: verdict.titleKey || rule.titleKey,
      bodyKey: verdict.bodyKey || rule.bodyKey,
      params: verdict.params,
      actionLabelKey: rule.actionLabelKey,
      action: rule.action,
    };
    try {
      present(suggestion, {
        onAction: () => acted(rule.id),
        onDismiss: () => dismiss(rule.id),
        onHide: () => settled(rule.id),
      });
    } catch (err) {
      showing = null;
      log.warn?.('[discovery] could not present a suggestion:', err && err.message);
      return false;
    }
    return true;
  }

  /** "Show me": the user went there, so the feature is known now. */
  function acted(id) {
    if (!byId.has(id)) return;
    updateRule(id, (entry) => { entry.acted = true; });
    settled(id);
  }

  /** "Don't show again", for good. */
  function dismiss(id) {
    if (!byId.has(id)) return;
    updateRule(id, (entry) => { entry.dismissed = true; });
    if (pending && pending.rule.id === id) pending = null;
    settled(id);
  }

  /** The card went away (closed, timed out, or one of the two above). */
  function settled(id) {
    if (showing === id) showing = null;
  }

  /**
   * The app saw the user use a feature (opened a screen, pressed a button).
   * Recorded once with the time it was first seen.
   * @param {string} key  e.g. 'tab:control-tower', 'git:generate-commit'
   */
  function markUsed(key) {
    if (!key || !store.isUsable()) return;
    const used = store.get().used || {};
    if (used[key]) return;
    store.update((state) => {
      if (!state.used || typeof state.used !== 'object') state.used = {};
      state.used[key] = now();
    });
    if (pending && pending.rule.usedWhen.includes(key)) pending = null;
  }

  return {
    signal,
    flush,
    markUsed,
    acted,
    dismiss,
    settled,
    hasPending: () => !!pending,
    showingId: () => showing,
    /** For the tests and the Settings: why a rule is silent right now, or null. */
    explain: (id) => {
      const rule = byId.get(id);
      return rule ? (ruleBlock(rule) || capBlock()) : 'unknown-rule';
    },
    rules: () => [...byId.values()],
  };
}

module.exports = {
  createDiscoveryEngine,
  validateRule,
  DAY_MS,
  DAILY_CAP_MS,
  PENDING_TTL_MS,
  DEFAULT_STARTUP_GRACE_MS,
  RULE_DEFAULTS,
};
