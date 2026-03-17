/**
 * Discord Component Renderer
 * Renders buttons, select menus, action rows, modals, and Components V2
 */

const { escapeHtml, escapeAttr } = require('./EmbedRenderer');

const BUTTON_STYLES = {
  1: 'primary',
  2: 'secondary',
  3: 'success',
  4: 'danger',
  5: 'link',
  primary: 'primary',
  secondary: 'secondary',
  success: 'success',
  danger: 'danger',
  link: 'link'
};

const LINK_ICON_SVG = '<svg class="dc-btn-link-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2A2.5 2.5 0 0 0 2 4.5v7A2.5 2.5 0 0 0 4.5 14h7a2.5 2.5 0 0 0 2.5-2.5v-3a.5.5 0 0 1 1 0v3a3.5 3.5 0 0 1-3.5 3.5h-7A3.5 3.5 0 0 1 1 11.5v-7A3.5 3.5 0 0 1 4.5 1h3a.5.5 0 0 1 0 1h-3zM9 .5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0V1.707L8.354 7.354a.5.5 0 1 1-.708-.708L13.293 1H9.5A.5.5 0 0 1 9 .5z"/></svg>';

/**
 * Render a single button
 */
function renderButton(button) {
  const style = BUTTON_STYLES[button.style] || 'secondary';
  const disabled = button.disabled ? ' disabled' : '';
  const emoji = button.emoji ? `<span class="dc-btn-emoji">${renderEmoji(button.emoji)}</span>` : '';
  const label = button.label ? escapeHtml(button.label) : '';

  if (style === 'link' && button.url) {
    return `<a class="dc-btn dc-btn-link" href="${escapeAttr(button.url)}" target="_blank" rel="noopener"${disabled}>${emoji}${label}${LINK_ICON_SVG}</a>`;
  }

  return `<button class="dc-btn dc-btn-${style}" data-custom-id="${escapeAttr(button.custom_id || '')}"${disabled}>${emoji}${label}</button>`;
}

/**
 * Render emoji (custom or unicode)
 */
function renderEmoji(emoji) {
  if (!emoji) return '';
  if (typeof emoji === 'string') return emoji;
  if (emoji.id) {
    const ext = emoji.animated ? 'gif' : 'png';
    return `<img src="https://cdn.discordapp.com/emojis/${emoji.id}.${ext}" alt="${emoji.name || ''}" width="16" height="16" style="vertical-align: middle;">`;
  }
  return emoji.name || '';
}

/**
 * Render a select menu
 */
function renderSelectMenu(select) {
  const placeholder = escapeHtml(select.placeholder || 'Make a selection');
  const disabled = select.disabled ? ' disabled' : '';

  let html = `<div class="dc-select${disabled ? ' disabled' : ''}" data-custom-id="${escapeAttr(select.custom_id || '')}">`;
  html += `<div class="dc-select-trigger">${placeholder}`;
  html += '<svg class="dc-select-arrow" viewBox="0 0 24 24"><path fill="currentColor" d="M7 10l5 5 5-5H7z"/></svg>';
  html += '</div>';

  if (select.options && select.options.length > 0) {
    html += '<div class="dc-select-dropdown">';
    for (const option of select.options) {
      const emoji = option.emoji ? `<span class="dc-btn-emoji">${renderEmoji(option.emoji)}</span>` : '';
      const desc = option.description ? `<div class="dc-select-option-desc">${escapeHtml(option.description)}</div>` : '';
      html += `<div class="dc-select-option" data-value="${escapeAttr(option.value || '')}">${emoji}<div><div>${escapeHtml(option.label || '')}</div>${desc}</div></div>`;
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

/**
 * Render an action row (container for buttons or a single select)
 */
function renderActionRow(row) {
  if (!row || !row.components) return '';

  let html = '<div class="dc-action-row">';
  for (const component of row.components) {
    html += renderComponent(component);
  }
  html += '</div>';
  return html;
}

/**
 * Render a single component by type
 */
function renderComponent(component) {
  if (!component) return '';

  switch (component.type) {
    case 1: // Action Row
      return renderActionRow(component);
    case 2: // Button
      return renderButton(component);
    case 3: // String Select Menu
    case 5: // User Select
    case 6: // Role Select
    case 7: // Mentionable Select
    case 8: // Channel Select
      return renderSelectMenu(component);
    case 4: // Text Input (in modals)
      return renderTextInput(component);
    // Components V2
    case 9: // Section
      return renderSection(component);
    case 10: // Text Display
      return renderTextDisplay(component);
    case 11: // Thumbnail
      return renderThumbnailComponent(component);
    case 12: // Media Gallery
      return renderMediaGallery(component);
    case 14: // Separator
      return '<div class="dc-separator"></div>';
    case 17: // Container
      return renderContainer(component);
    default:
      return '';
  }
}

/**
 * Render a text input (for modal previews)
 */
function renderTextInput(input) {
  const label = escapeHtml(input.label || '');
  const placeholder = escapeAttr(input.placeholder || '');
  const required = input.required !== false;

  let html = '<div class="dc-text-input-wrapper">';
  html += `<div class="dc-text-input-label">${label}${required ? ' <span style="color:var(--dc-red)">*</span>' : ''}</div>`;

  if (input.style === 2) {
    // Paragraph
    html += `<textarea class="dc-text-input" placeholder="${placeholder}" rows="4">${escapeHtml(input.value || '')}</textarea>`;
  } else {
    // Short
    html += `<input class="dc-text-input" type="text" placeholder="${placeholder}" value="${escapeAttr(input.value || '')}">`;
  }
  html += '</div>';
  return html;
}

/**
 * Render a modal
 */
function renderModal(modal) {
  if (!modal) return '';

  let html = '<div class="dc-modal">';
  html += `<div class="dc-modal-header">${escapeHtml(modal.title || '')}</div>`;
  html += '<div class="dc-modal-body">';

  if (modal.components) {
    for (const row of modal.components) {
      if (row.type === 1 && row.components) {
        for (const input of row.components) {
          html += renderTextInput(input);
        }
      }
    }
  }

  html += '</div>';
  html += '<div class="dc-modal-footer">';
  html += '<button class="dc-btn dc-btn-secondary">Cancel</button>';
  html += '<button class="dc-btn dc-btn-primary">Submit</button>';
  html += '</div>';
  html += '</div>';
  return html;
}

// ========== Components V2 ==========

function renderSection(section) {
  let html = '<div class="dc-section">';
  html += '<div class="dc-section-text">';
  if (section.components) {
    for (const child of section.components) {
      html += renderComponent(child);
    }
  }
  html += '</div>';
  if (section.accessory) {
    html += '<div class="dc-section-accessory">';
    html += renderComponent(section.accessory);
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function renderTextDisplay(td) {
  const content = td.content || '';
  return `<div class="dc-embed-description">${require('./EmbedRenderer').renderDiscordMarkdown(content)}</div>`;
}

function renderThumbnailComponent(thumb) {
  if (!thumb.media || !thumb.media.url) return '';
  return `<img class="dc-embed-thumbnail" src="${escapeAttr(thumb.media.url)}" alt="">`;
}

function renderMediaGallery(gallery) {
  if (!gallery.items || gallery.items.length === 0) return '';
  let html = '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;">';
  for (const item of gallery.items) {
    if (item.media && item.media.url) {
      html += `<img src="${escapeAttr(item.media.url)}" alt="${escapeAttr(item.description || '')}" style="max-width:200px;max-height:200px;border-radius:4px;object-fit:cover;">`;
    }
  }
  html += '</div>';
  return html;
}

function renderContainer(container) {
  let html = '<div class="dc-container">';
  if (container.components) {
    for (const child of container.components) {
      html += renderComponent(child);
    }
  }
  html += '</div>';
  return html;
}

/**
 * Render an array of components (top-level action rows)
 */
function render(components) {
  if (!components || !Array.isArray(components)) return '';
  let html = '';
  for (const component of components) {
    html += renderComponent(component);
  }
  return html;
}

module.exports = {
  render,
  renderComponent,
  renderActionRow,
  renderButton,
  renderSelectMenu,
  renderModal,
  renderEmoji,
  BUTTON_STYLES
};
