/**
 * Incremental streaming renderer for real-time markdown display.
 */

const { marked } = require('marked');
const DOMPurify = require('dompurify');
const { escapeHtml } = require('../../utils');
const { configure, PURIFY_CONFIG } = require('./configure');

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
      cache.stableEl.innerHTML = DOMPurify.sanitize(marked.parse(stableText), PURIFY_CONFIG);
    } catch {
      cache.stableEl.innerHTML = `<pre>${escapeHtml(stableText)}</pre>`;
    }
  }

  // Always re-render the active (last) block + cursor
  try {
    cache.activeEl.innerHTML = DOMPurify.sanitize(
      (activeText ? marked.parse(activeText) : '') + '<span class="chat-cursor"></span>',
      PURIFY_CONFIG
    );
  } catch {
    cache.activeEl.innerHTML = `<pre>${escapeHtml(activeText)}</pre><span class="chat-cursor"></span>`;
  }
}

/**
 * Find the last "block boundary" in text - a double-newline NOT inside a fenced code block.
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
        while (i < len && text[i] !== '\n') i++;
      } else {
        inCodeBlock = false;
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

module.exports = {
  createStreamCache,
  renderIncremental,
  findStableBlockBoundary,
};
