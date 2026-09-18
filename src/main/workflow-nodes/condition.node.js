'use strict';

const { esc } = require('./_registry');

const CONDITION_OPS = [
  { value: '==',           group: 'compare', label: '==' },
  { value: '!=',           group: 'compare', label: '!=' },
  { value: '>',            group: 'compare', label: '>' },
  { value: '>=',           group: 'compare', label: '>=' },
  { value: '<',            group: 'compare', label: '<' },
  { value: '<=',           group: 'compare', label: '<=' },
  { value: 'contains',     group: 'text',    label: 'contains' },
  { value: 'starts_with',  group: 'text',    label: 'startsWith' },
  { value: 'ends_with',    group: 'text',    label: 'endsWith' },
  { value: 'matches',      group: 'text',    label: 'matches' },
  { value: 'is_empty',     group: 'unary',   label: 'is empty' },
  { value: 'is_not_empty', group: 'unary',   label: 'not empty' },
];

function buildConditionPreview(variable, op, value, isUnary) {
  if (!variable) return 'variable operator value';
  if (isUnary) return `${variable} ${op}`;
  return `${variable} ${op} "${value || '...'}"`;
}

module.exports = {
  type:     'workflow/condition',
  title:    'Condition',
  desc:     'Conditional branch',
  color:    'success',
  width:    220,
  category: 'flow',
  icon:     'condition',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [
    { name: 'TRUE',  type: 'exec' },
    { name: 'FALSE', type: 'exec' },
  ],

  props: { _condMode: 'builder', variable: '', operator: '==', value: '', expression: '' },

  fields: [
    {
      type: 'custom',
      key:  'condition_ui',
      render(field, props, node) {
        const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const CONDITION_OPS = [
          { value: '==',           group: 'compare', label: '==' },
          { value: '!=',           group: 'compare', label: '!=' },
          { value: '>',            group: 'compare', label: '>' },
          { value: '>=',           group: 'compare', label: '>=' },
          { value: '<',            group: 'compare', label: '<' },
          { value: '<=',           group: 'compare', label: '<=' },
          { value: 'contains',     group: 'text',    label: 'contains' },
          { value: 'starts_with',  group: 'text',    label: 'startsWith' },
          { value: 'ends_with',    group: 'text',    label: 'endsWith' },
          { value: 'matches',      group: 'text',    label: 'matches' },
          { value: 'is_empty',     group: 'unary',   label: 'is empty' },
          { value: 'is_not_empty', group: 'unary',   label: 'not empty' },
        ];
        const p = props || {};
        const condMode  = p._condMode || 'builder';
        const currentOp = p.operator  || '==';
        const isUnary   = currentOp === 'is_empty' || currentOp === 'is_not_empty';
        const compareOps = CONDITION_OPS.filter(o => o.group === 'compare');
        const textOps    = CONDITION_OPS.filter(o => o.group === 'text');
        const unaryOps   = CONDITION_OPS.filter(o => o.group === 'unary');

        function buildPreview(variable, op, value, isUnary) {
          if (!variable) return 'variable operator value';
          if (isUnary) return `${variable} ${op}`;
          return `${variable} ${op} "${value || '...'}"`;
        }

        return `
          <div class="wf-cond-mode-toggle">
            <button class="wf-cond-mode-btn ${condMode === 'builder' ? 'active' : ''}" data-cond-mode="builder">Builder</button>
            <button class="wf-cond-mode-btn ${condMode === 'expression' ? 'active' : ''}" data-cond-mode="expression">Expression</button>
          </div>
          <div class="wf-cond-builder" ${condMode === 'expression' ? 'style="display:none"' : ''}>
            <div class="wf-step-edit-field">
              <label class="wf-step-edit-label">Variable</label>
              <span class="wf-field-hint">$variable or raw value — autocomplete with $</span>
              <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="variable" value="${esc(p.variable || '')}" placeholder="$ctx.branch" />
            </div>
            <div class="wf-step-edit-field">
              <label class="wf-step-edit-label">Operator</label>
              <div class="wf-cond-ops">
                <div class="wf-cond-ops-group">
                  ${compareOps.map(o => `<button class="wf-cond-op-btn ${currentOp === o.value ? 'active' : ''}" data-op="${esc(o.value)}" title="${esc(o.label)}">${esc(o.value)}</button>`).join('')}
                </div>
                <div class="wf-cond-ops-group">
                  ${textOps.map(o => `<button class="wf-cond-op-btn ${currentOp === o.value ? 'active' : ''}" data-op="${esc(o.value)}" title="${esc(o.label)}">${esc(o.label)}</button>`).join('')}
                </div>
                <div class="wf-cond-ops-group">
                  ${unaryOps.map(o => `<button class="wf-cond-op-btn wf-cond-op-unary ${currentOp === o.value ? 'active' : ''}" data-op="${esc(o.value)}" title="${esc(o.label)}">${esc(o.label)}</button>`).join('')}
                </div>
              </div>
            </div>
            <div class="wf-step-edit-field wf-cond-value-field" ${isUnary ? 'style="display:none"' : ''}>
              <label class="wf-step-edit-label">Value</label>
              <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="value" value="${esc(p.value || '')}" placeholder="main" />
            </div>
            <div class="wf-cond-preview">
              <code class="wf-cond-preview-code">${esc(buildPreview(p.variable, currentOp, p.value, isUnary))}</code>
            </div>
          </div>
          <div class="wf-cond-expression" ${condMode === 'builder' ? 'style="display:none"' : ''}>
            <div class="wf-step-edit-field">
              <label class="wf-step-edit-label">Expression</label>
              <span class="wf-field-hint">Free expression — e.g. $node_1.rows.length > 0</span>
              <textarea class="wf-step-edit-input wf-node-prop wf-field-mono wf-cond-expr-input" data-key="expression" rows="2" placeholder="$node_1.exitCode == 0">${esc(p.expression || '')}</textarea>
            </div>
          </div>
        `;
      },
      bind(container, field, node, onChange) {
        // Mode toggle
        container.querySelectorAll('.wf-cond-mode-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const mode = btn.dataset.condMode;
            node.properties._condMode = mode;
            const builder    = container.querySelector('.wf-cond-builder');
            const expression = container.querySelector('.wf-cond-expression');
            container.querySelectorAll('.wf-cond-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.condMode === mode));
            if (builder)    builder.style.display    = mode === 'builder'    ? '' : 'none';
            if (expression) expression.style.display = mode === 'expression' ? '' : 'none';
            onChange(mode);
          });
        });

        // Operator buttons
        container.querySelectorAll('.wf-cond-op-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const op = btn.dataset.op;
            node.properties.operator = op;
            container.querySelectorAll('.wf-cond-op-btn').forEach(b => b.classList.toggle('active', b.dataset.op === op));
            // Show/hide value field
            const isUnary    = op === 'is_empty' || op === 'is_not_empty';
            const valueField = container.querySelector('.wf-cond-value-field');
            if (valueField) valueField.style.display = isUnary ? 'none' : '';
            // Update preview
            const varInput = container.querySelector('[data-key="variable"]');
            const valInput = container.querySelector('[data-key="value"]');
            const preview  = container.querySelector('.wf-cond-preview-code');
            if (preview) {
              const v = varInput?.value || '';
              const val = valInput?.value || '';
              preview.textContent = isUnary ? `${v} ${op}` : `${v} ${op} "${val || '...'}"`;
            }
            onChange(op);
          });
        });

        // Live preview on variable/value input
        const updatePreview = () => {
          const preview  = container.querySelector('.wf-cond-preview-code');
          if (!preview) return;
          const varInput = container.querySelector('[data-key="variable"]');
          const valInput = container.querySelector('[data-key="value"]');
          const op       = node.properties.operator || '==';
          const isUnary  = op === 'is_empty' || op === 'is_not_empty';
          const v        = varInput?.value || '';
          const val      = valInput?.value || '';
          preview.textContent = !v ? 'variable operator value' : isUnary ? `${v} ${op}` : `${v} ${op} "${val || '...'}"`;
        };
        container.querySelector('[data-key="variable"]')?.addEventListener('input', updatePreview);
        container.querySelector('[data-key="value"]')?.addEventListener('input', updatePreview);
      },
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
    roundRect(ctx, n.size[0] - 38, SLOT_H * 0 + 2, 26, 13, 3);
    ctx.fill();
    ctx.fillStyle = '#4ade80'; ctx.textAlign = 'center';
    ctx.fillText('TRUE', n.size[0] - 25, SLOT_H * 0 + 12);
    ctx.fillStyle = 'rgba(239,68,68,.12)';
    roundRect(ctx, n.size[0] - 43, SLOT_H * 1 + 2, 31, 13, 3);
    ctx.fill();
    ctx.fillStyle = '#ef4444'; ctx.textAlign = 'center';
    ctx.fillText('FALSE', n.size[0] - 27, SLOT_H * 1 + 12);
  },

  run(config, vars) {
    const path = require('node:path');
    const fs = require('node:fs');
    const packaged = path.join(__dirname, '../shared/workflow-condition.js');
    return require(fs.existsSync(packaged) ? packaged : '../../shared/workflow-condition').runConditionStep(config, vars);
  },
};
