'use strict';

const { esc } = require('./_registry');

module.exports = {
  type:     'workflow/get_variable',
  title:    'Get Variable',
  desc:     'Lire une variable (pure)',
  color:    'purple',
  width:    150,
  category: 'data',
  icon:     'variable',

  inputs:  [],
  outputs: [{ name: 'value', type: 'any' }],

  props: { name: '', varType: 'any' },

  fields: [
    {
      type: 'custom',
      key:  'get_variable_ui',
      render(field, props, node) {
        const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const VAR_TYPE_OPTIONS = ['string', 'number', 'boolean', 'array', 'object', 'any'];
        const VAR_COLORS = {
          string:  '#c8c8c8',
          number:  '#60a5fa',
          boolean: '#4ade80',
          array:   '#fb923c',
          object:  '#a78bfa',
          any:     '#6b7280',
        };
        const p       = props || {};
        const varType = p.varType || 'any';

        return `
          <div class="wf-step-edit-field">
            <label class="wf-step-edit-label">Variable</label>
            <span class="wf-field-hint">Nom de la variable à lire</span>
            <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="name" value="${esc(p.name || '')}" placeholder="buildCount" />
          </div>
          <div class="wf-step-edit-field">
            <label class="wf-step-edit-label">Type du pin</label>
            <span class="wf-field-hint">Détermine la couleur et la compatibilité du pin de sortie</span>
            <div class="wf-var-type-picker" id="wf-getvar-type-picker">
              ${VAR_TYPE_OPTIONS.map(t => {
                const color = VAR_COLORS[t] || '#6b7280';
                return `<button class="wf-var-type-btn ${varType === t ? 'active' : ''}" data-type="${t}" style="--btn-color:${color}">${esc(t)}</button>`;
              }).join('')}
            </div>
          </div>
        `;
      },
      bind(container, field, node, onChange) {
        container.querySelectorAll('.wf-var-type-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const t = btn.dataset.type;
            node.properties.varType = t;
            container.querySelectorAll('.wf-var-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === t));
            // Update pin type on the node if the method exists
            if (typeof node._updatePinType === 'function') {
              node._updatePinType();
            }
            onChange(t);
          });
        });
      },
    },
  ],

  getTitle: (n) => n.properties.name || 'Get Variable',

  drawExtra: (ctx, n) => {
    const PIN_COLORS = {
      any:     '#888',
      string:  '#60a5fa',
      number:  '#34d399',
      boolean: '#a78bfa',
      array:   '#f59e0b',
      object:  '#fb923c',
    };
    const t  = n.properties.varType || 'any';
    const pc = PIN_COLORS[t] || PIN_COLORS.any;
    ctx.fillStyle   = pc;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(0, 0, 3, n.size[1]);
    ctx.globalAlpha = 1;
  },

  // No run() — this is a pure data node resolved by the graph engine from vars
};
