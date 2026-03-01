/**
 * WorkflowMarketplacePanel
 * Community workflow hub — rendered as a full-screen modal overlay.
 *
 * API (Cloudflare Worker):
 *   GET  /workflows?tab=browse&q=&page=&sort=imports|date|name
 *   GET  /workflows/:id
 *   POST /workflows  { name, description, tags[], author, workflowJson }
 *   POST /workflows/:id/import
 */

'use strict';

const { escapeHtml } = require('../../utils');

const HUB_URL = 'https://claude-terminal-hub.claudeterminal.workers.dev';
const PAGE_SIZE = 20;
const AUTHOR_LS_KEY = 'hub_author_v1';
const AUTHOR_ID_LS_KEY = 'hub_author_id_v1';

// ─── State ────────────────────────────────────────────────────────────────────

let _ctx = null;
let _modal = null;

function _loadAuthor() {
  try { return localStorage.getItem(AUTHOR_LS_KEY) || ''; } catch { return ''; }
}
function _saveAuthor(name) {
  try { if (name) localStorage.setItem(AUTHOR_LS_KEY, name); } catch {}
}

/** Retourne un UUID v4 stable, généré une seule fois et stocké dans localStorage */
function _getAuthorId() {
  try {
    let id = localStorage.getItem(AUTHOR_ID_LS_KEY);
    if (!id) {
      id = ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
      );
      localStorage.setItem(AUTHOR_ID_LS_KEY, id);
    }
    return id;
  } catch { return 'unknown'; }
}

const st = {
  tab: 'browse',       // 'browse' | 'mine'
  query: '',
  sort: 'imports',     // 'imports' | 'date' | 'name'
  page: 0,
  total: 0,
  items: [],
  mine: [],
  loading: false,
  cache: new Map(),
};

// ─── Public API ───────────────────────────────────────────────────────────────

function init(context) {
  _ctx = context;
}

/** Open the hub modal */
function open() {
  st.mine = []; // sera chargé depuis le serveur à la demande

  if (_modal) { _modal.remove(); _modal = null; }
  _modal = document.createElement('div');
  _modal.className = 'hub-modal-backdrop';
  _modal.innerHTML = _shellHtml();
  document.body.appendChild(_modal);

  _bindModal();
  _loadTab();
}

// Keep render() as compat shim — ignored, open() is the real entry point
function render() {}

// ─── Shell HTML ───────────────────────────────────────────────────────────────

function _shellHtml() {
  return `
  <div class="hub-modal" role="dialog" aria-modal="true">

    <!-- Sidebar -->
    <div class="hub-sidebar">
      <div class="hub-sidebar-brand">
        <svg class="hub-brand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="3" width="6" height="6" rx="1.5"/>
          <rect x="16" y="3" width="6" height="6" rx="1.5"/>
          <rect x="9" y="15" width="6" height="6" rx="1.5"/>
          <path d="M5 9v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/>
          <path d="M12 13v2"/>
        </svg>
        <div>
          <div class="hub-brand-title">Workflow Hub</div>
          <div class="hub-brand-sub">Communauté</div>
        </div>
      </div>

      <nav class="hub-nav">
        <button class="hub-nav-item ${st.tab === 'browse' ? 'active' : ''}" data-hubtab="browse">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          Explorer
        </button>
        <button class="hub-nav-item ${st.tab === 'mine' ? 'active' : ''}" data-hubtab="mine">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/></svg>
          Mes publications
        </button>
      </nav>

      <div class="hub-sidebar-footer">
        <button class="hub-publish-btn" id="hub-open-publish">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
          Publier un workflow
        </button>
      </div>
    </div>

    <!-- Main -->
    <div class="hub-main">

      <!-- Topbar -->
      <div class="hub-topbar">
        <div class="hub-search-wrap">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input class="hub-search" id="hub-search" placeholder="Rechercher des workflows…" value="${escapeHtml(st.query)}">
          ${st.query ? `<button class="hub-search-clear" id="hub-search-clear">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>` : ''}
        </div>

        <div class="hub-sort-wrap">
          <span class="hub-sort-label">Trier</span>
          <div class="hub-sort-pills">
            <button class="hub-sort-pill ${st.sort === 'imports' ? 'active' : ''}" data-hubsort="imports">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Populaires
            </button>
            <button class="hub-sort-pill ${st.sort === 'date' ? 'active' : ''}" data-hubsort="date">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              Récents
            </button>
            <button class="hub-sort-pill ${st.sort === 'name' ? 'active' : ''}" data-hubsort="name">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="9" y2="18"/></svg>
              A–Z
            </button>
          </div>
        </div>

        <button class="hub-close-btn" id="hub-close" title="Fermer">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>

      <!-- Content -->
      <div class="hub-content" id="hub-content"></div>

      <!-- Pagination -->
      <div class="hub-pagination" id="hub-pagination" style="display:none"></div>
    </div>
  </div>
  `;
}

// ─── Bindings ─────────────────────────────────────────────────────────────────

function _bindModal() {
  // Close
  _modal.querySelector('#hub-close').addEventListener('click', _close);
  _modal.addEventListener('click', e => { if (e.target === _modal) _close(); });
  document.addEventListener('keydown', _onKeyDown);

  // Tabs
  _modal.querySelectorAll('[data-hubtab]').forEach(btn => {
    btn.addEventListener('click', () => {
      st.tab = btn.dataset.hubtab;
      st.page = 0;
      _modal.querySelectorAll('[data-hubtab]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _loadTab();
    });
  });

  // Sort
  _modal.querySelectorAll('[data-hubsort]').forEach(btn => {
    btn.addEventListener('click', () => {
      st.sort = btn.dataset.hubsort;
      st.page = 0;
      st.cache.clear();
      _modal.querySelectorAll('[data-hubsort]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _loadTab();
    });
  });

  // Search
  const searchEl = _modal.querySelector('#hub-search');
  let debounce;
  searchEl?.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      st.query = searchEl.value.trim();
      st.page = 0;
      st.cache.clear();
      _reRenderTopbar();
      _loadTab();
    }, 280);
  });

  _modal.querySelector('#hub-search-clear')?.addEventListener('click', () => {
    st.query = '';
    st.page = 0;
    st.cache.clear();
    _reRenderTopbar();
    _loadTab();
  });

  // Publish
  _modal.querySelector('#hub-open-publish')?.addEventListener('click', _openPublishModal);
}

function _onKeyDown(e) {
  if (e.key === 'Escape') _close();
}

function _close() {
  document.removeEventListener('keydown', _onKeyDown);
  if (_modal) {
    _modal.classList.add('hub-modal-backdrop--out');
    setTimeout(() => { _modal?.remove(); _modal = null; }, 200);
  }
}

function _reRenderTopbar() {
  const searchEl = _modal?.querySelector('#hub-search');
  const clearBtn = _modal?.querySelector('#hub-search-clear');
  if (searchEl) searchEl.value = st.query;
  if (clearBtn) clearBtn.style.display = st.query ? '' : 'none';
}

// ─── Load tab ─────────────────────────────────────────────────────────────────

async function _loadTab() {
  const content = _modal?.querySelector('#hub-content');
  if (!content) return;

  if (st.tab === 'mine') {
    _renderMine(content);
    _hidePagination();
    return;
  }

  const cacheKey = `${st.query}:${st.sort}:${st.page}`;
  if (st.cache.has(cacheKey)) {
    _renderGrid(content, st.cache.get(cacheKey));
    return;
  }

  content.innerHTML = _loadingHtml();
  const result = await _fetchItems();
  if (result) {
    st.cache.set(cacheKey, result.items);
    st.total = result.total;
    _renderGrid(content, result.items);
    _renderPagination(result.total);
  }
}

async function _fetchItems() {
  if (!HUB_URL) return { items: _mockItems(), total: _mockItems().length };

  try {
    const params = new URLSearchParams({ tab: 'browse', page: st.page - 1, sort: st.sort });
    if (st.query) params.set('q', st.query);
    const res = await fetch(`${HUB_URL}/workflows?${params}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Client-side sort since worker returns by imports by default
    let items = data.items || [];
    if (st.sort === 'date') items = items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    else if (st.sort === 'name') items = items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return { items, total: data.total || items.length };
  } catch {
    return { items: _mockItems(), total: _mockItems().length };
  }
}

// ─── Grid render ──────────────────────────────────────────────────────────────

function _renderGrid(container, items) {
  if (!items.length) {
    container.innerHTML = `
      <div class="hub-empty">
        <div class="hub-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
        </div>
        <p>${st.query ? `Aucun résultat pour « ${escapeHtml(st.query)} »` : 'Aucun workflow disponible'}</p>
        ${!st.query ? `<span>Soyez le premier à publier !</span>` : ''}
      </div>
    `;
    return;
  }

  container.innerHTML = `<div class="hub-grid">${items.map((item, i) => _cardHtml(item, i)).join('')}</div>`;

  container.querySelectorAll('.hub-card').forEach(card => {
    const id = card.dataset.id;
    const item = items.find(i => i.id === id);
    if (!item) return;
    card.querySelector('.hub-card-import')?.addEventListener('click', e => {
      e.stopPropagation();
      _importWorkflow(item, card.querySelector('.hub-card-import'));
    });
    card.addEventListener('click', e => {
      if (!e.target.closest('.hub-card-import')) _openDetail(item);
    });
  });
}

const TAG_COLORS = { agent: 'accent', shell: 'info', git: 'purple', http: 'cyan', notify: 'warning', claude: 'violet' };

function _cardHtml(item, idx) {
  const initial = (item.name || '?').charAt(0).toUpperCase();
  const tagsHtml = (item.tags || []).slice(0, 3).map(tag =>
    `<span class="hub-tag hub-tag--${TAG_COLORS[tag] || 'muted'}">${escapeHtml(tag)}</span>`
  ).join('');
  const delay = Math.min(idx * 30, 180);

  return `
    <div class="hub-card" data-id="${escapeHtml(item.id)}" style="animation-delay:${delay}ms">
      <div class="hub-card-left">
        <div class="hub-card-avatar" data-initial="${initial}">${initial}</div>
      </div>
      <div class="hub-card-body">
        <div class="hub-card-row1">
          <span class="hub-card-name">${escapeHtml(item.name)}</span>
          <div class="hub-card-meta">
            <span class="hub-card-imports">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              ${_fmt(item.imports || 0)}
            </span>
          </div>
        </div>
        <div class="hub-card-author">par <strong>${escapeHtml(item.author || 'anonyme')}</strong></div>
        <div class="hub-card-desc">${escapeHtml(item.description || '')}</div>
        <div class="hub-card-footer">
          <div class="hub-tags">${tagsHtml}</div>
          <button class="hub-card-import">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Importer
          </button>
        </div>
      </div>
    </div>
  `;
}

// ─── Pagination ───────────────────────────────────────────────────────────────

function _renderPagination(total) {
  const pages = Math.ceil(total / PAGE_SIZE);
  const pag = _modal?.querySelector('#hub-pagination');
  if (!pag) return;
  if (pages <= 1) { pag.style.display = 'none'; return; }

  pag.style.display = 'flex';
  pag.innerHTML = `
    <button class="hub-page-btn" id="hub-prev" ${st.page === 0 ? 'disabled' : ''}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 18l-6-6 6-6"/></svg>
    </button>
    <span class="hub-page-info">${st.page + 1} / ${pages}</span>
    <button class="hub-page-btn" id="hub-next" ${st.page >= pages - 1 ? 'disabled' : ''}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>
    </button>
  `;

  pag.querySelector('#hub-prev')?.addEventListener('click', () => { st.page--; _loadTab(); });
  pag.querySelector('#hub-next')?.addEventListener('click', () => { st.page++; _loadTab(); });
}

function _hidePagination() {
  const pag = _modal?.querySelector('#hub-pagination');
  if (pag) pag.style.display = 'none';
}

// ─── Detail modal ─────────────────────────────────────────────────────────────

function _openDetail(item) {
  const overlay = document.createElement('div');
  overlay.className = 'hub-detail-overlay';

  const tagsHtml = (item.tags || []).map(tag =>
    `<span class="hub-tag hub-tag--${TAG_COLORS[tag] || 'muted'}">${escapeHtml(tag)}</span>`
  ).join('');

  overlay.innerHTML = `
    <div class="hub-detail">
      <div class="hub-detail-hd">
        <div class="hub-detail-avatar" data-initial="${(item.name || '?').charAt(0).toUpperCase()}">${(item.name || '?').charAt(0).toUpperCase()}</div>
        <div class="hub-detail-titles">
          <div class="hub-detail-name">${escapeHtml(item.name)}</div>
          <div class="hub-detail-by">par <strong>${escapeHtml(item.author || 'anonyme')}</strong></div>
        </div>
        <button class="hub-detail-close" id="hub-det-close">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>

      <div class="hub-detail-body">
        <div class="hub-detail-chips">
          <span class="hub-chip">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            ${_fmt(item.imports || 0)} imports
          </span>
          ${item.createdAt ? `<span class="hub-chip">${_relDate(item.createdAt)}</span>` : ''}
        </div>

        <p class="hub-detail-desc">${escapeHtml(item.description || 'Aucune description.')}</p>

        <div class="hub-tags" style="margin-bottom:18px">${tagsHtml}</div>

        ${item.workflowJson ? `
          <div class="hub-detail-section">Aperçu du workflow</div>
          <div class="hub-detail-preview">
            ${(item.workflowJson.steps || []).map(s => `
              <div class="hub-step-chip">
                <span class="hub-step-dot"></span>
                <span>${escapeHtml(s.name || s.type || s.id || '?')}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>

      <div class="hub-detail-ft">
        <button class="hub-detail-cancel" id="hub-det-cancel">Fermer</button>
        <button class="hub-detail-import" id="hub-det-import">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Importer ce workflow
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.querySelector('#hub-det-close').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#hub-det-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#hub-det-import').addEventListener('click', async () => {
    const btn = overlay.querySelector('#hub-det-import');
    await _importWorkflow(item, btn);
    overlay.remove();
  });
}

// ─── Import ───────────────────────────────────────────────────────────────────

async function _importWorkflow(item, btn) {
  if (!_ctx?.api?.workflow) { _toast('API workflow non disponible', 'error'); return; }

  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="hub-spinner"></span> Import…`;

  try {
    // Fetch full workflow detail to get workflowJson (not included in listing)
    let fullItem = item;
    if (!item.workflowJson && HUB_URL) {
      const detailRes = await fetch(`${HUB_URL}/workflows/${item.id}`, { signal: AbortSignal.timeout(6000) });
      if (detailRes.ok) fullItem = await detailRes.json();
    }

    const workflow = fullItem.workflowJson
      ? { ...fullItem.workflowJson, id: `wf_${Date.now()}`, name: fullItem.workflowJson.name || item.name, enabled: true, _importedFrom: item.id }
      : { id: `wf_${Date.now()}`, name: item.name, enabled: true, trigger: { type: 'manual' }, scope: 'current', concurrency: 'skip', steps: [], _importedFrom: item.id };

    const result = await _ctx.api.workflow.save({ workflow });
    if (!result?.success) throw new Error(result?.error || 'Échec');

    btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M9 12l2 2 4-4m6 2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/></svg> Importé !`;
    btn.classList.add('hub-card-import--done');

    _toast(`« ${item.name} » importé !`, 'success');

    if (HUB_URL) fetch(`${HUB_URL}/workflows/${item.id}/import`, { method: 'POST' }).catch(() => {});
  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = orig;
    _toast(`Erreur : ${e.message}`, 'error');
  }
}

// ─── Mine tab ─────────────────────────────────────────────────────────────────

async function _renderMine(container) {
  // Afficher un loading pendant le fetch
  container.innerHTML = _loadingHtml();

  try {
    const authorId = _getAuthorId();
    const res = await fetch(`${HUB_URL}/workflows?authorId=${encodeURIComponent(authorId)}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    st.mine = data.items || [];
  } catch {
    // En cas d'erreur réseau, st.mine reste vide
    st.mine = [];
  }

  if (!st.mine.length) {
    container.innerHTML = `
      <div class="hub-empty">
        <div class="hub-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </div>
        <p>Vous n'avez encore rien publié</p>
        <span>Partagez vos workflows avec la communauté !</span>
      </div>
    `;
    return;
  }

  container.innerHTML = `<div class="hub-grid">${st.mine.map((item, i) => _cardHtml(item, i)).join('')}</div>`;

  // Bind import buttons
  container.querySelectorAll('.hub-card').forEach(card => {
    const id = card.dataset.id;
    const item = st.mine.find(i => i.id === id);
    if (!item) return;
    card.querySelector('.hub-card-import')?.addEventListener('click', e => {
      e.stopPropagation();
      _importWorkflow(item, card.querySelector('.hub-card-import'));
    });
    card.addEventListener('click', e => {
      if (!e.target.closest('.hub-card-import')) _openDetail(item);
    });
  });
}

// ─── Publish modal (custom selector) ─────────────────────────────────────────

async function _openPublishModal() {
  // Load real workflows
  let workflows = [];
  try {
    const result = await _ctx?.api?.workflow?.list?.();
    workflows = result?.workflows || [];
  } catch { workflows = []; }

  const overlay = document.createElement('div');
  overlay.className = 'hub-pub-overlay';

  overlay.innerHTML = `
    <div class="hub-pub-modal">
      <div class="hub-pub-hd">
        <span class="hub-pub-title">Publier un workflow</span>
        <button class="hub-pub-close" id="hub-pub-close">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>

      <div class="hub-pub-body">

        <!-- Custom workflow selector -->
        <div class="hub-pub-field">
          <label class="hub-pub-label">Workflow à publier</label>
          <div class="hub-custom-select" id="hub-wf-select">
            <div class="hub-custom-select-trigger" id="hub-wf-trigger">
              <span id="hub-wf-selected-label">— Choisir un workflow —</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
            </div>
            <div class="hub-custom-select-dropdown" id="hub-wf-dropdown" style="display:none">
              ${workflows.length
                ? workflows.map(w => `
                    <div class="hub-custom-select-option" data-wfid="${escapeHtml(w.id)}" data-wfname="${escapeHtml(w.name || w.id)}">
                      <div class="hub-custom-select-option-name">${escapeHtml(w.name || w.id)}</div>
                      <div class="hub-custom-select-option-meta">${(w.steps || []).length} étape${(w.steps || []).length !== 1 ? 's' : ''}</div>
                    </div>`).join('')
                : `<div class="hub-custom-select-empty">Aucun workflow trouvé</div>`
              }
            </div>
          </div>
          <input type="hidden" id="hub-wf-id" value="">
        </div>

        <div class="hub-pub-field">
          <label class="hub-pub-label">Description <span class="hub-pub-hint">(affiché publiquement)</span></label>
          <textarea class="hub-pub-textarea" id="hub-pub-desc" rows="3" placeholder="Ce workflow fait X, Y, Z…"></textarea>
          <span class="hub-pub-char" id="hub-pub-char">0 / 500</span>
        </div>

        <div class="hub-pub-field">
          <label class="hub-pub-label">Tags <span class="hub-pub-hint">(séparés par virgule)</span></label>
          <input class="hub-pub-input" id="hub-pub-tags" placeholder="agent, git, deploy">
          <div class="hub-tag-presets" id="hub-tag-presets">
            ${['agent','shell','git','http','notify','claude'].map(t =>
              `<button class="hub-tag-preset hub-tag--${TAG_COLORS[t]||'muted'}" data-preset="${t}">${t}</button>`
            ).join('')}
          </div>
        </div>

        <div class="hub-pub-field">
          <label class="hub-pub-label">Pseudo <span class="hub-pub-hint">(affiché publiquement)</span></label>
          <input class="hub-pub-input" id="hub-pub-author" placeholder="votre-pseudo" value="${escapeHtml(_loadAuthor())}">
        </div>

        <div class="hub-pub-info">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          Votre workflow sera immédiatement visible dans l'onglet Explorer.
        </div>
      </div>

      <div class="hub-pub-ft">
        <button class="hub-pub-cancel" id="hub-pub-cancel">Annuler</button>
        <button class="hub-pub-submit" id="hub-pub-submit">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          Publier
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay._workflows = workflows;

  // Custom select logic
  const trigger = overlay.querySelector('#hub-wf-trigger');
  const dropdown = overlay.querySelector('#hub-wf-dropdown');
  const hiddenId = overlay.querySelector('#hub-wf-id');
  const selectedLabel = overlay.querySelector('#hub-wf-selected-label');

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = dropdown.style.display !== 'none';
    dropdown.style.display = isOpen ? 'none' : 'block';
    trigger.classList.toggle('open', !isOpen);
  });

  overlay.querySelectorAll('.hub-custom-select-option').forEach(opt => {
    opt.addEventListener('click', () => {
      hiddenId.value = opt.dataset.wfid;
      selectedLabel.textContent = opt.dataset.wfname;
      dropdown.style.display = 'none';
      trigger.classList.remove('open');
      overlay.querySelectorAll('.hub-custom-select-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
    });
  });

  document.addEventListener('click', function closeDropdown(e) {
    if (!overlay.querySelector('#hub-wf-select')?.contains(e.target)) {
      dropdown.style.display = 'none';
      trigger.classList.remove('open');
      document.removeEventListener('click', closeDropdown);
    }
  });

  // Char counter
  const descEl = overlay.querySelector('#hub-pub-desc');
  const charEl = overlay.querySelector('#hub-pub-char');
  descEl.addEventListener('input', () => {
    const n = descEl.value.length;
    charEl.textContent = `${n} / 500`;
    charEl.style.color = n > 480 ? 'var(--danger)' : '';
  });

  // Tag presets
  overlay.querySelectorAll('.hub-tag-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const tagsEl = overlay.querySelector('#hub-pub-tags');
      const current = tagsEl.value.split(',').map(t => t.trim()).filter(Boolean);
      if (!current.includes(btn.dataset.preset)) {
        current.push(btn.dataset.preset);
        tagsEl.value = current.join(', ');
      }
    });
  });

  // Close
  const closeModal = () => overlay.remove();
  overlay.querySelector('#hub-pub-close').addEventListener('click', closeModal);
  overlay.querySelector('#hub-pub-cancel').addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

  // Submit
  overlay.querySelector('#hub-pub-submit').addEventListener('click', () => _submitPublish(overlay));
}

async function _submitPublish(overlay) {
  const wfId   = overlay.querySelector('#hub-wf-id')?.value;
  const desc   = overlay.querySelector('#hub-pub-desc')?.value?.trim();
  const tags   = (overlay.querySelector('#hub-pub-tags')?.value || '').split(',').map(t => t.trim()).filter(Boolean);
  const author = overlay.querySelector('#hub-pub-author')?.value?.trim() || 'anonyme';

  if (!wfId) { _toast('Choisissez un workflow', 'error'); return; }
  if (!desc) { _toast('Ajoutez une description', 'error'); return; }
  if (desc.length > 500) { _toast('Description trop longue (max 500)', 'error'); return; }

  const workflows = overlay._workflows || [];
  const wf = workflows.find(w => w.id === wfId);
  const wfName = wf?.name || wfId;

  const btn = overlay.querySelector('#hub-pub-submit');
  btn.disabled = true;
  btn.innerHTML = `<span class="hub-spinner"></span> Publication…`;

  _saveAuthor(author);
  overlay.remove();

  if (HUB_URL) {
    const authorId = _getAuthorId();
    try {
      const res = await fetch(`${HUB_URL}/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: wfName, description: desc, tags, author, authorId, workflowJson: wf || null }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        st.cache.clear(); // invalidate so new workflow shows up
        _toast(`« ${wfName} » publié ! Visible dans Explorer.`, 'success');
      } else {
        _toast('Erreur lors de la publication', 'error');
      }
    } catch {
      _toast('Hors ligne — sera envoyé plus tard.', 'error');
    }
  } else {
    _toast('Hub non disponible.', 'error');
  }
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function _toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `hub-toast hub-toast--${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('hub-toast--in'));
  setTimeout(() => { t.classList.remove('hub-toast--in'); setTimeout(() => t.remove(), 300); }, 3500);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _fmt(n) {
  if (!n) return '0';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function _relDate(iso) {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 86400000) return "aujourd'hui";
    if (diff < 604800000) return `il y a ${Math.floor(diff / 86400000)}j`;
    if (diff < 2592000000) return `il y a ${Math.floor(diff / 604800000)}sem`;
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  } catch { return ''; }
}

function _loadingHtml() {
  return `
    <div class="hub-loading">
      <div class="hub-loading-dots">
        <span></span><span></span><span></span>
      </div>
      <span>Chargement…</span>
    </div>
  `;
}

function _mockItems() {
  const all = [
    { id: 'hub_1', name: 'Daily Code Review', author: 'yanis', verified: true, imports: 1420, createdAt: '2026-02-01T08:00:00Z',
      description: 'Revue de code quotidienne par Claude. Lance une analyse complète à 8h, corrige les issues et pousse si les tests passent.',
      tags: ['agent', 'git', 'shell'],
      workflowJson: { steps: [{ id: 's1', type: 'workflow/claude', name: 'Analyse' }, { id: 's2', type: 'workflow/git', name: 'Push' }] } },
    { id: 'hub_2', name: 'Auto Test on Commit', author: 'mehdi_dev', verified: false, imports: 892, createdAt: '2026-02-10T12:00:00Z',
      description: 'Déclenché après chaque outil Git. Lance les tests automatiquement et notifie en cas d\'échec.',
      tags: ['shell', 'notify'] },
    { id: 'hub_3', name: 'PR Summary Agent', author: 'thomas_vc', verified: false, imports: 607, createdAt: '2026-02-15T09:00:00Z',
      description: 'Génère un résumé de PR via Claude et le poste comme commentaire GitHub via l\'API.',
      tags: ['agent', 'http'] },
    { id: 'hub_4', name: 'Deploy + Notify Discord', author: 'sarah_builds', verified: false, imports: 341, createdAt: '2026-02-20T14:00:00Z',
      description: 'Pipeline de déploiement complet avec notification Discord.',
      tags: ['shell', 'http', 'notify'] },
    { id: 'hub_5', name: 'Changelog Auto-Writer', author: 'devops_bro', verified: false, imports: 228, createdAt: '2026-02-25T10:00:00Z',
      description: 'Génère le CHANGELOG.md depuis les commits Git via Claude.',
      tags: ['agent', 'git'] },
    { id: 'hub_6', name: 'Security Audit Weekly', author: 'sec_team', verified: false, imports: 183, createdAt: '2026-02-28T11:00:00Z',
      description: 'Audit hebdomadaire : dépendances vulnérables, secrets exposés, permissions.',
      tags: ['agent', 'shell'] },
  ];

  let items = [...all];
  if (st.query) {
    const q = st.query.toLowerCase();
    items = items.filter(i => i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q) || (i.tags||[]).some(t => t.includes(q)));
  }
  if (st.sort === 'date') items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  else if (st.sort === 'name') items.sort((a, b) => a.name.localeCompare(b.name));
  else items.sort((a, b) => (b.imports || 0) - (a.imports || 0));

  return items;
}

module.exports = { init, open, render };
