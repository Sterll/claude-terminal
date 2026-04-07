/**
 * Code-related block renderers: diff, mermaid placeholder, SVG, math placeholder, HTML preview.
 */

const { escapeHtml, highlight } = require('../../../utils');
const { t } = require('../../../i18n');

// ── Diff Block ──

function renderDiffBlock(code, filename) {
  const lines = code.split('\n');
  const diffLines = lines.map((line, i) => {
    let cls = 'diff-ctx';
    let symbol = ' ';
    if (line.startsWith('+')) { cls = 'diff-add'; symbol = '+'; }
    else if (line.startsWith('-')) { cls = 'diff-del'; symbol = '-'; }
    else if (line.startsWith('@@')) { cls = 'diff-info'; symbol = '@'; }
    const content = line.startsWith('+') || line.startsWith('-') ? line.slice(1) : line;
    if (cls === 'diff-info') {
      return `<div class="diff-line ${cls}"><span class="diff-ln">${i + 1}</span><span class="diff-info-content">${escapeHtml(line)}</span></div>`;
    }
    return `<div class="diff-line ${cls}"><span class="diff-ln">${i + 1}</span><span class="diff-sym">${symbol}</span><span class="diff-content">${escapeHtml(content)}</span></div>`;
  }).join('');

  const filenameHtml = filename
    ? `<span class="chat-code-filename">${escapeHtml(filename)}</span>`
    : '';

  return `<div class="chat-code-block chat-diff-block">`
    + `<div class="chat-code-header"><span class="chat-code-lang">diff</span>${filenameHtml}`
    + `<button class="chat-code-copy" title="${t('common.copy')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button></div>`
    + `<pre class="diff-pre">${diffLines}</pre></div>`;
}

// ── Mermaid Block (placeholder for lazy loading) ──

function renderMermaidBlock(code) {
  const id = 'mermaid-' + Math.random().toString(36).slice(2, 8);
  return `<div class="chat-mermaid-block" data-mermaid-id="${id}">`
    + `<div class="chat-mermaid-loading">${escapeHtml(t('chat.mermaid.loading') || 'Rendering diagram...')}</div>`
    + `<div class="chat-mermaid-source" style="display:none">${escapeHtml(code)}</div>`
    + `<div class="chat-mermaid-render"></div>`
    + `<div class="chat-mermaid-error" style="display:none"></div>`
    + `</div>`;
}

// ── SVG Block ──

function sanitizeSvg(svgString) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (!svg) return escapeHtml(svgString);

    // Remove dangerous elements
    const dangerous = svg.querySelectorAll('script, foreignObject, iframe, embed, object');
    dangerous.forEach(el => el.remove());

    // Remove event handler attributes from all elements
    const allEls = svg.querySelectorAll('*');
    allEls.forEach(el => {
      const attrs = Array.from(el.attributes);
      attrs.forEach(attr => {
        if (attr.name.startsWith('on') || attr.name === 'href' && attr.value.startsWith('javascript:')) {
          el.removeAttribute(attr.name);
        }
      });
    });

    // Constrain dimensions
    if (!svg.getAttribute('viewBox') && !svg.getAttribute('width')) {
      svg.setAttribute('width', '100%');
    }
    svg.style.maxWidth = '100%';
    svg.style.maxHeight = '400px';

    return svg.outerHTML;
  } catch {
    return escapeHtml(svgString);
  }
}

function renderSvgBlock(code) {
  const sanitized = sanitizeSvg(code);
  return `<div class="chat-svg-block">`
    + `<div class="chat-svg-render">${sanitized}</div>`
    + `<details class="chat-svg-source"><summary>${escapeHtml(t('chat.preview.code') || 'Code')}</summary>`
    + `<pre><code>${escapeHtml(code)}</code></pre></details>`
    + `</div>`;
}

// ── Math Block (placeholder for lazy KaTeX) ──

function renderMathBlock(code) {
  return `<div class="chat-math-block" data-math-source="${escapeHtml(code)}">`
    + `<div class="chat-math-loading">${escapeHtml(t('chat.math.loading') || 'Rendering math...')}</div>`
    + `<div class="chat-math-render"></div>`
    + `</div>`;
}

// ── HTML Preview Block ──

function renderHtmlPreviewBlock(code, filename) {
  const filenameHtml = filename ? escapeHtml(filename) : 'preview.html';
  return `<div class="chat-preview-container" data-filename="${escapeHtml(filename || '')}">`
    + `<div class="chat-preview-toolbar">`
    + `<button class="chat-preview-btn active" data-action="preview">${escapeHtml(t('chat.preview.title') || 'Preview')}</button>`
    + `<button class="chat-preview-btn" data-action="code">${escapeHtml(t('chat.preview.code') || 'Code')}</button>`
    + `<span class="chat-preview-sep"></span>`
    + `<button class="chat-preview-btn" data-action="viewport-desktop" title="${t('chat.preview.desktop') || 'Desktop'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></button>`
    + `<button class="chat-preview-btn" data-action="viewport-tablet" title="${t('chat.preview.tablet') || 'Tablet'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg></button>`
    + `<button class="chat-preview-btn" data-action="viewport-mobile" title="${t('chat.preview.mobile') || 'Mobile'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg></button>`
    + `<span class="chat-preview-sep"></span>`
    + `<span class="chat-preview-filename">${filenameHtml}</span>`
    + `</div>`
    + `<div class="chat-preview-content">`
    + `<div class="chat-preview-iframe-wrap"><iframe class="chat-preview-iframe" sandbox="allow-scripts allow-same-origin"></iframe></div>`
    + `<div class="chat-preview-code-wrap" style="display:none"><pre><code>${highlight(code, 'html')}</code></pre></div>`
    + `</div>`
    + `<div class="chat-preview-source" style="display:none">${escapeHtml(code)}</div>`
    + `<div class="chat-preview-resize"></div>`
    + `</div>`;
}

module.exports = {
  renderDiffBlock,
  renderMermaidBlock,
  renderSvgBlock,
  renderMathBlock,
  renderHtmlPreviewBlock,
  sanitizeSvg,
};
