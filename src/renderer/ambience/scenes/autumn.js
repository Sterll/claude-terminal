/**
 * Autumn - rolling hills at golden hour: a warm sky, a low sun, hazy ridges of
 * round-crowned trees rim-lit by the light, drifting cloud streaks, leaves
 * tumbling down in the breeze and a few far birds.
 */
const kit = require('./_kit');

const params = [
  { key: 'skyTop', type: 'color', default: '#463d6b' },
  { key: 'skyMid', type: 'color', default: '#c97a72' },
  { key: 'skyBottom', type: 'color', default: '#f2b978' },
  { key: 'sunColor', type: 'color', default: '#ffe2a8' },
  { key: 'hillFar', type: 'color', default: '#a8707a' },
  { key: 'hillNear', type: 'color', default: '#2e1c2c' },
  { key: 'leafA', type: 'color', default: '#e8793a' },
  { key: 'leafB', type: 'color', default: '#c5462f' },
  { key: 'leafC', type: 'color', default: '#f0b545' },
  { key: 'birdColor', type: 'color', default: '#3b2a42' },
  { key: 'leaves', type: 'range', min: 0, max: 1, step: 0.05, default: 0.5 },
  { key: 'wind', type: 'range', min: 0.2, max: 2, step: 0.05, default: 1 },
  { key: 'haze', type: 'range', min: 0, max: 1, step: 0.05, default: 0.6 },
  { key: 'birds', type: 'toggle', default: true },
];

const HILLS = 4;

/** Like kit.mix but returns hex, so the result can be mixed or alpha'd again. */
function mixHex(a, b, t) {
  const x = kit.hexToRgb(a);
  const y = kit.hexToRgb(b);
  const k = kit.clamp(t, 0, 1);
  const ch = (u, v) => Math.round(u + (v - u) * k).toString(16).padStart(2, '0');
  return `#${ch(x.r, y.r)}${ch(x.g, y.g)}${ch(x.b, y.b)}`;
}

/** A round-crowned deciduous tree, drawn rim-lit from the sun's side. */
function tree(c, x, base, h, color, canopy, rim, sunSide, rand) {
  const r = h * 0.34;
  const cy = base - h + r;
  const trunkW = Math.max(1, h * 0.05);
  c.fillStyle = color;
  c.fillRect(x - trunkW / 2, cy, trunkW, base - cy + 3);
  const blobs = 3 + Math.floor(rand() * 3);
  const pts = [];
  for (let i = 0; i < blobs; i++) {
    const a = (i / blobs) * Math.PI * 2 + rand();
    const d = r * (0.35 + rand() * 0.3);
    pts.push([x + Math.cos(a) * d, cy + Math.sin(a) * d * 0.75, r * (0.55 + rand() * 0.3)]);
  }
  pts.push([x, cy, r * 0.8]);
  // Lit crescent on the sun's side, then the body slightly offset away.
  c.fillStyle = rim;
  c.beginPath();
  for (const [px, py, pr] of pts) { c.moveTo(px + pr, py); c.arc(px, py, pr, 0, Math.PI * 2); }
  c.fill();
  c.fillStyle = canopy;
  c.beginPath();
  const off = Math.min(r * 0.1, 4);
  for (const [px, py, pr] of pts) {
    c.moveTo(px - sunSide * off + pr, py + off * 0.6);
    c.arc(px - sunSide * off, py + off * 0.6, pr, 0, Math.PI * 2);
  }
  c.fill();
}

function create(ctx, env) {
  const p = kit.paramReader(params, env.params);
  const hillFbm = kit.makeFbm(kit.seeded(41), 3);
  const grove = kit.makeNoise(kit.seeded(43));
  let W = env.width;
  let H = env.height;
  let sky = null;
  let clouds = null;
  let hills = [];
  let leaves = [];
  let birds = [];

  function sunPos() {
    return { x: W * 0.28, y: H * 0.6, r: Math.max(16, Math.min(W, H) * 0.06) };
  }
  function ridgeY(k) { return H * (0.63 + 0.29 * Math.pow(k, 1.2)); }

  function buildHill(i) {
    const rand = kit.seeded(301 + i * 19);
    const k = i / (HILLS - 1);
    const L = kit.layer(W, H);
    const c = L.ctx;
    const sun = sunPos();
    const base = ridgeY(k);
    const amp = H * (0.035 + 0.045 * k);
    const ground = (x) => base + hillFbm(x / (520 - 120 * k) + i * 5.3) * amp - Math.sin((x / W) * Math.PI) * amp * 0.5 * k;
    const color = mixHex(p('hillFar'), p('hillNear'), Math.pow(k, 0.75));
    const rim = mixHex(mixHex(color, p('skyMid'), 0.3), p('sunColor'), 0.45 - 0.2 * k);
    const canopy = mixHex(color, mixHex(p('leafA'), p('leafB'), (i % 2) * 0.6), 0.2 - 0.06 * k);

    c.fillStyle = color;
    c.beginPath();
    c.moveTo(0, H);
    for (let x = 0; x <= W; x += 6) c.lineTo(x, ground(x));
    c.lineTo(W, H);
    c.closePath();
    c.fill();

    // Golden rim along the crest.
    c.strokeStyle = kit.rgba(p('sunColor'), 0.28 - 0.14 * k);
    c.lineWidth = 1.5;
    c.beginPath();
    for (let x = 0; x <= W; x += 6) { if (x === 0) c.moveTo(x, ground(x)); else c.lineTo(x, ground(x)); }
    c.stroke();

    // Groves: clustered by noise, bigger and edge-weighted near by.
    const th = H * (0.035 + 0.13 * Math.pow(k, 1.5));
    let x = rand() * 10;
    while (x < W + 10) {
      const edge = Math.abs(x / W - 0.5) * 2;
      const g = grove(x / (90 + 140 * k) + i * 11);
      const want = g > 0.05 - 0.25 * (1 - k) && (k < 0.6 || edge > 0.45 - 0.1 * g);
      const h = th * (0.7 + rand() * 0.6) * (k > 0.5 ? 0.6 + 0.7 * edge : 1);
      if (want) {
        const sunSide = x < sun.x ? 1 : -1;
        tree(c, x, ground(x) + 2, h, color, canopy, rim, sunSide, rand);
      }
      x += h * (want ? 0.35 + rand() * 0.35 : 0.5);
    }

    // Golden haze settling into the valley behind each nearer ridge.
    const hz = p('haze') * (0.75 - 0.6 * k);
    if (hz > 0) {
      c.globalCompositeOperation = 'source-atop';
      const top = base - amp - th * 1.2;
      const gr = c.createLinearGradient(0, top, 0, H);
      gr.addColorStop(0, kit.rgba(p('skyBottom'), hz * 0.15));
      gr.addColorStop(kit.clamp((base + amp - top) / (H - top), 0.05, 0.95), kit.rgba(p('skyBottom'), hz));
      gr.addColorStop(1, kit.rgba(p('skyBottom'), hz));
      c.fillStyle = gr;
      c.fillRect(0, top, W, H - top);
      c.globalCompositeOperation = 'source-over';
    }
    return L.canvas;
  }

  /** Big framing trees at the bottom corners, partly out of frame. */
  function buildFront() {
    const rand = kit.seeded(909);
    const L = kit.layer(W, H);
    const c = L.ctx;
    const col = mixHex(p('hillNear'), '#000000', 0.25);
    const rim = mixHex(mixHex(col, p('skyMid'), 0.4), p('sunColor'), 0.3);
    c.fillStyle = col;
    c.beginPath();
    c.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) {
      const edge = Math.abs(x / W - 0.5) * 2;
      c.lineTo(x, H - H * (0.015 + 0.05 * Math.pow(edge, 2.5)) + hillFbm(x / 200 + 40) * H * 0.012);
    }
    c.lineTo(W, H);
    c.closePath();
    c.fill();
    const canopy = mixHex(col, p('leafB'), 0.12);
    tree(c, W * 0.04, H + 4, H * 0.62, col, canopy, rim, 1, rand);
    tree(c, W * 0.13, H + 4, H * 0.36, col, canopy, rim, 1, rand);
    tree(c, W * 0.95, H + 4, H * 0.5, col, canopy, rim, -1, rand);
    return L.canvas;
  }

  function buildClouds() {
    const rand = kit.seeded(77);
    const ch = Math.round(H * 0.45);
    const L = kit.layer(W, ch);
    const c = L.ctx;
    c.filter = `blur(${Math.round(Math.max(3, H / 140))}px)`;
    const lit = mixHex(p('skyMid'), p('sunColor'), 0.55);
    const n = Math.max(6, Math.round(W / 110));
    for (let i = 0; i < n; i++) {
      const y = ch * (0.15 + rand() * 0.8);
      const x = rand() * W;
      const len = 120 + rand() * 260;
      const th = 4 + rand() * 9 * (y / ch + 0.3);
      const a = 0.18 + rand() * 0.22;
      for (const ox of [-W, 0, W]) {
        c.fillStyle = kit.rgba(p('skyMid'), a * 0.8);
        c.beginPath();
        c.ellipse(x + ox, y, len / 2, th, 0, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = kit.rgba(lit, a);
        c.beginPath();
        c.ellipse(x + ox, y + th * 0.4, len * 0.42, th * 0.5, 0, 0, Math.PI * 2);
        c.fill();
      }
    }
    return { canvas: L.canvas, y: H * 0.12 };
  }

  function build() {
    const rand = kit.seeded(5);
    sky = kit.layer(W, H);
    const s = sky.ctx;
    kit.vGradient(s, 0, 0, W, H, [
      [0, p('skyTop')],
      [0.38, kit.mix(p('skyTop'), p('skyMid'), 0.65)],
      [0.55, p('skyMid')],
      [0.72, p('skyBottom')],
      [1, p('skyBottom')],
    ]);
    const sun = sunPos();
    kit.glow(s, sun.x, sun.y, Math.max(W, H) * 0.55, p('sunColor'), 0.28);
    kit.glow(s, sun.x, sun.y, sun.r * 4, p('sunColor'), 0.45);
    kit.glow(s, sun.x, sun.y, sun.r * 1.6, p('sunColor'), 0.7);
    s.fillStyle = p('sunColor');
    s.beginPath();
    s.arc(sun.x, sun.y, sun.r, 0, Math.PI * 2);
    s.fill();

    clouds = buildClouds();
    hills = [];
    for (let i = 0; i < HILLS; i++) hills.push(buildHill(i));
    hills.push(buildFront());

    const count = Math.round(Math.sqrt(W * H) / 1100 * 80 * p('leaves'));
    leaves = [];
    for (let i = 0; i < count; i++) {
      const near = rand() < 0.35;
      leaves.push({
        x: rand() * (W + 80),
        y: rand() * (H + 80),
        size: near ? 8 + rand() * 5 : 4 + rand() * 2.5,
        vy: (near ? 16 : 9) + rand() * 8,
        vx: 5 + rand() * 7,
        amp: 18 + rand() * 40,
        freq: 0.25 + rand() * 0.35,
        phase: rand() * Math.PI * 2,
        rot: rand() * Math.PI * 2,
        spin: (rand() - 0.5) * 1.2,
        flip: 0.4 + rand() * 0.9,
        color: Math.floor(rand() * 3),
        alpha: near ? 0.95 : 0.6,
      });
    }

    birds = [];
    if (p('birds')) {
      for (let i = 0; i < 5; i++) {
        birds.push({
          dx: i * 26 + rand() * 10,
          dy: Math.abs(i - 1.5) * 9 + rand() * 6,
          s: 4 + rand() * 2,
          phase: rand() * Math.PI * 2,
        });
      }
    }
  }
  build();

  const leafColors = () => [p('leafA'), p('leafB'), p('leafC')];

  function drawLeaves(time) {
    const wind = p('wind');
    const cols = leafColors();
    const spanX = W + 80;
    const spanY = H + 80;
    for (let c = 0; c < 3; c++) {
      for (const near of [false, true]) {
        ctx.fillStyle = kit.rgba(cols[c], near ? 0.95 : 0.6);
        ctx.beginPath();
        for (const l of leaves) {
          if (l.color !== c || (l.alpha > 0.9) !== near) continue;
          const t = time * wind;
          const y = ((l.y + t * l.vy) % spanY + spanY) % spanY - 40;
          const sway = Math.sin(t * l.freq + l.phase);
          const x = ((l.x + t * l.vx + sway * l.amp) % spanX + spanX) % spanX - 40;
          const rot = l.rot + t * l.spin + sway * 0.6;
          const rx = l.size * (0.35 + 0.65 * Math.abs(Math.cos(t * l.flip + l.phase)));
          const ry = l.size * 0.45;
          ctx.moveTo(x + Math.cos(rot) * rx, y + Math.sin(rot) * rx);
          ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }
  }

  function drawBirds(time) {
    if (!birds.length) return;
    const span = W + 400;
    const gx = W + 150 - ((time * 9 + W * 0.45) % span);
    const gy = H * 0.24 + Math.sin(time * 0.05) * H * 0.02;
    ctx.strokeStyle = kit.rgba(p('birdColor'), 0.75);
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const b of birds) {
      const x = gx + b.dx;
      const y = gy + b.dy;
      const f = Math.sin(time * 3 + b.phase) * b.s * 0.5;
      ctx.moveTo(x - b.s, y - b.s * 0.3 - f);
      ctx.quadraticCurveTo(x - b.s * 0.4, y - b.s * 0.35, x, y);
      ctx.quadraticCurveTo(x + b.s * 0.4, y - b.s * 0.35, x + b.s, y - b.s * 0.3 - f);
    }
    ctx.stroke();
  }

  function render(time) {
    ctx.drawImage(sky.canvas, 0, 0);
    const off = ((time * 3 * p('wind')) % W + W) % W;
    ctx.drawImage(clouds.canvas, off - W, clouds.y);
    ctx.drawImage(clouds.canvas, off, clouds.y);
    drawBirds(time);
    for (let i = 0; i < hills.length; i++) ctx.drawImage(hills[i], 0, 0);
    drawLeaves(time);
  }

  return {
    resize(width, height) { W = width; H = height; build(); },
    render,
    destroy() { sky = null; clouds = null; hills = []; leaves = []; birds = []; },
  };
}

module.exports = { id: 'autumn', params, create };
