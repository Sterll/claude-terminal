/**
 * Data display block renderers: metrics, API, resource, config, command, links.
 */

const { escapeHtml, highlight } = require('../../../utils');
const { t } = require('../../../i18n');

// ── Link Cards ──

function renderLinksBlock(code) {
  const lines = code.split('\n').filter(l => l.trim());
  const cards = lines.map(line => {
    const parts = line.split('|').map(s => s.trim());
    if (!parts[0]) return null;
    return { title: parts[0], desc: parts[1] || '', url: parts[2] || parts[0] };
  }).filter(Boolean);

  if (cards.length === 0) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const linkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="20" height="20"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>';
  const extIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';

  return cards.map(card => {
    const href = card.url.startsWith('http') ? card.url : `https://${card.url}`;
    const displayUrl = card.url.replace(/^https?:\/\//, '');
    return `<a class="chat-link-card" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">`
      + `<div class="chat-link-card-icon">${linkIcon}</div>`
      + `<div class="chat-link-card-body">`
      + `<div class="chat-link-card-title">${escapeHtml(card.title)} ${extIcon}</div>`
      + (card.desc ? `<div class="chat-link-card-desc">${escapeHtml(card.desc)}</div>` : '')
      + `<div class="chat-link-card-url">${escapeHtml(displayUrl)}</div>`
      + `</div></a>`;
  }).join('');
}

// ── Metric Cards ──

function renderMetricsBlock(code) {
  const lines = code.split('\n').filter(l => l.trim());
  const metrics = lines.map(line => {
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 2) return null;
    return { label: parts[0], value: parts[1], trend: parts[2] || '', bar: parts[3] || '', color: parts[4] || 'accent' };
  }).filter(Boolean);

  if (metrics.length === 0) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const cardsHtml = metrics.map(m => {
    const trendClass = /^[+\u2191]/.test(m.trend) ? 'up' : /^[-\u2193]/.test(m.trend) ? 'down' : 'neutral';
    const trendHtml = m.trend ? `<div class="chat-metric-trend ${trendClass}">${escapeHtml(m.trend)}</div>` : '';
    const colorVar = m.color === 'accent' ? 'accent' : m.color;
    const barHtml = m.bar ? `<div class="chat-metric-bar"><div class="chat-metric-bar-fill" style="width:${escapeHtml(m.bar)};background:var(--${escapeHtml(colorVar)})"></div></div>` : '';
    return `<div class="chat-metric-card accent-${escapeHtml(m.color)}">`
      + `<div class="chat-metric-label">${escapeHtml(m.label)}</div>`
      + `<div class="chat-metric-value">${escapeHtml(m.value)}</div>`
      + trendHtml + barHtml
      + `</div>`;
  }).join('');

  return `<div class="chat-metrics-grid">${cardsHtml}</div>`;
}

// ── API Endpoint Card ──

function renderApiBlock(code) {
  const lines = code.split('\n');
  let method = '', url = '', description = '';
  const params = [], responses = [];
  let section = 'desc';

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!method && /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+/i.test(trimmed)) {
      const m = trimmed.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(.+)/i);
      if (m) { method = m[1].toUpperCase(); url = m[2]; continue; }
    }
    if (/^---\s*params?/i.test(trimmed)) { section = 'params'; continue; }
    if (/^---\s*resp/i.test(trimmed)) { section = 'responses'; continue; }

    if (section === 'desc' && trimmed && method) {
      description += (description ? ' ' : '') + trimmed;
    } else if (section === 'params' && trimmed) {
      const parts = trimmed.split('|').map(s => s.trim());
      if (parts.length >= 2) params.push({ name: parts[0], type: parts[1], required: (parts[2] || '').toLowerCase() === 'required', desc: parts[3] || '' });
    } else if (section === 'responses' && trimmed) {
      const parts = trimmed.split('|').map(s => s.trim());
      if (parts.length >= 2) responses.push({ status: parts[0], desc: parts[1] });
    }
  }

  if (!method) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const urlHtml = escapeHtml(url).replace(/\{(\w+)\}/g, '<span class="url-param">{$1}</span>');
  const descHtml = description ? `<div class="chat-api-desc">${escapeHtml(description)}</div>` : '';

  const paramsHtml = params.length > 0 ? `<div class="chat-api-params"><div class="chat-api-params-title">Parameters</div>`
    + params.map(p => `<div class="chat-api-param">`
      + `<span class="chat-api-param-name">${escapeHtml(p.name)}</span>`
      + `<span class="chat-api-param-type">${escapeHtml(p.type)}</span>`
      + (p.required ? '<span class="chat-api-param-required">required</span>' : '')
      + (p.desc ? `<span class="chat-api-param-desc">\u2014 ${escapeHtml(p.desc)}</span>` : '')
      + `</div>`).join('') + `</div>` : '';

  const sClass = (s) => { const n = parseInt(s); return n >= 500 ? 's5xx' : n >= 400 ? 's4xx' : n >= 200 ? 's2xx' : ''; };
  const responsesHtml = responses.length > 0 ? `<div class="chat-api-responses"><div class="chat-api-params-title">Responses</div>`
    + responses.map(r => `<div class="chat-api-response-item"><span class="chat-api-status ${sClass(r.status)}">${escapeHtml(r.status)}</span>${escapeHtml(r.desc)}</div>`).join('') + `</div>` : '';

  return `<div class="chat-api-card"><div class="chat-api-header"><span class="chat-api-method ${method.toLowerCase()}">${escapeHtml(method)}</span><span class="chat-api-url">${urlHtml}</span></div>${descHtml}${paramsHtml}${responsesHtml}</div>`;
}

// ── FiveM Resource Card ──

function renderResourceBlock(code) {
  const props = {};
  for (const line of code.split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)/);
    if (m) props[m[1].toLowerCase()] = m[2].trim();
  }

  const name = props.name || 'unknown';
  const version = props.version || '';
  const desc = props.description || props.desc || '';
  const status = (props.status || 'stopped').toLowerCase();
  const type = props.type || '';
  const author = props.author || '';
  const scripts = props.scripts || '';
  const deps = props.deps || props.dependencies || '';
  const error = props.error || '';

  const iconClass = type.includes('client') ? 'client' : type.includes('server') ? 'server' : 'shared';
  const icon = iconClass === 'client' ? '\uD83D\uDCE6' : iconClass === 'server' ? '\uD83D\uDD0C' : '\u2699\uFE0F';

  const statusMap = {
    started: '<div class="chat-resource-status started"><span class="status-dot"></span>Started</div>',
    error: '<div class="chat-resource-status error"><span class="status-dot"></span>Error</div>',
  };
  const statusHtml = statusMap[status] || '<div class="chat-resource-status stopped"><span class="status-dot"></span>Stopped</div>';

  const versionHtml = version ? ` <span class="chat-resource-version">${escapeHtml(version)}</span>` : '';
  const descHtml = desc ? `<div class="chat-resource-desc">${escapeHtml(desc)}</div>` : '';

  const metaItems = [];
  if (type) {
    const tags = type.split(',').map(t => t.trim()).map(t =>
      `<span class="chat-resource-tag ${t}">${escapeHtml(t)}</span>`
    ).join(' ');
    metaItems.push(['Type', tags]);
  }
  if (author) metaItems.push(['Author', escapeHtml(author)]);
  if (scripts) metaItems.push(['Scripts', escapeHtml(scripts)]);
  if (error) metaItems.push(['Error', `<span style="color:var(--danger);font-size:11px">${escapeHtml(error)}</span>`]);

  const metaHtml = metaItems.length > 0
    ? `<div class="chat-resource-body">${metaItems.map(([label, val]) =>
      `<div class="chat-resource-meta"><span class="chat-resource-meta-label">${label}</span><span class="chat-resource-meta-value">${val}</span></div>`
    ).join('')}</div>` : '';

  const depsHtml = deps
    ? `<div class="chat-resource-deps"><span class="chat-resource-deps-label">Deps</span>`
      + deps.split(',').map(d => `<span class="chat-resource-dep">${escapeHtml(d.trim())}</span>`).join('') + `</div>`
    : '';

  return `<div class="chat-resource-card">`
    + `<div class="chat-resource-header">`
    + `<div class="chat-resource-icon ${iconClass}">${icon}</div>`
    + `<div class="chat-resource-info"><div class="chat-resource-name">${escapeHtml(name)}${versionHtml}</div>${descHtml}</div>`
    + statusHtml + `</div>`
    + metaHtml + depsHtml + `</div>`;
}

// ── Config / Convars Block ──

function renderConfigBlock(code) {
  const lines = code.split('\n');
  let title = '', icon = '\u2699\uFE0F';
  const rows = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const titleMatch = trimmed.match(/^title:\s*(.+)/i);
    if (titleMatch) { title = titleMatch[1]; continue; }
    const iconMatch = trimmed.match(/^icon:\s*(.+)/i);
    if (iconMatch) { icon = iconMatch[1]; continue; }
    const parts = trimmed.split('|').map(s => s.trim());
    if (parts.length >= 2) {
      rows.push({ key: parts[0], value: parts[1], type: parts[2] || '', desc: parts[3] || '', badge: parts[4] || '' });
    }
  }

  if (rows.length === 0) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const headerHtml = title
    ? `<div class="chat-config-header"><span class="chat-config-header-icon">${escapeHtml(icon)}</span>${escapeHtml(title)}</div>`
    : '';

  const rowsHtml = rows.map(r => {
    const typeHtml = r.type ? `<span class="chat-config-type">${escapeHtml(r.type)}</span>` : '';
    const descHtml = r.desc ? `<span class="chat-config-desc">${escapeHtml(r.desc)}</span>` : '';
    const badgeHtml = r.badge ? `<span class="chat-config-badge ${escapeHtml(r.badge)}">${escapeHtml(r.badge)}</span>` : '';
    return `<div class="chat-config-row">`
      + `<span class="chat-config-key">${escapeHtml(r.key)}</span>`
      + `<span class="chat-config-value">${escapeHtml(r.value)}</span>`
      + typeHtml + descHtml + badgeHtml + `</div>`;
  }).join('');

  return `<div class="chat-config-block">${headerHtml}${rowsHtml}</div>`;
}

// ── Game Command Reference ──

function renderCommandBlock(code) {
  const lines = code.split('\n');
  let cmdName = '', permission = '', description = '', syntax = '';
  const params = [], examples = [];
  let section = 'meta';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^---\s*params?/i.test(trimmed)) { section = 'params'; continue; }
    if (/^---\s*examples?/i.test(trimmed)) { section = 'examples'; continue; }

    if (section === 'meta') {
      if (trimmed.startsWith('/') && !cmdName) { cmdName = trimmed; continue; }
      const permMatch = trimmed.match(/^perm(?:ission)?:\s*(.+)/i);
      if (permMatch) { permission = permMatch[1]; continue; }
      const descMatch = trimmed.match(/^desc(?:ription)?:\s*(.+)/i);
      if (descMatch) { description = descMatch[1]; continue; }
      const synMatch = trimmed.match(/^syntax:\s*(.+)/i);
      if (synMatch) { syntax = synMatch[1]; continue; }
    } else if (section === 'params') {
      const parts = trimmed.split('|').map(s => s.trim());
      if (parts.length >= 2) params.push({ name: parts[0], type: parts[1], desc: parts[2] || '' });
    } else if (section === 'examples') {
      const parts = trimmed.split('|').map(s => s.trim());
      examples.push({ code: parts[0], desc: parts[1] || '' });
    }
  }

  if (!cmdName) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const cmdParts = cmdName.match(/^(\/?)(.+)/);
  const prefix = cmdParts ? cmdParts[1] : '/';
  const name = cmdParts ? cmdParts[2] : cmdName;

  const permHtml = permission
    ? `<span class="chat-gcmd-perm"><span class="chat-gcmd-perm-icon">\uD83D\uDD12</span>${escapeHtml(permission)}</span>`
    : '';
  const descHtml = description ? `<div class="chat-gcmd-desc">${escapeHtml(description)}</div>` : '';

  let syntaxHtml = '';
  if (syntax) {
    const colored = escapeHtml(syntax)
      .replace(/&lt;(\w[\w\s|]*)&gt;/g, '<span class="syn-required">&lt;$1&gt;</span>')
      .replace(/\[([^\]]+)\]/g, '<span class="syn-optional">[$1]</span>')
      .replace(/^(\/?\w+)/, '<span class="syn-cmd">$1</span>');
    syntaxHtml = `<div class="chat-gcmd-syntax">${colored}</div>`;
  }

  const paramsHtml = params.length > 0
    ? `<div class="chat-gcmd-params-title">Parameters</div>`
    + params.map(p => `<div class="chat-gcmd-param">`
      + `<span class="chat-gcmd-param-name">${escapeHtml(p.name)}</span>`
      + `<span class="chat-gcmd-param-type">${escapeHtml(p.type)}</span>`
      + (p.desc ? `<span class="chat-gcmd-param-desc">\u2014 ${escapeHtml(p.desc)}</span>` : '')
      + `</div>`).join('') : '';

  const examplesHtml = examples.length > 0
    ? `<div class="chat-gcmd-example"><div class="chat-gcmd-example-title">Examples</div>`
    + examples.map(ex =>
      `<div class="chat-gcmd-example-code">${escapeHtml(ex.code)}</div>`
      + (ex.desc ? `<div class="chat-gcmd-example-desc">${escapeHtml(ex.desc)}</div>` : '')
    ).join('') + `</div>` : '';

  return `<div class="chat-gcmd-card">`
    + `<div class="chat-gcmd-header"><span class="chat-gcmd-name"><span class="cmd-prefix">${escapeHtml(prefix)}</span>${escapeHtml(name)}</span>${permHtml}</div>`
    + `<div class="chat-gcmd-body">${descHtml}${syntaxHtml}${paramsHtml}${examplesHtml}</div>`
    + `</div>`;
}

module.exports = {
  renderLinksBlock,
  renderMetricsBlock,
  renderApiBlock,
  renderResourceBlock,
  renderConfigBlock,
  renderCommandBlock,
};
