/**
 * Campfire - a fire in a forest clearing at night: stars over layered pine
 * silhouettes, a small tent, a ring of stones and logs, a gently flickering
 * flame of soft glows and tongues, warm light pooling on the ground and
 * embers drifting up and fading.
 */
const kit = require('./_kit');

const params = [
  { key: 'skyTop', type: 'color', default: '#0b1028' },
  { key: 'skyBottom', type: 'color', default: '#2c2d55' },
  { key: 'treeColor', type: 'color', default: '#0b0f1e' },
  { key: 'groundColor', type: 'color', default: '#1b1828' },
  { key: 'fireCore', type: 'color', default: '#ffe2a3' },
  { key: 'fireOuter', type: 'color', default: '#ff7b3a' },
  { key: 'stars', type: 'toggle', default: true },
  { key: 'embers', type: 'range', min: 0, max: 1, step: 0.05, default: 0.55 },
  { key: 'flicker', type: 'range', min: 0, max: 1, step: 0.05, default: 0.5 },
];

const TAU = Math.PI * 2;

function mixHex(a, b, t) {
  const x = kit.hexToRgb(a);
  const y = kit.hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  const c = (u, v) => Math.round(u + (v - u) * k).toString(16).padStart(2, '0');
  return `#${c(x.r, y.r)}${c(x.g, y.g)}${c(x.b, y.b)}`;
}

function create(ctx, env) {
  const p = kit.paramReader(params, env.params);
  const fbm = kit.makeFbm(kit.seeded(47), 4);
  const flickNoise = kit.makeNoise(kit.seeded(83));
  let W = env.width;
  let H = env.height;
  let scene = null;
  let stars = [];
  let embers = [];
  let tongues = [];
  let fire = { x: 0, y: 0, s: 1 };

  function pine(s, x, baseY, h, color, seed, ratio = 0.32) {
    // A layered pine: trunk plus drooping tiers with ragged tips.
    const rand = kit.seeded(seed);
    const w = h * (ratio + rand() * 0.06);
    s.fillStyle = color;
    s.fillRect(x - h * 0.012, baseY - h * 0.2, h * 0.024, h * 0.2 + 2);
    const tiers = 6 + Math.floor(rand() * 3);
    for (let i = 0; i < tiers; i++) {
      const t = i / tiers;
      const tierBase = baseY - h * 0.1 - t * h * 0.82;
      const tw = w * (1 - t * 0.85) * (0.9 + rand() * 0.2);
      const th = h * 0.26 * (1 - t * 0.4);
      s.beginPath();
      s.moveTo(x, tierBase - th);
      const jag = 4 + Math.floor(rand() * 3);
      // Right side, jagged towards a drooping tip.
      for (let j = 1; j <= jag; j++) {
        const f = j / jag;
        s.lineTo(x + tw * f * (j % 2 ? 1 : 0.86), tierBase - th + th * f + (j % 2 ? th * 0.06 : -th * 0.04));
      }
      s.quadraticCurveTo(x + tw * 0.5, tierBase - th * 0.1, x, tierBase - th * 0.05);
      s.quadraticCurveTo(x - tw * 0.5, tierBase - th * 0.1, x - tw, tierBase + th * 0.04);
      for (let j = jag - 1; j >= 1; j--) {
        const f = j / jag;
        s.lineTo(x - tw * f * (j % 2 ? 1 : 0.86), tierBase - th + th * f + (j % 2 ? th * 0.06 : -th * 0.04));
      }
      s.closePath();
      s.fill();
    }
    s.beginPath();
    s.moveTo(x, baseY - h * 1.0);
    s.lineTo(x - w * 0.12, baseY - h * 0.82);
    s.lineTo(x + w * 0.12, baseY - h * 0.82);
    s.closePath();
    s.fill();
  }

  function buildScene() {
    scene = kit.layer(W, H);
    const s = scene.ctx;
    const horizon = H * 0.68;
    kit.vGradient(s, 0, 0, W, horizon + 4, [[0, p('skyTop')], [0.75, p('skyBottom')], [1, mixHex(p('skyBottom'), p('fireOuter'), 0.12)]]);

    // Faint static stars; the brighter twinkling ones are drawn live.
    const rand = kit.seeded(21);
    if (p('stars')) {
      const n = Math.round(W * H / 1400);
      for (let i = 0; i < n; i++) {
        const y = Math.pow(rand(), 1.4) * horizon;
        s.fillStyle = `rgba(255, 255, 255, ${(0.06 + rand() * 0.22) * (1 - y / horizon)})`;
        s.fillRect(rand() * W, y, 1, 1);
      }
    }
    // Crescent moon, upper right, small (cut out on its own little layer).
    const mx = W * 0.8;
    const my = H * 0.16;
    const mr = Math.max(9, Math.min(W, H) * 0.026);
    kit.glow(s, mx, my, mr * 7, '#e8e6ff', 0.08);
    const moon = kit.layer(mr * 2 + 4, mr * 2 + 4);
    const m = moon.ctx;
    m.fillStyle = '#f2ecd8';
    m.beginPath();
    m.arc(mr + 2, mr + 2, mr, 0, TAU);
    m.fill();
    m.globalCompositeOperation = 'destination-out';
    m.beginPath();
    m.arc(mr + 2 + mr * 0.45, mr + 2 - mr * 0.25, mr * 0.9, 0, TAU);
    m.fill();
    s.drawImage(moon.canvas, mx - mr - 2, my - mr - 2);

    // Far forest: a solid band with a row of small pines on top, hazy.
    const far = mixHex(p('treeColor'), p('skyBottom'), 0.55);
    const farLine = (x) => horizon - H * 0.025 - (fbm(x / 300 + 2) * 0.5 + 0.5) * H * 0.05;
    s.fillStyle = far;
    s.beginPath();
    s.moveTo(0, H);
    for (let x = 0; x <= W; x += 6) s.lineTo(x, farLine(x));
    s.lineTo(W, H);
    s.closePath();
    s.fill();
    for (let x = -10; x < W + 10; x += 7 + rand() * 12) {
      pine(s, x, farLine(x) + H * 0.02, H * (0.05 + rand() * 0.06), far, 1000 + Math.floor(x));
    }
    kit.vGradient(s, 0, horizon - H * 0.14, W, H * 0.16, [[0, kit.rgba(p('skyBottom'), 0)], [1, kit.rgba(p('skyBottom'), 0.3)]]);

    // Mid pines, clustered towards the sides; the centre stays open.
    const mid = mixHex(p('treeColor'), p('skyBottom'), 0.28);
    for (let i = 0; i < 26; i++) {
      const side = i % 2 ? 1 : -1;
      const off = Math.pow(rand(), 1.4) * 0.3;
      const x = side < 0 ? W * off : W * (1 - off);
      const h = H * (0.18 + rand() * 0.16) * (1 - off * 0.9);
      pine(s, x, horizon + H * 0.02 + rand() * H * 0.02, h, mid, 2000 + i);
    }

    // Ground of the clearing.
    kit.vGradient(s, 0, horizon, W, H - horizon, [[0, mixHex(p('groundColor'), p('skyBottom'), 0.25)], [1, p('groundColor')]]);
    s.fillStyle = mixHex(p('groundColor'), p('skyBottom'), 0.25);
    s.beginPath();
    s.moveTo(0, horizon + 6);
    for (let x = 0; x <= W; x += 8) s.lineTo(x, horizon + fbm(x / 80 + 7) * 4);
    s.lineTo(W, horizon + 6);
    s.closePath();
    s.fill();
    // Shade along the forest edge so the clearing sits under the trees.
    kit.vGradient(s, 0, horizon - 2, W, H * 0.07, [[0, kit.rgba(p('treeColor'), 0.55)], [1, kit.rgba(p('treeColor'), 0)]]);
    // Grass tufts scattered on the ground.
    s.strokeStyle = kit.rgba(mixHex(p('groundColor'), p('treeColor'), 0.5), 0.9);
    s.lineWidth = 1;
    for (let i = 0; i < Math.round(W / 6); i++) {
      const x = rand() * W;
      const y = horizon + 6 + Math.pow(rand(), 0.8) * (H - horizon);
      const g = 3 + (y - horizon) / (H - horizon) * 8;
      s.beginPath();
      for (let k = -1; k <= 1; k++) {
        s.moveTo(x + k * 1.5, y);
        s.lineTo(x + k * 3 + rand() * 2 - 1, y - g * (0.6 + rand() * 0.5));
      }
      s.stroke();
    }

    // Near pines framing the edges, darkest, running off the top.
    const near = p('treeColor');
    pine(s, -W * 0.01, H * 1.02, H * 1.08, near, 3001, 0.24);
    pine(s, W * 0.055, H * 0.97, H * 0.62, near, 3002, 0.26);
    pine(s, W * 1.0, H * 1.02, H * 1.12, near, 3003, 0.24);
    pine(s, W * 0.935, H * 0.98, H * 0.72, near, 3004, 0.26);
    pine(s, W * 0.86, H * 0.9, H * 0.42, mixHex(near, p('skyBottom'), 0.12), 3005, 0.3);

    // Tent near the left edge, facing the fire.
    const fx = fire.x;
    const fy = fire.y;
    const S = fire.s;
    const tx = Math.max(W * 0.12, fx - S * 2.2);
    const ty = fy - S * 0.35;
    const tw = S * 1.5;
    const th = S * 1.15;
    s.fillStyle = mixHex(mixHex(p('groundColor'), p('skyBottom'), 0.3), p('fireOuter'), 0.04);
    s.beginPath();
    s.moveTo(tx - tw, ty);
    s.lineTo(tx - tw * 0.1, ty - th);
    s.lineTo(tx + tw * 0.75, ty);
    s.closePath();
    s.fill();
    s.fillStyle = mixHex(mixHex(p('groundColor'), p('skyBottom'), 0.3), p('fireOuter'), 0.14);
    s.beginPath();
    s.moveTo(tx - tw * 0.1, ty - th);
    s.lineTo(tx + tw * 0.75, ty);
    s.lineTo(tx + tw * 1.05, ty - th * 0.05);
    s.lineTo(tx + tw * 0.2, ty - th * 1.02);
    s.closePath();
    s.fill();
    s.fillStyle = mixHex(p('groundColor'), '#000000', 0.4);
    s.beginPath();
    s.moveTo(tx + tw * 0.1, ty);
    s.lineTo(tx - tw * 0.1, ty - th * 0.55);
    s.lineTo(tx - tw * 0.35, ty);
    s.closePath();
    s.fill();

    // Stones and logs around the fire.
    const stone = mixHex(p('groundColor'), '#6b6680', 0.35);
    for (let i = 0; i < 11; i++) {
      const a = Math.PI * 0.05 + (i / 10) * Math.PI * 0.9;
      const sx = fx + Math.cos(a) * S * 0.75;
      const sy = fy + Math.sin(a) * S * 0.2 - S * 0.02;
      const r = S * (0.1 + (i % 3) * 0.02);
      s.fillStyle = stone;
      s.beginPath();
      s.ellipse(sx, sy, r * 1.2, r * 0.8, 0, 0, TAU);
      s.fill();
      s.fillStyle = kit.rgba(p('fireOuter'), 0.35);
      s.beginPath();
      s.ellipse(sx, sy - r * 0.35, r * 0.9, r * 0.35, 0, Math.PI, TAU);
      s.fill();
    }
    const logCol = mixHex(p('groundColor'), '#4a3326', 0.6);
    s.lineCap = 'round';
    for (const [a, len] of [[-0.35, 1.25], [0.4, 1.15], [3.0, 1.0]]) {
      s.strokeStyle = logCol;
      s.lineWidth = S * 0.16;
      s.beginPath();
      s.moveTo(fx - Math.cos(a) * S * len * 0.5, fy - S * 0.02 - Math.sin(a) * S * 0.18);
      s.lineTo(fx + Math.cos(a) * S * len * 0.5, fy - S * 0.02 + Math.sin(a) * S * 0.18);
      s.stroke();
    }
    // Glowing coal bed.
    kit.glow(s, fx, fy - S * 0.03, S * 0.55, p('fireOuter'), 0.6);
  }

  function build() {
    fire = { x: W * 0.27, y: H * 0.86, s: Math.max(26, Math.min(W, H) * 0.075) };
    buildScene();
    const rand = kit.seeded(5);
    stars = [];
    if (p('stars')) {
      const c = Math.round(W * H / 9000);
      for (let i = 0; i < c; i++) {
        stars.push({ x: rand() * W, y: Math.pow(rand(), 1.6) * H * 0.55, r: rand() < 0.1 ? 1.5 : 0.8 + rand() * 0.5, phase: rand() * TAU, speed: 0.4 + rand() * 1.2 });
      }
    }
    embers = [];
    const ec = Math.round(70 * p('embers'));
    for (let i = 0; i < ec; i++) {
      embers.push({
        period: 4 + rand() * 6, offset: rand() * 10, rise: H * (0.25 + rand() * 0.35),
        drift: (rand() - 0.3) * fire.s * 2.5, wob: 6 + rand() * 14, wf: 0.8 + rand() * 1.4,
        size: 1 + rand() * 1.8, spread: (rand() - 0.5) * fire.s * 0.7,
      });
    }
    tongues = [];
    for (let i = 0; i < 5; i++) {
      const k = (i / 4) * 2 - 1;
      tongues.push({ dx: k * 0.3, h: 0.9 + (1 - Math.abs(k)) * 0.9 + rand() * 0.3, w: 0.26 + rand() * 0.08, seed: rand() * 100, core: false });
    }
    for (let i = 0; i < 3; i++) {
      const k = i - 1;
      tongues.push({ dx: k * 0.14, h: 0.7 + (1 - Math.abs(k)) * 0.45 + rand() * 0.2, w: 0.18 + rand() * 0.04, seed: rand() * 100, core: true });
    }
  }
  build();

  function flick(t, seed) {
    return flickNoise(t * 1.3 + seed) * 0.65 + flickNoise(t * 2.7 + seed * 1.7) * 0.35;
  }

  function tongue(x, baseY, w, h, lean) {
    ctx.beginPath();
    ctx.moveTo(x - w, baseY);
    ctx.bezierCurveTo(x - w * 1.05, baseY - h * 0.45, x + lean * 0.4 - w * 0.35, baseY - h * 0.7, x + lean, baseY - h);
    ctx.bezierCurveTo(x + lean * 0.4 + w * 0.35, baseY - h * 0.7, x + w * 1.05, baseY - h * 0.45, x + w, baseY);
    ctx.quadraticCurveTo(x, baseY + w * 0.7, x - w, baseY);
    ctx.fill();
  }

  function render(time) {
    ctx.drawImage(scene.canvas, 0, 0);
    const amt = p('flicker');
    const { x: fx, y: fy, s: S } = fire;
    const core = p('fireCore');
    const outer = p('fireOuter');

    for (const st of stars) {
      const tw = 0.55 + 0.45 * Math.sin(time * st.speed + st.phase);
      ctx.fillStyle = `rgba(255, 248, 235, ${0.2 + tw * 0.55})`;
      ctx.fillRect(st.x, st.y, st.r, st.r);
    }

    // Overall light level, gently breathing.
    const level = 1 + flick(time * 0.8, 3) * 0.18 * amt;

    // Warm light pooling on the ground and lighting nearby trees.
    ctx.globalCompositeOperation = 'lighter';
    ctx.save();
    ctx.translate(fx, fy);
    ctx.scale(1, 0.42);
    kit.glow(ctx, 0, 0, S * 8, outer, 0.3 * level);
    ctx.restore();
    kit.glow(ctx, fx, fy - S * 0.8, S * 10, outer, 0.12 * level);
    kit.glow(ctx, fx, fy - S * 0.6, S * 2.6, outer, 0.22 * level);
    kit.glow(ctx, fx, fy - S * 0.5, S * 1.2, core, 0.25 * level);

    // Flame tongues: outer layer then the bright core.
    const wind = Math.sin(time * 0.21) * 0.12 + flick(time * 0.5, 9) * 0.1;
    for (const tg of tongues) {
      const n = flick(time + tg.seed, tg.seed);
      const h = S * tg.h * (1 + n * 0.22 * amt);
      const w = S * tg.w * (1 - n * 0.08 * amt);
      const lean = S * (wind + flick(time * 1.4 + tg.seed * 2, tg.seed + 5) * 0.18 * amt);
      const x = fx + S * tg.dx;
      const base = fy - S * 0.08;
      const g = ctx.createLinearGradient(0, base, 0, base - h);
      if (tg.core) {
        g.addColorStop(0, kit.rgba(core, 0.85));
        g.addColorStop(0.6, kit.rgba(core, 0.45));
        g.addColorStop(1, kit.rgba(outer, 0));
      } else {
        g.addColorStop(0, kit.rgba(outer, 0.75));
        g.addColorStop(0.55, kit.rgba(outer, 0.4));
        g.addColorStop(1, kit.rgba(outer, 0));
      }
      ctx.fillStyle = g;
      tongue(x, base, w, h, lean);
    }

    // Embers rising, swaying and fading out.
    for (const e of embers) {
      const age = ((time + e.offset) % e.period) / e.period;
      const y = fy - S * 0.6 - age * e.rise;
      const x = fx + e.spread + e.drift * age + Math.sin(time * e.wf + e.offset * 3) * e.wob * age;
      const a = Math.pow(1 - age, 1.4) * Math.min(1, age * 8) * (0.6 + 0.4 * Math.sin(time * 5 + e.offset * 7));
      if (a <= 0.01) continue;
      ctx.fillStyle = kit.rgba(age < 0.3 ? core : outer, a * 0.9);
      ctx.fillRect(x, y, e.size, e.size);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  return {
    resize(width, height) { W = width; H = height; build(); },
    render,
    destroy() { scene = null; stars = []; embers = []; tongues = []; },
  };
}

module.exports = { id: 'campfire', params, create };
