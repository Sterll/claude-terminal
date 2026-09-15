/**
 * The markdown file viewer shown in a terminal tab.
 *
 * A second, much smaller renderer than the chat’s: this one reads files off
 * disk, so relative image paths are resolved against the file and links are
 * inert until Ctrl+clicked rather than navigating the window. Raw HTML in the
 * source is dropped outright — both the tokenizer and the renderer refuse it
 * — because a markdown file in a repository is not trusted input.
 */

const { Marked } = require('marked');
const { escapeHtml, highlight } = require('../../../utils');
const { t } = require('../../../i18n');

function createMdRenderer(basePath) {
  const path = window.electron_nodeModules.path;
  const md = new Marked();
  md.use({
    renderer: {
      code({ text, lang }) {
        const decoded = (text || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
        const highlighted = lang ? highlight(decoded, lang) : escapeHtml(decoded);
        return `<div class="chat-code-block"><div class="chat-code-header"><span class="chat-code-lang">${escapeHtml(lang || 'text')}</span><button class="chat-code-copy" title="${t('common.copy')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button></div><pre><code>${highlighted}</code></pre></div>`;
      },
      codespan({ text }) {
        return `<code class="chat-inline-code">${escapeHtml(text)}</code>`;
      },
      table({ header, rows }) {
        const safeAlign = (a) => ['left', 'center', 'right'].includes(a) ? a : 'left';
        const headerHtml = header.map(h => `<th style="text-align:${safeAlign(h.align)}">${escapeHtml(typeof h.text === 'string' ? h.text : String(h.text || ''))}</th>`).join('');
        const rowsHtml = rows.map(row =>
          `<tr>${row.map(cell => `<td style="text-align:${safeAlign(cell.align)}">${escapeHtml(typeof cell.text === 'string' ? cell.text : String(cell.text || ''))}</td>`).join('')}</tr>`
        ).join('');
        return `<div class="chat-table-wrapper"><table class="chat-table"><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
      },
      link({ href, text }) {
        const safeHref = escapeHtml((href || '').trim());
        return `<a class="md-viewer-link" data-md-link="${safeHref}" title="${t('mdViewer.ctrlClickToOpen')}">${text || safeHref}</a>`;
      },
      image({ href, title, text }) {
        const src = (href || '').startsWith('http') ? href
          : `file:///${path.resolve(basePath, href || '').replace(/\\/g, '/')}`;
        return `<img src="${src}" alt="${escapeHtml(text || '')}" title="${escapeHtml(title || '')}" class="md-viewer-img" />`;
      },
      heading({ tokens, depth }) {
        const text = tokens.map(tok => tok.raw || tok.text || '').join('');
        const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return `<h${depth} id="md-h-${id}" class="md-viewer-heading">${this.parser.parseInline(tokens)}</h${depth}>`;
      },
      html() { return ''; }
    },
    tokenizer: {
      html() { return undefined; }
    },
    gfm: true,
    breaks: false
  });
  return md;
}

function buildMdToc(content) {
  const md = new Marked();
  const tokens = md.lexer(content);
  const headings = tokens
    .filter(tok => tok.type === 'heading')
    .map(tok => {
      const text = tok.text || '';
      const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return { depth: tok.depth, text, id: `md-h-${id}` };
    });
  if (headings.length === 0) return '';
  return `<nav class="md-toc-nav">
    <div class="md-toc-title">${t('mdViewer.tableOfContents')}</div>
    <ul class="md-toc-list">${headings.map(h =>
      `<li class="md-toc-item md-toc-depth-${h.depth}"><a href="#${h.id}" data-toc-link="${h.id}">${escapeHtml(h.text)}</a></li>`
    ).join('')}</ul>
  </nav>`;
}

module.exports = { createMdRenderer, buildMdToc };
