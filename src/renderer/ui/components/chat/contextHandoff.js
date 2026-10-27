/**
 * Context handoff: once a conversation's window passes the threshold the user
 * set (`contextHandoffThreshold`), the session writes its own handoff summary
 * and the tab carries on in a fresh session that opens on that summary.
 *
 * Why not the CLI's compaction, which already does something close: a compact
 * keeps the same session and a summary nobody gets to read. A handoff leaves the
 * old session whole on disk, puts the summary on screen where the user can check
 * it, and starts a session that really is new, under a threshold the user chose
 * rather than a few percent short of the model's window.
 *
 * The summary comes from the session itself, as one more turn, because that is
 * the only place the whole context is. It runs at the end of a turn and never
 * in the middle of one: cutting a turn short would drop the tool work it was
 * doing. The new session is not started straight away: it opens on the next
 * message the user sends, with the summary carried in that same prompt, so the
 * handoff costs no turn of its own. A message typed while the summary is being
 * written is held, and opens the new session as soon as the summary is in.
 *
 * Both prompts are tagged so a replayed transcript can draw them as what they
 * are instead of as two long messages the user never typed.
 */

const DEFAULT_HANDOFF_THRESHOLD = 500000;
/** Below this a handoff would fire on nearly every turn of a real session. */
const MIN_HANDOFF_THRESHOLD = 50000;

const REQUEST_TAG = 'context-handoff-request';
const SEED_TAG = 'context-handoff';

/**
 * The threshold in tokens, from the stored setting. Junk falls back to the
 * default rather than to "never": the feature is only consulted once enabled.
 *
 * @param {*} value
 * @returns {number}
 */
function normalizeHandoffThreshold(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HANDOFF_THRESHOLD;
  return Math.max(MIN_HANDOFF_THRESHOLD, n);
}

/** How far above the handoff threshold the CLI's own compaction sits. */
const COMPACT_MARGIN = 0.1;

/**
 * The window handed to the CLI as its `autoCompactWindow` while the handoff is
 * on. The handoff only acts at the end of a turn, on the main conversation;
 * this covers the rest. A subagent compacts at this window, and so does a turn
 * that runs well past the threshold before ending. A margin above the threshold
 * keeps an ordinary turn on the handoff rather than on a compaction. Kept inside
 * the 100k to 1M range the CLI accepts.
 *
 * @param {number} threshold - tokens, as normalizeHandoffThreshold gives it
 * @returns {number}
 */
function autoCompactWindowFor(threshold) {
  const window = Math.round((threshold * (1 + COMPACT_MARGIN)) / 1000) * 1000;
  return Math.min(1000000, Math.max(100000, window));
}

function tokenCount(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** A CLI session id goes into an attribute: keep it to what an id is made of. */
function safeId(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * What the old session is asked, as its last turn.
 *
 * @param {number} tokens - the window's occupancy when the handoff started
 * @returns {string}
 */
function buildHandoffRequest(tokens) {
  return [
    `<${REQUEST_TAG} tokens="${tokenCount(tokens)}" />`,
    `This conversation's context window has reached about ${tokenCount(tokens)} tokens, so it is being handed off to a fresh session. That session will see nothing of this one except what you write now.`,
    '',
    'Write the handoff summary for it. Do not use any tools for this. Write in the language the user has been using.',
    '',
    'Use these sections:',
    '- Goal: what the user is trying to achieve overall.',
    '- Current state: what is done, what is in progress, what was verified and how.',
    '- Decisions and constraints: what was decided and why, including what was tried and rejected.',
    '- Files and places that matter: paths, branches, commands, ids, with one line on why each matters.',
    '- Next steps: what remains, in order, and any open question for the user.',
    '- Anything the user explicitly asked to keep in mind.',
    '',
    'Be specific and complete, but do not pad it: no greeting, no closing remark, only the content.',
  ].join('\n');
}

/**
 * @param {string} text - a user message
 * @returns {{tokens: number}|null} the request's details when it is one
 */
function parseHandoffRequest(text) {
  const match = typeof text === 'string'
    && text.trimStart().match(new RegExp(`^<${REQUEST_TAG}(?:\\s+tokens="(\\d+)")?\\s*/>`));
  return match ? { tokens: tokenCount(match[1]) } : null;
}

/**
 * The opening prompt of the new session: what the user typed, then the summary.
 *
 * The user's text comes first because the session list titles a conversation
 * by its first prompt, and a title made of the handoff tag would say nothing.
 *
 * @param {{text?: string, summary: string, previousSessionId?: string, tokens?: number}} seed
 * @returns {string}
 */
function buildHandoffSeed({ text = '', summary, previousSessionId = '', tokens = 0 }) {
  const id = safeId(previousSessionId);
  const block = [
    `<${SEED_TAG} previous-session="${id}" tokens="${tokenCount(tokens)}">`,
    'This conversation continues a previous Claude Code session that was handed off when its context window grew large. The previous session wrote the summary below for you. Treat it as what you already know about this work.'
      + (id ? ` If you need a detail it left out, the full transcript of that session is the file ${id}.jsonl in this project's Claude Code session directory (~/.claude/projects/).` : ''),
    '',
    String(summary || '').trim(),
    `</${SEED_TAG}>`,
  ].join('\n');
  const typed = String(text || '').trim();
  return typed ? `${typed}\n\n${block}` : block;
}

/**
 * @param {string} text - a user message
 * @returns {{text: string, summary: string, previousSessionId: string, tokens: number}|null}
 */
function parseHandoffSeed(text) {
  if (typeof text !== 'string') return null;
  const open = text.match(new RegExp(`<${SEED_TAG} previous-session="([A-Za-z0-9_-]*)" tokens="(\\d+)">\\n`));
  if (!open) return null;
  const close = text.lastIndexOf(`</${SEED_TAG}>`);
  if (close < open.index) return null;
  const inner = text.slice(open.index + open[0].length, close);
  // The first paragraph is the note to the new session, not the summary.
  const split = inner.indexOf('\n\n');
  const summary = (split >= 0 ? inner.slice(split + 2) : inner).trim();
  return {
    text: text.slice(0, open.index).trim(),
    summary,
    previousSessionId: open[1],
    tokens: tokenCount(open[2]),
  };
}

/**
 * The tab's side of a handoff, as a small state machine:
 *
 *   idle -> summarizing -> ready -> (the next message takes the seed) -> idle
 *                       \-> off   (failed or stopped: not tried again in this tab)
 *
 * @param {Object} deps
 * @param {() => number} deps.getThreshold - tokens, 0 when the feature is off
 * @param {() => number} deps.getUsedTokens - the window's occupancy now
 * @param {() => boolean} deps.canStart - nothing running, queued or pending
 * @param {() => string|null} deps.getCliSessionId - the CLI's id of the session
 * @param {(prompt: string) => Promise<{success: boolean, error?: string}>} deps.sendRequest
 * @param {(info: {tokens: number, threshold: number}) => void} deps.onSummarizing
 * @param {(seed: object, held: object[]) => void} deps.onReady
 * @param {(held: object[]) => void} deps.onFailed
 * @param {(fn: Function) => void} [deps.defer] - lets the turn end settle first
 */
function createContextHandoff(deps) {
  const defer = deps.defer || ((fn) => setTimeout(fn, 0));
  let phase = 'idle';
  let tokens = 0;
  let seed = null;
  let held = [];

  function start() {
    if (phase !== 'idle') return;
    const threshold = deps.getThreshold();
    const used = deps.getUsedTokens();
    if (!(threshold > 0) || !(used >= threshold) || !deps.canStart()) return;
    phase = 'summarizing';
    tokens = used;
    deps.onSummarizing({ tokens: used, threshold });
    Promise.resolve()
      .then(() => deps.sendRequest(buildHandoffRequest(used)))
      .then((res) => { if (!res?.success) fail(); })
      .catch(() => fail());
  }

  function fail() {
    if (phase !== 'summarizing') return;
    phase = 'off';
    const pending = held;
    held = [];
    deps.onFailed(pending);
  }

  return {
    /** After a successful turn: hand off if the window is past the threshold. */
    afterTurn() {
      if (phase === 'idle') defer(start);
    },

    /**
     * Every `result` goes through here first.
     * @returns {boolean} whether it was the summary turn's
     */
    onTurnResult(message) {
      if (phase !== 'summarizing') return false;
      const summary = typeof message?.result === 'string' ? message.result.trim() : '';
      if (message?.is_error || (message?.subtype && message.subtype !== 'success') || !summary) {
        fail();
        return true;
      }
      phase = 'ready';
      seed = { summary, previousSessionId: deps.getCliSessionId() || '', tokens };
      const pending = held;
      held = [];
      deps.onReady(seed, pending);
      return true;
    },

    /** The summary turn was stopped or the session went away under it. */
    onAborted() { fail(); },

    isSummarizing() { return phase === 'summarizing'; },

    /** A message typed while the summary is being written. */
    hold(message) { held.push(message); },

    /**
     * The seed for the session about to open, once. The tab can hand off
     * again later, from the new session.
     */
    takeSeed() {
      if (phase !== 'ready') return null;
      const out = seed;
      seed = null;
      phase = 'idle';
      return out;
    },

    /** The new session failed to open: keep the seed for the next attempt. */
    restoreSeed(previous) {
      if (!previous || phase !== 'idle') return;
      seed = previous;
      phase = 'ready';
    },

    get phase() { return phase; },
  };
}

module.exports = {
  DEFAULT_HANDOFF_THRESHOLD,
  MIN_HANDOFF_THRESHOLD,
  normalizeHandoffThreshold,
  autoCompactWindowFor,
  buildHandoffRequest,
  parseHandoffRequest,
  buildHandoffSeed,
  parseHandoffSeed,
  createContextHandoff,
};
