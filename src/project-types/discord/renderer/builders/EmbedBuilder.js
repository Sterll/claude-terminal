/**
 * Discord Embed Builder
 * Visual form editor with live preview for building Discord embeds
 */

const EmbedRenderer = require('../../../../renderer/ui/discord/EmbedRenderer');
const { generateEmbedCode } = require('./CodeGenerator');

let debounceTimer = null;

/**
 * Render the Embed Builder UI
 * @param {HTMLElement} container - Container element
 * @param {Object} [initialData] - Pre-filled embed data
 * @param {Function} [t] - i18n function
 */
function render(container, initialData = null, t = (k) => k) {
  const data = initialData || {
    title: '',
    description: '',
    color: '#5865F2',
    url: '',
    fields: [],
    footer: { text: '', icon_url: '' },
    thumbnail: { url: '' },
    image: { url: '' },
    author: { name: '', icon_url: '', url: '' },
    timestamp: false
  };

  container.innerHTML = `
    <div class="dc-builder-layout">
      <div class="dc-builder-form">
        <div class="dc-builder-section">
          <label class="dc-builder-label">${t('discord.builderAuthor')}</label>
          <input class="dc-builder-input" data-field="author.name" placeholder="${t('discord.builderAuthorName')}" value="${esc(data.author?.name || '')}">
          <input class="dc-builder-input dc-builder-input-sm" data-field="author.icon_url" placeholder="${t('discord.builderAuthorIcon')}" value="${esc(data.author?.icon_url || '')}">
          <input class="dc-builder-input dc-builder-input-sm" data-field="author.url" placeholder="${t('discord.builderAuthorUrl')}" value="${esc(data.author?.url || '')}">
        </div>

        <div class="dc-builder-section">
          <label class="dc-builder-label">${t('discord.builderTitle')}</label>
          <input class="dc-builder-input" data-field="title" placeholder="${t('discord.builderTitleHint')}" value="${esc(data.title || '')}">
          <input class="dc-builder-input dc-builder-input-sm" data-field="url" placeholder="${t('discord.builderTitleUrl')}" value="${esc(data.url || '')}">
        </div>

        <div class="dc-builder-section">
          <label class="dc-builder-label">${t('discord.builderDescription')}</label>
          <textarea class="dc-builder-textarea" data-field="description" rows="4" placeholder="${t('discord.builderDescHint')}">${esc(data.description || '')}</textarea>
        </div>

        <div class="dc-builder-section dc-builder-row">
          <div>
            <label class="dc-builder-label">${t('discord.builderColor')}</label>
            <input class="dc-builder-color" type="color" data-field="color" value="${data.color || '#5865F2'}">
          </div>
          <div>
            <label class="dc-builder-label">${t('discord.builderTimestamp')}</label>
            <label class="dc-builder-toggle">
              <input type="checkbox" data-field="timestamp" ${data.timestamp ? 'checked' : ''}>
              <span>${t('discord.builderTimestampNow')}</span>
            </label>
          </div>
        </div>

        <div class="dc-builder-section">
          <label class="dc-builder-label">${t('discord.builderFields')} <button class="dc-builder-add-btn" data-action="add-field">+</button></label>
          <div class="dc-builder-fields" data-container="fields"></div>
        </div>

        <div class="dc-builder-section">
          <label class="dc-builder-label">${t('discord.builderImages')}</label>
          <input class="dc-builder-input dc-builder-input-sm" data-field="thumbnail.url" placeholder="${t('discord.builderThumbnail')}" value="${esc(data.thumbnail?.url || '')}">
          <input class="dc-builder-input dc-builder-input-sm" data-field="image.url" placeholder="${t('discord.builderImage')}" value="${esc(data.image?.url || '')}">
        </div>

        <div class="dc-builder-section">
          <label class="dc-builder-label">${t('discord.builderFooter')}</label>
          <input class="dc-builder-input" data-field="footer.text" placeholder="${t('discord.builderFooterText')}" value="${esc(data.footer?.text || '')}">
          <input class="dc-builder-input dc-builder-input-sm" data-field="footer.icon_url" placeholder="${t('discord.builderFooterIcon')}" value="${esc(data.footer?.icon_url || '')}">
        </div>
      </div>

      <div class="dc-builder-preview">
        <div class="dc-builder-preview-header">
          <span>${t('discord.builderPreview')}</span>
          <div class="dc-builder-actions">
            <button class="dc-builder-action-btn" data-action="copy-js" title="Copy JS">&lt;/&gt; JS</button>
            <button class="dc-builder-action-btn" data-action="copy-py" title="Copy Python">🐍 PY</button>
            <button class="dc-builder-action-btn" data-action="copy-json" title="Copy JSON">{} JSON</button>
          </div>
        </div>
        <div class="dc-builder-preview-content" data-preview="embed"></div>
      </div>
    </div>
  `;

  // Render initial fields
  renderFields(container, data.fields || []);

  // Render initial preview
  updatePreview(container, data);

  // Bind events
  bindEvents(container, data, t);
}

function renderFields(container, fields) {
  const fieldsContainer = container.querySelector('[data-container="fields"]');
  if (!fieldsContainer) return;

  fieldsContainer.innerHTML = fields.map((f, i) => `
    <div class="dc-builder-field-item" data-field-index="${i}">
      <div class="dc-builder-field-row">
        <input class="dc-builder-input" data-field-prop="name" placeholder="Field name" value="${esc(f.name || '')}">
        <button class="dc-builder-remove-btn" data-action="remove-field" data-index="${i}">&times;</button>
      </div>
      <textarea class="dc-builder-textarea dc-builder-textarea-sm" data-field-prop="value" placeholder="Field value" rows="2">${esc(f.value || '')}</textarea>
      <label class="dc-builder-toggle">
        <input type="checkbox" data-field-prop="inline" ${f.inline ? 'checked' : ''}>
        <span>Inline</span>
      </label>
    </div>
  `).join('');
}

function collectData(container) {
  const data = {};

  // Simple fields
  container.querySelectorAll('[data-field]').forEach(el => {
    const field = el.dataset.field;
    let value;
    if (el.type === 'checkbox') value = el.checked;
    else if (el.type === 'color') value = el.value;
    else value = el.value;

    setNested(data, field, value);
  });

  // Fields array
  data.fields = [];
  container.querySelectorAll('.dc-builder-field-item').forEach(item => {
    const field = {
      name: item.querySelector('[data-field-prop="name"]')?.value || '',
      value: item.querySelector('[data-field-prop="value"]')?.value || '',
      inline: item.querySelector('[data-field-prop="inline"]')?.checked || false
    };
    data.fields.push(field);
  });

  // Clean empty nested objects
  if (data.author && !data.author.name && !data.author.icon_url && !data.author.url) delete data.author;
  if (data.footer && !data.footer.text && !data.footer.icon_url) delete data.footer;
  if (data.thumbnail && !data.thumbnail.url) delete data.thumbnail;
  if (data.image && !data.image.url) delete data.image;
  if (!data.url) delete data.url;
  if (data.fields.length === 0) delete data.fields;
  if (data.timestamp) data.timestamp = new Date().toISOString();
  else delete data.timestamp;

  return data;
}

function updatePreview(container, data) {
  const previewEl = container.querySelector('[data-preview="embed"]');
  if (!previewEl) return;

  const cleanData = data || collectData(container);
  const html = EmbedRenderer.render(cleanData);
  previewEl.innerHTML = html || '<div style="color:var(--dc-text-muted);padding:20px;text-align:center;">Preview will appear here</div>';
}

function bindEvents(container, data, t) {
  // Input change -> update preview (debounced)
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
    const embedData = collectData(container);

    switch (action) {
      case 'add-field': {
        const fields = [];
        container.querySelectorAll('.dc-builder-field-item').forEach(item => {
          fields.push({
            name: item.querySelector('[data-field-prop="name"]')?.value || '',
            value: item.querySelector('[data-field-prop="value"]')?.value || '',
            inline: item.querySelector('[data-field-prop="inline"]')?.checked || false
          });
        });
        fields.push({ name: '', value: '', inline: false });
        renderFields(container, fields);
        updatePreview(container);
        break;
      }
      case 'remove-field': {
        const idx = parseInt(btn.dataset.index);
        const fields = [];
        container.querySelectorAll('.dc-builder-field-item').forEach((item, i) => {
          if (i === idx) return;
          fields.push({
            name: item.querySelector('[data-field-prop="name"]')?.value || '',
            value: item.querySelector('[data-field-prop="value"]')?.value || '',
            inline: item.querySelector('[data-field-prop="inline"]')?.checked || false
          });
        });
        renderFields(container, fields);
        updatePreview(container);
        break;
      }
      case 'copy-js': {
        const code = generateEmbedCode(embedData, 'js');
        copyToClipboard(code);
        break;
      }
      case 'copy-py': {
        const code = generateEmbedCode(embedData, 'py');
        copyToClipboard(code);
        break;
      }
      case 'copy-json': {
        copyToClipboard(JSON.stringify(embedData, null, 2));
        break;
      }
    }
  });
}

// ========== Helpers ==========

function setNested(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}

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
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

module.exports = { render, collectData };
