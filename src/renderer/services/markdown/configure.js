/**
 * Marked configuration with custom renderers and extensions.
 * DOMPurify sanitization for all rendered output.
 */

const { marked } = require('marked');
const DOMPurify = require('dompurify');
const { escapeHtml, highlight } = require('../../utils');
const { t } = require('../../i18n');

// Block renderers
const { renderDiffBlock, renderMermaidBlock, renderSvgBlock, renderMathBlock, renderHtmlPreviewBlock } = require('./blocks/code');
const { renderLinksBlock, renderMetricsBlock, renderApiBlock, renderResourceBlock, renderConfigBlock, renderCommandBlock } = require('./blocks/data');
const { renderFileTree, renderTerminalBlock, renderTimelineBlock, renderCompareBlock, renderTabsBlock, renderEventFlowBlock } = require('./blocks/layout');
const { renderDiscordEmbedBlock, renderDiscordComponentBlock, renderDiscordMessageBlock } = require('./blocks/discord');

// ── Special language identifiers for custom blocks ──
const SPECIAL_LANGS = new Set([
  'mermaid', 'svg', 'math', 'latex', 'katex',
  'tree', 'filetree', 'terminal', 'console', 'output',
  'timeline', 'steps', 'compare', 'links', 'tabs',
  'metrics', 'api', 'endpoint', 'resource', 'eventflow',
  'config', 'convars', 'command', 'cmd',
  'embed', 'discord-embed', 'discord-component', 'discord-components', 'discord-message',
]);

// Callout types: > [!TYPE]
const CALLOUT_TYPES = {
  NOTE: { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>', class: 'note' },
  TIP: { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 1 4 12.9V17H8v-2.1A7 7 0 0 1 12 2z"/></svg>', class: 'tip' },
  IMPORTANT: { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>', class: 'important' },
  WARNING: { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>', class: 'warning' },
  CAUTION: { icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/></svg>', class: 'caution' },
};

// ── Collapsible code threshold ──
const COLLAPSE_THRESHOLD = 30;

// ── DOMPurify configuration ──
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    // Standard HTML
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',
    'strong', 'em', 'b', 'i', 'u', 'del', 'code', 'pre', 'kbd',
    'ul', 'ol', 'li', 'a', 'span', 'div', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'blockquote', 'details', 'summary',
    // SVG (mermaid + SVG blocks)
    'svg', 'path', 'circle', 'line', 'rect', 'polyline', 'polygon',
    'ellipse', 'g', 'text', 'tspan', 'defs', 'use', 'marker',
    'clipPath', 'mask', 'pattern', 'linearGradient', 'radialGradient',
    'stop', 'symbol', 'foreignObject', 'title',
    // Interactive elements
    'input', 'button', 'iframe', 'label',
  ],
  ALLOWED_ATTR: [
    'href', 'target', 'rel', 'class', 'style', 'title',
    'src', 'srcdoc', 'sandbox', 'alt', 'width', 'height',
    'viewBox', 'xmlns', 'fill', 'stroke', 'stroke-width', 'stroke-linecap',
    'stroke-linejoin', 'stroke-dasharray', 'd', 'cx', 'cy', 'r', 'x', 'y',
    'x1', 'y1', 'x2', 'y2', 'rx', 'ry', 'points',
    'transform', 'opacity', 'id', 'clip-path', 'marker-end', 'marker-start',
    'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline',
    'type', 'placeholder', 'value',
  ],
  ALLOW_DATA_ATTR: true,
  ADD_ATTR: ['target'],
  FORBID_TAGS: ['script', 'object', 'embed'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
};

let _configured = false;

/**
 * Configure marked with all custom renderers and extensions.
 * Called once on first render.
 */
function configure() {
  if (_configured) return;
  _configured = true;

  marked.use({
    renderer: {
      // ── Enhanced code blocks ──
      code({ text, lang }) {
        const raw = (text || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

        // Parse filename from lang:filename pattern (e.g. "js:app.js")
        let language = lang || '';
        let filename = '';
        if (language.includes(':') && !SPECIAL_LANGS.has(language.split(':')[0])) {
          const parts = language.split(':');
          language = parts[0];
          filename = parts.slice(1).join(':');
        }

        // ── Special blocks ──
        const langLower = language.toLowerCase();

        if (langLower === 'mermaid') return renderMermaidBlock(raw);
        if (langLower === 'svg') return renderSvgBlock(raw);
        if (langLower === 'math' || langLower === 'latex' || langLower === 'katex') return renderMathBlock(raw);
        if (langLower === 'html' && (raw.includes('<') || filename)) return renderHtmlPreviewBlock(raw, filename);
        if (langLower === 'diff') return renderDiffBlock(raw, filename);
        if (langLower === 'tree' || langLower === 'filetree') return renderFileTree(raw);
        if (langLower === 'terminal' || langLower === 'console' || langLower === 'output') return renderTerminalBlock(raw);
        if (langLower === 'timeline' || langLower === 'steps') return renderTimelineBlock(raw);
        if (langLower === 'compare') return renderCompareBlock(raw);
        if (langLower === 'links') return renderLinksBlock(raw);
        if (langLower === 'tabs') return renderTabsBlock(raw);
        if (langLower === 'metrics') return renderMetricsBlock(raw);
        if (langLower === 'api' || langLower === 'endpoint') return renderApiBlock(raw);
        if (langLower === 'resource') return renderResourceBlock(raw);
        if (langLower === 'eventflow') return renderEventFlowBlock(raw);
        if (langLower === 'config' || langLower === 'convars') return renderConfigBlock(raw);
        if (langLower === 'command' || langLower === 'cmd') return renderCommandBlock(raw);
        if (langLower === 'embed' || langLower === 'discord-embed') return renderDiscordEmbedBlock(raw);
        if (langLower === 'discord-component' || langLower === 'discord-components') return renderDiscordComponentBlock(raw);
        if (langLower === 'discord-message') return renderDiscordMessageBlock(raw);

        // ── Standard code block ──
        const highlighted = language ? highlight(raw, language) : escapeHtml(raw);
        const lines = raw.split('\n');
        const lineCount = lines.length;
        const isCollapsible = lineCount > COLLAPSE_THRESHOLD;

        const numberedLines = highlighted.split('\n').map((line, i) =>
          `<span class="code-line" data-line="${i + 1}">${line || ' '}</span>`
        ).join('\n');

        const langDisplay = escapeHtml(language || 'text');
        const filenameHtml = filename
          ? `<span class="chat-code-filename">${escapeHtml(filename)}</span>`
          : '';

        const collapseAttr = isCollapsible ? ' data-collapsible="true" data-collapsed="true"' : '';
        const collapseBtn = isCollapsible
          ? `<button class="chat-code-collapse-btn" data-lines="${lineCount}">${t('chat.code.showMore', { count: lineCount - COLLAPSE_THRESHOLD })}</button>`
          : '';

        return `<div class="chat-code-block${isCollapsible ? ' collapsible collapsed' : ''}"${collapseAttr}>`
          + `<div class="chat-code-header">`
          + `${filenameHtml}<span class="chat-code-lang">${langDisplay}</span>`
          + `<div class="chat-code-actions">`
          + `<button class="chat-code-line-toggle" title="${t('chat.code.lineNumbers')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>`
          + `<button class="chat-code-copy" title="${t('common.copy')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>`
          + `</div></div>`
          + `<pre><code class="line-numbers-off">${numberedLines}</code></pre>`
          + collapseBtn
          + `</div>`;
      },

      // ── Inline code ──
      codespan({ text }) {
        if (/^(Ctrl|Alt|Shift|Cmd|Meta|Super|Win|Tab|Enter|Esc(?:ape)?|Backspace|Delete|Home|End|PageUp|PageDown|Space|Arrow(?:Up|Down|Left|Right)|Insert|F\d{1,2})(\+.+)*$/i.test(text)) {
          const keys = text.split('+').map(k => `<kbd>${escapeHtml(k.trim())}</kbd>`);
          return `<span class="chat-kbd-group">${keys.join('<span class="chat-kbd-sep">+</span>')}</span>`;
        }
        const hexMatch = text.match(/^#([0-9a-fA-F]{3,8})$/);
        if (hexMatch) {
          return `<span class="chat-color-swatch"><span class="chat-color-dot" style="background:${escapeHtml(text)}"></span>${escapeHtml(text)}</span>`;
        }
        return `<code class="chat-inline-code">${escapeHtml(text)}</code>`;
      },

      // ── Tables (interactive) ──
      table({ header, rows }) {
        const safeAlign = (a) => ['left', 'center', 'right'].includes(a) ? a : 'left';
        const parseCell = (text) => marked.parseInline(typeof text === 'string' ? text : String(text || ''));
        const headerHtml = header.map(h =>
          `<th class="sortable" style="text-align:${safeAlign(h.align)}" data-col-idx="${header.indexOf(h)}">${parseCell(h.text)}</th>`
        ).join('');
        const rowsHtml = rows.map(row =>
          `<tr>${row.map(cell => `<td style="text-align:${safeAlign(cell.align)}">${parseCell(cell.text)}</td>`).join('')}</tr>`
        ).join('');
        const hasSearch = rows.length > 10;
        const searchHtml = hasSearch
          ? `<div class="chat-table-search-wrap"><input type="text" class="chat-table-search" placeholder="${t('chat.table.search')}" /></div>`
          : '';

        return `<div class="chat-table-container" data-rows="${rows.length}">`
          + searchHtml
          + `<div class="chat-table-wrapper"><table class="chat-table chat-table-sortable"><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`
          + `</div>`;
      },

      // ── Blockquotes with callout detection ──
      blockquote({ text, tokens }) {
        const html = tokens ? this.parser.parse(tokens) : text;
        const calloutMatch = text.match(/^\s*(?:<p>\s*)?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i);
        if (calloutMatch) {
          const type = calloutMatch[1].toUpperCase();
          const callout = CALLOUT_TYPES[type];
          if (callout) {
            let content = text.slice(calloutMatch[0].length).trim();
            if (content) {
              content = marked.parse(content);
            }
            const title = t(`chat.callout.${type.toLowerCase()}`) || type;
            return `<div class="chat-callout chat-callout-${callout.class}">`
              + `<div class="chat-callout-header">`
              + `<span class="chat-callout-icon">${callout.icon}</span>`
              + `<span class="chat-callout-title">${escapeHtml(title)}</span>`
              + `</div>`
              + `<div class="chat-callout-body">${content}</div>`
              + `</div>`;
          }
        }
        return `<blockquote>${html}</blockquote>`;
      },

      // ── Links ──
      link({ href, tokens }) {
        const raw = (href || '').trim();
        const safePrefixes = ['https://', 'http://', '#'];
        const isSafe = safePrefixes.some(p => raw.startsWith(p));
        const safeHref = isSafe ? escapeHtml(raw) : '#';
        const body = tokens ? this.parser.parseInline(tokens) : '';
        return `<a href="${safeHref}" class="chat-link" target="_blank" rel="noopener noreferrer">${body}</a>`;
      },

      // ── Paragraphs ──
      paragraph({ tokens }) {
        const text = this.parser.parseInline(tokens);
        return `<p>${text.replace(/(<br\s*\/?>)+\s*$/, '')}</p>\n`;
      }
    },
    breaks: true,
    gfm: true
  });

  // Disable raw HTML passthrough, except <details>/<summary> for spoiler blocks
  marked.use({
    renderer: {
      html({ text }) {
        const trimmed = (text || '').trim();
        if (/^<\/?details(\s|>|$)/i.test(trimmed) || /^<\/?summary(\s|>|$)/i.test(trimmed)) {
          return renderDetailsHtml(trimmed);
        }
        return '';
      }
    },
    tokenizer: {
      html(src) {
        const detailsMatch = src.match(/^<(details|summary)(\s[^>]*)?>|^<\/(details|summary)>/i);
        if (detailsMatch) {
          return { type: 'html', raw: detailsMatch[0], text: detailsMatch[0] };
        }
        return undefined;
      }
    }
  });

  // Inline math: $...$ (single dollar, not escaped, not inside code)
  marked.use({
    extensions: [{
      name: 'inlineMath',
      level: 'inline',
      start(src) {
        const match = src.match(/\$/);
        return match ? match.index : -1;
      },
      tokenizer(src) {
        const match = src.match(/^\$([^\$\n]+?)\$/);
        if (match) {
          return { type: 'inlineMath', raw: match[0], text: match[1].trim() };
        }
        return undefined;
      },
      renderer(token) {
        return `<span class="chat-math-inline" data-math-source="${escapeHtml(token.text)}">${escapeHtml(token.text)}</span>`;
      }
    }]
  });
}

// ── Details / Spoiler HTML handler ──

function renderDetailsHtml(tag) {
  if (/^<details/i.test(tag)) {
    return `<div class="chat-details">`;
  }
  if (/^<\/details>/i.test(tag)) {
    return `</div></div>`;
  }
  if (/^<summary/i.test(tag)) {
    const inlineMatch = tag.match(/<summary[^>]*>(.*?)<\/summary>/i);
    if (inlineMatch) {
      return `<div class="chat-details-summary">`
        + `<svg class="chat-details-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`
        + escapeHtml(inlineMatch[1])
        + `</div><div class="chat-details-content">`;
    }
    return `<div class="chat-details-summary">`
      + `<svg class="chat-details-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
  }
  if (/^<\/summary>/i.test(tag)) {
    return `</div><div class="chat-details-content">`;
  }
  return '';
}

// ── Public API ──

/**
 * Render markdown text to HTML (full render) with DOMPurify sanitization.
 */
function render(text) {
  if (!text) return '';
  configure();
  try {
    return DOMPurify.sanitize(marked.parse(text), PURIFY_CONFIG);
  } catch (err) {
    console.error('[MarkdownRenderer] Render failed:', err.message);
    return `<pre class="chat-markdown-fallback">${escapeHtml(text)}</pre>`;
  }
}

/**
 * Render inline markdown (no block wrappers) with DOMPurify sanitization.
 */
function renderInline(text) {
  if (!text) return '';
  configure();
  try {
    return DOMPurify.sanitize(marked.parseInline(text), PURIFY_CONFIG);
  } catch {
    return escapeHtml(text);
  }
}

module.exports = {
  configure,
  render,
  renderInline,
  PURIFY_CONFIG,
  COLLAPSE_THRESHOLD,
};
