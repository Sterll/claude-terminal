'use strict';

const { esc } = require('./_registry');

const VAR_COLORS = {
  string:  '#c8c8c8',
  number:  '#60a5fa',
  boolean: '#4ade80',
  array:   '#fb923c',
  object:  '#a78bfa',
  any:     '#6b7280',
};

module.exports = {
  type:     'workflow/variable',
  title:    'Set Variable',
  desc:     'Read/write a variable',
  color:    'purple',
  width:    200,
  category: 'data',
  icon:     'variable',

  inputs:  [{ name: 'In', type: 'exec' }, { name: 'value', type: 'any' }],
  outputs: [{ name: 'Done', type: 'exec' }, { name: 'value', type: 'any' }],

  props: { action: 'set', name: '', varType: 'any', value: '' },

  fields: [
    {
      type: 'custom',
      key:  'variable_ui',
      render(field, props, node) {
        const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const VAR_COLORS = {
          string:  '#c8c8c8',
          number:  '#60a5fa',
          boolean: '#4ade80',
          array:   '#fb923c',
          object:  '#a78bfa',
          any:     '#6b7280',
        };
        const VAR_TYPE_OPTIONS = ['string', 'number', 'boolean', 'array', 'object', 'any'];
        const p       = props || {};
        const varType = p.varType || 'any';

        // Collect variable names from other nodes in this workflow
        // graphService/_nodes is not available here, so we skip browser rendering at static time
        // The bind() will populate the browser dynamically
        const action = p.action || 'set';
        const showValue = action !== 'get';

        const incrementHint = action === 'increment' ? 'Increment (number)' : 'Value to assign';
        const valuePlaceholder = action === 'increment' ? '1' : 'production';

        return `
          <div class="wf-var-browser" id="wf-var-browser" style="display:none">
            <div class="wf-var-browser-title">Workflow variables</div>
            <div class="wf-var-browser-list" id="wf-var-browser-list"></div>
          </div>
          <div class="wf-step-edit-field">
            <label class="wf-step-edit-label">Action</label>
            <select class="wf-step-edit-input wf-node-prop" data-key="action">
              <option value="set"       ${action === 'set'       ? 'selected' : ''}>Set value</option>
              <option value="get"       ${action === 'get'       ? 'selected' : ''}>Read value</option>
              <option value="increment" ${action === 'increment' ? 'selected' : ''}>Increment (+n)</option>
              <option value="append"    ${action === 'append'    ? 'selected' : ''}>Append to list</option>
            </select>
          </div>
          <div class="wf-step-edit-field">
            <label class="wf-step-edit-label">Name</label>
            <span class="wf-field-hint">Unique variable identifier</span>
            <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="name" value="${esc(p.name || '')}" placeholder="buildCount" />
          </div>
          <div class="wf-step-edit-field">
            <label class="wf-step-edit-label">Type</label>
            <span class="wf-field-hint">Variable type (for data-pin compatibility)</span>
            <select class="wf-step-edit-input wf-node-prop" data-key="varType">
              ${VAR_TYPE_OPTIONS.map(t => `<option value="${t}" ${varType === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
          </div>
          <div class="wf-step-edit-field wf-var-value-field" ${showValue ? '' : 'style="display:none"'}>
            <label class="wf-step-edit-label">Value</label>
            <span class="wf-field-hint wf-var-value-hint">${esc(incrementHint)}</span>
            <input class="wf-step-edit-input wf-node-prop ${action === 'increment' ? 'wf-field-mono' : ''}" data-key="value" value="${esc(p.value || '')}" placeholder="${esc(valuePlaceholder)}" ${action === 'increment' ? 'type="number"' : ''} />
          </div>
        `;
      },
      bind(container, field, node, onChange) {
        const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const VAR_COLORS = {
          string:  '#c8c8c8',
          number:  '#60a5fa',
          boolean: '#4ade80',
          array:   '#fb923c',
          object:  '#a78bfa',
          any:     '#6b7280',
        };

        // Populate the variable browser from sibling variable nodes in DOM context
        // We attempt to get node list from the graph service if available via window
        const tryPopulateBrowser = () => {
          const browserEl  = container.querySelector('#wf-var-browser');
          const browserList = container.querySelector('#wf-var-browser-list');
          if (!browserEl || !browserList) return;

          // Try to find graphService via global
          const graphService = window._workflowGraphService;
          if (!graphService || !graphService._nodes) {
            browserEl.style.display = 'none';
            return;
          }

          const allVarNodes = (graphService._nodes || []).filter(n =>
            (n.type === 'workflow/variable' || n.type === 'workflow/get_variable') && n.id !== node.id
          );
          const varNames = [...new Set(allVarNodes.map(n => n.properties.name).filter(Boolean))];

          if (!varNames.length) {
            browserEl.style.display = 'none';
            return;
          }

          browserEl.style.display = '';
          browserList.innerHTML = varNames.map(v => {
            const vNode  = allVarNodes.find(n => n.properties.name === v);
            const vType  = vNode?.properties.varType || 'any';
            const color  = VAR_COLORS[vType] || '#6b7280';
            return `<button class="wf-var-browser-item" data-varname="${esc(v)}" title="Click to use"><code style="color:${color}">$${esc(v)}</code><span class="wf-var-browser-type" style="color:${color}">${esc(vType)}</span></button>`;
          }).join('');

          // Click on variable in browser → fill name input
          browserList.querySelectorAll('.wf-var-browser-item').forEach(btn => {
            btn.addEventListener('click', () => {
              const nameInput = container.querySelector('[data-key="name"]');
              if (nameInput) {
                nameInput.value = btn.dataset.varname;
                node.properties.name = btn.dataset.varname;
                nameInput.dispatchEvent(new Event('input'));
              }
            });
          });
        };

        tryPopulateBrowser();

        // Action select change → show/hide value field
        const actionSelect = container.querySelector('[data-key="action"]');
        if (actionSelect) {
          actionSelect.addEventListener('change', () => {
            const action     = actionSelect.value;
            const valueField = container.querySelector('.wf-var-value-field');
            const hintEl     = container.querySelector('.wf-var-value-hint');
            const valueInput = container.querySelector('[data-key="value"]');

            if (valueField) valueField.style.display = action !== 'get' ? '' : 'none';
            if (hintEl) hintEl.textContent = action === 'increment' ? 'Increment (number)' : 'Value to assign';
            if (valueInput) {
              valueInput.type        = action === 'increment' ? 'number' : 'text';
              valueInput.placeholder = action === 'increment' ? '1' : 'production';
            }
          });
        }
      },
    },
  ],

  badge: (n) => (n.properties.action || 'set').toUpperCase(),
  getTitle: (n) => {
    const a  = n.properties.action || 'set';
    const nm = n.properties.name;
    if (a === 'get')       return nm ? `Get ${nm}`    : 'Get Variable';
    if (a === 'set')       return nm ? `Set ${nm}`    : 'Set Variable';
    if (a === 'increment') return nm ? `++ ${nm}`     : 'Increment';
    if (a === 'append')    return nm ? `Append ${nm}` : 'Append';
    return 'Variable';
  },
  drawExtra: (ctx, n) => {
    const MONO = '"Cascadia Code","Fira Code",monospace';
    if (n.properties.name) {
      ctx.fillStyle = '#555';
      ctx.font = `10px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.fillText('$' + n.properties.name, 10, n.size[1] - 6);
    }
  },

  dynamic: 'variable',

  rebuildOutputs(engine, node) {
    const action = node.properties.action || 'set';

    // Clear all existing links
    for (const inp of node.inputs) {
      if (inp.link != null && engine._removeLink) engine._removeLink(inp.link);
    }
    for (const out of node.outputs) {
      for (const lid of [...(out.links || [])]) {
        if (engine._removeLink) engine._removeLink(lid);
      }
    }

    if (action === 'get') {
      // Pure node: no exec pins, just data output
      node.inputs  = [];
      node.outputs = [{ name: 'value', type: 'any', links: [] }];
    } else if (action === 'set' || action === 'append') {
      // Exec + data input for the value + data output
      node.inputs  = [
        { name: 'In',    type: 'exec', link: null },
        { name: 'value', type: 'any',  link: null },
      ];
      node.outputs = [
        { name: 'Done',  type: 'exec', links: [] },
        { name: 'value', type: 'any',  links: [] },
      ];
    } else {
      // increment: exec only, no data input needed
      node.inputs  = [{ name: 'In', type: 'exec', link: null }];
      node.outputs = [
        { name: 'Done',  type: 'exec', links: [] },
        { name: 'value', type: 'any',  links: [] },
      ];
    }
  },

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

    const action = config.action || 'set';
    const name   = config.name   || '';
    if (!name) throw new Error('Variable node: no name specified');

    const currentValue = vars instanceof Map ? vars.get(name) : vars?.[name];

    switch (action) {
      case 'set': {
        const raw   = config.value != null ? config.value : '';
        const value = resolveVars(raw, vars);
        if (vars instanceof Map) vars.set(name, value);
        return { name, value, action: 'set' };
      }
      case 'get': {
        return { name, value: currentValue ?? null, action: 'get' };
      }
      case 'increment': {
        const increment = parseFloat(config.value) || 1;
        const newValue  = (parseFloat(currentValue) || 0) + increment;
        if (vars instanceof Map) vars.set(name, newValue);
        return { name, value: newValue, action: 'increment' };
      }
      case 'append': {
        const rawA  = config.value != null ? config.value : '';
        const value = resolveVars(rawA, vars);
        const arr   = Array.isArray(currentValue) ? currentValue : (currentValue ? [currentValue] : []);
        arr.push(value);
        if (vars instanceof Map) vars.set(name, arr);
        return { name, value: arr, action: 'append' };
      }
      default:
        throw new Error(`Variable node: unknown action "${action}"`);
    }
  },
};
