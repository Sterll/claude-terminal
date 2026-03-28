/**
 * MarkdownRenderer test suite
 * Tests custom block rendering, DOMPurify sanitization, streaming, and error handling.
 */

// Mock i18n
jest.mock('../../src/renderer/i18n', () => ({
  t: (key, params) => {
    const translations = {
      'chat.code.showMore': `Show ${params?.count || 0} more lines`,
      'chat.code.showLess': 'Show less',
      'chat.code.lineNumbers': 'Toggle line numbers',
      'common.copy': 'Copy',
      'chat.table.search': 'Search table...',
      'chat.callout.note': 'Note',
      'chat.callout.tip': 'Tip',
      'chat.callout.important': 'Important',
      'chat.callout.warning': 'Warning',
      'chat.callout.caution': 'Caution',
      'chat.preview.title': 'Preview',
      'chat.preview.code': 'Code',
      'chat.preview.desktop': 'Desktop',
      'chat.preview.tablet': 'Tablet',
      'chat.preview.mobile': 'Mobile',
      'chat.mermaid.loading': 'Rendering diagram...',
      'chat.mermaid.error': 'Diagram render failed',
      'chat.mermaid.showSource': 'Show source',
      'chat.math.loading': 'Rendering math...',
      'chat.math.error': 'Math render failed',
    };
    return translations[key] || key;
  }
}));

// Mock DiscordRenderer
jest.mock('../../src/renderer/ui/discord/DiscordRenderer', () => ({
  autoRender: jest.fn(() => ({ html: '<div class="dc-embed">mock embed</div>' })),
  renderComponents: jest.fn(() => '<div class="dc-components">mock components</div>'),
  renderMessage: jest.fn(() => '<div class="dc-message">mock message</div>'),
}));

// Mock marked (ESM-only module, must be mocked for Jest/CJS)
jest.mock('marked', () => {
  const rendererOverrides = {};
  const extensionList = [];

  class Renderer {}

  // Minimal parser context passed as `this` to renderer methods
  function makeContext() {
    return {
      parser: {
        parse: (tokens) => {
          if (typeof tokens === 'string') return tokens;
          if (Array.isArray(tokens)) return tokens.map(t => t.raw || t.text || '').join('');
          return '';
        },
        parseInline: (tokens) => {
          if (typeof tokens === 'string') return tokens;
          if (Array.isArray(tokens)) return tokens.map(t => t.raw || t.text || '').join('');
          return '';
        }
      }
    };
  }

  const marked = {
    Renderer,
    use: jest.fn(function (...configs) {
      for (const config of configs) {
        if (config.renderer) {
          Object.assign(rendererOverrides, config.renderer);
        }
        if (config.extensions) {
          extensionList.push(...config.extensions);
        }
      }
    }),
    parse: jest.fn(function (text) {
      if (!text) return '';
      const ctx = makeContext();
      let html = text;

      // 1. Code blocks: ```lang\ncontent\n```
      html = html.replace(/```(\S*)\n([\s\S]*?)\n```/g, (_, lang, code) => {
        if (rendererOverrides.code) {
          return rendererOverrides.code.call(ctx, { text: code, lang: lang || '', escaped: false });
        }
        return `<pre><code>${code}</code></pre>`;
      });

      // 2. Tables: | H1 | H2 |\n|---|---|\n| A | B |
      html = html.replace(/^\|(.+)\|\s*\n\|([-| :]+)\|\s*\n((?:\|.+\|\s*\n?)+)/gm, (match, headerLine, sepLine, bodyLines) => {
        const headers = headerLine.split('|').map(h => h.trim()).filter(Boolean);
        const rows = bodyLines.trim().split('\n').map(row =>
          row.split('|').map(c => c.trim()).filter(Boolean)
        );
        if (rendererOverrides.table) {
          return rendererOverrides.table.call(ctx, {
            header: headers.map(h => ({ text: h, align: '' })),
            rows: rows.map(row => row.map(cell => ({ text: cell, align: '' })))
          });
        }
        return `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      });

      // 3. Blockquotes (multi-line > prefixed)
      html = html.replace(/((?:^> ?.*(?:\n|$))+)/gm, (match) => {
        const inner = match.replace(/^> ?/gm, '').trim();
        if (rendererOverrides.blockquote) {
          return rendererOverrides.blockquote.call(ctx, { text: inner, tokens: null });
        }
        return `<blockquote><p>${inner}</p></blockquote>`;
      });

      // 4. Headings
      html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
      html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');

      // 5. Bold + italic
      html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');

      // 6. Inline math via extensions ($...$)
      for (const ext of extensionList) {
        if (ext.name === 'inlineMath' && ext.renderer) {
          html = html.replace(/\$([^\$\n]+?)\$/g, (_, math) => {
            return ext.renderer({ raw: `$${math}$`, text: math.trim() });
          });
        }
      }

      // 7. Inline code
      html = html.replace(/`([^`]+)`/g, (_, code) => {
        if (rendererOverrides.codespan) {
          return rendererOverrides.codespan.call(ctx, { text: code });
        }
        return `<code>${code}</code>`;
      });

      // 8. Links
      html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, href) => {
        if (rendererOverrides.link) {
          return rendererOverrides.link.call(ctx, { href, tokens: null, text: linkText });
        }
        return `<a href="${href}">${linkText}</a>`;
      });

      // 9. Lists
      html = html.replace(/((?:^- .+\n?)+)/gm, (match) => {
        const items = match.trim().split('\n').map(l => `<li>${l.slice(2)}</li>`).join('');
        return `<ul>${items}</ul>`;
      });

      // 10. Wrap bare text in <p>
      html = html.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('<')) return line;
        if (rendererOverrides.paragraph) {
          return rendererOverrides.paragraph.call(ctx, { tokens: trimmed, text: trimmed });
        }
        return `<p>${trimmed}</p>`;
      }).join('\n');

      return html;
    }),
    parseInline: jest.fn(function (textOrTokens) {
      if (typeof textOrTokens === 'string') {
        let html = textOrTokens;
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        return html;
      }
      if (Array.isArray(textOrTokens)) {
        return textOrTokens.map(t => t.raw || t.text || '').join('');
      }
      return String(textOrTokens || '');
    }),
  };

  return { marked };
});

const MR = require('../../src/renderer/services/MarkdownRenderer');

describe('MarkdownRenderer', () => {

  // ── Basic rendering ──

  describe('render() basics', () => {
    test('renders paragraphs', () => {
      const html = MR.render('Hello world');
      expect(html).toContain('<p>');
      expect(html).toContain('Hello world');
    });

    test('renders headings', () => {
      const html = MR.render('# Title');
      expect(html).toContain('<h1>');
      expect(html).toContain('Title');
    });

    test('renders bold and italic', () => {
      const html = MR.render('**bold** *italic*');
      expect(html).toContain('<strong>bold</strong>');
      expect(html).toContain('<em>italic</em>');
    });

    test('returns empty string for null/undefined/empty', () => {
      expect(MR.render(null)).toBe('');
      expect(MR.render(undefined)).toBe('');
      expect(MR.render('')).toBe('');
    });

    test('renders lists', () => {
      const html = MR.render('- item 1\n- item 2');
      expect(html).toContain('<ul>');
      expect(html).toContain('<li>');
    });
  });

  // ── Code blocks ──

  describe('code blocks', () => {
    test('standard code block with language', () => {
      const html = MR.render('```js\nconst x = 1;\n```');
      expect(html).toContain('chat-code-block');
      expect(html).toContain('chat-code-lang');
    });

    test('code block with filename (lang:filename pattern)', () => {
      const html = MR.render('```js:app.js\nconst x = 1;\n```');
      expect(html).toContain('chat-code-filename');
      expect(html).toContain('app.js');
    });

    test('collapsible code block (>30 lines)', () => {
      const lines = Array(35).fill('line').join('\n');
      const html = MR.render('```js\n' + lines + '\n```');
      expect(html).toContain('collapsible');
      expect(html).toContain('chat-code-collapse-btn');
    });

    test('non-collapsible short code block', () => {
      const html = MR.render('```js\nconst x = 1;\n```');
      expect(html).not.toContain('collapsible');
    });

    test('code block without language defaults to text', () => {
      const html = MR.render('```\nsome text\n```');
      expect(html).toContain('text');
    });

    test('diff block', () => {
      const html = MR.render('```diff\n+added\n-removed\n context\n```');
      expect(html).toContain('chat-diff-block');
      expect(html).toContain('diff-add');
      expect(html).toContain('diff-del');
    });
  });

  // ── Special blocks (placeholders) ──

  describe('special blocks', () => {
    test('mermaid block placeholder', () => {
      const html = MR.render('```mermaid\ngraph TD\n  A-->B\n```');
      expect(html).toContain('chat-mermaid-block');
      expect(html).toContain('data-mermaid-id');
      expect(html).toContain('chat-mermaid-source');
    });

    test('math block placeholder', () => {
      const html = MR.render('```math\nE = mc^2\n```');
      expect(html).toContain('chat-math-block');
      expect(html).toContain('data-math-source');
    });

    test('SVG block sanitizes dangerous elements', () => {
      const svg = '<svg><script>alert("xss")</script><circle cx="10" cy="10" r="5"/></svg>';
      const html = MR.render('```svg\n' + svg + '\n```');
      expect(html).toContain('chat-svg-block');
      expect(html).not.toContain('<script>');
    });

    test('HTML preview block', () => {
      const html = MR.render('```html\n<h1>Hello</h1>\n```');
      expect(html).toContain('chat-preview-container');
    });
  });

  // ── Layout blocks ──

  describe('layout blocks', () => {
    test('file tree', () => {
      const html = MR.render('```tree\nsrc/\n    index.js\n    utils/\n        helper.js\n```');
      expect(html).toContain('chat-filetree');
      expect(html).toContain('ft-item');
    });

    test('terminal block with success', () => {
      const html = MR.render('```terminal\n$ npm test\nPASS all tests\n```');
      expect(html).toContain('chat-terminal-block');
      expect(html).toContain('term-prompt');
      expect(html).toContain('exit-ok');
    });

    test('terminal block with error detection', () => {
      const html = MR.render('```terminal\n$ npm test\nFAIL something went wrong\n```');
      expect(html).toContain('exit-err');
    });

    test('timeline block', () => {
      const html = MR.render('```timeline\ntitle: Steps\n[x] Done | desc\n[>] Active | desc\n[ ] Pending\n```');
      expect(html).toContain('chat-timeline');
      expect(html).toContain('tl-step');
    });

    test('compare block', () => {
      const html = MR.render('```compare\ntitle: Refactor\n--- before\nold code\n--- after\nnew code\n```');
      expect(html).toContain('chat-compare');
      expect(html).toContain('Before');
      expect(html).toContain('After');
    });

    test('tabs block', () => {
      const html = MR.render('```tabs\n--- Tab A\ncontent A\n--- Tab B\ncontent B\n```');
      expect(html).toContain('chat-tabs-block');
      expect(html).toContain('chat-tab-btn');
      expect(html).toContain('Tab A');
    });

    test('eventflow block', () => {
      const html = MR.render('```eventflow\ntitle: Auth\nclient -> server | Login\n```');
      expect(html).toContain('chat-event-flow');
    });
  });

  // ── Data blocks ──

  describe('data blocks', () => {
    test('metrics block', () => {
      const html = MR.render('```metrics\nUsers | 1500 | +12%\n```');
      expect(html).toContain('chat-metrics-grid');
      expect(html).toContain('chat-metric-card');
    });

    test('API block', () => {
      const html = MR.render('```api\nGET /users/{id}\nFetch user\n---params\nid | string | required | User ID\n---responses\n200 | OK\n```');
      expect(html).toContain('chat-api-card');
      expect(html).toContain('chat-api-method');
      expect(html).toContain('GET');
    });

    test('config block', () => {
      const html = MR.render('```config\ntitle: Config\nport | 3000 | number | Port\n```');
      expect(html).toContain('chat-config-block');
    });

    test('links block', () => {
      const html = MR.render('```links\nGoogle | Search engine | https://google.com\n```');
      expect(html).toContain('chat-link-card');
      expect(html).toContain('https://google.com');
    });

    test('command block', () => {
      const html = MR.render('```command\n/teleport\ndescription: Teleport player\n```');
      expect(html).toContain('chat-gcmd-card');
    });
  });

  // ── Discord blocks ──

  describe('discord blocks', () => {
    test('discord embed block', () => {
      const html = MR.render('```discord-embed\n{"title":"Test"}\n```');
      expect(html).toContain('dc-chat-preview');
      expect(html).toContain('Discord Embed');
    });

    test('discord component block', () => {
      const html = MR.render('```discord-component\n[{"type":1}]\n```');
      expect(html).toContain('dc-chat-preview');
      expect(html).toContain('Discord Components');
    });

    test('discord message block', () => {
      const html = MR.render('```discord-message\n{"content":"Hi"}\n```');
      expect(html).toContain('dc-chat-preview');
      expect(html).toContain('Discord Message');
    });
  });

  // ── Callouts ──

  describe('callouts', () => {
    test('renders NOTE callout', () => {
      const html = MR.render('> [!NOTE]\n> This is a note');
      expect(html).toContain('chat-callout');
      expect(html).toContain('chat-callout-note');
    });

    test('renders WARNING callout', () => {
      const html = MR.render('> [!WARNING]\n> Danger zone');
      expect(html).toContain('chat-callout-warning');
    });

    test('renders TIP callout', () => {
      const html = MR.render('> [!TIP]\n> Useful hint');
      expect(html).toContain('chat-callout-tip');
    });

    test('regular blockquote without callout', () => {
      const html = MR.render('> Just a quote');
      expect(html).toContain('<blockquote>');
      expect(html).not.toContain('chat-callout');
    });
  });

  // ── Inline elements ──

  describe('inline elements', () => {
    test('keyboard shortcut detection', () => {
      const html = MR.render('Press `Ctrl+C` to copy');
      expect(html).toContain('chat-kbd-group');
      expect(html).toContain('<kbd>');
    });

    test('hex color detection', () => {
      const html = MR.render('Color: `#d97706`');
      expect(html).toContain('chat-color-swatch');
      expect(html).toContain('chat-color-dot');
    });

    test('regular inline code', () => {
      const html = MR.render('Use `myFunction()`');
      expect(html).toContain('chat-inline-code');
    });

    test('inline math', () => {
      const html = MR.render('The formula $E = mc^2$ is famous');
      expect(html).toContain('chat-math-inline');
      expect(html).toContain('data-math-source');
    });
  });

  // ── Tables ──

  describe('tables', () => {
    test('sortable table headers', () => {
      const html = MR.render('| Name | Age |\n|------|-----|\n| Alice | 30 |');
      expect(html).toContain('chat-table');
      expect(html).toContain('sortable');
      expect(html).toContain('data-col-idx');
    });

    test('table with search (>10 rows)', () => {
      const rows = Array(12).fill('| A | B |').join('\n');
      const html = MR.render('| H1 | H2 |\n|---|---|\n' + rows);
      expect(html).toContain('chat-table-search');
    });

    test('table without search (<=10 rows)', () => {
      const html = MR.render('| H1 | H2 |\n|---|---|\n| A | B |\n| C | D |');
      expect(html).not.toContain('chat-table-search');
    });
  });

  // ── DOMPurify ──

  describe('DOMPurify sanitization', () => {
    test('strips script tags', () => {
      const html = MR.render('Hello <script>alert("xss")</script> world');
      expect(html).not.toContain('<script>');
    });

    test('preserves custom data attributes', () => {
      const html = MR.render('```mermaid\ngraph TD\n  A-->B\n```');
      expect(html).toContain('data-mermaid-id');
    });

    test('preserves code block structure', () => {
      const html = MR.render('```js\nconst x = 1;\n```');
      expect(html).toContain('chat-code-block');
      expect(html).toContain('<pre>');
      expect(html).toContain('<code');
    });

    test('preserves links with href', () => {
      const html = MR.render('[Click](https://example.com)');
      expect(html).toContain('href="https://example.com"');
    });
  });

  // ── Streaming ──

  describe('streaming', () => {
    test('createStreamCache returns proper shape', () => {
      const cache = MR.createStreamCache();
      expect(cache).toEqual({
        stableEl: null,
        activeEl: null,
        stableText: '',
        initialized: false,
      });
    });

    test('findStableBlockBoundary finds double newlines', () => {
      const { findStableBlockBoundary } = require('../../src/renderer/services/markdown/streaming');
      expect(findStableBlockBoundary('hello\n\nworld')).toBe(7);
    });

    test('findStableBlockBoundary ignores newlines inside code blocks', () => {
      const { findStableBlockBoundary } = require('../../src/renderer/services/markdown/streaming');
      // Double newline inside code block should NOT count as boundary
      const textNoOuterBoundary = '```js\nfoo\n\nbar\n```';
      expect(findStableBlockBoundary(textNoOuterBoundary)).toBe(-1);

      // With explicit paragraph break after code block (extra newline for boundary detection)
      const textWithBoundary = 'hello\n\n```js\nfoo\n\nbar\n```';
      const boundary = findStableBlockBoundary(textWithBoundary);
      expect(boundary).toBe(7); // After "hello\n\n"
    });

    test('findStableBlockBoundary returns -1 with no boundary', () => {
      const { findStableBlockBoundary } = require('../../src/renderer/services/markdown/streaming');
      expect(findStableBlockBoundary('single line')).toBe(-1);
    });

    test('renderIncremental initializes container', () => {
      const container = document.createElement('div');
      const cache = MR.createStreamCache();
      MR.renderIncremental('Hello', container, cache);
      expect(cache.initialized).toBe(true);
      expect(container.querySelector('.stream-stable')).toBeTruthy();
      expect(container.querySelector('.stream-active')).toBeTruthy();
    });

    test('renderIncremental shows cursor', () => {
      const container = document.createElement('div');
      const cache = MR.createStreamCache();
      MR.renderIncremental('Hello', container, cache);
      expect(container.querySelector('.chat-cursor')).toBeTruthy();
    });
  });

  // ── renderInline ──

  describe('renderInline', () => {
    test('renders inline markdown without block wrappers', () => {
      const html = MR.renderInline('**bold** text');
      expect(html).toContain('<strong>');
      expect(html).not.toContain('<p>');
    });

    test('returns empty string for null', () => {
      expect(MR.renderInline(null)).toBe('');
    });

    test('returns empty string for empty string', () => {
      expect(MR.renderInline('')).toBe('');
    });
  });

  // ── Links safety ──

  describe('link safety', () => {
    test('allows https links', () => {
      const html = MR.render('[link](https://example.com)');
      expect(html).toContain('href="https://example.com"');
    });

    test('blocks javascript: links', () => {
      const html = MR.render('[link](javascript:alert(1))');
      expect(html).not.toContain('javascript:');
    });
  });
});
