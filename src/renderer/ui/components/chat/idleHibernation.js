/**
 * Idle chat sessions go to sleep.
 *
 * A chat tab keeps its Claude Code process for as long as the tab is open: the
 * SDK runs it in streaming input mode, and only closing the session ends it.
 * One tab opened once and forgotten keeps a few hundred megabytes for the life
 * of the app. Restarting the app, or closing the tab and reopening it from the
 * history, frees that memory without losing anything, because a tab restored
 * that way holds only the session id and starts the CLI with `--resume` on its
 * next message.
 *
 * This does the same on its own. Once a tab has been idle for the configured
 * delay, its session is closed and the tab goes back to that restored state.
 * Nothing on screen changes; the next message resumes the conversation.
 *
 * A tab is never put to sleep while anything is still in flight or waiting on
 * the user, nor while it is the tab the user has open: see shouldHibernate().
 */

/** Default delay, in minutes. 0 (the setting) means never. */
const DEFAULT_HIBERNATE_MINUTES = 15;

/** How soon a check that was refused looks again. */
const RECHECK_MS = 60 * 1000;

/**
 * The setting, as a delay in milliseconds, or 0 for never.
 * @param {unknown} minutes - `chatHibernateMinutes` as stored
 * @returns {number}
 */
function hibernateDelayMs(minutes) {
  if (minutes === null || minutes === undefined || minutes === '') return DEFAULT_HIBERNATE_MINUTES * 60 * 1000;
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 60 * 1000);
}

/**
 * Whether a tab may be put to sleep now.
 *
 * Every field is about what closing the session would cut off or make
 * impossible to pick up again. Anything unknown counts against it.
 *
 * @param {Object} state
 * @param {number} state.delayMs - hibernateDelayMs(); 0 is never
 * @param {number} state.idleMs - time since the tab's last activity
 * @param {boolean} state.hasSession - a CLI process is running for this tab
 * @param {boolean} state.resumable - its transcript can be resumed (an id, and saved to disk)
 * @param {boolean} state.active - it is the tab the user has open
 * @param {boolean} state.busy - a turn running, an abort, a send or an account switch in flight
 * @param {boolean} state.waitingOnUser - a permission, question or plan card unanswered
 * @param {boolean} state.queued - a message or a model/effort switch waiting to go out
 * @param {boolean} state.handoff - the context handoff is writing its summary
 * @param {boolean} state.runningTasks - a background task of this tab is still running
 * @param {boolean} state.shared - mirrored to claude.ai through Remote Control
 * @param {boolean} state.cloud - a cloud project, whose session is not a local process
 * @returns {boolean}
 */
function shouldHibernate(state) {
  if (!state || !(state.delayMs > 0)) return false;
  if (!(state.idleMs >= state.delayMs)) return false;
  if (!state.hasSession || !state.resumable) return false;
  return !state.active
    && !state.busy
    && !state.waitingOnUser
    && !state.queued
    && !state.handoff
    && !state.runningTasks
    && !state.shared
    && !state.cloud;
}

/**
 * One tab's sleep timer.
 *
 * Activity is reported through touch(); the timer fires once the delay has
 * passed since the last one, and either puts the tab to sleep or looks again a
 * minute later. A tab with no session has nothing to free, so no timer runs
 * until the next touch.
 *
 * @param {Object} deps
 * @param {() => number} deps.getDelayMs - read on every check, so a settings change applies
 * @param {(idleMs: number, delayMs: number) => Object} deps.getState - the shouldHibernate() input
 * @param {() => void} deps.hibernate - close the session and keep the tab resumable
 * @param {() => number} [deps.now]
 */
function createIdleHibernation({ getDelayMs, getState, hibernate, now = () => Date.now() }) {
  let lastActivityAt = now();
  let timer = null;
  let destroyed = false;

  function clear() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function schedule(ms) {
    clear();
    if (destroyed) return;
    timer = setTimeout(check, Math.max(1000, ms));
  }

  function check() {
    timer = null;
    if (destroyed) return;
    const delayMs = getDelayMs();
    // Off: look again later, so turning it on applies to tabs already open
    if (!(delayMs > 0)) { schedule(RECHECK_MS); return; }
    const idleMs = now() - lastActivityAt;
    if (idleMs < delayMs) { schedule(delayMs - idleMs); return; }
    let state;
    try { state = getState(idleMs, delayMs); } catch { state = null; }
    if (!state || !state.hasSession) return; // nothing running: wait for the next touch
    if (shouldHibernate({ ...state, idleMs, delayMs })) {
      try { hibernate(); } catch (e) { console.warn('[chat] hibernation failed:', e?.message); }
      return;
    }
    schedule(RECHECK_MS);
  }

  return {
    /** Something happened in this tab: the delay starts over. */
    touch() {
      if (destroyed) return;
      lastActivityAt = now();
      const delayMs = getDelayMs();
      schedule(delayMs > 0 ? delayMs : RECHECK_MS);
    },
    destroy() {
      destroyed = true;
      clear();
    },
  };
}

module.exports = {
  DEFAULT_HIBERNATE_MINUTES,
  hibernateDelayMs,
  shouldHibernate,
  createIdleHibernation,
};
