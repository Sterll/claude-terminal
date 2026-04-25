/**
 * ErrorLogPanel
 * Centralized error log viewer with filtering, pattern detection, AI diagnosis, and export.
 */

const { t } = require('../../i18n');
const { escapeHtml } = require('../../utils');

let _container = null;
let _unsubscribers = [];
let _refreshTimer = null;
let _expandedEntries = new Set();
let _isLoaded = false;

// ── Helpers ─────────────────────────────────────────────────────────────────

function _timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
}

function _formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function _levelIcon(level) {
  switch (level) {
    case 'critical': return '<svg viewBox="0 0 24 24" fill="currentColor" class="errorlog-level-icon errorlog-level-critical"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';
    case 'warning': return '<svg viewBox="0 0 24 24" fill="currentColor" class="errorlog-level-icon errorlog-level-warning"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>';
    default: return '<svg viewBox="0 0 24 24" fill="currentColor" class="errorlog-level-icon errorlog-level-info"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';
  }
}

function _levelLabel(level) {
  return t(`errorLog.level.${level}`) || level;
}

// ── Panel API ───────────────────────────────────────────────────────────────

function loadPanel(container) {
  _container = container;

  if (!_isLoaded) {
    _isLoaded = true;
    _initIpcListeners();
  }

  _render();
  _loadData();

  if (_refreshTimer) clearInterval(_refreshTimer);
  _refreshTimer = setInterval(() => {
    _loadStats();
    _renderEntries();
  }, 10000);
}

function cleanup() {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}

// ── Data loading ────────────────────────────────────────────────────────────

const _state = require('../../state/errorLog.state');
const api = window.electron_api;

async function _loadData() {
  try {
    if (!api?.errorLog) return;
    const [entries, stats, patterns] = await Promise.all([
      api.errorLog.getEntries({}),
      api.errorLog.getStats(),
      api.errorLog.getPatterns(),
    ]);
    _state.setEntries(entries || []);
    _state.setStats(stats);
    _state.setPatternAlerts(patterns || []);
    _render();
  } catch (e) {
    console.error('[ErrorLogPanel] loadData failed:', e);
  }
}

async function _loadStats() {
  try {
    if (!api?.errorLog) return;
    const stats = await api.errorLog.getStats();
    _state.setStats(stats);
  } catch {}
}

function _initIpcListeners() {
  if (!api?.errorLog) return;

  const unsub1 = _state.errorLogState.subscribe(() => {
    if (_container) _renderEntries();
  });
  _unsubscribers.push(unsub1);

  if (api.errorLog.onEntry) {
    api.errorLog.onEntry(() => _loadStats());
  }
}

// ── Render ──────────────────────────────────────────────────────────────────

function _render() {
  if (!_container) return;
  const stats = _state.errorLogState.get().stats;
  const filter = _state.errorLogState.get().filter;
  const domains = _state.getDomains();
  const patternAlerts = _state.errorLogState.get().patternAlerts;

  _container.innerHTML = `
    <div class="errorlog-panel">
      <div class="errorlog-header">
        <h2>${t('errorLog.title')}</h2>
        <div class="errorlog-header-actions">
          <button class="errorlog-btn errorlog-btn--export" id="errorlog-export" title="${t('errorLog.export')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            ${t('errorLog.export')}
          </button>
          <button class="errorlog-btn errorlog-btn--clear" id="errorlog-clear" title="${t('errorLog.clearAll')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            ${t('errorLog.clearAll')}
          </button>
        </div>
      </div>

      ${stats ? `
      <div class="errorlog-stats">
        <div class="errorlog-stat">
          <span class="errorlog-stat-value">${stats.total}</span>
          <span class="errorlog-stat-label">${t('errorLog.stats.total')}</span>
        </div>
        <div class="errorlog-stat errorlog-stat--critical">
          <span class="errorlog-stat-value">${stats.critical}</span>
          <span class="errorlog-stat-label">${t('errorLog.level.critical')}</span>
        </div>
        <div class="errorlog-stat errorlog-stat--warning">
          <span class="errorlog-stat-value">${stats.warning}</span>
          <span class="errorlog-stat-label">${t('errorLog.level.warning')}</span>
        </div>
        <div class="errorlog-stat errorlog-stat--info">
          <span class="errorlog-stat-value">${stats.info}</span>
          <span class="errorlog-stat-label">${t('errorLog.level.info')}</span>
        </div>
        <div class="errorlog-stat">
          <span class="errorlog-stat-value">${stats.patternAlerts}</span>
          <span class="errorlog-stat-label">${t('errorLog.stats.patterns')}</span>
        </div>
      </div>
      ` : ''}

      ${patternAlerts.length > 0 ? `
      <div class="errorlog-pattern-alerts">
        <div class="errorlog-pattern-alerts-header">
          <svg viewBox="0 0 24 24" fill="currentColor" class="errorlog-pattern-icon"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
          ${t('errorLog.patternAlerts')}
        </div>
        ${patternAlerts.map(a => `
          <div class="errorlog-pattern-item">
            <span class="errorlog-pattern-count">${a.count}x</span>
            <span class="errorlog-pattern-domain">${escapeHtml(a.domain)}</span>
            <span class="errorlog-pattern-msg">${escapeHtml(a.message).slice(0, 120)}</span>
            <span class="errorlog-pattern-window">${t('errorLog.inLastHour')}</span>
          </div>
        `).join('')}
      </div>
      ` : ''}

      <div class="errorlog-filters">
        <div class="errorlog-filter-group">
          <select class="errorlog-select" id="errorlog-filter-level">
            <option value="">${t('errorLog.filters.allLevels')}</option>
            <option value="critical" ${filter.level === 'critical' ? 'selected' : ''}>${t('errorLog.level.critical')}</option>
            <option value="warning" ${filter.level === 'warning' ? 'selected' : ''}>${t('errorLog.level.warning')}</option>
            <option value="info" ${filter.level === 'info' ? 'selected' : ''}>${t('errorLog.level.info')}</option>
          </select>
          <select class="errorlog-select" id="errorlog-filter-domain">
            <option value="">${t('errorLog.filters.allDomains')}</option>
            ${domains.map(d => `<option value="${escapeHtml(d)}" ${filter.domain === d ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('')}
          </select>
        </div>
        <div class="errorlog-search-wrapper">
          <svg viewBox="0 0 24 24" fill="currentColor" class="errorlog-search-icon"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
          <input type="text" class="errorlog-search" id="errorlog-filter-search" placeholder="${t('errorLog.filters.search')}" value="${escapeHtml(filter.search)}" spellcheck="false">
        </div>
      </div>

      <div class="errorlog-entries" id="errorlog-entries"></div>
    </div>
  `;

  _bindEvents();
  _renderEntries();
}

function _renderEntries() {
  const el = _container?.querySelector('#errorlog-entries');
  if (!el) return;

  const entries = _state.getFilteredEntries();

  if (entries.length === 0) {
    el.innerHTML = `
      <div class="errorlog-empty">
        <svg viewBox="0 0 24 24" fill="currentColor" class="errorlog-empty-icon"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        <p>${t('errorLog.noErrors')}</p>
      </div>
    `;
    return;
  }

  // Show newest first, limit to 500 for perf
  const visible = entries.slice(-500).reverse();

  el.innerHTML = visible.map(entry => {
    const expanded = _expandedEntries.has(entry.id);
    return `
      <div class="errorlog-entry errorlog-entry--${entry.level}" data-id="${entry.id}">
        <div class="errorlog-entry-header" data-entry-id="${entry.id}">
          ${_levelIcon(entry.level)}
          <span class="errorlog-entry-level">${_levelLabel(entry.level)}</span>
          <span class="errorlog-entry-domain">${escapeHtml(entry.domain)}</span>
          <span class="errorlog-entry-msg">${escapeHtml(entry.message)}</span>
          <span class="errorlog-entry-time" title="${new Date(entry.timestamp).toLocaleString()}">${_formatTime(entry.timestamp)}</span>
          <span class="errorlog-entry-ago">${_timeAgo(entry.timestamp)}</span>
          ${entry.stack ? `<button class="errorlog-expand-btn" data-expand-id="${entry.id}" title="${t('errorLog.toggleStack')}">${expanded ? '&#9660;' : '&#9654;'}</button>` : ''}
        </div>
        ${expanded && entry.stack ? `
          <div class="errorlog-entry-stack">
            <pre>${escapeHtml(entry.stack)}</pre>
            <div class="errorlog-entry-actions">
              <button class="errorlog-btn errorlog-btn--diagnose" data-diagnose-id="${entry.id}">${t('errorLog.diagnoseWithClaude')}</button>
              <button class="errorlog-btn errorlog-btn--copy-stack" data-copy-id="${entry.id}">${t('errorLog.copyStack')}</button>
            </div>
          </div>
        ` : ''}
        ${expanded && entry.context ? `
          <div class="errorlog-entry-context">
            <pre>${escapeHtml(JSON.stringify(entry.context, null, 2))}</pre>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

// ── Events ──────────────────────────────────────────────────────────────────

function _bindEvents() {
  if (!_container) return;

  const filterLevel = _container.querySelector('#errorlog-filter-level');
  const filterDomain = _container.querySelector('#errorlog-filter-domain');
  const filterSearch = _container.querySelector('#errorlog-filter-search');
  const clearBtn = _container.querySelector('#errorlog-clear');
  const exportBtn = _container.querySelector('#errorlog-export');
  const entriesEl = _container.querySelector('#errorlog-entries');

  if (filterLevel) {
    filterLevel.addEventListener('change', () => {
      _state.setFilter({ level: filterLevel.value || null });
      _renderEntries();
    });
  }
  if (filterDomain) {
    filterDomain.addEventListener('change', () => {
      _state.setFilter({ domain: filterDomain.value });
      _renderEntries();
    });
  }
  if (filterSearch) {
    let debounce;
    filterSearch.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        _state.setFilter({ search: filterSearch.value });
        _renderEntries();
      }, 200);
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!api?.errorLog) return;
      await api.errorLog.clear();
      _state.clearEntries();
      _expandedEntries.clear();
      _render();
    });
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      if (!api?.errorLog) return;
      const data = await api.errorLog.export();
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `claude-terminal-errorlog-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  if (entriesEl) {
    entriesEl.addEventListener('click', (e) => {
      // Expand/collapse stack trace
      const expandBtn = e.target.closest('[data-expand-id]');
      if (expandBtn) {
        const id = parseInt(expandBtn.dataset.expandId, 10);
        if (_expandedEntries.has(id)) {
          _expandedEntries.delete(id);
        } else {
          _expandedEntries.add(id);
        }
        _renderEntries();
        return;
      }

      // Click on entry header to toggle
      const header = e.target.closest('.errorlog-entry-header');
      if (header && !expandBtn) {
        const id = parseInt(header.dataset.entryId, 10);
        const entry = _state.errorLogState.get().entries.find(en => en.id === id);
        if (entry?.stack) {
          if (_expandedEntries.has(id)) {
            _expandedEntries.delete(id);
          } else {
            _expandedEntries.add(id);
          }
          _renderEntries();
        }
        return;
      }

      // Diagnose with Claude
      const diagnoseBtn = e.target.closest('[data-diagnose-id]');
      if (diagnoseBtn) {
        const id = parseInt(diagnoseBtn.dataset.diagnoseId, 10);
        _diagnoseWithClaude(id);
        return;
      }

      // Copy stack trace
      const copyBtn = e.target.closest('[data-copy-id]');
      if (copyBtn) {
        const id = parseInt(copyBtn.dataset.copyId, 10);
        const entry = _state.errorLogState.get().entries.find(en => en.id === id);
        if (entry?.stack) {
          navigator.clipboard.writeText(entry.stack);
          copyBtn.textContent = t('common.copied') || 'Copied!';
          setTimeout(() => { copyBtn.textContent = t('errorLog.copyStack'); }, 2000);
        }
        return;
      }
    });
  }
}

async function _diagnoseWithClaude(entryId) {
  const entry = _state.errorLogState.get().entries.find(e => e.id === entryId);
  if (!entry) return;

  const prompt = [
    `Diagnose this error from Claude Terminal:`,
    ``,
    `**Domain:** ${entry.domain}`,
    `**Level:** ${entry.level}`,
    `**Message:** ${entry.message}`,
    entry.stack ? `\n**Stack trace:**\n\`\`\`\n${entry.stack}\n\`\`\`` : '',
    entry.context ? `\n**Context:** ${JSON.stringify(entry.context)}` : '',
    ``,
    `What could cause this? How to fix it?`,
  ].filter(Boolean).join('\n');

  // Copy to clipboard and switch to Claude tab for now
  await navigator.clipboard.writeText(prompt);

  // Switch to Claude tab
  const claudeTab = document.querySelector('[data-tab="claude"]');
  if (claudeTab) claudeTab.click();

  // Try to paste into chat input
  setTimeout(() => {
    const chatInput = document.querySelector('.chat-input textarea, .terminal-input');
    if (chatInput) {
      chatInput.focus();
    }
  }, 200);
}

module.exports = {
  loadPanel,
  cleanup,
};
