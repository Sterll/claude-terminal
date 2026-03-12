/**
 * MarkdownRenderer Service
 * Core rendering engine for chat markdown — extends marked with custom
 * block types (callouts, enhanced code, interactive tables, previews, etc.)
 * and provides incremental streaming rendering.
 */

const { marked } = require('marked');
const { escapeHtml, highlight } = require('../utils');
const { t } = require('../i18n');

// ── Special language identifiers for custom blocks ──
const SPECIAL_LANGS = new Set([
  'mermaid', 'svg', 'math', 'latex', 'katex',
  'tree', 'filetree', 'terminal', 'console', 'output',
  'timeline', 'steps', 'compare', 'links', 'tabs',
  'metrics', 'api', 'endpoint', 'resource', 'eventflow',
  'config', 'convars', 'command', 'cmd',
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

        // Mermaid diagrams
        if (langLower === 'mermaid') {
          return renderMermaidBlock(raw);
        }

        // SVG inline
        if (langLower === 'svg') {
          return renderSvgBlock(raw);
        }

        // Math / LaTeX
        if (langLower === 'math' || langLower === 'latex' || langLower === 'katex') {
          return renderMathBlock(raw);
        }

        // HTML preview
        if (langLower === 'html' && (raw.includes('<') || filename)) {
          return renderHtmlPreviewBlock(raw, filename);
        }

        // Diff highlighting
        if (langLower === 'diff') {
          return renderDiffBlock(raw, filename);
        }

        // File tree
        if (langLower === 'tree' || langLower === 'filetree') {
          return renderFileTree(raw);
        }

        // Terminal output
        if (langLower === 'terminal' || langLower === 'console' || langLower === 'output') {
          return renderTerminalBlock(raw);
        }

        // Timeline / Steps
        if (langLower === 'timeline' || langLower === 'steps') {
          return renderTimelineBlock(raw);
        }

        // Comparison (Before/After)
        if (langLower === 'compare') {
          return renderCompareBlock(raw);
        }

        // Link Cards
        if (langLower === 'links') {
          return renderLinksBlock(raw);
        }

        // Tabs
        if (langLower === 'tabs') {
          return renderTabsBlock(raw);
        }

        // Metric Cards
        if (langLower === 'metrics') {
          return renderMetricsBlock(raw);
        }

        // API Endpoint Cards
        if (langLower === 'api' || langLower === 'endpoint') {
          return renderApiBlock(raw);
        }

        // FiveM Resource Card
        if (langLower === 'resource') {
          return renderResourceBlock(raw);
        }

        // Event Flow Diagram
        if (langLower === 'eventflow') {
          return renderEventFlowBlock(raw);
        }

        // Config / Convars Block
        if (langLower === 'config' || langLower === 'convars') {
          return renderConfigBlock(raw);
        }

        // Game Command Reference
        if (langLower === 'command' || langLower === 'cmd') {
          return renderCommandBlock(raw);
        }

        // ── Standard code block ──
        const highlighted = language ? highlight(raw, language) : escapeHtml(raw);
        const lines = raw.split('\n');
        const lineCount = lines.length;
        const isCollapsible = lineCount > COLLAPSE_THRESHOLD;

        // Build line-numbered code
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
        // Detect keyboard shortcuts: `Ctrl+C`, `Alt+Tab`, `Escape`, etc.
        if (/^(Ctrl|Alt|Shift|Cmd|Meta|Super|Win|Tab|Enter|Esc(?:ape)?|Backspace|Delete|Home|End|PageUp|PageDown|Space|Arrow(?:Up|Down|Left|Right)|Insert|F\d{1,2})(\+.+)*$/i.test(text)) {
          const keys = text.split('+').map(k => `<kbd>${escapeHtml(k.trim())}</kbd>`);
          return `<span class="chat-kbd-group">${keys.join('<span class="chat-kbd-sep">+</span>')}</span>`;
        }
        // Detect hex color codes: `#d97706`, `#fff`, `#FF5733`
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
      blockquote({ text }) {
        // Detect [!TYPE] callout pattern — marked v17 may or may not wrap in <p>
        const calloutMatch = text.match(/^\s*(?:<p>\s*)?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i);
        if (calloutMatch) {
          const type = calloutMatch[1].toUpperCase();
          const callout = CALLOUT_TYPES[type];
          if (callout) {
            // Remove the [!TYPE] prefix from content and render remaining as markdown
            let content = text.slice(calloutMatch[0].length).trim();
            // Parse remaining content as inline markdown for formatting support
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
        return `<blockquote>${text}</blockquote>`;
      },

      // ── Links ──
      link({ href, text }) {
        const raw = (href || '').trim();
        const safePrefixes = ['https://', 'http://', '#'];
        const isSafe = safePrefixes.some(p => raw.startsWith(p));
        const safeHref = isSafe ? escapeHtml(raw) : '#';
        return `<a href="${safeHref}" class="chat-link" target="_blank" rel="noopener noreferrer">${escapeHtml(typeof text === 'string' ? text : String(text || ''))}</a>`;
      },

      // ── Paragraphs ──
      paragraph({ text }) {
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
        // Allow <details> and <summary> tags for spoiler/collapsible blocks
        if (/^<\/?details(\s|>|$)/i.test(trimmed) || /^<\/?summary(\s|>|$)/i.test(trimmed)) {
          return renderDetailsHtml(trimmed);
        }
        return '';
      }
    },
    tokenizer: {
      html(src) {
        // Let details/summary pass through to the html renderer
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


// ══════════════════════════════════════════════
// Special Block Renderers
// ══════════════════════════════════════════════

function renderDiffBlock(code, filename) {
  const lines = code.split('\n');
  const diffLines = lines.map((line, i) => {
    let cls = 'diff-ctx';
    let symbol = ' ';
    if (line.startsWith('+')) { cls = 'diff-add'; symbol = '+'; }
    else if (line.startsWith('-')) { cls = 'diff-del'; symbol = '-'; }
    else if (line.startsWith('@@')) { cls = 'diff-info'; symbol = '@'; }
    const content = line.startsWith('+') || line.startsWith('-') ? line.slice(1) : line;
    // @@ lines: render full line content without symbol split
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

function renderMermaidBlock(code) {
  const id = 'mermaid-' + Math.random().toString(36).slice(2, 8);
  return `<div class="chat-mermaid-block" data-mermaid-id="${id}">`
    + `<div class="chat-mermaid-loading">${escapeHtml(t('chat.mermaid.loading') || 'Rendering diagram...')}</div>`
    + `<div class="chat-mermaid-source" style="display:none">${escapeHtml(code)}</div>`
    + `<div class="chat-mermaid-render"></div>`
    + `<div class="chat-mermaid-error" style="display:none"></div>`
    + `</div>`;
}

function renderSvgBlock(code) {
  // Sanitize SVG: remove script, event handlers, foreignObject
  const sanitized = sanitizeSvg(code);
  return `<div class="chat-svg-block">`
    + `<div class="chat-svg-render">${sanitized}</div>`
    + `<details class="chat-svg-source"><summary>${escapeHtml(t('chat.preview.code') || 'Code')}</summary>`
    + `<pre><code>${escapeHtml(code)}</code></pre></details>`
    + `</div>`;
}

function renderMathBlock(code) {
  return `<div class="chat-math-block" data-math-source="${escapeHtml(code)}">`
    + `<div class="chat-math-loading">${escapeHtml(t('chat.math.loading') || 'Rendering math...')}</div>`
    + `<div class="chat-math-render"></div>`
    + `</div>`;
}

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
    + `<div class="chat-preview-iframe-wrap"><iframe class="chat-preview-iframe" sandbox="allow-scripts" srcdoc=""></iframe></div>`
    + `<div class="chat-preview-code-wrap" style="display:none"><pre><code>${highlight(code, 'html')}</code></pre></div>`
    + `</div>`
    + `<div class="chat-preview-source" style="display:none">${escapeHtml(code)}</div>`
    + `<div class="chat-preview-resize"></div>`
    + `</div>`;
}


// ══════════════════════════════════════════════
// File Tree Renderer
// ══════════════════════════════════════════════

function renderFileTree(code) {
  const lines = code.split('\n').filter(l => l.trim());
  const items = [];

  // Tree-drawing characters regex: ├ └ │ ─ ┬ ┤ ┘ ┐ ┌ ╭ ╰ ╮ ╯
  const treeCharsRe = /[├└│─┬┤┘┐┌╭╰╮╯┊┆┃┈╌]/g;

  for (const line of lines) {
    // Count depth from tree chars and leading whitespace
    // Strip tree-drawing chars and leading spaces to get the name
    const stripped = line.replace(treeCharsRe, ' ');
    const match = stripped.match(/^(\s*)(.*)/);
    if (!match) continue;

    // Compute depth: count groups of tree-char + spaces (typically 4 chars per level)
    const prefix = line.match(/^[\s├└│─┬┤┘┐┌╭╰╮╯┊┆┃┈╌]*/)?.[0] || '';
    // Each nesting level is roughly 4 chars (│   or ├── or └── )
    const depth = Math.round(prefix.length / 4);

    let name = match[2].trim();
    if (!name) continue;

    // Parse optional metadata after tab or multiple spaces
    let meta = '';
    const metaMatch = name.match(/^(.+?)\s{2,}(.+)$/);
    if (metaMatch) {
      name = metaMatch[1].trim();
      meta = metaMatch[2].trim();
    }

    const isDir = name.endsWith('/');
    items.push({ name, depth, isDir, meta });
  }

  // File extension icons
  const extIcons = {
    js: '<span class="ft-ext" style="color:#f7df1e">JS</span>',
    mjs: '<span class="ft-ext" style="color:#f7df1e">JS</span>',
    ts: '<span class="ft-ext" style="color:#3178c6">TS</span>',
    tsx: '<span class="ft-ext" style="color:#3178c6">TX</span>',
    jsx: '<span class="ft-ext" style="color:#61dafb">JX</span>',
    json: '<span class="ft-ext" style="color:#a8a8a8">{ }</span>',
    css: '<span class="ft-ext" style="color:#1572b6">CS</span>',
    scss: '<span class="ft-ext" style="color:#c6538c">SC</span>',
    html: '<span class="ft-ext" style="color:#e44d26">HT</span>',
    py: '<span class="ft-ext" style="color:#3776ab">PY</span>',
    lua: '<span class="ft-ext" style="color:#000080">LU</span>',
    md: '<span class="ft-ext" style="color:#888">MD</span>',
    yaml: '<span class="ft-ext" style="color:#cb171e">YM</span>',
    yml: '<span class="ft-ext" style="color:#cb171e">YM</span>',
    sh: '<span class="ft-ext" style="color:#4eaa25">SH</span>',
    sql: '<span class="ft-ext" style="color:#e38c00">SQ</span>',
    rs: '<span class="ft-ext" style="color:#dea584">RS</span>',
    go: '<span class="ft-ext" style="color:#00add8">GO</span>',
    java: '<span class="ft-ext" style="color:#b07219">JV</span>',
    rb: '<span class="ft-ext" style="color:#cc342d">RB</span>',
  };
  const defaultFileIcon = '<span class="ft-ext" style="color:#888">&#9632;</span>';

  function getFileIcon(name) {
    const ext = name.split('.').pop()?.toLowerCase();
    return extIcons[ext] || defaultFileIcon;
  }

  const chevronSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';

  const rowsHtml = items.map(item => {
    const indent = item.depth > 0 ? `<span class="ft-indent" style="width:${item.depth * 18}px"></span>` : '';
    const toggle = item.isDir
      ? `<span class="ft-toggle">${chevronSvg}</span>`
      : '<span class="ft-toggle-placeholder"></span>';
    const icon = item.isDir
      ? '<span class="ft-icon">&#128194;</span>'
      : `<span class="ft-icon-ext">${getFileIcon(item.name)}</span>`;
    const nameClass = item.isDir ? 'ft-name folder' : 'ft-name';
    const metaHtml = item.meta ? `<span class="ft-meta">${escapeHtml(item.meta)}</span>` : '';

    return `<div class="ft-item">${indent}${toggle}${icon}<span class="${nameClass}">${escapeHtml(item.name)}</span>${metaHtml}</div>`;
  }).join('');

  return `<div class="chat-filetree">`
    + `<div class="chat-filetree-header"><span class="chat-filetree-label">`
    + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`
    + `File Tree</span></div>`
    + `<div class="chat-filetree-body">${rowsHtml}</div></div>`;
}


// ══════════════════════════════════════════════
// Terminal Output Renderer
// ══════════════════════════════════════════════

function renderTerminalBlock(code) {
  const lines = code.split('\n');
  let exitCode = null;
  let shell = 'bash';

  // Parse first line for metadata: "$ command" or "shell: bash" or "exit: 0"
  const metaLines = [];
  const bodyLines = [];
  for (const line of lines) {
    const exitMatch = line.match(/^exit:\s*(\d+)\s*$/i);
    const shellMatch = line.match(/^shell:\s*(.+)\s*$/i);
    if (exitMatch && bodyLines.length === 0) { exitCode = parseInt(exitMatch[1], 10); metaLines.push(line); continue; }
    if (shellMatch && bodyLines.length === 0) { shell = shellMatch[1].trim(); metaLines.push(line); continue; }
    bodyLines.push(line);
  }

  // Detect exit code from content if not explicit
  if (exitCode === null) {
    const hasError = bodyLines.some(l => /\b(error|fail|ERR!)\b/i.test(l) || l.trim().startsWith('FAIL'));
    exitCode = hasError ? 1 : 0;
  }

  const exitClass = exitCode === 0 ? 'exit-ok' : 'exit-err';

  const contentHtml = bodyLines.map(line => {
    const escaped = escapeHtml(line);
    // Prompt line: $ or >
    if (/^\s*\$\s/.test(line)) {
      const [, prompt, cmd] = line.match(/^(\s*\$\s)(.*)/) || [null, '$ ', line];
      return `<div><span class="term-prompt">${escapeHtml(prompt)}</span><span class="term-cmd">${escapeHtml(cmd)}</span></div>`;
    }
    if (/^\s*>\s/.test(line) && !/^\s*>\s*$/.test(line)) {
      const [, prompt, cmd] = line.match(/^(\s*>\s)(.*)/) || [null, '> ', line];
      return `<div><span class="term-prompt">${escapeHtml(prompt)}</span><span class="term-cmd">${escapeHtml(cmd)}</span></div>`;
    }
    // Error lines
    if (/\b(error|ERR!|FAIL|fatal|panic)\b/i.test(line)) {
      return `<div><span class="term-error">${escaped}</span></div>`;
    }
    // Warning lines
    if (/\b(warn|warning|WARN)\b/i.test(line)) {
      return `<div><span class="term-warn">${escaped}</span></div>`;
    }
    // Separator
    if (/^[-=]{3,}$/.test(line.trim())) {
      return '<span class="term-separator"></span>';
    }
    // Dim lines (comments, timestamps)
    if (/^\s*#/.test(line) || /^\s*\/\//.test(line)) {
      return `<div><span class="term-dim">${escaped}</span></div>`;
    }
    // Empty lines
    if (!line.trim()) return '<div>&nbsp;</div>';
    // Normal output
    return `<div><span class="term-output">${escaped}</span></div>`;
  }).join('');

  return `<div class="chat-terminal-block">`
    + `<div class="chat-terminal-header">`
    + `<span class="terminal-icon">&#10095;</span>`
    + `<span class="terminal-shell">${escapeHtml(shell)}</span>`
    + `<span class="terminal-exit ${exitClass}">exit ${exitCode}</span>`
    + `</div>`
    + `<div class="chat-terminal-body">${contentHtml}</div>`
    + `</div>`;
}


// ══════════════════════════════════════════════
// Timeline / Steps Renderer
// ══════════════════════════════════════════════

/**
 * ```timeline or ```steps
 * Format:
 *   title: My Title
 *   [x] Step done | Description
 *   [>] Step active | Description
 *   [ ] Step pending | Description
 */
function renderTimelineBlock(code) {
  const lines = code.split('\n');
  let title = '';
  const steps = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const titleMatch = trimmed.match(/^title:\s*(.+)/i);
    if (titleMatch) { title = titleMatch[1]; continue; }
    const stepMatch = trimmed.match(/^\[([x>\ ])\]\s*(.+)/i);
    if (stepMatch) {
      const status = stepMatch[1] === 'x' ? 'done' : stepMatch[1] === '>' ? 'active' : 'pending';
      const parts = stepMatch[2].split('|').map(s => s.trim());
      steps.push({ title: parts[0], desc: parts[1] || '', status });
    }
  }

  if (steps.length === 0) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const titleHtml = title
    ? `<div class="chat-timeline-header"><span class="chat-timeline-label">${escapeHtml(title)}</span></div>`
    : '';

  const badgeLabels = { done: 'Done', active: 'In Progress', pending: 'Pending' };
  const stepsHtml = steps.map((step, i) => {
    const lineEl = i < steps.length - 1 ? '<div class="tl-line"></div>' : '';
    const descHtml = step.desc ? `<div class="tl-desc">${escapeHtml(step.desc)}</div>` : '';
    return `<div class="tl-step ${step.status}">`
      + `<div class="tl-rail"><div class="tl-dot ${step.status}"></div>${lineEl}</div>`
      + `<div class="tl-content"><div class="tl-title">${escapeHtml(step.title)} <span class="tl-badge ${step.status}">${badgeLabels[step.status]}</span></div>${descHtml}</div>`
      + `</div>`;
  }).join('');

  return `<div class="chat-timeline">${titleHtml}<div class="chat-timeline-body">${stepsHtml}</div></div>`;
}


// ══════════════════════════════════════════════
// Comparison (Before/After) Renderer
// ══════════════════════════════════════════════

/**
 * ```compare
 * Format:
 *   title: Refactoring title
 *   --- before
 *   old code
 *   --- after
 *   new code
 */
function renderCompareBlock(code) {
  const lines = code.split('\n');
  let title = '';
  let beforeCode = '';
  let afterCode = '';
  let section = 'none';

  for (const line of lines) {
    const trimmed = line.trim();
    const titleMatch = trimmed.match(/^title:\s*(.+)/i);
    if (titleMatch && section === 'none') { title = titleMatch[1]; continue; }
    if (/^---\s*before\s*$/i.test(trimmed)) { section = 'before'; continue; }
    if (/^---\s*after\s*$/i.test(trimmed)) { section = 'after'; continue; }
    if (section === 'before') beforeCode += line + '\n';
    if (section === 'after') afterCode += line + '\n';
  }

  beforeCode = beforeCode.trimEnd();
  afterCode = afterCode.trimEnd();

  const titleHtml = title
    ? `<div class="chat-compare-header"><span class="chat-compare-label">${escapeHtml(title)}</span></div>`
    : '';

  const beforeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
  const afterIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';

  return `<div class="chat-compare">`
    + titleHtml
    + `<div class="chat-compare-body">`
    + `<div class="chat-compare-side before"><div class="chat-compare-side-header">${beforeIcon} Before</div><div class="chat-compare-code"><pre><code>${escapeHtml(beforeCode)}</code></pre></div></div>`
    + `<div class="chat-compare-side after"><div class="chat-compare-side-header">${afterIcon} After</div><div class="chat-compare-code"><pre><code>${escapeHtml(afterCode)}</code></pre></div></div>`
    + `</div></div>`;
}


// ══════════════════════════════════════════════
// Link Cards Renderer
// ══════════════════════════════════════════════

/**
 * ```links
 * Format: title | description | url (one per line)
 */
function renderLinksBlock(code) {
  const lines = code.split('\n').filter(l => l.trim());
  const cards = lines.map(line => {
    const parts = line.split('|').map(s => s.trim());
    if (!parts[0]) return null;
    return { title: parts[0], desc: parts[1] || '', url: parts[2] || parts[0] };
  }).filter(Boolean);

  if (cards.length === 0) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const linkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="20" height="20"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>';
  const extIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';

  return cards.map(card => {
    const href = card.url.startsWith('http') ? card.url : `https://${card.url}`;
    const displayUrl = card.url.replace(/^https?:\/\//, '');
    return `<a class="chat-link-card" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">`
      + `<div class="chat-link-card-icon">${linkIcon}</div>`
      + `<div class="chat-link-card-body">`
      + `<div class="chat-link-card-title">${escapeHtml(card.title)} ${extIcon}</div>`
      + (card.desc ? `<div class="chat-link-card-desc">${escapeHtml(card.desc)}</div>` : '')
      + `<div class="chat-link-card-url">${escapeHtml(displayUrl)}</div>`
      + `</div></a>`;
  }).join('');
}


// ══════════════════════════════════════════════
// Tabs Block Renderer
// ══════════════════════════════════════════════

/**
 * ```tabs
 * Format:
 *   --- Tab Name 1
 *   content
 *   --- Tab Name 2
 *   content
 */
function renderTabsBlock(code) {
  const lines = code.split('\n');
  const tabs = [];
  let currentTab = null;

  for (const line of lines) {
    const tabMatch = line.match(/^---\s*(.+?)\s*$/);
    if (tabMatch) {
      if (currentTab) tabs.push(currentTab);
      currentTab = { title: tabMatch[1], content: '' };
      continue;
    }
    if (currentTab) currentTab.content += line + '\n';
  }
  if (currentTab) tabs.push(currentTab);

  if (tabs.length === 0) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const id = 'tabs-' + Math.random().toString(36).slice(2, 8);

  const buttonsHtml = tabs.map((tab, i) =>
    `<button class="chat-tab-btn${i === 0 ? ' active' : ''}" data-tab-idx="${i}" data-tabs-id="${id}">${escapeHtml(tab.title)}</button>`
  ).join('');

  const panelsHtml = tabs.map((tab, i) => {
    const content = tab.content.trimEnd();
    const lang = tab.title.toLowerCase().replace(/[^a-z]/g, '');
    const highlighted = lang ? highlight(content, lang) : escapeHtml(content);
    return `<div class="chat-tab-panel${i === 0 ? ' active' : ''}" data-tab-idx="${i}" data-tabs-id="${id}"><pre><code>${highlighted}</code></pre></div>`;
  }).join('');

  return `<div class="chat-tabs-block" data-tabs-id="${id}">`
    + `<div class="chat-tabs-nav">${buttonsHtml}</div>`
    + panelsHtml
    + `</div>`;
}


// ══════════════════════════════════════════════
// Metric Cards Renderer
// ══════════════════════════════════════════════

/**
 * ```metrics
 * Format: label | value | trend | bar% | color (one per line)
 * Colors: success, danger, info, warning, accent
 */
function renderMetricsBlock(code) {
  const lines = code.split('\n').filter(l => l.trim());
  const metrics = lines.map(line => {
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 2) return null;
    return { label: parts[0], value: parts[1], trend: parts[2] || '', bar: parts[3] || '', color: parts[4] || 'accent' };
  }).filter(Boolean);

  if (metrics.length === 0) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const cardsHtml = metrics.map(m => {
    const trendClass = /^[+↑]/.test(m.trend) ? 'up' : /^[-↓]/.test(m.trend) ? 'down' : 'neutral';
    const trendHtml = m.trend ? `<div class="chat-metric-trend ${trendClass}">${escapeHtml(m.trend)}</div>` : '';
    const colorVar = m.color === 'accent' ? 'accent' : m.color;
    const barHtml = m.bar ? `<div class="chat-metric-bar"><div class="chat-metric-bar-fill" style="width:${escapeHtml(m.bar)};background:var(--${escapeHtml(colorVar)})"></div></div>` : '';
    return `<div class="chat-metric-card accent-${escapeHtml(m.color)}">`
      + `<div class="chat-metric-label">${escapeHtml(m.label)}</div>`
      + `<div class="chat-metric-value">${escapeHtml(m.value)}</div>`
      + trendHtml + barHtml
      + `</div>`;
  }).join('');

  return `<div class="chat-metrics-grid">${cardsHtml}</div>`;
}


// ══════════════════════════════════════════════
// API Endpoint Card Renderer
// ══════════════════════════════════════════════

/**
 * ```api or ```endpoint
 * Format:
 *   METHOD /path/{param}
 *   Description text
 *   ---params
 *   name | type | required | description
 *   ---responses
 *   200 | Description
 */
function renderApiBlock(code) {
  const lines = code.split('\n');
  let method = '', url = '', description = '';
  const params = [], responses = [];
  let section = 'desc';

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!method && /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+/i.test(trimmed)) {
      const m = trimmed.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(.+)/i);
      if (m) { method = m[1].toUpperCase(); url = m[2]; continue; }
    }
    if (/^---\s*params?/i.test(trimmed)) { section = 'params'; continue; }
    if (/^---\s*resp/i.test(trimmed)) { section = 'responses'; continue; }

    if (section === 'desc' && trimmed && method) {
      description += (description ? ' ' : '') + trimmed;
    } else if (section === 'params' && trimmed) {
      const parts = trimmed.split('|').map(s => s.trim());
      if (parts.length >= 2) params.push({ name: parts[0], type: parts[1], required: (parts[2] || '').toLowerCase() === 'required', desc: parts[3] || '' });
    } else if (section === 'responses' && trimmed) {
      const parts = trimmed.split('|').map(s => s.trim());
      if (parts.length >= 2) responses.push({ status: parts[0], desc: parts[1] });
    }
  }

  if (!method) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const urlHtml = escapeHtml(url).replace(/\{(\w+)\}/g, '<span class="url-param">{$1}</span>');
  const descHtml = description ? `<div class="chat-api-desc">${escapeHtml(description)}</div>` : '';

  const paramsHtml = params.length > 0 ? `<div class="chat-api-params"><div class="chat-api-params-title">Parameters</div>`
    + params.map(p => `<div class="chat-api-param">`
      + `<span class="chat-api-param-name">${escapeHtml(p.name)}</span>`
      + `<span class="chat-api-param-type">${escapeHtml(p.type)}</span>`
      + (p.required ? '<span class="chat-api-param-required">required</span>' : '')
      + (p.desc ? `<span class="chat-api-param-desc">\u2014 ${escapeHtml(p.desc)}</span>` : '')
      + `</div>`).join('') + `</div>` : '';

  const sClass = (s) => { const n = parseInt(s); return n >= 500 ? 's5xx' : n >= 400 ? 's4xx' : n >= 200 ? 's2xx' : ''; };
  const responsesHtml = responses.length > 0 ? `<div class="chat-api-responses"><div class="chat-api-params-title">Responses</div>`
    + responses.map(r => `<div class="chat-api-response-item"><span class="chat-api-status ${sClass(r.status)}">${escapeHtml(r.status)}</span>${escapeHtml(r.desc)}</div>`).join('') + `</div>` : '';

  return `<div class="chat-api-card"><div class="chat-api-header"><span class="chat-api-method ${method.toLowerCase()}">${escapeHtml(method)}</span><span class="chat-api-url">${urlHtml}</span></div>${descHtml}${paramsHtml}${responsesHtml}</div>`;
}


// ══════════════════════════════════════════════
// FiveM Resource Card Renderer
// ══════════════════════════════════════════════

/**
 * ```resource
 * Format: key: value (one per line)
 * Keys: name, version, description, status, type, author, scripts, deps, error
 */
function renderResourceBlock(code) {
  const props = {};
  for (const line of code.split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)/);
    if (m) props[m[1].toLowerCase()] = m[2].trim();
  }

  const name = props.name || 'unknown';
  const version = props.version || '';
  const desc = props.description || props.desc || '';
  const status = (props.status || 'stopped').toLowerCase();
  const type = props.type || '';
  const author = props.author || '';
  const scripts = props.scripts || '';
  const deps = props.deps || props.dependencies || '';
  const error = props.error || '';

  const iconClass = type.includes('client') ? 'client' : type.includes('server') ? 'server' : 'shared';
  const icon = iconClass === 'client' ? '\uD83D\uDCE6' : iconClass === 'server' ? '\uD83D\uDD0C' : '\u2699\uFE0F';

  const statusMap = {
    started: '<div class="chat-resource-status started"><span class="status-dot"></span>Started</div>',
    error: '<div class="chat-resource-status error"><span class="status-dot"></span>Error</div>',
  };
  const statusHtml = statusMap[status] || '<div class="chat-resource-status stopped"><span class="status-dot"></span>Stopped</div>';

  const versionHtml = version ? ` <span class="chat-resource-version">${escapeHtml(version)}</span>` : '';
  const descHtml = desc ? `<div class="chat-resource-desc">${escapeHtml(desc)}</div>` : '';

  const metaItems = [];
  if (type) {
    const tags = type.split(',').map(t => t.trim()).map(t =>
      `<span class="chat-resource-tag ${t}">${escapeHtml(t)}</span>`
    ).join(' ');
    metaItems.push(['Type', tags]);
  }
  if (author) metaItems.push(['Author', escapeHtml(author)]);
  if (scripts) metaItems.push(['Scripts', escapeHtml(scripts)]);
  if (error) metaItems.push(['Error', `<span style="color:var(--danger);font-size:11px">${escapeHtml(error)}</span>`]);

  const metaHtml = metaItems.length > 0
    ? `<div class="chat-resource-body">${metaItems.map(([label, val]) =>
      `<div class="chat-resource-meta"><span class="chat-resource-meta-label">${label}</span><span class="chat-resource-meta-value">${val}</span></div>`
    ).join('')}</div>` : '';

  const depsHtml = deps
    ? `<div class="chat-resource-deps"><span class="chat-resource-deps-label">Deps</span>`
      + deps.split(',').map(d => `<span class="chat-resource-dep">${escapeHtml(d.trim())}</span>`).join('') + `</div>`
    : '';

  return `<div class="chat-resource-card">`
    + `<div class="chat-resource-header">`
    + `<div class="chat-resource-icon ${iconClass}">${icon}</div>`
    + `<div class="chat-resource-info"><div class="chat-resource-name">${escapeHtml(name)}${versionHtml}</div>${descHtml}</div>`
    + statusHtml + `</div>`
    + metaHtml + depsHtml + `</div>`;
}


// ══════════════════════════════════════════════
// Event Flow Diagram Renderer
// ══════════════════════════════════════════════

/**
 * ```eventflow
 * Format:
 *   title: Event Flow — Action Name
 *   client | OpenInventory()
 *   client -> server | TriggerServerEvent("event")
 *   server | handler
 *   nui --> client | NUI Callback (dashed)
 */
function renderEventFlowBlock(code) {
  const lines = code.split('\n');
  let title = '';
  const steps = [];
  const participants = {
    client: { color: '#3b82f6', label: 'Client', cls: 'c' },
    server: { color: '#a855f7', label: 'Server', cls: 's' },
    nui: { color: '#22c55e', label: 'NUI', cls: 'n' },
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const titleMatch = trimmed.match(/^title:\s*(.+)/i);
    if (titleMatch) { title = titleMatch[1]; continue; }
    // Arrow: from -> to | label  or  from --> to | label (dashed)
    const arrowMatch = trimmed.match(/^(\w+)\s*(-->|->)\s*(\w+)\s*\|\s*(.+)/i);
    if (arrowMatch) {
      steps.push({ type: 'arrow', from: arrowMatch[1].toLowerCase(), dashed: arrowMatch[2] === '-->', to: arrowMatch[3].toLowerCase(), label: arrowMatch[4] });
      continue;
    }
    // Handler: participant | action
    const handlerMatch = trimmed.match(/^(\w+)\s*\|\s*(.+)/i);
    if (handlerMatch) {
      steps.push({ type: 'handler', participant: handlerMatch[1].toLowerCase(), label: handlerMatch[2] });
    }
  }

  if (steps.length === 0) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const titleHtml = title ? `<div class="chat-ef-title">${escapeHtml(title)}</div>` : '';

  const usedP = new Set();
  steps.forEach(s => {
    if (s.type === 'arrow') { usedP.add(s.from); usedP.add(s.to); }
    if (s.type === 'handler') usedP.add(s.participant);
  });
  const pList = ['client', 'server', 'nui'].filter(p => usedP.has(p));

  const headsHtml = pList.map(p => {
    const info = participants[p] || { cls: 'c', label: p };
    return `<span class="chat-ef-head ${info.cls}">${escapeHtml(info.label)}</span>`;
  }).join('');

  let stepNum = 0;
  const stepsHtml = steps.map(step => {
    if (step.type === 'handler') {
      const info = participants[step.participant] || { cls: 'c' };
      return `<div class="chat-ef-step handler"><span class="chat-ef-badge ${info.cls}">${escapeHtml(step.label)}</span></div>`;
    }
    stepNum++;
    const fromCls = (participants[step.from] || { cls: 'c' }).cls;
    const toCls = (participants[step.to] || { cls: 'c' }).cls;
    const fromLabel = (participants[step.from] || { label: step.from }).label;
    const toLabel = (participants[step.to] || { label: step.to }).label;
    const dashClass = step.dashed ? ' dashed' : '';
    return `<div class="chat-ef-step arrow${dashClass}">`
      + `<span class="chat-ef-num">${stepNum}</span>`
      + `<span class="chat-ef-from ${fromCls}">${escapeHtml(fromLabel)}</span>`
      + `<span class="chat-ef-arrow${dashClass}">\u2192</span>`
      + `<span class="chat-ef-to ${toCls}">${escapeHtml(toLabel)}</span>`
      + `<span class="chat-ef-label">${escapeHtml(step.label)}</span>`
      + `</div>`;
  }).join('');

  return `<div class="chat-event-flow">${titleHtml}<div class="chat-ef-heads">${headsHtml}</div><div class="chat-ef-body">${stepsHtml}</div></div>`;
}


// ══════════════════════════════════════════════
// Config / Convars Block Renderer
// ══════════════════════════════════════════════

/**
 * ```config or ```convars
 * Format:
 *   title: server.cfg — Convars
 *   icon: ⚙️
 *   key | value | type | description | badge
 */
function renderConfigBlock(code) {
  const lines = code.split('\n');
  let title = '', icon = '\u2699\uFE0F';
  const rows = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const titleMatch = trimmed.match(/^title:\s*(.+)/i);
    if (titleMatch) { title = titleMatch[1]; continue; }
    const iconMatch = trimmed.match(/^icon:\s*(.+)/i);
    if (iconMatch) { icon = iconMatch[1]; continue; }
    const parts = trimmed.split('|').map(s => s.trim());
    if (parts.length >= 2) {
      rows.push({ key: parts[0], value: parts[1], type: parts[2] || '', desc: parts[3] || '', badge: parts[4] || '' });
    }
  }

  if (rows.length === 0) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const headerHtml = title
    ? `<div class="chat-config-header"><span class="chat-config-header-icon">${escapeHtml(icon)}</span>${escapeHtml(title)}</div>`
    : '';

  const rowsHtml = rows.map(r => {
    const typeHtml = r.type ? `<span class="chat-config-type">${escapeHtml(r.type)}</span>` : '';
    const descHtml = r.desc ? `<span class="chat-config-desc">${escapeHtml(r.desc)}</span>` : '';
    const badgeHtml = r.badge ? `<span class="chat-config-badge ${escapeHtml(r.badge)}">${escapeHtml(r.badge)}</span>` : '';
    return `<div class="chat-config-row">`
      + `<span class="chat-config-key">${escapeHtml(r.key)}</span>`
      + `<span class="chat-config-value">${escapeHtml(r.value)}</span>`
      + typeHtml + descHtml + badgeHtml + `</div>`;
  }).join('');

  return `<div class="chat-config-block">${headerHtml}${rowsHtml}</div>`;
}


// ══════════════════════════════════════════════
// Game Command Reference Renderer
// ══════════════════════════════════════════════

/**
 * ```command or ```cmd
 * Format:
 *   /commandname
 *   permission: ace.permission
 *   description: What it does
 *   syntax: /cmd <required> [optional]
 *   ---params
 *   name | type | description
 *   ---examples
 *   /cmd arg | Description
 */
function renderCommandBlock(code) {
  const lines = code.split('\n');
  let cmdName = '', permission = '', description = '', syntax = '';
  const params = [], examples = [];
  let section = 'meta';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^---\s*params?/i.test(trimmed)) { section = 'params'; continue; }
    if (/^---\s*examples?/i.test(trimmed)) { section = 'examples'; continue; }

    if (section === 'meta') {
      if (trimmed.startsWith('/') && !cmdName) { cmdName = trimmed; continue; }
      const permMatch = trimmed.match(/^perm(?:ission)?:\s*(.+)/i);
      if (permMatch) { permission = permMatch[1]; continue; }
      const descMatch = trimmed.match(/^desc(?:ription)?:\s*(.+)/i);
      if (descMatch) { description = descMatch[1]; continue; }
      const synMatch = trimmed.match(/^syntax:\s*(.+)/i);
      if (synMatch) { syntax = synMatch[1]; continue; }
    } else if (section === 'params') {
      const parts = trimmed.split('|').map(s => s.trim());
      if (parts.length >= 2) params.push({ name: parts[0], type: parts[1], desc: parts[2] || '' });
    } else if (section === 'examples') {
      const parts = trimmed.split('|').map(s => s.trim());
      examples.push({ code: parts[0], desc: parts[1] || '' });
    }
  }

  if (!cmdName) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const cmdParts = cmdName.match(/^(\/?)(.+)/);
  const prefix = cmdParts ? cmdParts[1] : '/';
  const name = cmdParts ? cmdParts[2] : cmdName;

  const permHtml = permission
    ? `<span class="chat-gcmd-perm"><span class="chat-gcmd-perm-icon">\uD83D\uDD12</span>${escapeHtml(permission)}</span>`
    : '';
  const descHtml = description ? `<div class="chat-gcmd-desc">${escapeHtml(description)}</div>` : '';

  let syntaxHtml = '';
  if (syntax) {
    const colored = escapeHtml(syntax)
      .replace(/&lt;(\w[\w\s|]*)&gt;/g, '<span class="syn-required">&lt;$1&gt;</span>')
      .replace(/\[([^\]]+)\]/g, '<span class="syn-optional">[$1]</span>')
      .replace(/^(\/?\w+)/, '<span class="syn-cmd">$1</span>');
    syntaxHtml = `<div class="chat-gcmd-syntax">${colored}</div>`;
  }

  const paramsHtml = params.length > 0
    ? `<div class="chat-gcmd-params-title">Parameters</div>`
    + params.map(p => `<div class="chat-gcmd-param">`
      + `<span class="chat-gcmd-param-name">${escapeHtml(p.name)}</span>`
      + `<span class="chat-gcmd-param-type">${escapeHtml(p.type)}</span>`
      + (p.desc ? `<span class="chat-gcmd-param-desc">\u2014 ${escapeHtml(p.desc)}</span>` : '')
      + `</div>`).join('') : '';

  const examplesHtml = examples.length > 0
    ? `<div class="chat-gcmd-example"><div class="chat-gcmd-example-title">Examples</div>`
    + examples.map(ex =>
      `<div class="chat-gcmd-example-code">${escapeHtml(ex.code)}</div>`
      + (ex.desc ? `<div class="chat-gcmd-example-desc">${escapeHtml(ex.desc)}</div>` : '')
    ).join('') + `</div>` : '';

  return `<div class="chat-gcmd-card">`
    + `<div class="chat-gcmd-header"><span class="chat-gcmd-name"><span class="cmd-prefix">${escapeHtml(prefix)}</span>${escapeHtml(name)}</span>${permHtml}</div>`
    + `<div class="chat-gcmd-body">${descHtml}${syntaxHtml}${paramsHtml}${examplesHtml}</div>`
    + `</div>`;
}


// ══════════════════════════════════════════════
// Details / Spoiler HTML handler
// ══════════════════════════════════════════════

function renderDetailsHtml(tag) {
  if (/^<details/i.test(tag)) {
    return `<div class="chat-details">`;
  }
  if (/^<\/details>/i.test(tag)) {
    return `</div></div>`;
  }
  if (/^<summary/i.test(tag)) {
    // Extract summary text if inline: <summary>Title</summary>
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


// ══════════════════════════════════════════════
// SVG Sanitization
// ══════════════════════════════════════════════

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


// ══════════════════════════════════════════════
// Public API
// ══════════════════════════════════════════════

/**
 * Render markdown text to HTML (full render).
 * Used for finalized messages and history replay.
 */
function render(text) {
  if (!text) return '';
  configure();
  try {
    return marked.parse(text);
  } catch (err) {
    console.error('[MarkdownRenderer] Render failed:', err.message);
    return `<pre class="chat-markdown-fallback">${escapeHtml(text)}</pre>`;
  }
}

/**
 * Render inline markdown (no block wrappers).
 */
function renderInline(text) {
  if (!text) return '';
  configure();
  try {
    return marked.parseInline(text);
  } catch {
    return escapeHtml(text);
  }
}

// ══════════════════════════════════════════════
// Incremental Streaming Renderer
// ══════════════════════════════════════════════

/**
 * Create a stream cache for incremental rendering.
 * One cache per streaming message.
 */
function createStreamCache() {
  return { stableEl: null, activeEl: null, stableText: '', initialized: false };
}

/**
 * Render incrementally: only re-render the last (incomplete) block.
 * Previous blocks stay in DOM untouched for performance.
 * @param {string} text - Full accumulated markdown text
 * @param {HTMLElement} container - The .chat-msg-content element
 * @param {object} cache - Stream cache from createStreamCache()
 */
function renderIncremental(text, container, cache) {
  configure();

  // Initialize container with stable + active elements
  if (!cache.initialized) {
    cache.stableEl = document.createElement('div');
    cache.stableEl.className = 'stream-stable';
    cache.activeEl = document.createElement('div');
    cache.activeEl.className = 'stream-active';
    container.innerHTML = '';
    container.appendChild(cache.stableEl);
    container.appendChild(cache.activeEl);
    cache.initialized = true;
    cache.stableText = '';
  }

  // Find the boundary between "stable" (complete) blocks and the "active" (last) block
  const splitIdx = findStableBlockBoundary(text);
  const stableText = splitIdx > 0 ? text.substring(0, splitIdx) : '';
  const activeText = splitIdx > 0 ? text.substring(splitIdx) : text;

  // Only re-render stable portion when new blocks complete
  if (stableText && stableText !== cache.stableText) {
    cache.stableText = stableText;
    try {
      cache.stableEl.innerHTML = marked.parse(stableText);
    } catch {
      cache.stableEl.innerHTML = `<pre>${escapeHtml(stableText)}</pre>`;
    }
  }

  // Always re-render the active (last) block + cursor
  try {
    cache.activeEl.innerHTML = (activeText ? marked.parse(activeText) : '') + '<span class="chat-cursor"></span>';
  } catch {
    cache.activeEl.innerHTML = `<pre>${escapeHtml(activeText)}</pre><span class="chat-cursor"></span>`;
  }
}

/**
 * Find the last "block boundary" in text — a double-newline NOT inside a fenced code block.
 * Returns the character index after the boundary, or -1 if none found.
 */
function findStableBlockBoundary(text) {
  let inCodeBlock = false;
  let lastBoundary = -1;
  const len = text.length;

  for (let i = 0; i < len - 1; i++) {
    // Track fenced code blocks (```)
    if (i + 2 < len && text[i] === '`' && text[i + 1] === '`' && text[i + 2] === '`') {
      if (!inCodeBlock) {
        inCodeBlock = true;
        // Skip to end of opening fence line
        while (i < len && text[i] !== '\n') i++;
      } else {
        inCodeBlock = false;
        // Skip to end of closing fence line
        while (i < len && text[i] !== '\n') i++;
      }
      continue;
    }

    // Track double-newlines outside code blocks
    if (!inCodeBlock && text[i] === '\n' && text[i + 1] === '\n') {
      lastBoundary = i + 2;
    }
  }

  return lastBoundary;
}


// ══════════════════════════════════════════════
// DOM Event Delegation (post-render interactivity)
// ══════════════════════════════════════════════

/**
 * Attach event listeners to a container for interactive blocks.
 * Should be called once on the chat messages container.
 */
function attachInteractivity(container) {
  container.addEventListener('click', (e) => {
    const target = e.target.closest('[class]');
    if (!target) return;

    // ── Copy button ──
    if (target.classList.contains('chat-code-copy')) {
      handleCopyClick(target);
      return;
    }

    // ── Collapse/expand code ──
    if (target.classList.contains('chat-code-collapse-btn')) {
      handleCollapseToggle(target);
      return;
    }

    // ── Line numbers toggle ──
    if (target.classList.contains('chat-code-line-toggle')) {
      handleLineNumbersToggle(target);
      return;
    }

    // ── Table sort ──
    if (target.closest('th.sortable')) {
      handleTableSort(target.closest('th.sortable'));
      return;
    }

    // ── Preview toolbar ──
    if (target.classList.contains('chat-preview-btn')) {
      handlePreviewAction(target);
      return;
    }

    // ── Details/Spoiler toggle ──
    if (target.closest('.chat-details-summary')) {
      const details = target.closest('.chat-details');
      if (details) details.classList.toggle('open');
      return;
    }

    // ── Tab switching ──
    if (target.classList.contains('chat-tab-btn')) {
      const idx = target.dataset.tabIdx;
      const block = target.closest('.chat-tabs-block');
      if (block) {
        block.querySelectorAll('.chat-tab-btn').forEach(b => b.classList.remove('active'));
        block.querySelectorAll('.chat-tab-panel').forEach(p => p.classList.remove('active'));
        target.classList.add('active');
        const panel = block.querySelector(`.chat-tab-panel[data-tab-idx="${idx}"]`);
        if (panel) panel.classList.add('active');
      }
      return;
    }

    // ── File tree folder toggle ──
    if (target.closest('.ft-toggle')) {
      const toggle = target.closest('.ft-toggle');
      toggle.classList.toggle('collapsed');
      // Toggle next sibling ft-children
      const item = toggle.closest('.ft-item');
      if (item) {
        const next = item.nextElementSibling;
        if (next && next.classList.contains('ft-children')) {
          next.classList.toggle('hidden');
        }
      }
      return;
    }
  });

  // ── Table search ──
  container.addEventListener('input', (e) => {
    if (e.target.classList.contains('chat-table-search')) {
      handleTableSearch(e.target);
    }
  });

  // ── Preview resize handle ──
  container.addEventListener('mousedown', (e) => {
    if (!e.target.classList.contains('chat-preview-resize')) return;
    const resizeEl = e.target;
    const previewContainer = resizeEl.closest('.chat-preview-container');
    if (!previewContainer) return;
    const iframe = previewContainer.querySelector('.chat-preview-iframe');
    if (!iframe) return;

    const startY = e.clientY;
    const startH = iframe.offsetHeight;

    const onMove = (ev) => {
      const newH = Math.max(100, startH + (ev.clientY - startY));
      iframe.style.height = newH + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}

function handleCopyClick(btn) {
  const block = btn.closest('.chat-code-block') || btn.closest('.chat-diff-block');
  if (!block) return;
  const code = block.querySelector('pre code, pre.diff-pre');
  if (!code) return;
  const text = code.textContent;
  navigator.clipboard.writeText(text).then(() => {
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  });
}

function handleCollapseToggle(btn) {
  const block = btn.closest('.chat-code-block');
  if (!block) return;
  const isCollapsed = block.classList.contains('collapsed');
  block.classList.toggle('collapsed');
  const lineCount = parseInt(btn.dataset.lines, 10);
  btn.textContent = isCollapsed
    ? (t('chat.code.showLess') || 'Show less')
    : (t('chat.code.showMore', { count: lineCount - COLLAPSE_THRESHOLD }) || `Show ${lineCount - COLLAPSE_THRESHOLD} more lines`);
}

function handleLineNumbersToggle(btn) {
  const block = btn.closest('.chat-code-block');
  if (!block) return;
  const code = block.querySelector('code');
  if (!code) return;
  code.classList.toggle('line-numbers-off');
  code.classList.toggle('line-numbers-on');
}

function handleTableSort(th) {
  const table = th.closest('table');
  if (!table) return;
  const idx = parseInt(th.dataset.colIdx, 10);
  const tbody = table.querySelector('tbody');
  const rows = Array.from(tbody.querySelectorAll('tr'));

  // Determine sort direction
  const currentDir = th.dataset.sortDir || 'none';
  const newDir = currentDir === 'asc' ? 'desc' : 'asc';

  // Reset all headers
  table.querySelectorAll('th').forEach(h => { h.dataset.sortDir = 'none'; h.classList.remove('sort-asc', 'sort-desc'); });
  th.dataset.sortDir = newDir;
  th.classList.add(newDir === 'asc' ? 'sort-asc' : 'sort-desc');

  // Sort rows
  rows.sort((a, b) => {
    const aText = (a.cells[idx]?.textContent || '').trim();
    const bText = (b.cells[idx]?.textContent || '').trim();
    const aNum = parseFloat(aText);
    const bNum = parseFloat(bText);
    if (!isNaN(aNum) && !isNaN(bNum)) {
      return newDir === 'asc' ? aNum - bNum : bNum - aNum;
    }
    return newDir === 'asc' ? aText.localeCompare(bText) : bText.localeCompare(aText);
  });

  rows.forEach(row => tbody.appendChild(row));
}

let _searchDebounce = null;
function handleTableSearch(input) {
  clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(() => {
    const container = input.closest('.chat-table-container');
    if (!container) return;
    const query = input.value.toLowerCase().trim();
    const rows = container.querySelectorAll('tbody tr');
    rows.forEach(row => {
      const text = row.textContent.toLowerCase();
      row.style.display = query && !text.includes(query) ? 'none' : '';
    });
  }, 200);
}

function handlePreviewAction(btn) {
  const container = btn.closest('.chat-preview-container');
  if (!container) return;
  const action = btn.dataset.action;

  // Toggle preview/code
  if (action === 'preview' || action === 'code') {
    const iframeWrap = container.querySelector('.chat-preview-iframe-wrap');
    const codeWrap = container.querySelector('.chat-preview-code-wrap');
    container.querySelectorAll('.chat-preview-btn[data-action="preview"], .chat-preview-btn[data-action="code"]')
      .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (action === 'preview') {
      iframeWrap.style.display = '';
      codeWrap.style.display = 'none';
      // Initialize iframe if not done yet
      initializePreviewIframe(container);
    } else {
      iframeWrap.style.display = 'none';
      codeWrap.style.display = '';
    }
    return;
  }

  // Viewport switching
  if (action?.startsWith('viewport-')) {
    const viewport = action.replace('viewport-', '');
    container.classList.remove('viewport-desktop', 'viewport-tablet', 'viewport-mobile');
    if (viewport !== 'desktop') {
      container.classList.add(`viewport-${viewport}`);
    }
    return;
  }
}

/**
 * Initialize iframe preview with sandboxed content.
 */
function initializePreviewIframe(container) {
  const iframe = container.querySelector('.chat-preview-iframe');
  if (!iframe || iframe.dataset.initialized) return;
  iframe.dataset.initialized = 'true';

  const sourceEl = container.querySelector('.chat-preview-source');
  if (!sourceEl) return;
  const code = sourceEl.textContent;

  // Build complete HTML document
  let html;
  if (code.includes('<html') || code.includes('<body')) {
    html = code;
  } else {
    html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;padding:16px;background:#1a1a1a;color:#e0e0e0;font-family:system-ui,sans-serif;}</style></head><body>${code}</body></html>`;
  }

  // Use srcdoc for Electron compatibility (blob URLs blocked by sandbox)
  iframe.srcdoc = html;
}

/**
 * Post-render processing: initialize special blocks in a container.
 * Call after inserting rendered HTML into the DOM.
 * Uses IntersectionObserver for off-screen blocks (lazy rendering).
 */
function postProcess(container) {
  // Collect all special blocks
  const previews = container.querySelectorAll('.chat-preview-container');
  const mermaidBlocks = container.querySelectorAll('.chat-mermaid-block');
  const mathBlocks = container.querySelectorAll('.chat-math-block');
  const inlineMathEls = container.querySelectorAll('.chat-math-inline[data-math-source]');

  // Render inline math with KaTeX
  if (inlineMathEls.length > 0) {
    initInlineMath(inlineMathEls);
  }

  // If few blocks, initialize immediately
  const totalSpecial = previews.length + mermaidBlocks.length + mathBlocks.length;
  if (totalSpecial <= 3 || typeof IntersectionObserver === 'undefined') {
    previews.forEach(initializePreviewIframe);
    if (mermaidBlocks.length > 0) initMermaidBlocks(mermaidBlocks);
    if (mathBlocks.length > 0) initMathBlocks(mathBlocks);
    return;
  }

  // Use IntersectionObserver for lazy initialization of many blocks
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      observer.unobserve(el);

      if (el.classList.contains('chat-preview-container')) {
        initializePreviewIframe(el);
      } else if (el.classList.contains('chat-mermaid-block')) {
        initMermaidBlocks([el]);
      } else if (el.classList.contains('chat-math-block')) {
        initMathBlocks([el]);
      }
    });
  }, { rootMargin: '200px' }); // Pre-load 200px before visible

  previews.forEach(el => observer.observe(el));
  mermaidBlocks.forEach(el => observer.observe(el));
  mathBlocks.forEach(el => observer.observe(el));
}

// ── Lazy-loaded Mermaid ──
let _mermaidPromise = null;
function initMermaidBlocks(blocks) {
  if (!_mermaidPromise) {
    _mermaidPromise = loadMermaid();
  }
  _mermaidPromise.then(mermaid => {
    if (!mermaid) return;
    blocks.forEach(async block => {
      if (block.dataset.rendered) return;
      block.dataset.rendered = 'true';
      const source = block.querySelector('.chat-mermaid-source')?.textContent;
      if (!source) return;
      const loading = block.querySelector('.chat-mermaid-loading');
      const render = block.querySelector('.chat-mermaid-render');
      const error = block.querySelector('.chat-mermaid-error');
      try {
        const { svg } = await mermaid.render(block.dataset.mermaidId, source);
        render.innerHTML = svg;
        if (loading) loading.style.display = 'none';
      } catch (err) {
        if (loading) loading.style.display = 'none';
        if (error) {
          error.style.display = '';
          error.textContent = t('chat.mermaid.error') || 'Diagram render failed';
        }
        // Show source as fallback
        render.innerHTML = `<pre><code>${escapeHtml(source)}</code></pre>`;
      }
    });
  });
}

async function loadMermaid() {
  try {
    // Mermaid is ESM-only, must use dynamic import
    const mod = await import('mermaid');
    const mermaid = mod.default;
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      themeVariables: {
        darkMode: true,
        background: '#151515',
        primaryColor: '#d97706',
        primaryTextColor: '#e0e0e0',
        lineColor: '#555',
        secondaryColor: '#1a1a1a',
        tertiaryColor: '#252525',
      },
      securityLevel: 'strict',
    });
    return mermaid;
  } catch (err) {
    console.warn('[MarkdownRenderer] Mermaid not available:', err.message);
    return null;
  }
}

// ── Lazy-loaded KaTeX ──
let _katexPromise = null;
function initMathBlocks(blocks) {
  if (!_katexPromise) {
    _katexPromise = loadKatex();
  }
  _katexPromise.then(katex => {
    if (!katex) return;
    blocks.forEach(block => {
      if (block.dataset.rendered) return;
      block.dataset.rendered = 'true';
      const source = block.dataset.mathSource;
      if (!source) return;
      const loading = block.querySelector('.chat-math-loading');
      const render = block.querySelector('.chat-math-render');
      try {
        render.innerHTML = katex.renderToString(source, {
          displayMode: true,
          throwOnError: false,
        });
        if (loading) loading.style.display = 'none';
      } catch {
        if (loading) loading.textContent = t('chat.math.error') || 'Math render failed';
      }
    });
  });
}

async function loadKatex() {
  try {
    return require('katex');
  } catch {
    console.warn('[MarkdownRenderer] KaTeX not available');
    return null;
  }
}

function initInlineMath(elements) {
  if (!_katexPromise) {
    _katexPromise = loadKatex();
  }
  _katexPromise.then(katex => {
    if (!katex) return;
    elements.forEach(el => {
      if (el.dataset.rendered) return;
      el.dataset.rendered = 'true';
      const source = el.dataset.mathSource;
      if (!source) return;
      try {
        el.innerHTML = katex.renderToString(source, {
          displayMode: false,
          throwOnError: false,
        });
      } catch {
        // Keep plain text fallback
      }
    });
  });
}


module.exports = {
  render,
  renderInline,
  configure,
  attachInteractivity,
  postProcess,
  createStreamCache,
  renderIncremental,
};
