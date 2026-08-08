'use strict';

const { assert } = require('../sandbox');

/**
 * wait has two very different jobs behind one node: a timer, and a human
 * approval gate. Durations here are deliberately tiny — the point is the
 * branching and the callback contract, not the clock.
 */

/** Resolve the first approval callback the node registers, as a fake human. */
function approveAsSoonAsRegistered(sb, payload) {
  const iv = setInterval(() => {
    const first = sb.ctx.waitCallbacks.values().next();
    if (!first.done) { clearInterval(iv); first.value(payload); }
  }, 5);
  const stop = setTimeout(() => clearInterval(iv), 2000);
  stop.unref?.();
}

module.exports = {
  type: 'wait',
  scenarios: [
    {
      name: 'duration mode returns only after the configured time has actually elapsed',
      async setup(sb) { sb.t0 = Date.now(); },
      config: { mode: 'duration', duration: '120ms' },
      assert(out, sb) {
        const elapsed = Date.now() - sb.t0;
        assert.strictEqual(out.waited, 120);
        assert.strictEqual(out.timedOut, false);
        assert.ok(elapsed >= 100, `returned after only ${elapsed}ms — it did not wait`);
      },
    },
    {
      name: 'a fractional seconds duration is converted to milliseconds',
      config: { mode: 'duration', duration: '0.15s' },
      assert(out) {
        assert.strictEqual(out.waited, 150);
      },
    },
    {
      name: 'duration is the default mode when none is configured',
      config: { duration: '10ms' },
      assert(out) {
        assert.strictEqual(out.waited, 10);
        assert.strictEqual(out.timedOut, false);
      },
    },
    {
      name: 'a bare number in the duration field is read as milliseconds',
      config: { mode: 'duration', duration: '150' },
      assert(out) {
        assert.strictEqual(out.waited, 150, `a unitless duration became ${out.waited}ms`);
      },
    },
    {
      name: 'a zero duration returns immediately instead of being treated as unset',
      async setup(sb) { sb.t0 = Date.now(); },
      config: { mode: 'duration', duration: '0ms' },
      assert(out, sb) {
        assert.strictEqual(out.waited, 0);
        assert.ok(Date.now() - sb.t0 < 1000, 'a zero wait fell back to a long default');
      },
    },
    {
      name: 'approval mode resumes when a human approves',
      async setup(sb) { approveAsSoonAsRegistered(sb, { approved: true, timedOut: false }); },
      config: { mode: 'approval' },
      assert(out) {
        assert.strictEqual(out.approved, true);
        assert.strictEqual(out.timedOut, false);
      },
    },
    {
      name: 'an approved wait deregisters its callback so a run cannot be resumed twice',
      async setup(sb) { approveAsSoonAsRegistered(sb, { approved: true }); },
      config: { mode: 'approval' },
      assert(out, sb) {
        assert.strictEqual(out.approved, true);
        assert.strictEqual(sb.ctx.waitCallbacks.size, 0, 'a stale approval callback was left behind');
      },
    },
    {
      name: 'an unapproved wait gives up at its timeout and reports it timed out',
      config: { mode: 'approval', timeout: '80ms' },
      assert(out, sb) {
        assert.strictEqual(out.timedOut, true);
        assert.strictEqual(out.approved, false);
        assert.strictEqual(sb.ctx.waitCallbacks.size, 0, 'the timed-out callback was left registered');
      },
    },
    {
      name: 'approval mode is not short-circuited by the default duration property',
      // `duration` has a non-empty default ('5s'), so a node that tested the
      // duration before the mode would silently sleep instead of asking anyone.
      async setup(sb) { sb.t0 = Date.now(); },
      config: { mode: 'approval', duration: '5s', timeout: '80ms' },
      assert(out, sb) {
        const elapsed = Date.now() - sb.t0;
        assert.strictEqual(out.timedOut, true, 'it slept through the approval gate');
        assert.ok(elapsed < 2000, `waited ${elapsed}ms — it used the duration, not the approval timeout`);
      },
    },
    {
      name: 'a waiting approval is registered under the run id so it can be resumed',
      async setup(sb) {
        // Not unref'd: an approval-mode wait with no timeout registers no timer
        // of its own, so this is the only thing holding the event loop open.
        setTimeout(() => {
          sb.registeredKeys = [...sb.ctx.waitCallbacks.keys()];
          const first = sb.ctx.waitCallbacks.values().next();
          if (!first.done) first.value({ approved: true });
        }, 20);
      },
      config: { mode: 'approval' },
      assert(out, sb) {
        assert.deepStrictEqual(out, { approved: true });
        assert.ok(sb.registeredKeys?.length === 1, 'no approval callback was registered while waiting');
        assert.ok(sb.registeredKeys[0].startsWith('lab-run::'), `key not scoped to the run: ${sb.registeredKeys[0]}`);
      },
    },
  ],
};
