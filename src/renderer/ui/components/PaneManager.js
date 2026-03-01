/**
 * PaneManager
 * Manages pane lifecycle and provides container accessors for terminal tabs.
 * Foundation for multi-pane splitview (Phase 31).
 *
 * Initial state: exactly 1 pane ("pane-0").
 * TerminalManager uses getTabsContainer() / getContentContainer() instead of
 * getElementById('terminals-tabs') / getElementById('terminals-container').
 */

// Core state
const panes = new Map(); // paneId -> { el, tabsEl, contentEl, tabs: Set<string>, activeTab: string|null }
let paneOrder = []; // ordered left to right, max 3
let activePaneId = null; // currently focused pane
let nextPaneNum = 0;

/**
 * Called once on app init — reads the existing pane-0 DOM structure.
 */
function initPanes() {
  const paneArea = document.getElementById('split-pane-area');
  if (!paneArea) {
    console.error('[PaneManager] split-pane-area element not found');
    return;
  }
  const paneEl = paneArea.querySelector('.split-pane[data-pane-id="0"]');
  if (!paneEl) {
    console.error('[PaneManager] pane-0 element not found');
    return;
  }
  const tabsEl = paneEl.querySelector('.pane-tabs');
  const contentEl = paneEl.querySelector('.pane-content');

  panes.set('pane-0', { el: paneEl, tabsEl, contentEl, tabs: new Set(), activeTab: null });
  paneOrder = ['pane-0'];
  activePaneId = 'pane-0';
  nextPaneNum = 1;

  // Set up drop overlay for the initial pane
  setupPaneDropOverlay('pane-0');

  // Set up drag targets for content-area drop-to-split
  setupPaneDragTargets();
}

/**
 * Create a new pane — inserts DOM after the specified pane (or at end).
 * Returns the new paneId. Max 3 panes enforced.
 */
function createPane(afterPaneId) {
  if (paneOrder.length >= 3) {
    console.warn('[PaneManager] Max 3 panes reached');
    return null;
  }

  const paneId = `pane-${nextPaneNum++}`;
  const paneArea = document.getElementById('split-pane-area');

  // Create divider
  const divider = document.createElement('div');
  divider.className = 'split-divider';
  divider.dataset.paneId = paneId;

  // Create pane DOM
  const paneEl = document.createElement('div');
  paneEl.className = 'split-pane';
  paneEl.dataset.paneId = String(nextPaneNum - 1);

  const tabsEl = document.createElement('div');
  tabsEl.className = 'pane-tabs';
  tabsEl.setAttribute('role', 'tablist');
  tabsEl.setAttribute('aria-label', 'Terminal tabs');

  const contentEl = document.createElement('div');
  contentEl.className = 'pane-content';
  contentEl.setAttribute('role', 'region');
  contentEl.setAttribute('aria-label', 'Terminals');

  paneEl.appendChild(tabsEl);
  paneEl.appendChild(contentEl);

  // Insert after the specified pane
  const afterIdx = afterPaneId ? paneOrder.indexOf(afterPaneId) : paneOrder.length - 1;
  const afterPane = afterPaneId ? panes.get(afterPaneId) : panes.get(paneOrder[paneOrder.length - 1]);

  if (afterPane && afterPane.el.nextSibling) {
    paneArea.insertBefore(divider, afterPane.el.nextSibling);
    paneArea.insertBefore(paneEl, divider.nextSibling);
  } else {
    paneArea.appendChild(divider);
    paneArea.appendChild(paneEl);
  }

  // Update state
  panes.set(paneId, { el: paneEl, tabsEl, contentEl, tabs: new Set(), activeTab: null });
  paneOrder.splice(afterIdx + 1, 0, paneId);

  // Set up drop overlay for the new pane
  setupPaneDropOverlay(paneId);

  return paneId;
}

/**
 * Collapse a pane — removes DOM + preceding divider, removes from Map and paneOrder.
 * Caller (TerminalManager) handles tab reassignment before calling collapse.
 * If the collapsed pane was the active pane, set activePaneId to the first remaining pane.
 */
function collapsePane(paneId) {
  if (paneOrder.length <= 1) {
    console.warn('[PaneManager] Cannot collapse last pane');
    return false;
  }

  const pane = panes.get(paneId);
  if (!pane) return false;

  const paneArea = document.getElementById('split-pane-area');

  // Remove preceding divider (if any)
  const divider = paneArea.querySelector(`.split-divider[data-pane-id="${paneId}"]`);
  if (divider) divider.remove();

  // Remove pane DOM
  pane.el.remove();

  // Update state
  panes.delete(paneId);
  paneOrder = paneOrder.filter(id => id !== paneId);

  if (activePaneId === paneId) {
    activePaneId = paneOrder[0] || null;
  }

  return true;
}

/**
 * Register a tab (termId) to a pane.
 */
function registerTab(termId, paneId) {
  const pane = panes.get(paneId);
  if (!pane) {
    console.warn(`[PaneManager] Cannot register tab ${termId} — pane ${paneId} not found`);
    return;
  }
  pane.tabs.add(termId);
}

/**
 * Unregister a tab — returns the paneId if pane is now empty, null otherwise.
 */
function unregisterTab(termId) {
  for (const [paneId, pane] of panes) {
    if (pane.tabs.has(termId)) {
      pane.tabs.delete(termId);
      if (pane.activeTab === termId) {
        const remaining = Array.from(pane.tabs);
        pane.activeTab = remaining.length > 0 ? remaining[0] : null;
      }
      return pane.tabs.size === 0 ? paneId : null;
    }
  }
  return null;
}

/**
 * Get the pane a tab belongs to — returns paneId or null.
 */
function getPaneForTab(termId) {
  for (const [paneId, pane] of panes) {
    if (pane.tabs.has(termId)) {
      return paneId;
    }
  }
  return null;
}

/**
 * Move a tab between panes (DOM + state).
 */
/**
 * Move a tab between panes (DOM + state).
 * Returns true if source pane is now empty.
 */
function moveTabToPane(termId, targetPaneId) {
  const sourcePaneId = getPaneForTab(termId);
  if (!sourcePaneId || sourcePaneId === targetPaneId) return false;

  const sourcePane = panes.get(sourcePaneId);
  const targetPane = panes.get(targetPaneId);
  if (!sourcePane || !targetPane) return false;

  // Move tab DOM element
  const tabEl = document.querySelector(`.terminal-tab[data-id="${termId}"]`);
  if (tabEl) {
    targetPane.tabsEl.appendChild(tabEl);
  }

  // Move wrapper DOM element
  const wrapperEl = document.querySelector(`.terminal-wrapper[data-id="${termId}"]`);
  if (wrapperEl) {
    targetPane.contentEl.appendChild(wrapperEl);
  }

  // Update state
  sourcePane.tabs.delete(termId);
  if (sourcePane.activeTab === termId) {
    const remaining = Array.from(sourcePane.tabs);
    sourcePane.activeTab = remaining.length > 0 ? remaining[0] : null;

    // Activate the new active tab's DOM elements in the source pane
    if (sourcePane.activeTab) {
      sourcePane.tabsEl.querySelectorAll('.terminal-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.id === sourcePane.activeTab));
      sourcePane.contentEl.querySelectorAll('.terminal-wrapper').forEach(w => {
        w.classList.toggle('active', w.dataset.id === sourcePane.activeTab);
        w.style.removeProperty('display');
      });
    }
  }
  targetPane.tabs.add(termId);

  return sourcePane.tabs.size === 0;
}

// --- Container accessors — THE KEY API for TerminalManager ---

/**
 * Get the tabs container element for a pane.
 * If no paneId specified, returns the active pane's tabs container.
 */
function getTabsContainer(paneId) {
  return panes.get(paneId || activePaneId)?.tabsEl || null;
}

/**
 * Get the content container element for a pane.
 * If no paneId specified, returns the active pane's content container.
 */
function getContentContainer(paneId) {
  return panes.get(paneId || activePaneId)?.contentEl || null;
}

/**
 * Get default pane for new tabs (the active pane).
 */
function getDefaultPaneId() {
  return activePaneId || paneOrder[0];
}

function getActivePaneId() {
  return activePaneId;
}

function setActivePaneId(paneId) {
  if (activePaneId && panes.has(activePaneId)) {
    panes.get(activePaneId).el.classList.remove('focused');
  }
  if (panes.has(paneId)) {
    activePaneId = paneId;
    panes.get(paneId).el.classList.add('focused');
  }
}

function setPaneActiveTab(paneId, termId) {
  const pane = panes.get(paneId);
  if (pane) pane.activeTab = termId;
}

function getPaneActiveTab(paneId) {
  return panes.get(paneId)?.activeTab || null;
}

// --- Pane focus handling ---

let onPaneFocusCallback = null;

function setOnPaneFocus(callback) {
  onPaneFocusCallback = callback;
}

function setupPaneFocusHandlers() {
  const paneArea = document.getElementById('split-pane-area');
  if (!paneArea) return;
  paneArea.addEventListener('mousedown', (e) => {
    const paneEl = e.target.closest('.split-pane');
    if (!paneEl) return;
    const paneId = 'pane-' + paneEl.dataset.paneId;
    if (paneId === activePaneId) return; // already focused

    const pane = panes.get(paneId);
    if (pane && pane.activeTab) {
      if (onPaneFocusCallback) {
        onPaneFocusCallback(pane.activeTab);
      }
    }
  }, true); // capture phase to fire before xterm focus
}

function getPaneOrder() {
  return [...paneOrder];
}

function getPanes() {
  return panes;
}

function getPaneCount() {
  return paneOrder.length;
}

function getActivePaneIndex() {
  return paneOrder.indexOf(activePaneId);
}

// --- Drop overlay management ---

/**
 * Add a semi-transparent drop overlay to a pane's content area.
 */
function setupPaneDropOverlay(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;

  const overlay = document.createElement('div');
  overlay.className = 'split-drop-overlay';
  overlay.dataset.paneId = paneId.replace('pane-', '');
  pane.contentEl.style.position = 'relative';
  pane.contentEl.appendChild(overlay);
}

function showDropOverlay(paneId) {
  hideAllDropOverlays();
  const pane = panes.get(paneId);
  if (!pane) return;
  const overlay = pane.contentEl.querySelector('.split-drop-overlay');
  if (overlay) overlay.classList.add('visible');
}

function hideDropOverlay(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;
  const overlay = pane.contentEl.querySelector('.split-drop-overlay');
  if (overlay) overlay.classList.remove('visible');
}

function hideAllDropOverlays() {
  document.querySelectorAll('.split-drop-overlay.visible').forEach(el =>
    el.classList.remove('visible'));
}

// --- Drag tab tracking (set by TerminalManager's dragstart) ---

let _currentDragTabId = null;
function setDragTabId(id) { _currentDragTabId = id; }
function clearDragTabId() { _currentDragTabId = null; }

// Callback when tab is moved (to trigger setActiveTerminal in TerminalManager)
let onTabMovedCallback = null;
function setOnTabMoved(callback) { onTabMovedCallback = callback; }

/**
 * Set up drag-over/drop handlers on content areas for split-by-drag.
 * Delegated on split-pane-area for all panes (current and future).
 */
function setupPaneDragTargets() {
  const paneArea = document.getElementById('split-pane-area');
  if (!paneArea) return;

  paneArea.addEventListener('dragover', (e) => {
    const contentEl = e.target.closest('.pane-content');
    if (!contentEl) return;

    const paneEl = contentEl.closest('.split-pane');
    if (!paneEl) return;
    const targetPaneId = 'pane-' + paneEl.dataset.paneId;

    const draggedTabId = _currentDragTabId;
    if (!draggedTabId) return;

    const sourcePaneId = getPaneForTab(draggedTabId);

    if (sourcePaneId === targetPaneId && paneOrder.length < 3) {
      // Same pane — only show overlay on RIGHT HALF (prevent accidental splits)
      const contentRect = contentEl.getBoundingClientRect();
      const isRightHalf = e.clientX > contentRect.left + contentRect.width / 2;
      if (isRightHalf) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        showDropOverlay(targetPaneId);
      } else {
        hideDropOverlay(targetPaneId);
      }
    } else if (sourcePaneId !== targetPaneId) {
      // Different pane — show overlay for "move to this pane"
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      showDropOverlay(targetPaneId);
    }
  });

  paneArea.addEventListener('dragleave', (e) => {
    const contentEl = e.target.closest('.pane-content');
    if (!contentEl) return;
    const relatedTarget = e.relatedTarget;
    if (!contentEl.contains(relatedTarget)) {
      const paneEl = contentEl.closest('.split-pane');
      if (paneEl) {
        hideDropOverlay('pane-' + paneEl.dataset.paneId);
      }
    }
  });

  paneArea.addEventListener('drop', (e) => {
    const contentEl = e.target.closest('.pane-content');
    if (!contentEl) return;

    const paneEl = contentEl.closest('.split-pane');
    if (!paneEl) return;
    const targetPaneId = 'pane-' + paneEl.dataset.paneId;

    const draggedTabId = _currentDragTabId;
    if (!draggedTabId) return;

    e.preventDefault();
    hideAllDropOverlays();

    const sourcePaneId = getPaneForTab(draggedTabId);
    if (sourcePaneId === targetPaneId) {
      // Same pane: split right (create new pane and move tab there)
      if (paneOrder.length < 3) {
        const newPaneId = createPane(targetPaneId);
        if (newPaneId) {
          const sourceEmpty = moveTabToPane(draggedTabId, newPaneId);
          if (onTabMovedCallback) onTabMovedCallback(draggedTabId);
          if (sourceEmpty && paneOrder.length > 1) collapsePane(sourcePaneId);
        }
      }
    } else {
      // Different pane: move tab to target pane
      const sourceEmpty = moveTabToPane(draggedTabId, targetPaneId);
      if (onTabMovedCallback) onTabMovedCallback(draggedTabId);
      if (sourceEmpty && paneOrder.length > 1) collapsePane(sourcePaneId);
    }
  });
}

module.exports = {
  initPanes,
  createPane,
  collapsePane,
  registerTab,
  unregisterTab,
  getPaneForTab,
  moveTabToPane,
  getTabsContainer,
  getContentContainer,
  getDefaultPaneId,
  getActivePaneId,
  setActivePaneId,
  setPaneActiveTab,
  getPaneActiveTab,
  setupPaneFocusHandlers,
  setOnPaneFocus,
  getPaneOrder,
  getPanes,
  getPaneCount,
  setupPaneDropOverlay,
  setupPaneDragTargets,
  setDragTabId,
  clearDragTabId,
  setOnTabMoved,
  hideAllDropOverlays,
  getActivePaneIndex,
};
