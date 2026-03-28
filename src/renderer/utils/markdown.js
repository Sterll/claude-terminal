/**
 * Markdown Rendering Utility
 * Shared renderer for README display in Marketplace, Plugins, and Editor panels
 */

const { Marked } = require('marked');
const DOMPurify = require('dompurify');

// Use a separate Marked instance to avoid polluting the global singleton
// (which is configured by the chat markdown renderer with custom block renderers)
const readmeMarked = new Marked();

const renderer = {
  code({ text, lang }) {
    return `<pre class="readme-code-block"><code class="lang-${lang || ''}">${text}</code></pre>`;
  },
  codespan({ text }) {
    return `<code class="readme-inline-code">${text}</code>`;
  },
  link({ href, text }) {
    return `<a href="${href}" class="readme-link" data-external="true">${text}</a>`;
  },
  table({ header, rows }) {
    const headerHtml = header.map(h => `<th>${h.text}</th>`).join('');
    const rowsHtml = rows.map(row => `<tr>${row.map(cell => `<td>${cell.text}</td>`).join('')}</tr>`).join('');
    return `<table class="readme-table"><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table>`;
  },
  image({ href, text }) {
    return `<img src="${href}" alt="${text || ''}" class="readme-img">`;
  }
};

readmeMarked.use({ renderer, gfm: true, breaks: false });

/**
 * Render markdown to sanitized HTML
 * @param {string} md - Raw markdown text
 * @returns {string} Sanitized HTML
 */
function renderReadmeMarkdown(md) {
  if (!md) return '';
  const rawHtml = readmeMarked.parse(md);
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'strong', 'em', 'b', 'i',
      'code', 'pre', 'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'blockquote', 'hr', 'span', 'div', 'img', 'del', 'details', 'summary'
    ],
    ALLOWED_ATTR: ['href', 'class', 'src', 'alt', 'title', 'data-external'],
    ALLOW_DATA_ATTR: false
  });
}

/**
 * Bind external link handlers on a container element
 * @param {HTMLElement} container - Element containing rendered markdown
 * @param {Function} openExternal - Function to open URLs externally
 */
function bindReadmeLinks(container, openExternal) {
  container.querySelectorAll('a[data-external]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const url = a.getAttribute('href');
      if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
        openExternal(url);
      }
    });
  });
}

module.exports = { renderReadmeMarkdown, bindReadmeLinks };
