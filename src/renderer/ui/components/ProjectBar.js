/**
 * ProjectBar Component
 *
 * One tab per *open* project, in a bar shared by every screen. It replaces the
 * three permanent project sidebars (Claude, Git, Dashboard): the active tab is
 * the project context those screens render.
 *
 * The bar lives inside .content rather than spanning the window, so it stays
 * visually subordinate to the vertical nav — switching screens is the primary
 * move, switching project the secondary one.
 *
 * The full project tree (search, folders, drag & drop, per-project menus) is
 * not duplicated here: the + button opens the existing ProjectList in a
 * popover, which doubles as the "open a project" picker.
 */

const { BaseComponent } = require('../../core/BaseComponent');
const {
  projectsState,
  terminalsState,
  getProject,
  getProjectIndex,
  getOpenProjects,
  openProjectTab,
  closeProjectTab,
  moveProjectTab,
  isPathMissing,
} = require('../../state');
const { getWorkspacesForProject } = require('../../state/workspace.state');
const { escapeHtml, sanitizeColor } = require('../../utils');
const { t } = require('../../i18n');

const FOLDER_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>';

class ProjectBar extends BaseComponent {
  constructor(el, options = {}) {
    super(el, options);
    this._callbacks = {
      onSelectProject: null,   // (projectIndex, project) => void
      onCloseProject: null,    // (project) => void
      onContextMenu: null,     // (project, x, y) => void
      onOpenPicker: null,      // (anchorEl) => void
      onSelectOverview: null,  // () => void
      getTerminalStatsForProject: () => ({ total: 0, working: 0 }),
    };
    this._renderScheduled = false;
    this._dragProjectId = null;
    // Screens with an all-projects view (the dashboard) get an Overview tab in
    // front of the project tabs rather than a second selector of their own.
    this._overviewActive = false;
  }

  /**
   * Mark the Overview tab as the active one — no project tab is then active.
   * @param {boolean} active
   */
  setOverviewActive(active) {
    if (this._overviewActive === !!active) return;
    this._overviewActive = !!active;
    this.render();
  }

  setCallbacks(callbacks) {
    Object.assign(this._callbacks, callbacks);
  }

  init() {
    const addBtn = document.getElementById('btn-open-project');
    if (addBtn) {
      this.on(addBtn, 'click', (e) => {
        e.stopPropagation();
        if (this._callbacks.onOpenPicker) this._callbacks.onOpenPicker(addBtn);
      });
    }

    if (this.el) {
      this.on(this.el, 'click', (e) => this._onClick(e));
      this.on(this.el, 'contextmenu', (e) => this._onContextMenu(e));
      this.on(this.el, 'auxclick', (e) => {
        // Middle-click closes, like a browser tab.
        if (e.button !== 1) return;
        const tab = e.target.closest('.project-tab[data-project-id]');
        if (!tab) return;
        e.preventDefault();
        this._close(tab.dataset.projectId);
      });
      // Let the wheel scroll the tab strip horizontally.
      this.on(this.el, 'wheel', (e) => {
        if (e.deltaY === 0 || this.el.scrollWidth <= this.el.clientWidth) return;
        e.preventDefault();
        this.el.scrollLeft += e.deltaY;
      }, { passive: false });
      this._initDragReorder();
    }

    this.subscribe(projectsState, () => this.render());
    // Session count and its "working" state are on the tabs, so terminal
    // changes have to repaint the bar too.
    this.subscribe(terminalsState, () => this.render());
    this.render();
  }

  render() {
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    requestAnimationFrame(() => this._renderNow());
  }

  _renderNow() {
    this._renderScheduled = false;
    if (!this.el) return;

    const openProjects = getOpenProjects();
    const activeIndex = projectsState.get().selectedProjectFilter;
    const activeId = projectsState.get().projects[activeIndex]?.id || null;

    const body = openProjects.length === 0
      ? `<div class="project-tabs-empty">${escapeHtml(t('projects.noOpenProjects'))}</div>`
      : openProjects
        .map(project => this._renderTabHtml(project, !this._overviewActive && project.id === activeId))
        .join('');

    this.el.innerHTML = this._renderOverviewTabHtml() + body;
    this._scrollActiveIntoView();
  }

  /**
   * The Overview tab. Always rendered, shown by CSS only on the screens that
   * have an all-projects view (see .project-tab--overview in projects.css).
   */
  _renderOverviewTabHtml() {
    return `<div class="project-tab project-tab--overview${this._overviewActive ? ' active' : ''}" data-overview="1" role="tab" aria-selected="${this._overviewActive}" tabindex="${this._overviewActive ? '0' : '-1'}" title="${escapeHtml(t('dashboard.overview'))}">
      <span class="project-tab-icon">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>
      </span>
      <span class="project-tab-name">${escapeHtml(t('dashboard.overview'))}</span>
    </div>`;
  }

  _renderTabHtml(project, isActive) {
    const color = sanitizeColor(project.color);
    const colorDot = color
      ? `<span class="project-tab-color" style="background:${color}"></span>`
      : '';

    const icon = project.icon
      ? `<span class="project-tab-emoji">${escapeHtml(project.icon)}</span>`
      : `<span class="project-tab-emoji project-tab-emoji--default">${FOLDER_ICON}</span>`;

    // A project can belong to several workspaces; the badge shows the first, and
    // the tooltip names them all.
    const workspaces = getWorkspacesForProject(project.id) || [];
    const workspaceBadge = workspaces.length
      ? `<span class="project-tab-workspace" title="${escapeHtml(workspaces.map(w => w.name).join(', '))}">${escapeHtml(workspaces[0].icon || '\u{1F4E6}')}</span>`
      : '';

    const stats = this._callbacks.getTerminalStatsForProject(getProjectIndex(project.id)) || { total: 0, working: 0 };
    const sessionBadge = stats.total > 0
      ? `<span class="project-tab-sessions${stats.working > 0 ? ' working' : ''}" title="${escapeHtml(t('projects.openSessions', { count: stats.total }))}">${stats.total}</span>`
      : '';

    const missing = isPathMissing(project.id)
      ? `<span class="project-tab-missing" title="${escapeHtml(t('projects.pathMissingTitle'))}">!</span>`
      : '';

    return `<div class="project-tab${isActive ? ' active' : ''}" data-project-id="${escapeHtml(project.id)}" role="tab" aria-selected="${isActive}" tabindex="${isActive ? '0' : '-1'}" draggable="true" title="${escapeHtml(project.path || project.name)}">
      ${colorDot}
      <span class="project-tab-icon">${icon}${workspaceBadge}</span>
      <span class="project-tab-name">${escapeHtml(project.name)}</span>
      ${missing}
      ${sessionBadge}
      <button class="project-tab-close" data-project-id="${escapeHtml(project.id)}" aria-label="${escapeHtml(t('common.close'))}" title="${escapeHtml(t('common.close'))}">
        <svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
      </button>
    </div>`;
  }

  _onClick(e) {
    const closeBtn = e.target.closest('.project-tab-close');
    if (closeBtn) {
      e.stopPropagation();
      this._close(closeBtn.dataset.projectId);
      return;
    }

    const tab = e.target.closest('.project-tab');
    if (!tab) return;
    if (tab.dataset.overview) {
      if (this._callbacks.onSelectOverview) this._callbacks.onSelectOverview();
      return;
    }
    this._select(tab.dataset.projectId);
  }

  _onContextMenu(e) {
    const tab = e.target.closest('.project-tab[data-project-id]');
    if (!tab) return;
    e.preventDefault();
    const project = getProject(tab.dataset.projectId);
    if (project && this._callbacks.onContextMenu) {
      this._callbacks.onContextMenu(project, e.clientX, e.clientY);
    }
  }

  _select(projectId) {
    const project = getProject(projectId);
    if (!project) return;
    const projectIndex = getProjectIndex(projectId);
    // Re-selecting the active project is normally a no-op, but not while the
    // Overview is showing: its tab is how you get back to a single project,
    // and clicking the one you were already on has to work.
    if (!this._overviewActive && projectsState.get().selectedProjectFilter === projectIndex) return;
    // The host owns the switch (it also drives the screens), so it opens the tab.
    if (this._callbacks.onSelectProject) this._callbacks.onSelectProject(projectIndex, project);
  }

  _close(projectId) {
    const project = getProject(projectId);
    if (!project) return;
    if (this._callbacks.onCloseProject) this._callbacks.onCloseProject(project);
  }

  /**
   * Close a tab and report which project became active, so the caller can
   * re-render the screens that follow the project context.
   * @returns {number|null}
   */
  closeTab(projectId) {
    return closeProjectTab(projectId);
  }

  _scrollActiveIntoView() {
    const active = this.el.querySelector('.project-tab.active');
    if (!active) return;
    const { offsetLeft, offsetWidth } = active;
    const viewLeft = this.el.scrollLeft;
    const viewRight = viewLeft + this.el.clientWidth;
    if (offsetLeft < viewLeft) {
      this.el.scrollLeft = offsetLeft;
    } else if (offsetLeft + offsetWidth > viewRight) {
      this.el.scrollLeft = offsetLeft + offsetWidth - this.el.clientWidth;
    }
  }

  _initDragReorder() {
    this.on(this.el, 'dragstart', (e) => {
      const tab = e.target.closest('.project-tab[data-project-id]');
      if (!tab) return;
      this._dragProjectId = tab.dataset.projectId;
      tab.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox/Chromium need data set for the drag to start at all.
      try { e.dataTransfer.setData('text/plain', this._dragProjectId); } catch (_) { /* noop */ }
    });

    this.on(this.el, 'dragover', (e) => {
      if (!this._dragProjectId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const over = e.target.closest('.project-tab[data-project-id]');
      this.el.querySelectorAll('.project-tab').forEach(el => el.classList.remove('drop-before', 'drop-after'));
      if (!over || over.dataset.projectId === this._dragProjectId) return;
      const rect = over.getBoundingClientRect();
      over.classList.add(e.clientX < rect.left + rect.width / 2 ? 'drop-before' : 'drop-after');
    });

    this.on(this.el, 'drop', (e) => {
      if (!this._dragProjectId) return;
      e.preventDefault();
      const over = e.target.closest('.project-tab[data-project-id]');
      if (over && over.dataset.projectId !== this._dragProjectId) {
        const rect = over.getBoundingClientRect();
        const openIds = projectsState.get().openProjectIds;
        let target = openIds.indexOf(over.dataset.projectId);
        if (e.clientX >= rect.left + rect.width / 2) target += 1;
        // Removing the dragged tab first shifts everything after it left by one.
        if (openIds.indexOf(this._dragProjectId) < target) target -= 1;
        moveProjectTab(this._dragProjectId, target);
      }
      this._clearDragState();
    });

    this.on(this.el, 'dragend', () => this._clearDragState());
  }

  _clearDragState() {
    this._dragProjectId = null;
    this.el.querySelectorAll('.project-tab').forEach(el => {
      el.classList.remove('dragging', 'drop-before', 'drop-after');
    });
  }
}

// Singleton, mirroring the other components in this folder.
let _instance = null;

function initProjectBar(callbacks = {}) {
  const el = document.getElementById('project-tabs');
  if (!el) return null;
  if (!_instance) {
    _instance = new ProjectBar(el);
    _instance.setCallbacks(callbacks);
    _instance.init();
  } else {
    _instance.setCallbacks(callbacks);
    _instance.render();
  }
  return _instance;
}

module.exports = {
  ProjectBar,
  initProjectBar,
  render: () => _instance?.render(),
  closeTab: (projectId) => _instance?.closeTab(projectId),
  setOverviewActive: (active) => _instance?.setOverviewActive(active),
};
