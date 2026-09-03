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
  const layout = doc.getElementById('claude-layout');
  const content = doc.querySelector('.content');
  const tools = doc.getElementById('project-bar-tools');
  const header = doc.getElementById('terminals-header');
  const bar = doc.getElementById('project-bar');

  if (sidebar) {
    // Docked column, left of the file explorer, as it was before the tab bar
    if (popover && layout && popover.parentElement !== layout) {
      layout.insertBefore(popover, layout.querySelector('#file-explorer-panel'));
    }
    if (tools && header && tools.parentElement !== header) header.appendChild(tools);
    if (popover) popover.style.display = 'flex';
  } else {
    if (popover && content && popover.parentElement !== content) {
      content.insertBefore(popover, content.querySelector('.tab-content'));
    }
    if (tools && bar && tools.parentElement !== bar) bar.appendChild(tools);
    // Back to a popover: closed until the + button opens it
    if (popover) {
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
