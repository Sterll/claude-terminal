/**
 * Layout/visual block renderers: file tree, terminal, timeline, compare, tabs, event flow.
 */

const { escapeHtml, highlight } = require('../../../utils');
const { t } = require('../../../i18n');

// ── File Tree ──

function renderFileTree(code) {
  const lines = code.split('\n').filter(l => l.trim());
  const items = [];

  const treeCharsRe = /[├└│─┬┤┘┐┌╭╰╮╯┊┆┃┈╌]/g;

  for (const line of lines) {
    const stripped = line.replace(treeCharsRe, ' ');
    const match = stripped.match(/^(\s*)(.*)/);
    if (!match) continue;

    const prefix = line.match(/^[\s├└│─┬┤┘┐┌╭╰╮╯┊┆┃┈╌]*/)?.[0] || '';
    const depth = Math.round(prefix.length / 4);

    let name = match[2].trim();
    if (!name) continue;

    let meta = '';
    const metaMatch = name.match(/^(.+?)\s{2,}(.+)$/);
    if (metaMatch) {
      name = metaMatch[1].trim();
      meta = metaMatch[2].trim();
    }

    const isDir = name.endsWith('/');
    items.push({ name, depth, isDir, meta });
  }

  const extIcons = {
    js: '<span class="ft-ext" style="color:#f7df1e">JS</span>',
    mjs: '<span class="ft-ext" style="color:#f7df1e">JS</span>',
    ts: '<span class="ft-ext" style="color:#3178c6">TS</span>',
    tsx: '<span class="ft-ext" style="color:#3178c6">TX</span>',
    jsx: '<span class="ft-ext" style="color:#61dafb">JX</span>',
    json: '<span class="ft-ext" style="color:#a8a8a8">{ }</span>',
    css: '<span class="ft-ext" style="color:#1572b6">CS</span>',
    scss: '<span class="ft-ext" style="color:#c6538c">SC</span>',
    html: '<span class="ft-ext" style="color:#e44d26">HT</span>',
    py: '<span class="ft-ext" style="color:#3776ab">PY</span>',
    lua: '<span class="ft-ext" style="color:#000080">LU</span>',
    md: '<span class="ft-ext" style="color:#888">MD</span>',
    yaml: '<span class="ft-ext" style="color:#cb171e">YM</span>',
    yml: '<span class="ft-ext" style="color:#cb171e">YM</span>',
    sh: '<span class="ft-ext" style="color:#4eaa25">SH</span>',
    sql: '<span class="ft-ext" style="color:#e38c00">SQ</span>',
    rs: '<span class="ft-ext" style="color:#dea584">RS</span>',
    go: '<span class="ft-ext" style="color:#00add8">GO</span>',
    java: '<span class="ft-ext" style="color:#b07219">JV</span>',
    rb: '<span class="ft-ext" style="color:#cc342d">RB</span>',
  };
  const defaultFileIcon = '<span class="ft-ext" style="color:#888">&#9632;</span>';

  function getFileIcon(name) {
    const ext = name.split('.').pop()?.toLowerCase();
    return extIcons[ext] || defaultFileIcon;
  }

  const chevronSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';

  const rowsHtml = items.map(item => {
    const indent = item.depth > 0 ? `<span class="ft-indent" style="width:${item.depth * 18}px"></span>` : '';
    const toggle = item.isDir
      ? `<span class="ft-toggle">${chevronSvg}</span>`
      : '<span class="ft-toggle-placeholder"></span>';
    const icon = item.isDir
      ? '<span class="ft-icon">&#128194;</span>'
      : `<span class="ft-icon-ext">${getFileIcon(item.name)}</span>`;
    const nameClass = item.isDir ? 'ft-name folder' : 'ft-name';
    const metaHtml = item.meta ? `<span class="ft-meta">${escapeHtml(item.meta)}</span>` : '';
    const dirAttr = item.isDir ? ' data-ft-dir' : '';

    return `<div class="ft-item${item.isDir ? ' ft-dir' : ''}" data-ft-depth="${item.depth}"${dirAttr}>${indent}${toggle}${icon}<span class="${nameClass}">${escapeHtml(item.name)}</span>${metaHtml}</div>`;
  }).join('');

  return `<div class="chat-filetree">`
    + `<div class="chat-filetree-header"><span class="chat-filetree-label">`
    + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`
    + `File Tree</span></div>`
    + `<div class="chat-filetree-body">${rowsHtml}</div></div>`;
}

// ── Terminal Output ──

function renderTerminalBlock(code) {
  const lines = code.split('\n');
  let exitCode = null;
  let shell = 'bash';

  const metaLines = [];
  const bodyLines = [];
  for (const line of lines) {
    const exitMatch = line.match(/^exit:\s*(\d+)\s*$/i);
    const shellMatch = line.match(/^shell:\s*(.+)\s*$/i);
    if (exitMatch && bodyLines.length === 0) { exitCode = parseInt(exitMatch[1], 10); metaLines.push(line); continue; }
    if (shellMatch && bodyLines.length === 0) { shell = shellMatch[1].trim(); metaLines.push(line); continue; }
    bodyLines.push(line);
  }

  if (exitCode === null) {
    const hasError = bodyLines.some(l => /\b(error|fail|ERR!)\b/i.test(l) || l.trim().startsWith('FAIL'));
    exitCode = hasError ? 1 : 0;
  }

  const exitClass = exitCode === 0 ? 'exit-ok' : 'exit-err';

  const contentHtml = bodyLines.map(line => {
    const escaped = escapeHtml(line);
    if (/^\s*\$\s/.test(line)) {
      const [, prompt, cmd] = line.match(/^(\s*\$\s)(.*)/) || [null, '$ ', line];
      return `<div><span class="term-prompt">${escapeHtml(prompt)}</span><span class="term-cmd">${escapeHtml(cmd)}</span></div>`;
    }
    if (/^\s*>\s/.test(line) && !/^\s*>\s*$/.test(line)) {
      const [, prompt, cmd] = line.match(/^(\s*>\s)(.*)/) || [null, '> ', line];
      return `<div><span class="term-prompt">${escapeHtml(prompt)}</span><span class="term-cmd">${escapeHtml(cmd)}</span></div>`;
    }
    if (/\b(error|ERR!|FAIL|fatal|panic)\b/i.test(line)) {
      return `<div><span class="term-error">${escaped}</span></div>`;
    }
    if (/\b(warn|warning|WARN)\b/i.test(line)) {
      return `<div><span class="term-warn">${escaped}</span></div>`;
    }
    if (/^[-=]{3,}$/.test(line.trim())) {
      return '<span class="term-separator"></span>';
    }
    if (/^\s*#/.test(line) || /^\s*\/\//.test(line)) {
      return `<div><span class="term-dim">${escaped}</span></div>`;
    }
    if (!line.trim()) return '<div>&nbsp;</div>';
    return `<div><span class="term-output">${escaped}</span></div>`;
  }).join('');

  return `<div class="chat-terminal-block">`
    + `<div class="chat-terminal-header">`
    + `<span class="terminal-icon">&#10095;</span>`
    + `<span class="terminal-shell">${escapeHtml(shell)}</span>`
    + `<span class="terminal-exit ${exitClass}">exit ${exitCode}</span>`
    + `</div>`
    + `<div class="chat-terminal-body">${contentHtml}</div>`
    + `</div>`;
}

// ── Timeline / Steps ──

function renderTimelineBlock(code) {
  const lines = code.split('\n');
  let title = '';
  const steps = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const titleMatch = trimmed.match(/^title:\s*(.+)/i);
    if (titleMatch) { title = titleMatch[1]; continue; }
    const stepMatch = trimmed.match(/^\[([x>\ ])\]\s*(.+)/i);
    if (stepMatch) {
      const status = stepMatch[1] === 'x' ? 'done' : stepMatch[1] === '>' ? 'active' : 'pending';
      const parts = stepMatch[2].split('|').map(s => s.trim());
      steps.push({ title: parts[0], desc: parts[1] || '', status });
    }
  }

  if (steps.length === 0) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const titleHtml = title
    ? `<div class="chat-timeline-header"><span class="chat-timeline-label">${escapeHtml(title)}</span></div>`
    : '';

  const badgeLabels = { done: 'Done', active: 'In Progress', pending: 'Pending' };
  const stepsHtml = steps.map((step, i) => {
    const lineEl = i < steps.length - 1 ? '<div class="tl-line"></div>' : '';
    const descHtml = step.desc ? `<div class="tl-desc">${escapeHtml(step.desc)}</div>` : '';
    return `<div class="tl-step ${step.status}">`
      + `<div class="tl-rail"><div class="tl-dot ${step.status}"></div>${lineEl}</div>`
      + `<div class="tl-content"><div class="tl-title">${escapeHtml(step.title)} <span class="tl-badge ${step.status}">${badgeLabels[step.status]}</span></div>${descHtml}</div>`
      + `</div>`;
  }).join('');

  return `<div class="chat-timeline">${titleHtml}<div class="chat-timeline-body">${stepsHtml}</div></div>`;
}

// ── Comparison (Before/After) ──

function renderCompareBlock(code) {
  const lines = code.split('\n');
  let title = '';
  let beforeCode = '';
  let afterCode = '';
  let section = 'none';

  for (const line of lines) {
    const trimmed = line.trim();
    const titleMatch = trimmed.match(/^title:\s*(.+)/i);
    if (titleMatch && section === 'none') { title = titleMatch[1]; continue; }
    if (/^---\s*before\s*$/i.test(trimmed)) { section = 'before'; continue; }
    if (/^---\s*after\s*$/i.test(trimmed)) { section = 'after'; continue; }
    if (section === 'before') beforeCode += line + '\n';
    if (section === 'after') afterCode += line + '\n';
  }

  beforeCode = beforeCode.trimEnd();
  afterCode = afterCode.trimEnd();

  const titleHtml = title
    ? `<div class="chat-compare-header"><span class="chat-compare-label">${escapeHtml(title)}</span></div>`
    : '';

  const beforeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
  const afterIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';

  return `<div class="chat-compare">`
    + titleHtml
    + `<div class="chat-compare-body">`
    + `<div class="chat-compare-side before"><div class="chat-compare-side-header">${beforeIcon} Before</div><div class="chat-compare-code"><pre><code>${escapeHtml(beforeCode)}</code></pre></div></div>`
    + `<div class="chat-compare-side after"><div class="chat-compare-side-header">${afterIcon} After</div><div class="chat-compare-code"><pre><code>${escapeHtml(afterCode)}</code></pre></div></div>`
    + `</div></div>`;
}

// ── Tabs Block ──

function renderTabsBlock(code) {
  const lines = code.split('\n');
  const tabs = [];
  let currentTab = null;

  for (const line of lines) {
    const tabMatch = line.match(/^---\s*(.+?)\s*$/);
    if (tabMatch) {
      if (currentTab) tabs.push(currentTab);
      currentTab = { title: tabMatch[1], content: '' };
      continue;
    }
    if (currentTab) currentTab.content += line + '\n';
  }
  if (currentTab) tabs.push(currentTab);

  if (tabs.length === 0) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const id = 'tabs-' + Math.random().toString(36).slice(2, 8);

  const buttonsHtml = tabs.map((tab, i) =>
    `<button class="chat-tab-btn${i === 0 ? ' active' : ''}" data-tab-idx="${i}" data-tabs-id="${id}">${escapeHtml(tab.title)}</button>`
  ).join('');

  const langNameToExt = {
    javascript: 'js', typescript: 'ts', python: 'py', rust: 'rs',
    ruby: 'rb', golang: 'go', bash: 'sh', shell: 'sh', markdown: 'md',
  };

  const panelsHtml = tabs.map((tab, i) => {
    const content = tab.content.trimEnd();
    const raw = tab.title.toLowerCase().replace(/[^a-z+#]/g, '');
    const lang = langNameToExt[raw] || raw;
    const highlighted = lang ? highlight(content, lang) : escapeHtml(content);
    return `<div class="chat-tab-panel${i === 0 ? ' active' : ''}" data-tab-idx="${i}" data-tabs-id="${id}"><pre><code>${highlighted}</code></pre></div>`;
  }).join('');

  return `<div class="chat-tabs-block" data-tabs-id="${id}">`
    + `<div class="chat-tabs-nav">${buttonsHtml}</div>`
    + panelsHtml
    + `</div>`;
}

// ── Event Flow Diagram ──

function renderEventFlowBlock(code) {
  const lines = code.split('\n');
  let title = '';
  const steps = [];
  const participants = {
    client: { color: '#3b82f6', label: 'Client', cls: 'c' },
    server: { color: '#a855f7', label: 'Server', cls: 's' },
    nui: { color: '#22c55e', label: 'NUI', cls: 'n' },
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const titleMatch = trimmed.match(/^title:\s*(.+)/i);
    if (titleMatch) { title = titleMatch[1]; continue; }
    const arrowMatch = trimmed.match(/^(\w+)\s*(-->|->)\s*(\w+)\s*\|\s*(.+)/i);
    if (arrowMatch) {
      steps.push({ type: 'arrow', from: arrowMatch[1].toLowerCase(), dashed: arrowMatch[2] === '-->', to: arrowMatch[3].toLowerCase(), label: arrowMatch[4] });
      continue;
    }
    const handlerMatch = trimmed.match(/^(\w+)\s*\|\s*(.+)/i);
    if (handlerMatch) {
      steps.push({ type: 'handler', participant: handlerMatch[1].toLowerCase(), label: handlerMatch[2] });
    }
  }

  if (steps.length === 0) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const titleHtml = title ? `<div class="chat-ef-title">${escapeHtml(title)}</div>` : '';

  const usedP = new Set();
  steps.forEach(s => {
    if (s.type === 'arrow') { usedP.add(s.from); usedP.add(s.to); }
    if (s.type === 'handler') usedP.add(s.participant);
  });
  const pList = ['client', 'server', 'nui'].filter(p => usedP.has(p));

  const headsHtml = pList.map(p => {
    const info = participants[p] || { cls: 'c', label: p };
    return `<span class="chat-ef-head ${info.cls}">${escapeHtml(info.label)}</span>`;
  }).join('');

  let stepNum = 0;
  const stepsHtml = steps.map(step => {
    if (step.type === 'handler') {
      const info = participants[step.participant] || { cls: 'c' };
      return `<div class="chat-ef-step handler"><span class="chat-ef-badge ${info.cls}">${escapeHtml(step.label)}</span></div>`;
    }
    stepNum++;
    const fromCls = (participants[step.from] || { cls: 'c' }).cls;
    const toCls = (participants[step.to] || { cls: 'c' }).cls;
    const fromLabel = (participants[step.from] || { label: step.from }).label;
    const toLabel = (participants[step.to] || { label: step.to }).label;
    const dashClass = step.dashed ? ' dashed' : '';
    return `<div class="chat-ef-step arrow${dashClass}">`
      + `<span class="chat-ef-num">${stepNum}</span>`
      + `<span class="chat-ef-from ${fromCls}">${escapeHtml(fromLabel)}</span>`
      + `<span class="chat-ef-arrow${dashClass}">\u2192</span>`
      + `<span class="chat-ef-to ${toCls}">${escapeHtml(toLabel)}</span>`
      + `<span class="chat-ef-label">${escapeHtml(step.label)}</span>`
      + `</div>`;
  }).join('');

  return `<div class="chat-event-flow">${titleHtml}<div class="chat-ef-heads">${headsHtml}</div><div class="chat-ef-body">${stepsHtml}</div></div>`;
}

module.exports = {
  renderFileTree,
  renderTerminalBlock,
  renderTimelineBlock,
  renderCompareBlock,
  renderTabsBlock,
  renderEventFlowBlock,
};
