/**
 * Sakura - a Japanese sunset: a pastel sky, a large soft sun sinking behind a
 * Fuji-like peak, layered hills with a small pagoda, a cherry tree in bloom on
 * the left and petals drifting and spinning slowly across the frame.
 */
const kit = require('./_kit');

const params = [
  { key: 'skyTop', type: 'color', default: '#4a3a6e' },
  { key: 'skyMid', type: 'color', default: '#b47aa2' },
  { key: 'skyBottom', type: 'color', default: '#f1b492' },
  { key: 'sunColor', type: 'color', default: '#ffe2b4' },
  { key: 'mountainColor', type: 'color', default: '#8a6c9b' },
  { key: 'hillFar', type: 'color', default: '#6a4e7c' },
  { key: 'hillNear', type: 'color', default: '#2e2140' },
  { key: 'treeColor', type: 'color', default: '#2a1b2f' },
  { key: 'blossomColor', type: 'color', default: '#f5b3c8' },
  { key: 'mountain', type: 'toggle', default: true },
  { key: 'petals', type: 'range', min: 0, max: 1, step: 0.05, default: 0.5 },
  { key: 'wind', type: 'range', min: 0.1, max: 2, step: 0.05, default: 0.6 },
];

const TAU = Math.PI * 2;

function create(ctx, env) {
  const p = kit.paramReader(params, env.params);
  const fbm = kit.makeFbm(kit.seeded(31), 4);
  const cloudNoise = kit.makeNoise(kit.seeded(5));
  let W = env.width;
  let H = env.height;
  let sky = null;
  let clouds = null;
  let tree = null;
  let land = null;
  let petals = [];
  let treeBase = { x: 0, y: 0 };

  function sun() {
    return { x: W * 0.55, y: H * 0.62, r: Math.max(26, Math.min(W, H) * 0.11) };
  }

  function ridge(s, y0, amp, scale, seed, color, rim, bumps = 0) {
    const pts = [];
    for (let x = -4; x <= W + 8; x += 3) {
      let tuft = 0;
      if (bumps) {
        // Rounded tree crowns along the ridge.
        const u = x / (bumps * 1.6) + seed * 7;
        const cell = Math.floor(u);
        const f = u - cell;
        const size = 0.4 + 0.6 * Math.abs(cloudNoise(cell * 1.37 + seed));
        tuft = Math.sqrt(Math.max(0, 1 - (2 * f - 1) * (2 * f - 1))) * bumps * size * (0.55 + 0.45 * fbm(x / 120 + seed));
      }
      pts.push([x, y0 - (fbm(x / scale + seed) * 0.5 + 0.5) * amp - tuft]);
    }
    const g = s.createLinearGradient(0, y0 - amp, 0, Math.min(H, y0 + H * 0.12));
    g.addColorStop(0, mixHex(color, p('sunColor'), 0.14));
    g.addColorStop(1, color);
    s.fillStyle = g;
    s.beginPath();
    s.moveTo(-4, H + 2);
    for (const [x, y] of pts) s.lineTo(x, y);
    s.lineTo(W + 8, H + 2);
    s.closePath();
    s.fill();
    if (rim) {
      s.strokeStyle = kit.rgba(p('sunColor'), rim);
      s.lineWidth = 1.2;
      s.beginPath();
      pts.forEach(([x, y], i) => (i ? s.lineTo(x, y + 0.5) : s.moveTo(x, y + 0.5)));
      s.stroke();
    }
    return pts;
  }

  function ridgeY(pts, x) {
    const i = Math.max(0, Math.min(pts.length - 2, Math.floor((x + 4) / 3)));
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    return kit.lerp(y0, y1, kit.clamp((x - x0) / (x1 - x0), 0, 1));
  }

  function haze(s, y, h, color, a) {
    kit.vGradient(s, 0, y - h, W, H - y + h, [[0, kit.rgba(color, 0)], [h / (H - y + h), kit.rgba(color, a)], [1, kit.rgba(color, a)]]);
  }

  function pagoda(s, x, baseY, size, color) {
    s.fillStyle = color;
    const tiers = 5;
    let y = baseY;
    let w = size;
    s.fillRect(x - w * 0.36, y - size * 0.12, w * 0.72, size * 0.12);
    y -= size * 0.12;
    for (let i = 0; i < tiers; i++) {
      const body = size * 0.16;
      s.fillRect(x - w * 0.28, y - body, w * 0.56, body);
      y -= body;
      // Roof with upturned eaves.
      s.beginPath();
      s.moveTo(x - w * 0.62, y + size * 0.015);
      s.quadraticCurveTo(x - w * 0.45, y - size * 0.02, x - w * 0.22, y - size * 0.07);
      s.lineTo(x + w * 0.22, y - size * 0.07);
      s.quadraticCurveTo(x + w * 0.45, y - size * 0.02, x + w * 0.62, y + size * 0.015);
      s.closePath();
      s.fill();
      y -= size * 0.07;
      w *= 0.84;
    }
    s.fillRect(x - size * 0.012, y - size * 0.3, size * 0.024, size * 0.3);
  }

  function buildSky() {
    sky = kit.layer(W, H);
    const s = sky.ctx;
    kit.vGradient(s, 0, 0, W, H, [
      [0, p('skyTop')], [0.38, p('skyMid')], [0.66, p('skyBottom')], [1, p('skyBottom')],
    ]);
    const sn = sun();
    kit.glow(s, sn.x, sn.y, Math.max(W, H) * 0.55, p('sunColor'), 0.28);
    kit.glow(s, sn.x, sn.y, sn.r * 3.2, p('sunColor'), 0.4);
    kit.glow(s, sn.x, sn.y, sn.r * 1.5, p('sunColor'), 0.55);
    const g = s.createLinearGradient(0, sn.y - sn.r, 0, sn.y + sn.r);
    g.addColorStop(0, p('sunColor'));
    g.addColorStop(1, mixHex(p('sunColor'), p('blossomColor'), 0.45));
    s.fillStyle = g;
    s.beginPath();
    s.arc(sn.x, sn.y, sn.r, 0, TAU);
    s.fill();
    // Soft fade so the disc edge is not razor sharp.
    s.strokeStyle = kit.rgba(p('sunColor'), 0.35);
    s.lineWidth = 3;
    s.stroke();

    // A little film grain, lofi texture.
    const rand = kit.seeded(77);
    const n = Math.round(W * H / 60);
    for (let i = 0; i < n; i++) {
      s.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.04)';
      s.fillRect(rand() * W, rand() * H, 1, 1);
    }
  }

  function buildClouds() {
    // Long thin streaks, twice the width so they can scroll and wrap.
    const cw = Math.ceil(W * 1.5);
    clouds = kit.layer(cw, H * 0.7);
    const s = clouds.ctx;
    const rand = kit.seeded(19);
    const bands = 9;
    for (let i = 0; i < bands; i++) {
      const y = H * (0.12 + rand() * 0.48);
      const len = W * (0.25 + rand() * 0.45);
      const x = rand() * cw;
      const th = 3 + rand() * 9;
      const light = y > H * 0.35;
      const col = light ? mixHex(p('sunColor'), p('blossomColor'), 0.5) : mixHex(p('skyMid'), p('blossomColor'), 0.4);
      for (const dx of [0, -cw]) {
        s.save();
        s.translate(x + dx + len / 2, y);
        s.scale(len / 2, th);
        const g = s.createRadialGradient(0, 0, 0, 0, 0, 1);
        g.addColorStop(0, kit.rgba(col, light ? 0.32 : 0.22));
        g.addColorStop(1, kit.rgba(col, 0));
        s.fillStyle = g;
        s.beginPath();
        s.arc(0, 0, 1, 0, TAU);
        s.fill();
        s.restore();
      }
      // Lumpy lower edge highlights.
      for (let k = 0; k < 6; k++) {
        const u = rand();
        const lx = x + (u - 0.5) * len * 0.8 + len / 2;
        const lw = len * (0.08 + rand() * 0.12) * (1 - Math.abs(u - 0.5));
        for (const dx of [0, -cw]) {
          s.save();
          s.translate(lx + dx, y + th * 0.3 + cloudNoise(i + k) * 2);
          s.scale(lw, th * 0.7);
          const g = s.createRadialGradient(0, 0, 0, 0, 0, 1);
          g.addColorStop(0, kit.rgba(col, 0.2));
          g.addColorStop(1, kit.rgba(col, 0));
          s.fillStyle = g;
          s.beginPath();
          s.arc(0, 0, 1, 0, TAU);
          s.fill();
          s.restore();
        }
      }
    }
  }

  function buildLand() {
    land = kit.layer(W, H);
    const s = land.ctx;
    const sn = sun();

    if (p('mountain')) {
      const cx = W * 0.8;
      const top = H * 0.36;
      const base = H * 0.72;
      const half = Math.max(W * 0.36, H * 0.55);
      const mh = base - top;
      const prof = [];
      for (let x = cx - half * 1.5; x <= cx + half * 1.5; x += 4) {
        const d = Math.abs(x - cx) / half;
        if (d > 1) { prof.push([x, base + (d - 1) * mh * 0.35]); continue; }
        const dd = Math.max(0, d - 0.035) / 0.965;
        let y = top + mh * (1 - Math.pow(1 - dd, 2.4)) + fbm(x / 70 + 9) * mh * 0.025 * d;
        if (d < 0.035) y = top + fbm(x / 9) * 1.5;
        prof.push([x, y]);
      }
      const mg = s.createLinearGradient(0, top, 0, base);
      mg.addColorStop(0, mixHex(p('mountainColor'), p('skyTop'), 0.15));
      mg.addColorStop(1, mixHex(p('mountainColor'), p('skyBottom'), 0.45));
      s.fillStyle = mg;
      s.beginPath();
      s.moveTo(prof[0][0], H);
      for (const [x, y] of prof) s.lineTo(x, y);
      s.lineTo(prof[prof.length - 1][0], H);
      s.closePath();
      s.fill();
      // Snow cap with ragged fingers running down the gullies.
      s.save();
      s.beginPath();
      for (const [x, y] of prof) s.lineTo(x, y);
      s.lineTo(cx + half, base);
      s.lineTo(cx - half, base);
      s.closePath();
      s.clip();
      const snowBase = top + mh * 0.2;
      const sg = s.createLinearGradient(cx - half * 0.3, 0, cx + half * 0.3, 0);
      sg.addColorStop(0, mixHex('#ffffff', p('sunColor'), 0.4));
      sg.addColorStop(1, mixHex(mixHex('#ffffff', p('mountainColor'), 0.45), p('skyMid'), 0.2));
      s.fillStyle = sg;
      s.globalAlpha = 0.75;
      s.beginPath();
      s.moveTo(cx - half, top - 10);
      const sw = half * 0.5;
      for (let x = cx - sw; x <= cx + sw; x += 3) {
        const u = (x - cx) / sw;
        const finger = Math.pow(Math.abs(Math.sin(u * 9.5 + 0.7)), 3) * mh * 0.09 * (1 - Math.abs(u));
        s.lineTo(x, snowBase + Math.abs(u) * mh * 0.05 + finger + fbm(x / 13) * 4);
      }
      s.lineTo(cx + half, top - 10);
      s.closePath();
      s.fill();
      s.restore();
      haze(s, base, mh * 0.55, p('skyBottom'), 0.55);
    }

    // Distant hills fading into the glow, then nearer, darker ones.
    const far = mixHex(p('hillFar'), p('skyBottom'), 0.35);
    ridge(s, H * 0.75, H * 0.08, 240, 2.3, far, 0.12);
    haze(s, H * 0.78, H * 0.06, p('skyBottom'), 0.35);
    const mid = ridge(s, H * 0.81, H * 0.09, 190, 7.7, p('hillFar'), 0.16, H * 0.012);
    // A pagoda on the mid hill, right side.
    const px = W * 0.87;
    pagoda(s, px, ridgeY(mid, px) + 3, Math.max(22, H * 0.075), mixHex(p('hillFar'), p('hillNear'), 0.6));
    haze(s, H * 0.86, H * 0.05, p('skyMid'), 0.18);
    ridge(s, H * 0.9, H * 0.07, 160, 13.1, mixHex(p('hillFar'), p('hillNear'), 0.55), 0.1, H * 0.018);
    ridge(s, H * 0.97, H * 0.05, 130, 21.4, p('hillNear'), 0.08);
    // Sun's warm reflection glow on the land.
    kit.glow(s, sn.x, H * 0.82, W * 0.3, p('sunColor'), 0.06);

    // Fallen petals scattered on the nearest ground.
    const rand = kit.seeded(41);
    const blossom = p('blossomColor');
    for (let i = 0; i < Math.round(W / 6); i++) {
      const x = Math.pow(rand(), 1.6) * W * 0.55;
      const y = H * 0.955 + rand() * H * 0.05;
      s.fillStyle = kit.rgba(blossom, 0.25 + rand() * 0.35);
      s.beginPath();
      s.ellipse(x, y, 1.2 + rand() * 1.6, 0.6 + rand() * 0.6, rand() * 0.6, 0, TAU);
      s.fill();
    }
  }

  function buildTree() {
    tree = kit.layer(W, H);
    const s = tree.ctx;
    const rand = kit.seeded(101);
    const S = Math.min(H, W * 0.75);
    const trunk = p('treeColor');
    const blossom = p('blossomColor');
    treeBase = { x: Math.min(W * 0.07, S * 0.11), y: H + 6 };
    const clusters = [];

    function segment(x, y, ex, ey, width, w1, bend) {
      const ang = Math.atan2(ey - y, ex - x);
      const len = Math.hypot(ex - x, ey - y);
      const nx = Math.cos(ang + Math.PI / 2);
      const ny = Math.sin(ang + Math.PI / 2);
      const mx = (x + ex) / 2 + nx * len * bend;
      const my = (y + ey) / 2 + ny * len * bend;
      s.beginPath();
      s.moveTo(x + nx * width / 2, y + ny * width / 2);
      s.quadraticCurveTo(mx + nx * (width + w1) / 4, my + ny * (width + w1) / 4, ex + nx * w1 / 2, ey + ny * w1 / 2);
      s.lineTo(ex - nx * w1 / 2, ey - ny * w1 / 2);
      s.quadraticCurveTo(mx - nx * (width + w1) / 4, my - ny * (width + w1) / 4, x - nx * width / 2, y - ny * width / 2);
      s.closePath();
      s.fill();
      s.beginPath();
      s.arc(ex, ey, w1 / 2, 0, TAU);
      s.fill();
      return { mx, my };
    }

    function limb(x, y, ang, len, width, depth) {
      // Cherry limbs zig-zag: two kinked sub-segments per limb.
      const kink = (rand() - 0.5) * 0.5;
      const kx = x + Math.cos(ang + kink) * len * 0.5;
      const ky = y + Math.sin(ang + kink) * len * 0.5;
      const ex = kx + Math.cos(ang - kink * 0.8) * len * 0.5;
      const ey = ky + Math.sin(ang - kink * 0.8) * len * 0.5;
      const w1 = Math.max(0.8, width * 0.62);
      const wm = (width + w1) / 2;
      s.fillStyle = trunk;
      segment(x, y, kx, ky, width, wm, (rand() - 0.5) * 0.12);
      segment(kx, ky, ex, ey, wm, w1, (rand() - 0.5) * 0.12);
      if (depth <= 2) {
        clusters.push({ x: ex, y: ey, r: S * (0.04 + rand() * 0.025) });
        if (depth <= 1) clusters.push({ x: kx, y: ky, r: S * (0.028 + rand() * 0.015) });
      }
      if (depth === 0) return;
      const kids = 2 + (rand() < 0.35 ? 1 : 0);
      for (let k = 0; k < kids; k++) {
        const spread = (k / (kids - 1) - 0.5) * (0.8 + rand() * 0.35);
        let na = ang + spread + (rand() - 0.5) * 0.25;
        na = kit.clamp(na, -2.7, -0.12);
        limb(ex, ey, na, len * (0.66 + rand() * 0.12), w1, depth - 1);
      }
    }

    // Trunk, then a few hand-placed main limbs; recursion does the rest.
    const tx = treeBase.x;
    const ty = treeBase.y;
    const tl = S * 0.4;
    const topX = tx + Math.cos(-1.42) * tl;
    const topY = ty + Math.sin(-1.42) * tl;
    s.fillStyle = trunk;
    segment(tx - S * 0.02, ty, topX, topY, S * 0.075, S * 0.04, 0.05);
    // Root flare.
    s.beginPath();
    s.ellipse(tx - S * 0.02, ty - 2, S * 0.07, S * 0.025, 0, 0, TAU);
    s.fill();
    const midX = kit.lerp(tx, topX, 0.62);
    const midY = kit.lerp(ty, topY, 0.62);
    limb(midX, midY, -0.45, S * 0.14, S * 0.026, 3);
    limb(topX, topY, -2.3, S * 0.17, S * 0.03, 4);
    limb(topX, topY, -1.35, S * 0.19, S * 0.035, 4);
    limb(topX, topY, -0.85, S * 0.2, S * 0.035, 4);

    // Canopy: soft masses first, then shaded, base and lit blossoms on top.
    const shade = mixHex(blossom, p('skyTop'), 0.5);
    const deep = mixHex(blossom, p('skyTop'), 0.3);
    const lit = mixHex(blossom, '#ffffff', 0.45);
    const warm = mixHex(blossom, p('sunColor'), 0.55);
    for (const c of clusters) kit.glow(s, c.x, c.y, c.r * 2.4, blossom, 0.06);
    const k = Math.max(0.7, S / 860);
    const passes = [
      { col: shade, dy: 0.3, dx: -0.1, n: 7, a: 0.9, rMin: 0.25, rMax: 0.45, rel: true },
      { col: deep, dy: 0.12, dx: 0, n: 10, a: 0.9, rMin: 0.18, rMax: 0.34, rel: true },
      { col: blossom, dy: -0.05, dx: 0.05, n: 14, a: 0.95, rMin: 2.2, rMax: 5.5 },
      { col: lit, dy: -0.3, dx: 0.15, n: 12, a: 0.9, rMin: 1.4, rMax: 3.4 },
      { col: warm, dy: -0.15, dx: 0.4, n: 6, a: 0.7, rMin: 1.2, rMax: 2.6 },
    ];
    for (const pass of passes) {
      s.fillStyle = pass.col;
      for (const c of clusters) {
        for (let i = 0; i < pass.n; i++) {
          const a = rand() * TAU;
          const d = Math.sqrt(rand()) * c.r * (pass.rel ? 0.75 : 1);
          const x = c.x + Math.cos(a) * d + pass.dx * c.r;
          const y = c.y + Math.sin(a) * d * 0.7 + pass.dy * c.r;
          const r = pass.rel ? c.r * kit.lerp(pass.rMin, pass.rMax, rand()) : kit.lerp(pass.rMin, pass.rMax, rand()) * k;
          s.globalAlpha = pass.a * (0.65 + rand() * 0.35);
          s.beginPath();
          s.arc(x, y, r, 0, TAU);
          s.fill();
        }
      }
    }
    s.globalAlpha = 1;
  }

  function buildPetals() {
    const rand = kit.seeded(3);
    const count = Math.round(W * H / 9000 * p('petals'));
    petals = [];
    for (let i = 0; i < count; i++) {
      const near = rand() < 0.12;
      petals.push({
        x: rand(), y: rand(),
        size: near ? 6 + rand() * 4 : 2.6 + rand() * 2.4,
        fall: (near ? 22 : 9) + rand() * 10,
        drift: 0.6 + rand() * 0.8,
        swayAmp: 10 + rand() * 30,
        swayF: 0.15 + rand() * 0.25,
        spin: (rand() - 0.5) * 1.6,
        flip: 0.4 + rand() * 0.9,
        phase: rand() * TAU,
        alpha: near ? 0.55 : 0.6 + rand() * 0.35,
        tone: rand(),
      });
    }
  }

  function build() {
    buildSky();
    buildClouds();
    buildLand();
    buildTree();
    buildPetals();
  }
  build();

  function render(time) {
    ctx.drawImage(sky.canvas, 0, 0);
    const wind = p('wind');

    // Drifting cloud streaks.
    const cw = clouds.canvas.width;
    const off = (time * wind * 5) % cw;
    ctx.drawImage(clouds.canvas, off, 0);
    ctx.drawImage(clouds.canvas, off - cw, 0);

    ctx.drawImage(land.canvas, 0, 0);

    // The tree sways a hair around its base.
    const sway = Math.sin(time * 0.35) * 0.004 * wind + Math.sin(time * 0.83 + 1) * 0.0015 * wind;
    ctx.save();
    ctx.translate(treeBase.x, treeBase.y);
    ctx.rotate(sway);
    ctx.translate(-treeBase.x, -treeBase.y);
    ctx.drawImage(tree.canvas, 0, 0);
    ctx.restore();

    // Petals: position is a pure function of time, so a frozen frame is fine.
    const blossom = p('blossomColor');
    const lit = mixHex(blossom, '#ffffff', 0.4);
    const spanX = W + 60;
    const spanY = H + 60;
    for (const pt of petals) {
      const x = ((pt.x * spanX + time * wind * 26 * pt.drift + Math.sin(time * pt.swayF + pt.phase) * pt.swayAmp) % spanX + spanX) % spanX - 30;
      const y = ((pt.y * spanY + time * pt.fall) % spanY) - 30;
      const rot = pt.phase + time * pt.spin;
      const flip = Math.cos(time * pt.flip + pt.phase);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.scale(1, 0.25 + 0.75 * Math.abs(flip));
      ctx.globalAlpha = pt.alpha;
      ctx.fillStyle = flip > 0 ? (pt.tone > 0.5 ? lit : blossom) : blossom;
      ctx.beginPath();
      ctx.ellipse(0, 0, pt.size, pt.size * 0.62, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  return {
    resize(width, height) { W = width; H = height; build(); },
    render,
    destroy() { sky = clouds = tree = land = null; petals = []; },
  };
}

/** Like kit.mix but returns a hex string so it can feed kit.rgba / kit.mix again. */
function mixHex(a, b, t) {
  const x = kit.hexToRgb(a);
  const y = kit.hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  const c = (u, v) => Math.round(u + (v - u) * k).toString(16).padStart(2, '0');
  return `#${c(x.r, y.r)}${c(x.g, y.g)}${c(x.b, y.b)}`;
}

module.exports = { id: 'sakura', params, create };
