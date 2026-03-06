'use strict';

const { esc } = require('./_registry');

const TRANSFORM_OPS = [
  { value: 'map',           label: 'Map',           desc: 'Transformer chaque élément',       tpl: 'item.fieldName' },
  { value: 'filter',        label: 'Filter',         desc: 'Garder les éléments qui matchent', tpl: 'item.status === "active"' },
  { value: 'reduce',        label: 'Reduce',         desc: 'Agréger en une seule valeur',      tpl: 'acc + item.value' },
  { value: 'find',          label: 'Find',           desc: 'Trouver le premier élément',       tpl: 'item.id === $targetId' },
  { value: 'pluck',         label: 'Pluck',          desc: 'Extraire un seul champ',           tpl: 'name' },
  { value: 'count',         label: 'Count',          desc: 'Compter les éléments',             tpl: '' },
  { value: 'sort',          label: 'Sort',           desc: 'Trier les éléments',               tpl: 'name' },
  { value: 'unique',        label: 'Unique',         desc: 'Supprimer les doublons',           tpl: '' },
  { value: 'flatten',       label: 'Flatten',        desc: 'Aplatir les tableaux imbriqués',   tpl: '' },
  { value: 'json_parse',    label: 'JSON Parse',     desc: 'Convertir string → objet',         tpl: '' },
  { value: 'json_stringify', label: 'JSON Stringify', desc: 'Convertir objet → string',        tpl: '' },
];

module.exports = {
  type:     'workflow/transform',
  title:    'Transform',
  desc:     'Transformer des données',
  color:    'teal',
  width:    230,
  category: 'data',
  icon:     'transform',

  inputs:  [{ name: 'In', type: 'exec' }, { name: 'input', type: 'any' }],
  outputs: [
    { name: 'Done',   type: 'exec'   },
    { name: 'Error',  type: 'exec'   },
    { name: 'result', type: 'any'    },
    { name: 'count',  type: 'number' },
  ],

  props: { operation: 'map', input: '', expression: '', outputVar: '' },

  fields: [
    {
      type: 'custom',
      key:  'transform_ui',
      render(field, props, node) {
        const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const TRANSFORM_OPS = [
          { value: 'map',           label: 'Map',           desc: 'Transformer chaque élément',       tpl: 'item.fieldName' },
          { value: 'filter',        label: 'Filter',         desc: 'Garder les éléments qui matchent', tpl: 'item.status === "active"' },
          { value: 'reduce',        label: 'Reduce',         desc: 'Agréger en une seule valeur',      tpl: 'acc + item.value' },
          { value: 'find',          label: 'Find',           desc: 'Trouver le premier élément',       tpl: 'item.id === $targetId' },
          { value: 'pluck',         label: 'Pluck',          desc: 'Extraire un seul champ',           tpl: 'name' },
          { value: 'count',         label: 'Count',          desc: 'Compter les éléments',             tpl: '' },
          { value: 'sort',          label: 'Sort',           desc: 'Trier les éléments',               tpl: 'name' },
          { value: 'unique',        label: 'Unique',         desc: 'Supprimer les doublons',           tpl: '' },
          { value: 'flatten',       label: 'Flatten',        desc: 'Aplatir les tableaux imbriqués',   tpl: '' },
          { value: 'json_parse',    label: 'JSON Parse',     desc: 'Convertir string → objet',         tpl: '' },
          { value: 'json_stringify', label: 'JSON Stringify', desc: 'Convertir objet → string',        tpl: '' },
        ];
        const p          = props || {};
        const currentOp  = p.operation || 'map';
        const opInfo     = TRANSFORM_OPS.find(o => o.value === currentOp) || TRANSFORM_OPS[0];
        const needsExpr  = !['count', 'unique', 'flatten', 'json_parse', 'json_stringify'].includes(currentOp);

        const exprHint = currentOp === 'pluck' || currentOp === 'sort'
          ? 'Nom du champ'
          : currentOp === 'reduce'
            ? 'acc = accumulateur, item = élément'
            : 'item = élément courant';

        return `
          <div class="wf-step-edit-field">
            <label class="wf-step-edit-label">Opération</label>
            <div class="wf-transform-ops">
              ${TRANSFORM_OPS.map(o => `
                <button class="wf-transform-op-btn ${currentOp === o.value ? 'active' : ''}" data-op="${esc(o.value)}" title="${esc(o.desc)}">
                  <span class="wf-transform-op-name">${esc(o.label)}</span>
                  <span class="wf-transform-op-desc">${esc(o.desc)}</span>
                </button>
              `).join('')}
            </div>
          </div>
          <div class="wf-step-edit-field">
            <label class="wf-step-edit-label">Input</label>
            <span class="wf-field-hint">Source des données — variable ou node output</span>
            <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="input" value="${esc(p.input || '')}" placeholder="$node_1.rows" />
          </div>
          <div class="wf-step-edit-field wf-transform-expr-field" ${needsExpr ? '' : 'style="display:none"'}>
            <label class="wf-step-edit-label">Expression</label>
            <span class="wf-field-hint wf-transform-expr-hint">${esc(exprHint)}</span>
            <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="expression" value="${esc(p.expression || '')}" placeholder="${esc(opInfo.tpl)}" />
          </div>
          <div class="wf-step-edit-field">
            <label class="wf-step-edit-label">Variable de sortie</label>
            <span class="wf-field-hint">Stocker le résultat dans une variable (optionnel)</span>
            <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="outputVar" value="${esc(p.outputVar || '')}" placeholder="transformedData" />
          </div>
          <div class="wf-transform-preview">
            <code class="wf-transform-preview-code">${esc(currentOp)}(${esc(p.input || 'input')}${needsExpr && p.expression ? ', ' + esc(p.expression) : ''})${p.outputVar ? ' → $' + esc(p.outputVar) : ''}</code>
          </div>
        `;
      },
      bind(container, field, node, onChange) {
        const NO_EXPR_OPS = new Set(['count', 'unique', 'flatten', 'json_parse', 'json_stringify']);
        const EXPR_HINTS = {
          pluck: 'Nom du champ',
          sort:  'Nom du champ',
          reduce: 'acc = accumulateur, item = élément',
        };
        const OP_TPLS = {
          map:    'item.fieldName',
          filter: 'item.status === "active"',
          reduce: 'acc + item.value',
          find:   'item.id === $targetId',
          pluck:  'name',
          sort:   'name',
        };

        function updatePreview() {
          const preview = container.querySelector('.wf-transform-preview-code');
          if (!preview) return;
          const op        = node.properties.operation || 'map';
          const input     = node.properties.input || 'input';
          const expr      = node.properties.expression || '';
          const outputVar = node.properties.outputVar || '';
          const needsExpr = !NO_EXPR_OPS.has(op);
          preview.textContent = `${op}(${input}${needsExpr && expr ? ', ' + expr : ''})${outputVar ? ' → $' + outputVar : ''}`;
        }

        container.querySelectorAll('.wf-transform-op-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const op = btn.dataset.op;
            node.properties.operation = op;
            container.querySelectorAll('.wf-transform-op-btn').forEach(b => b.classList.toggle('active', b.dataset.op === op));

            const needsExpr   = !NO_EXPR_OPS.has(op);
            const exprField   = container.querySelector('.wf-transform-expr-field');
            const exprHintEl  = container.querySelector('.wf-transform-expr-hint');
            const exprInput   = container.querySelector('[data-key="expression"]');

            if (exprField)  exprField.style.display  = needsExpr ? '' : 'none';
            if (exprHintEl) exprHintEl.textContent    = EXPR_HINTS[op] || 'item = élément courant';
            if (exprInput)  exprInput.placeholder     = OP_TPLS[op]   || '';

            updatePreview();
            onChange(op);
          });
        });

        ['expression', 'input', 'outputVar'].forEach(key => {
          container.querySelector(`[data-key="${key}"]`)?.addEventListener('input', updatePreview);
        });
      },
    },
  ],

  badge: (n) => (n.properties.operation || 'map').toUpperCase(),

  run(config, vars) {
    const resolveVars = (value, vars) => {
      if (typeof value !== 'string') return value;
      const singleMatch = value.match(/^\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)$/);
      if (singleMatch) {
        const parts = singleMatch[1].split('.');
        let cur = vars instanceof Map ? vars.get(parts[0]) : vars[parts[0]];
        for (let i = 1; i < parts.length && cur != null; i++) cur = cur[parts[i]];
        if (cur != null) return typeof cur === 'string' ? cur.replace(/[\r\n]+$/, '') : cur;
      }
      return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
        const parts = key.split('.');
        let cur = vars instanceof Map ? vars.get(parts[0]) : vars[parts[0]];
        for (let i = 1; i < parts.length && cur != null; i++) cur = cur[parts[i]];
        return cur != null ? String(cur).replace(/[\r\n]+$/, '') : match;
      });
    };

    const operation = config.operation || 'map';
    const inputRaw  = config.input ? resolveVars(config.input, vars) : null;
    const expr      = config.expression ? resolveVars(config.expression, vars) : '';

    if (operation === 'json_parse') {
      try {
        const parsed = JSON.parse(typeof inputRaw === 'string' ? inputRaw : JSON.stringify(inputRaw));
        return { result: parsed, count: Array.isArray(parsed) ? parsed.length : 1, success: true };
      } catch (e) {
        throw new Error(`json_parse failed: ${e.message}`);
      }
    }

    if (operation === 'json_stringify') {
      return { result: JSON.stringify(inputRaw, null, 2), success: true };
    }

    const input = Array.isArray(inputRaw) ? inputRaw : (inputRaw != null ? [inputRaw] : []);

    const makeFn = (body) => {
      try {
        return new Function('item', 'index', `"use strict"; return (${body});`);
      } catch {
        throw new Error(`Invalid expression: ${body}`);
      }
    };

    let result;
    switch (operation) {
      case 'map':
        result = input.map((item, index) => expr ? makeFn(expr)(item, index) : item);
        break;
      case 'filter':
        result = input.filter((item, index) => expr ? makeFn(expr)(item, index) : true);
        break;
      case 'find':
        result = expr ? input.find((item, index) => makeFn(expr)(item, index)) : input[0];
        break;
      case 'reduce': {
        const reduceFn = expr ? new Function('acc', 'item', 'index', `"use strict"; return (${expr});`) : (acc, item) => acc + item;
        result = input.reduce(reduceFn, 0);
        break;
      }
      case 'pluck':
        result = input.map(item => {
          if (!expr) return item;
          return expr.split('.').reduce((o, k) => (o != null ? o[k] : undefined), item);
        });
        break;
      case 'count':
        result = expr ? input.filter((item, index) => makeFn(expr)(item, index)).length : input.length;
        break;
      case 'sort':
        result = [...input].sort((a, b) => {
          if (!expr) return 0;
          const va = expr.split('.').reduce((o, k) => (o != null ? o[k] : undefined), a);
          const vb = expr.split('.').reduce((o, k) => (o != null ? o[k] : undefined), b);
          return va < vb ? -1 : va > vb ? 1 : 0;
        });
        break;
      case 'unique':
        if (expr) {
          const seen = new Set();
          result = input.filter(item => {
            const key = expr.split('.').reduce((o, k) => (o != null ? o[k] : undefined), item);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        } else {
          result = [...new Set(input)];
        }
        break;
      case 'flatten':
        result = input.flat(expr ? parseInt(expr, 10) || 1 : 1);
        break;
      default:
        throw new Error(`Unknown transform operation: ${operation}`);
    }

    return {
      result,
      count: Array.isArray(result) ? result.length : 1,
      success: true,
    };
  },
};