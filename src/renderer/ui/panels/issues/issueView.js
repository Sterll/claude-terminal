/**
 * Tickets screen, the pure half: what the user picked → the query sent to
 * main, issues → groups, and the HTML of rows, groups and the detail pane.
 * No IPC and no event wiring here, so all of it is testable on its own.
 *
 * Everything an issue carries comes from the network and has already been
 * through `src/shared/issue-trackers.js`; colours are known to be `#rrggbb`
 * and URLs https. Text is still escaped here like any other untrusted string.
 */

'use strict';

const { t, getCurrentLanguage } = require('../../../i18n');
const { escapeHtml } = require('../../../utils');
const { STATE_CATEGORIES, PRIORITY_LEVELS } = require('../../../../shared/issue-trackers');

/** What a first visit shows: every ticket still open. */
const DEFAULT_VIEW = Object.freeze({
  connectionId: null,
  mine: null,
  text: '',
  status: ['cat:backlog', 'cat:todo', 'cat:started'],
  assigneeIds: [],
  priorities: [],
  labelIds: [],
  facets: {},
  groupBy: 'status',
  sort: 'updated',
  layout: 'list',
});

const PAGE_SIZE = 50;

/** A saved view from settings, with anything unusable put back to its default. */
function restoreView(saved) {
  const v = saved && typeof saved === 'object' ? saved : {};
  const list = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string' || typeof s === 'number') : null);
  return {
    connectionId: typeof v.connectionId === 'string' ? v.connectionId : null,
    mine: ['assigned', 'created', 'subscribed'].includes(v.mine) ? v.mine : null,
    text: '',
    status: list(v.status) || [...DEFAULT_VIEW.status],
    assigneeIds: list(v.assigneeIds) || [],
    priorities: (list(v.priorities) || []).filter((p) => PRIORITY_LEVELS.includes(p)),
    labelIds: list(v.labelIds) || [],
    facets: v.facets && typeof v.facets === 'object' && !Array.isArray(v.facets) ? { ...v.facets } : {},
    groupBy: typeof v.groupBy === 'string' ? v.groupBy : DEFAULT_VIEW.groupBy,
    sort: ['updated', 'created', 'priority', 'due'].includes(v.sort) ? v.sort : DEFAULT_VIEW.sort,
    layout: v.layout === 'board' ? 'board' : 'list',
  };
}

// ── Status options ───────────────────────────────────────────────────────────

/**
 * The Status menu: each category, and under it the distinct state names. Two
 * teams' "In Progress" are one entry, since the screen spans every team.
 *
 * @returns {Array<{ category: string, states: Array<{ key: string, name: string, color: string|null, ids: string[] }> }>}
 */
function statusOptions(metadata) {
  const byCategory = new Map(STATE_CATEGORIES.map((c) => [c, new Map()]));
  for (const s of metadata?.states || []) {
    const names = byCategory.get(s.category);
    const entry = names.get(s.name) || { key: `state:${s.category}:${s.name}`, name: s.name, color: s.color, ids: [], position: s.position };
    entry.ids.push(s.id);
    entry.position = Math.min(entry.position, s.position);
    names.set(s.name, entry);
  }
  return STATE_CATEGORIES
    .map((category) => ({
      category,
      states: [...byCategory.get(category).values()]
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
        .map(({ key, name, color, ids }) => ({ key, name, color, ids })),
    }))
    .filter((group) => group.states.length);
}

/**
 * The view as the provider-neutral query. A whole category is sent as a
 * category, a single state as every state id that carries its name.
 */
function buildQuery(view, metadata) {
  const stateCategories = [];
  const stateIds = [];
  const options = statusOptions(metadata);
  for (const key of view.status) {
    if (key.startsWith('cat:')) {
      stateCategories.push(key.slice(4));
      continue;
    }
    for (const group of options) {
      const state = group.states.find((s) => s.key === key);
      if (state) stateIds.push(...state.ids);
    }
  }
  return {
    text: view.text,
    mine: view.mine,
    stateCategories,
    stateIds,
    assigneeIds: view.assigneeIds,
    priorities: view.priorities,
    labelIds: view.labelIds,
    facets: view.facets,
    sort: view.sort,
    limit: PAGE_SIZE,
  };
}

/** Whether the view is still the one a first visit shows (grouping and sort aside). */
function isDefaultView(view) {
  const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  return !view.mine && !view.text && same(view.status, DEFAULT_VIEW.status)
    && !view.assigneeIds.length && !view.priorities.length && !view.labelIds.length
    && !Object.values(view.facets).some((f) => Array.isArray(f) && f.length);
}

/** How many filters narrow the list, the quick "mine" chip and the search aside. */
function activeFilterCount(view) {
  return (view.status.length ? 1 : 0)
    + (view.assigneeIds.length ? 1 : 0)
    + (view.priorities.length ? 1 : 0)
    + (view.labelIds.length ? 1 : 0)
    + Object.values(view.facets).filter((v) => Array.isArray(v) && v.length).length;
}

// ── Grouping ─────────────────────────────────────────────────────────────────

function priorityLabel(level) {
  switch (level) {
    case 1: return t('tickets.priority.urgent');
    case 2: return t('tickets.priority.high');
    case 3: return t('tickets.priority.medium');
    case 4: return t('tickets.priority.low');
    default: return t('tickets.priority.none');
  }
}

function categoryLabel(category) {
  switch (category) {
    case 'backlog': return t('tickets.category.backlog');
    case 'todo': return t('tickets.category.todo');
    case 'started': return t('tickets.category.started');
    case 'done': return t('tickets.category.done');
    default: return t('tickets.category.canceled');
  }
}

/** The ways a list can be grouped, given what this tracker reports. */
function groupByOptions(metadata, capabilities) {
  const options = [
    { id: 'status', label: t('tickets.groupBy.status') },
    { id: 'assignee', label: t('tickets.groupBy.assignee') },
  ];
  if (capabilities?.priority) options.push({ id: 'priority', label: t('tickets.groupBy.priority') });
  options.push({ id: 'container', label: containerLabel(metadata) });
  const container = containerFacet(metadata);
  for (const facet of metadata?.facets || []) {
    if (facet !== container) options.push({ id: `facet:${facet.id}`, label: facetLabel(facet) });
  }
  options.push({ id: 'none', label: t('tickets.groupBy.none') });
  return options;
}

/**
 * The facet that names an issue's container (a Linear team, a GitHub
 * repository, a Jira project), so grouping by container can borrow its word.
 */
const CONTAINER_FACETS = ['team', 'repository', 'project'];

function containerFacet(metadata) {
  const facets = metadata?.facets || [];
  for (const id of CONTAINER_FACETS) {
    const facet = facets.find((f) => f.id === id);
    if (facet) return facet;
  }
  return null;
}

function containerLabel(metadata) {
  const facet = containerFacet(metadata);
  return facet ? facetLabel(facet) : t('tickets.groupBy.container');
}

/** A facet's label: the app's own word for the common ids, the adapter's otherwise. */
function facetLabel(facet) {
  switch (facet.id) {
    case 'team': return t('tickets.facets.team');
    case 'project': return t('tickets.facets.project');
    case 'cycle': return t('tickets.facets.cycle');
    case 'sprint': return t('tickets.facets.sprint');
    case 'milestone': return t('tickets.facets.milestone');
    case 'epic': return t('tickets.facets.epic');
    case 'repository': return t('tickets.facets.repository');
    default: return facet.label;
  }
}

/**
 * @returns {Array<{ key: string, label: string, color?: string|null, person?: object, issues: object[] }>}
 */
function groupIssues(issues, groupBy, metadata) {
  if (groupBy === 'none') return [{ key: 'all', label: '', issues }];

  const groups = new Map();
  const add = (key, make, issue) => {
    if (!groups.has(key)) groups.set(key, { ...make(), key, issues: [] });
    groups.get(key).issues.push(issue);
  };
  // A merged state ("In Progress" across teams) sorts by its lowest position,
  // the same rule the Status menu uses, so the list and the menu agree.
  const namePosition = new Map();
  for (const s of metadata?.states || []) {
    const k = `${s.category}:${s.name}`;
    namePosition.set(k, Math.min(namePosition.get(k) ?? Infinity, s.position));
  }

  for (const issue of issues) {
    if (groupBy === 'status') {
      const { category, name, color } = issue.state;
      const k = `${category}:${name}`;
      add(k, () => ({
        label: name, color, order: [STATE_CATEGORIES.indexOf(category), namePosition.get(k) ?? 99, name],
      }), issue);
    } else if (groupBy === 'assignee') {
      const a = issue.assignee;
      add(a ? `p:${a.id}` : 'p:none', () => ({
        label: a ? a.name : t('tickets.groupBy.noAssignee'), person: a, order: [a ? 0 : 1, a ? a.name : ''],
      }), issue);
    } else if (groupBy === 'priority') {
      const p = issue.priority;
      add(`pr:${p}`, () => ({ label: priorityLabel(p), priority: p, order: [p ? p : 5] }), issue);
    } else if (groupBy === 'container') {
      const c = issue.container;
      add(c ? `c:${c.id}` : 'c:none', () => ({ label: c ? c.name : t('tickets.groupBy.noValue'), order: [c ? 0 : 1, c ? c.name : ''] }), issue);
    } else if (groupBy.startsWith('facet:')) {
      const value = issue.facets[groupBy.slice(6)];
      add(value ? `f:${value}` : 'f:none', () => ({ label: value || t('tickets.groupBy.noValue'), order: [value ? 0 : 1, value || ''] }), issue);
    } else {
      add('all', () => ({ label: '', order: [0] }), issue);
    }
  }

  const compare = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] === b[i]) continue;
      if (typeof a[i] === 'number' && typeof b[i] === 'number') return a[i] - b[i];
      return String(a[i] ?? '').localeCompare(String(b[i] ?? ''));
    }
    return 0;
  };
  return [...groups.values()]
    .sort((a, b) => compare(a.order, b.order))
    .map(({ order, ...group }) => group);
}

// ── Board ────────────────────────────────────────────────────────────────────

/**
 * The board's columns. One team on screen (the container facet narrowed to
 * one, or every listed ticket in the same team): that team's real states, in
 * its workflow order. Several teams, or states shared by the whole workspace:
 * the categories, since only they line up, and only those the tracker uses.
 *
 * @returns {{ mode: 'states'|'categories', containerId: string|null,
 *   columns: Array<{ key: string, label: string, category: string, color?: string|null, stateId?: string, issues: object[] }> }}
 */
function boardColumns(issues, metadata, viewState) {
  const states = metadata?.states || [];
  const picked = viewState?.facets?.[containerFacet(metadata)?.id];
  let containerId = Array.isArray(picked) && picked.length === 1 ? picked[0] : null;
  if (!containerId) {
    const ids = new Set(issues.map((i) => i.container?.id).filter(Boolean));
    if (ids.size === 1) containerId = [...ids][0];
  }
  const teamStates = containerId ? states.filter((st) => st.containerId === containerId) : [];

  if (teamStates.length) {
    const columns = teamStates
      .slice()
      .sort((a, b) => STATE_CATEGORIES.indexOf(a.category) - STATE_CATEGORIES.indexOf(b.category) || a.position - b.position)
      .map((st) => ({ key: `state:${st.id}`, label: st.name, category: st.category, color: st.color, stateId: st.id, issues: [] }));
    for (const issue of issues) columns.find((c) => c.stateId === issue.state.id)?.issues.push(issue);
    return { mode: 'states', containerId, columns };
  }

  // Only the categories this tracker has a state in: a ticket could never be
  // dropped on the others (a GitHub-like tracker has open and closed, no more).
  const used = new Set(states.map((st) => st.category));
  const columns = STATE_CATEGORIES
    .filter((category) => !used.size || used.has(category))
    .map((category) => ({ key: `cat:${category}`, label: categoryLabel(category), category, issues: [] }));
  for (const issue of issues) columns.find((c) => c.category === issue.state.category)?.issues.push(issue);
  return { mode: 'categories', containerId: null, columns };
}

/**
 * The state a ticket takes when dropped on a column: the column's own state,
 * or in category mode the first state of the ticket's team in that category
 * (any state in it, when the tracker's states belong to no team).
 * Null when the drop changes nothing or the team has no such state.
 */
function dropTargetState(issue, column, metadata) {
  if (column.stateId) return column.stateId === issue.state.id ? null : column.stateId;
  if (issue.state.category === column.category) return null;
  const candidates = (metadata?.states || [])
    .filter((st) => st.category === column.category && (!issue.container || !st.containerId || st.containerId === issue.container.id))
    .sort((a, b) => a.position - b.position);
  return candidates[0]?.id || null;
}

/** The states a ticket can be moved to by hand: those of its own team. */
function statesForIssue(issue, metadata) {
  const states = (metadata?.states || []).filter((st) => !issue.container || !st.containerId || st.containerId === issue.container.id);
  return states.slice().sort((a, b) => STATE_CATEGORIES.indexOf(a.category) - STATE_CATEGORIES.indexOf(b.category) || a.position - b.position);
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function relativeTime(iso, now = Date.now()) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const diff = (ms - now) / 1000;
  const units = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3_600], ['minute', 60]];
  let rtf;
  try {
    rtf = new Intl.RelativeTimeFormat(getCurrentLanguage() || 'en', { numeric: 'auto', style: 'short' });
  } catch {
    rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' });
  }
  for (const [unit, seconds] of units) {
    if (Math.abs(diff) >= seconds) return rtf.format(Math.round(diff / seconds), unit);
  }
  return rtf.format(0, 'second');
}

function initials(name) {
  return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

function avatarHtml(person, extraClass = '') {
  if (!person) return `<span class="issue-avatar issue-avatar-empty ${extraClass}" title="${escapeHtml(t('tickets.groupBy.noAssignee'))}"></span>`;
  const title = `title="${escapeHtml(person.name)}"`;
  if (person.avatarUrl) return `<img class="issue-avatar ${extraClass}" src="${escapeHtml(person.avatarUrl)}" alt="" ${title}>`;
  return `<span class="issue-avatar ${extraClass}" ${title}>${escapeHtml(initials(person.name))}</span>`;
}

/** Linear-style priority glyph: bars for high to low, a mark for urgent, dashes for none. */
function priorityIcon(level) {
  const label = escapeHtml(priorityLabel(level));
  if (level == null) return '<span class="issue-priority" aria-hidden="true"></span>';
  if (level === 1) {
    return `<span class="issue-priority" data-priority="1" title="${label}"><svg viewBox="0 0 16 16" aria-label="${label}"><rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor"/><path d="M8 4v5M8 11.5v.5" style="stroke: var(--bg-primary)" stroke-width="2" stroke-linecap="round"/></svg></span>`;
  }
  if (level === 0) {
    return `<span class="issue-priority" data-priority="0" title="${label}"><svg viewBox="0 0 16 16" aria-label="${label}"><path d="M2 8h2.5M6.75 8h2.5M11.5 8H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>`;
  }
  const filled = 5 - level;
  const bar = (i) => `<rect x="${2 + i * 4.5}" y="${11 - i * 3.5}" width="3" height="${3 + i * 3.5}" rx="1" fill="currentColor" opacity="${i < filled ? 1 : 0.3}"/>`;
  return `<span class="issue-priority" data-priority="${level}" title="${label}"><svg viewBox="0 0 16 16" aria-label="${label}">${bar(0)}${bar(1)}${bar(2)}</svg></span>`;
}

function stateDot(state) {
  const color = state.color ? ` style="--state-color: ${state.color}"` : '';
  return `<span class="issue-state" data-category="${escapeHtml(state.category)}"${color} title="${escapeHtml(state.name)}"></span>`;
}

function labelsHtml(labels, max = 2) {
  if (!labels.length) return '';
  const shown = labels.slice(0, max).map((l) => {
    const color = l.color ? ` style="--label-color: ${l.color}"` : '';
    return `<span class="issue-label"${color}>${escapeHtml(l.name)}</span>`;
  }).join('');
  const more = labels.length > max ? `<span class="issue-label issue-label-more">+${labels.length - max}</span>` : '';
  return `<span class="issue-labels">${shown}${more}</span>`;
}

/** "2 sessions": how many Claude sessions this ticket is linked to. */
function sessionsHtml(count) {
  if (!count) return '';
  const label = t('tickets.panel.sessions', { count });
  return `<span class="issue-sessions" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

function rowHtml(issue, { selected = false, now, sessions = 0 } = {}) {
  const facet = issue.facets.cycle || issue.facets.sprint || issue.facets.milestone || '';
  return `
    <div class="issue-row${selected ? ' selected' : ''}" role="row" tabindex="0" data-ref="${escapeHtml(issue.ref)}" data-key="${escapeHtml(issue.key)}">
      ${priorityIcon(issue.priority)}
      <span class="issue-key">${escapeHtml(issue.key)}</span>
      ${stateDot(issue.state)}
      <span class="issue-title">${escapeHtml(issue.title)}</span>
      ${labelsHtml(issue.labels)}
      ${sessionsHtml(sessions)}
      ${facet ? `<span class="issue-facet">${escapeHtml(facet)}</span>` : ''}
      ${issue.dueDate ? `<span class="issue-due" title="${escapeHtml(t('tickets.detail.due'))}">${escapeHtml(issue.dueDate)}</span>` : ''}
      ${avatarHtml(issue.assignee)}
      <span class="issue-updated" title="${escapeHtml(issue.updatedAt || '')}">${escapeHtml(issue.updatedAt ? relativeTime(issue.updatedAt, now) : '')}</span>
    </div>`;
}

function groupHeaderIcon(group) {
  if (group.person !== undefined) return avatarHtml(group.person, 'issue-avatar-sm');
  if (group.priority !== undefined) return priorityIcon(group.priority);
  if (group.color !== undefined) return stateDot({ color: group.color, category: '', name: group.label });
  return '';
}

function groupsHtml(groups, { selectedRef = null, collapsed = new Set(), now, sessionCounts = {} } = {}) {
  return groups.map((group) => {
    const isCollapsed = collapsed.has(group.key);
    const header = group.label
      ? `<button type="button" class="issue-group-header" data-group="${escapeHtml(group.key)}" aria-expanded="${!isCollapsed}">
          <svg class="issue-group-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5z" fill="currentColor"/></svg>
          ${groupHeaderIcon(group)}
          <span class="issue-group-label">${escapeHtml(group.label)}</span>
          <span class="issue-group-count">${group.issues.length}</span>
        </button>`
      : '';
    const rows = isCollapsed ? '' : group.issues.map((issue) => rowHtml(issue, { selected: issue.ref === selectedRef, now, sessions: sessionCounts[issue.ref] || 0 })).join('');
    return `<section class="issue-group" data-group="${escapeHtml(group.key)}">${header}<div class="issue-group-rows" role="rowgroup">${rows}</div></section>`;
  }).join('');
}

function cardHtml(issue, { selected = false, draggable = false, sessions = 0 } = {}) {
  const facet = issue.facets.cycle || issue.facets.sprint || issue.facets.milestone || '';
  return `
    <div class="issue-card${selected ? ' selected' : ''}" tabindex="0" data-ref="${escapeHtml(issue.ref)}" data-key="${escapeHtml(issue.key)}"${draggable ? ' draggable="true"' : ''}>
      <div class="issue-card-top">
        <span class="issue-key">${escapeHtml(issue.key)}</span>
        ${avatarHtml(issue.assignee, 'issue-avatar-sm')}
      </div>
      <div class="issue-card-title">${escapeHtml(issue.title)}</div>
      <div class="issue-card-meta">
        ${priorityIcon(issue.priority)}
        ${labelsHtml(issue.labels, 2)}
        ${sessionsHtml(sessions)}
        ${facet ? `<span class="issue-facet">${escapeHtml(facet)}</span>` : ''}
        ${issue.dueDate ? `<span class="issue-due">${escapeHtml(issue.dueDate)}</span>` : ''}
      </div>
    </div>`;
}

function boardHtml(board, { selectedRef = null, draggable = false, sessionCounts = {} } = {}) {
  return `<div class="issues-board" data-mode="${board.mode}">${board.columns.map((col) => `
    <section class="issues-board-column" data-column="${escapeHtml(col.key)}" data-category="${escapeHtml(col.category)}">
      <header class="issues-board-column-head">
        ${stateDot({ color: col.color ?? null, category: col.category, name: col.label })}
        <span class="issues-board-column-label">${escapeHtml(col.label)}</span>
        <span class="issue-group-count">${col.issues.length}</span>
      </header>
      <div class="issues-board-cards">
        ${col.issues.length
    ? col.issues.map((issue) => cardHtml(issue, { selected: issue.ref === selectedRef, draggable, sessions: sessionCounts[issue.ref] || 0 })).join('')
    : `<div class="issues-board-empty">${escapeHtml(draggable ? t('tickets.board.dropHere') : t('tickets.board.empty'))}</div>`}
      </div>
    </section>`).join('')}</div>`;
}

function propHtml(label, value) {
  return value ? `<div class="issue-prop"><span class="issue-prop-label">${escapeHtml(label)}</span><span class="issue-prop-value">${value}</span></div>` : '';
}

/**
 * The detail pane. `renderMarkdown` turns the description and comments into
 * HTML: it is MarkdownRenderer, which sanitises with DOMPurify.
 */
/** A property value, as a button opening its menu when the tracker lets it change. */
function editable(field, html, editableFields) {
  if (!editableFields?.[field]) return html;
  return `<button type="button" class="issue-prop-edit" data-edit="${field}" aria-haspopup="menu" title="${escapeHtml(t('tickets.detail.edit'))}">${html}</button>`;
}

function detailHtml(issue, { renderMarkdown, providerName, metadata, editableFields = null, canStart = false }) {
  // A tracker whose container is also a facet (a GitHub repository) already
  // names it on the container row.
  const shownAsContainer = issue.container ? containerFacet(metadata)?.id : null;
  const facets = Object.entries(issue.facets)
    .filter(([id]) => id !== shownAsContainer)
    .map(([id, value]) => propHtml(facetLabel((metadata?.facets || []).find((f) => f.id === id) || { id, label: id }), escapeHtml(value)))
    .join('');
  const children = issue.children.length
    ? `<section class="issue-detail-section">
        <h4>${escapeHtml(t('tickets.detail.subIssues'))} <span class="issue-group-count">${issue.children.length}</span></h4>
        <div class="issue-detail-children">${issue.children.map((c) => rowHtml(c)).join('')}</div>
      </section>`
    : '';
  const comments = issue.comments.length
    ? `<section class="issue-detail-section">
        <h4>${escapeHtml(t('tickets.detail.comments'))} <span class="issue-group-count">${issue.comments.length}</span></h4>
        ${issue.comments.map((c) => `
          <div class="issue-comment">
            <div class="issue-comment-head">${avatarHtml(c.author, 'issue-avatar-sm')}<span class="issue-comment-author">${escapeHtml(c.author?.name || '')}</span><span class="issue-comment-time">${escapeHtml(c.createdAt ? relativeTime(c.createdAt) : '')}</span></div>
            <div class="issue-comment-body chat-msg-content">${renderMarkdown(c.body)}</div>
          </div>`).join('')}
      </section>`
    : '';

  return `
    <div class="issue-detail-head">
      <span class="issue-key">${escapeHtml(issue.key)}</span>
      <button type="button" class="issue-detail-close" aria-label="${escapeHtml(t('common.close'))}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <h3 class="issue-detail-title">${escapeHtml(issue.title)}</h3>
    <div class="issue-detail-actions">
      ${canStart ? `<button type="button" class="btn-sm issues-primary issue-action" data-action="start-session" aria-haspopup="dialog">${escapeHtml(t('tickets.detail.startSession'))}</button>` : ''}
      ${issue.url ? `<button type="button" class="btn-sm btn-secondary issue-action" data-action="open">${escapeHtml(t('tickets.detail.openIn', { provider: providerName }))}</button>` : ''}
      ${issue.branchName ? `<button type="button" class="btn-sm btn-secondary issue-action" data-action="copy-branch" title="${escapeHtml(issue.branchName)}">${escapeHtml(t('tickets.detail.copyBranch'))}</button>` : ''}
      <button type="button" class="btn-sm btn-secondary issue-action" data-action="copy-key">${escapeHtml(t('tickets.detail.copyKey'))}</button>
    </div>
    <div class="issue-detail-props">
      ${propHtml(t('tickets.detail.status'), editable('state', `${stateDot(issue.state)} ${escapeHtml(issue.state.name)}`, editableFields))}
      ${issue.priority != null ? propHtml(t('tickets.detail.priority'), editable('priority', `${priorityIcon(issue.priority)} ${escapeHtml(priorityLabel(issue.priority))}`, editableFields)) : ''}
      ${propHtml(t('tickets.detail.assignee'), editable('assignee', issue.assignee ? `${avatarHtml(issue.assignee, 'issue-avatar-sm')} ${escapeHtml(issue.assignee.name)}` : escapeHtml(t('tickets.groupBy.noAssignee')), editableFields))}
      ${issue.container ? propHtml(containerLabel(metadata), escapeHtml(issue.container.name)) : ''}
      ${facets}
      ${issue.estimate != null ? propHtml(t('tickets.detail.estimate'), escapeHtml(String(issue.estimate))) : ''}
      ${issue.dueDate ? propHtml(t('tickets.detail.due'), escapeHtml(issue.dueDate)) : ''}
      ${issue.labels.length ? propHtml(t('tickets.detail.labels'), labelsHtml(issue.labels, 20)) : ''}
    </div>
    <section class="issue-detail-section">
      <div class="issue-detail-description chat-msg-content">${issue.description ? renderMarkdown(issue.description) : `<p class="issue-detail-empty">${escapeHtml(t('tickets.detail.noDescription'))}</p>`}</div>
    </section>
    ${children}
    ${comments}`;
}

/**
 * A failed bridge answer in words, naming the tracker. Shared by the Tickets
 * screen and the session tab, which used to say only "Could not load".
 * @param {{ code?: string, error?: string }|null} res
 * @param {string} [provider] the tracker's display name
 */
function errorText(res, provider = '') {
  switch (res?.code) {
    case 'AUTH': return t('tickets.errors.auth', { provider });
    case 'RATE_LIMITED': return t('tickets.errors.rateLimited', { provider });
    case 'NETWORK': return t('tickets.errors.network', { provider });
    case 'NOT_FOUND': return t('tickets.errors.notFound', { provider });
    default: return t('tickets.errors.provider', { provider, message: res?.error || '' });
  }
}

module.exports = {
  errorText,
  DEFAULT_VIEW,
  PAGE_SIZE,
  restoreView,
  statusOptions,
  buildQuery,
  activeFilterCount,
  isDefaultView,
  groupByOptions,
  groupIssues,
  facetLabel,
  containerLabel,
  priorityLabel,
  categoryLabel,
  relativeTime,
  rowHtml,
  groupsHtml,
  detailHtml,
  boardColumns,
  dropTargetState,
  statesForIssue,
  cardHtml,
  boardHtml,
  priorityIcon,
  stateDot,
  avatarHtml,
};
