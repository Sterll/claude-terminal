/**
 * BackgroundTaskReconciler
 *
 * Decides when a background-task card whose end was never announced should be
 * settled anyway.
 *
 * The CLI describes background tasks through two feeds. `task_started` /
 * `task_notification` are edge bookends and are the only source that knows *how*
 * a task ended. `background_tasks_changed` carries the full live set on every
 * membership change and is authoritative about *whether* one is still running.
 * The SDK is explicit that consumers must key "is it running" off the set, so a
 * bookend that never arrives — a dropped frame, a CLI restart — cannot wedge a
 * spinner forever.
 *
 * Ordering between the two feeds is unspecified, and in practice the set drops a
 * task slightly *before* its bookend lands. Settling the moment a task leaves
 * the set would therefore flash a generic outcome over the real one on every
 * normal completion. Hence the grace window: only a task still running after it
 * is treated as one whose bookend is never coming.
 *
 * Pure with respect to the DOM — it owns ids and timers, the caller owns cards.
 */

'use strict';

const DEFAULT_GRACE_MS = 2000;

class BackgroundTaskReconciler {
  /**
   * @param {object} opts
   * @param {(taskId: string) => void} opts.onSettle Called when a task has been
   *   absent from the live set for the whole grace window.
   * @param {number} [opts.graceMs]
   * @param {(fn: Function, ms: number) => any} [opts.setTimer] Injectable for tests.
   * @param {(handle: any) => void} [opts.clearTimer]
   */
  constructor({ onSettle, graceMs = DEFAULT_GRACE_MS, setTimer, clearTimer } = {}) {
    this._onSettle = typeof onSettle === 'function' ? onSettle : () => {};
    this._graceMs = graceMs;
    this._setTimer = setTimer || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimer = clearTimer || ((h) => clearTimeout(h));
    /** @type {Map<string, any>} taskId -> pending timer handle */
    this._pending = new Map();
  }

  /**
   * Reconcile the live set against the tasks the caller still shows as running.
   *
   * @param {Iterable<string>} liveIds Task ids in the latest `background_tasks_changed`.
   * @param {Iterable<string>} runningIds Task ids the caller currently renders as running.
   */
  sync(liveIds, runningIds) {
    const live = liveIds instanceof Set ? liveIds : new Set(liveIds || []);
    for (const taskId of runningIds || []) {
      if (!taskId) continue;
      if (live.has(taskId)) {
        // Back in the set: the earlier absence was transient, so the task is
        // still running and any pending settle must be called off.
        this.cancel(taskId);
        continue;
      }
      if (this._pending.has(taskId)) continue;
      this._pending.set(taskId, this._setTimer(() => {
        this._pending.delete(taskId);
        this._onSettle(taskId);
      }, this._graceMs));
    }
  }

  /** The bookend won the race — drop any backstop for this task. */
  cancel(taskId) {
    const handle = this._pending.get(taskId);
    if (handle === undefined) return;
    this._clearTimer(handle);
    this._pending.delete(taskId);
  }

  /** @returns {boolean} whether a settle is currently scheduled for `taskId`. */
  isPending(taskId) {
    return this._pending.has(taskId);
  }

  dispose() {
    for (const handle of this._pending.values()) this._clearTimer(handle);
    this._pending.clear();
  }
}

module.exports = { BackgroundTaskReconciler, DEFAULT_GRACE_MS };
