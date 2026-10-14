/**
 * The chat's Tickets tab: the tickets this session works on, with their live
 * status.
 *
 * Links live in main (IssueLinkService), keyed by session. A tab has no CLI
 * session id before its first message, so it starts under a provisional
 * `tab:<id>` key and moves to the real id when the CLI reports it
 * (`onSessionId`); a fork copies its parent's links instead.
 *
 * Linking here is explicit: the "Link a ticket" search, or an `@ENG-142`
 * mention in a message. Automatic detection only ever suggests: each new
 * suggestion is announced once to ChatView (`onSuggestions`), which shows the
 * confirmation card in the conversation, and stays listed here under
 * Suggestions until the user answers, so a card scrolled away or a restart
 * loses nothing.
 *
 * Statuses are fetched from the tracker when the tab is shown, at most every
 * 30 s, one request per linked ticket; a session links a handful, not dozens.
 */

'use strict';

const { t } = require('../../../i18n');
const { escapeHtml } = require('../../../utils');
const issueView = require('../../panels/issues/issueView');
const { STATE_CATEGORIES } = require('../../../../shared/issue-trackers');

const ISSUE_TTL_MS = 30_000;
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 8;
const REFRESH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>';

function sourceLabel(source) {
  switch (source) {
    case 'mention': return t('chat.tickets.sourceMention');
    case 'start': return t('chat.tickets.sourceStart');
    case 'tool': return t('chat.tickets.sourceTool');
    case 'prompt': return t('chat.tickets.sourcePrompt');
    case 'branch': return t('chat.tickets.sourceBranch');
    case 'pr': return t('chat.tickets.sourcePr');
    default: return t('chat.tickets.sourceManual');
  }
}

/**
 * @param {object} deps
 * @param {object} deps.api window.electron_api
 * @param {HTMLElement} deps.panelEl
 * @param {HTMLElement} deps.tabBtn the tab button, shown once a tracker is connected
 * @param {HTMLElement|null} deps.badgeEl
 * @param {() => void} deps.onAvailable
 * @param {string} deps.initialKey `tab:<id>` for a new tab or a fork, the CLI session id for a resumed one
 * @param {string|null} [deps.parentKey] a fork's parent session, whose links it copies once named
 * @param {() => string|null} deps.getProjectId
 * @param {(opts: object) => void} deps.showToast
 * @param {() => string} [deps.buildRecap] the session's recap, offered as a comment draft
 */
function createTicketsTab(deps) {
  const { api, panelEl } = deps;
  let key = deps.initialKey;
  let parentKey = deps.parentKey || null;
  let connections = [];
  let providers = [];
  let links = [];
  const issues = new Map(); // ref → { issue?, error?, at }
  const metadata = new Map(); // connectionId → metadata
  const contextParents = new Map(); // ref → { issue, connectionId } of the dimmed parents last drawn
  let visible = false;
  let destroyed = false;
  let searching = false;
  let searchText = '';
  let searchResults = null;
  let searchError = null; // a failed search says why instead of "No ticket found"
  let searchSeq = 0;
  let searchTimer = null;
  let menu = null; // { ref } of the open state menu
  const announced = new Set(); // suggestions already handed to ChatView for a card
  let recap = null; // { ref, text } while a recap comment is being written
  let suggestionListener = null;

  // The filter bar over the session's tickets: text on key and title, and a
  // state category. Kept across renders, local, no tracker call.
  let filterText = '';
  let filterCategory = null;
  let refreshing = false;
  const linked = () => links.filter((l) => l.status === 'linked');
  const suggested = () => links.filter((l) => l.status === 'suggested');
  const connectionFor = (link) => connections.find((c) => c.id === link.connectionId) || null;
  const providerFor = (conn) => providers.find((p) => p.id === conn?.provider) || null;
  const keyOf = (ref) => ref.slice(ref.indexOf(':') + 1);

  function updateBadge() {
    if (!deps.badgeEl) return;
    const n = linked().length;
    const pending = suggested().length;
    deps.badgeEl.textContent = pending ? `${n} +${pending}` : String(n);
    deps.badgeEl.hidden = n === 0 && pending === 0;
    deps.badgeEl.classList.toggle('has-suggestions', pending > 0);
  }

  /** Hand each new suggestion to ChatView once, for the card in the conversation. */
  function announce() {
    const fresh = suggested().filter((l) => !announced.has(l.ref));
    if (!fresh.length) return;
    fresh.forEach((l) => announced.add(l.ref));
    suggestionListener?.(fresh.map((l) => ({ ...l })));
  }

  async function answer(refs, yes) {
    const res = yes ? await api.issueLinks.confirm(key, refs) : await api.issueLinks.dismiss(key, refs);
    if (destroyed || !res?.ok) return res;
    links = res.links;
    updateBadge();
    if (visible) {
      render();
      if (yes) fetchIssues();
    }
    return res;
  }

  async function refreshLinks({ force = false } = {}) {
    const res = await api.issueLinks.get(key);
    if (destroyed) return undefined;
    links = res?.ok ? res.links : [];
    updateBadge();
    announce();
    if (visible) {
      render();
      return fetchIssues({ force });
    }
    return undefined;
  }

  /** The refresh button: the links again, and every ticket's state from the tracker. */
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    panelEl.querySelector('[data-action="refresh"]')?.classList.add('spinning');
    try {
      // Forced, not just emptied: a load already on its way would refill the
      // cache and leave the refresh with nothing to fetch.
      issues.clear();
      metadata.clear();
      await refreshLinks({ force: true });
    } finally {
      refreshing = false;
      if (!destroyed && visible) render();
    }
  }

  async function fetchIssues({ force = false } = {}) {
    const due = linked().filter((l) => {
      const hit = issues.get(l.ref);
      return force || !hit || Date.now() - hit.at > ISSUE_TTL_MS;
    });
    await Promise.all(due.map(async (l) => {
      const conn = connectionFor(l);
      if (!conn) {
        issues.set(l.ref, { error: { code: 'NOT_FOUND' }, at: Date.now() });
        return;
      }
      const res = await api.issueTrackers.getIssue(conn.id, keyOf(l.ref));
      issues.set(l.ref, res?.ok ? { issue: res.issue, at: Date.now() } : { error: res, at: Date.now() });
    }));
    if (!destroyed && visible && due.length) render();
  }

  async function search(text) {
    const mine = ++searchSeq;
    const conn = connections[0];
    if (!conn) return;
    const res = await api.issueTrackers.listIssues(conn.id, { text, limit: SEARCH_LIMIT, sort: 'updated' }, null);
    if (destroyed || mine !== searchSeq) return;
    searchResults = res?.ok ? res.issues.map((issue) => ({ issue, connectionId: conn.id })) : [];
    searchError = res?.ok ? null : issueView.errorText(res, providerFor(conn)?.name || '');
    if (visible) renderSearchResults();
  }

  async function link(issue, connectionId, source = 'manual') {
    const res = await api.issueLinks.link(key, { ref: issue.ref, connectionId, title: issue.title, source }, { projectId: deps.getProjectId?.() || null });
    if (destroyed) return;
    if (!res?.ok) {
      deps.showToast({ type: 'error', title: res?.error || t('common.errorOccurred') });
      return;
    }
    issues.set(issue.ref, { issue, at: Date.now() });
    links = res.links;
    updateBadge();
    if (visible) render();
  }

  async function changeState(ref, stateId) {
    const hit = issues.get(ref);
    const conn = connectionFor(links.find((l) => l.ref === ref) || {});
    if (!hit?.issue || !conn) return;
    const res = await api.issueTrackers.updateIssue(conn.id, hit.issue.key, { stateId });
    if (destroyed) return;
    if (res?.ok) issues.set(ref, { issue: res.issue, at: Date.now() });
    else deps.showToast({ type: 'error', title: t('tickets.errors.updateFailed', { key: hit.issue.key }), message: res?.error || '' });
    if (visible) render();
  }

  // ── Rendering ──

  function rowHtml(l, depth = 0, last = false) {
    const hit = issues.get(l.ref);
    const conn = connectionFor(l);
    const provider = providerFor(conn);
    const writable = !!provider?.capabilities?.write?.includes('state');
    const issue = hit?.issue;
    const key = keyOf(l.ref);
    const state = issue
      ? `${writable ? `<button type="button" class="session-tickets-state" data-action="state" data-ref="${escapeHtml(l.ref)}" aria-haspopup="menu" title="${escapeHtml(t('tickets.detail.edit'))}">` : '<span class="session-tickets-state">'}
          ${issueView.stateDot(issue.state)} ${escapeHtml(issue.state.name)}
        ${writable ? '</button>' : '</span>'}`
      : hit?.error
        // The reason used to be dropped: "Could not load" alone gave nothing to act on.
        ? `<button type="button" class="session-tickets-state session-tickets-failed" data-action="retry" data-ref="${escapeHtml(l.ref)}" title="${escapeHtml(t('chat.tickets.retryHint', { reason: issueView.errorText(hit.error, provider?.name || '') }))}">${escapeHtml(t('chat.tickets.loadFailed'))}</button>`
        : `<span class="session-tickets-state session-tickets-muted">${escapeHtml(t('tickets.panel.loading'))}</span>`;
    return `
      <li class="session-tickets-row" data-ref="${escapeHtml(l.ref)}"${issueView.depthAttrs(depth, last)}>
        ${issue ? issueView.priorityIcon(issue.priority) : '<span class="issue-priority"></span>'}
        <span class="issue-key">${escapeHtml(key)}</span>
        <span class="session-tickets-title">
          <span class="session-tickets-name">${escapeHtml(issue?.title || l.title || key)}</span>
          <span class="session-tickets-source">${escapeHtml(sourceLabel(l.source))}${l.evidence ? ` · ${escapeHtml(l.evidence)}` : ''}</span>
        </span>
        ${issueView.progressHtml(issue?.subIssues)}
        ${state}
        ${issue ? issueView.avatarHtml(issue.assignee, 'issue-avatar-sm') : ''}
        ${issue?.url ? `<button type="button" class="session-tickets-icon" data-action="open" data-ref="${escapeHtml(l.ref)}" title="${escapeHtml(t('tickets.detail.openIn', { provider: provider?.name || '' }))}" aria-label="${escapeHtml(t('tickets.detail.openIn', { provider: provider?.name || '' }))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>
        </button>` : ''}
        ${issue && provider?.capabilities?.write?.includes('comment') && deps.buildRecap ? `<button type="button" class="session-tickets-icon" data-action="recap" data-ref="${escapeHtml(l.ref)}" title="${escapeHtml(t('chat.tickets.recap'))}" aria-label="${escapeHtml(t('chat.tickets.recap'))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </button>` : ''}
        <button type="button" class="session-tickets-icon" data-action="unlink" data-ref="${escapeHtml(l.ref)}" title="${escapeHtml(t('chat.tickets.unlink'))}" aria-label="${escapeHtml(t('chat.tickets.unlink'))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </li>${recap?.ref === l.ref ? recapEditorHtml(provider) : ''}`;
  }

  /**
   * The parent of linked tickets that is not linked itself: dimmed, drawn from
   * what its children carry, with a way to open it or link it too.
   */
  function contextRowHtml(parent, depth, last, providerName) {
    return `
      <li class="session-tickets-row context" data-ref="${escapeHtml(parent.ref)}" title="${escapeHtml(t('tickets.subIssues.contextParent'))}"${issueView.depthAttrs(depth, last)}>
        <span class="issue-priority"></span>
        <span class="issue-key">${escapeHtml(parent.key)}</span>
        <span class="session-tickets-title"><span class="session-tickets-name">${escapeHtml(parent.title)}</span></span>
        ${issueView.progressHtml(parent.subIssues)}
        ${parent.state ? `<span class="session-tickets-state">${issueView.stateDot(parent.state)} ${escapeHtml(parent.state.name)}</span>` : ''}
        ${parent.url ? `<button type="button" class="session-tickets-icon" data-action="open" data-ref="${escapeHtml(parent.ref)}" title="${escapeHtml(t('tickets.detail.openIn', { provider: providerName }))}" aria-label="${escapeHtml(t('tickets.detail.openIn', { provider: providerName }))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>
        </button>` : ''}
        <button type="button" class="session-tickets-icon" data-action="link-parent" data-ref="${escapeHtml(parent.ref)}" title="${escapeHtml(t('chat.tickets.link'))}" aria-label="${escapeHtml(t('chat.tickets.link'))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </li>`;
  }

  /** Linking a context parent: the same link as the search makes, then its live state. */
  async function linkParent(ref) {
    const parent = contextParents.get(ref);
    if (!parent) return;
    const res = await api.issueLinks.link(key, { ref, connectionId: parent.connectionId, title: parent.issue.title, source: 'manual' }, { projectId: deps.getProjectId?.() || null });
    if (destroyed) return;
    if (!res?.ok) {
      deps.showToast({ type: 'error', title: res?.error || t('common.errorOccurred') });
      return;
    }
    links = res.links;
    updateBadge();
    if (visible) render();
    fetchIssues();
  }

  /** The comment being written, under its ticket. Nothing is posted until Publish. */
  function recapEditorHtml(provider) {
    return `<li class="session-tickets-recap">
      <textarea class="session-tickets-recap-input" rows="7" spellcheck="true" aria-label="${escapeHtml(t('chat.tickets.recap'))}">${escapeHtml(recap.text)}</textarea>
      <div class="session-tickets-recap-actions">
        <button type="button" class="btn-sm session-tickets-confirm" data-action="recap-publish">${escapeHtml(t('chat.tickets.recapPublish', { provider: provider?.name || '' }))}</button>
        <button type="button" class="btn-sm btn-secondary" data-action="recap-cancel">${escapeHtml(t('chat.tickets.recapCancel'))}</button>
        <span class="session-tickets-muted">${escapeHtml(t('chat.tickets.recapNote'))}</span>
      </div>
    </li>`;
  }

  async function publishRecap(button) {
    const ref = recap?.ref;
    const text = (recap?.text || '').trim();
    const conn = connectionFor(links.find((l) => l.ref === ref) || {});
    if (!ref || !text || !conn) return;
    button.disabled = true;
    const res = await api.issueTrackers.addComment(conn.id, keyOf(ref), text);
    if (destroyed) return;
    if (res?.ok) {
      recap = null;
      deps.showToast({ type: 'success', title: t('chat.tickets.recapPublished', { key: keyOf(ref) }) });
      if (visible) render();
    } else {
      button.disabled = false;
      deps.showToast({ type: 'error', title: t('chat.tickets.recapFailed'), message: res?.error || '' });
    }
  }

  function suggestionsHtml() {
    const list = suggested();
    if (!list.length) return '';
    return `<section class="session-tickets-suggestions">
      <h5 class="session-tickets-subheading">${escapeHtml(t('chat.tickets.suggestions'))} <span class="session-tickets-count">${list.length}</span></h5>
      <ul class="session-tickets-list">${list.map((l) => `
        <li class="session-tickets-row suggested" data-ref="${escapeHtml(l.ref)}">
          <span class="issue-key">${escapeHtml(keyOf(l.ref))}</span>
          <span class="session-tickets-title">
            <span class="session-tickets-name">${escapeHtml(l.title || keyOf(l.ref))}</span>
            <span class="session-tickets-source">${escapeHtml(sourceLabel(l.source))}${l.evidence ? ` · ${escapeHtml(l.evidence)}` : ''}</span>
          </span>
          <button type="button" class="btn-sm session-tickets-confirm" data-action="confirm" data-ref="${escapeHtml(l.ref)}">${escapeHtml(t('chat.tickets.confirm'))}</button>
          <button type="button" class="session-tickets-icon" data-action="dismiss-suggestion" data-ref="${escapeHtml(l.ref)}" title="${escapeHtml(t('chat.tickets.cardDismiss'))}" aria-label="${escapeHtml(t('chat.tickets.cardDismiss'))}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </li>`).join('')}</ul>
    </section>`;
  }

  function renderSearchResults() {
    const el = panelEl.querySelector('.session-tickets-results');
    if (!el) return;
    if (searchResults === null) {
      el.innerHTML = '';
      return;
    }
    if (searchError) {
      el.innerHTML = `<li class="session-tickets-muted session-tickets-search-error">${escapeHtml(searchError)}</li>`;
      return;
    }
    // A ticket already linked stays in the results, marked: hiding it made a
    // search for its own key answer "No ticket found".
    const known = new Set(linked().map((l) => l.ref));
    const first = searchResults.findIndex((r) => !known.has(r.issue.ref));
    el.innerHTML = searchResults.length
      ? searchResults.map((r, i) => {
        const already = known.has(r.issue.ref);
        return `
        <li><button type="button" class="session-tickets-result" data-action="pick" data-index="${i}" ${i === first ? 'data-first="1"' : ''} ${already ? 'disabled aria-disabled="true"' : ''}>
          ${issueView.stateDot(r.issue.state)}
          <span class="issue-key">${escapeHtml(r.issue.key)}</span>
          <span class="session-tickets-name">${escapeHtml(r.issue.title)}</span>
          ${already ? `<span class="session-tickets-linked-tag">${escapeHtml(t('chat.tickets.alreadyLinked'))}</span>` : ''}
        </button></li>`;
      }).join('')
      : `<li class="session-tickets-muted">${escapeHtml(t('chat.tickets.noResults'))}</li>`;
  }

  /** `focusSearch` only when the user opens the search: the composer below must keep its focus otherwise. */
  /** The linked tickets the filter bar lets through. */
  function filtered(rows) {
    const q = filterText.trim().toLowerCase();
    return rows.filter((l) => {
      const issue = issues.get(l.ref)?.issue;
      if (filterCategory && issue?.state?.category !== filterCategory) return false;
      if (!q) return true;
      return keyOf(l.ref).toLowerCase().includes(q) || String(issue?.title || l.title || '').toLowerCase().includes(q);
    });
  }

  /** "All", then each state category the loaded tickets are in, with its count. */
  function chipsHtml(rows) {
    const counts = new Map();
    for (const l of rows) {
      const category = issues.get(l.ref)?.issue?.state?.category;
      if (category) counts.set(category, (counts.get(category) || 0) + 1);
    }
    const chip = (value, label, count) => `<button type="button" class="session-tickets-chip${filterCategory === value ? ' active' : ''}" data-action="filter-category" data-category="${escapeHtml(value || '')}" aria-pressed="${filterCategory === value}">
        ${escapeHtml(label)} <span class="session-tickets-chip-count">${count}</span>
      </button>`;
    return [
      chip(null, t('chat.tickets.filterAll'), rows.length),
      ...STATE_CATEGORIES.filter((c) => counts.has(c) || c === filterCategory).map((c) => chip(c, issueView.categoryLabel(c), counts.get(c) || 0)),
    ].join('');
  }

  function listHtml(rows) {
    if (!rows.length) return `<p class="session-tickets-empty">${escapeHtml(t('chat.tickets.empty'))}</p>`;
    const shown = filtered(rows);
    if (!shown.length) {
      return `<p class="session-tickets-empty">${escapeHtml(t('chat.tickets.filterNone'))}
        <button type="button" class="session-tickets-clear" data-action="filter-clear">${escapeHtml(t('chat.tickets.filterClear'))}</button></p>`;
    }
    // Sub-tickets under their parent, as on the Tickets screen.
    contextParents.clear();
    const tree = issueView.flattenTree(issueView.nestIssues(shown, (l) => issues.get(l.ref)?.issue));
    return `<ul class="session-tickets-list">${tree.map(({ node, depth, last }) => {
      if (!node.context) return rowHtml(node.item, depth, last);
      const child = node.children[0]?.item || {};
      contextParents.set(node.issue.ref, { issue: node.issue, connectionId: child.connectionId || null });
      return contextRowHtml(node.issue, depth, last, providerFor(connectionFor(child))?.name || '');
    }).join('')}</ul>`;
  }

  const countText = (rows) => {
    const shown = filtered(rows).length;
    return shown === rows.length ? String(rows.length) : `${shown} / ${rows.length}`;
  };

  /** The chips and the list only: the filter field keeps its focus and caret while typing. */
  function renderList() {
    const rows = linked();
    const chips = panelEl.querySelector('.session-tickets-chips');
    if (chips) chips.innerHTML = chipsHtml(rows);
    const list = panelEl.querySelector('.session-tickets-listwrap');
    if (list) list.innerHTML = listHtml(rows);
    const count = panelEl.querySelector('.session-tickets-count');
    if (count) count.textContent = countText(rows);
    placeMenu();
  }

  /** `focusSearch` only when the user opens the search: the composer below must keep its focus otherwise. */
  function render({ focusSearch = false } = {}) {
    const rows = linked();
    // A refresh can land while the filter is being typed in: give it back its focus and caret.
    const active = document.activeElement;
    const typing = active && panelEl.contains(active) && active.classList.contains('session-tickets-filter-input')
      ? { start: active.selectionStart, end: active.selectionEnd }
      : null;
    panelEl.innerHTML = `
      <div class="session-tickets">
        <div class="session-tickets-head">
          <h4 class="session-tickets-heading">${escapeHtml(t('chat.tickets.title'))} <span class="session-tickets-count">${countText(rows)}</span></h4>
          <button type="button" class="session-tickets-icon${refreshing ? ' spinning' : ''}" data-action="refresh" title="${escapeHtml(t('common.refresh'))}" aria-label="${escapeHtml(t('common.refresh'))}">${REFRESH_ICON}</button>
          <button type="button" class="btn-sm btn-secondary" data-action="toggle-search">${escapeHtml(t('chat.tickets.link'))}</button>
        </div>
        ${searching ? `
          <div class="session-tickets-search">
            <input type="search" class="session-tickets-search-input" placeholder="${escapeHtml(t('chat.tickets.searchPlaceholder'))}" aria-label="${escapeHtml(t('chat.tickets.searchPlaceholder'))}" spellcheck="false" value="${escapeHtml(searchText)}">
            <ul class="session-tickets-results"></ul>
          </div>` : ''}
        ${suggestionsHtml()}
        ${rows.length ? `
          <div class="session-tickets-filter">
            <input type="search" class="session-tickets-filter-input" placeholder="${escapeHtml(t('chat.tickets.filterPlaceholder'))}" aria-label="${escapeHtml(t('chat.tickets.filterPlaceholder'))}" spellcheck="false" value="${escapeHtml(filterText)}">
            <div class="session-tickets-chips" role="group" aria-label="${escapeHtml(t('chat.tickets.filterPlaceholder'))}">${chipsHtml(rows)}</div>
          </div>` : ''}
        <div class="session-tickets-listwrap">${listHtml(rows)}</div>
      </div>`;
    if (searching) {
      renderSearchResults();
      if (focusSearch) panelEl.querySelector('.session-tickets-search-input').focus();
    }
    if (typing) {
      const input = panelEl.querySelector('.session-tickets-filter-input');
      input?.focus();
      input?.setSelectionRange(typing.start, typing.end);
    }
    placeMenu();
  }

  async function openStateMenu(button) {
    closeMenu();
    const ref = button.dataset.ref;
    const issue = issues.get(ref)?.issue;
    const conn = connectionFor(links.find((l) => l.ref === ref) || {});
    if (!issue || !conn) return;
    if (!metadata.has(conn.id)) {
      const res = await api.issueTrackers.metadata(conn.id);
      if (destroyed || !res?.ok) return;
      metadata.set(conn.id, res.metadata);
    }
    const states = issueView.statesForIssue(issue, metadata.get(conn.id));
    const el = document.createElement('div');
    el.className = 'issues-menu session-tickets-menu';
    el.setAttribute('role', 'menu');
    el.innerHTML = `<div class="issues-menu-items">${states.map((st) => `
      <button type="button" class="issues-menu-item" role="menuitemradio" aria-checked="${st.id === issue.state.id}" data-action="set-state" data-ref="${escapeHtml(ref)}" data-state="${escapeHtml(st.id)}">
        <span class="issues-menu-check" aria-hidden="true">${st.id === issue.state.id ? '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/></svg>' : ''}</span>
        ${issueView.stateDot(st)}
        <span class="issues-menu-label">${escapeHtml(st.name)}</span>
      </button>`).join('')}</div>`;
    menu = { ref, el };
    placeMenu();
  }

  /**
   * Put the open menu under its button. render() replaces the panel's HTML,
   * menu included, and a refresh lands whenever the links change: the menu
   * used to vanish under the pointer, and the next click on the button only
   * "closed" it.
   */
  function placeMenu() {
    if (!menu) return;
    const button = [...panelEl.querySelectorAll('[data-action="state"]')].find((b) => b.dataset.ref === menu.ref);
    if (!button) {
      menu.el.remove();
      menu = null; // its ticket is gone
      return;
    }
    if (!menu.el.isConnected) panelEl.appendChild(menu.el);
    const box = button.getBoundingClientRect();
    const host = panelEl.getBoundingClientRect();
    menu.el.style.top = `${box.bottom - host.top + panelEl.scrollTop + 4}px`;
    // Kept inside the panel: the state button sits near the right edge.
    menu.el.style.left = `${Math.max(0, Math.min(box.left - host.left, host.width - menu.el.offsetWidth - 8))}px`;
    button.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    menu?.el.remove();
    menu = null;
  }

  // ── Events ──

  function onClick(event) {
    const el = event.target.closest('[data-action]');
    if (!el) {
      if (menu && !event.target.closest('.session-tickets-menu')) closeMenu();
      return;
    }
    const ref = el.dataset.ref;
    switch (el.dataset.action) {
      case 'refresh':
        refresh();
        break;
      case 'filter-category':
        filterCategory = el.dataset.category || null;
        renderList();
        break;
      case 'filter-clear':
        filterText = '';
        filterCategory = null;
        render();
        break;
      case 'toggle-search':
        searching = !searching;
        if (!searching) {
          searchText = '';
          searchResults = null;
          searchError = null;
        }
        render({ focusSearch: searching });
        if (searching && searchResults === null) search('');
        break;
      case 'retry':
        issues.delete(ref);
        render();
        fetchIssues();
        break;
      case 'pick': {
        const picked = searchResults?.[Number(el.dataset.index)];
        if (picked) {
          searching = false;
          searchText = '';
          searchResults = null;
          searchError = null;
          link(picked.issue, picked.connectionId, 'manual');
        }
        break;
      }
      case 'unlink':
        api.issueLinks.dismiss(key, [ref]).then((res) => {
          if (!destroyed && res?.ok) {
            links = res.links;
            updateBadge();
            if (visible) render();
          }
        });
        break;
      case 'link-parent':
        linkParent(ref);
        break;
      case 'open': {
        const url = issues.get(ref)?.issue?.url || contextParents.get(ref)?.issue?.url;
        if (url) api.dialog.openExternal(url);
        break;
      }
      case 'state':
        if (menu?.ref === ref) closeMenu();
        else openStateMenu(el);
        break;
      case 'set-state':
        closeMenu();
        changeState(ref, el.dataset.state);
        break;
      case 'confirm':
        answer([ref], true);
        break;
      case 'recap':
        recap = recap?.ref === ref ? null : { ref, text: deps.buildRecap() };
        render();
        panelEl.querySelector('.session-tickets-recap-input')?.focus();
        break;
      case 'recap-publish':
        publishRecap(el);
        break;
      case 'recap-cancel':
        recap = null;
        render();
        break;
      case 'dismiss-suggestion':
        answer([ref], false);
        break;
      default:
    }
  }

  function onInput(event) {
    if (event.target.matches('.session-tickets-filter-input')) {
      filterText = event.target.value;
      renderList();
      return;
    }
    if (event.target.matches('.session-tickets-recap-input') && recap) {
      recap.text = event.target.value;
      return;
    }
    if (!event.target.matches('.session-tickets-search-input')) return;
    searchText = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search(searchText.trim()), SEARCH_DEBOUNCE_MS);
  }

  function onKeydown(event) {
    if (event.key === 'Escape' && event.target.matches('.session-tickets-filter-input') && filterText) {
      filterText = '';
      event.target.value = '';
      renderList();
      event.stopPropagation();
      return;
    }
    if (event.key === 'Escape' && (menu || searching)) {
      if (menu) closeMenu();
      else {
        searching = false;
        render();
      }
      event.stopPropagation();
    }
    if (event.key === 'Enter' && event.target.matches('.session-tickets-search-input')) {
      event.preventDefault();
      panelEl.querySelector('.session-tickets-result[data-first]')?.click();
    }
  }

  panelEl.addEventListener('click', onClick);
  panelEl.addEventListener('input', onInput);
  panelEl.addEventListener('keydown', onKeydown);
  const offChanged = api.issueLinks?.onChanged?.((payload) => {
    if (payload?.sessionKey === key) refreshLinks();
  });

  return {
    /** Show the tab only when a tracker is connected, and fill the badge. */
    async probe() {
      let p;
      let c;
      try {
        [p, c] = await Promise.all([api.issueTrackers.providers(), api.issueTrackers.connections()]);
      } catch {
        return; // no tracker bridge: the tab simply never appears
      }
      if (destroyed) return;
      providers = p?.ok ? p.providers : [];
      connections = c?.ok ? c.connections.filter((x) => x.available) : [];
      if (!connections.length) return;
      deps.onAvailable?.();
      await refreshLinks();
    },

    show() {
      visible = true;
      render();
      fetchIssues();
    },

    hide() {
      visible = false;
      closeMenu();
    },

    /**
     * The CLI named this session: its links follow (moved from a new tab,
     * copied for a fork). A fork copies its parent's before its own
     * provisional ones move in, so the parent never sees the fork's writes.
     */
    async onSessionId(id) {
      if (!id || id === key) return;
      const previous = key;
      key = id;
      if (parentKey) {
        const parent = parentKey;
        parentKey = null;
        if (parent !== id) await api.issueLinks.copy(parent, id);
      }
      if (previous.startsWith('tab:')) await api.issueLinks.rekey(previous, id);
      else await api.issueLinks.copy(previous, id);
      await refreshLinks();
    },

    /** Link from outside the tab: an @mention, or a session started from a ticket. */
    async linkTicket({ ref, connectionId, title }, source) {
      const res = await api.issueLinks.link(key, { ref, connectionId, title, source }, { projectId: deps.getProjectId?.() || null });
      if (destroyed || !res?.ok) return;
      links = res.links;
      updateBadge();
      if (visible) {
        render();
        fetchIssues(); // or the new row stays on "Loading" until the tab is reopened
      }
    },

    /** Called once per new suggestion batch; ChatView turns it into a card. */
    onSuggestions(fn) {
      suggestionListener = fn;
    },

    /** The card's answers. */
    confirm: (refs) => answer(refs, true),
    dismiss: (refs) => answer(refs, false),

    getKey: () => key,
    getLinks: () => links.slice(),

    destroy() {
      destroyed = true;
      clearTimeout(searchTimer);
      offChanged?.();
      panelEl.removeEventListener('click', onClick);
      panelEl.removeEventListener('input', onInput);
      panelEl.removeEventListener('keydown', onKeydown);
    },
  };
}

module.exports = { createTicketsTab, sourceLabel };
