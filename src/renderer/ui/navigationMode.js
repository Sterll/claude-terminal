/**
 * Navigation mode
 *
 * Two navigations ship together and only one is mounted at a time: the project
 * tab bar, or the projects sidebar it replaced. Which one is a body class.
 *
 * Two nodes are shared rather than duplicated — the projects host and the tools
 * row — because a second `#projects-list` or a second tool row would be two
 * implementations drifting apart. They are moved to where each navigation
 * expects them, which is what most of this module does.
 */

const MODES = ['tabs', 'sidebar'];

/** @returns {boolean} true when `mode` is a navigation the app can mount */
function isNavigationMode(mode) {
  return MODES.includes(mode);
}

/**
 * The mode to mount for a stored setting. Anything unset or unrecognised falls
 * back to the tab bar, which is what a fresh install gets.
 * @param {string|null|undefined} stored
 * @returns {'tabs'|'sidebar'}
 */
function resolveNavigationMode(stored) {
  return stored === 'sidebar' ? 'sidebar' : 'tabs';
}

/**
 * Apply a mode to the DOM: the body class, and the two shared nodes.
 * Safe to call before those nodes exist (first paint) and repeatedly.
 * @param {'tabs'|'sidebar'|null} mode
 * @param {Document} [doc]
 */
function applyNavigationMode(mode, doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return;
  const sidebar = resolveNavigationMode(mode) === 'sidebar';
  doc.body.classList.toggle('nav-sidebar', sidebar);
  doc.body.classList.toggle('nav-tabs', !sidebar);

  const popover = doc.getElementById('projects-popover');
  const container = doc.querySelector('.main-container');
  const content = doc.querySelector('.content');
  const layout = doc.getElementById('claude-layout');
  const showBtn = doc.getElementById('btn-show-projects');
  const tools = doc.getElementById('project-bar-tools');
  const header = doc.getElementById('terminals-header');
  const bar = doc.getElementById('project-bar');

  if (sidebar) {
    // Docked between the nav and the content, so it stands beside every screen
    // rather than inside one of them. It used to live in .claude-layout, which
    // meant it vanished with the Claude tab: in sidebar mode Dashboard, Git,
    // Replay, Tasks and Files were left with no project switcher at all.
    if (popover && container && content && popover.parentElement !== container) {
      container.insertBefore(popover, content);
    }
    // The strip that reopens a collapsed column travels with it, right after,
    // so the CSS can key off the adjacency.
    if (showBtn && container && content && showBtn.parentElement !== container) {
      container.insertBefore(showBtn, content);
    }
    if (tools && header && tools.parentElement !== header) header.appendChild(tools);
    // Which screens it shows on is a CSS concern (see .projects-popover.docked),
    // so no inline display to fight with.
    if (popover) {
      popover.classList.add('docked');
      popover.style.display = '';
    }
  } else {
    if (popover && content && popover.parentElement !== content) {
      content.insertBefore(popover, content.querySelector('.tab-content'));
    }
    if (showBtn && layout && showBtn.parentElement !== layout) {
      layout.insertBefore(showBtn, layout.firstChild);
    }
    if (tools && bar && tools.parentElement !== bar) bar.appendChild(tools);
    // Back to a popover: closed until the + button opens it
    if (popover) {
      popover.classList.remove('docked');
      popover.style.display = 'none';
      popover.classList.remove('collapsed');
    }
  }
}

/** True when the docked sidebar is the mounted navigation. */
function isSidebarNavigation(doc = typeof document !== 'undefined' ? document : null) {
  return !!doc && doc.body.classList.contains('nav-sidebar');
}

module.exports = {
  MODES,
  isNavigationMode,
  resolveNavigationMode,
  applyNavigationMode,
  isSidebarNavigation,
};
