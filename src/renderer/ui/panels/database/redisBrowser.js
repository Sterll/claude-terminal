/**
 * Redis key browser: the key tree of one db and the detail of the selected key.
 *
 * Lifted out of DatabasePanel, whose render is a full innerHTML rewrite of the
 * tab. That was tolerable for a table grid and wrong for a tree: every
 * keystroke in the filter and every folder toggle rebuilt the whole panel,
 * which threw away the tree's scroll position and cost a full layout per
 * character on a few thousand keys. The tree and the detail pane now repaint
 * on their own; the panel's render only lays out the frame.
 *
 * State lives here, not in the panel's panelState, and every request carries
 * a token, so an answer for a db or key that is no longer selected is dropped
 * instead of overwriting the one that is.
 */

const { buildRedisTree, leafName, formatTtl, canFilterLocally } = require('./redisTree');

const FILTER_DEBOUNCE_MS = 150;

const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>';
const ICON_REFRESH = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>';
const ICON_KEY = '<svg class="redis-tree-key-icon" viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h3v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>';
const ICON_BOOK = '<svg viewBox="0 0 24 24" fill="currentColor" width="40" height="40" style="opacity:0.3"><path d="M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1z"/></svg>';
const ICON_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

function dbIndexOf(dbName) {
  const m = /^db:(\d+)$/.exec(dbName || '');
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * @param {Object} deps
 * @param {Object} deps.api - `window.electron_api.database`
 * @param {() => string|null} deps.getActiveId - active connection id
 * @param {(key: string, params?: Object) => string} deps.t
 * @param {(s: string) => string} deps.escapeHtml
 * @param {(toast: Object) => void} deps.showToast
 * @param {() => void} [deps.onRefresh] - the refresh button also reloads the db list
 */
function createRedisBrowser(deps) {
  const { api, getActiveId, t, escapeHtml, showToast } = deps;

  const state = {
    connectionId: null,
    dbName: null,
    keys: null,          // string[] loaded for loadedPattern, or null before the first answer
    truncated: false,    // more keys match loadedPattern than were loaded
    total: null,         // DBSIZE of the db
    loadedPattern: '',
    filter: '',
    separator: ':',
    expanded: new Set(),
    selectedKey: null,
    info: null,
    loadingKeys: false,
    loadingInfo: false,
  };
  let keysRequest = 0;
  let infoRequest = 0;
  let filterTimer = null;

  // ── Loading ────────────────────────────────────────────────────────────────

  /** Open a db: forget everything about the previous one and load its keys. */
  function select(dbName) {
    clearTimeout(filterTimer);
    infoRequest++; // an in-flight key detail belongs to the db being left
    Object.assign(state, {
      connectionId: getActiveId(), dbName, keys: null, truncated: false, total: null, loadedPattern: '',
      filter: '', expanded: new Set(), selectedKey: null, info: null,
      loadingKeys: false, loadingInfo: false,
    });
    return loadKeys();
  }

  async function loadKeys({ pattern = '' } = {}) {
    const id = getActiveId();
    if (!id || !state.dbName) return;
    const token = ++keysRequest;
    state.loadingKeys = true;
    refreshTree();
    let result;
    try {
      result = await api.redis({ id, action: 'keys', db: dbIndexOf(state.dbName), pattern });
    } catch (e) {
      result = { success: false, error: e.message };
    }
    if (token !== keysRequest) return; // a newer load owns the tree
    if (result.success) {
      Object.assign(state, { keys: result.keys, truncated: !!result.truncated, total: result.total, loadedPattern: pattern });
    } else {
      Object.assign(state, { keys: [], truncated: false, loadedPattern: pattern });
      showToast({ type: 'error', title: t('database.browserQueryError'), message: result.error });
    }
    state.loadingKeys = false;
    refreshTree();
  }

  async function loadInfo(key) {
    const id = getActiveId();
    if (!id) return;
    const token = ++infoRequest;
    state.loadingInfo = true;
    refreshDetail();
    let result;
    try {
      result = await api.redis({ id, action: 'info', db: dbIndexOf(state.dbName), key });
    } catch (e) {
      result = { success: false, error: e.message };
    }
    if (token !== infoRequest) return;
    if (result.success) {
      state.info = { ...result.info, fetchedAt: Date.now() };
    } else {
      state.info = null;
      showToast({ type: 'error', title: t('database.browserQueryError'), message: result.error });
    }
    state.loadingInfo = false;
    refreshDetail();
  }

  function selectKey(key) {
    if (!key || key === state.selectedKey) return;
    state.selectedKey = key;
    state.info = null;
    const list = document.getElementById('redis-tree-list');
    if (list) {
      list.querySelectorAll('.redis-tree-key').forEach(el => {
        el.classList.toggle('active', el.dataset.redisKey === key);
      });
    }
    loadInfo(key);
  }

  function applyFilter() {
    if (canFilterLocally(state)) refreshTree();
    else loadKeys({ pattern: state.filter });
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function currentTree() {
    return buildRedisTree(state.keys || [], state.filter, state.separator);
  }

  function treeNodesHtml(node, pathPrefix) {
    const sep = state.separator;
    let html = '';
    const sortedChildren = [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [name, childNode] of sortedChildren) {
      const folderPath = pathPrefix ? `${pathPrefix}${sep}${name}` : name;
      const isExpanded = state.expanded.has(folderPath);
      html += `
        <div class="redis-tree-folder ${isExpanded ? 'expanded' : ''}">
          <div class="redis-tree-folder-header" data-folder-toggle="${escapeHtml(folderPath)}">
            <svg class="redis-tree-chevron" viewBox="0 0 10 10" width="10" height="10">
              <path d="${isExpanded ? 'M1 3l4 4 4-4' : 'M3 1l4 4-4 4'}" fill="none" stroke="currentColor" stroke-width="1.5"/>
            </svg>
            <svg class="redis-tree-folder-icon" viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
              <path d="${isExpanded
                ? 'M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z'
                : 'M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z'}"/>
            </svg>
            <span class="redis-tree-folder-name">${escapeHtml(name)}</span>
            <span class="redis-tree-folder-count">${childNode.keyCount}</span>
          </div>
          ${isExpanded ? `<div class="redis-tree-folder-children">${treeNodesHtml(childNode, folderPath)}</div>` : ''}
        </div>`;
    }
    for (const key of [...node.keys].sort()) {
      html += `
        <div class="redis-tree-key ${key === state.selectedKey ? 'active' : ''}" data-redis-key="${escapeHtml(key)}" title="${escapeHtml(key)}">
          ${ICON_KEY}
          <span class="redis-tree-key-name">${escapeHtml(leafName(key, state.separator))}</span>
        </div>`;
    }
    return html;
  }

  function treeListHtml(tree) {
    if (state.loadingKeys) {
      return `<div class="redis-tree-loading"><div class="db-browser-spinner"></div>${t('database.redisLoadingKeys')}</div>`;
    }
    if (!state.keys || tree.keyCount === 0) {
      return `<div class="redis-tree-empty">${state.filter ? t('database.redisNoMatch') : t('database.redisNoKeys')}</div>`;
    }
    return treeNodesHtml(tree, '');
  }

  function noticeHtml() {
    if (state.loadingKeys || !state.truncated || !state.keys) return '';
    const shown = state.keys.length.toLocaleString();
    const message = state.loadedPattern
      ? t('database.redisKeysTruncatedFiltered', { shown })
      : t('database.redisKeysTruncated', { shown, total: (state.total ?? '?').toLocaleString() });
    return `<div class="redis-tree-notice">${escapeHtml(message)}</div>`;
  }

  function detailHtml() {
    if (state.loadingInfo) {
      return `<div class="redis-detail-loading"><div class="db-browser-spinner"></div>${t('database.redisLoadingKey')}</div>`;
    }
    if (!state.selectedKey || !state.info) {
      return `<div class="redis-detail-empty">${ICON_BOOK}<span>${t('database.redisSelectKey')}</span></div>`;
    }
    return keyDetailHtml(state.info);
  }

  function valueHtml(info) {
    const { type, value } = info;
    try {
      if (type === 'string') {
        let formatted = value, isJson = false;
        try { formatted = JSON.stringify(JSON.parse(value), null, 2); isJson = true; } catch { /* plain text */ }
        return `<pre class="redis-value-pre ${isJson ? 'json' : ''}">${escapeHtml(formatted || '')}</pre>`;
      }
      if (type === 'hash') {
        const pairs = Object.entries(typeof value === 'string' ? JSON.parse(value) : (value || {}));
        return `<div class="redis-value-table-wrapper"><table class="redis-value-table">
          <thead><tr><th>${t('database.redisField')}</th><th>${t('database.redisValue')}</th></tr></thead>
          <tbody>${pairs.map(([f, v]) => `<tr><td class="redis-field-name">${escapeHtml(f)}</td><td>${escapeHtml(String(v))}</td></tr>`).join('')}</tbody>
        </table></div>`;
      }
      if (type === 'list') {
        const items = typeof value === 'string' ? JSON.parse(value) : (value || []);
        return `<div class="redis-value-table-wrapper"><table class="redis-value-table">
          <thead><tr><th>#</th><th>${t('database.redisValue')}</th></tr></thead>
          <tbody>${items.map((v, i) => `<tr><td class="redis-list-index">${i}</td><td>${escapeHtml(String(v))}</td></tr>`).join('')}</tbody>
        </table></div>`;
      }
      if (type === 'set') {
        const members = typeof value === 'string' ? JSON.parse(value) : (value || []);
        return `<div class="redis-value-table-wrapper"><table class="redis-value-table">
          <thead><tr><th>${t('database.redisMember')}</th></tr></thead>
          <tbody>${members.map(m => `<tr><td>${escapeHtml(String(m))}</td></tr>`).join('')}</tbody>
        </table></div>`;
      }
      if (type === 'zset') {
        const arr = typeof value === 'string' ? JSON.parse(value) : (value || []);
        const pairs = [];
        for (let i = 0; i < arr.length; i += 2) pairs.push({ member: arr[i], score: arr[i + 1] });
        return `<div class="redis-value-table-wrapper"><table class="redis-value-table">
          <thead><tr><th>${t('database.redisScore')}</th><th>${t('database.redisMember')}</th></tr></thead>
          <tbody>${pairs.map(p => `<tr><td class="redis-zset-score">${escapeHtml(String(p.score))}</td><td>${escapeHtml(String(p.member))}</td></tr>`).join('')}</tbody>
        </table></div>`;
      }
    } catch { /* fall through to the raw value */ }
    return `<pre class="redis-value-pre">${escapeHtml(String(value || ''))}</pre>`;
  }

  function keyDetailHtml(info) {
    const { key, type, ttl, size, length } = info;
    const ttlDisplay = ttl === null ? t('database.redisNoExpiry') : `${ttl}s (${formatTtl(ttl)})`;
    return `
      <div class="redis-detail">
        <div class="redis-detail-header">
          <div class="redis-detail-key-row">
            <span class="redis-detail-key-name" title="${escapeHtml(key)}">${escapeHtml(key)}</span>
            <span class="redis-type-badge ${escapeHtml(type)}">${escapeHtml(type.toUpperCase())}</span>
          </div>
          <div class="redis-detail-meta">
            <span class="redis-detail-ttl">${ICON_CLOCK}${escapeHtml(ttlDisplay)}</span>
            ${size !== null && size !== undefined ? `<span class="redis-detail-size">${t('database.redisBytes', { count: size })}</span>` : ''}
            ${length !== null && length !== undefined ? `<span class="redis-detail-length">${t('database.redisItems', { count: length })}</span>` : ''}
          </div>
        </div>
        <div class="redis-detail-value">${valueHtml(info)}</div>
      </div>`;
  }

  /** The browser's frame, for the panel's render. */
  function render() {
    const tree = currentTree();
    return `
      <div class="redis-browser">
        <div class="redis-tree-panel">
          <div class="redis-tree-header">
            <div class="redis-tree-search">
              ${ICON_SEARCH}
              <input type="text" class="redis-tree-search-input" id="redis-tree-filter" placeholder="${t('database.redisFilterKeys')}" value="${escapeHtml(state.filter)}">
              <span class="redis-tree-count" id="redis-tree-count">${tree.keyCount}</span>
            </div>
            <button class="db-browser-btn" id="redis-tree-refresh" title="${t('database.redisRefreshKeys')}">${ICON_REFRESH}</button>
          </div>
          <div id="redis-tree-notice-slot">${noticeHtml()}</div>
          <div class="redis-tree-list" id="redis-tree-list">${treeListHtml(tree)}</div>
        </div>
        <div class="redis-detail-panel" id="redis-detail-panel">${detailHtml()}</div>
      </div>`;
  }

  /** Repaint the tree only, keeping its scroll position and the filter's focus. */
  function refreshTree() {
    const list = document.getElementById('redis-tree-list');
    if (!list) return;
    const tree = currentTree();
    list.innerHTML = treeListHtml(tree);
    const count = document.getElementById('redis-tree-count');
    if (count) count.textContent = String(tree.keyCount);
    const notice = document.getElementById('redis-tree-notice-slot');
    if (notice) notice.innerHTML = noticeHtml();
  }

  function refreshDetail() {
    const panel = document.getElementById('redis-detail-panel');
    if (!panel) return;
    panel.innerHTML = detailHtml();
  }

  /** Wire the frame `render()` produced. */
  function bind(container) {
    const filterInput = container.querySelector('#redis-tree-filter');
    if (filterInput) {
      filterInput.oninput = () => {
        state.filter = filterInput.value;
        clearTimeout(filterTimer);
        filterTimer = setTimeout(applyFilter, FILTER_DEBOUNCE_MS);
      };
    }

    const refreshBtn = container.querySelector('#redis-tree-refresh');
    if (refreshBtn) {
      refreshBtn.onclick = () => {
        if (deps.onRefresh) deps.onRefresh();
        loadKeys({ pattern: state.loadedPattern });
      };
    }

    // One delegated handler survives every tree repaint
    const list = container.querySelector('#redis-tree-list');
    if (list) {
      list.onclick = (e) => {
        const folder = e.target.closest('[data-folder-toggle]');
        if (folder) {
          const path = folder.dataset.folderToggle;
          if (state.expanded.has(path)) state.expanded.delete(path);
          else state.expanded.add(path);
          refreshTree();
          return;
        }
        const keyEl = e.target.closest('.redis-tree-key');
        if (keyEl) selectKey(keyEl.dataset.redisKey);
      };
    }
  }

  /** Drop in-flight answers and timers; the next render reloads. */
  function destroy() {
    clearTimeout(filterTimer);
    keysRequest++;
    infoRequest++;
  }

  /** Forget the loaded db, e.g. after a reconnect: its keys may have changed meanwhile. */
  function reset() {
    destroy();
    state.dbName = null;
    state.connectionId = null;
  }

  return {
    select, render, bind, destroy, reset,
    get dbName() { return state.dbName; },
    get connectionId() { return state.connectionId; },
    _state: state,
  };
}

module.exports = { createRedisBrowser, dbIndexOf };
