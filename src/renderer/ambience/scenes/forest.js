/**
 * Forest - a misty pine forest under the moon: ridges of pines fading into
 * fog by distance, slow drifting fog bands, soft moon rays and wandering
 * fireflies. Day / dusk / night variants come from colours alone.
 */
const kit = require('./_kit');

const params = [
  { key: 'skyTop', type: 'color', default: '#1b1f3f' },
  { key: 'skyBottom', type: 'color', default: '#77708f' },
  { key: 'moonColor', type: 'color', default: '#f2e9d0' },
  { key: 'treeFar', type: 'color', default: '#4f5679' },
  { key: 'treeNear', type: 'color', default: '#0f1325' },
  { key: 'fogColor', type: 'color', default: '#a39fba' },
  { key: 'fireflyColor', type: 'color', default: '#ffd27a' },
  { key: 'fireflies', type: 'range', min: 0, max: 1, step: 0.05, default: 0.5 },
  { key: 'fog', type: 'range', min: 0, max: 1, step: 0.05, default: 0.6 },
  { key: 'stars', type: 'range', min: 0, max: 1, step: 0.05, default: 0.6 },
  { key: 'drift', type: 'range', min: 0, max: 2, step: 0.05, default: 1 },
  { key: 'moon', type: 'toggle', default: true },
  { key: 'rays', type: 'toggle', default: true },
];

const LAYERS = 5; // ridges of pines, far -> near
const MARGIN = 40; // extra width each side so layers can drift (parallax)

/** One pine silhouette as a sub-path: stacked drooping tiers on a short trunk. */
function pine(c, x, base, h, halfW, rand) {
  const tiers = 5 + Math.floor(rand() * 3);
  const top = base - h;
  const crownBase = base - h * 0.07;
  const tierH = (crownBase - top) / tiers;
  const ys = [];
  const ws = [];
  for (let i = 1; i <= tiers; i++) {
    const k = i / tiers;
    ys.push(top + (crownBase - top) * k);
    ws.push(halfW * (0.18 + 0.82 * Math.pow(k, 0.9)) * (0.85 + rand() * 0.3));
  }
  const trunk = Math.max(0.6, halfW * 0.08);
  c.moveTo(x, top);
  for (let i = 0; i < tiers; i++) {
    c.lineTo(x + ws[i], ys[i] + tierH * 0.12);
    if (i < tiers - 1) c.lineTo(x + ws[i] * 0.38, ys[i] - tierH * 0.08);
  }
  c.lineTo(x + trunk, crownBase);
  c.lineTo(x + trunk, base + 4);
  c.lineTo(x - trunk, base + 4);
  c.lineTo(x - trunk, crownBase);
  for (let i = tiers - 1; i >= 0; i--) {
    if (i < tiers - 1) c.lineTo(x - ws[i] * 0.38, ys[i] - tierH * 0.08);
    c.lineTo(x - ws[i], ys[i] + tierH * 0.12);
  }
  c.closePath();
}

function create(ctx, env) {
  const p = kit.paramReader(params, env.params);
  const ridgeFbm = kit.makeFbm(kit.seeded(31), 4);
  const wander = kit.makeNoise(kit.seeded(57));
  let W = env.width;
  let H = env.height;
  let sky = null;
  let rays = null;
  let fogTex = null;
  let sprite = null;
  let layers = [];
  let flies = [];

  function ridgeY(k) { return H * (0.6 + 0.38 * Math.pow(k, 1.25)); }

  function buildLayer(i) {
    const rand = kit.seeded(101 + i * 13);
    const k = i / (LAYERS - 1);
    const lw = W + MARGIN * 2;
    const L = kit.layer(lw, H);
    const c = L.ctx;
    const base = ridgeY(k);
    const amp = H * (0.025 + 0.03 * k);
    const ground = (x) => base + ridgeFbm(x / (300 + 200 * k) + i * 7.7) * amp;

    c.fillStyle = kit.mix(p('treeFar'), p('treeNear'), Math.pow(k, 0.8));
    c.beginPath();
    c.moveTo(0, H);
    for (let x = 0; x <= lw; x += 6) c.lineTo(x, ground(x));
    c.lineTo(lw, H);
    c.closePath();

    // Trees: denser and smaller far away, taller towards the edges near by,
    // so the centre of the frame stays open and calm.
    const baseH = H * (0.07 + 0.3 * Math.pow(k, 1.4));
    let x = -rand() * 20;
    while (x < lw + 20) {
      const edge = Math.abs((x - MARGIN) / W - 0.5) * 2;
      const shape = kit.lerp(0.85 + 0.3 * edge, 0.35 + 1.1 * Math.pow(edge, 1.6), k);
      const h = baseH * shape * (0.7 + rand() * 0.55);
      const halfW = h * (0.17 + rand() * 0.05);
      if (h > 4) pine(c, x, ground(x) + 2, h, halfW, rand);
      x += halfW * (0.75 + rand() * 0.9) * (1 + 2.2 * Math.pow(k, 1.5) * Math.max(0, 0.75 - edge));
    }
    c.fill();

    // Mist pooling at the foot of the ridge: atmospheric perspective.
    // Every ridge melts into the same fog density at its foot, so one layer's
    // ground never shows as a seam behind the next.
    const fogA = p('fog') * 0.92;
    if (fogA > 0) {
      c.globalCompositeOperation = 'source-atop';
      const top = base - amp - baseH * (1.25 - 0.55 * k);
      const g = c.createLinearGradient(0, top, 0, H);
      const foot = kit.clamp((base + amp - top) / (H - top), 0.05, 0.97);
      g.addColorStop(0, kit.rgba(p('fogColor'), 0));
      g.addColorStop(foot * 0.6, kit.rgba(p('fogColor'), fogA * 0.35));
      g.addColorStop(foot, kit.rgba(p('fogColor'), fogA));
      g.addColorStop(1, kit.rgba(p('fogColor'), i === LAYERS - 1 ? fogA * 0.45 : fogA));
      c.fillStyle = g;
      c.fillRect(0, top, lw, H - top);
      c.globalCompositeOperation = 'source-over';
    }
    return { canvas: L.canvas, k };
  }

  /** Very near pines at the left and right edges, framing the scene. */
  function buildFrame() {
    const rand = kit.seeded(977);
    const lw = W + MARGIN * 2;
    const L = kit.layer(lw, H);
    const c = L.ctx;
    c.fillStyle = p('treeNear');
    c.beginPath();
    const spots = [
      [-0.02, 1.05], [0.05, 0.82], [0.11, 0.6],
      [0.9, 0.68], [0.96, 0.95], [1.03, 1.1],
    ];
    for (const [fx, fh] of spots) {
      const h = H * fh * (0.95 + rand() * 0.1);
      pine(c, MARGIN + fx * W, H + 6, h, h * 0.16, rand);
    }
    c.fill();
    // Faint moonlit rim so the near trunks read against the dark.
    c.globalCompositeOperation = 'source-atop';
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, kit.rgba(p('skyBottom'), 0.18));
    g.addColorStop(0.6, kit.rgba(p('fogColor'), 0.08 * p('fog')));
    g.addColorStop(1, kit.rgba(p('fogColor'), 0.22 * p('fog')));
    c.fillStyle = g;
    c.fillRect(0, 0, lw, H);
    c.globalCompositeOperation = 'source-over';
    return { canvas: L.canvas, k: 1.3 };
  }

  function buildFogTexture() {
    const rand = kit.seeded(211);
    const bh = Math.max(40, Math.round(H * 0.2));
    const T = kit.layer(W, bh);
    const c = T.ctx;
    const n = Math.round(W / 40);
    for (let i = 0; i < n; i++) {
      const x = rand() * W;
      const y = bh * (0.5 + (rand() - 0.5) * 0.3);
      const rx = 90 + rand() * 220;
      const ry = Math.min(bh * 0.48, rx * (0.18 + rand() * 0.12));
      const a = 0.1 + rand() * 0.12;
      for (const ox of [-W, 0, W]) {
        if (x + ox + rx < 0 || x + ox - rx > W) continue;
        c.save();
        c.translate(x + ox, y);
        c.scale(1, ry / rx);
        const g = c.createRadialGradient(0, 0, 0, 0, 0, rx);
        g.addColorStop(0, kit.rgba(p('fogColor'), a));
        g.addColorStop(1, kit.rgba(p('fogColor'), 0));
        c.fillStyle = g;
        c.fillRect(-rx, -rx, rx * 2, rx * 2);
        c.restore();
      }
    }
    return { canvas: T.canvas, h: bh };
  }

  function moonPos() {
    return { x: W * 0.79, y: H * 0.17, r: Math.max(12, Math.min(W, H) * 0.038) };
  }

  function build() {
    const rand = kit.seeded(7);
    sky = kit.layer(W, H);
    const s = sky.ctx;
    kit.vGradient(s, 0, 0, W, H, [
      [0, p('skyTop')],
      [0.62, p('skyBottom')],
      [1, kit.mix(p('skyBottom'), p('fogColor'), 0.5)],
    ]);
    // A sparse handful of stars, high up.
    const count = Math.round(W * H / 5400 * p('stars'));
    for (let i = 0; i < count; i++) {
      const y = Math.pow(rand(), 1.8) * H * 0.5;
      const a = (0.2 + rand() * 0.55) * (1 - y / (H * 0.55));
      s.fillStyle = `rgba(255, 255, 255, ${a.toFixed(3)})`;
      const r = rand() < 0.07 ? 1.6 : 0.6 + rand() * 0.7;
      s.fillRect(rand() * W, y, r, r);
    }
    const m = moonPos();
    if (p('moon')) {
      kit.glow(s, m.x, m.y, m.r * 11, p('moonColor'), 0.16);
      kit.glow(s, m.x, m.y, m.r * 3.2, p('moonColor'), 0.3);
      s.fillStyle = p('moonColor');
      s.beginPath();
      s.arc(m.x, m.y, m.r, 0, Math.PI * 2);
      s.fill();
      // Faint maria so the disc is not a flat sticker.
      s.fillStyle = kit.rgba(p('skyBottom'), 0.07);
      s.beginPath();
      s.arc(m.x - m.r * 0.3, m.y - m.r * 0.2, m.r * 0.32, 0, Math.PI * 2);
      s.arc(m.x + m.r * 0.25, m.y + m.r * 0.3, m.r * 0.22, 0, Math.PI * 2);
      s.fill();
    }

    rays = null;
    if (p('moon') && p('rays')) {
      rays = kit.layer(W, H);
      const c = rays.ctx;
      c.filter = `blur(${Math.round(Math.max(4, W / 200))}px)`;
      const rr = kit.seeded(5);
      const len = Math.hypot(W, H);
      for (let i = 0; i < 5; i++) {
        const ang = Math.PI * (0.56 + i * 0.055 + rr() * 0.03);
        const spread = 0.02 + rr() * 0.03;
        const g = c.createRadialGradient(m.x, m.y, m.r, m.x, m.y, len * 0.85);
        const a = 0.07 + rr() * 0.06;
        g.addColorStop(0, kit.rgba(p('moonColor'), a));
        g.addColorStop(0.5, kit.rgba(p('moonColor'), a * 0.45));
        g.addColorStop(1, kit.rgba(p('moonColor'), 0));
        c.fillStyle = g;
        c.beginPath();
        c.moveTo(m.x, m.y);
        c.lineTo(m.x + Math.cos(ang - spread) * len, m.y + Math.sin(ang - spread) * len);
        c.lineTo(m.x + Math.cos(ang + spread) * len, m.y + Math.sin(ang + spread) * len);
        c.closePath();
        c.fill();
      }
    }

    layers = [];
    for (let i = 0; i < LAYERS; i++) layers.push(buildLayer(i));
    layers.push(buildFrame());
    fogTex = buildFogTexture();

    const S = 48;
    sprite = kit.layer(S, S);
    const g = sprite.ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255, 252, 235, 1)');
    g.addColorStop(0.12, kit.rgba(p('fireflyColor'), 0.95));
    g.addColorStop(0.35, kit.rgba(p('fireflyColor'), 0.25));
    g.addColorStop(1, kit.rgba(p('fireflyColor'), 0));
    sprite.ctx.fillStyle = g;
    sprite.ctx.fillRect(0, 0, S, S);

    const n = Math.round(Math.sqrt(W * H) / 1100 * 70 * p('fireflies'));
    flies = [];
    for (let i = 0; i < n; i++) {
      const near = rand() < 0.45;
      flies.push({
        x: rand() * W,
        y: H * (near ? 0.78 + rand() * 0.2 : 0.62 + rand() * 0.2),
        size: near ? 18 + rand() * 14 : 8 + rand() * 7,
        near,
        seed: rand() * 200,
        sp: 0.6 + rand() * 0.8,
        pulse: 0.25 + rand() * 0.35,
        phase: rand() * Math.PI * 2,
      });
    }
  }
  build();

  function drawLayer(L, time) {
    const dx = Math.sin(time * 0.012 * p('drift')) * MARGIN * 0.8 * L.k;
    ctx.drawImage(L.canvas, -MARGIN + dx, 0);
  }

  function drawFogBand(y, speed, alpha, time) {
    if (alpha <= 0.002) return;
    const off = ((time * speed) % W + W) % W;
    ctx.globalAlpha = alpha;
    ctx.drawImage(fogTex.canvas, off - W, y);
    ctx.drawImage(fogTex.canvas, off, y);
    ctx.globalAlpha = 1;
  }

  function drawFlies(near, time) {
    if (!flies.length) return;
    ctx.globalCompositeOperation = 'lighter';
    for (const f of flies) {
      if (f.near !== near) continue;
      const t = time * f.sp;
      const x = f.x + wander(f.seed + t * 0.05) * 90;
      const y = f.y + wander(f.seed + 50 + t * 0.06) * 40;
      const b = 0.5 + 0.5 * Math.sin(time * f.pulse + f.phase);
      const a = 0.15 + 0.85 * b * b;
      const s = f.size * (0.8 + 0.2 * b);
      ctx.globalAlpha = a * (near ? 0.9 : 0.6);
      ctx.drawImage(sprite.canvas, x - s / 2, y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function render(time) {
    const drift = p('drift');
    const fog = p('fog');
    ctx.drawImage(sky.canvas, 0, 0);
    if (rays) {
      ctx.globalAlpha = 0.75 + 0.25 * Math.sin(time * 0.07);
      ctx.drawImage(rays.canvas, 0, 0);
      ctx.globalAlpha = 1;
    }
    for (let i = 0; i < LAYERS; i++) {
      drawLayer(layers[i], time);
      const k = i / (LAYERS - 1);
      // Ground mist lying on this ridge's foot, in front of its trunks.
      const y = ridgeY(k) - fogTex.h * (0.62 - 0.12 * k);
      drawFogBand(y, (4 + 5 * k) * drift * (i % 2 ? -1 : 1), fog * (0.95 - 0.4 * k), time + i * 40);
      if (i === 2) drawFlies(false, time);
    }
    drawFlies(true, time);
    drawLayer(layers[LAYERS], time);
  }

  return {
    resize(width, height) { W = width; H = height; build(); },
    render,
    destroy() { sky = null; rays = null; fogTex = null; sprite = null; layers = []; flies = []; },
  };
}

module.exports = { id: 'forest', params, create };
