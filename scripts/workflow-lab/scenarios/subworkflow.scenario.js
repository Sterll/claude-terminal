'use strict';

const { assert, EXEC } = require('../sandbox');

/**
 * subworkflow calls another workflow through `ctx.workflowService`, which the
 * sandbox leaves null. Every scenario that needs a service installs a recording
 * fake in `setup(sb)` — the run then proves what the node asked it for.
 *
 * The runner dispatches subworkflow as a NORMAL step (it has no special branch
 * in _executeGraph), so slot 0 = Done and slot 1 = Error, per subworkflow.node.js:
 *   inputs  0 = In (exec)
 *   outputs 0 = Done (exec), 1 = Error (exec), 2 = outputs, 3 = runId
 *
 * NOTE: waiting scenarios really sleep — the node polls getRun() once a second.
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
    sub(id, properties) {
      nodes.push({
        id, type: 'workflow/subworkflow', properties,
        inputs: [{ name: 'In', type: EXEC, link: null }],
        outputs: [
          { name: 'Done',    type: EXEC,     links: [] },
          { name: 'Error',   type: EXEC,     links: [] },
          { name: 'outputs', type: 'object', links: [] },
          { name: 'runId',   type: 'string', links: [] },
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

/**
 * Install a recording workflowService.
 * @param sb
 * @param opts.triggerResult   what trigger() resolves to
 * @param opts.runStates       statuses getRun() returns, one per poll (last repeats)
 */
function installService(sb, { triggerResult = { success: true, runId: 'child-run-1' }, runStates = [] } = {}) {
  sb.calls = { trigger: [], getRun: [], cancel: [] };
  sb.ctx.workflowService = {
    async trigger(ref, opts) {
      sb.calls.trigger.push({ ref, opts });
      return triggerResult;
    },
    async getRun(runId) {
      sb.calls.getRun.push(runId);
      const idx = Math.min(sb.calls.getRun.length - 1, runStates.length - 1);
      return runStates[idx];
    },
    cancel(runId) { sb.calls.cancel.push(runId); },
  };
}

/** trigger -> subworkflow, Done -> log, Error -> log */
function subGraph(properties) {
  const g = builder();
  g.trigger(1);
  g.sub(2, properties);
  g.log(3, 'done:$node_2.runId');
  g.log(4, 'error:$node_2.error');
  g.link(1, 0, 2);
  g.link(2, 0, 3);   // Done
  g.link(2, 1, 4);   // Error
  return g.build();
}

module.exports = {
  type: 'subworkflow',
  scenarios: [
    {
      name: 'waitForCompletion=false triggers the child and continues without polling',
      async setup(sb) {
        installService(sb, { triggerResult: { success: true, runId: 'child-run-1' } });
      },
      graph: () => subGraph({ workflow: 'nightly-build', waitForCompletion: false, inputVars: 'env=prod,tag=v1' }),
      assert(result, sb) {
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(sb.calls.trigger.length, 1, 'the child must be triggered exactly once');
        assert.strictEqual(sb.calls.getRun.length, 0, 'fire-and-forget must never poll');

        const { ref, opts } = sb.calls.trigger[0];
        assert.strictEqual(ref, 'nightly-build');
        assert.strictEqual(opts.source, 'subworkflow');
        assert.deepStrictEqual(opts.extraVars, { env: 'prod', tag: 'v1' },
          'key=value inputVars must reach the child');
        assert.strictEqual(opts.triggerData.__subworkflowDepth, 1,
          'the child must be told it is one level deeper');

        assert.strictEqual(result.outputs.node_2.waited, false);
        assert.strictEqual(result.outputs.node_2.runId, 'child-run-1');
        assert.deepStrictEqual(logMessages(sb), ['done:child-run-1'], 'the Done branch must run');
      },
    },
    {
      name: 'waitForCompletion=true polls until the child finishes and forwards its outputs',
      async setup(sb) {
        installService(sb, {
          triggerResult: { success: true, runId: 'child-run-2' },
          runStates: [
            { id: 'child-run-2', status: 'running' },
            { id: 'child-run-2', status: 'success', outputs: { node_9: { answer: 42 } } },
          ],
        });
      },
      graph: () => subGraph({ workflow: 'child', waitForCompletion: true }),
      assert(result, sb) {
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(sb.calls.getRun.length, 2,
          'it must keep polling while the child is still running');
        assert.strictEqual(result.outputs.node_2.waited, true);
        assert.deepStrictEqual(result.outputs.node_2.outputs, { node_9: { answer: 42 } });
        assert.deepStrictEqual(logMessages(sb), ['done:child-run-2']);
        assert.deepStrictEqual(sb.calls.cancel, [], 'a completed child must not be cancelled');
      },
    },
    {
      name: 'a child run that fails routes down the Error branch',
      async setup(sb) {
        installService(sb, {
          triggerResult: { success: true, runId: 'child-run-3' },
          runStates: [{ id: 'child-run-3', status: 'failed' }],
        });
      },
      graph: () => subGraph({ workflow: 'child', waitForCompletion: true }),
      assert(result, sb) {
        // The Error pin is wired, so the failure is handled by design.
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(result.outputs.node_2.caught, true);
        assert.match(result.outputs.node_2.error, /Sub-workflow "child" failed/);
        assert.deepStrictEqual(logMessages(sb), ['error:Sub-workflow "child" failed']);
      },
    },
    {
      name: 'a service that refuses to start the child fails the run when nothing handles it',
      async setup(sb) {
        installService(sb, { triggerResult: { success: false, error: 'workflow not found' } });
      },
      graph() {
        // No Error pin wired -> the throw must be fatal.
        const g = builder();
        g.trigger(1);
        g.sub(2, { workflow: 'ghost', waitForCompletion: false });
        g.log(3, 'done');
        g.link(1, 0, 2);
        g.link(2, 0, 3);
        return g.build();
      },
      assert(result, sb) {
        assert.strictEqual(result.success, false);
        assert.match(result.error, /could not start: workflow not found/);
        assert.deepStrictEqual(logMessages(sb), [], 'the Done branch must not run');
      },
    },
    {
      name: 'a missing workflow reference fails before the service is called at all',
      async setup(sb) { installService(sb); },
      graph() {
        const g = builder();
        g.trigger(1);
        g.sub(2, { workflow: '', waitForCompletion: false });
        g.log(3, 'done');
        g.link(1, 0, 2);
        g.link(2, 0, 3);
        return g.build();
      },
      assert(result, sb) {
        assert.strictEqual(result.success, false);
        assert.match(result.error, /missing workflow name or ID/);
        assert.strictEqual(sb.calls.trigger.length, 0);
      },
    },
    {
      name: 'the recursion guard refuses to descend past depth 10',
      async setup(sb) {
        installService(sb);
        // Depth travels in the trigger payload; extraVars override run.triggerData.
        sb.vars.set('trigger', { parent: true, __subworkflowDepth: 10 });
      },
      graph() {
        const g = builder();
        g.trigger(1);
        g.sub(2, { workflow: 'child', waitForCompletion: false });
        g.log(3, 'done');
        g.link(1, 0, 2);
        g.link(2, 0, 3);
        return g.build();
      },
      assert(result, sb) {
        assert.strictEqual(result.success, false);
        assert.match(result.error, /recursion limit reached \(depth 10 >= 10\)/);
        assert.strictEqual(sb.calls.trigger.length, 0, 'the child must never be started');
      },
    },
    {
      name: 'without a workflowService the call degrades to a fire-and-forget request',
      // sb.ctx.workflowService stays null — no setup on purpose.
      graph: () => subGraph({ workflow: 'child', waitForCompletion: true }),
      assert(result, sb) {
        assert.strictEqual(result.success, true, result.error);
        const req = sb.sentOn('workflow-trigger-subworkflow');
        assert.ok(req, 'the node must emit a request the renderer can pick up');
        assert.strictEqual(req.workflow, 'child');
        assert.strictEqual(req.triggerData.__subworkflowDepth, 1);
        assert.strictEqual(result.outputs.node_2.triggered, true);
        assert.strictEqual(result.outputs.node_2.waited, false,
          'it must not block when there is nothing to poll');
      },
    },
  ],
};
