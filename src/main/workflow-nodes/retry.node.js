'use strict';

/**
 * retry node
 *
 * Runs its downstream TRY branch as a subgraph. If any node inside throws,
 * it waits (with optional exponential backoff) and retries up to `maxAttempts`
 * total tries. If all attempts fail, FAIL branch runs with the last error.
 *
 * Execution branching is implemented in WorkflowRunner — this module only
 * declares the node shape.
 */
module.exports = {
  type:     'workflow/retry',
  title:    'Retry',
  desc:     'Retry a subgraph N times with backoff',
  color:    'warning',
  width:    230,
  category: 'flow',
  icon:     'refresh',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [
    { name: 'TRY',      type: 'exec'    },
    { name: 'FAIL',     type: 'exec'    },
    { name: 'attempts', type: 'number'  },
    { name: 'error',    type: 'string'  },
  ],

  props: {
    maxAttempts: 3,
    delayMs: 1000,
    backoff: 'linear',
  },

  fields: [
    { type: 'number', key: 'maxAttempts', label: 'wfn.retry.attempts.label',
      default: 3, min: 1, max: 20,
      hint: 'wfn.retry.attempts.hint' },
    { type: 'number', key: 'delayMs', label: 'wfn.retry.delay.label',
      default: 1000, min: 0,
      hint: 'wfn.retry.delay.hint' },
    { type: 'select', key: 'backoff', label: 'wfn.retry.backoff.label',
      default: 'linear',
      options: [
        { value: 'none',        label: 'wfn.retry.backoff.none' },
        { value: 'linear',      label: 'wfn.retry.backoff.linear' },
        { value: 'exponential', label: 'wfn.retry.backoff.exponential' },
      ],
      hint: 'wfn.retry.backoff.hint' },
  ],

  badge: (n) => `×${n.properties.maxAttempts || 3}`,
  badgeColor: () => '#f59e0b',

  // Placeholder — WorkflowRunner handles retry semantics via subgraph branching
  async run(config) {
    return { attempts: 0, error: null, maxAttempts: Number(config.maxAttempts) || 3 };
  },
};
