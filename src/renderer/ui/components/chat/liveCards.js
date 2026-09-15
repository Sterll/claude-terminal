/**
 * Cards in the transcript that keep ticking after they are rendered.
 *
 * Both hold module-level state on purpose. The background-task subscription
 * is one listener for the whole app rather than one per ChatView, and the
 * wakeup ticker is a single interval that stops itself the moment no card is
 * left on screen — an earlier version armed it on the first ScheduleWakeup of
 * the session and then walked the document every second for the rest of the
 * app's life.
 */

const { renderBgTaskCard, bgTaskStore, formatDuration: fmtDur } = require('../../../utils/toolRegistry');

// ── Background task cards re-render on store update ─────────────────
// Cards for Monitor/TaskOutput/TaskStop read state from bgTaskStore.
// Any mutation refreshes every card currently showing that taskId.
let _bgTaskSubStarted = false;
function ensureBgTaskSubscription() {
  if (_bgTaskSubStarted) return;
  _bgTaskSubStarted = true;
  bgTaskStore.subscribe((taskId) => {
    if (!taskId) return;
    let nodes;
    try {
      nodes = document.querySelectorAll(`[data-bg-task-id="${CSS.escape(taskId)}"]`);
    } catch (_) { return; }
    nodes.forEach((el) => {
      const tool = el.dataset.bgTool || 'TaskOutput';
      const card = el.closest('.chat-tool-card');
      let input = {};
      try {
        input = card && card.dataset.toolInput ? JSON.parse(card.dataset.toolInput) : { task_id: taskId };
      } catch (_) { input = { task_id: taskId }; }
      el.outerHTML = renderBgTaskCard(tool, input);
    });
  });
}

// ── Wakeup countdown ticker (module-level, single global interval) ──
// Runs only while a wakeup card is actually on screen. The first version armed
// the interval on the first ScheduleWakeup of the session and then ticked for
// the rest of the app's life, and its `[data-wakeup-at]` selector carried no
// class or tag to index on — so every second it walked every element in the
// document. On a few long transcripts that is ~20 ms a second, permanently.
let _wakeupTimer = null;

/** @returns {boolean} True while at least one wakeup card is still on screen. */
function _tickWakeups() {
  const nodes = document.querySelectorAll('.chat-wakeup-card[data-wakeup-at]');
  if (!nodes.length) return false;
  const now = Date.now();
  nodes.forEach((el) => {
    const at = Number(el.dataset.wakeupAt) || 0;
    const cd = el.querySelector('[data-countdown]');
    if (!cd) return;
    const remaining = Math.max(0, Math.round((at - now) / 1000));
    if (remaining === 0) {
      cd.textContent = 'fired';
      cd.classList.add('is-fired');
    } else {
      cd.textContent = 'in ' + fmtDur(remaining);
    }
  });
  return true;
}

function ensureWakeupTicker() {
  _tickWakeups();
  if (_wakeupTimer) return;
  _wakeupTimer = setInterval(() => {
    if (!_tickWakeups()) { clearInterval(_wakeupTimer); _wakeupTimer = null; }
  }, 1000);
}

module.exports = { ensureBgTaskSubscription, ensureWakeupTicker };
