/**
 * loop-config field renderer
 * Renders the Loop node configuration:
 * - Source select (auto / projects / files / custom)
 * - Filter/items input (conditional)
 * - Mode tabs (sequential / parallel)
 * - Max iterations input
 * - Item schema display (if available)
 * - Usage hint block
 */
const { escapeHtml, escapeAttr } = require('./_registry');
const { t } = require('../i18n');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderFilterField(source, filter) {
  if (source === 'files') {
    return `<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.loop.globLabel')}</label>
  <span class="wf-field-hint">${t('workflow.loop.globHint')}</span>
  <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="filter"
    value="${esc(filter || '')}" placeholder="src/**/*.test.js" />
</div>`;
  }
  if (source === 'custom') {
    return `<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.loop.itemsLabel')}</label>
  <span class="wf-field-hint">${t('workflow.loop.itemsHint')}</span>
  <textarea class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="filter"
    rows="4" placeholder="api-service\nweb-app\nworker">${esc(filter || '')}</textarea>
</div>`;
  }
  return '';
}

function renderSchema(itemSchema) {
  if (itemSchema && itemSchema.length > 0) {
    return `<div class="wf-loop-schema">
  <div class="wf-loop-schema-title">${t('workflow.loop.schemaTitle')}</div>
  <div class="wf-loop-schema-keys">
    ${itemSchema.map(key => `<div class="wf-loop-schema-key"><code>$item.${esc(key)}</code></div>`).join('')}
  </div>
  <div class="wf-loop-schema-hint">${t('workflow.loop.schemaHint')}</div>
</div>`;
  }
  return `<div class="wf-loop-schema wf-loop-schema--empty">
  <div class="wf-loop-schema-title">${t('workflow.loop.schemaTitle')}</div>
  <div class="wf-loop-schema-hint">${t('workflow.loop.schemaEmpty')}</div>
</div>`;
}

function renderUsageHint(itemSchema) {
  const schemaKeys = (itemSchema && itemSchema.length > 0)
    ? itemSchema.map(key => `<code>$item.${esc(key)}</code> <span>${esc(key)}</span>`).join('')
    : '';
  return `<div class="wf-loop-usage-hint">
  <div class="wf-loop-usage-title">${t('workflow.loop.usageTitle')}</div>
  <div class="wf-loop-usage-items">
    <code>$item</code> <span>${t('workflow.loop.itemDesc')}</span>
    ${schemaKeys}
    <code>$loop.index</code> <span>${t('workflow.loop.indexDesc')}</span>
    <code>$loop.total</code> <span>${t('workflow.loop.totalDesc')}</span>
  </div>
  <div class="wf-loop-usage-tip">${t('workflow.loop.usageTip')}</div>
</div>`;
}

module.exports = {
  type: 'loop-config',

  render(field, value, node) {
    const props = node.properties || {};
    const source = props.source || 'auto';
    const mode = props.mode || 'sequential';
    const itemSchema = props._itemSchema || node._outputSchema || [];

    return `<div class="wf-field-group" data-key="source">
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.loop.sourceLabel')}</label>
  <span class="wf-field-hint">${t('workflow.loop.sourceHint')}</span>
  <select class="wf-step-edit-input wf-node-prop wf-loop-source-select" data-key="source">
    <option value="auto"${(!source || source === 'auto' || source === 'previous_output') ? ' selected' : ''}>${t('workflow.loop.sourceAuto')}</option>
    <option value="projects"${source === 'projects' ? ' selected' : ''}>${t('workflow.loop.sourceProjects')}</option>
    <option value="files"${source === 'files' ? ' selected' : ''}>${t('workflow.loop.sourceFiles')}</option>
    <option value="custom"${source === 'custom' ? ' selected' : ''}>${t('workflow.loop.sourceCustom')}</option>
  </select>
</div>
<div class="wf-loop-filter-section">
${renderFilterField(source, props.filter)}
</div>
<div class="wf-loop-options">
  <div class="wf-loop-opt">
    <span class="wf-loop-opt-label">${t('workflow.loop.modeLabel')}</span>
    <div class="wf-loop-mode-tabs">
      <button class="wf-loop-mode-tab${mode === 'sequential' ? ' active' : ''}" data-mode="sequential" title="${t('workflow.loop.modeSeqTitle')}">${t('workflow.loop.modeSeq')}</button>
      <button class="wf-loop-mode-tab${mode === 'parallel' ? ' active' : ''}" data-mode="parallel" title="${t('workflow.loop.modeParTitle')}">${t('workflow.loop.modePar')}</button>
    </div>
  </div>
  <div class="wf-loop-opt">
    <span class="wf-loop-opt-label">${t('workflow.loop.limitLabel')}</span>
    <input class="wf-step-edit-input wf-node-prop wf-field-mono wf-loop-max-input" data-key="maxIterations"
      type="number" min="1" max="10000"
      value="${esc(String(props.maxIterations || ''))}" placeholder="∞" />
  </div>
</div>
${renderSchema(itemSchema)}
${renderUsageHint(itemSchema)}
</div>`;
  },

  bind(container, field, node, onChange) {
    // Source select → toggle filter section
    const sourceSel = container.querySelector('.wf-loop-source-select');
    if (sourceSel) {
      sourceSel.addEventListener('change', () => {
        const src = sourceSel.value;
        node.properties.source = src;
        onChange(src);

        const filterSection = container.querySelector('.wf-loop-filter-section');
        if (filterSection) {
          filterSection.innerHTML = renderFilterField(src, node.properties.filter || '');
          const filterEl = filterSection.querySelector('.wf-node-prop');
          if (filterEl) {
            filterEl.addEventListener('input', () => { node.properties.filter = filterEl.value; });
            filterEl.addEventListener('change', () => { node.properties.filter = filterEl.value; });
          }
        }
      });
    }

    // Filter field binding (initial)
    const filterEl = container.querySelector('.wf-loop-filter-section .wf-node-prop');
    if (filterEl) {
      filterEl.addEventListener('input', () => { node.properties.filter = filterEl.value; });
      filterEl.addEventListener('change', () => { node.properties.filter = filterEl.value; });
    }

    // Mode tabs
    container.querySelectorAll('.wf-loop-mode-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        container.querySelectorAll('.wf-loop-mode-tab').forEach(tb => tb.classList.remove('active'));
        tab.classList.add('active');
        node.properties.mode = tab.dataset.mode;
      });
    });

    // Max iterations
    const maxEl = container.querySelector('.wf-loop-max-input');
    if (maxEl) {
      maxEl.addEventListener('input', () => { node.properties.maxIterations = maxEl.value ? parseInt(maxEl.value, 10) : ''; });
    }
  },
};
