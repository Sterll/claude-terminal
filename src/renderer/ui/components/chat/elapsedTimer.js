/**
 * "Ça fait combien de temps que Claude tourne" — the turn's wall clock, in the
 * chat footer next to the status text.
 *
 * Wall clock deliberately, not the SDK's `result.duration_ms`: that number only
 * exists once the turn is over, and what the reader wants *while* waiting is how
 * long they have been waiting — permission prompts and tool runs included.
 *
 * The start instant is held here rather than on the thinking indicator, because
 * that element is removed and rebuilt on nearly every stream event (see the
 * ~20 `removeThinkingIndicator()` calls in ChatView). A counter living on it
 * would restart a dozen times per turn.
 */

/** "8s", "1m 04s", "2h 05m" — seconds stay visible up to the hour. */
function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * @param {HTMLElement} el - the `.chat-status-elapsed` span it writes into.
 */
function createElapsedTimer(el) {
  let startedAt = 0;
  let ticker = null;

  function _paint() {
    if (el) el.textContent = formatElapsed(Date.now() - startedAt);
  }

  /** Begin a turn. Idempotent: a second call while running is not a restart. */
  function start() {
    if (ticker) return;
    startedAt = Date.now();
    if (el) {
      el.classList.remove('done');
      el.hidden = false;
    }
    _paint();
    ticker = setInterval(_paint, 1000);
  }

  /**
   * End the turn, leaving the total on screen (dimmed) — "that one took 3m 12s"
   * is the answer the user came for, and it is gone the moment they send again.
   */
  function stop() {
    if (!ticker) return;
    clearInterval(ticker);
    ticker = null;
    _paint(); // land on the true total, not on whatever the last tick showed
    if (el) el.classList.add('done');
  }

  /** Drop it entirely — new session, or the view going away. */
  function clear() {
    if (ticker) { clearInterval(ticker); ticker = null; }
    startedAt = 0;
    if (el) {
      el.textContent = '';
      el.hidden = true;
      el.classList.remove('done');
    }
  }

  return {
    start,
    stop,
    clear,
    destroy: clear,
    isRunning: () => ticker !== null,
    elapsedMs: () => (startedAt ? Date.now() - startedAt : 0),
  };
}

module.exports = { createElapsedTimer, formatElapsed };
