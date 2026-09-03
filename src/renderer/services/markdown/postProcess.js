/**
 * Post-render processing: initialize special blocks after HTML insertion.
 * Handles lazy loading of mermaid, KaTeX, and HTML previews.
 * Includes mermaid render caching for performance.
 */

const { escapeHtml } = require('../../utils');
const { t } = require('../../i18n');
const { initializePreviewIframe, ensurePresenceTicker } = require('./interactivity');

/** Presence cards carrying a live timer — the only ones that need a ticker. */
const PRESENCE_SELECTOR = '.dc-presence-time[data-start], .dc-presence-time[data-end], .dc-presence-progress[data-start][data-end]';

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

// One observer for the whole renderer, created on first use. Replaying a long
// session calls postProcess() once per render batch; allocating an observer per
// call left thousands of them alive, each re-observing every block already
// handled by the previous ones.
let _lazyObserver = null;

function getLazyObserver() {
  if (_lazyObserver) return _lazyObserver;
  _lazyObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      _lazyObserver.unobserve(el);

      if (el.classList.contains('chat-preview-container')) {
        initializePreviewIframe(el);
      } else if (el.classList.contains('chat-mermaid-block')) {
        initMermaidBlocks([el]);
      } else if (el.classList.contains('chat-math-block')) {
        initMathBlocks([el]);
      }
    });
  }, { rootMargin: '200px' });
  return _lazyObserver;
}

/**
 * Normalize a postProcess target into a list of DOM roots.
 * Accepts an element/fragment, or an array/NodeList of elements (a render batch).
 */
function toRoots(target) {
  if (!target) return [];
  if (typeof target.querySelectorAll === 'function') return [target];
  return Array.from(target).filter(el => el && typeof el.querySelectorAll === 'function');
}

function queryWithin(roots, selector) {
  const found = [];
  for (const root of roots) {
    if (typeof root.matches === 'function' && root.matches(selector)) found.push(root);
    found.push(...root.querySelectorAll(selector));
  }
  return found;
}

/**
 * Post-render processing: initialize special blocks after HTML insertion.
 * Uses IntersectionObserver for off-screen blocks (lazy rendering).
 *
 * @param {Element|DocumentFragment|Element[]|NodeList} target - Container, or the
 *   nodes of a single render batch. Passing the batch (rather than the whole
 *   message list) keeps replay linear instead of quadratic.
 */
function postProcess(target) {
  const roots = toRoots(target);
  if (roots.length === 0) return;

  const previews = queryWithin(roots, '.chat-preview-container');
  const mermaidBlocks = queryWithin(roots, '.chat-mermaid-block');
  const mathBlocks = queryWithin(roots, '.chat-math-block');
  const inlineMathEls = queryWithin(roots, '.chat-math-inline[data-math-source]');

  // Discord Rich Presence timers. Scoped to the batch just inserted, so a
  // session that renders no presence card never pays for one — and never arms
  // the 1 Hz document scan that keeps them counting.
  if (queryWithin(roots, PRESENCE_SELECTOR).length > 0) {
    ensurePresenceTicker();
  }

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
  const observer = getLazyObserver();
  const observe = (el) => {
    if (el.dataset.lazyObserved) return;
    el.dataset.lazyObserved = '1';
    observer.observe(el);
  };
  previews.forEach(observe);
  mermaidBlocks.forEach(observe);
  mathBlocks.forEach(observe);
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
    if (!document.getElementById('katex-css')) {
      const link = document.createElement('link');
      link.id = 'katex-css';
      link.rel = 'stylesheet';
      link.href = 'node_modules/katex/dist/katex.min.css';
      document.head.appendChild(link);
    }
    // Separate esbuild entry (see scripts/build-renderer.js), same pattern as
    // mermaid: `require('katex')` was lazily *executed* but statically
    // *resolved*, so ~270 KB shipped in renderer.bundle.js for every session.
    // Path is relative to dist/renderer.bundle.js (dynamic import in a classic
    // script resolves against the script URL, not the document).
    const mod = await import('./katex.bundle.js');
    return mod.default || mod;
  } catch (err) {
    console.warn('[MarkdownRenderer] KaTeX not available:', err && err.message);
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
