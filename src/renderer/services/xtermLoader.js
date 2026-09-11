/**
 * Lazy loader for @xterm/xterm and its addons.
 *
 * xterm is the single heaviest thing the renderer ever loads — 476 KB for the
 * emulator and another 242 KB for the WebGL addon — and until this module
 * existed all 719 KB were parsed and evaluated at every startup, because five
 * files require()d them at the top level. Opening the app on the dashboard, on
 * a chat tab, or on any tab with no terminal mounted paid the whole bill for
 * nothing.
 *
 * Everything that needs xterm goes through here rather than calling import()
 * itself. esbuild's code splitting already guarantees one copy of the module,
 * so the memoized promise is not about instance identity; it is about having a
 * single in-flight load, a single place that decides when the WebGL addon is
 * worth fetching at all, and a single failure path.
 *
 * The core and the WebGL addon are deliberately two separate loads:
 *
 *  - the core is required to draw anything, so a caller must await it before
 *    constructing a Terminal;
 *  - the addon is an optimisation with an existing DOM-renderer fallback, so it
 *    is attached after the terminal is already on screen and its failure is a
 *    console.debug, not an error. It is also not fetched at all when the machine
 *    has no WebGL2 context to give it, which is the case the fallback exists for.
 */

/** @type {Promise<{Terminal: Function, FitAddon: Function}>|null} */
let _corePromise = null;

/** @type {{Terminal: Function, FitAddon: Function}|null} */
let _core = null;

/** @type {Promise<Function|null>|null} */
let _webglPromise = null;

/**
 * esbuild exposes a CommonJS module's exports as the default export, and the
 * @xterm packages ship both a CJS and an ESM build. Reading the named export
 * first and falling back to `default` covers whichever one the bundler picked.
 * @param {Object} mod
 * @param {string} name
 * @returns {Function|undefined}
 */
function pick(mod, name) {
  return (mod && mod[name]) || (mod && mod.default && mod.default[name]);
}

/**
 * Load the terminal emulator and the fit addon.
 *
 * Memoized: concurrent callers share one fetch, later callers get the resolved
 * value. A rejection clears the memo, so a load that failed on a flaky first
 * attempt can be retried by simply opening another terminal.
 *
 * @returns {Promise<{Terminal: Function, FitAddon: Function}>}
 */
function loadXterm() {
  if (_corePromise) return _corePromise;

  _corePromise = Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit')
  ]).then(([xtermMod, fitMod]) => {
    const Terminal = pick(xtermMod, 'Terminal');
    const FitAddon = pick(fitMod, 'FitAddon');
    if (typeof Terminal !== 'function' || typeof FitAddon !== 'function') {
      throw new Error('xterm loaded but exported no Terminal/FitAddon');
    }
    _core = { Terminal, FitAddon };
    return _core;
  }).catch((err) => {
    _corePromise = null;
    throw err;
  });

  return _corePromise;
}

/**
 * The already-loaded core, or null if nothing has loaded it yet.
 *
 * For the rare caller that cannot become async. Anything that can await should
 * call `loadXterm()` instead — this returns null on the very path that matters,
 * the first terminal of the session.
 *
 * @returns {{Terminal: Function, FitAddon: Function}|null}
 */
function getXtermSync() {
  return _core;
}

/**
 * Has the emulator been loaded (or at least started loading) already?
 * Used to decide whether a mount is going to be instant or needs a placeholder.
 * @returns {boolean}
 */
function isXtermLoaded() {
  return _core !== null;
}

/**
 * Does this machine have a WebGL2 context to give the addon?
 *
 * WebglAddon needs WebGL2 and throws in its constructor without it. Probing
 * with a throwaway canvas costs a few hundred microseconds and saves fetching
 * and parsing 242 KB on a machine that would immediately fall back to the DOM
 * renderer anyway.
 *
 * @returns {boolean}
 */
function hasWebgl2() {
  try {
    const canvas = document.createElement('canvas');
    return !!canvas.getContext('webgl2');
  } catch (e) {
    return false;
  }
}

/**
 * Load the WebGL addon constructor, or null if it is unavailable here.
 * Memoized, and never rejects — an unavailable addon is a fallback, not a fault.
 * @returns {Promise<Function|null>}
 */
function loadWebgl() {
  if (_webglPromise) return _webglPromise;

  _webglPromise = (async () => {
    if (!hasWebgl2()) return null;
    const mod = await import('@xterm/addon-webgl');
    const WebglAddon = pick(mod, 'WebglAddon');
    return typeof WebglAddon === 'function' ? WebglAddon : null;
  })().catch((err) => {
    console.debug('[xterm] WebGL addon unavailable, using the DOM renderer:', err && err.message);
    return null;
  });

  return _webglPromise;
}

/**
 * Attach the WebGL renderer to a terminal that is already open.
 *
 * Fire-and-forget by design: the terminal draws with the DOM renderer from the
 * moment it is opened and swaps to WebGL when the addon lands, so nothing on
 * screen waits for this. Callers may ignore the returned promise.
 *
 * The terminal can be disposed while the chunk is in flight — closing a tab
 * immediately after opening it is one keystroke — so the element is rechecked
 * before loadAddon(), and the whole thing stays inside a try/catch.
 *
 * @param {Object} terminal - an opened xterm Terminal
 * @returns {Promise<boolean>} true if the WebGL renderer was attached
 */
function attachWebglAddon(terminal) {
  return loadWebgl().then((WebglAddon) => {
    if (!WebglAddon || !terminal) return false;
    // `element` is set by Terminal#open and cleared by dispose(); a detached
    // one means the tab went away while we were fetching.
    if (!terminal.element || !terminal.element.isConnected) return false;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      terminal.loadAddon(webgl);
      return true;
    } catch (e) {
      console.warn('WebGL addon failed to load, using DOM renderer:', e.message);
      return false;
    }
  });
}

// There is deliberately no prefetch here. Warming the module on an idle
// callback would keep the 719 KB off the path to first paint while still
// parsing it in every session, including the ones that never open a terminal —
// which is most of the benefit thrown away to buy back a few hundred
// milliseconds on one click. The load is started before the PTY spawn instead
// (see TerminalManager.createTerminal), so the two overlap.

module.exports = {
  loadXterm,
  getXtermSync,
  isXtermLoaded,
  loadWebgl,
  attachWebglAddon
};
