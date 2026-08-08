'use strict';

const { parseDuration } = require('./_registry');

module.exports = {
  type:     'workflow/wait',
  title:    'Wait',
  desc:     'Temporisation',
  color:    'muted',
  width:    200,
  category: 'flow',
  icon:     'wait',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [{ name: 'Done', type: 'exec' }],

  props: { mode: 'duration', duration: '5s', timeout: '' },

  fields: [
    { type: 'select', key: 'mode',     label: 'wfn.wait.mode.label',     options: ['duration', 'approval'] },
    { type: 'text',   key: 'duration', label: 'wfn.wait.duration.label', placeholder: '5s', showIf: (p) => !p.mode || p.mode === 'duration' },
    { type: 'text',   key: 'timeout',  label: 'wfn.wait.timeout.label',  placeholder: '60s', showIf: (p) => p.mode === 'approval' },
  ],

  badge: (n) => n.properties.mode === 'approval' ? 'APPROVAL' : (n.properties.duration || '5s').toUpperCase(),

  async run(config, vars, signal, ctx) {
    // Shared with WorkflowRunner (retry delays, step and workflow timeouts),
    // which kept its own copy. See _registry.parseDuration for the two silent
    // failures both copies carried.
    const parseMs = (value) => parseDuration(value, 'wait.node');

    const sleep = (ms, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Cancelled'));
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Cancelled')); }, { once: true });
    });

    // Branch on mode FIRST — the duration prop has a default ('5s') so a plain
    // `if (duration)` would short-circuit approval mode.
    const mode = config.mode || 'duration';

    if (mode !== 'approval') {
      const ms = parseMs(config.duration || '5s');
      await sleep(ms, signal);
      return { waited: ms, timedOut: false };
    }

    // Approval mode: wait for human callback or timeout
    return new Promise((resolve, reject) => {
      const runId  = ctx?.runId  || 'unknown';
      const stepId = ctx?.stepId || `step_${Date.now()}`;
      const key    = `${runId}::${stepId}`;
      const timeoutMs = config.timeout ? parseMs(config.timeout) : null;

      const done = (result) => {
        if (ctx?.waitCallbacks) ctx.waitCallbacks.delete(key);
        clearTimeout(timer);
        resolve(result);
      };

      if (ctx?.waitCallbacks) ctx.waitCallbacks.set(key, done);

      const timer = timeoutMs
        ? setTimeout(() => done({ timedOut: true, approved: false }), timeoutMs)
        : null;

      const onAbort = () => {
        if (ctx?.waitCallbacks) ctx.waitCallbacks.delete(key);
        clearTimeout(timer);
        reject(new Error('Cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
};
