/**
 * Post-render processing: initialize special blocks after HTML insertion.
 * Handles lazy loading of mermaid, KaTeX, and HTML previews.
 * Includes mermaid render caching for performance.
 */

const { escapeHtml } = require('../../utils');
const { t } = require('../../i18n');
const { initializePreviewIframe } = require('./interactivity');

// ── Mermaid SVG cache (LRU, max 50) ──

const MERMAID_CACHE_MAX = 50;
const _mermaidCache = new Map();

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

function getCachedMermaid(source) {
  const key = simpleHash(source);
  if (_mermaidCache.has(key)) {
    const svg = _mermaidCache.get(key);
    _mermaidCache.delete(key);
    _mermaidCache.set(key, svg);
    return svg;
  }
  return null;
}

function setCachedMermaid(source, svg) {
  const key = simpleHash(source);
  if (_mermaidCache.size >= MERMAID_CACHE_MAX) {
    const firstKey = _mermaidCache.keys().next().value;
    _mermaidCache.delete(firstKey);
  }
  _mermaidCache.set(key, svg);
}

// ── Post-render processing ──

/**
 * Post-render processing: initialize special blocks in a container.
 * Call after inserting rendered HTML into the DOM.
 * Uses IntersectionObserver for off-screen blocks (lazy rendering).
 */
function postProcess(container) {
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
  }, { rootMargin: '200px' });

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

      // Check cache first
      const cached = getCachedMermaid(source);
      if (cached) {
        render.innerHTML = cached;
        if (loading) loading.style.display = 'none';
        return;
      }

      try {
        const { svg } = await mermaid.render(block.dataset.mermaidId, source);
        setCachedMermaid(source, svg);
        render.innerHTML = svg;
        if (loading) loading.style.display = 'none';
      } catch (err) {
        if (loading) loading.style.display = 'none';
        if (error) {
          error.style.display = '';
          error.innerHTML = `<div class="chat-mermaid-error-msg">${escapeHtml(t('chat.mermaid.error') || 'Diagram render failed')}</div>`
            + `<details class="chat-mermaid-error-details"><summary>${escapeHtml(t('chat.mermaid.showSource') || 'Show source')}</summary>`
            + `<pre><code>${escapeHtml(source)}</code></pre></details>`;
        }
        render.innerHTML = '';
      }
    });
  });
}

async function loadMermaid() {
  try {
    const mod = await import('./mermaid.bundle.js');
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
        // Block math: displayMode true (centered, large)
        render.innerHTML = katex.renderToString(source, {
          displayMode: true,
          throwOnError: true,
          strict: false,
        });
        if (loading) loading.style.display = 'none';
      } catch (err) {
        if (loading) loading.style.display = 'none';
        render.innerHTML = `<div class="chat-math-error">`
          + `<div class="chat-math-error-msg">${escapeHtml(t('chat.math.error') || 'Math render failed')}: ${escapeHtml(err.message)}</div>`
          + `<pre class="chat-math-error-source"><code>${escapeHtml(source)}</code></pre>`
          + `</div>`;
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
        // Inline math: displayMode false (inline, small)
        el.innerHTML = katex.renderToString(source, {
          displayMode: false,
          throwOnError: true,
          strict: false,
        });
      } catch (err) {
        el.innerHTML = `<span class="chat-math-error-inline" title="${escapeHtml(err.message)}"><code>${escapeHtml(source)}</code></span>`;
      }
    });
  });
}

module.exports = {
  postProcess,
};
