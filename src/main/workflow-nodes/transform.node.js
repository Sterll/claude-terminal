'use strict';

const vm = require('vm');
const { esc, resolveVars } = require('./_registry');

// Compile an expression body inside a restricted vm sandbox and return a
// callable. The expression is treated as CODE with a fixed set of parameter
// names; the caller supplies the actual data (item/index/acc) as sandbox
// values. Variables are resolved as DATA before compilation and are NEVER
// interpolated into the code body, so `$foo` values cannot inject executable
// code. Each invocation runs with a 1000 ms timeout in a context that exposes
// no require/process/global/console.
const EXPR_TIMEOUT_MS = 1000;

function compileExpr(body, paramNames) {
  const argList = paramNames.join(', ');
  const src = `(function(${argList}){ "use strict"; return (${body}); }).apply(undefined, __args__)`;
  let script;
  try {
    script = new vm.Script(src, { filename: 'transform-expr.js' });
  } catch {
    throw new Error(`Invalid expression: ${body}`);
  }
  return (...args) => {
    // Fresh, minimal context per call — no prototype chain to global.
    const sandbox = Object.create(null);
    sandbox.__args__ = args;
    const ctx = vm.createContext(sandbox);
    try {
      return script.runInContext(ctx, { timeout: EXPR_TIMEOUT_MS });
    } catch (e) {
      if (/Script execution timed out/i.test(String(e && e.message))) {
        throw new Error(`Expression timed out (>${EXPR_TIMEOUT_MS}ms): ${body}`);
      }
      throw new Error(`Expression error: ${e.message}`);
    }
  };
}

const TRANSFORM_OPS = [
  { value: 'map',           label: 'Map',           desc: 'Transform each item',            tpl: 'item.fieldName' },
  { value: 'filter',        label: 'Filter',        desc: 'Keep matching items',            tpl: 'item.status === "active"' },
  { value: 'reduce',        label: 'Reduce',        desc: 'Aggregate into one value',       tpl: 'acc + item.value' },
  { value: 'find',          label: 'Find',          desc: 'Find the first matching item',   tpl: 'item.id === $targetId' },
  { value: 'pluck',         label: 'Pluck',         desc: 'Extract one field',              tpl: 'name' },
  { value: 'count',         label: 'Count',         desc: 'Count items',                    tpl: '' },
  { value: 'sort',          label: 'Sort',          desc: 'Sort items',                     tpl: 'name' },
  { value: 'unique',        label: 'Unique',        desc: 'Remove duplicates',              tpl: '' },
  { value: 'flatten',       label: 'Flatten',       desc: 'Flatten nested arrays',          tpl: '' },
  { value: 'json_parse',    label: 'JSON Parse',    desc: 'Convert string → object',        tpl: '' },
  { value: 'json_stringify', label: 'JSON Stringify', desc: 'Convert object → string',      tpl: '' },
];

module.exports = {
  type:     'workflow/transform',
  title:    'Transform',
  desc:     'Transform data',
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

  props: { operation: 'map', input: '', expression: '', outputVar: '', initialValue: '' },

  fields: [
    {
      type: 'custom',
      key:  'transform_ui',
      render(field, props, node) {
        const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const TRANSFORM_OPS = [
          { value: 'map',           label: 'Map',           desc: 'Transform each item',            tpl: 'item.fieldName' },
          { value: 'filter',        label: 'Filter',        desc: 'Keep matching items',            tpl: 'item.status === "active"' },
          { value: 'reduce',        label: 'Reduce',        desc: 'Aggregate into one value',       tpl: 'acc + item.value' },
          { value: 'find',          label: 'Find',          desc: 'Find the first matching item',   tpl: 'item.id === $targetId' },
          { value: 'pluck',         label: 'Pluck',         desc: 'Extract one field',              tpl: 'name' },
          { value: 'count',         label: 'Count',         desc: 'Count items',                    tpl: '' },
          { value: 'sort',          label: 'Sort',          desc: 'Sort items',                     tpl: 'name' },
          { value: 'unique',        label: 'Unique',        desc: 'Remove duplicates',              tpl: '' },
          { value: 'flatten',       label: 'Flatten',       desc: 'Flatten nested arrays',          tpl: '' },
          { value: 'json_parse',    label: 'JSON Parse',    desc: 'Convert string → object',        tpl: '' },
          { value: 'json_stringify', label: 'JSON Stringify', desc: 'Convert object → string',      tpl: '' },
        ];
        const p          = props || {};
        const currentOp  = p.operation || 'map';
        const opInfo     = TRANSFORM_OPS.find(o => o.value === currentOp) || TRANSFORM_OPS[0];
        const needsExpr  = !['count', 'unique', 'flatten', 'json_parse', 'json_stringify'].includes(currentOp);

        const exprHint = currentOp === 'pluck' || currentOp === 'sort'
          ? 'Field name'
          : currentOp === 'reduce'
            ? 'acc = accumulator, item = current item'
            : 'item = current item';

        return `
          <div class="wf-step-edit-field">
            <label class="wf-step-edit-label">Operation</label>
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
            <span class="wf-field-hint">Data source — variable or node output</span>
            <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="input" value="${esc(p.input || '')}" placeholder="$node_1.rows" />
          </div>
          <div class="wf-step-edit-field wf-transform-expr-field" ${needsExpr ? '' : 'style="display:none"'}>
            <label class="wf-step-edit-label">Expression</label>
            <span class="wf-field-hint wf-transform-expr-hint">${esc(exprHint)}</span>
            <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="expression" value="${esc(p.expression || '')}" placeholder="${esc(opInfo.tpl)}" />
          </div>
          <div class="wf-step-edit-field wf-transform-initial-field" ${currentOp === 'reduce' ? '' : 'style="display:none"'}>
            <label class="wf-step-edit-label">Initial value</label>
            <span class="wf-field-hint">Accumulator seed (JSON — e.g. 0, "", [] or {}). Empty = first item.</span>
            <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="initialValue" value="${esc(p.initialValue || '')}" placeholder="0" />
          </div>
          <div class="wf-step-edit-field">
            <label class="wf-step-edit-label">Output variable</label>
            <span class="wf-field-hint">Store result in a variable (optional)</span>
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
          pluck: 'Field name',
          sort:  'Field name',
          reduce: 'acc = accumulator, item = current item',
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

        // Operation buttons
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
            if (exprHintEl) exprHintEl.textContent    = EXPR_HINTS[op] || 'item = current item';
            if (exprInput)  exprInput.placeholder     = OP_TPLS[op]   || '';

            const initialField = container.querySelector('.wf-transform-initial-field');
            if (initialField) initialField.style.display = op === 'reduce' ? '' : 'none';

            updatePreview();
            onChange(op);
          });
        });

        // Live preview on expression/input/outputVar changes
        ['expression', 'input', 'outputVar', 'initialValue'].forEach(key => {
          container.querySelector(`[data-key="${key}"]`)?.addEventListener('input', updatePreview);
        });
      },
    },
  ],

  badge: (n) => (n.properties.operation || 'map').toUpperCase(),

  run(config, vars) {
    const operation = config.operation || 'map';
    const inputRaw  = config.input ? resolveVars(config.input, vars) : null;
    // Resolve the expression's variables as DATA. The result is used purely as a
    // string body compiled inside a vm sandbox — it is never eval'd inline.
    const expr      = config.expression ? String(resolveVars(config.expression, vars) ?? '') : '';

    if (operation === 'json_parse') {
      try {
        const parsed = JSON.parse(typeof inputRaw === 'string' ? inputRaw : JSON.stringify(inputRaw));
        return { result: parsed, count: Array.isArray(parsed) ? parsed.length : 1, success: true };
      } catch (e) {
        throw new Error(`json_parse failed: ${e.message}`);
      }
    }

    if (operation === 'json_stringify') {
      // JSON.stringify(undefined) === undefined → normalise to '' to avoid an
      // undefined/null result flowing downstream. An empty input (no source)
      // also yields '' rather than the literal "null".
      const str = inputRaw == null ? '' : JSON.stringify(inputRaw, null, 2);
      return { result: str ?? '', success: true };
    }

    const input = Array.isArray(inputRaw) ? inputRaw : (inputRaw != null ? [inputRaw] : []);

    // Cache compiled expressions so we compile once per operation, not per item.
    let _cachedMap = null;
    const mapFn = () => (_cachedMap ||= compileExpr(expr, ['item', 'index']));

    let result;
    switch (operation) {
      case 'map':
        result = input.map((item, index) => expr ? mapFn()(item, index) : item);
        break;
      case 'filter':
        result = input.filter((item, index) => expr ? mapFn()(item, index) : true);
        break;
      case 'find':
        result = expr ? input.find((item, index) => mapFn()(item, index)) : input[0];
        break;
      case 'reduce': {
        const reduceFn = expr
          ? compileExpr(expr, ['acc', 'item', 'index'])
          : (acc, item) => acc + item;
        // Configurable initial accumulator. Empty → reduce without a seed
        // (uses the first item, matching Array.prototype.reduce semantics).
        const hasInitial = config.initialValue != null && String(config.initialValue).trim() !== '';
        if (hasInitial) {
          const seedRaw = resolveVars(String(config.initialValue), vars);
          let seed = seedRaw;
          if (typeof seedRaw === 'string') {
            try { seed = JSON.parse(seedRaw); } catch { seed = seedRaw; }
          }
          result = input.reduce((acc, item, index) => reduceFn(acc, item, index), seed);
        } else {
          result = input.reduce((acc, item, index) => reduceFn(acc, item, index));
        }
        break;
      }
      case 'pluck':
        result = input.map(item => {
          if (!expr) return item;
          return expr.split('.').reduce((o, k) => (o != null ? o[k] : undefined), item);
        });
        break;
      case 'count':
        result = expr ? input.filter((item, index) => mapFn()(item, index)).length : input.length;
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
