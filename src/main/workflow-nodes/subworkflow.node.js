'use strict';

module.exports = {
  type:     'workflow/subworkflow',
  title:    'Sub-workflow',
  desc:     'Appeler un autre workflow',
  color:    'purple',
  width:    220,
  category: 'flow',
  icon:     'subworkflow',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [
    { name: 'Done',    type: 'exec'    },
    { name: 'Error',   type: 'exec'    },
    { name: 'outputs', type: 'object'  },
    { name: 'runId',   type: 'string'  },
  ],

  props: { workflow: '', inputVars: '', waitForCompletion: true },

  fields: [
    { type: 'subworkflow-picker', key: 'workflow', label: 'wfn.subworkflow.label' },
  ],

  badge: (n) => n.properties.workflow ? n.properties.workflow.slice(0, 12).toUpperCase() : 'WORKFLOW',

  async run(config, vars, signal, ctx) {
    const { resolveVars } = require('./_registry');

    const workflowService = ctx?.workflowService;
    const workflowRef = String(resolveVars(config.workflow || '', vars) ?? '').trim();
    if (!workflowRef) throw new Error('Sub-workflow: missing workflow name or ID');

    // ── Recursion guard ─────────────────────────────────────────────────────
    // Depth is threaded through the trigger payload. Each nested call increments
    // it; refuse to descend past MAX_DEPTH to prevent infinite recursion loops.
    const MAX_DEPTH = 10;
    const parentTrigger = (vars instanceof Map ? vars.get('trigger') : vars?.trigger) || {};
    const currentDepth = Number(parentTrigger.__subworkflowDepth) || 0;
    if (currentDepth >= MAX_DEPTH) {
      throw new Error(`Sub-workflow recursion limit reached (depth ${currentDepth} >= ${MAX_DEPTH})`);
    }
    const childDepth = currentDepth + 1;

    let extraVars = {};
    if (config.inputVars) {
      const raw = resolveVars(config.inputVars, vars);
      if (raw && typeof raw === 'object') {
        extraVars = raw;
      } else if (typeof raw === 'string') {
        try {
          extraVars = JSON.parse(raw);
        } catch {
          for (const pair of raw.split(',')) {
            const [k, v] = pair.split('=').map(s => s.trim());
            if (k) extraVars[k] = v ?? '';
          }
        }
      }
    }

    const waitForCompletion = config.waitForCompletion !== false && config.waitForCompletion !== 'no' && config.waitForCompletion !== 'false';

    const triggerData = { parent: true, __subworkflowDepth: childDepth };

    if (!workflowService) {
      // No workflow service available — fire-and-forget via sendFn
      if (ctx?.sendFn) ctx.sendFn('workflow-trigger-subworkflow', { workflow: workflowRef, extraVars, triggerData });
      return { triggered: true, runId: null, waited: false };
    }

    // Service contract: trigger(workflowId, { source, triggerData, extraVars })
    // → { success, runId }. getRun(runId) returns the run record (async).
    const triggerResult = await workflowService.trigger(workflowRef, {
      source: 'subworkflow',
      triggerData,
      extraVars,
    });

    if (!triggerResult || triggerResult.success === false) {
      throw new Error(`Sub-workflow "${workflowRef}" could not start: ${triggerResult?.error || 'unknown error'}`);
    }
    const runId = triggerResult.runId;
    if (!runId) throw new Error(`Sub-workflow "${workflowRef}" did not return a runId`);

    if (!waitForCompletion) {
      return { triggered: true, runId, waited: false };
    }

    // Poll for completion (max 10 minutes), honouring cancellation.
    const start   = Date.now();
    const TIMEOUT = 10 * 60 * 1000;
    const POLL    = 1000;

    // If the parent is cancelled while we wait, cancel the child run too so it
    // (and its child processes / Claude sessions) don't keep running orphaned.
    const cancelChild = () => {
      try { workflowService.cancel?.(runId); } catch (_) { /* ignore */ }
    };

    while (Date.now() - start < TIMEOUT) {
      if (signal?.aborted) { cancelChild(); throw new Error('Aborted'); }
      await new Promise(r => setTimeout(r, POLL));
      if (signal?.aborted) { cancelChild(); throw new Error('Aborted'); }

      const run = await workflowService.getRun(runId);
      if (!run) break;
      if (run.status === 'success') {
        return { success: true, runId, outputs: run.outputs || {}, waited: true };
      }
      if (run.status === 'failed' || run.status === 'cancelled') {
        throw new Error(`Sub-workflow "${workflowRef}" ${run.status}`);
      }
    }

    cancelChild();
    throw new Error(`Sub-workflow "${workflowRef}" timed out after 10 minutes`);
  },
};
