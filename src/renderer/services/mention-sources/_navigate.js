/**
 * Navigation helpers shared by the palette sources.
 * -----------------------------------------------------------------------------
 * Not a source: it exports no `tools`-style contract and is never registered.
 *
 * Every palette source that jumps somewhere has the same problem. Clicking a
 * sidebar tab only *starts* the panel's render, and several panels finish it
 * asynchronously — the dashboard fetches git status, commit history and workflow
 * runs before it draws its view tabs, so its Kanban tab does not exist for well
 * over a second on a cold open. Sources used to guess at a fixed `setTimeout`,
 * which is why "jump to this card" silently landed on an empty dashboard.
 *
 * These poll for the element instead, and give up quietly: a source that cannot
 * finish its jump has still put the user on the right screen.
 * -----------------------------------------------------------------------------
 */

/** How long to keep looking before giving up on a target. */
const DEFAULT_TIMEOUT = 4000;
/** Polling interval — one frame is too eager, this is imperceptible. */
const POLL_MS = 60;

/**
 * Resolve with the first element `find()` returns, or null once time runs out.
 * @param {() => Element|null|undefined} find
 * @param {number} [timeout]
 * @returns {Promise<Element|null>}
 */
function waitFor(find, timeout = DEFAULT_TIMEOUT) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeout;
    const tick = () => {
      let el;
      try { el = find(); } catch { el = null; }
      if (el) return resolve(el);
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(tick, POLL_MS);
    };
    tick();
  });
}

/** Wait for a selector to appear anywhere in the document. */
function waitForSelector(selector, timeout) {
  return waitFor(() => document.querySelector(selector), timeout);
}

/**
 * Find an element by a data attribute whose value is user-derived (a task id, a
 * doc slug) — scanned rather than interpolated into a selector, since those
 * values are not guaranteed to be selector-safe.
 * @param {string} selector  the candidate set, e.g. '.kanban-card'
 * @param {string} dataKey   dataset key, e.g. 'taskId'
 * @param {string} value
 */
function waitForByData(selector, dataKey, value, timeout) {
  return waitFor(
    () => [...document.querySelectorAll(selector)].find(el => el.dataset[dataKey] === value),
    timeout
  );
}

/** Open a sidebar tab and wait until something inside it has rendered. */
async function openTab(tabName, readySelector, timeout) {
  document.querySelector(`[data-tab="${tabName}"]`)?.click();
  if (!readySelector) return null;
  return waitForSelector(readySelector, timeout);
}

/**
 * Make `projectId` the selected project, if it is not already.
 *
 * Sources index across every project (a kanban card names its own), but the
 * screens they jump to are per-project: landing on the dashboard of a different
 * project shows the wrong board, or none at all. Both navigations expose the
 * same hook — `.project-tab[data-project-id]` in tabs mode, `.project-item`
 * in sidebar mode — so clicking it is mode-agnostic.
 *
 * Returns false when the project is not on screen (collapsed folder, filtered
 * out); callers carry on rather than treating that as a failure.
 */
function selectProject(projectId) {
  if (!projectId) return false;
  const el = [...document.querySelectorAll('.project-tab[data-project-id], .project-item[data-project-id]')]
    .find(node => node.dataset.projectId === projectId);
  if (!el) return false;
  if (el.classList.contains('active')) return true;
  el.click();
  return true;
}

/** Scroll an element into view and flash it, so the jump is visible. */
function reveal(el, flashClass = null, flashMs = 1600) {
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (!flashClass) return;
  el.classList.add(flashClass);
  setTimeout(() => el.classList.remove(flashClass), flashMs);
}

module.exports = { waitFor, waitForSelector, waitForByData, openTab, selectProject, reveal, DEFAULT_TIMEOUT };
