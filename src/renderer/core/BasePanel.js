const { BaseComponent } = require('./BaseComponent');

/**
 * BasePanel — Base class for sidebar tab panels.
 *
 * Extends BaseComponent with panel-specific lifecycle:
 *   onActivate()   — called when the panel's tab becomes active
 *   onDeactivate() — called when navigating away
 *
 * Also provides access to ApiProvider and ServiceContainer.
 */
class BasePanel extends BaseComponent {
  /**
   * @param {HTMLElement} el
   * @param {object} options
   * @param {import('./ApiProvider').ApiProvider} options.api
   * @param {import('./ServiceContainer').ServiceContainer} options.container
   */
  constructor(el, options = {}) {
    super(el, options);
    this.api = options.api;
    this.container = options.container;
    this._active = false;
    this._panelIntervals = new Set();
  }

  /**
   * Called when this panel's tab is selected.
   * Default: marks as active and calls render().
   */
  onActivate() {
    this._active = true;
    this.render();
  }

  /**
   * Called when navigating away from this panel.
   * Clears every interval registered through setPanelInterval() so a panel
   * cannot keep polling from a tab the user has left.
   * Override to pause extra work (players, animations, modals) — call super.
   */
  onDeactivate() {
    this._active = false;
    this.clearPanelIntervals();
  }

  /** Whether this panel is currently active. */
  get isActive() {
    return this._active;
  }

  /**
   * setInterval() whose handle is owned by the panel: it is cleared by
   * onDeactivate() and destroy(), so forgetting a clearInterval() somewhere
   * cannot turn into a permanent background poll.
   * @param {Function} fn
   * @param {number} delay
   * @returns {*} interval handle
   */
  setPanelInterval(fn, delay) {
    const id = setInterval(fn, delay);
    this._panelIntervals.add(id);
    return id;
  }

  /** Clear a single interval created by setPanelInterval(). */
  clearPanelInterval(id) {
    if (id == null) return;
    clearInterval(id);
    this._panelIntervals.delete(id);
  }

  /** Clear every interval created by setPanelInterval(). */
  clearPanelIntervals() {
    for (const id of this._panelIntervals) clearInterval(id);
    this._panelIntervals.clear();
  }

  /**
   * True while `el` is still attached to the document AND actually rendered.
   *
   * Tabs are hidden by removing an `active` class, which resolves to
   * `display:none` — the panel's DOM stays in the document, so an
   * `isConnected` / `getElementById` check alone still reports "alive".
   * A `display:none` ancestor yields no client rects and a null offsetParent,
   * so a hidden panel correctly reads as not live here.
   *
   * @param {HTMLElement} [el] defaults to this panel's root element
   * @returns {boolean}
   */
  isPanelLive(el = this.el) {
    if (!el || !el.isConnected) return false;
    return el.offsetParent !== null || el.getClientRects().length > 0;
  }

  /** Clear owned intervals before the standard BaseComponent teardown. */
  destroy() {
    this.clearPanelIntervals();
    super.destroy();
  }

  /**
   * Resolve a service from the container.
   * @param {string} name
   * @returns {object}
   */
  getService(name) {
    return this.container.resolve(name);
  }
}

module.exports = { BasePanel };
