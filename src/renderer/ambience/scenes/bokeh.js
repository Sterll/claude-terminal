/**
 * Bokeh - dreamy out-of-focus city lights: soft discs at three depths (tiny
 * hazy specks far away, hexagonal aperture shapes in the middle, huge faint
 * rings up close) floating slowly upward and breathing over a soft gradient.
 *
 * Every light is a pre-rendered sprite blitted with drawImage, so the frame
 * cost is a few dozen image draws and nothing else.
 */
const kit = require('./_kit');

const params = [
  { key: 'bgTop', type: 'color', default: '#120f24' },
  { key: 'bgBottom', type: 'color', default: '#2a1b36' },
  { key: 'light1', type: 'color', default: '#f2b880' },
  { key: 'light2', type: 'color', default: '#e58fa8' },
  { key: 'light3', type: 'color', default: '#8fb4e8' },
  { key: 'density', type: 'range', min: 0.2, max: 2, step: 0.05, default: 1 },
  { key: 'speed', type: 'range', min: 0.1, max: 2, step: 0.05, default: 0.6 },
];

const SPRITE = 128;

function hexPath(c, cx, cy, r, rot) {
  c.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = rot + i * Math.PI / 3;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.closePath();
}

/** Hexagonal aperture disc: flat body, soft edge, slightly brighter rim. */
function makeHexSprite(color) {
  const L = kit.layer(SPRITE, SPRITE);
  const c = L.ctx;
  const m = SPRITE / 2;
  const R = m * 0.78;
  const rot = Math.PI / 6;
  // Defocus: the whole aperture shape is blurred once, at build time.
  c.filter = `blur(${SPRITE * 0.03}px)`;
  c.fillStyle = kit.rgba(color, 0.62);
  hexPath(c, m, m, R, rot);
  c.fill();
  c.lineWidth = SPRITE * 0.045;
  c.strokeStyle = kit.rgba(color, 0.5);
  hexPath(c, m, m, R * 0.95, rot);
  c.stroke();
  c.filter = 'none';
  // A faint hot centre so it reads as light rather than a flat shape.
  const g = c.createRadialGradient(m, m, 0, m, m, R * 0.85);
  g.addColorStop(0, 'rgba(255, 255, 255, 0.10)');
  g.addColorStop(1, 'rgba(255, 255, 255, 0)');
  c.fillStyle = g;
  c.fillRect(0, 0, SPRITE, SPRITE);
  return L.canvas;
}

/** Round disc with a soft edge and a gentle rim (close, very defocused). */
function makeRingSprite(color) {
  const L = kit.layer(SPRITE, SPRITE);
  const c = L.ctx;
  const m = SPRITE / 2;
  const g = c.createRadialGradient(m, m, 0, m, m, m);
  g.addColorStop(0, kit.rgba(color, 0.5));
  g.addColorStop(0.72, kit.rgba(color, 0.6));
  g.addColorStop(0.86, kit.rgba(color, 0.85));
  g.addColorStop(0.94, kit.rgba(color, 0.35));
  g.addColorStop(1, kit.rgba(color, 0));
  c.fillStyle = g;
  c.fillRect(0, 0, SPRITE, SPRITE);
  return L.canvas;
}

/** Hazy speck: plain gaussian-ish blob (far lights). */
function makeSoftSprite(color) {
  const L = kit.layer(SPRITE, SPRITE);
  const c = L.ctx;
  const m = SPRITE / 2;
  const g = c.createRadialGradient(m, m, 0, m, m, m);
  g.addColorStop(0, kit.rgba(color, 1));
  g.addColorStop(0.35, kit.rgba(color, 0.75));
  g.addColorStop(0.7, kit.rgba(color, 0.2));
  g.addColorStop(1, kit.rgba(color, 0));
  c.fillStyle = g;
  c.fillRect(0, 0, SPRITE, SPRITE);
  return L.canvas;
}

// Depth bands, far to near. Sizes are fractions of the short side.
const DEPTHS = [
  { kind: 'soft', per: 1 / 30000, size: [0.014, 0.034], alpha: [0.35, 0.75], rise: 4, sway: 6 },
  { kind: 'hex', per: 1 / 48000, size: [0.04, 0.1], alpha: [0.4, 0.75], rise: 8, sway: 12 },
  { kind: 'ring', per: 1 / 150000, size: [0.12, 0.24], alpha: [0.14, 0.26], rise: 14, sway: 20 },
];

function create(ctx, env) {
  const p = kit.paramReader(params, env.params);
  const fbm = kit.makeFbm(kit.seeded(41), 3);
  let W = env.width;
  let H = env.height;
  let bg = null;
  let lights = [];

  const colors = [p('light1'), p('light2'), p('light3')];
  const sprites = {
    soft: colors.map(makeSoftSprite),
    hex: colors.map(makeHexSprite),
    ring: colors.map(makeRingSprite),
  };

  function build() {
    bg = kit.layer(W, H);
    const b = bg.ctx;
    const g = b.createLinearGradient(0, 0, W * 0.35, H);
    g.addColorStop(0, p('bgTop'));
    g.addColorStop(1, p('bgBottom'));
    b.fillStyle = g;
    b.fillRect(0, 0, W, H);
    // A faint wash of the middle light colour, low and off-centre, so the
    // background feels lit by the lights rather than flat.
    const R = Math.max(W, H) * 0.7;
    const wash = b.createRadialGradient(W * 0.62, H * 0.72, 0, W * 0.62, H * 0.72, R);
    wash.addColorStop(0, kit.rgba(p('light2'), 0.14));
    wash.addColorStop(1, kit.rgba(p('light2'), 0));
    b.fillStyle = wash;
    b.fillRect(0, 0, W, H);
    const wash2 = b.createRadialGradient(W * 0.2, H * 0.3, 0, W * 0.2, H * 0.3, R * 0.7);
    wash2.addColorStop(0, kit.rgba(p('light3'), 0.08));
    wash2.addColorStop(1, kit.rgba(p('light3'), 0));
    b.fillStyle = wash2;
    b.fillRect(0, 0, W, H);

    // Lights: rebuilt from a fixed seed so a resize keeps the same layout feel.
    const rand = kit.seeded(17);
    const short = Math.min(W, H);
    lights = [];
    const density = p('density');
    DEPTHS.forEach((d, depth) => {
      const count = Math.max(2, Math.round(W * H * d.per * density));
      for (let i = 0; i < count; i++) {
        // Lights cluster in loose groups with darker gaps between them.
        let x = rand();
        for (let tries = 0; tries < 6; tries++) {
          if (rand() < 0.3 + 0.7 * kit.smooth((fbm(x * 3.1 + 9) + 1) / 2)) break;
          x = rand();
        }
        // Colour drifts across the frame in broad bands, with some mixing,
        // so neighbouring lights tend to share a hue (like a real street).
        const band = kit.clamp((fbm(x * 2.2 + depth * 5) * 1.8 + 1) / 2, 0, 1) * 3 + (rand() - 0.5) * 1.2;
        const ci = rand() < 0.3 ? Math.floor(rand() * 3) : Math.max(0, Math.min(2, Math.floor(band)));
        lights.push({
          depth,
          kind: d.kind,
          sprite: sprites[d.kind][ci],
          halo: d.kind === 'hex' ? sprites.soft[ci] : null,
          x,
          y: rand(),
          size: short * kit.lerp(d.size[0], d.size[1], rand()),
          alpha: kit.lerp(d.alpha[0], d.alpha[1], rand()),
          rise: d.rise * (0.6 + rand() * 0.8),
          sway: d.sway * (0.5 + rand()),
          swayF: 0.03 + rand() * 0.05,
          breathF: 0.08 + rand() * 0.12,
          phase: rand() * Math.PI * 2,
        });
      }
    });
  }
  build();

  // Lights add light on a dark background; on a light (pastel) one they are
  // simply laid over it, or they would wash out to white.
  const lum = (hex) => { const c = kit.hexToRgb(hex); return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255; };
  const additive = (lum(p('bgTop')) + lum(p('bgBottom'))) / 2 < 0.5;

  function render(time) {
    ctx.drawImage(bg.canvas, 0, 0);
    if (additive) ctx.globalCompositeOperation = 'screen';
    const sp = p('speed');
    const t = time * sp;
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i];
      const breath = Math.sin(t * l.breathF * Math.PI + l.phase);
      const s = l.size * (1 + 0.06 * breath);
      const span = H + s * 2;
      let y = (l.y * span - t * l.rise) % span;
      if (y < 0) y += span;
      y -= s;
      const x = l.x * W + Math.sin(t * l.swayF * Math.PI * 2 + l.phase) * l.sway;
      ctx.globalAlpha = l.alpha * (0.72 + 0.28 * breath);
      ctx.drawImage(l.sprite, x - s / 2, y - s / 2, s, s);
      if (l.halo) {
        const hs = s * 2.6;
        ctx.globalAlpha *= 0.22;
        ctx.drawImage(l.halo, x - hs / 2, y - hs / 2, hs, hs);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  return {
    resize(width, height) { W = width; H = height; build(); },
    render,
    destroy() { bg = null; lights = []; },
  };
}

module.exports = { id: 'bokeh', params, create };
