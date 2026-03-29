/**
 * Workspace display block renderers: KB document cards, concept links.
 */

const { escapeHtml } = require('../../../utils');

// ── KB Document Card ──

function renderWorkspaceDocBlock(code) {
  const { marked } = require('marked');

  // Split header from body at first "---" line
  const lines = code.split('\n');
  let separatorIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') { separatorIdx = i; break; }
  }

  const headerLines = separatorIdx >= 0 ? lines.slice(0, separatorIdx) : lines;
  const bodyText = separatorIdx >= 0 ? lines.slice(separatorIdx + 1).join('\n').trim() : '';

  let title = '', icon = '\uD83D\uDCC4', tags = [];
  for (const line of headerLines) {
    const titleMatch = line.match(/^title:\s*(.+)/i);
    if (titleMatch) { title = titleMatch[1].trim(); continue; }
    const iconMatch = line.match(/^icon:\s*(.+)/i);
    if (iconMatch) { icon = iconMatch[1].trim(); continue; }
    const tagsMatch = line.match(/^tags:\s*(.+)/i);
    if (tagsMatch) { tags = tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean); continue; }
  }

  if (!title) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const bodyHtml = bodyText ? marked.parse(bodyText) : '';

  const tagsHtml = tags.length > 0
    ? `<div class="chat-ws-doc-tags">${tags.map(t =>
        `<span class="chat-ws-doc-tag">${escapeHtml(t)}</span>`
      ).join('')}</div>`
    : '';

  return `<div class="chat-ws-doc">`
    + `<div class="chat-ws-doc-header">`
    + `<span class="chat-ws-doc-icon">${escapeHtml(icon)}</span>`
    + `<span class="chat-ws-doc-title">${escapeHtml(title)}</span>`
    + `</div>`
    + tagsHtml
    + (bodyHtml ? `<div class="chat-ws-doc-body">${bodyHtml}</div>` : '')
    + `</div>`;
}

// ── Concept Links Section ──

function renderWorkspaceLinksBlock(code) {
  const lines = code.split('\n').filter(l => l.trim());
  let title = '';
  const links = [];

  for (const line of lines) {
    const titleMatch = line.match(/^title:\s*(.+)/i);
    if (titleMatch) { title = titleMatch[1].trim(); continue; }

    const parts = line.split('|').map(s => s.trim());
    if (parts.length >= 3) {
      links.push({
        source: parts[0],
        label: parts[1],
        target: parts[2],
        badge: parts[3] || '',
      });
    }
  }

  if (links.length === 0) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const headerHtml = `<div class="chat-ws-links-header">`
    + `<span class="chat-ws-links-title">${escapeHtml(title || 'Concept Links')}</span>`
    + `<span class="chat-ws-links-count">${links.length}</span>`
    + `</div>`;

  const rowsHtml = links.map(link => {
    const badgeHtml = link.badge
      ? ` <span class="chat-ws-link-badge ${escapeHtml(link.badge.toLowerCase())}">${escapeHtml(link.badge)}</span>`
      : '';
    return `<div class="chat-ws-link-row">`
      + `<span class="chat-ws-link-entity">${escapeHtml(link.source)}</span>`
      + `<span class="chat-ws-link-arrow">\u2192</span>`
      + `<span class="chat-ws-link-label">${escapeHtml(link.label)}</span>`
      + `<span class="chat-ws-link-arrow">\u2192</span>`
      + `<span class="chat-ws-link-entity">${escapeHtml(link.target)}</span>`
      + badgeHtml
      + `</div>`;
  }).join('');

  return `<div class="chat-ws-links">${headerHtml}<div class="chat-ws-links-body">${rowsHtml}</div></div>`;
}

module.exports = {
  renderWorkspaceDocBlock,
  renderWorkspaceLinksBlock,
};
