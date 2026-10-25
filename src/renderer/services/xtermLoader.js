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

/** addon-fit's own fallback for the scrollbar it reserves, inlined in its build. */
const FIT_SCROLLBAR_WIDTH = 14;

/**
 * The padding and border a `border-box` element carries inside its computed
 * width and height, which is the part of it a child cannot use.
 * @param {CSSStyleDeclaration} style
 * @returns {{ vertical: number, horizontal: number }}
 */
function borderBoxInset(style) {
  if (style.getPropertyValue('box-sizing') !== 'border-box') return { vertical: 0, horizontal: 0 };
  const px = (prop) => parseFloat(style.getPropertyValue(prop)) || 0;
  return {
    vertical: px('padding-top') + px('padding-bottom') + px('border-top-width') + px('border-bottom-width'),
    horizontal: px('padding-left') + px('padding-right') + px('border-left-width') + px('border-right-width')
  };
}

/**
 * FitAddon, measuring the space its terminal actually gets (issue #242).
 *
 * FitAddon sizes the grid from its parent's computed `height` and `width`, and
 * subtracts only the terminal element's own padding. That is right for a
 * `content-box` parent, but base.css makes every element `border-box`, where
 * the computed size includes the parent's padding and border too. A
 * `.terminal-wrapper` has 8px of padding, so every terminal was sized for 16px
 * more than it has: one row too many, the last one (the CLI's status line)
 * drawn below the bottom of the window, and a column hidden on the right.
 *
 * Same arithmetic as FitAddon, minus that inset, and never more than FitAddon
 * itself would propose. Anything unexpected falls back to FitAddon's answer,
 * which is what every terminal used before.
 *
 * @param {Function} FitAddon - the addon-fit class
 * @returns {Function} a drop-in subclass
 */
function withContentBoxFit(FitAddon) {
  return class ContentBoxFitAddon extends FitAddon {
    activate(terminal) {
      super.activate(terminal);
      this._ctTerminal = terminal;
    }

    proposeDimensions() {
      const proposed = super.proposeDimensions();
      const terminal = this._ctTerminal;
      if (!proposed || !terminal) return proposed;
      try {
        const parent = terminal.element.parentElement;
        const inset = borderBoxInset(window.getComputedStyle(parent));
        if (!inset.vertical && !inset.horizontal) return proposed;

        const cell = terminal._core._renderService.dimensions.css.cell;
        const elementStyle = window.getComputedStyle(terminal.element);
        const parentStyle = window.getComputedStyle(parent);
        const px = (style, prop) => parseInt(style.getPropertyValue(prop)) || 0;
        const scrollbarWidth = terminal.options.scrollback === 0
          ? 0
          : (terminal.options.overviewRuler?.width || FIT_SCROLLBAR_WIDTH);

        const availableHeight = px(parentStyle, 'height') - inset.vertical
          - px(elementStyle, 'padding-top') - px(elementStyle, 'padding-bottom');
        const availableWidth = Math.max(0, px(parentStyle, 'width')) - inset.horizontal
          - px(elementStyle, 'padding-left') - px(elementStyle, 'padding-right') - scrollbarWidth;

        const rows = Math.max(1, Math.floor(availableHeight / cell.height));
        const cols = Math.max(2, Math.floor(availableWidth / cell.width));
        if (!Number.isFinite(rows) || !Number.isFinite(cols)) return proposed;
        return { rows: Math.min(rows, proposed.rows), cols: Math.min(cols, proposed.cols) };
      } catch (e) {
        return proposed;
      }
    }
  };
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
    _core = { Terminal, FitAddon: withContentBoxFit(FitAddon) };
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
function attachWebglAddon(terminal, { enabled = true } = {}) {
  // The escape hatch for issue #207. A glyph atlas that disagrees with the
  // font's real metrics is a driver-and-font specific fault we cannot probe
  // for, and `--disable-gpu` is not a workaround: Electron still answers
  // getContext('webgl2') through SwiftShader, so hasWebgl2() stays true and
  // the addon still attaches. Only an explicit setting can take this path out.
  if (!enabled) return Promise.resolve(false);

  return loadWebgl().then((WebglAddon) => {
    if (!WebglAddon || !terminal) return false;
    // `element` is set by Terminal#open and cleared by dispose(); a detached
    // one means the tab went away while we were fetching.
    if (!terminal.element || !terminal.element.isConnected) return false;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      terminal.loadAddon(webgl);
      // Kept so the font-size setting can re-cut the atlas; see clearGlyphAtlas.
      terminal._ctWebglAddon = webgl;
      repaintWhenFontsSettle(terminal, webgl);
      trackForRepaintOnReturn(terminal, webgl);
      return true;
    } catch (e) {
      console.warn('WebGL addon failed to load, using DOM renderer:', e.message);
      return false;
    }
  });
}

/**
 * Rasterise the glyph atlas again once the page's fonts have stopped moving.
 *
 * The atlas is built from the metrics in force when the addon attaches, and
 * those are not final. The terminal asks for `Cascadia Code` first and falls
 * back through `Consolas` to `monospace`; whichever wins can be resolved after
 * the first paint, and a fallback's advance width is not the one the atlas was
 * cut for. From then on every glyph is drawn on the old grid: the caret lands
 * a column away from where text goes in, and a cell repainted in place keeps a
 * sliver of what was under it until something forces a full redraw.
 *
 * `document.fonts.ready` is the one signal that says the measurements are now
 * stable. Cheap, idempotent, and a no-op where it is unsupported.
 */
function repaintWhenFontsSettle(terminal, webgl) {
  const fonts = typeof document !== 'undefined' && document.fonts;
  if (!fonts || typeof fonts.ready?.then !== 'function') return;
  fonts.ready.then(() => {
    // The tab can close while the fonts settle.
    if (!terminal.element || !terminal.element.isConnected) return;
    try {
      webgl.clearTextureAtlas();
      terminal.refresh(0, terminal.rows - 1);
    } catch (e) { /* disposed mid-flight */ }
  }).catch(() => { /* never worth failing a terminal over */ });
}

/**
 * Re-cut every live atlas when the window comes back into view, on Linux.
 *
 * While the window is hidden or behind another app, Chromium on Linux may
 * evict the GPU textures backing the atlas without raising a context loss.
 * xterm keeps sampling the stale texture on return, which shows up as
 * half-drawn or scrambled glyphs until the next full redraw. Rebuilding costs
 * one rasterisation pass per terminal, which is why it is not paid on every
 * alt-tab elsewhere: nothing has shown this fault off Linux.
 *
 * `focus` and `visibilitychange` both fire on the same return, so the repaint
 * is coalesced into one frame. That frame also lets the compositor restore the
 * surface before anything is redrawn.
 */
const _webglTerminals = new Map();
let _returnListenersInstalled = false;
let _repaintScheduled = false;

function isLinux() {
  return typeof window !== 'undefined'
    && window.electron_nodeModules?.process?.platform === 'linux';
}

/** A closed terminal has nothing left to repaint. */
function pruneDeadTerminals() {
  for (const terminal of _webglTerminals.keys()) {
    if (!terminal.element || !terminal.element.isConnected) _webglTerminals.delete(terminal);
  }
}

function repaintAllAtlases() {
  _repaintScheduled = false;
  pruneDeadTerminals();
  for (const [terminal, webgl] of _webglTerminals) {
    try {
      webgl.clearTextureAtlas();
      terminal.refresh(0, terminal.rows - 1);
    } catch (e) { _webglTerminals.delete(terminal); }
  }
}

function scheduleRepaint() {
  if (_repaintScheduled) return;
  _repaintScheduled = true;
  requestAnimationFrame(repaintAllAtlases);
}

function trackForRepaintOnReturn(terminal, webgl) {
  if (!isLinux()) return;
  // Closing a tab does not tell us, so whatever closed since the last attach
  // is dropped here: the map stays bounded by the tabs actually open.
  pruneDeadTerminals();
  _webglTerminals.set(terminal, webgl);
  webgl.onContextLoss(() => _webglTerminals.delete(terminal));
  if (_returnListenersInstalled) return;
  _returnListenersInstalled = true;
  window.addEventListener('focus', scheduleRepaint);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleRepaint();
  });
}

// There is deliberately no prefetch here. Warming the module on an idle
// callback would keep the 719 KB off the path to first paint while still
// parsing it in every session, including the ones that never open a terminal —
// which is most of the benefit thrown away to buy back a few hundred
// milliseconds on one click. The load is started before the PTY spawn instead
// (see TerminalManager.createTerminal), so the two overlap.

/**
 * Drop the cached glyph atlas of a terminal, if it has one.
 *
 * Anything that changes how a cell is measured — the font size setting is the
 * one the UI exposes — leaves the atlas holding glyphs rasterised for the old
 * grid. xterm redraws from that cache, so without this the new size is laid
 * out with the old advance widths. A no-op on a DOM-rendered terminal, which
 * has no atlas to begin with.
 *
 * @param {Object} terminal
 */
function clearGlyphAtlas(terminal) {
  const webgl = terminal && terminal._ctWebglAddon;
  if (!webgl || typeof webgl.clearTextureAtlas !== 'function') return;
  try { webgl.clearTextureAtlas(); } catch (e) { /* disposed */ }
}

module.exports = {
  loadXterm,
  getXtermSync,
  isXtermLoaded,
  loadWebgl,
  attachWebglAddon,
  clearGlyphAtlas,
  trackForRepaintOnReturn,
  withContentBoxFit
};
