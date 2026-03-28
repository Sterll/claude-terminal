/**
 * Discord preview block renderers: embed, component, message.
 */

const { escapeHtml } = require('../../../utils');

// ── Discord Embed Preview ──

function renderDiscordEmbedBlock(raw) {
  const DiscordRenderer = require('../../../ui/discord/DiscordRenderer');
  const result = DiscordRenderer.autoRender(raw);
  if (!result) {
    return `<pre class="code-block"><code>${escapeHtml(raw)}</code></pre>`;
  }

  const codeEscaped = escapeHtml(raw);
  const uid = 'dc-preview-' + Math.random().toString(36).slice(2, 8);

  return `<div class="dc-chat-preview" data-dc-uid="${uid}">`
    + `<div class="dc-chat-preview-toolbar">`
    + `<span class="dc-chat-preview-label">Discord Embed</span>`
    + `<button class="dc-chat-toggle-btn active" data-action="dc-show-preview">Preview</button>`
    + `<button class="dc-chat-toggle-btn" data-action="dc-show-code">Code</button>`
    + `<button class="dc-chat-toggle-btn" data-action="dc-copy-json">Copy JSON</button>`
    + `</div>`
    + `<div class="dc-chat-preview-body">${result.html}</div>`
    + `<div class="dc-chat-code-body"><pre class="code-block"><code>${codeEscaped}</code></pre></div>`
    + `<div class="dc-chat-raw" style="display:none">${codeEscaped}</div>`
    + `</div>`;
}

// ── Discord Component Preview ──

function renderDiscordComponentBlock(raw) {
  const DiscordRenderer = require('../../../ui/discord/DiscordRenderer');
  const html = DiscordRenderer.renderComponents(raw);
  if (!html) {
    return `<pre class="code-block"><code>${escapeHtml(raw)}</code></pre>`;
  }

  const codeEscaped = escapeHtml(raw);
  const uid = 'dc-preview-' + Math.random().toString(36).slice(2, 8);

  return `<div class="dc-chat-preview" data-dc-uid="${uid}">`
    + `<div class="dc-chat-preview-toolbar">`
    + `<span class="dc-chat-preview-label">Discord Components</span>`
    + `<button class="dc-chat-toggle-btn active" data-action="dc-show-preview">Preview</button>`
    + `<button class="dc-chat-toggle-btn" data-action="dc-show-code">Code</button>`
    + `<button class="dc-chat-toggle-btn" data-action="dc-copy-json">Copy JSON</button>`
    + `</div>`
    + `<div class="dc-chat-preview-body">${html}</div>`
    + `<div class="dc-chat-code-body"><pre class="code-block"><code>${codeEscaped}</code></pre></div>`
    + `<div class="dc-chat-raw" style="display:none">${codeEscaped}</div>`
    + `</div>`;
}

// ── Discord Message Preview ──

function renderDiscordMessageBlock(raw) {
  const DiscordRenderer = require('../../../ui/discord/DiscordRenderer');
  const html = DiscordRenderer.renderMessage(raw);
  if (!html) {
    return `<pre class="code-block"><code>${escapeHtml(raw)}</code></pre>`;
  }

  const codeEscaped = escapeHtml(raw);
  const uid = 'dc-preview-' + Math.random().toString(36).slice(2, 8);

  return `<div class="dc-chat-preview" data-dc-uid="${uid}">`
    + `<div class="dc-chat-preview-toolbar">`
    + `<span class="dc-chat-preview-label">Discord Message</span>`
    + `<button class="dc-chat-toggle-btn active" data-action="dc-show-preview">Preview</button>`
    + `<button class="dc-chat-toggle-btn" data-action="dc-show-code">Code</button>`
    + `</div>`
    + `<div class="dc-chat-preview-body">${html}</div>`
    + `<div class="dc-chat-code-body"><pre class="code-block"><code>${codeEscaped}</code></pre></div>`
    + `</div>`;
}

module.exports = {
  renderDiscordEmbedBlock,
  renderDiscordComponentBlock,
  renderDiscordMessageBlock,
};
