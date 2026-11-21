/**
 * Meadow - a summer night field: a big starry sky with the Milky Way, a soft
 * glow along the horizon, low hills with a lone tree, tall grass swaying in a
 * slow travelling breeze and fireflies drifting up out of it. Pastel dawn or
 * dusk variants come from colours alone.
 */
const kit = require('./_kit');

const params = [
  { key: 'skyTop', type: 'color', default: '#0e1434' },
  { key: 'skyBottom', type: 'color', default: '#38406e' },
  { key: 'horizonGlow', type: 'color', default: '#b98aa8' },
  { key: 'milkyColor', type: 'color', default: '#cfc8f2' },
  { key: 'hillFar', type: 'color', default: '#2c3260' },
  { key: 'hillNear', type: 'color', default: '#1b2042' },
  { key: 'grassColor', type: 'color', default: '#0b0e21' },
  { key: 'grassTip', type: 'color', default: '#4a5585' },
  { key: 'fireflyColor', type: 'color', default: '#e4f59a' },
  { key: 'stars', type: 'range', min: 0, max: 1, step: 0.05, default: 0.7 },
  { key: 'fireflies', type: 'range', min: 0, max: 1, step: 0.05, default: 0.6 },
  { key: 'wind', type: 'range', min: 0, max: 2, step: 0.05, default: 1 },
  { key: 'milkyWay', type: 'toggle', default: true },
];

/** kit.mix with an alpha, as an rgba() string. */
function mixA(a, b, t, alpha) {
  const x = kit.hexToRgb(a);
  const y = kit.hexToRgb(b);
  const c = (u, v) => Math.round(u + (v - u) * t);
  return `rgba(${c(x.r, y.r)}, ${c(x.g, y.g)}, ${c(x.b, y.b)}, ${alpha.toFixed(3)})`;
}

/** Roughly normal sample in [-1, 1] (sum of uniforms). */
function gauss(rand) { return (rand() + rand() + rand() - 1.5) / 1.5; }

function create(ctx, env) {
  const p = kit.paramReader(params, env.params);
  const hillFbm = kit.makeFbm(kit.seeded(61), 3);
  const breeze = kit.makeNoise(kit.seeded(67));
  const wander = kit.makeNoise(kit.seeded(71));
  let W = env.width;
  let H = env.height;
  let sky = null;
  let land = null;
  let sprite = null;
  let twinkles = [];
  let blades = [];
  let flies = [];
  let grassFills = [];

  function drawMilkyWay(s) {
    const rand = kit.seeded(19);
    const cx = W * 0.56;
    const cy = H * 0.3;
    const ang = -0.62;
    const len = Math.hypot(W, H) * 0.75;
    const wid = Math.min(W, H) * 0.11;
    s.save();
    s.translate(cx, cy);
    s.rotate(ang);
    const spine = (u) => Math.sin(u / len * 5) * wid * 0.22;
    // Brightness along the band: knots and a brighter core near the horizon.
    const knot = (u) => 0.55 + 0.45 * Math.max(0, Math.sin(u / len * 11 + 1.3)) + Math.max(0, -u / len) * 0.9;
    s.filter = `blur(${Math.round(Math.max(10, wid * 0.45))}px)`;
    for (let i = 0; i < 30; i++) {
      const u = (rand() - 0.5) * len;
      const fade = 1 - Math.pow(Math.abs(u) / (len * 0.5), 2);
      s.fillStyle = kit.rgba(p('milkyColor'), 0.05 * fade);
      s.beginPath();
      s.ellipse(u, spine(u) + gauss(rand) * wid * 0.3, wid * 1.6, wid * 0.75, 0, 0, Math.PI * 2);
      s.fill();
    }
    s.filter = `blur(${Math.round(Math.max(5, wid * 0.18))}px)`;
    for (let i = 0; i < 90; i++) {
      const u = (rand() - 0.5) * len;
      const v = spine(u) + gauss(rand) * wid * 0.4;
      const r = wid * (0.12 + rand() * 0.3);
      const fade = 1 - Math.pow(Math.abs(u) / (len * 0.5), 2);
      const a = (0.025 + rand() * 0.06) * fade * knot(u);
      s.fillStyle = mixA(p('milkyColor'), p('horizonGlow'), u < 0 && rand() < 0.5 ? 0.35 : 0, a);
      s.beginPath();
      s.ellipse(u, v, r * 1.7, r * 0.8, (rand() - 0.5) * 0.4, 0, Math.PI * 2);
      s.fill();
    }
    // Dark, ragged dust lane slightly off the spine.
    s.filter = `blur(${Math.round(Math.max(4, wid * 0.12))}px)`;
    for (let i = 0; i < 80; i++) {
      const u = (rand() - 0.5) * len * 0.85;
      const v = spine(u) + wid * 0.06 + Math.sin(u / len * 23) * wid * 0.08 + gauss(rand) * wid * 0.06;
      const r = wid * (0.04 + rand() * 0.07);
      s.fillStyle = kit.rgba(p('skyTop'), 0.1 + rand() * 0.12);
      s.beginPath();
      s.ellipse(u, v, r * 2.4, r * 0.7, (rand() - 0.5) * 0.5, 0, Math.PI * 2);
      s.fill();
    }
    s.filter = 'none';
    // Dense dust of faint stars concentrated on the band.
    const n = Math.round(len * 2.2 * p('stars'));
    for (let i = 0; i < n; i++) {
      const u = (rand() - 0.5) * len;
      const v = spine(u) + gauss(rand) * wid * 0.55;
      const a = (0.1 + rand() * 0.4) * Math.min(1.3, knot(u));
      s.fillStyle = `rgba(255, 255, 255, ${a.toFixed(3)})`;
      const r = rand() < 0.05 ? 1.3 : 0.6 + rand() * 0.4;
      s.fillRect(u, v, r, r);
    }
    s.restore();
  }

  function build() {
    const rand = kit.seeded(3);
    const horizon = H * 0.7;

    sky = kit.layer(W, H);
    const s = sky.ctx;
    kit.vGradient(s, 0, 0, W, H, [
      [0, p('skyTop')],
      [0.6, p('skyBottom')],
      [0.8, kit.mix(p('skyBottom'), p('horizonGlow'), 0.45)],
      [1, kit.mix(p('skyBottom'), p('horizonGlow'), 0.45)],
    ]);
    // Wide low glow sitting on the horizon.
    s.save();
    s.translate(W * 0.5, horizon);
    s.scale(1, 0.32);
    kit.glow(s, 0, 0, W * 0.7, p('horizonGlow'), 0.45);
    s.restore();
    // Background stars.
    const count = Math.round(W * H / 2600 * p('stars'));
    for (let i = 0; i < count; i++) {
      const y = Math.pow(rand(), 1.3) * horizon;
      const a = (0.15 + rand() * 0.5) * (1 - 0.7 * y / horizon);
      s.fillStyle = `rgba(255, 255, 255, ${a.toFixed(3)})`;
      const r = 0.5 + rand() * 0.8;
      s.fillRect(rand() * W, y, r, r);
    }
    if (p('milkyWay')) drawMilkyWay(s);

    // Brighter stars that twinkle slowly.
    twinkles = [];
    const tn = Math.round(W * H / 16000 * p('stars'));
    for (let i = 0; i < tn; i++) {
      twinkles.push({
        x: rand() * W,
        y: Math.pow(rand(), 1.4) * horizon * 0.92,
        r: 1 + rand() * 1.1,
        phase: rand() * Math.PI * 2,
        speed: 0.25 + rand() * 0.6,
      });
    }

    // Hills, a lone tree on the far ridge, and the dense back grass.
    land = kit.layer(W, H);
    const l = land.ctx;
    const farY = (x) => horizon + hillFbm(x / 600 + 2) * H * 0.05 - Math.sin(x / W * Math.PI * 1.3 + 0.4) * H * 0.03;
    const nearY = (x) => H * 0.8 + hillFbm(x / 420 + 9) * H * 0.045 + Math.cos(x / W * Math.PI * 2) * H * 0.02;
    l.fillStyle = p('hillFar');
    l.beginPath();
    l.moveTo(0, H);
    for (let x = 0; x <= W; x += 6) l.lineTo(x, farY(x));
    l.lineTo(W, H);
    l.closePath();
    l.fill();
    // Lone tree, right third.
    const tx = W * 0.82;
    const ty = farY(tx) + 2;
    const th = H * 0.085;
    l.fillRect(tx - 1.5, ty - th * 0.6, 3, th * 0.6);
    l.beginPath();
    for (const [dx, dy, r] of [[0, -0.75, 0.32], [-0.26, -0.6, 0.24], [0.27, -0.62, 0.25], [0.1, -0.95, 0.22], [-0.12, -0.88, 0.2]]) {
      l.moveTo(tx + dx * th + r * th, ty + dy * th);
      l.arc(tx + dx * th, ty + dy * th, r * th, 0, Math.PI * 2);
    }
    l.fill();
    // Mist along the far ridge.
    const mg = l.createLinearGradient(0, horizon - H * 0.06, 0, H * 0.86);
    mg.addColorStop(0, kit.rgba(p('horizonGlow'), 0));
    mg.addColorStop(0.5, kit.rgba(p('horizonGlow'), 0.1));
    mg.addColorStop(1, kit.rgba(p('horizonGlow'), 0));
    l.fillStyle = mg;
    l.fillRect(0, horizon - H * 0.06, W, H * 0.3);

    l.fillStyle = p('hillNear');
    l.beginPath();
    l.moveTo(0, H);
    for (let x = 0; x <= W; x += 6) l.lineTo(x, nearY(x));
    l.lineTo(W, H);
    l.closePath();
    l.fill();
    // Short static grass tufts along the near crest.
    l.beginPath();
    for (let x = 0; x <= W; x += 2 + rand() * 3) {
      const y = nearY(x) + 2;
      const h = H * (0.012 + rand() * 0.025);
      const lean = (rand() - 0.5) * h * 0.8;
      l.moveTo(x - 1.2, y);
      l.quadraticCurveTo(x + lean * 0.3, y - h * 0.6, x + lean, y - h);
      l.quadraticCurveTo(x + lean * 0.3 + 0.6, y - h * 0.6, x + 1.2, y);
    }
    l.fill();

    // Swaying foreground blades, tall at the edges and short in the middle.
    blades = [];
    const bn = Math.round(W / 2.6);
    for (let i = 0; i < bn; i++) {
      const x = rand() * W;
      const edge = Math.abs(x / W - 0.5) * 2;
      const tall = 0.09 + 0.33 * Math.pow(edge, 1.8);
      const layerIdx = rand() < 0.45 ? 0 : rand() < 0.6 ? 1 : 2;
      blades.push({
        x,
        h: H * tall * (0.55 + rand() * 0.6) * (layerIdx === 0 ? 0.8 : 1),
        w: 2.4 + rand() * 3.2 + layerIdx * 1.2,
        lean: (rand() - 0.5) * 0.5,
        phase: rand() * Math.PI * 2,
        flex: 0.6 + rand() * 0.6,
        head: rand() < 0.07,
        layer: layerIdx,
      });
    }
    blades.sort((a, b) => a.layer - b.layer);
    grassFills = [0, 1, 2].map((k) => {
      const g = ctx.createLinearGradient(0, H * 0.62, 0, H);
      const tip = kit.mix(p('grassTip'), p('grassColor'), k * 0.3);
      const body = kit.mix(p('hillNear'), p('grassColor'), 0.4 + k * 0.3);
      g.addColorStop(0, tip);
      g.addColorStop(0.55, body);
      g.addColorStop(1, p('grassColor'));
      return g;
    });

    const S = 40;
    sprite = kit.layer(S, S);
    const sg = sprite.ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    sg.addColorStop(0, 'rgba(255, 255, 240, 1)');
    sg.addColorStop(0.16, kit.rgba(p('fireflyColor'), 0.95));
    sg.addColorStop(0.42, kit.rgba(p('fireflyColor'), 0.28));
    sg.addColorStop(1, kit.rgba(p('fireflyColor'), 0));
    sprite.ctx.fillStyle = sg;
    sprite.ctx.fillRect(0, 0, S, S);

    flies = [];
    const fn = Math.round(Math.sqrt(W * H) / 1100 * 60 * p('fireflies'));
    for (let i = 0; i < fn; i++) {
      flies.push({
        x: rand() * W,
        y0: H * (0.86 + rand() * 0.14),
        range: H * (0.1 + rand() * 0.2),
        speed: 4 + rand() * 5,
        off: rand(),
        size: 14 + rand() * 18,
        seed: rand() * 100,
        pulse: 0.4 + rand() * 0.5,
      });
    }
  }
  build();

  function drawFlies(time) {
    if (!flies.length) return;
    ctx.globalCompositeOperation = 'lighter';
    for (const f of flies) {
      const ph = ((time * f.speed / f.range + f.off) % 1 + 1) % 1;
      const life = Math.pow(Math.sin(ph * Math.PI), 1.5);
      const a = life * (0.55 + 0.45 * Math.sin(time * f.pulse + f.seed));
      if (a < 0.02) continue;
      const x = f.x + wander(f.seed + time * 0.07) * 60;
      const y = f.y0 - ph * f.range;
      ctx.globalAlpha = a;
      ctx.drawImage(sprite.canvas, x - f.size / 2, y - f.size / 2, f.size, f.size);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawGrass(time) {
    const wind = p('wind');
    const base = H + 4;
    let cur = -1;
    for (const b of blades) {
      if (b.layer !== cur) {
        if (cur >= 0) ctx.fill();
        cur = b.layer;
        ctx.fillStyle = grassFills[cur];
        ctx.beginPath();
      }
      // A slow gust travels across the field, plus each blade's own nod.
      const gust = breeze(b.x / 260 - time * 0.12 * wind) * 0.55 + Math.sin(time * 0.5 * wind + b.phase) * 0.12;
      const bend = b.lean + gust * wind * b.flex;
      const tipX = b.x + bend * b.h * 0.55;
      const tipY = base - b.h * (1 - 0.12 * Math.abs(bend));
      const cx = b.x + bend * b.h * 0.12;
      const cy = base - b.h * 0.55;
      ctx.moveTo(b.x - b.w / 2, base);
      ctx.quadraticCurveTo(cx - b.w * 0.25, cy, tipX, tipY);
      ctx.quadraticCurveTo(cx + b.w * 0.25, cy, b.x + b.w / 2, base);
      if (b.head) {
        const r = Math.min(3.2, b.w * 0.8);
        const ang = Math.atan2(tipY - cy, tipX - cx);
        ctx.moveTo(tipX + Math.cos(ang) * r * 2.4, tipY + Math.sin(ang) * r * 2.4);
        ctx.ellipse(tipX, tipY, r * 2.4, r, ang, 0, Math.PI * 2);
      }
    }
    if (cur >= 0) ctx.fill();
  }

  function render(time) {
    ctx.drawImage(sky.canvas, 0, 0);
    ctx.fillStyle = '#ffffff';
    for (const st of twinkles) {
      const tw = 0.5 + 0.5 * Math.sin(time * st.speed + st.phase);
      ctx.globalAlpha = 0.3 + tw * 0.6;
      ctx.fillRect(st.x, st.y, st.r, st.r);
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(land.canvas, 0, 0);
    drawFlies(time);
    drawGrass(time);
  }

  return {
    resize(width, height) { W = width; H = height; build(); },
    render,
    destroy() { sky = null; land = null; sprite = null; twinkles = []; blades = []; flies = []; grassFills = []; },
  };
}

module.exports = { id: 'meadow', params, create };
