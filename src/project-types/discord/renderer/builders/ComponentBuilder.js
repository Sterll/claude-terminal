/**
 * Discord Component Builder
 * Visual builder for buttons, select menus, and action rows with live preview
 */

const ComponentRenderer = require('../../../../renderer/ui/discord/ComponentRenderer');
const { generateComponentCode } = require('./CodeGenerator');

let debounceTimer = null;

const STYLES = [
  { value: 1, label: 'Primary', color: '#5865F2' },
  { value: 2, label: 'Secondary', color: '#4E5058' },
  { value: 3, label: 'Success', color: '#248046' },
  { value: 4, label: 'Danger', color: '#ED4245' },
  { value: 5, label: 'Link', color: '#4E5058' }
];

/**
 * Render the Component Builder UI
 * @param {HTMLElement} container - Container element
 * @param {Object[]} [initialData] - Pre-filled action rows
 * @param {Function} [t] - i18n function
 */
function render(container, initialData = null, t = (k) => k) {
  const rows = initialData || [
    { type: 1, components: [{ type: 2, style: 1, label: 'Click me', custom_id: 'btn_1' }] }
  ];

  container.innerHTML = `
    <div class="dc-builder-layout">
      <div class="dc-builder-form">
        <div class="dc-builder-section">
          <label class="dc-builder-label">
            ${t('discord.builderActionRows')}
            <button class="dc-builder-add-btn" data-action="add-row" title="${t('discord.builderAddRow')}">+ Row</button>
          </label>
          <div class="dc-comp-builder-rows" data-container="rows"></div>
        </div>
      </div>

      <div class="dc-builder-preview">
        <div class="dc-builder-preview-header">
          <span>${t('discord.builderPreview')}</span>
          <div class="dc-builder-actions">
            <button class="dc-builder-action-btn" data-action="copy-js">&lt;/&gt; JS</button>
            <button class="dc-builder-action-btn" data-action="copy-py">🐍 PY</button>
            <button class="dc-builder-action-btn" data-action="copy-json">{} JSON</button>
          </div>
        </div>
        <div class="dc-builder-preview-content" data-preview="components"></div>
      </div>
    </div>
  `;

  renderRows(container, rows);
  updatePreview(container, rows);
  bindEvents(container, t);
}

function renderRows(container, rows) {
  const rowsContainer = container.querySelector('[data-container="rows"]');
  if (!rowsContainer) return;

  rowsContainer.innerHTML = rows.map((row, ri) => {
    const comps = (row.components || []).map((comp, ci) => {
      if (comp.type === 2) return renderButtonEditor(ri, ci, comp);
      if (comp.type === 3) return renderSelectEditor(ri, ci, comp);
      return '';
    }).join('');

    return `
      <div class="dc-comp-row" data-row="${ri}">
        <div class="dc-comp-row-header">
          <span>Row ${ri + 1}</span>
          <div class="dc-comp-row-actions">
            <button class="dc-builder-add-btn" data-action="add-button" data-row="${ri}" title="Add Button">+ Button</button>
            <button class="dc-builder-add-btn" data-action="add-select" data-row="${ri}" title="Add Select">+ Select</button>
            <button class="dc-builder-remove-btn" data-action="remove-row" data-row="${ri}">&times;</button>
          </div>
        </div>
        <div class="dc-comp-row-items">${comps}</div>
      </div>
    `;
  }).join('');
}

function renderButtonEditor(rowIdx, compIdx, btn) {
  const styleOptions = STYLES.map(s =>
    `<option value="${s.value}" ${btn.style === s.value ? 'selected' : ''}>${s.label}</option>`
  ).join('');

  return `
    <div class="dc-comp-item" data-row="${rowIdx}" data-comp="${compIdx}" data-type="2">
      <div class="dc-comp-item-header">
        <span style="color:${STYLES.find(s => s.value === btn.style)?.color || '#4E5058'}">Button</span>
        <button class="dc-builder-remove-btn" data-action="remove-comp" data-row="${rowIdx}" data-comp="${compIdx}">&times;</button>
      </div>
      <input class="dc-builder-input" data-prop="label" placeholder="Label" value="${esc(btn.label || '')}">
      <select class="dc-builder-select" data-prop="style">${styleOptions}</select>
      <input class="dc-builder-input dc-builder-input-sm" data-prop="custom_id" placeholder="custom_id" value="${esc(btn.custom_id || '')}">
      <input class="dc-builder-input dc-builder-input-sm" data-prop="url" placeholder="URL (link style only)" value="${esc(btn.url || '')}">
      <input class="dc-builder-input dc-builder-input-sm" data-prop="emoji" placeholder="Emoji" value="${esc(typeof btn.emoji === 'string' ? btn.emoji : btn.emoji?.name || '')}">
      <label class="dc-builder-toggle">
        <input type="checkbox" data-prop="disabled" ${btn.disabled ? 'checked' : ''}>
        <span>Disabled</span>
      </label>
    </div>
  `;
}

function renderSelectEditor(rowIdx, compIdx, sel) {
  const optionsHtml = (sel.options || []).map((o, oi) => `
    <div class="dc-comp-option" data-option="${oi}">
      <input class="dc-builder-input" data-opt-prop="label" placeholder="Label" value="${esc(o.label || '')}">
      <input class="dc-builder-input dc-builder-input-sm" data-opt-prop="value" placeholder="Value" value="${esc(o.value || '')}">
      <input class="dc-builder-input dc-builder-input-sm" data-opt-prop="description" placeholder="Description" value="${esc(o.description || '')}">
      <button class="dc-builder-remove-btn" data-action="remove-option" data-row="${rowIdx}" data-comp="${compIdx}" data-option="${oi}">&times;</button>
    </div>
  `).join('');

  return `
    <div class="dc-comp-item dc-comp-item-select" data-row="${rowIdx}" data-comp="${compIdx}" data-type="3">
      <div class="dc-comp-item-header">
        <span>Select Menu</span>
        <button class="dc-builder-remove-btn" data-action="remove-comp" data-row="${rowIdx}" data-comp="${compIdx}">&times;</button>
      </div>
      <input class="dc-builder-input" data-prop="custom_id" placeholder="custom_id" value="${esc(sel.custom_id || '')}">
      <input class="dc-builder-input" data-prop="placeholder" placeholder="Placeholder text" value="${esc(sel.placeholder || '')}">
      <div class="dc-comp-options">
        <label class="dc-builder-label">Options <button class="dc-builder-add-btn" data-action="add-option" data-row="${rowIdx}" data-comp="${compIdx}">+</button></label>
        ${optionsHtml}
      </div>
    </div>
  `;
}

function collectData(container) {
  const rows = [];
  container.querySelectorAll('.dc-comp-row').forEach(rowEl => {
    const row = { type: 1, components: [] };
    rowEl.querySelectorAll('.dc-comp-item').forEach(itemEl => {
      const type = parseInt(itemEl.dataset.type);

      if (type === 2) {
        // Button
        const comp = { type: 2 };
        comp.label = itemEl.querySelector('[data-prop="label"]')?.value || '';
        comp.style = parseInt(itemEl.querySelector('[data-prop="style"]')?.value) || 2;
        comp.custom_id = itemEl.querySelector('[data-prop="custom_id"]')?.value || '';
        comp.url = itemEl.querySelector('[data-prop="url"]')?.value || '';
        comp.emoji = itemEl.querySelector('[data-prop="emoji"]')?.value || '';
        comp.disabled = itemEl.querySelector('[data-prop="disabled"]')?.checked || false;
        if (!comp.url) delete comp.url;
        if (!comp.emoji) delete comp.emoji;
        if (!comp.disabled) delete comp.disabled;
        row.components.push(comp);
      } else if (type === 3) {
        // Select
        const comp = { type: 3 };
        comp.custom_id = itemEl.querySelector('[data-prop="custom_id"]')?.value || 'select';
        comp.placeholder = itemEl.querySelector('[data-prop="placeholder"]')?.value || '';
        comp.options = [];
        itemEl.querySelectorAll('.dc-comp-option').forEach(optEl => {
          comp.options.push({
            label: optEl.querySelector('[data-opt-prop="label"]')?.value || 'Option',
            value: optEl.querySelector('[data-opt-prop="value"]')?.value || '',
            description: optEl.querySelector('[data-opt-prop="description"]')?.value || ''
          });
        });
        if (!comp.placeholder) delete comp.placeholder;
        row.components.push(comp);
      }
    });
    if (row.components.length > 0) rows.push(row);
  });
  return rows;
}

function updatePreview(container, rows) {
  const previewEl = container.querySelector('[data-preview="components"]');
  if (!previewEl) return;

  const data = rows || collectData(container);
  const html = ComponentRenderer.render(data);
  previewEl.innerHTML = html || '<div style="color:var(--dc-text-muted);padding:20px;text-align:center;">Preview will appear here</div>';
}

function bindEvents(container, t) {
  // Input/change -> debounced preview update
  container.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => updatePreview(container), 150);
  });

  container.addEventListener('change', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => updatePreview(container), 150);
  });

  // Click actions
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const data = collectData(container);

    switch (action) {
      case 'add-row': {
        data.push({ type: 1, components: [{ type: 2, style: 2, label: 'Button', custom_id: `btn_${Date.now()}` }] });
        renderRows(container, data);
        updatePreview(container, data);
        break;
      }
      case 'remove-row': {
        const ri = parseInt(btn.dataset.row);
        data.splice(ri, 1);
        renderRows(container, data);
        updatePreview(container, data);
        break;
      }
      case 'add-button': {
        const ri = parseInt(btn.dataset.row);
        if (data[ri] && data[ri].components.length < 5) {
          data[ri].components.push({ type: 2, style: 2, label: 'Button', custom_id: `btn_${Date.now()}` });
          renderRows(container, data);
          updatePreview(container, data);
        }
        break;
      }
      case 'add-select': {
        const ri = parseInt(btn.dataset.row);
        if (data[ri] && data[ri].components.length === 0) {
          data[ri].components.push({ type: 3, custom_id: `select_${Date.now()}`, placeholder: 'Choose...', options: [{ label: 'Option 1', value: 'opt1' }] });
          renderRows(container, data);
          updatePreview(container, data);
        }
        break;
      }
      case 'remove-comp': {
        const ri = parseInt(btn.dataset.row);
        const ci = parseInt(btn.dataset.comp);
        if (data[ri]) {
          data[ri].components.splice(ci, 1);
          renderRows(container, data);
          updatePreview(container, data);
        }
        break;
      }
      case 'add-option': {
        const ri = parseInt(btn.dataset.row);
        const ci = parseInt(btn.dataset.comp);
        if (data[ri] && data[ri].components[ci]) {
          if (!data[ri].components[ci].options) data[ri].components[ci].options = [];
          data[ri].components[ci].options.push({ label: `Option ${data[ri].components[ci].options.length + 1}`, value: '' });
          renderRows(container, data);
          updatePreview(container, data);
        }
        break;
      }
      case 'remove-option': {
        const ri = parseInt(btn.dataset.row);
        const ci = parseInt(btn.dataset.comp);
        const oi = parseInt(btn.dataset.option);
        if (data[ri] && data[ri].components[ci] && data[ri].components[ci].options) {
          data[ri].components[ci].options.splice(oi, 1);
          renderRows(container, data);
          updatePreview(container, data);
        }
        break;
      }
      case 'copy-js': {
        copyToClipboard(generateComponentCode(data, 'js'));
        break;
      }
      case 'copy-py': {
        copyToClipboard(generateComponentCode(data, 'py'));
        break;
      }
      case 'copy-json': {
        copyToClipboard(JSON.stringify(data, null, 2));
        break;
      }
    }
  });
}

// ========== Helpers ==========

function esc(s) {
  return (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function copyToClipboard(text) {
  try {
    if (window.electron_api?.app?.clipboardWrite) {
      await window.electron_api.app.clipboardWrite(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

module.exports = { render, collectData };
