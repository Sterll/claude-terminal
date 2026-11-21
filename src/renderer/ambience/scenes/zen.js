/**
 * Zen - a koi pond at dusk seen from above: still water holding a faint sky
 * reflection, lily pads gently swaying, a couple of koi gliding on long slow
 * loops, and concentric ripples blooming at deterministic intervals and
 * fading out. A `sand` toggle swaps the pond for a raked zen garden (rocks in
 * raked rings, with slow cloud shadows passing over).
 */
const kit = require('./_kit');

const params = [
  { key: 'waterColor', type: 'color', default: '#18283a' },
  { key: 'rippleColor', type: 'color', default: '#cdbfe0' },
  { key: 'koiColor', type: 'color', default: '#e3804f' },
  { key: 'lilyColor', type: 'color', default: '#3e6a52' },
  { key: 'koi', type: 'toggle', default: true },
  { key: 'rippleRate', type: 'range', min: 0, max: 1, step: 0.05, default: 0.5 },
  { key: 'sand', type: 'toggle', default: false },
];

const TAU = Math.PI * 2;

/** Integer hash -> [0, 1), so ripple k always appears at the same place. */
function hash01(k, salt) {
  let h = (k * 374761393 + salt * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function luminance(hex) {
  const c = kit.hexToRgb(hex);
  return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
}

/** kit.mix returns rgb(); turn it back into hex for kit.rgba. */
function toHex(rgb) {
  const m = rgb.match(/\d+/g).map(Number);
  return '#' + m.map((v) => v.toString(16).padStart(2, '0')).join('');
}

function makeSoftSprite(color, size) {
  const L = kit.layer(size, size);
  const m = size / 2;
  const g = L.ctx.createRadialGradient(m, m, 0, m, m, m);
  g.addColorStop(0, kit.rgba(color, 1));
  g.addColorStop(0.4, kit.rgba(color, 0.6));
  g.addColorStop(0.75, kit.rgba(color, 0.15));
  g.addColorStop(1, kit.rgba(color, 0));
  L.ctx.fillStyle = g;
  L.ctx.fillRect(0, 0, size, size);
  return L.canvas;
}

function create(ctx, env) {
  const p = kit.paramReader(params, env.params);
  const sandMode = !!p('sand');
  const water = p('waterColor');
  const ripple = p('rippleColor');
  const koiCol = p('koiColor');
  const lily = p('lilyColor');
  const light = luminance(water) > 0.5;
  // Shade colour for shadows and depth: darker water on dark themes, a
  // muted version of the water itself on light ones so nothing goes grey.
  const shade = light ? kit.mix(water, '#3a3550', 0.35) : kit.mix(water, '#000000', 0.55);
  const shadeHex = toHex(shade);
  const cloud = makeSoftSprite(shadeHex, 128);

  let W = env.width;
  let H = env.height;
  let base = null;
  let pads = [];
  let rocks = [];

  function buildPad(r, rand) {
    const size = Math.ceil(r * 2 + 8);
    const L = kit.layer(size, size);
    const c = L.ctx;
    const m = size / 2;
    const notch = 0.28 + rand() * 0.12;
    const padPath = () => {
      c.beginPath();
      c.moveTo(m, m);
      c.arc(m, m, r, notch, TAU - notch * 0.15);
      c.closePath();
    };
    const g = c.createRadialGradient(m - r * 0.3, m - r * 0.3, 0, m, m, r);
    g.addColorStop(0, kit.mix(lily, '#ffffff', light ? 0.25 : 0.18));
    g.addColorStop(1, kit.mix(lily, light ? '#4a5a4a' : '#000000', 0.25));
    c.fillStyle = g;
    padPath();
    c.fill();
    // Rim and veins, very faint.
    c.strokeStyle = kit.rgba('#ffffff', light ? 0.25 : 0.08);
    c.lineWidth = 1;
    c.stroke();
    c.strokeStyle = kit.rgba('#000000', 0.08);
    for (let i = 0; i < 9; i++) {
      const a = notch + (TAU - notch * 1.15) * (i + 0.5) / 9;
      c.beginPath();
      c.moveTo(m, m);
      c.lineTo(m + Math.cos(a) * r * 0.9, m + Math.sin(a) * r * 0.9);
      c.stroke();
    }
    return L.canvas;
  }

  function buildFlower(r) {
    const size = Math.ceil(r * 2.4);
    const L = kit.layer(size, size);
    const c = L.ctx;
    const m = size / 2;
    const petal = kit.mix('#ffffff', koiCol, 0.22);
    const inner = kit.mix('#ffffff', koiCol, 0.45);
    for (let ring = 0; ring < 2; ring++) {
      const n = ring ? 6 : 8;
      const pr = r * (ring ? 0.62 : 1);
      c.fillStyle = ring ? inner : petal;
      for (let i = 0; i < n; i++) {
        const a = i / n * TAU + ring * 0.4;
        c.save();
        c.translate(m, m);
        c.rotate(a);
        c.beginPath();
        c.ellipse(pr * 0.55, 0, pr * 0.5, pr * 0.22, 0, 0, TAU);
        c.fill();
        c.restore();
      }
    }
    c.fillStyle = kit.mix('#f3d27a', koiCol, 0.2);
    c.beginPath();
    c.arc(m, m, r * 0.16, 0, TAU);
    c.fill();
    return L.canvas;
  }

  function buildWater() {
    const b = base.ctx;
    const cx = W * 0.5;
    const cy = H * 0.45;
    const R = Math.hypot(W, H) * 0.6;
    const g = b.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, kit.mix(water, ripple, light ? 0.08 : 0.06));
    g.addColorStop(0.6, water);
    g.addColorStop(1, shade);
    b.fillStyle = g;
    b.fillRect(0, 0, W, H);
    // Dusk sky reflected as a broad, soft sheen from one corner.
    const sheen = b.createLinearGradient(W, 0, W * 0.3, H);
    sheen.addColorStop(0, kit.rgba(ripple, light ? 0.18 : 0.12));
    sheen.addColorStop(0.55, kit.rgba(ripple, 0));
    b.fillStyle = sheen;
    b.fillRect(0, 0, W, H);
    // A few deeper, darker patches so the water has some floor beneath it.
    const rand = kit.seeded(83);
    for (let i = 0; i < 4; i++) {
      const d = Math.max(W, H) * (0.35 + rand() * 0.25);
      b.globalAlpha = light ? 0.12 : 0.28;
      b.drawImage(cloud, rand() * W - d / 2, rand() * H - d / 2, d, d * 0.7);
    }
    b.globalAlpha = 1;
  }

  function buildSand() {
    const b = base.ctx;
    const rand = kit.seeded(61);
    const fbm = kit.makeFbm(kit.seeded(67), 3);
    const short = Math.min(W, H);
    kit.vGradient(b, 0, 0, W, H, [[0, kit.mix(water, ripple, 0.08)], [1, water]]);
    // Fine sand speckle.
    const specks = Math.round(W * H / 90);
    for (let i = 0; i < specks; i++) {
      b.fillStyle = rand() < 0.5 ? kit.rgba('#ffffff', 0.05) : kit.rgba('#000000', 0.05);
      b.fillRect(rand() * W, rand() * H, 1, 1);
    }
    rocks = [
      { x: 0.2, y: 0.32, r: 0.055 },
      { x: 0.74, y: 0.62, r: 0.075 },
      { x: 0.9, y: 0.4, r: 0.03 },
      { x: 0.46, y: 0.82, r: 0.035 },
    ].map((k) => ({ x: k.x * W, y: k.y * H, r: k.r * short, ring: k.r * short * 2.6 }));

    const gap = Math.max(9, short * 0.018);
    const groove = (draw) => {
      // Each groove: a shadow line and a highlight line just above it.
      b.lineWidth = 1.4;
      b.strokeStyle = kit.rgba(shadeHex, light ? 0.22 : 0.4);
      b.save(); b.translate(0, 1.2); draw(); b.restore();
      b.strokeStyle = kit.rgba(ripple, light ? 0.45 : 0.22);
      draw();
    };
    // Straight rake lines, broken around each rock's ring zone.
    for (let y = gap / 2; y < H + gap; y += gap) {
      groove(() => {
        b.beginPath();
        let pen = false;
        for (let x = -4; x <= W + 4; x += 6) {
          const yy = y + fbm(x / 500 + y / 90) * 2.2;
          const inside = rocks.some((k) => Math.hypot(x - k.x, yy - k.y) < k.ring + gap * 0.4);
          if (inside) { pen = false; continue; }
          if (pen) b.lineTo(x, yy); else { b.moveTo(x, yy); pen = true; }
        }
        b.stroke();
      });
    }
    // Concentric rings around the rocks.
    for (const k of rocks) {
      for (let rr = k.r + gap * 0.9; rr <= k.ring; rr += gap) {
        groove(() => { b.beginPath(); b.arc(k.x, k.y, rr, 0, TAU); b.stroke(); });
      }
    }
    // Rocks with a soft cast shadow and a top light.
    for (const k of rocks) {
      b.fillStyle = kit.rgba(shadeHex, light ? 0.3 : 0.5);
      b.beginPath();
      b.ellipse(k.x + k.r * 0.14, k.y + k.r * 0.18, k.r * 1.04, k.r * 0.92, 0, 0, TAU);
      b.fill();
      const g = b.createRadialGradient(k.x - k.r * 0.4, k.y - k.r * 0.45, 0, k.x, k.y, k.r * 1.1);
      g.addColorStop(0, kit.mix(lily, '#ffffff', 0.3));
      g.addColorStop(1, kit.mix(lily, '#000000', 0.35));
      b.fillStyle = g;
      b.beginPath();
      for (let i = 0; i < 32; i++) {
        const a = i / 32 * TAU;
        const rr = k.r * (0.93 + 0.045 * Math.sin(2 * a + k.x) + 0.03 * Math.sin(3 * a + k.y));
        const px = k.x + Math.cos(a) * rr;
        const py = k.y + Math.sin(a) * rr * 0.85;
        if (i === 0) b.moveTo(px, py); else b.lineTo(px, py);
      }
      b.closePath();
      b.fill();
    }
  }

  function build() {
    base = kit.layer(W, H);
    if (sandMode) { buildSand(); return; }
    buildWater();
    const rand = kit.seeded(29);
    const short = Math.min(W, H);
    // Pads gathered in two loose clusters near opposite corners, leaving the
    // middle of the pond open.
    const clusters = [
      { x: 0.12, y: 0.2, n: 4 },
      { x: 0.86, y: 0.8, n: 4 },
      { x: 0.9, y: 0.16, n: 1 },
    ];
    pads = [];
    for (const cl of clusters) {
      for (let i = 0; i < cl.n; i++) {
        const r = short * (0.035 + rand() * 0.035);
        const a = rand() * TAU;
        const d = short * (0.02 + rand() * 0.1) * (i ? 1 : 0);
        pads.push({
          x: cl.x * W + Math.cos(a) * d,
          y: cl.y * H + Math.sin(a) * d,
          r,
          rot: rand() * TAU,
          sprite: buildPad(r, rand),
          phase: rand() * TAU,
          flower: null,
        });
      }
    }
    pads[1].flower = buildFlower(pads[1].r * 0.42);
    pads[5].flower = buildFlower(pads[5].r * 0.38);
  }
  build();

  // --- koi ---------------------------------------------------------------
  const koiDefs = [
    { cx: 0.46, cy: 0.5, rx: 0.3, ry: 0.27, w: 0.022, phase: 0.4, len: 0.15, dir: 1, spot: 0.55 },
    { cx: 0.56, cy: 0.46, rx: 0.24, ry: 0.32, w: 0.017, phase: 3.1, len: 0.12, dir: -1, spot: 0.85 },
  ];

  function koiPos(k, s, out) {
    // A closed loop with a gentle second harmonic, so it meanders.
    out.x = (k.cx + k.rx * Math.cos(s) + 0.05 * Math.sin(2 * s + 1)) * W;
    out.y = (k.cy + k.ry * Math.sin(s) + 0.04 * Math.cos(3 * s)) * H;
    return out;
  }

  const SEG = 16;
  const spine = Array.from({ length: SEG + 1 }, () => ({ x: 0, y: 0 }));
  const left = Array.from({ length: SEG + 1 }, () => ({ x: 0, y: 0 }));
  const right = Array.from({ length: SEG + 1 }, () => ({ x: 0, y: 0 }));
  const tmp = { x: 0, y: 0 };

  function koiShape(k, time) {
    const short = Math.min(W, H);
    const L = k.len * short;
    const s0 = k.phase + k.dir * time * k.w * TAU * 0.25;
    const R = Math.max(W * k.rx, H * k.ry);
    const ds = (L / SEG) / R * k.dir;
    const swim = time * 1.6 + k.phase;
    for (let i = 0; i <= SEG; i++) koiPos(k, s0 - ds * i, spine[i]);
    for (let i = 0; i <= SEG; i++) {
      const a = spine[Math.max(0, i - 1)];
      const b = spine[Math.min(SEG, i + 1)];
      let nx = -(a.y - b.y);
      let ny = a.x - b.x;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl; ny /= nl;
      const u = i / SEG;
      // Body undulation grows towards the tail.
      const wig = Math.sin(swim - u * 3.2) * u * u * L * 0.08;
      const cxp = spine[i].x + nx * wig;
      const cyp = spine[i].y + ny * wig;
      spine[i].x = cxp; spine[i].y = cyp;
      // Width profile: round head, full shoulders, slim peduncle.
      const wdt = L * 0.12 * (u < 0.22
        ? Math.sqrt(Math.max(0, 1 - Math.pow((0.22 - u) / 0.22, 2))) * 0.85 + 0.15 * (u / 0.22)
        : 1 - Math.pow((u - 0.22) / 0.78, 1.5) * 0.86);
      left[i].x = cxp + nx * wdt; left[i].y = cyp + ny * wdt;
      right[i].x = cxp - nx * wdt; right[i].y = cyp - ny * wdt;
    }
    return { L, swim };
  }

  function traceBody(c) {
    c.beginPath();
    c.moveTo(left[0].x, left[0].y);
    for (let i = 1; i <= SEG; i++) c.lineTo(left[i].x, left[i].y);
    for (let i = SEG; i >= 0; i--) c.lineTo(right[i].x, right[i].y);
    c.closePath();
  }

  function fins(c, L, swim) {
    // Tail: two soft lobes off the last spine segment.
    const a = spine[SEG - 1];
    const b = spine[SEG];
    const ang = Math.atan2(b.y - a.y, b.x - a.x) + Math.sin(swim - 3.2) * 0.35;
    c.save();
    c.translate(b.x, b.y);
    c.rotate(ang);
    c.beginPath();
    c.moveTo(-L * 0.03, 0);
    c.quadraticCurveTo(L * 0.1, -L * 0.03, L * 0.24, -L * 0.12);
    c.quadraticCurveTo(L * 0.17, 0, L * 0.24, L * 0.12);
    c.quadraticCurveTo(L * 0.1, L * 0.03, -L * 0.03, 0);
    c.fill();
    c.restore();
    // Pectoral fins, behind the head.
    const h = spine[4];
    const h2 = spine[5];
    const ha = Math.atan2(h2.y - h.y, h2.x - h.x);
    for (const side of [-1, 1]) {
      c.save();
      c.translate(h.x, h.y);
      c.rotate(ha + side * (1.0 + 0.15 * Math.sin(swim * 0.7 + side)));
      c.beginPath();
      c.ellipse(L * 0.1, 0, L * 0.1, L * 0.04, 0, 0, TAU);
      c.fill();
      c.restore();
    }
  }

  function drawKoi(k, time) {
    const { L, swim } = koiShape(k, time);
    const off = L * 0.16;
    // Shadow on the pond floor.
    ctx.save();
    ctx.translate(off, off * 1.2);
    ctx.fillStyle = kit.rgba(shadeHex, light ? 0.16 : 0.3);
    traceBody(ctx); ctx.fill();
    fins(ctx, L, swim);
    ctx.restore();
    // Body: koi colour with a pale head patch, slightly submerged.
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = kit.rgba(koiCol, 0.6);
    fins(ctx, L, swim);
    ctx.fillStyle = koiCol;
    traceBody(ctx); ctx.fill();
    ctx.save();
    traceBody(ctx); ctx.clip();
    ctx.fillStyle = kit.mix(koiCol, '#fff8f0', k.spot);
    const sp = spine[3];
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y, L * 0.16, L * 0.11, 0, 0, TAU);
    ctx.fill();
    const sp2 = spine[9];
    ctx.beginPath();
    ctx.ellipse(sp2.x, sp2.y, L * 0.09, L * 0.07, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // --- ripples -------------------------------------------------------------
  const RIPPLE_LIFE = 10;

  function drawRipples(time) {
    const rate = p('rippleRate');
    if (rate <= 0) return;
    const interval = kit.lerp(12, 1.6, rate);
    const short = Math.min(W, H);
    const speed = short * 0.028;
    const kMin = Math.floor((time - RIPPLE_LIFE) / interval) - 1;
    const kMax = Math.floor(time / interval) + 1;
    ctx.lineWidth = 1.3;
    for (let k = kMin; k <= kMax; k++) {
      const born = k * interval + hash01(k, 1) * interval * 0.6;
      const age = time - born;
      if (age < 0 || age > RIPPLE_LIFE) continue;
      const x = (0.08 + hash01(k, 2) * 0.84) * W;
      const y = (0.08 + hash01(k, 3) * 0.84) * H;
      const strength = 0.55 + hash01(k, 4) * 0.45;
      const fade = Math.min(1, age / 0.8) * Math.pow(1 - age / RIPPLE_LIFE, 1.6);
      for (let j = 0; j < 3; j++) {
        const r = age * speed - j * short * 0.018;
        if (r <= 1) continue;
        ctx.strokeStyle = kit.rgba(ripple, (light ? 0.8 : 0.5) * strength * fade * (1 - j * 0.28));
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.stroke();
      }
    }
  }

  function render(time) {
    ctx.drawImage(base.canvas, 0, 0);

    if (sandMode) {
      // Slow cloud shadows drifting across the garden.
      const short = Math.min(W, H);
      for (let i = 0; i < 3; i++) {
        const d = short * (0.9 + i * 0.25);
        const span = W + d * 2;
        let x = ((time * (6 + i * 2) + i * span / 3) % span) - d;
        const y = H * (0.25 + 0.3 * i) + Math.sin(time * 0.02 + i * 2) * H * 0.08;
        ctx.globalAlpha = light ? 0.12 : 0.22;
        ctx.drawImage(cloud, x - d / 2, y - d / 2, d * 1.4, d);
      }
      ctx.globalAlpha = 1;
      return;
    }

    if (p('koi')) for (const k of koiDefs) drawKoi(k, time);
    drawRipples(time);

    for (const pad of pads) {
      const sway = Math.sin(time * 0.15 + pad.phase);
      const s = pad.sprite;
      const dx = Math.cos(pad.phase) * sway * 2;
      const dy = Math.sin(pad.phase) * sway * 2;
      // Soft shadow under the pad.
      ctx.fillStyle = kit.rgba(shadeHex, light ? 0.18 : 0.35);
      ctx.beginPath();
      ctx.arc(pad.x + dx + pad.r * 0.12, pad.y + dy + pad.r * 0.16, pad.r, 0, TAU);
      ctx.fill();
      ctx.save();
      ctx.translate(pad.x + dx, pad.y + dy);
      ctx.rotate(pad.rot + sway * 0.04);
      ctx.drawImage(s, -s.width / 2, -s.height / 2);
      if (pad.flower) {
        const f = pad.flower;
        ctx.rotate(-pad.rot * 0.5);
        ctx.drawImage(f, -f.width / 2 - pad.r * 0.1, -f.height / 2 - pad.r * 0.1);
      }
      ctx.restore();
    }
  }

  return {
    resize(width, height) { W = width; H = height; build(); },
    render,
    destroy() { base = null; pads = []; rocks = []; },
  };
}

module.exports = { id: 'zen', params, create };
