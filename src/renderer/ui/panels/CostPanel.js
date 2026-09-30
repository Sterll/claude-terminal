/**
 * CostPanel
 * What Claude Code consumed on this machine, priced at API list rates and split
 * by account, project, model and day.
 *
 * The figures come from CostService, which reads the local transcripts. They
 * are not a bill: on a subscription they are the proxy for how much of the
 * plan's limit the tokens drew. The "one percent" card turns that into the
 * question users actually ask, by setting the cost since the weekly reset
 * against the weekly percentage the usage API reports.
 */

const { t, getCurrentLanguage } = require('../../i18n');
const { escapeHtml } = require('../../utils');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const UNKNOWN_ACCOUNT = 'unknown';
const PERIODS = ['thisWeek', 'lastWeek', 'last7', 'last30', 'thisMonth', 'all'];
// Account colours come from the theme variables; a colour the user picked for
// an account in Settings wins over these.
const PALETTE = ['var(--accent)', 'var(--info)', 'var(--purple)', 'var(--success)', 'var(--warning)', 'var(--danger)'];

let _container = null;
let _period = 'thisWeek';
let _accountFilter = 'all';
let _report = null;
let _quota = [];
let _loading = false;
let _loadError = null;
let _requestSeq = 0;

// ── Formatting ──────────────────────────────────────────────────────────────

function _locale() {
  try {
    return getCurrentLanguage() || undefined;
  } catch {
    return undefined;
  }
}

function _money(value) {
  const n = Number(value) || 0;
  return new Intl.NumberFormat(_locale(), {
    style: 'currency',
    currency: 'USD',
    // "$", not "$US" / "US$": every figure here is in dollars, so the
    // disambiguation some locales add is noise.
    currencyDisplay: 'narrowSymbol',
    maximumFractionDigits: n >= 100 ? 0 : 2,
  }).format(n);
}

function _compact(value) {
  return new Intl.NumberFormat(_locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value) || 0);
}

function _percent(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function _shortDate(ms) {
  return new Date(ms).toLocaleDateString(_locale(), { day: 'numeric', month: 'short' });
}

function _dayLabel(isoDay) {
  const [y, m, d] = isoDay.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(_locale(), { weekday: 'short', day: 'numeric' });
}

function _modelLabel(id) {
  return String(id)
    .replace(/^claude-/, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/-(\d+)$/, ' $1')
    .replace(/^\w/, c => c.toUpperCase());
}

// ── Periods ─────────────────────────────────────────────────────────────────

function _startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Monday 00:00 of the week holding `date`, local time. */
function _startOfWeek(date) {
  const day = _startOfDay(date);
  const offset = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - offset);
  return day;
}

/**
 * @param {string} period
 * @param {Date} [now]
 * @returns {{ from: number|null, to: number|null }}
 */
function periodRange(period, now = new Date()) {
  switch (period) {
    case 'thisWeek':
      return { from: _startOfWeek(now).getTime(), to: null };
    case 'lastWeek': {
      const end = _startOfWeek(now);
      const start = new Date(end);
      start.setDate(start.getDate() - 7);
      return { from: start.getTime(), to: end.getTime() };
    }
    case 'last7':
      return { from: now.getTime() - WEEK_MS, to: null };
    case 'last30':
      return { from: now.getTime() - 30 * DAY_MS, to: null };
    case 'thisMonth':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), to: null };
    default:
      return { from: null, to: null };
  }
}

/** Every local day in [from, to), so empty days still get a bar. */
function _daysBetween(from, to) {
  const out = [];
  const cursor = _startOfDay(new Date(from));
  while (cursor.getTime() < to) {
    const mm = String(cursor.getMonth() + 1).padStart(2, '0');
    const dd = String(cursor.getDate()).padStart(2, '0');
    out.push(`${cursor.getFullYear()}-${mm}-${dd}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

// ── Accounts ────────────────────────────────────────────────────────────────

function _accountInfo(id) {
  const accounts = _report?.accounts || [];
  const index = accounts.findIndex(a => a.id === id);
  if (index === -1) {
    return { id, name: t('cost.unknownAccount'), color: 'var(--text-muted)' };
  }
  const account = accounts[index];
  return { id, name: account.name, color: account.color || PALETTE[index % PALETTE.length] };
}

// ── Panel API ───────────────────────────────────────────────────────────────

function loadPanel(container) {
  _container = container;
  _render();
  _load();
}

function cleanup() {
  // Nothing polls: the figures refresh when the tab is opened or on demand.
  _requestSeq++;
}

// ── Data ────────────────────────────────────────────────────────────────────

async function _load() {
  const api = window.electron_api;
  if (!api?.cost) return;
  const seq = ++_requestSeq;
  _loading = true;
  _loadError = null;
  _render();

  const range = periodRange(_period);
  try {
    const report = await api.cost.getReport({
      from: range.from ?? undefined,
      to: range.to ?? undefined,
      accountId: _accountFilter === 'all' ? undefined : _accountFilter,
    });
    if (seq !== _requestSeq) return;
    _report = report;
  } catch (err) {
    if (seq !== _requestSeq) return;
    _loadError = err?.message || String(err);
  }
  _loading = false;
  _render();
  _loadQuota(seq);
}

/**
 * For every account with a weekly figure: what this machine spent since the
 * weekly window opened, against the percentage the usage API reports.
 */
async function _loadQuota(seq) {
  const api = window.electron_api;
  if (!api?.cost || !_report) return;
  const accounts = _report.accounts || [];
  const targets = [];

  try {
    if (accounts.length && api.accounts?.usage) {
      const res = await api.accounts.usage(5 * 60 * 1000, false);
      const usage = res?.success ? res.data : res;
      for (const account of accounts) {
        targets.push({ accountId: account.id, usage: usage?.[account.id]?.data });
      }
    } else if (api.usage?.getData) {
      const res = await api.usage.getData(null);
      targets.push({ accountId: UNKNOWN_ACCOUNT, usage: res?.data });
    }
  } catch {
    return;
  }

  const rows = [];
  for (const target of targets) {
    const weekly = target.usage?.buckets?.find(b => b.type === 'weekly');
    if (!weekly?.resetsAt || typeof weekly.utilization !== 'number') continue;
    const windowStart = Date.parse(weekly.resetsAt) - WEEK_MS;
    if (!Number.isFinite(windowStart)) continue;
    try {
      const report = await api.cost.getReport({ from: windowStart, accountId: target.accountId });
      const spent = report?.totals?.cost || 0;
      rows.push({ accountId: target.accountId, utilization: weekly.utilization, windowStart, spent });
    } catch {
      // One account failing leaves the others to show.
    }
  }
  if (seq !== _requestSeq) return;
  _quota = rows;
  _render();
}

// ── Rendering ───────────────────────────────────────────────────────────────

function _render() {
  if (!_container) return;
  _container.innerHTML = `
    <div class="cost-panel">
      ${_renderHeader()}
      ${_renderFilters()}
      <div class="cost-body">${_renderBody()}</div>
    </div>`;
  _bindEvents();
}

function _renderHeader() {
  return `
    <div class="cost-header">
      <div>
        <h2>${escapeHtml(t('cost.title'))}</h2>
        <p class="cost-subtitle">${escapeHtml(t('cost.subtitle'))}</p>
      </div>
      <button class="cost-btn" data-action="refresh" ${_loading ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
        ${escapeHtml(t('cost.refresh'))}
      </button>
    </div>`;
}

function _renderFilters() {
  const periods = PERIODS.map(p => `
    <button class="cost-chip ${p === _period ? 'active' : ''}" data-period="${p}">${escapeHtml(t(`cost.period.${p}`))}</button>`).join('');

  const accounts = _report?.accounts || [];
  let accountChips = '';
  if (accounts.length) {
    const chips = [{ id: 'all', name: t('cost.allAccounts') }, ...accounts.map(a => ({ id: a.id, name: a.name }))];
    accountChips = `
      <div class="cost-chips">
        ${chips.map(c => `
          <button class="cost-chip ${c.id === _accountFilter ? 'active' : ''}" data-account="${escapeHtml(c.id)}">
            ${c.id === 'all' ? '' : `<span class="cost-dot" style="background:${_accountInfo(c.id).color}"></span>`}
            ${escapeHtml(c.name)}
          </button>`).join('')}
      </div>`;
  }
  return `
    <div class="cost-filters">
      <div class="cost-chips">${periods}</div>
      ${accountChips}
    </div>`;
}

function _renderBody() {
  if (_loadError) {
    return `<div class="cost-error">${escapeHtml(t('cost.loadError'))}: ${escapeHtml(_loadError)}</div>`;
  }
  if (!_report) {
    return `<div class="cost-empty">${escapeHtml(t('cost.loading'))}</div>`;
  }
  if (!_report.totals.messages) {
    return `<div class="cost-empty">${escapeHtml(t('cost.empty'))}</div>`;
  }
  return `
    ${_renderMetrics()}
    <div class="cost-grid">
      ${_accountFilter === 'all' && _report.byAccount.length > 1 ? _renderAccounts() : ''}
      ${_renderQuota()}
    </div>
    ${_renderDaily()}
    <div class="cost-grid">
      ${_renderProjects()}
      ${_renderModels()}
    </div>
    ${_renderNotes()}`;
}

function _renderMetrics() {
  const { totals } = _report;
  const range = periodRange(_period);
  const from = range.from ?? _report.firstSeen ?? Date.now();
  const to = range.to ?? Date.now();
  const days = Math.max(1, Math.ceil((to - from) / DAY_MS));
  const cards = [
    { label: t('cost.metrics.total'), value: _money(totals.cost) },
    { label: t('cost.metrics.perDay'), value: _money(totals.cost / days) },
    { label: t('cost.metrics.tokens'), value: _compact(totals.tokens) },
    { label: t('cost.metrics.messages'), value: _compact(totals.messages) },
  ];
  return `
    <div class="cost-metrics">
      ${cards.map(c => `
        <div class="cost-metric">
          <div class="cost-metric-value">${escapeHtml(c.value)}</div>
          <div class="cost-metric-label">${escapeHtml(c.label)}</div>
        </div>`).join('')}
    </div>`;
}

function _bar(share, color) {
  return `<div class="cost-bar"><div class="cost-bar-fill" style="width:${Math.min(100, share)}%;background:${color}"></div></div>`;
}

function _renderAccounts() {
  const total = _report.totals.cost;
  const rows = _report.byAccount.map(a => {
    const info = _accountInfo(a.id);
    const share = _percent(a.cost, total);
    return `
      <div class="cost-account-row">
        <div class="cost-account-name"><span class="cost-dot" style="background:${info.color}"></span>${escapeHtml(info.name)}</div>
        ${_bar(share, info.color)}
        <div class="cost-account-value">${escapeHtml(_money(a.cost))}</div>
        <div class="cost-account-share">${share}%</div>
      </div>`;
  }).join('');
  return `
    <section class="cost-card">
      <h3>${escapeHtml(t('cost.sections.accounts'))}</h3>
      ${rows}
    </section>`;
}

function _renderQuota() {
  const rows = _quota
    .filter(q => _accountFilter === 'all' || q.accountId === _accountFilter)
    .map(q => {
      const info = _accountInfo(q.accountId);
      const perPercent = q.utilization > 0 ? q.spent / q.utilization : null;
      return `
        <div class="cost-quota-row">
          <div class="cost-account-name"><span class="cost-dot" style="background:${info.color}"></span>${escapeHtml(info.name)}</div>
          <div class="cost-quota-main">
            ${perPercent === null
    ? `<span class="cost-quota-value">${escapeHtml(t('cost.quota.notEnough'))}</span>`
    : `<span class="cost-quota-value">${escapeHtml(t('cost.quota.perPercent', { value: _money(perPercent) }))}</span>
               <span class="cost-quota-week">${escapeHtml(t('cost.quota.fullWeek', { value: _money(perPercent * 100) }))}</span>`}
          </div>
          <div class="cost-quota-detail">${escapeHtml(t('cost.quota.detail', {
    percent: Math.round(q.utilization),
    date: _shortDate(q.windowStart),
    cost: _money(q.spent),
  }))}</div>
          ${_bar(q.utilization, info.color)}
        </div>`;
    }).join('');
  return `
    <section class="cost-card">
      <h3>${escapeHtml(t('cost.sections.quota'))}</h3>
      ${rows || `<div class="cost-muted">${escapeHtml(t('cost.quota.none'))}</div>`}
      ${rows ? `<p class="cost-muted cost-note">${escapeHtml(t('cost.quota.note'))}</p>` : ''}
    </section>`;
}

function _renderDaily() {
  const range = periodRange(_period);
  const byDate = new Map(_report.byDay.map(d => [d.date, d]));
  let dates;
  if (range.from !== null) {
    const to = range.to ?? Date.now();
    dates = _daysBetween(range.from, to);
  } else {
    dates = _report.byDay.map(d => d.date);
  }
  const max = Math.max(...dates.map(d => byDate.get(d)?.cost || 0), 0.01);
  const dense = dates.length > 14;

  const bars = dates.map((date, i) => {
    const day = byDate.get(date);
    const segments = day
      ? Object.entries(day.byAccount)
        .sort((a, b) => b[1] - a[1])
        .map(([id, cost]) => `<div class="cost-day-seg" style="height:${(cost / max) * 100}%;background:${_accountInfo(id).color}"></div>`)
        .join('')
      : '';
    const title = `${_dayLabel(date)} · ${_money(day?.cost || 0)}`;
    const showLabel = !dense || i % Math.ceil(dates.length / 10) === 0;
    return `
      <div class="cost-day" title="${escapeHtml(title)}">
        <div class="cost-day-value">${!dense && day ? escapeHtml(_money(day.cost)) : ''}</div>
        <div class="cost-day-bar">${segments}</div>
        <div class="cost-day-label">${showLabel ? escapeHtml(_dayLabel(date)) : ''}</div>
      </div>`;
  }).join('');

  return `
    <section class="cost-card">
      <h3>${escapeHtml(t('cost.sections.daily'))}</h3>
      <div class="cost-days ${dense ? 'dense' : ''}">${bars}</div>
    </section>`;
}

function _renderProjects() {
  const total = _report.totals.cost;
  const rows = _report.byProject.map(p => {
    const share = _percent(p.cost, total);
    const bound = p.boundAccountId ? _accountInfo(p.boundAccountId) : null;
    return `
      <tr>
        <td>
          <div class="cost-project-name">${escapeHtml(p.name)}</div>
          ${bound ? `<div class="cost-project-bound"><span class="cost-dot" style="background:${bound.color}"></span>${escapeHtml(t('cost.boundTo', { name: bound.name }))}</div>` : ''}
        </td>
        <td class="num">${escapeHtml(_money(p.cost))}</td>
        <td class="share">${_bar(share, 'var(--accent)')}<span>${share}%</span></td>
        <td class="num muted">${escapeHtml(_compact(p.tokens))}</td>
      </tr>`;
  }).join('');
  return `
    <section class="cost-card">
      <h3>${escapeHtml(t('cost.sections.projects'))}</h3>
      <table class="cost-table">
        <thead><tr>
          <th>${escapeHtml(t('cost.columns.project'))}</th>
          <th class="num">${escapeHtml(t('cost.columns.cost'))}</th>
          <th>${escapeHtml(t('cost.columns.share'))}</th>
          <th class="num">${escapeHtml(t('cost.columns.tokens'))}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function _renderModels() {
  const total = _report.totals.cost;
  const rows = _report.byModel.map(m => {
    const share = _percent(m.cost, total);
    const mark = m.estimatedPrice ? ` <span class="cost-estimated" title="${escapeHtml(t('cost.estimatedPrice'))}">*</span>` : '';
    return `
      <tr>
        <td>${escapeHtml(_modelLabel(m.model))}${mark}</td>
        <td class="num">${escapeHtml(_money(m.cost))}</td>
        <td class="share">${_bar(share, 'var(--purple)')}<span>${share}%</span></td>
        <td class="num muted">${escapeHtml(_compact(m.tokens))}</td>
      </tr>`;
  }).join('');
  return `
    <section class="cost-card">
      <h3>${escapeHtml(t('cost.sections.models'))}</h3>
      <table class="cost-table">
        <thead><tr>
          <th>${escapeHtml(t('cost.columns.model'))}</th>
          <th class="num">${escapeHtml(t('cost.columns.cost'))}</th>
          <th>${escapeHtml(t('cost.columns.share'))}</th>
          <th class="num">${escapeHtml(t('cost.columns.tokens'))}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function _renderNotes() {
  const notes = [t('cost.note.listPrice')];
  const { attribution, unpricedModels } = _report;
  if (attribution?.estimatedCost > 0.005 && (_report.accounts || []).length > 1) {
    notes.push(t('cost.note.estimated', {
      cost: _money(attribution.estimatedCost),
      date: _shortDate(attribution.trackedSince),
    }));
  }
  if (unpricedModels?.length) {
    notes.push(t('cost.note.unpriced', { models: unpricedModels.join(', ') }));
  }
  return `<div class="cost-notes">${notes.map(n => `<p>${escapeHtml(n)}</p>`).join('')}</div>`;
}

function _bindEvents() {
  if (!_container) return;
  _container.querySelector('[data-action="refresh"]')?.addEventListener('click', () => _load());
  _container.querySelectorAll('[data-period]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (_period === btn.dataset.period) return;
      _period = btn.dataset.period;
      _load();
    });
  });
  _container.querySelectorAll('[data-account]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (_accountFilter === btn.dataset.account) return;
      _accountFilter = btn.dataset.account;
      _load();
    });
  });
}

module.exports = { loadPanel, cleanup, periodRange };
