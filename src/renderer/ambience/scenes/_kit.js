/**
 * Scene kit - the small toolbox every ambient scene shares.
 *
 * A scene is a plain module:
 *
 *   module.exports = {
 *     id: 'ocean',
 *     params: [ { key, type: 'color'|'range'|'toggle', default, min?, max?, step? } ],
 *     create(ctx, env) -> { resize(width, height), render(time, dt), destroy() }
 *   };
 *
 * `env` is { width, height, params, random } where width/height are in the
 * canvas' own drawing units (the background already applied its resolution
 * scale to the context, so a scene never thinks about devicePixelRatio).
 * `render(time, dt)` redraws the whole frame; `time` is seconds since start and
 * may stand still (reduced motion), in which case the scene must still paint a
 * complete, pleasant still frame.
 *
 * Everything here is dependency-free on purpose: scenes are also loaded by the
 * standalone preview page, outside the renderer bundle.
 */

/** Deterministic PRNG, so a scene looks the same at every launch. */
function seeded(seed = 1) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex) {
  if (typeof hex !== 'string') return { r: 0, g: 0, b: 0 };
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** `rgba(...)` string from a hex colour and an alpha. */
function rgba(hex, alpha = 1) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Linear mix of two hex colours, `t` in [0, 1], returned as an rgb() string. */
function mix(a, b, t) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(x.r + (y.r - x.r) * k)}, ${Math.round(x.g + (y.g - x.g) * k)}, ${Math.round(x.b + (y.b - x.b) * k)})`;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function smooth(t) { return t * t * (3 - 2 * t); }

/**
 * 1D value noise in [-1, 1], smooth and cheap. Good enough for ridgelines,
 * wave crests and flickers; no allocation per call.
 */
function makeNoise(rand) {
  const N = 256;
  const table = new Float32Array(N);
  for (let i = 0; i < N; i++) table[i] = rand() * 2 - 1;
  return function noise(x) {
    const i = Math.floor(x);
    const f = x - i;
    const a = table[i & (N - 1)];
    const b = table[(i + 1) & (N - 1)];
    return a + (b - a) * smooth(f);
  };
}

/** Fractal (octave-summed) 1D noise, still in roughly [-1, 1]. */
function makeFbm(rand, octaves = 4) {
  const n = makeNoise(rand);
  return function fbm(x) {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += n(x * freq + o * 17.3) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  };
}

/**
 * An offscreen canvas for layers that only change on resize (mountains, a
 * skyline, a starfield). Painting them once and blitting each frame is what
 * keeps a scene under a couple of milliseconds.
 */
function layer(width, height) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  const canvas = typeof globalThis.OffscreenCanvas !== 'undefined'
    ? new globalThis.OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  return { canvas, ctx: canvas.getContext('2d') };
}

/** Vertical gradient fill over the whole frame. stops: [[offset, colour], ...] */
function vGradient(ctx, x, y, w, h, stops) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

/** Soft radial glow (sun, moon halo, lamp, bokeh). */
function glow(ctx, x, y, radius, color, alpha = 1) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

/** Read a param with its declared default, so themes may omit any of them. */
function paramReader(schema, values) {
  const defaults = {};
  for (const p of schema) defaults[p.key] = p.default;
  const merged = { ...defaults, ...(values || {}) };
  return (key) => merged[key];
}

module.exports = {
  seeded,
  hexToRgb,
  rgba,
  mix,
  clamp,
  lerp,
  smooth,
  makeNoise,
  makeFbm,
  layer,
  vGradient,
  glow,
  paramReader,
};
