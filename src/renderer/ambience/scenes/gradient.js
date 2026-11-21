/**
 * Gradient - a minimal "mesh gradient": a handful of large, very soft colour
 * blobs drifting on slow Lissajous paths over a base colour, under a faint
 * static film grain. The calmest scene, meant for minimal themes.
 *
 * The blobs are composited each frame into a small offscreen field (a fraction
 * of the window) and stretched to full size, which is both cheap and gives the
 * smoothest possible falloff.
 */
const kit = require('./_kit');

const params = [
  { key: 'baseColor', type: 'color', default: '#141328' },
  { key: 'blob1', type: 'color', default: '#4b3f8f' },
  { key: 'blob2', type: 'color', default: '#a0587a' },
  { key: 'blob3', type: 'color', default: '#2f6c86' },
  { key: 'blob4', type: 'color', default: '#c98a5e' },
  { key: 'speed', type: 'range', min: 0.1, max: 2, step: 0.05, default: 0.6 },
  { key: 'grain', type: 'range', min: 0, max: 1, step: 0.05, default: 0.4 },
];

// Field resolution relative to the window; the blobs are so soft that a
// quarter-size field upscaled is indistinguishable from full size.
const FIELD_SCALE = 0.25;
const SPRITE = 128;
const GRAIN_TILE = 192;

function makeSprite(color) {
  const L = kit.layer(SPRITE, SPRITE);
  const c = L.ctx;
  const r = SPRITE / 2;
  const g = c.createRadialGradient(r, r, 0, r, r, r);
  // Gaussian-ish falloff: no visible edge, no bright core.
  const stops = [[0, 1], [0.2, 0.9], [0.4, 0.66], [0.6, 0.36], [0.8, 0.12], [1, 0]];
  for (const [o, a] of stops) g.addColorStop(o, kit.rgba(color, a));
  c.fillStyle = g;
  c.fillRect(0, 0, SPRITE, SPRITE);
  return L.canvas;
}

function makeGrain(rand) {
  const L = kit.layer(GRAIN_TILE, GRAIN_TILE);
  const img = L.ctx.createImageData(GRAIN_TILE, GRAIN_TILE);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = rand();
    const light = v > 0.5;
    const k = light ? 255 : 0;
    d[i] = k; d[i + 1] = k; d[i + 2] = k;
    d[i + 3] = Math.round(Math.abs(v - 0.5) * 2 * 255);
  }
  L.ctx.putImageData(img, 0, 0);
  return L.canvas;
}

function create(ctx, env) {
  const p = kit.paramReader(params, env.params);
  const rand = kit.seeded(5);
  let W = env.width;
  let H = env.height;
  let field = null;
  let grainPattern = null;

  const colors = [p('blob1'), p('blob2'), p('blob3'), p('blob4'), p('blob2')];
  const sprites = colors.map(makeSprite);
  const grainTile = makeGrain(kit.seeded(31));

  // Each blob: a centre, a Lissajous amplitude/frequency pair and a size.
  // Frequencies are tiny (periods of one to three minutes at speed 1).
  const blobs = [
    { cx: 0.22, cy: 0.28, ax: 0.20, ay: 0.16, fx: 0.041, fy: 0.057, size: 0.9, alpha: 0.95 },
    { cx: 0.78, cy: 0.30, ax: 0.18, ay: 0.20, fx: 0.035, fy: 0.047, size: 0.85, alpha: 0.9 },
    { cx: 0.30, cy: 0.78, ax: 0.22, ay: 0.15, fx: 0.052, fy: 0.038, size: 0.88, alpha: 0.9 },
    { cx: 0.74, cy: 0.76, ax: 0.17, ay: 0.18, fx: 0.044, fy: 0.061, size: 0.8, alpha: 0.85 },
    { cx: 0.50, cy: 0.50, ax: 0.26, ay: 0.12, fx: 0.029, fy: 0.050, size: 0.6, alpha: 0.4 },
  ].map((b) => ({ ...b, px: rand() * Math.PI * 2, py: rand() * Math.PI * 2 }));

  function build() {
    field = kit.layer(Math.max(8, W * FIELD_SCALE), Math.max(8, H * FIELD_SCALE));
    grainPattern = ctx.createPattern(grainTile, 'repeat');
  }
  build();

  function render(time) {
    const f = field.ctx;
    const fw = field.canvas.width;
    const fh = field.canvas.height;
    const t = time * p('speed');
    const span = Math.max(fw, fh);

    f.globalAlpha = 1;
    f.fillStyle = p('baseColor');
    f.fillRect(0, 0, fw, fh);
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      const x = (b.cx + b.ax * Math.sin(t * b.fx * Math.PI * 2 + b.px)) * fw;
      const y = (b.cy + b.ay * Math.sin(t * b.fy * Math.PI * 2 + b.py)) * fh;
      // A slow breathing of size keeps the mesh from feeling mechanical.
      const d = span * b.size * (1 + 0.08 * Math.sin(t * 0.07 + b.px));
      f.globalAlpha = b.alpha;
      f.drawImage(sprites[i], x - d / 2, y - d / 2, d, d);
    }
    f.globalAlpha = 1;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(field.canvas, 0, 0, fw, fh, 0, 0, W, H);

    const grain = p('grain');
    if (grain > 0 && grainPattern) {
      ctx.globalAlpha = grain * 0.09;
      ctx.fillStyle = grainPattern;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  return {
    resize(width, height) { W = width; H = height; build(); },
    render,
    destroy() { field = null; grainPattern = null; },
  };
}

module.exports = { id: 'gradient', params, create };
