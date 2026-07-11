/**
 * db-config field renderer
 * Renders the DB node configuration:
 * - Connection select (from _dbConnectionsCache)
 * - Action select (query / schema / tables)
 * - SQL textarea with template buttons (when action === 'query')
 * - Limit + output var row (when action === 'query')
 * - Output hints block
 */
const { escapeHtml, escapeAttr } = require('./_registry');
const { t } = require('../i18n');
const { schemaCache } = require('../services/WorkflowSchemaCache');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SQL_TEMPLATES = {
  select: 'SELECT * FROM table_name\nLIMIT 100',
  insert: 'INSERT INTO table_name (col1, col2)\nVALUES (\'value1\', \'value2\')',
  update: 'UPDATE table_name\nSET col1 = \'value\'\nWHERE id = 1',
  delete: 'DELETE FROM table_name\nWHERE id = 1',
};

function renderOutputHints(action, nodeId) {
  const id = nodeId != null ? nodeId : 'X';
  if (action === 'query') {
    return `<div class="wf-db-output-hint">
  <div class="wf-db-output-title">${t('workflow.db.availableOutputs')}</div>
  <div class="wf-db-output-items">
    <code>$node_${esc(String(id))}.rows</code> <span>${t('workflow.db.outputRows')}</span>
    <code>$node_${esc(String(id))}.columns</code> <span>${t('workflow.db.outputColumns')}</span>
    <code>$node_${esc(String(id))}.rowCount</code> <span>${t('workflow.db.outputRowCount')}</span>
    <code>$node_${esc(String(id))}.duration</code> <span>${t('workflow.db.outputDuration')}</span>
    <code>$node_${esc(String(id))}.firstRow</code> <span>${t('workflow.db.outputFirstRow')}</span>
  </div>
</div>`;
  }
  return `<div class="wf-db-output-hint">
  <div class="wf-db-output-title">${t('workflow.db.availableOutputs')}</div>
  <div class="wf-db-output-items">
    <code>$node_${esc(String(id))}.tables</code> <span>${t('workflow.db.outputTables')}</span>
    <code>$node_${esc(String(id))}.tableCount</code> <span>${t('workflow.db.outputTableCount')}</span>
  </div>
</div>`;
}

module.exports = {
  type: 'db-config',

  render(field, value, node) {
    const props = node.properties || {};
    const dbConns = (typeof window !== 'undefined' && window._dbConnectionsCache) || [];
    const dbAction = props.action || 'query';
    const selectedConn = dbConns.find(c => c.id === props.connection);

    const connOptions = dbConns
      .map(c => `<option value="${esc(c.id)}"${props.connection === c.id ? ' selected' : ''}>${esc(c.name)} (${esc(c.type || 'sql')})</option>`)
      .join('');

    const connHint = !dbConns.length
      ? `<span class="wf-field-hint" style="color:rgba(251,191,36,.6)">${t('workflow.db.noConnection')}</span>`
      : (selectedConn
          ? `<span class="wf-field-hint" style="color:rgba(251,191,36,.5)">${esc(selectedConn.type || 'sql')}${selectedConn.host ? ' — ' + esc(selectedConn.host) : ''}${selectedConn.database ? '/' + esc(selectedConn.database) : ''}</span>`
          : '');

    const querySection = dbAction === 'query' ? `
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.db.sqlQuery')}</label>
  <div class="wf-sql-templates">
    <button class="wf-sql-tpl" data-tpl="select">SELECT</button>
    <button class="wf-sql-tpl" data-tpl="insert">INSERT</button>
    <button class="wf-sql-tpl" data-tpl="update">UPDATE</button>
    <button class="wf-sql-tpl" data-tpl="delete">DELETE</button>
  </div>
  <textarea class="wf-step-edit-input wf-node-prop wf-field-mono wf-sql-textarea" data-key="query"
    rows="5" spellcheck="false"
    placeholder="SELECT * FROM users WHERE active = 1">${esc(props.query || '')}</textarea>
  <span class="wf-field-hint">${t('workflow.db.sqlVariables')}</span>
</div>
<div class="wf-field-row">
  <div class="wf-step-edit-field wf-field-half">
    <label class="wf-step-edit-label">${t('workflow.db.limit')}</label>
    <span class="wf-field-hint">${t('workflow.db.limitHint')}</span>
    <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="limit" type="number"
      min="1" max="10000" value="${esc(String(props.limit != null ? props.limit : 100))}" placeholder="100" />
  </div>
</div>` : '';

    return `<div class="wf-field-group" data-key="connection">
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.db.connection')}</label>
  <span class="wf-field-hint">${t('workflow.db.connectionHint')}</span>
  <select class="wf-step-edit-input wf-node-prop wf-db-conn-select" data-key="connection">
    <option value="">${t('workflow.db.selectConnection')}</option>
    ${connOptions}
  </select>
  ${connHint}
</div>
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.db.action')}</label>
  <span class="wf-field-hint">${t('workflow.db.actionHint')}</span>
  <select class="wf-step-edit-input wf-node-prop wf-db-action-select" data-key="action">
    <option value="query"${dbAction === 'query' ? ' selected' : ''}>${t('workflow.db.actionQuery')}</option>
    <option value="schema"${dbAction === 'schema' ? ' selected' : ''}>${t('workflow.db.actionSchema')}</option>
    <option value="tables"${dbAction === 'tables' ? ' selected' : ''}>${t('workflow.db.actionTables')}</option>
  </select>
</div>
<div class="wf-db-query-section">
${querySection}
</div>
${renderOutputHints(dbAction, node.id)}
</div>`;
  },

  bind(container, field, node, onChange) {
    // Persist a default limit even if the user never touches the field (MAJ-8/9)
    if ((node.properties.action || 'query') === 'query' && node.properties.limit == null) {
      node.properties.limit = 100;
    }

    // Bind all own prop inputs (connection / query / limit). The generic panel
    // binding skips custom-field subtrees, so this field owns its inputs.
    const bindProps = (root) => {
      root.querySelectorAll('.wf-node-prop').forEach(el => {
        const key = el.dataset.key;
        if (!key) return;
        el.setAttribute('data-wf-self-bound', '');
        const evt = (el.tagName === 'TEXTAREA' || el.type === 'text' || el.type === 'number') ? 'input' : 'change';
        el.addEventListener(evt, () => {
          const v = el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
          node.properties[key] = v;
          if (key === 'connection') {
            try { schemaCache.invalidate(v); } catch (_) {}
            onChange(v);
          } else {
            onChange(v);
          }
        });
      });
    };
    bindProps(container);

    // SQL template buttons
    container.querySelectorAll('.wf-sql-tpl').forEach(btn => {
      btn.addEventListener('click', () => {
        const ta = container.querySelector('[data-key="query"]');
        if (ta) {
          const tpl = SQL_TEMPLATES[btn.dataset.tpl] || '';
          ta.value = tpl;
          node.properties.query = tpl;
        }
      });
    });

    // Action select → toggle query section + update output hints
    const actionSel = container.querySelector('.wf-db-action-select');
    if (actionSel) {
      actionSel.addEventListener('change', () => {
        const action = actionSel.value;
        node.properties.action = action;
        onChange(action);

        const qSection = container.querySelector('.wf-db-query-section');
        if (qSection) {
          function e(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
          const props = node.properties || {};
          qSection.innerHTML = action === 'query' ? `
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.db.sqlQuery')}</label>
  <div class="wf-sql-templates">
    <button class="wf-sql-tpl" data-tpl="select">SELECT</button>
    <button class="wf-sql-tpl" data-tpl="insert">INSERT</button>
    <button class="wf-sql-tpl" data-tpl="update">UPDATE</button>
    <button class="wf-sql-tpl" data-tpl="delete">DELETE</button>
  </div>
  <textarea class="wf-step-edit-input wf-node-prop wf-field-mono wf-sql-textarea" data-key="query"
    rows="5" spellcheck="false"
    placeholder="SELECT * FROM users WHERE active = 1">${e(props.query || '')}</textarea>
  <span class="wf-field-hint">${t('workflow.db.sqlVariables')}</span>
</div>
<div class="wf-field-row">
  <div class="wf-step-edit-field wf-field-half">
    <label class="wf-step-edit-label">${t('workflow.db.limit')}</label>
    <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="limit" type="number"
      min="1" max="10000" value="${e(String(props.limit != null ? props.limit : 100))}" placeholder="100" />
  </div>
</div>` : '';

          // Re-bind SQL template buttons
          qSection.querySelectorAll('.wf-sql-tpl').forEach(b => {
            b.addEventListener('click', () => {
              const ta = qSection.querySelector('[data-key="query"]');
              if (ta) {
                const tpl = SQL_TEMPLATES[b.dataset.tpl] || '';
                ta.value = tpl;
                node.properties.query = tpl;
              }
            });
          });
          qSection.querySelectorAll('.wf-node-prop').forEach(el => {
            const key = el.dataset.key;
            if (!key) return;
            el.setAttribute('data-wf-self-bound', '');
            const evt = el.tagName === 'TEXTAREA' || el.type === 'text' || el.type === 'number' ? 'input' : 'change';
            el.addEventListener(evt, () => { node.properties[key] = el.type === 'number' ? Number(el.value) : el.value; });
          });
        }

        // Update output hints
        const hintsEl = container.querySelector('.wf-db-output-hint');
        if (hintsEl) {
          hintsEl.outerHTML = renderOutputHints(action, node.id);
        }
      });
    }
  },
};
