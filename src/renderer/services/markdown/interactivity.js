/**
 * DOM event delegation for interactive markdown blocks.
 * Attach once on the chat messages container.
 */

const { t } = require('../../i18n');

const COLLAPSE_THRESHOLD = 30;

/**
 * Attach event listeners to a container for interactive blocks.
 * Should be called once on the chat messages container.
 */
function attachInteractivity(container) {
  container.addEventListener('click', (e) => {
    // ── External links → open in browser ──
    const anchor = e.target.closest('a[href]');
    if (anchor) {
      const href = anchor.getAttribute('href');
      if (href && /^https?:\/\//.test(href)) {
        e.preventDefault();
        e.stopPropagation();
        if (window.electron_api?.dialog?.openExternal) {
          window.electron_api.dialog.openExternal(href);
        }
        return;
      }
    }

    // ── Close any open Discord select when clicking outside it ──
    if (!e.target.closest('.dc-select')) {
      container.querySelectorAll('.dc-select.open').forEach(s => s.classList.remove('open'));
    }

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

    // ── Discord preview toggle (Code/Preview/Copy JSON) ──
    if (target.classList.contains('dc-chat-toggle-btn')) {
      const preview = target.closest('.dc-chat-preview');
      if (preview) {
        const action = target.dataset.action;
        const previewBody = preview.querySelector('.dc-chat-preview-body');
        const codeBody = preview.querySelector('.dc-chat-code-body');
        const allBtns = preview.querySelectorAll('.dc-chat-toggle-btn');

        if (action === 'dc-show-preview') {
          allBtns.forEach(b => b.classList.remove('active'));
          target.classList.add('active');
          if (previewBody) previewBody.classList.remove('hidden');
          if (codeBody) codeBody.classList.remove('visible');
        } else if (action === 'dc-show-code') {
          allBtns.forEach(b => b.classList.remove('active'));
          target.classList.add('active');
          if (previewBody) previewBody.classList.add('hidden');
          if (codeBody) codeBody.classList.add('visible');
        } else if (action === 'dc-copy-json') {
          const rawEl = preview.querySelector('.dc-chat-raw');
          if (rawEl) {
            const text = rawEl.textContent;
            if (window.electron_api?.app?.clipboardWrite) {
              window.electron_api.app.clipboardWrite(text);
            } else {
              navigator.clipboard.writeText(text).catch(() => {});
            }
            target.textContent = 'Copied!';
            setTimeout(() => { target.textContent = 'Copy JSON'; }, 1500);
          }
        } else if (action === 'dc-copy-code') {
          const rawEl = preview.querySelector('.dc-chat-raw-djs');
          if (rawEl) {
            const text = rawEl.textContent;
            if (window.electron_api?.app?.clipboardWrite) {
              window.electron_api.app.clipboardWrite(text);
            } else {
              navigator.clipboard.writeText(text).catch(() => {});
            }
            target.textContent = 'Copied!';
            setTimeout(() => { target.textContent = 'Copy as discord.js'; }, 1500);
          }
        }
      }
      return;
    }

    // ── Discord spoiler toggle ──
    if (target.classList.contains('dc-spoiler')) {
      target.classList.toggle('revealed');
      return;
    }

    // ── Discord select: open/close dropdown ──
    if (target.classList.contains('dc-select-trigger')) {
      const select = target.closest('.dc-select');
      if (select && !select.classList.contains('disabled')) {
        const wasOpen = select.classList.contains('open');
        container.querySelectorAll('.dc-select.open').forEach(s => s.classList.remove('open'));
        if (!wasOpen) select.classList.add('open');
      }
      return;
    }

    // ── Discord select: pick an option ──
    if (target.closest('.dc-select-option')) {
      const option = target.closest('.dc-select-option');
      const select = option.closest('.dc-select');
      if (select) {
        select.querySelectorAll('.dc-select-option').forEach(o => o.classList.remove('selected'));
        option.classList.add('selected');
        const trigger = select.querySelector('.dc-select-trigger');
        if (trigger) {
          const label = option.querySelector('.dc-select-option-label')?.textContent
            || option.textContent.trim();
          const arrow = trigger.querySelector('.dc-select-arrow');
          trigger.textContent = label;
          if (arrow) trigger.appendChild(arrow);
          trigger.classList.add('has-value');
        }
        select.classList.remove('open');
      }
      return;
    }

    // ── Discord button: brief pressed feedback (non-link, enabled) ──
    if (target.classList.contains('dc-btn') && target.tagName === 'BUTTON' && !target.disabled) {
      target.classList.add('dc-btn-pressed');
      setTimeout(() => target.classList.remove('dc-btn-pressed'), 200);
      return;
    }

    // ── File tree folder toggle ──
    if (target.closest('.ft-toggle')) {
      const item = target.closest('.ft-item');
      if (!item || !item.hasAttribute('data-ft-dir')) return;
      const depth = parseInt(item.dataset.ftDepth, 10);
      const collapsed = item.classList.toggle('ft-collapsed');
      let sibling = item.nextElementSibling;
      while (sibling && sibling.classList.contains('ft-item')) {
        const sibDepth = parseInt(sibling.dataset.ftDepth, 10);
        if (sibDepth <= depth) break;
        sibling.style.display = collapsed ? 'none' : '';
        sibling = sibling.nextElementSibling;
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

  // ── Discord Rich Presence live timers ──
  startPresenceTicker(container);
}

/**
 * Format a duration in ms as H:MM:SS or MM:SS (mirrors PresenceRenderer).
 */
function formatPresenceElapsed(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Stop the presence ticker of a container (if any) and drop the property.
 * Safe to call multiple times, and on containers that never had a ticker.
 * @param {Element} container
 */
function stopPresenceTicker(container) {
  if (!container || !container._dcPresenceTicker) return;
  clearInterval(container._dcPresenceTicker);
  delete container._dcPresenceTicker;
}

/**
 * Start a 1s interval (once per container) that refreshes any
 * .dc-presence-time elements with elapsed/remaining durations.
 *
 * The interval self-cancels as soon as the container leaves the document or
 * once every presence node it used to drive is gone — otherwise the closure
 * would keep a detached transcript alive for the whole app lifetime.
 */
function startPresenceTicker(container) {
  if (container._dcPresenceTicker) return;

  // Only cancel on "no nodes left" once we actually saw some: the container
  // is usually empty when interactivity is attached and fills in on stream.
  let sawPresence = false;

  const tick = (fromInterval) => {
    const times = container.querySelectorAll('.dc-presence-time[data-start], .dc-presence-time[data-end]');
    const bars = container.querySelectorAll('.dc-presence-progress[data-start][data-end]');
    const hasPresence = times.length > 0 || bars.length > 0;

    if (fromInterval && (!container.isConnected || (sawPresence && !hasPresence))) {
      stopPresenceTicker(container);
      return;
    }
    if (!hasPresence) return;
    sawPresence = true;

    const now = Date.now();

    times.forEach((el) => {
      const end = el.getAttribute('data-end');
      const start = el.getAttribute('data-start');
      if (end) {
        el.textContent = `${formatPresenceElapsed(Number(end) - now)} left`;
      } else if (start) {
        el.textContent = `${formatPresenceElapsed(now - Number(start))} elapsed`;
      }
    });

    bars.forEach((el) => {
      const start = Number(el.getAttribute('data-start'));
      const end = Number(el.getAttribute('data-end'));
      const total = Math.max(1, end - start);
      const pct = Math.min(100, Math.max(0, ((now - start) / total) * 100));
      const fill = el.querySelector('.dc-presence-bar-fill');
      if (fill) fill.style.width = `${pct.toFixed(2)}%`;
      const elapsed = el.querySelector('.dc-presence-elapsed');
      if (elapsed) elapsed.textContent = formatPresenceElapsed(Math.min(now - start, total));
    });
  };
  container._dcPresenceTicker = setInterval(() => tick(true), 1000);
  tick(false);
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

  const currentDir = th.dataset.sortDir || 'none';
  const newDir = currentDir === 'asc' ? 'desc' : 'asc';

  table.querySelectorAll('th').forEach(h => { h.dataset.sortDir = 'none'; h.classList.remove('sort-asc', 'sort-desc'); });
  th.dataset.sortDir = newDir;
  th.classList.add(newDir === 'asc' ? 'sort-asc' : 'sort-desc');

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

  if (action === 'preview' || action === 'code') {
    const iframeWrap = container.querySelector('.chat-preview-iframe-wrap');
    const codeWrap = container.querySelector('.chat-preview-code-wrap');
    container.querySelectorAll('.chat-preview-btn[data-action="preview"], .chat-preview-btn[data-action="code"]')
      .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (action === 'preview') {
      iframeWrap.style.display = '';
      codeWrap.style.display = 'none';
      initializePreviewIframe(container);
    } else {
      iframeWrap.style.display = 'none';
      codeWrap.style.display = '';
    }
    return;
  }

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
 *
 * The document is served over `ct-preview://` (see src/main/ipc/preview.ipc.js)
 * rather than a blob:/data:/srcdoc URL. Those all inherit the CSP of this page,
 * which forbids framing them (`frame-src`) and strips their inline scripts —
 * the preview would render as a blank white iframe. A custom scheme carries its
 * own CSP, so the preview renders as authored.
 */
function initializePreviewIframe(container) {
  const iframe = container.querySelector('.chat-preview-iframe');
  if (!iframe || iframe.dataset.initialized) return;
  iframe.dataset.initialized = 'true';

  const sourceEl = container.querySelector('.chat-preview-source');
  if (!sourceEl) return;
  const code = sourceEl.textContent;

  let html;
  if (code.includes('<html') || code.includes('<body')) {
    html = code;
  } else {
    html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;padding:16px;background:#1a1a1a;color:#e0e0e0;font-family:system-ui,sans-serif;}</style></head><body>${code}</body></html>`;
  }

  const api = window.electron_api?.preview;
  if (!api) {
    console.warn('[Markdown] Preview API unavailable — HTML preview disabled');
    return;
  }

  api.register(html)
    .then((res) => {
      if (res?.url) {
        iframe.src = res.url;
      } else {
        console.warn('[Markdown] Preview registration failed:', res?.error);
      }
    })
    .catch((err) => console.warn('[Markdown] Preview registration failed:', err.message));
}

/**
 * Release every timer attachInteractivity() started on a container.
 * Call this from the owner's destroy()/teardown before dropping the element,
 * so the transcript can be garbage collected.
 * @param {Element} container
 */
function detachInteractivity(container) {
  stopPresenceTicker(container);
}

module.exports = {
  attachInteractivity,
  detachInteractivity,
  stopPresenceTicker,
  initializePreviewIframe,
  COLLAPSE_THRESHOLD,
};
