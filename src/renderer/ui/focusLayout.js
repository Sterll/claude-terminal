/**
 * Focus layout (settings.layoutMode = 'focus')
 *
 * One header instead of four rows of chrome. The standard layout stacks the
 * titlebar (usage and time stats), the project tab bar, the session tab row and
 * the chat's own tab bar above the conversation, with a 20-entry sidebar beside
 * it. Focus mode keeps all of it reachable and puts none of it in the way:
 *
 *   titlebar:  [Project ▾] / [Session ▾] [+]   [git tools]   [⌘K Search] [Screens] [◷ 2h] [🌊] [⚙]
 *
 * Nothing is reimplemented. The sidebar, the project bar and the session row are
 * hidden, not removed, and every menu here drives their elements: a screen is
 * opened by clicking its (hidden) nav tab, a session by clicking its (hidden)
 * tab, a new session through the session "+" menu's own items. So every
 * behaviour those elements carry - context menus, attention flags, split view,
 * the Ctrl+Tab cycle - stays exactly where it was, and switching back to the
 * standard layout is only a body class and a few moved nodes.
 *
 * Three nodes are moved rather than mirrored, like navigationMode.js does: the
 * git tools row (one implementation, many listeners) goes into the header, and
 * the titlebar's usage and time widgets go into the Stats popover. They return
 * to where they came from when focus mode ends.
 */

const { applyNavigationMode } = require('./navigationMode');
const { backgroundTasksState, listTasks } = require('../state/backgroundTasks.state');
const { isSafeImage, avatarColor } = require('../utils/projectImage');

/** A project's glyph at small size: its image, else its initial on its colour. */
function projectGlyph(p) {
  if (isSafeImage(p?.image)) return `<img class="focus-project-image" src="${p.image}" alt="">`;
  const color = p?.color && /^#[0-9a-f]{3,8}$/i.test(p.color) ? p.color : avatarColor(p?.name);
  const initial = escapeHtml((p?.name || '?').trim().charAt(0).toUpperCase() || '?');
  return `<span class="focus-project-avatar" style="--pc:${color}">${initial}</span>`;
}
const { escapeHtml } = require('../utils/dom');
const { t } = require('../i18n');

const CARET = '<svg class="focus-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
const ICONS = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  close: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2L2 10" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>',
};

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || '');

/**
 * @param {object} deps
 * @param {object} deps.settingsState
 * @param {object} deps.projectsState
 * @param {() => void} deps.openPalette               open the command palette
 * @param {(project: object) => void} deps.selectProject  make a project the current one
 * @param {() => void} deps.openNewProject
 */
function createFocusLayout(deps) {
  const { settingsState, projectsState } = deps;
  const titlebar = document.querySelector('.titlebar');
  if (!titlebar) return { sync() {} };

  const bar = document.createElement('div');
  bar.className = 'focus-bar';
  bar.id = 'focus-bar';
  bar.innerHTML = `
    <div class="focus-left">
      <div class="focus-group">
        <button type="button" class="focus-chip" id="focus-project-btn" aria-haspopup="dialog" title="${escapeHtml(t('focus.switchProject'))}">
          <span class="focus-chip-kicker">${escapeHtml(t('focus.projectKicker'))}</span>
          <span class="focus-project-glyph" id="focus-project-glyph"></span><span class="focus-chip-label" id="focus-project-label"></span>${CARET}
        </button>
      </div>
      <div class="focus-group">
        <button type="button" class="focus-chip" id="focus-session-btn" aria-haspopup="dialog" title="${escapeHtml(t('focus.switchSession'))}">
          <span class="focus-chip-kicker">${escapeHtml(t('focus.sessionKicker'))}</span>
          <span class="focus-status"></span><span class="focus-chip-label" id="focus-session-label"></span>${CARET}
        </button>
        <span class="focus-divider" aria-hidden="true"></span>
        <button type="button" class="focus-icon-btn" id="focus-new-session" title="${escapeHtml(t('terminals.newClaudeSession'))}" aria-label="${escapeHtml(t('terminals.newClaudeSession'))}">${ICONS.plus}<span class="focus-label">${escapeHtml(t('focus.newShort'))}</span></button>
      </div>
    </div>
    <div class="focus-tools focus-group" id="focus-tools-slot"></div>
    <div class="focus-right">
      <button type="button" class="focus-tasks" id="focus-tasks" aria-haspopup="dialog" title="${escapeHtml(t('focus.tasks'))}">
        <span class="focus-tasks-spinner" aria-hidden="true"></span><span id="focus-tasks-label"></span>
      </button>
      <button type="button" class="focus-search" id="focus-search" aria-label="${escapeHtml(t('focus.search'))}">
        ${ICONS.search}<span>${escapeHtml(t('focus.search'))}</span><kbd>${isMac ? '⌘' : 'Ctrl'} K</kbd>
      </button>
      <div class="focus-group">
        <button type="button" class="focus-icon-btn" id="focus-screens" aria-haspopup="dialog" title="${escapeHtml(t('focus.screens'))}" aria-label="${escapeHtml(t('focus.screens'))}">${ICONS.grid}<span class="focus-label">${escapeHtml(t('focus.screens'))}</span></button>
        <button type="button" class="focus-icon-btn focus-stats-btn" id="focus-stats" aria-haspopup="dialog" title="${escapeHtml(t('focus.stats'))}">
          ${ICONS.clock}<span id="focus-stats-label"></span>
        </button>
        <span class="focus-ambience-slot" id="focus-ambience-slot"></span>
        <button type="button" class="focus-icon-btn" id="focus-settings" title="${escapeHtml(t('settings.title'))}" aria-label="${escapeHtml(t('settings.title'))}">${ICONS.gear}<span class="focus-label">${escapeHtml(t('focus.settingsShort'))}</span></button>
      </div>
    </div>`;
  titlebar.insertBefore(bar, titlebar.querySelector('.titlebar-controls'));

  const $ = (id) => document.getElementById(id);

  // ── Popovers ────────────────────────────────────────────────────────────
  let pop = null;
  let popAnchor = null;
  function closePop() {
    if (!pop) return;
    // The stats popover borrows the titlebar widgets: park them before removing it.
    const store = $('focus-stats-store');
    if (store) pop.querySelectorAll('[data-borrowed]').forEach((n) => store.appendChild(n));
    pop.remove();
    pop = null;
    popAnchor?.setAttribute('aria-expanded', 'false');
    popAnchor = null;
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  }
  function onOutside(e) { if (pop && !pop.contains(e.target) && !popAnchor?.contains(e.target)) closePop(); }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); const a = popAnchor; closePop(); a?.focus(); }
  }
  function openPop(anchor, className, render) {
    if (pop && popAnchor === anchor) { closePop(); return; }
    closePop();
    pop = document.createElement('div');
    pop.className = `focus-pop ${className}`;
    pop.setAttribute('role', 'dialog');
    document.body.appendChild(pop);
    popAnchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    render(pop);
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  }

  /** Arrow keys and Enter over a list of buttons, from a search field. */
  function listKeys(input, listEl) {
    input.addEventListener('keydown', (e) => {
      const items = [...listEl.querySelectorAll('.focus-item:not([hidden])')];
      if (!items.length) return;
      let i = items.findIndex((x) => x.classList.contains('kb'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[i]?.classList.remove('kb');
        i = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items[i].classList.add('kb');
        items[i].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        (items[i] || items[0]).click();
      }
    });
  }

  // ── Project switcher ────────────────────────────────────────────────────
  function currentProject() {
    const { projects, selectedProjectFilter } = projectsState.get();
    return selectedProjectFilter !== null && selectedProjectFilter !== undefined ? projects[selectedProjectFilter] || null : null;
  }

  $('focus-project-btn').onclick = (e) => openPop(e.currentTarget, 'focus-pop-projects', (el) => {
    const { projects } = projectsState.get();
    const open = new Set(settingsState.get().openProjectIds || []);
    const current = currentProject();
    const list = projects.filter((p) => !p.archived)
      .sort((a, b) => Number(open.has(b.id)) - Number(open.has(a.id)));
    el.innerHTML = `
      <input type="text" class="focus-filter" placeholder="${escapeHtml(t('focus.filterProjects'))}" aria-label="${escapeHtml(t('focus.filterProjects'))}">
      <div class="focus-list" role="listbox">
        ${list.map((p) => `
          <button type="button" class="focus-item ${current?.id === p.id ? 'current' : ''}" data-id="${escapeHtml(p.id)}" data-search="${escapeHtml(`${p.name} ${p.path}`.toLowerCase())}" role="option">
            ${projectGlyph(p)}
            <span class="focus-item-main"><span class="focus-item-name">${escapeHtml(p.name)}</span><span class="focus-item-sub">${escapeHtml(p.path)}</span></span>
            ${open.has(p.id) ? `<span class="focus-item-tag">${escapeHtml(t('focus.open'))}</span>` : ''}
          </button>`).join('') || `<div class="focus-empty">${escapeHtml(t('focus.noProjects'))}</div>`}
      </div>
      <div class="focus-pop-footer">
        <button type="button" class="focus-footer-btn" data-act="new">${ICONS.plus}<span>${escapeHtml(t('focus.newProject'))}</span></button>
        <button type="button" class="focus-footer-btn" data-act="remote"><span>${escapeHtml(t('focus.openRemote'))}</span></button>
      </div>`;
    const input = el.querySelector('.focus-filter');
    const listEl = el.querySelector('.focus-list');
    input.oninput = () => {
      const q = input.value.trim().toLowerCase();
      listEl.querySelectorAll('.focus-item').forEach((it) => { it.hidden = !!q && !it.dataset.search.includes(q); it.classList.remove('kb'); });
    };
    listKeys(input, listEl);
    listEl.querySelectorAll('.focus-item').forEach((it) => {
      it.onclick = () => {
        const project = projectsState.get().projects.find((p) => p.id === it.dataset.id);
        closePop();
        if (project) deps.selectProject(project);
      };
    });
    el.querySelector('[data-act="new"]').onclick = () => { closePop(); deps.openNewProject(); };
    el.querySelector('[data-act="remote"]').onclick = () => { closePop(); document.getElementById('btn-new-remote-project')?.click(); };
    setTimeout(() => input.focus(), 0);
  });

  // ── Session switcher ────────────────────────────────────────────────────
  function visibleTabs() {
    return [...document.querySelectorAll('#terminals-tabs .terminal-tab')].filter((tab) => tab.style.display !== 'none');
  }
  function tabStatus(tab) {
    if (tab.classList.contains('attention-input')) return 'input';
    if (tab.classList.contains('attention-error')) return 'error';
    const m = [...tab.classList].find((c) => c.startsWith('status-'));
    return m ? m.slice(7) : 'ready';
  }
  function tabName(tab) {
    return (tab.querySelector('.tab-name')?.textContent || '').trim() || t('focus.untitledSession');
  }

  $('focus-session-btn').onclick = (e) => openPop(e.currentTarget, 'focus-pop-sessions', (el) => {
    const tabs = visibleTabs();
    const addItems = [...document.querySelectorAll('#session-add-menu .session-add-item')];
    el.innerHTML = `
      <div class="focus-list" role="listbox">
        ${tabs.map((tab, i) => `
          <div class="focus-item focus-session ${tab.classList.contains('active') ? 'current' : ''}" data-i="${i}" role="option" tabindex="0">
            <span class="focus-status" data-status="${tabStatus(tab)}"></span>
            <span class="focus-item-main"><span class="focus-item-name">${escapeHtml(tabName(tab))}</span></span>
            <button type="button" class="focus-item-close" data-close="${i}" aria-label="${escapeHtml(t('common.close'))}">${ICONS.close}</button>
          </div>`).join('') || `<div class="focus-empty">${escapeHtml(currentProject() ? t('terminals.noTerminals') : t('focus.pickProjectFirst'))}</div>`}
      </div>
      <div class="focus-pop-footer focus-pop-footer-col">
        ${addItems.map((item, i) => `<button type="button" class="focus-footer-btn" data-add="${i}">${item.innerHTML}</button>`).join('')}
      </div>`;
    el.querySelectorAll('.focus-session').forEach((row) => {
      const tab = tabs[Number(row.dataset.i)];
      const activate = () => { closePop(); document.querySelector('.nav-tab[data-tab="claude"]')?.click(); tab.click(); };
      row.onclick = (ev) => { if (!ev.target.closest('.focus-item-close')) activate(); };
      row.onkeydown = (ev) => { if (ev.key === 'Enter') activate(); };
      // The tab's own context menu (rename, pin, split, close others...).
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        closePop();
        tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ev.clientX, clientY: ev.clientY }));
      };
    });
    el.querySelectorAll('[data-close]').forEach((btn) => {
      btn.onclick = (ev) => { ev.stopPropagation(); closePop(); tabs[Number(btn.dataset.close)]?.querySelector('.tab-close')?.click(); };
    });
    el.querySelectorAll('[data-add]').forEach((btn) => {
      btn.onclick = () => { closePop(); document.querySelector('.nav-tab[data-tab="claude"]')?.click(); addItems[Number(btn.dataset.add)]?.click(); };
    });
  });

  $('focus-new-session').onclick = () => {
    document.querySelector('.nav-tab[data-tab="claude"]')?.click();
    if (!currentProject()) { $('focus-project-btn').click(); return; }
    document.querySelector('#session-add-menu .session-add-item[data-session-action="claude"]')?.click();
  };

  // ── Screens ─────────────────────────────────────────────────────────────
  $('focus-screens').onclick = (e) => openPop(e.currentTarget, 'focus-pop-screens', (el) => {
    const groups = [];
    let group = null;
    const seen = new Set();
    for (const node of document.querySelectorAll('.sidebar nav.nav-tabs > .nav-separator, .sidebar nav.nav-tabs > .nav-tab[data-tab], #more-tabs-dropdown [data-tab]')) {
      if (node.classList.contains('nav-separator')) { group = { title: node.textContent.trim(), items: [] }; groups.push(group); continue; }
      const id = node.dataset.tab;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!group) { group = { title: '', items: [] }; groups.push(group); }
      // A sidebar tab is [drag handle][icon][label]: take the icon and the label, never the grip.
      group.items.push({ id, icon: node.querySelector(':scope > svg')?.outerHTML || '', label: (node.querySelector(':scope > span[data-i18n], :scope > span:not(.nav-tab-drag-handle)')?.textContent || node.title || id).trim() });
    }
    const active = document.body.dataset.activeTab;
    el.innerHTML = groups.filter((g) => g.items.length).map((g) => `
      <div class="focus-screens-group">
        ${g.title ? `<div class="focus-screens-title">${escapeHtml(g.title)}</div>` : ''}
        <div class="focus-screens-grid">
          ${g.items.map((it) => `
            <button type="button" class="focus-screen ${it.id === active ? 'current' : ''}" data-tab="${escapeHtml(it.id)}">${it.icon}<span>${escapeHtml(it.label)}</span></button>`).join('')}
        </div>
      </div>`).join('');
    el.querySelectorAll('.focus-screen').forEach((btn) => {
      btn.onclick = () => {
        closePop();
        document.querySelector(`.sidebar .nav-tab[data-tab="${CSS.escape(btn.dataset.tab)}"], #more-tabs-dropdown [data-tab="${CSS.escape(btn.dataset.tab)}"]`)?.click();
      };
    });
  });

  // ── Stats ───────────────────────────────────────────────────────────────
  const store = document.createElement('div');
  store.id = 'focus-stats-store';
  store.hidden = true;
  bar.appendChild(store);

  $('focus-stats').onclick = (e) => openPop(e.currentTarget, 'focus-pop-stats', (el) => {
    el.innerHTML = `<div class="focus-stats-body"></div>
      <div class="focus-pop-footer"><button type="button" class="focus-footer-btn" data-act="notif"></button></div>`;
    const body = el.querySelector('.focus-stats-body');
    store.querySelectorAll('[data-borrowed]').forEach((n) => body.appendChild(n));
    const notifBtn = el.querySelector('[data-act="notif"]');
    const paint = () => {
      const on = document.getElementById('btn-notifications')?.classList.contains('active');
      notifBtn.textContent = on ? t('focus.notificationsOn') : t('focus.notificationsOff');
    };
    paint();
    notifBtn.onclick = () => { document.getElementById('btn-notifications')?.click(); setTimeout(paint, 50); };
  });

  // ── Running tasks ───────────────────────────────────────────────────────
  // Background work (subagents, shells left running, workflow steps) across
  // every session: a pill while anything runs, the list on click. The chat's
  // side column still has the full history; this is the glance.
  const elapsed = (ms) => {
    const sec = Math.max(0, Math.round(ms / 1000));
    return sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}` : `${Math.floor(sec / 3600)}h${String(Math.floor(sec / 60) % 60).padStart(2, '0')}`;
  };
  const taskTitle = (task) => task.description || task.workflowName || task.agentType || task.type || t('focus.taskUntitled');
  const taskSub = (task) => [task.agentType || task.type, task.workflowName].filter(Boolean).join(' · ');
  const ICON_FOR = { completed: '✓', failed: '✕', stopped: '■' };
  let tasksTimer = 0;

  function paintTasksPill() {
    const running = listTasks().filter((task) => task.status === 'running');
    const pill = $('focus-tasks');
    pill.classList.toggle('has-tasks', running.length > 0);
    $('focus-tasks-label').textContent = t('focus.tasksRunning', { count: running.length });
  }

  function renderTasksPop(el) {
    const all = listTasks();
    const running = all.filter((task) => task.status === 'running');
    const recent = all.filter((task) => task.status !== 'running').slice(0, 4);
    const row = (task) => `
      <div class="focus-task">
        <span class="focus-task-icon ${task.status}">${task.status === 'running' ? '<span class="focus-tasks-spinner"></span>' : (ICON_FOR[task.status] || '•')}</span>
        <span class="focus-task-main">
          <span class="focus-task-title">${escapeHtml(taskTitle(task))}</span>
          ${taskSub(task) ? `<span class="focus-task-sub">${escapeHtml(taskSub(task))}</span>` : ''}
        </span>
        <span class="focus-task-time">${elapsed((task.endedAt || Date.now()) - (task.startedAt || Date.now()))}</span>
      </div>`;
    el.innerHTML = `
      <div class="focus-tasks-section">${escapeHtml(t('focus.tasksNow', { count: running.length }))}</div>
      ${running.map(row).join('') || `<div class="focus-empty">${escapeHtml(t('focus.tasksNone'))}</div>`}
      ${recent.length ? `<div class="focus-tasks-section">${escapeHtml(t('focus.tasksRecent'))}</div>${recent.map(row).join('')}` : ''}`;
  }

  $('focus-tasks').onclick = (e) => openPop(e.currentTarget, 'focus-pop-tasks', (el) => {
    renderTasksPop(el);
    clearInterval(tasksTimer);
    // Elapsed times tick while the popover is open, and only then.
    tasksTimer = setInterval(() => {
      if (!pop || !pop.classList.contains('focus-pop-tasks')) { clearInterval(tasksTimer); return; }
      renderTasksPop(pop);
    }, 1000);
  });
  backgroundTasksState.subscribe(paintTasksPill);
  paintTasksPill();

  // ── Search and settings ─────────────────────────────────────────────────
  $('focus-search').onclick = () => deps.openPalette();
  $('focus-settings').onclick = () => document.getElementById('btn-settings')?.click();

  // ── Labels kept in sync ─────────────────────────────────────────────────
  let labelRaf = 0;
  function paintLabels() {
    cancelAnimationFrame(labelRaf);
    labelRaf = requestAnimationFrame(() => {
      const p = currentProject();
      $('focus-project-label').textContent = p ? p.name : t('focus.noProjectSelected');
      $('focus-project-glyph').innerHTML = p ? projectGlyph(p) : '';
      const tabs = visibleTabs();
      const active = tabs.find((tab) => tab.classList.contains('active'));
      $('focus-session-label').textContent = active ? tabName(active) : (tabs.length ? t('focus.sessionsCount', { count: tabs.length }) : t('focus.noSession'));
      bar.querySelector('#focus-session-btn .focus-status').dataset.status = active ? tabStatus(active) : '';
      // A session elsewhere waiting on the user shows on the chip, since the
      // tab row that used to show it is hidden in this layout.
      const waiting = tabs.some((tab) => tab !== active && /attention-(input|error)/.test(tab.className));
      $('focus-session-btn').classList.toggle('has-attention', waiting);
      $('focus-stats-label').textContent = document.getElementById('time-today')?.textContent || '';
    });
  }
  projectsState.subscribe(paintLabels);
  const tabsEl = document.getElementById('terminals-tabs');
  if (tabsEl) new MutationObserver(paintLabels).observe(tabsEl, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'], characterData: true });
  const timeEl = document.getElementById('time-today');
  if (timeEl) new MutationObserver(paintLabels).observe(timeEl, { childList: true, characterData: true, subtree: true });

  // ── Moving the shared nodes ─────────────────────────────────────────────
  /** Nodes moved into the focus header, newest last: [node, parent, nextSibling]. */
  let moved = [];
  function borrow(node, into) {
    if (!node || node.parentElement === into) return;
    moved.push([node, node.parentElement, node.nextSibling]);
    into.appendChild(node);
  }
  function giveBack() {
    for (const [node, parent, next] of moved.reverse()) {
      if (next && next.parentElement === parent) parent.insertBefore(node, next);
      else parent.appendChild(node);
      delete node.dataset.borrowed;
    }
    moved = [];
  }

  let on = false;
  let toolsObserver = null;
  function apply(next) {
    if (next === on) {
      // navigationMode may have pulled the tools back while focus mode is on.
      if (on) {
        const tools = document.getElementById('project-bar-tools');
        const slot = $('focus-tools-slot');
        if (tools && tools.parentElement !== slot) slot.appendChild(tools);
      }
      return;
    }
    on = next;
    closePop();
    document.body.classList.toggle('ct-layout-focus', on);
    if (on) {
      const usage = document.getElementById('titlebar-usage');
      const time = document.getElementById('titlebar-time');
      for (const n of [usage, time]) if (n) n.dataset.borrowed = '1';
      borrow(usage, store);
      const ambienceBtn = document.querySelector('.titlebar-ambience-btn');
      if (ambienceBtn) ambienceBtn.dataset.focusLabel = t('ambience.buttonLabel');
      borrow(ambienceBtn, $('focus-ambience-slot'));
      borrow(time, store);
      const tools = document.getElementById('project-bar-tools');
      if (tools) {
        $('focus-tools-slot').appendChild(tools);
        // Which of its controls show is decided in several places (git
        // status, quick actions, the screen); the capsule simply hides when
        // what is inside measures nothing, rather than mirroring every rule.
        if (!toolsObserver && typeof ResizeObserver !== 'undefined') {
          toolsObserver = new ResizeObserver(() => {
            $('focus-tools-slot').classList.toggle('is-empty', tools.getBoundingClientRect().width < 6);
          });
          toolsObserver.observe(tools);
        }
      }
      // Short captions for the icon-only git controls (read by CSS ::after).
      const caption = (id, key) => { const el = document.getElementById(id); if (el) el.dataset.focusLabel = t(key); };
      caption('filter-btn-pull', 'focus.pullShort');
      caption('filter-btn-push', 'focus.pushShort');
      paintLabels();
    } else {
      // Popover content returns to the store first, then everything home.
      giveBack();
      applyNavigationMode(settingsState.get().navigationMode);
    }
  }

  function sync() { apply(settingsState.get().layoutMode === 'focus'); }
  settingsState.subscribe(sync);
  sync();
  return { sync, closePopover: closePop };
}

module.exports = { createFocusLayout };
