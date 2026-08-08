'use strict';

const { assert, EXEC } = require('../sandbox');

/**
 * error_handler is a try/catch subgraph. error_handler.node.js run() is a
 * placeholder returning `{ caught: false }`, so it proves nothing on its own —
 * every scenario drives the real runner.
 *
 * Slots, from error_handler.node.js:
 *   inputs  0 = In (exec)
 *   outputs 0 = TRY (exec), 1 = CATCH (exec), 2 = error, 3 = caught
 *
 * Which branch ran is read from the `workflow-log` messages, so a scenario
 * cannot pass just because a node object exists in the outputs map.
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
    handler(id) {
      nodes.push({
        id, type: 'workflow/error_handler', properties: {},
        inputs: [{ name: 'In', type: EXEC, link: null }],
        outputs: [
          { name: 'TRY',    type: EXEC,      links: [] },
          { name: 'CATCH',  type: EXEC,      links: [] },
          { name: 'error',  type: 'string',  links: [] },
          { name: 'caught', type: 'boolean', links: [] },
        ],
      });
      return id;
    },
    /** A transform with an unknown operation — throws; slot 1 is its Error pin. */
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

module.exports = {
  type: 'error_handler',
  scenarios: [
    {
      name: 'a throw inside TRY routes to CATCH and exposes the error text',
      graph() {
        const g = builder();
        g.trigger(1);
        g.handler(2);
        g.boom(3);
        g.log(4, 'caught:$node_2.error');
        g.link(1, 0, 2);
        g.link(2, 0, 3);   // TRY   -> boom
        g.link(2, 1, 4);   // CATCH -> handler log
        return g.build();
      },
      assert(result, sb) {
        assert.strictEqual(result.outputs.node_2.caught, true);
        assert.match(result.outputs.node_2.error, /Unknown transform operation: boom/);
        assert.deepStrictEqual(logMessages(sb), ['caught:Unknown transform operation: boom'],
          'the CATCH branch must run and be able to read $node_<id>.error');
        // Documented behaviour (WorkflowRunner.js:1531) — an explicit try/catch
        // is handled by design, so the RUN is still a success.
        assert.strictEqual(result.success, true, result.error);
      },
    },
    {
      name: 'a TRY branch that never throws takes the normal path and CATCH stays cold',
      graph() {
        const g = builder();
        g.trigger(1);
        g.handler(2);
        g.log(3, 'try-ok');
        g.log(4, 'catch-ran');
        g.link(1, 0, 2);
        g.link(2, 0, 3);
        g.link(2, 1, 4);
        return g.build();
      },
      assert(result, sb) {
        assert.strictEqual(result.success, true, result.error);
        assert.deepStrictEqual(logMessages(sb), ['try-ok'], 'CATCH must not run');
        assert.strictEqual(result.outputs.node_2.caught, false);
        assert.strictEqual(result.outputs.node_2.error, null);
      },
    },
    {
      name: 'the remainder of the TRY branch is skipped once a node throws',
      graph() {
        const g = builder();
        g.trigger(1);
        g.handler(2);
        g.log(3, 'try-step-1');
        g.boom(4);
        g.log(5, 'try-step-3');   // downstream of the throw — must never run
        g.log(6, 'handled');
        g.link(1, 0, 2);
        g.link(2, 0, 3);
        g.link(3, 0, 4);
        g.link(4, 0, 5);
        g.link(2, 1, 6);
        return g.build();
      },
      assert(result, sb) {
        assert.strictEqual(result.success, true, result.error);
        assert.deepStrictEqual(logMessages(sb), ['try-step-1', 'handled']);
        assert.strictEqual(result.outputs.node_5, undefined, 'nodes after the throw must not run');
      },
    },
    {
      name: 'a node that handles its own failure on its Error pin never reaches CATCH',
      graph() {
        const g = builder();
        g.trigger(1);
        g.handler(2);
        g.boom(3);
        g.log(4, 'local-handler');
        g.log(5, 'catch-ran');
        g.link(1, 0, 2);
        g.link(2, 0, 3);   // TRY -> boom
        g.link(3, 1, 4);   // boom Error pin -> local handler
        g.link(2, 1, 5);   // CATCH
        return g.build();
      },
      assert(result, sb) {
        assert.strictEqual(result.success, true, result.error);
        assert.deepStrictEqual(logMessages(sb), ['local-handler'], 'CATCH must stay cold');
        assert.strictEqual(result.outputs.node_2.caught, false);
        assert.strictEqual(result.outputs.node_3.caught, true, 'the node itself recorded the catch');
      },
    },
    {
      name: 'an error_handler with nothing wired to TRY reports nothing caught',
      graph() {
        const g = builder();
        g.trigger(1);
        g.handler(2);
        g.log(3, 'catch-ran');
        g.link(1, 0, 2);
        g.link(2, 1, 3);   // only CATCH is wired
        return g.build();
      },
      assert(result, sb) {
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(result.outputs.node_2.caught, false);
        assert.deepStrictEqual(logMessages(sb), [], 'an empty TRY must not trip CATCH');
      },
    },
    {
      name: 'a throw inside CATCH is not swallowed — the run fails',
      graph() {
        const g = builder();
        g.trigger(1);
        g.handler(2);
        g.boom(3);         // TRY throws
        g.log(4, 'entering-catch');
        g.boom(5);         // ...and so does the CATCH branch
        g.link(1, 0, 2);
        g.link(2, 0, 3);
        g.link(2, 1, 4);
        g.link(4, 0, 5);
        return g.build();
      },
      assert(result, sb) {
        assert.strictEqual(result.success, false, 'a failing CATCH branch must surface');
        assert.match(result.error, /Unknown transform operation/);
        assert.deepStrictEqual(logMessages(sb), ['entering-catch']);
      },
    },
  ],
};
