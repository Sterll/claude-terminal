/**
 * Discord Embed Renderer
 * Generates HTML faithful to Discord's embed rendering
 */

/**
 * Render basic Discord markdown (bold, italic, code, links, underline, strikethrough)
 */
function renderDiscordMarkdown(text) {
  if (!text) return '';
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Underline
  html = html.replace(/__(.+?)__/g, '<u>$1</u>');
  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Newlines
  html = html.replace(/\n/g, '<br>');

  return html;
}

/**
 * Convert hex color int to CSS color string
 */
function colorToCSS(color) {
  if (!color && color !== 0) return null;
  if (typeof color === 'string') {
    if (color.startsWith('#')) return color;
    const parsed = parseInt(color, 10);
    if (!isNaN(parsed)) return '#' + parsed.toString(16).padStart(6, '0');
    return color;
  }
  return '#' + color.toString(16).padStart(6, '0');
}

/**
 * Format ISO timestamp to relative or readable format
 */
function formatTimestamp(ts) {
  if (!ts) return '';
  try {
    const date = new Date(ts);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return ts;
  }
}

/**
 * Render a Discord embed to HTML
 * @param {Object} embed - Embed data object
 * @returns {string} HTML string
 */
function render(embed) {
  if (!embed) return '';

  const hasThumbnail = !!(embed.thumbnail && embed.thumbnail.url);
  const borderColor = colorToCSS(embed.color) || 'var(--dc-bg-tertiary)';
  const hasInlineFields = embed.fields && embed.fields.some(f => f.inline);

  let html = `<div class="dc-embed${hasThumbnail ? ' has-thumbnail' : ''}" style="border-left-color: ${borderColor}">`;

  // Author
  if (embed.author) {
    html += '<div class="dc-embed-author">';
    if (embed.author.icon_url) {
      html += `<img class="dc-embed-author-icon" src="${escapeAttr(embed.author.icon_url)}" alt="">`;
    }
    html += '<span class="dc-embed-author-name">';
    if (embed.author.url) {
      html += `<a href="${escapeAttr(embed.author.url)}" target="_blank" rel="noopener">${escapeHtml(embed.author.name || '')}</a>`;
    } else {
      html += escapeHtml(embed.author.name || '');
    }
    html += '</span></div>';
  }

  // Title
  if (embed.title) {
    html += '<div class="dc-embed-title">';
    if (embed.url) {
      html += `<a href="${escapeAttr(embed.url)}" target="_blank" rel="noopener">${renderDiscordMarkdown(embed.title)}</a>`;
    } else {
      html += renderDiscordMarkdown(embed.title);
    }
    html += '</div>';
  }

  // Description
  if (embed.description) {
    html += `<div class="dc-embed-description">${renderDiscordMarkdown(embed.description)}</div>`;
  }

  // Fields
  if (embed.fields && embed.fields.length > 0) {
    html += `<div class="dc-embed-fields${hasInlineFields ? ' has-inline' : ''}">`;
    for (const field of embed.fields) {
      html += `<div class="dc-embed-field${field.inline ? ' inline' : ''}">`;
      html += `<div class="dc-embed-field-name">${renderDiscordMarkdown(field.name || '')}</div>`;
      html += `<div class="dc-embed-field-value">${renderDiscordMarkdown(field.value || '')}</div>`;
      html += '</div>';
    }
    html += '</div>';
  }

  // Thumbnail
  if (hasThumbnail) {
    html += `<img class="dc-embed-thumbnail" src="${escapeAttr(embed.thumbnail.url)}" alt="">`;
  }

  // Image
  if (embed.image && embed.image.url) {
    html += `<img class="dc-embed-image" src="${escapeAttr(embed.image.url)}" alt="">`;
  }

  // Footer
  if (embed.footer || embed.timestamp) {
    html += '<div class="dc-embed-footer">';
    if (embed.footer && embed.footer.icon_url) {
      html += `<img class="dc-embed-footer-icon" src="${escapeAttr(embed.footer.icon_url)}" alt="">`;
    }
    const parts = [];
    if (embed.footer && embed.footer.text) {
      parts.push(escapeHtml(embed.footer.text));
    }
    if (embed.timestamp) {
      parts.push(formatTimestamp(embed.timestamp));
    }
    html += `<span class="dc-embed-footer-text">${parts.join('<span class="dc-embed-footer-separator"></span>')}</span>`;
    html += '</div>';
  }

  html += '</div>';
  return html;
}

/**
 * Try to parse embed data from discord.js builder code
 */
function parseEmbedFromCode(code) {
  try {
    const embed = {};

    // .setTitle('...')
    const titleMatch = code.match(/\.setTitle\(\s*['"`]([^'"`]+)['"`]\s*\)/);
    if (titleMatch) embed.title = titleMatch[1];

    // .setDescription('...')
    const descMatch = code.match(/\.setDescription\(\s*['"`]([\s\S]*?)['"`]\s*\)/);
    if (descMatch) embed.description = descMatch[1];

    // .setColor(0x... or '#...' or number)
    const colorMatch = code.match(/\.setColor\(\s*(0x[0-9a-fA-F]+|\d+|['"`]#[0-9a-fA-F]+['"`])\s*\)/);
    if (colorMatch) {
      let c = colorMatch[1].replace(/['"`]/g, '');
      if (c.startsWith('#')) {
        embed.color = c;
      } else {
        embed.color = parseInt(c);
      }
    }

    // .setURL('...')
    const urlMatch = code.match(/\.setURL\(\s*['"`]([^'"`]+)['"`]\s*\)/);
    if (urlMatch) embed.url = urlMatch[1];

    // .setThumbnail('...')
    const thumbMatch = code.match(/\.setThumbnail\(\s*['"`]([^'"`]+)['"`]\s*\)/);
    if (thumbMatch) embed.thumbnail = { url: thumbMatch[1] };

    // .setImage('...')
    const imgMatch = code.match(/\.setImage\(\s*['"`]([^'"`]+)['"`]\s*\)/);
    if (imgMatch) embed.image = { url: imgMatch[1] };

    // .setTimestamp()
    if (code.includes('.setTimestamp(')) {
      embed.timestamp = new Date().toISOString();
    }

    // .setFooter({ text: '...' })
    const footerMatch = code.match(/\.setFooter\(\s*\{[^}]*text:\s*['"`]([^'"`]+)['"`]/);
    if (footerMatch) {
      embed.footer = { text: footerMatch[1] };
      const footerIconMatch = code.match(/\.setFooter\(\s*\{[^}]*iconURL:\s*['"`]([^'"`]+)['"`]/);
      if (footerIconMatch) embed.footer.icon_url = footerIconMatch[1];
    }

    // .setAuthor({ name: '...' })
    const authorMatch = code.match(/\.setAuthor\(\s*\{[^}]*name:\s*['"`]([^'"`]+)['"`]/);
    if (authorMatch) {
      embed.author = { name: authorMatch[1] };
      const authorIconMatch = code.match(/\.setAuthor\(\s*\{[^}]*iconURL:\s*['"`]([^'"`]+)['"`]/);
      if (authorIconMatch) embed.author.icon_url = authorIconMatch[1];
      const authorUrlMatch = code.match(/\.setAuthor\(\s*\{[^}]*url:\s*['"`]([^'"`]+)['"`]/);
      if (authorUrlMatch) embed.author.url = authorUrlMatch[1];
    }

    // .addFields({ name: '...', value: '...' })
    const fieldsRegex = /\{\s*name:\s*['"`]([^'"`]+)['"`]\s*,\s*value:\s*['"`]([^'"`]+)['"`](?:\s*,\s*inline:\s*(true|false))?\s*\}/g;
    let fieldMatch;
    while ((fieldMatch = fieldsRegex.exec(code)) !== null) {
      if (!embed.fields) embed.fields = [];
      embed.fields.push({
        name: fieldMatch[1],
        value: fieldMatch[2],
        inline: fieldMatch[3] === 'true'
      });
    }

    // Return null if nothing was parsed
    if (Object.keys(embed).length === 0) return null;
    return embed;
  } catch {
    return null;
  }
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = {
  render,
  parseEmbedFromCode,
  renderDiscordMarkdown,
  colorToCSS,
  escapeHtml,
  escapeAttr
};
