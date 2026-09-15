/**
 * Saving a conversation out of the app.
 *
 * Three formats, one shape each: JSON is the transcript as stored, Markdown is
 * what you paste into an issue, HTML is what you send to someone who does not
 * have the app. Only the HTML one renders markdown, and only for assistant
 * turns — a user turn is escaped verbatim, because it is the one part of the
 * transcript the user wrote and it should read back exactly as typed.
 *
 * The HTML export carries its own inline stylesheet rather than reusing the
 * app's: it is a standalone file that will be opened outside this process,
 * where none of the CSS variables exist. That is the one place in the
 * renderer where colour literals are correct.
 *
 * `buildExport` is separated from the download so the formatting can be tested
 * without a DOM download dance.
 */

const { escapeHtml } = require('../../../utils');
const MarkdownRenderer = require('../../../services/MarkdownRenderer');

const EXPORT_CSS = 'body{font-family:system-ui;max-width:800px;margin:0 auto;padding:20px;background:#1a1a1a;color:#e0e0e0}'
  + '.msg{margin:16px 0;padding:12px;border-radius:8px}.user{background:#252525}.assistant{background:#1e2a1e}'
  + 'strong{color:#d97706}pre{background:#111;padding:8px;border-radius:4px;overflow-x:auto}code{font-size:0.9em}';

/** @returns {{content: string, ext: string, mime: string}} */
function buildExport(history, format) {
  if (format === 'json') {
    return {
      content: JSON.stringify(history, null, 2),
      ext: 'json',
      mime: 'application/json',
    };
  }

  if (format === 'html') {
    const msgs = history.map((m) => {
      const role = m.role === 'user' ? 'You' : 'Claude';
      const rendered = m.role === 'assistant' ? MarkdownRenderer.render(m.content) : escapeHtml(m.content);
      return `<div class="msg ${m.role}"><strong>${role}:</strong><div>${rendered}</div></div>`;
    }).join('\n');
    return {
      content: `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Conversation</title><style>${EXPORT_CSS}</style></head><body><h1>Conversation Export</h1>${msgs}</body></html>`,
      ext: 'html',
      mime: 'text/html',
    };
  }

  const content = history.map((m) => {
    const role = m.role === 'user' ? '## You' : '## Claude';
    return `${role}\n\n${m.content}\n`;
  }).join('\n---\n\n');
  return { content, ext: 'md', mime: 'text/markdown' };
}

function downloadExport(history, format) {
  if (!history.length) return;
  const { content, ext, mime } = buildExport(history, format);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `conversation-${timestamp}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Wire the export button's format menu. Self-contained: the menu closes on the
 * next document click, armed a tick late so the click that opened it does not
 * immediately close it again.
 */
function attachExportMenu({ exportBtn, chatView, getHistory }) {
  if (!exportBtn) return;

  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = chatView.querySelector('.chat-export-dropdown');
    if (existing) { existing.remove(); return; }

    const dd = document.createElement('div');
    dd.className = 'chat-export-dropdown';
    dd.innerHTML = ['markdown', 'html', 'json'].map((f) =>
      `<button class="chat-export-option" data-format="${f}">${f.toUpperCase()}</button>`
    ).join('');
    dd.style.cssText = 'position:absolute;bottom:100%;left:0;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:var(--radius-sm);padding:4px;display:flex;gap:4px;z-index:100;margin-bottom:4px';
    exportBtn.style.position = 'relative';
    exportBtn.appendChild(dd);

    dd.addEventListener('click', (ev) => {
      const fmt = ev.target.dataset.format;
      if (fmt) { downloadExport(getHistory(), fmt); dd.remove(); }
    });

    setTimeout(() => {
      const close = () => { dd.remove(); document.removeEventListener('click', close); };
      document.addEventListener('click', close);
    }, 0);
  });
}

module.exports = { buildExport, downloadExport, attachExportMenu };
