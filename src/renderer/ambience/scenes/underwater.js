/**
 * Underwater - a calm deep sea: light shafts swaying down from the surface,
 * caustic shimmer near the top, marine snow, rising bubbles, softly pulsing
 * jellyfish and kelp swaying over reef silhouettes at the bottom edges.
 */
const kit = require('./_kit');

const params = [
  { key: 'waterTop', type: 'color', default: '#1d6a80' },
  { key: 'waterBottom', type: 'color', default: '#0a1c3a' },
  { key: 'lightColor', type: 'color', default: '#c4f1ff' },
  { key: 'jellyColor', type: 'color', default: '#f3a9e0' },
  { key: 'plantColor', type: 'color', default: '#0b2836' },
  { key: 'reefColor', type: 'color', default: '#0c2537' },
  { key: 'jellyfish', type: 'toggle', default: true },
  { key: 'bubbles', type: 'range', min: 0, max: 1, step: 0.05, default: 0.5 },
  { key: 'sway', type: 'range', min: 0.1, max: 2, step: 0.05, default: 0.7 },
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
  const fbm = kit.makeFbm(kit.seeded(37), 4);
  const noise = kit.makeNoise(kit.seeded(73));
  let W = env.width;
  let H = env.height;
  let bg = null;
  let front = null;
  let beam = null;
  let jellyGlow = null;
  let shafts = [];
  let bubbles = [];
  let snow = [];
  let jellies = [];
  let kelp = [];

  function buildBackground() {
    bg = kit.layer(W, H);
    const s = bg.ctx;
    kit.vGradient(s, 0, 0, W, H, [
      [0, mixHex(p('waterTop'), p('lightColor'), 0.12)], [0.35, p('waterTop')], [1, p('waterBottom')],
    ]);
    // Bright patch where the sun sits above the surface.
    kit.glow(s, W * 0.42, -H * 0.1, H * 0.75, p('lightColor'), 0.22);

    // Far reef: hazy, low-contrast silhouettes across the bottom.
    const far = mixHex(p('reefColor'), p('waterBottom'), 0.15);
    const hazeFar = mixHex(far, p('waterTop'), 0.45);
    s.fillStyle = hazeFar;
    s.beginPath();
    s.moveTo(0, H);
    for (let x = 0; x <= W; x += 6) {
      const e = Math.pow(Math.abs(x / W * 2 - 1), 1.2);
      s.lineTo(x, H * (0.86 - e * 0.1) - (fbm(x / 160 + 4) * 0.5 + 0.5) * H * 0.08);
    }
    s.lineTo(W, H);
    s.closePath();
    s.fill();
    kit.vGradient(s, 0, H * 0.7, W, H * 0.3, [[0, kit.rgba(p('waterBottom'), 0)], [1, kit.rgba(p('waterBottom'), 0.5)]]);

    // Soft vignette.
    const v = s.createRadialGradient(W / 2, H * 0.4, Math.min(W, H) * 0.35, W / 2, H * 0.45, Math.max(W, H) * 0.8);
    v.addColorStop(0, kit.rgba(p('waterBottom'), 0));
    v.addColorStop(1, kit.rgba(p('waterBottom'), 0.5));
    s.fillStyle = v;
    s.fillRect(0, 0, W, H);
  }

  function rock(s, cx, baseY, w, h, seed, color, rim) {
    s.fillStyle = color;
    s.beginPath();
    s.moveTo(cx - w / 2, baseY);
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const x = cx - w / 2 + t * w;
      const dome = Math.pow(Math.sin(t * Math.PI), 0.7);
      s.lineTo(x, baseY - dome * h * (0.8 + 0.35 * fbm(t * 3 + seed)));
    }
    s.lineTo(cx + w / 2, baseY);
    s.closePath();
    s.fill();
    if (rim) {
      s.save();
      s.clip();
      kit.vGradient(s, cx - w / 2, baseY - h * 1.2, w, h * 0.5, [[0, kit.rgba(p('lightColor'), rim)], [1, kit.rgba(p('lightColor'), 0)]]);
      s.restore();
    }
  }

  function buildFront() {
    // Near reef rocks in the bottom corners; kelp is drawn live on top.
    front = kit.layer(W, H);
    const s = front.ctx;
    const near = p('reefColor');
    const nearDark = mixHex(near, p('waterBottom'), 0.45);
    rock(s, W * 0.05, H + 4, W * 0.32, H * 0.22, 1, near, 0.22);
    rock(s, W * 0.2, H + 4, W * 0.18, H * 0.1, 3, near, 0.1);
    rock(s, W * 0.96, H + 4, W * 0.32, H * 0.26, 5, near, 0.22);
    rock(s, W * 0.8, H + 4, W * 0.16, H * 0.09, 8, near, 0.1);
    // Sandy floor.
    s.fillStyle = nearDark;
    s.beginPath();
    s.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) s.lineTo(x, H - H * 0.035 - fbm(x / 120 + 9) * H * 0.012);
    s.lineTo(W, H);
    s.closePath();
    s.fill();
    // Little coral fans on the rocks.
    const rand = kit.seeded(55);
    const fanCol = mixHex(p('jellyColor'), p('reefColor'), 0.6);
    for (const [fx, fy, fs] of [[W * 0.08, H * 0.84, 1], [W * 0.15, H * 0.9, 0.7], [W * 0.92, H * 0.8, 1.1], [W * 0.86, H * 0.88, 0.7]]) {
      s.strokeStyle = kit.rgba(fanCol, 0.75);
      s.lineCap = 'round';
      const sc = fs * Math.max(0.6, H / 860);
      const grow = (x, y, a, len, wdt, d) => {
        const ex = x + Math.cos(a) * len;
        const ey = y + Math.sin(a) * len;
        s.lineWidth = wdt;
        s.beginPath();
        s.moveTo(x, y);
        s.lineTo(ex, ey);
        s.stroke();
        if (d > 0) {
          grow(ex, ey, a - 0.35 - rand() * 0.2, len * 0.75, wdt * 0.7, d - 1);
          grow(ex, ey, a + 0.35 + rand() * 0.2, len * 0.75, wdt * 0.7, d - 1);
        }
      };
      grow(fx, fy, -Math.PI / 2 + (rand() - 0.5) * 0.3, 16 * sc, 3 * sc, 4);
    }
  }

  function buildSprites() {
    // One soft beam sprite, reused (stretched, skewed) for every shaft.
    const bw = 64;
    const bh = Math.ceil(H);
    beam = kit.layer(bw, bh);
    const b = beam.ctx;
    const hg = b.createLinearGradient(0, 0, bw, 0);
    hg.addColorStop(0, kit.rgba(p('lightColor'), 0));
    hg.addColorStop(0.5, kit.rgba(p('lightColor'), 1));
    hg.addColorStop(1, kit.rgba(p('lightColor'), 0));
    b.fillStyle = hg;
    b.fillRect(0, 0, bw, bh);
    b.globalCompositeOperation = 'destination-in';
    const vg = b.createLinearGradient(0, 0, 0, bh);
    vg.addColorStop(0, 'rgba(0,0,0,1)');
    vg.addColorStop(0.45, 'rgba(0,0,0,0.45)');
    vg.addColorStop(1, 'rgba(0,0,0,0)');
    b.fillStyle = vg;
    b.fillRect(0, 0, bw, bh);

    const gs = 128;
    jellyGlow = kit.layer(gs, gs);
    kit.glow(jellyGlow.ctx, gs / 2, gs / 2, gs / 2, p('jellyColor'), 1);
  }

  function buildParticles() {
    const rand = kit.seeded(9);
    shafts = [];
    for (let i = 0; i < 7; i++) {
      shafts.push({
        x: (0.08 + i / 7 * 0.9 + (rand() - 0.5) * 0.06) * W,
        width: W * (0.03 + rand() * 0.07),
        alpha: 0.07 + rand() * 0.09,
        phase: rand() * TAU,
        speed: 0.05 + rand() * 0.06,
        len: 0.6 + rand() * 0.35,
      });
    }
    bubbles = [];
    const sources = [W * 0.06, W * 0.13, W * 0.22, W * 0.79, W * 0.9, W * 0.95, W * 0.6];
    const bc = Math.round(70 * p('bubbles') * Math.max(0.5, W / 1400));
    for (let i = 0; i < bc; i++) {
      const src = sources[i % sources.length];
      bubbles.push({
        x: src + (rand() - 0.5) * W * 0.03,
        off: rand(),
        speed: 22 + rand() * 30,
        r: 1 + Math.pow(rand(), 2) * 3.5,
        wob: 3 + rand() * 7,
        wf: 0.6 + rand() * 1.2,
        phase: rand() * TAU,
      });
    }
    snow = [];
    const sc = Math.round(W * H / 11000);
    for (let i = 0; i < sc; i++) {
      snow.push({ x: rand(), y: rand(), r: 0.6 + rand() * 1.2, a: 0.1 + rand() * 0.25, vx: (rand() - 0.5) * 4, vy: 2 + rand() * 4, phase: rand() * TAU });
    }
    jellies = [];
    const spots = [[0.12, 0.35, 1], [0.86, 0.5, 0.85], [0.24, 0.72, 0.6], [0.7, 0.2, 0.5], [0.95, 0.15, 0.4]];
    for (const [jx, jy, js] of spots) {
      jellies.push({
        x: jx, y: jy, size: js * Math.max(26, Math.min(W, H) * 0.055),
        period: 4.5 + rand() * 2.5, phase: rand() * TAU,
        rise: 6 + rand() * 6, driftF: 0.03 + rand() * 0.03, driftA: 0.02 + rand() * 0.03,
      });
    }
    kelp = [];
    const roots = [
      [0.01, 0.5], [0.03, 0.62], [0.05, 0.4], [0.075, 0.52], [0.1, 0.3], [0.13, 0.38], [0.18, 0.22], [0.24, 0.14], [0.3, 0.08],
      [0.99, 0.55], [0.97, 0.42], [0.945, 0.6], [0.92, 0.33], [0.895, 0.45], [0.86, 0.24], [0.81, 0.16], [0.74, 0.1],
    ];
    for (const [rx, rh] of roots) {
      kelp.push({
        x: rx * W + (rand() - 0.5) * W * 0.01, h: rh * H * (0.85 + rand() * 0.3), w: Math.max(5, W * 0.0085) * (0.7 + rand() * 0.7),
        phase: rand() * TAU, back: rand() < 0.45,
      });
    }
  }

  function build() {
    buildBackground();
    buildFront();
    buildSprites();
    buildParticles();
  }
  build();

  function drawKelp(k, time, sway, color) {
    const segs = 16;
    const pts = [];
    let x = k.x;
    let y = H + 4;
    const step = k.h / segs;
    for (let i = 0; i <= segs; i++) {
      const f = i / segs;
      const bend = Math.sin(time * 0.45 * sway + k.phase - f * 2.2) * f * f * step * 1.6 * sway
        + noise(time * 0.15 + k.phase * 3 + f) * f * step * 0.8;
      pts.push([x + bend, y]);
      y -= step;
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i <= segs; i++) {
      const f = i / segs;
      const w = k.w * (1 - f * 0.75) * (0.75 + 0.5 * Math.abs(Math.sin(f * 7 + k.phase)));
      const [px, py] = pts[i];
      if (i === 0) ctx.moveTo(px - w, py); else ctx.lineTo(px - w, py);
    }
    for (let i = segs; i >= 0; i--) {
      const f = i / segs;
      const w = k.w * (1 - f * 0.75) * (0.75 + 0.5 * Math.abs(Math.sin(f * 7 + k.phase)));
      ctx.lineTo(pts[i][0] + w, pts[i][1]);
    }
    ctx.closePath();
    ctx.fill();
    // Leaf blades along the stalk, alternating sides.
    ctx.beginPath();
    for (let i = 3; i < segs; i += 2) {
      const f = i / segs;
      const side = i % 4 === 1 ? 1 : -1;
      const [px, py] = pts[i];
      const lean = side * (0.7 - f * 0.3) + Math.sin(time * 0.5 * sway + k.phase - f * 2) * 0.25;
      const len = k.w * (2.6 - f * 1.2);
      const ang = -Math.PI / 2 + lean;
      const cx = px + Math.cos(ang) * len;
      const cy = py + Math.sin(ang) * len;
      ctx.moveTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
      ctx.ellipse(cx, cy, len, k.w * 0.55, ang, 0, TAU);
    }
    ctx.fill();
  }

  function drawJelly(j, time, sway) {
    const t = time / j.period + j.phase;
    const pulse = 0.5 + 0.5 * Math.sin(t * TAU);           // 1 = relaxed, 0 = contracted
    const travel = (time * j.rise + Math.sin(t * TAU) * 4) % (H * 1.5);
    const x = (j.x + Math.sin(time * j.driftF + j.phase) * j.driftA * sway) * W;
    let y = j.y * H - travel;
    if (y < -H * 0.25) y += H * 1.5;
    const r = j.size;
    const bw = r * (0.85 + pulse * 0.25);
    const bh = r * (0.75 - pulse * 0.15);
    const col = p('jellyColor');
    const glowA = 0.35 + 0.15 * pulse;
    ctx.globalAlpha = glowA;
    ctx.drawImage(jellyGlow.canvas, x - r * 2.6, y - r * 2.2, r * 5.2, r * 5.2);
    // Tentacles trail below and lag the bell.
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(0.8, r * 0.035);
    for (let k = 0; k < 6; k++) {
      const tx0 = x - bw * 0.7 + (k / 5) * bw * 1.4;
      const len = r * (1.6 + (k % 3) * 0.5);
      ctx.beginPath();
      ctx.moveTo(tx0, y);
      for (let s = 1; s <= 8; s++) {
        const f = s / 8;
        ctx.lineTo(tx0 + Math.sin(time * 1.1 + k * 1.3 + f * 4 + j.phase) * r * 0.18 * f - (tx0 - x) * f * 0.3, y + f * len);
      }
      ctx.stroke();
    }
    // Bell: dome with a scalloped rim.
    ctx.globalAlpha = 0.75;
    const g = ctx.createLinearGradient(0, y - bh, 0, y);
    g.addColorStop(0, mixHex(col, '#ffffff', 0.45));
    g.addColorStop(1, kit.rgba(col, 0.55));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x - bw, y);
    ctx.bezierCurveTo(x - bw, y - bh * 1.35, x + bw, y - bh * 1.35, x + bw, y);
    for (let k = 5; k >= 0; k--) {
      const sx = x - bw + (k / 6) * bw * 2;
      ctx.quadraticCurveTo(sx + bw / 6, y + bh * 0.22, sx, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = mixHex(col, '#ffffff', 0.7);
    ctx.beginPath();
    ctx.ellipse(x - bw * 0.25, y - bh * 0.6, bw * 0.3, bh * 0.2, -0.3, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function render(time) {
    ctx.drawImage(bg.canvas, 0, 0);
    const sway = p('sway');

    // Light shafts, additive, slowly swaying and breathing.
    ctx.globalCompositeOperation = 'lighter';
    for (const sh of shafts) {
      const lean = 0.18 + Math.sin(time * sh.speed + sh.phase) * 0.06 * sway;
      const a = sh.alpha * (0.65 + 0.35 * Math.sin(time * sh.speed * 1.7 + sh.phase * 2));
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(sh.x, -10);
      ctx.transform(1, 0, -lean, 1, 0, 0);
      ctx.drawImage(beam.canvas, -sh.width / 2, 0, sh.width, H * sh.len);
      ctx.restore();
    }

    // Caustic shimmer: broken wavy bands near the surface, pieces fading in
    // and out as a slow noise field moves through them.
    ctx.lineCap = 'round';
    const light = p('lightColor');
    for (let k = 0; k < 7; k++) {
      const depth = k / 7;
      const y0 = H * 0.015 + depth * H * 0.2 * (0.6 + depth * 0.4);
      ctx.strokeStyle = kit.rgba(light, 0.16 * (1 - depth * 0.8));
      ctx.lineWidth = 1 + (1 - depth) * 2.2;
      ctx.beginPath();
      let on = false;
      for (let x = -10; x <= W + 10; x += 12) {
        const y = y0
          + Math.sin(x / (60 + k * 8) + time * 0.3 * sway + k * 1.7) * (3 + k * 1.2)
          + Math.sin(x / 27 - time * 0.22 * sway + k) * 2
          + noise(x / 90 + k * 5 + time * 0.06) * 5;
        const vis = noise(x / 55 + k * 11.3 - time * 0.12 * sway) > -0.1;
        if (vis && on) ctx.lineTo(x, y);
        else if (vis) ctx.moveTo(x, y);
        on = vis;
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';

    // Marine snow drifting gently down.
    ctx.fillStyle = kit.rgba(light, 1);
    for (const m of snow) {
      const x = ((m.x * W + time * m.vx + Math.sin(time * 0.3 + m.phase) * 6) % W + W) % W;
      const y = ((m.y * H + time * m.vy) % H + H) % H;
      ctx.globalAlpha = m.a;
      ctx.fillRect(x, y, m.r, m.r);
    }
    ctx.globalAlpha = 1;

    // Kelp behind the rocks, rocks, then kelp in front.
    const backCol = mixHex(p('plantColor'), p('waterTop'), 0.35);
    for (const k of kelp) if (k.back) drawKelp(k, time, sway, backCol);
    ctx.drawImage(front.canvas, 0, 0);

    if (p('jellyfish')) for (const j of jellies) drawJelly(j, time, sway);

    for (const k of kelp) if (!k.back) drawKelp(k, time, sway, p('plantColor'));

    // Bubbles rising and wobbling.
    if (bubbles.length) {
      ctx.lineWidth = 1;
      const span = H * 1.1;
      for (const b of bubbles) {
        const yy = H - ((b.off * span + time * b.speed) % span);
        const x = b.x + Math.sin(time * b.wf + b.phase) * b.wob;
        const fade = Math.min(1, yy / (H * 0.25));
        if (fade <= 0) continue;
        ctx.strokeStyle = kit.rgba(light, 0.45 * fade);
        ctx.beginPath();
        ctx.arc(x, yy, b.r, 0, TAU);
        ctx.stroke();
        ctx.fillStyle = kit.rgba(light, 0.5 * fade);
        ctx.fillRect(x - b.r * 0.45, yy - b.r * 0.5, Math.max(1, b.r * 0.35), Math.max(1, b.r * 0.35));
      }
    }
  }

  return {
    resize(width, height) { W = width; H = height; build(); },
    render,
    destroy() { bg = front = beam = jellyGlow = null; shafts = []; bubbles = []; snow = []; jellies = []; kelp = []; },
  };
}

module.exports = { id: 'underwater', params, create };
