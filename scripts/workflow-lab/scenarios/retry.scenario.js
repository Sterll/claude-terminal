'use strict';

const { assert, EXEC } = require('../sandbox');

/**
 * retry re-executes its TRY subgraph; retry.node.js run() is a placeholder, so
 * all the semantics live in WorkflowRunner and every scenario drives it.
 *
 * Slots, from retry.node.js:
 *   inputs  0 = In (exec)
 *   outputs 0 = TRY (exec), 1 = FAIL (exec), 2 = attempts, 3 = error
 *
 * Attempts are counted from the `workflow-log` messages the TRY branch emits —
 * `outputs.node_<try>` is overwritten on each attempt and cannot distinguish
 * one execution from three.
 *
 * "Fail once then succeed" needs state that survives an attempt. The runner
 * hands the SAME vars Map to every attempt, so a `variable/increment` node
 * inside TRY is a real attempt counter, and a condition on it decides whether
 * that attempt throws.
 */

// ── graph helpers ────────────────────────────────────────────────────────────

function builder() {
  const nodes = [];
  const links = [];
  let linkId  = 1;

  const api = {
    trigger(id) {
      nodes.push({
        id, type: 'workflow/trigger', properties: {},
        inputs: [], outputs: [{ name: 'Start', type: EXEC, links: [] }],
      });
      return id;
    },
    log(id, message) {
      nodes.push({
        id, type: 'workflow/log', properties: { level: 'info', message },
        inputs: [
          { name: 'In', type: EXEC, link: null },
          { name: 'message', type: 'string', link: null },
        ],
        outputs: [{ name: 'Done', type: EXEC, links: [] }],
      });
      return id;
    },
    retry(id, properties) {
      nodes.push({
        id, type: 'workflow/retry', properties,
        inputs: [{ name: 'In', type: EXEC, link: null }],
        outputs: [
          { name: 'TRY',      type: EXEC,     links: [] },
          { name: 'FAIL',     type: EXEC,     links: [] },
          { name: 'attempts', type: 'number', links: [] },
          { name: 'error',    type: 'string', links: [] },
        ],
      });
      return id;
    },
    increment(id, name) {
      nodes.push({
        id, type: 'workflow/variable', properties: { action: 'increment', name, value: '1' },
        inputs: [{ name: 'In', type: EXEC, link: null }],
        outputs: [
          { name: 'Done',  type: EXEC,  links: [] },
          { name: 'value', type: 'any', links: [] },
        ],
      });
      return id;
    },
    condition(id, properties) {
      nodes.push({
        id, type: 'workflow/condition', properties,
        inputs: [{ name: 'In', type: EXEC, link: null }],
        outputs: [
          { name: 'TRUE',  type: EXEC, links: [] },
          { name: 'FALSE', type: EXEC, links: [] },
        ],
      });
      return id;
    },
    /** A transform with an unknown operation — throws, and its Error pin is free. */
    boom(id) {
      nodes.push({
        id, type: 'workflow/transform', properties: { operation: 'boom' },
        inputs: [
          { name: 'In', type: EXEC, link: null },
          { name: 'input', type: 'any', link: null },
        ],
        outputs: [
          { name: 'Done',   type: EXEC,     links: [] },
          { name: 'Error',  type: EXEC,     links: [] },
          { name: 'result', type: 'any',    links: [] },
          { name: 'count',  type: 'number', links: [] },
        ],
      });
      return id;
    },
    link(originId, originSlot, targetId, targetSlot = 0) {
      links.push([linkId++, originId, originSlot, targetId, targetSlot, EXEC]);
    },
    build() { return { nodes, links }; },
  };
  return api;
}

function logMessages(sb) {
  return sb.sent.filter(s => s.channel === 'workflow-log').map(s => s.payload.message);
}

/** trigger -> retry, TRY -> log('attempt') -> boom, FAIL -> log('fail:<error>') */
function alwaysFailingGraph(retryProps) {
  const g = builder();
  g.trigger(1);
  g.retry(2, retryProps);
  g.log(3, 'attempt');
  g.boom(4);
  g.log(5, 'fail:$node_2.error');
  g.link(1, 0, 2);
  g.link(2, 0, 3);   // TRY  -> log
  g.link(3, 0, 4);   // log  -> boom
  g.link(2, 1, 5);   // FAIL -> handler
  return g.build();
}

module.exports = {
  type: 'retry',
  scenarios: [
    {
      name: 'a TRY branch that succeeds runs once and reports exactly one attempt',
      graph() {
        const g = builder();
        g.trigger(1);
        g.retry(2, { maxAttempts: 3, delayMs: 0, backoff: 'none' });
        g.log(3, 'try-ran');
        g.log(4, 'fail-branch');
        g.link(1, 0, 2);
        g.link(2, 0, 3);
        g.link(2, 1, 4);
        return g.build();
      },
      assert(result, sb) {
        assert.strictEqual(result.success, true, result.error);
        assert.deepStrictEqual(logMessages(sb), ['try-ran'], 'the FAIL branch must not run');
        assert.strictEqual(result.outputs.node_2.attempts, 1);
        assert.strictEqual(result.outputs.node_2.error, null);
      },
    },
    {
      name: 'a TRY branch that throws once is retried and then succeeds',
      graph() {
        // TRY: increment $tries -> condition($tries < 2) ? boom : log('recovered')
        const g = builder();
        g.trigger(1);
        g.retry(2, { maxAttempts: 3, delayMs: 0, backoff: 'none' });
        g.increment(3, 'tries');
        g.condition(4, { _condMode: 'builder', variable: '$tries', operator: '<', value: '2' });
        g.boom(5);
        g.log(6, 'recovered');
        g.log(7, 'fail-branch');
        g.link(1, 0, 2);
        g.link(2, 0, 3);   // TRY -> increment
        g.link(3, 0, 4);   // increment -> condition
        g.link(4, 0, 5);   // TRUE  -> boom  (attempt 1)
        g.link(4, 1, 6);   // FALSE -> log   (attempt 2)
        g.link(2, 1, 7);   // FAIL branch
        return g.build();
      },
      assert(result, sb) {
        assert.strictEqual(result.outputs.node_2.attempts, 2, 'the body ran twice');
        assert.strictEqual(result.outputs.node_2.error, null, 'the retry ultimately succeeded');
        assert.deepStrictEqual(logMessages(sb), ['recovered'], 'the FAIL branch must not run');
        // Documented behaviour (WorkflowRunner.js:1596) — recovering after >1
        // attempt is deliberately NOT a clean success at the run level.
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.degraded, true);
      },
    },
    {
      name: 'exhausting every attempt runs the FAIL branch with the last error',
      graph: () => alwaysFailingGraph({ maxAttempts: 3, delayMs: 0, backoff: 'none' }),
      assert(result, sb) {
        const msgs = logMessages(sb);
        assert.deepStrictEqual(
          msgs.filter(m => m === 'attempt').length, 3,
          'the TRY branch must actually execute 3 times',
        );
        assert.strictEqual(result.outputs.node_2.attempts, 3);
        assert.match(result.outputs.node_2.error, /Unknown transform operation/);
        assert.strictEqual(result.outputs.node_2.success, false);
        // The FAIL branch ran, and it can read the error off the retry node.
        assert.match(msgs[msgs.length - 1], /^fail:.*Unknown transform operation/);
        assert.strictEqual(result.success, false, 'retry exhaustion is a run failure');
        assert.strictEqual(result.degraded, true);
      },
    },
    {
      name: 'maxAttempts of 1 means the body runs once and is never retried',
      graph: () => alwaysFailingGraph({ maxAttempts: 1, delayMs: 0, backoff: 'none' }),
      assert(result, sb) {
        const msgs = logMessages(sb);
        assert.strictEqual(msgs.filter(m => m === 'attempt').length, 1);
        assert.strictEqual(result.outputs.node_2.attempts, 1);
        assert.ok(msgs.some(m => m.startsWith('fail:')), 'the FAIL branch must still run');
      },
    },
    {
      name: 'exponential backoff actually waits between attempts',
      async setup(sb) { sb.startedAt = Date.now(); },
      // 3 attempts, base 60 ms exponential -> waits 60 ms then 120 ms = 180 ms.
      graph: () => alwaysFailingGraph({ maxAttempts: 3, delayMs: 60, backoff: 'exponential' }),
      assert(result, sb) {
        assert.strictEqual(result.outputs.node_2.attempts, 3);
        const elapsed = Date.now() - sb.startedAt;
        assert.ok(elapsed >= 170, `expected >=170 ms of backoff, ran in ${elapsed} ms`);
      },
    },
    {
      name: 'a retry with nothing wired to TRY is a no-op reporting zero attempts',
      graph() {
        const g = builder();
        g.trigger(1);
        g.retry(2, { maxAttempts: 3, delayMs: 0, backoff: 'none' });
        g.log(3, 'fail-branch');
        g.link(1, 0, 2);
        g.link(2, 1, 3);   // only FAIL is wired
        return g.build();
      },
      assert(result, sb) {
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(result.outputs.node_2.attempts, 0);
        assert.deepStrictEqual(logMessages(sb), [], 'an empty TRY must not trip the FAIL branch');
      },
    },
  ],
};
