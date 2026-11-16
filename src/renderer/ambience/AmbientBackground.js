/**
 * AmbientBackground - the animated scene behind the whole window.
 *
 * One fixed canvas, first child of <body>, at z-index -1, so every panel that
 * lets its background through shows the scene and nothing has to be moved in
 * the DOM. A scrim div sits over the canvas to dim it towards the theme's
 * backdrop colour: that, not the panels, is what keeps text readable.
 *
 * Cost is the whole design constraint. This app measured a single composited
 * spinner at ~30% of a core on a large transcript (see IdleAnimationPauser), so
 * the loop here is deliberately frugal:
 *   - the canvas renders below device resolution (quality: 0.5 / 0.75 / 1x),
 *     the scene being dimmed and often blurred anyway;
 *   - frames are capped (30 fps by default, 12 fps while the window is
 *     unfocused, or paused outright if the user asked);
 *   - nothing runs while the document is hidden. `backgroundThrottling` is off
 *     for the main window, so rAF would otherwise keep firing when minimised;
 *   - reduced motion (OS or app setting) paints one still frame and stops.
 * A scene that throws is dropped for a plain gradient rather than retried every
 * frame.
 */

const QUALITY_SCALE = { low: 0.5, medium: 0.75, high: 1 };
const UNFOCUSED_FPS = 12;
/** A still frame is taken at this time, so particles are spread out naturally. */
const STILL_TIME = 24;

class AmbientBackground {
  constructor() {
    this.root = null;
    this.canvas = null;
    this.ctx = null;
    this.scene = null;
    this.sceneModule = null;
    this.params = null;
    // pixel: tile size in CSS px for the pixel renderer, 0 for smooth rendering.
    this.options = { fps: 30, quality: 'medium', motion: true, pauseUnfocused: false, pixel: 0 };
    this.time = 0;
    this.last = 0;
    this.lastFrame = 0;
    this.raf = 0;
    this.focused = typeof document !== 'undefined' ? document.hasFocus() : true;
    this.failed = false;
    this._onResize = this._debounce(() => this._resize(), 150);
    this._onVisibility = () => this._sync();
    this._onFocus = () => { this.focused = true; this._sync(); };
    this._onBlur = () => { this.focused = false; this._sync(); };
    this._motionQuery = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    this._onMotionPref = () => this._sync();
  }

  get mounted() { return !!this.root; }

  mount() {
    if (this.root) return;
    const root = document.createElement('div');
    root.id = 'ct-ambient';
    root.setAttribute('aria-hidden', 'true');
    const canvas = document.createElement('canvas');
    canvas.className = 'ct-ambient-canvas';
    // The tile grid of the pixel renderer: a CSS gradient over the canvas,
    // free to draw and exactly aligned with the canvas pixels.
    const grid = document.createElement('div');
    grid.className = 'ct-ambient-grid';
    const scrim = document.createElement('div');
    scrim.className = 'ct-ambient-scrim';
    root.append(canvas, grid, scrim);
    document.body.prepend(root);
    this.root = root;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    // Without a 2D context there is nothing to draw: the layer keeps its
    // backdrop colour and the scrim, which is still a themed background.
    if (!this.ctx) this.failed = true;
    window.addEventListener('resize', this._onResize);
    document.addEventListener('visibilitychange', this._onVisibility);
    window.addEventListener('focus', this._onFocus);
    window.addEventListener('blur', this._onBlur);
    this._motionQuery?.addEventListener?.('change', this._onMotionPref);
    this._resize(true);
  }

  unmount() {
    if (!this.root) return;
    this._stopLoop();
    this._destroyScene();
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    window.removeEventListener('focus', this._onFocus);
    window.removeEventListener('blur', this._onBlur);
    this._motionQuery?.removeEventListener?.('change', this._onMotionPref);
    this.root.remove();
    this.root = null;
    this.canvas = null;
    this.ctx = null;
  }

  /**
   * Swap the scene. The outgoing frame is kept on a snapshot canvas that
   * fades out over the new one, so switching themes never flashes.
   */
  setScene(sceneModule, params) {
    if (!this.root) this.mount();
    if (!this.ctx) return;
    const same = sceneModule === this.sceneModule;
    if (!same && this.scene) this._crossfadeSnapshot();
    this._destroyScene();
    this.sceneModule = sceneModule;
    this.params = params || {};
    this.failed = false;
    if (!same) this.time = 0;
    this._createScene();
    this._paintOnce();
    this._sync();
  }

  setOptions(options) {
    const prevQuality = this.options.quality;
    const prevPixel = this.options.pixel;
    this.options = { ...this.options, ...options };
    if (this.root && prevPixel !== this.options.pixel) {
      // A scene builds its layers for one resolution: rebuild it for the new one.
      this._destroyScene();
      this._resize(true);
      this._createScene();
      this._paintOnce();
    } else if (this.root && prevQuality !== this.options.quality) {
      this._resize(true);
    }
    this._sync();
  }

  // ── internals ──────────────────────────────────────────────────────────

  _scale() {
    const q = QUALITY_SCALE[this.options.quality] || QUALITY_SCALE.medium;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return Math.max(0.35, q * dpr);
  }

  _resize(force) {
    if (!this.canvas) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cell = this.options.pixel;
    let pw;
    let ph;
    let s;
    if (cell) {
      // Pixel renderer: one canvas pixel per tile, scaled up without
      // smoothing. The canvas is sized to whole tiles (a little past the
      // window edge) so the CSS grid lines fall exactly between pixels.
      pw = Math.ceil(w / cell);
      ph = Math.ceil(h / cell);
      s = 1 / cell;
      this.canvas.style.width = `${pw * cell}px`;
      this.canvas.style.height = `${ph * cell}px`;
      this.root?.style.setProperty('--pixel-cell', `${cell}px`);
    } else {
      s = this._scale();
      pw = Math.max(1, Math.round(w * s));
      ph = Math.max(1, Math.round(h * s));
      this.canvas.style.width = '';
      this.canvas.style.height = '';
    }
    this.root?.classList.toggle('pixel', !!cell);
    if (!force && this.canvas.width === pw && this.canvas.height === ph) return;
    this.canvas.width = pw;
    this.canvas.height = ph;
    this.ctx?.setTransform(s, 0, 0, s, 0, 0);
    if (this.ctx) this.ctx.imageSmoothingEnabled = !cell;
    if (this.scene) {
      try { this.scene.resize(w, h); } catch (e) { this._fail(e); }
    }
    this._paintOnce();
  }

  _createScene() {
    if (!this.sceneModule || !this.ctx) return;
    try {
      this.scene = this.sceneModule.create(this.ctx, {
        width: window.innerWidth,
        height: window.innerHeight,
        params: this.params,
        // Tile size when the pixel renderer is on: a pixel-native scene draws
        // one tile at a time, any other scene is simply drawn coarser.
        cell: this.options.pixel || 0,
      });
    } catch (e) {
      this._fail(e);
    }
  }

  _destroyScene() {
    if (this.scene) {
      try { this.scene.destroy(); } catch { /* a scene's cleanup is best effort */ }
    }
    this.scene = null;
  }

  _fail(err) {
    if (!this.failed) console.warn('[ambience] scene failed, falling back to a still gradient:', err);
    this.failed = true;
    this.scene = null;
    this._stopLoop();
    if (this.ctx) {
      const g = this.ctx.createLinearGradient(0, 0, 0, window.innerHeight);
      g.addColorStop(0, '#141826');
      g.addColorStop(1, '#07080d');
      this.ctx.fillStyle = g;
      this.ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    }
  }

  _crossfadeSnapshot() {
    if (!this.canvas || !this.root) return;
    const snap = document.createElement('canvas');
    snap.className = 'ct-ambient-canvas ct-ambient-fade';
    snap.width = this.canvas.width;
    snap.height = this.canvas.height;
    snap.style.width = this.canvas.style.width;
    snap.style.height = this.canvas.style.height;
    if (this.options.pixel) snap.style.imageRendering = 'pixelated';
    snap.getContext('2d').drawImage(this.canvas, 0, 0);
    this.canvas.after(snap);
    requestAnimationFrame(() => requestAnimationFrame(() => { snap.style.opacity = '0'; }));
    setTimeout(() => snap.remove(), 1200);
  }

  _still() {
    const reduce = document.body.classList.contains('reduce-motion') || !!this._motionQuery?.matches;
    return !this.options.motion || reduce;
  }

  _paintOnce() {
    if (!this.scene) return;
    const t = this._still() ? STILL_TIME : this.time;
    try { this.scene.render(t, 0); } catch (e) { this._fail(e); }
  }

  /** Decide whether the loop should run, given visibility, focus and motion. */
  _sync() {
    const shouldRun = !!this.scene && !this.failed && !document.hidden && !this._still()
      && (this.focused || !this.options.pauseUnfocused);
    if (shouldRun) this._startLoop();
    else {
      this._stopLoop();
      if (this._still()) this._paintOnce();
    }
  }

  _startLoop() {
    if (this.raf) return;
    this.last = performance.now();
    const tick = (now) => {
      this.raf = requestAnimationFrame(tick);
      const fps = this.focused ? this.options.fps : Math.min(this.options.fps, UNFOCUSED_FPS);
      const minGap = 1000 / Math.max(1, fps);
      if (now - this.lastFrame < minGap - 1) return;
      // Cap dt so returning to the window never jumps the scene forward.
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.lastFrame = now;
      this.time += dt;
      try { this.scene.render(this.time, dt); } catch (e) { this._fail(e); }
    };
    this.raf = requestAnimationFrame(tick);
  }

  _stopLoop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  _debounce(fn, ms) {
    let id = 0;
    return () => { clearTimeout(id); id = setTimeout(fn, ms); };
  }
}

module.exports = { AmbientBackground, QUALITY_SCALE };
