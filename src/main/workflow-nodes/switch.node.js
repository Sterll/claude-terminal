'use strict';

const { esc } = require('./_registry');

module.exports = {
  type:     'workflow/switch',
  title:    'Switch',
  desc:     'Brancher sur plusieurs valeurs',
  color:    'pink',
  width:    220,
  category: 'flow',
  icon:     'switch',

  inputs:  [{ name: 'In', type: 'exec' }],
  // Outputs rebuilt dynamically via rebuildOutputs()
  outputs: [{ name: 'default', type: 'exec' }],

  props: { variable: '', cases: 'case1,case2,case3' },

  fields: [
    {
      type: 'custom',
      key:  'switch_ui',
      render(field, props, node) {
        const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const p     = props || {};
        const cases = (p.cases || '').split(',').map(c => c.trim()).filter(Boolean);

        return `
          <div class="wf-step-edit-field">
            <label class="wf-step-edit-label">Variable à tester</label>
            <span class="wf-field-hint">Variable dont la valeur détermine la branche</span>
            <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="variable" value="${esc(p.variable || '')}" placeholder="$ctx.branch" />
          </div>
          <div class="wf-step-edit-field">
            <label class="wf-step-edit-label">Cases</label>
            <span class="wf-field-hint">Chaque case crée un port de sortie. Le port "default" est automatique.</span>
            <div class="wf-switch-cases" id="wf-switch-case-list">
              ${cases.map((c, i) => `
                <div class="wf-switch-case-row" data-idx="${i}">
                  <span class="wf-switch-case-idx">${i + 1}</span>
                  <input class="wf-switch-case-input wf-field-mono" value="${esc(c)}" placeholder="valeur" />
                  <button class="wf-switch-case-del" title="Supprimer ce case"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
                </div>
              `).join('')}
            </div>
            <button class="wf-switch-case-add" id="wf-switch-add-case">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
              Ajouter un case
            </button>
          </div>
          <div class="wf-switch-preview">
            <div class="wf-switch-preview-title">Ports de sortie</div>
            <div class="wf-switch-preview-ports" id="wf-switch-preview-ports">
              ${cases.map(c => `<span class="wf-switch-preview-port">${esc(c)}</span>`).join('')}
              <span class="wf-switch-preview-port wf-switch-preview-port--default">default</span>
            </div>
          </div>
        `;
      },
      bind(container, field, node, onChange) {
        const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        function getCases() {
          const inputs = container.querySelectorAll('.wf-switch-case-input');
          return Array.from(inputs).map(i => i.value.trim()).filter(Boolean);
        }

        function updateCasesProperty() {
          const cases = getCases();
          node.properties.cases = cases.join(',');
          // Update preview ports
          const portsEl = container.querySelector('#wf-switch-preview-ports');
          if (portsEl) {
            portsEl.innerHTML = cases.map(c => `<span class="wf-switch-preview-port">${esc(c)}</span>`).join('') +
              '<span class="wf-switch-preview-port wf-switch-preview-port--default">default</span>';
          }
          // Rebuild node outputs via rebuildOutputs if available
          if (typeof node.rebuildOutputs === 'function') {
            // Will be called by the workflow engine
          }
          onChange(node.properties.cases);
        }

        function rebuildRows() {
          const cases = getCases();
          const listEl = container.querySelector('#wf-switch-case-list');
          if (!listEl) return;
          listEl.innerHTML = cases.map((c, i) => `
            <div class="wf-switch-case-row" data-idx="${i}">
              <span class="wf-switch-case-idx">${i + 1}</span>
              <input class="wf-switch-case-input wf-field-mono" value="${esc(c)}" placeholder="valeur" />
              <button class="wf-switch-case-del" title="Supprimer ce case"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
            </div>
          `).join('');
          bindRows();
        }

        function bindRows() {
          // Case input changes
          container.querySelectorAll('.wf-switch-case-input').forEach(input => {
            input.addEventListener('input', updateCasesProperty);
          });
          // Delete buttons
          container.querySelectorAll('.wf-switch-case-del').forEach(btn => {
            btn.addEventListener('click', () => {
              const row = btn.closest('.wf-switch-case-row');
              if (row) row.remove();
              updateCasesProperty();
              // Re-number
              const listEl = container.querySelector('#wf-switch-case-list');
              if (listEl) {
                listEl.querySelectorAll('.wf-switch-case-row').forEach((r, i) => {
                  const idx = r.querySelector('.wf-switch-case-idx');
                  if (idx) idx.textContent = i + 1;
                  r.dataset.idx = i;
                });
              }
            });
          });
        }

        // Add case button
        const addBtn = container.querySelector('#wf-switch-add-case');
        if (addBtn) {
          addBtn.addEventListener('click', () => {
            const listEl = container.querySelector('#wf-switch-case-list');
            if (!listEl) return;
            const count = listEl.querySelectorAll('.wf-switch-case-row').length;
            const row = document.createElement('div');
            row.className = 'wf-switch-case-row';
            row.dataset.idx = count;
            row.innerHTML = `
              <span class="wf-switch-case-idx">${count + 1}</span>
              <input class="wf-switch-case-input wf-field-mono" value="" placeholder="valeur" />
              <button class="wf-switch-case-del" title="Supprimer ce case"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
            `;
            listEl.appendChild(row);
            bindRows();
            row.querySelector('.wf-switch-case-input')?.focus();
          });
        }

        bindRows();
      },
    },
  ],

  badge: (n) => (n.properties.variable || '$var').slice(0, 14),

  dynamic: 'switch',

  rebuildOutputs(engine, node) {
    // Clear existing links from outputs
    for (const out of node.outputs) {
      for (const lid of [...(out.links || [])]) {
        if (engine._removeLink) engine._removeLink(lid);
      }
    }
    node.outputs = [];
    const cases = (node.properties.cases || '').split(',').map(c => c.trim()).filter(Boolean);
    for (const c of cases) node.outputs.push({ name: c, type: 'exec', links: [] });
    node.outputs.push({ name: 'default', type: 'exec', links: [] });
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

    const value  = resolveVars(config.variable || '', vars);
    const cases  = (config.cases || '').split(',').map(c => c.trim()).filter(Boolean);
    const idx    = cases.findIndex(c => String(value) === String(c));
    // idx = matched case slot, cases.length = default slot
    const matchedSlot = idx >= 0 ? idx : cases.length;
    return { value, matchedCase: idx >= 0 ? cases[idx] : 'default', matchedSlot, success: true };
  },
};
