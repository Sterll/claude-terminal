'use strict';

/**
 * error_handler node (try/catch subgraph)
 *
 * Routes downstream exec to a TRY branch and catches any unhandled error
 * from nodes inside that branch, exposing it via `$nodeId.error` and
 * dispatching the CATCH branch.
 *
 * Execution semantics are implemented in WorkflowRunner._executeGraph and
 * WorkflowRunner._executeSubGraph — this module only declares the node shape
 * so LiteGraph can render it and the runner can identify it by `stepType`.
 */
module.exports = {
  type:     'workflow/error_handler',
  title:    'Error handler',
  desc:     'Try / catch subgraph — runs CATCH if the TRY branch fails',
  color:    'danger',
  width:    230,
  category: 'flow',
  icon:     'error',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [
    { name: 'TRY',   type: 'exec' },
    { name: 'CATCH', type: 'exec' },
    { name: 'error', type: 'string' },
    { name: 'caught', type: 'boolean' },
  ],

  props: {},

  fields: [
    {
      type: 'custom',
      key: 'error_handler_hint',
      render() {
        return `
          <div class="wf-step-edit-field">
            <div class="wf-field-hint" style="line-height:1.5">
              Connect nodes to the <b>TRY</b> branch. If any of them throws an
              error that isn't caught by its own error pin, the <b>CATCH</b>
              branch runs with <code>$node_X.error</code> and
              <code>$node_X.caught</code> set.
            </div>
          </div>
        `;
      },
      bind() {},
    },
  ],

  drawExtra: (ctx, n) => {
    const FONT   = '"Inter","Segoe UI",sans-serif';
    const SLOT_H = 24;
    const roundRect = (ctx, x, y, w, h, r) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    };
    ctx.font = `700 8px ${FONT}`;
    ctx.fillStyle = 'rgba(74,222,128,.12)';
    roundRect(ctx, n.size[0] - 34, SLOT_H * 0 + 2, 22, 13, 3);
    ctx.fill();
    ctx.fillStyle = '#4ade80'; ctx.textAlign = 'center';
    ctx.fillText('TRY', n.size[0] - 23, SLOT_H * 0 + 12);
    ctx.fillStyle = 'rgba(239,68,68,.12)';
    roundRect(ctx, n.size[0] - 45, SLOT_H * 1 + 2, 33, 13, 3);
    ctx.fill();
    ctx.fillStyle = '#ef4444'; ctx.textAlign = 'center';
    ctx.fillText('CATCH', n.size[0] - 28, SLOT_H * 1 + 12);
  },

  // The runner handles error_handler nodes via special branching — this run()
  // is a no-op placeholder so generic code paths (e.g. test harness) don't fail.
  async run() {
    return { caught: false, error: null };
  },
};
