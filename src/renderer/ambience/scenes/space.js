/**
 * Space - a deep-space drift: soft nebulae slowly turning about the centre
 * (so they stay towards the edges), three parallax star layers, an optional
 * distant ringed planet and, now and then, a slow shooting star.
 *
 * The nebulae are painted once from many radial gradients into reduced
 * resolution layers large enough to rotate without exposing a corner; each
 * frame only blits and rotates them.
 */
const kit = require('./_kit');

const params = [
  { key: 'background', type: 'color', default: '#0b0c22' },
  { key: 'nebulaA', type: 'color', default: '#6b4fd8' },
  { key: 'nebulaB', type: 'color', default: '#d4609f' },
  { key: 'nebulaC', type: 'color', default: '#3c9fc6' },
  { key: 'starColor', type: 'color', default: '#e9edff' },
  { key: 'planetColor', type: 'color', default: '#e2a872' },
  { key: 'planet', type: 'toggle', default: true },
  { key: 'nebula', type: 'range', min: 0, max: 1.5, step: 0.05, default: 1 },
  { key: 'drift', type: 'range', min: 0, max: 3, step: 0.05, default: 1 },
];

const NEB_SCALE = 0.75; // nebula layers are painted below full resolution
const SHOOT_PERIOD = 26; // seconds between shooting-star chances
const SHOOT_LIFE = 2.4;

function mixHex(a, b, t) {
  const m = kit.mix(a, b, t).match(/\d+/g).map(Number);
  return '#' + m.map((v) => v.toString(16).padStart(2, '0')).join('');
}

function create(ctx, env) {
  const p = kit.paramReader(params, env.params);
  const fbm = kit.makeFbm(kit.seeded(71), 3);
  let W = env.width;
  let H = env.height;
  let D = 0;
  let base = null;
  let nebulae = [];
  let starLayers = [];
  let twinkles = [];
  let planet = null;

  function paintNebula(seed, clouds) {
    const S = Math.ceil(D * NEB_SCALE);
    const L = kit.layer(S, S);
    const c = L.ctx;
    const rand = kit.seeded(seed);
    const toL = (sx, sy) => [(sx - W / 2) * NEB_SCALE + S / 2, (sy - H / 2) * NEB_SCALE + S / 2];
    const unit = Math.min(W, H) * NEB_SCALE;
    c.globalCompositeOperation = 'lighter';
    for (const cl of clouds) {
      let [x, y] = toL(cl.x * W, cl.y * H);
      let a = cl.angle;
      const steps = cl.steps;
      for (let k = 0; k < steps; k++) {
        const along = k / steps;
        const swell = Math.sin(along * Math.PI);
        a += fbm(seed + k * 0.21) * 0.5;
        x += Math.cos(a) * unit * cl.len / steps;
        y += Math.sin(a) * unit * cl.len / steps;
        for (let j = 0; j < 3; j++) {
          const r = unit * cl.size * (0.25 + rand() * 0.75) * (0.4 + 0.6 * swell);
          const ox = (rand() - 0.5) * r * 1.2;
          const oy = (rand() - 0.5) * r * 1.2;
          const t = rand();
          const col = t < 0.5 ? mixHex(cl.c1, cl.c2, t * 0.6) : mixHex(cl.c2, cl.c1, (1 - t) * 0.6);
          kit.glow(c, x + ox, y + oy, r, col, cl.alpha * (0.5 + rand() * 0.5));
        }
        // Finer wisps scattered around the filament.
        for (let j = 0; j < 4; j++) {
          const r = unit * cl.size * (0.06 + rand() * 0.14);
          const d = unit * cl.size * 0.6 * (rand() + rand() - 1);
          const q = rand() * Math.PI * 2;
          kit.glow(c, x + Math.cos(q) * d, y + Math.sin(q) * d, r, rand() < 0.5 ? cl.c1 : cl.c2, cl.alpha * 1.4 * swell);
        }
        // Small bright knots along the filament.
        if (rand() < 0.15) {
          kit.glow(c, x + (rand() - 0.5) * unit * 0.05, y + (rand() - 0.5) * unit * 0.05, unit * (0.01 + rand() * 0.02), mixHex(cl.c1, '#ffffff', 0.5), 0.16);
        }
      }
    }
    // Dark dust lanes carved through the glow.
    c.globalCompositeOperation = 'destination-out';
    for (const cl of clouds) {
      let [x, y] = toL(cl.x * W, cl.y * H);
      let a = cl.angle + 0.5;
      for (let k = 0; k < cl.steps; k++) {
        a += fbm(seed * 2 + k * 0.3) * 0.7;
        x += Math.cos(a) * unit * cl.len / cl.steps;
        y += Math.sin(a) * unit * cl.len / cl.steps;
        if (rand() < 0.5) continue;
        const r = unit * cl.size * (0.1 + rand() * 0.25);
        const g = c.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(0,0,0,0.25)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g;
        c.fillRect(x - r, y - r, r * 2, r * 2);
      }
    }
    c.globalCompositeOperation = 'source-over';
    // A light blur melts the gradients' dithering into smooth haze.
    const out = kit.layer(S, S);
    out.ctx.filter = `blur(${Math.max(1, Math.round(unit * 0.004))}px)`;
    out.ctx.drawImage(L.canvas, 0, 0);
    out.ctx.filter = 'none';
    return out;
  }

  function paintStars(rand, count, rMin, rMax, alphaMin, alphaMax, glowChance) {
    const L = kit.layer(W, H);
    const c = L.ctx;
    const col = p('starColor');
    for (let i = 0; i < count; i++) {
      const x = rand() * W;
      const y = rand() * H;
      const r = kit.lerp(rMin, rMax, Math.pow(rand(), 2));
      const a = kit.lerp(alphaMin, alphaMax, rand());
      if (rand() < glowChance) kit.glow(c, x, y, r * 5, col, a * 0.18);
      c.fillStyle = kit.rgba(col, a);
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    }
    return L;
  }

  function paintPlanet() {
    const R = Math.max(24, Math.min(W, H) * 0.085);
    const size = Math.ceil(R * 5);
    const L = kit.layer(size, size);
    const c = L.ctx;
    const cx = size / 2;
    const cy = size / 2;
    const col = p('planetColor');
    const bg = p('background');
    const tilt = -0.32;
    const ringCol = mixHex(col, '#ffffff', 0.25);

    const rings = (front) => {
      c.save();
      c.translate(cx, cy);
      c.rotate(tilt);
      c.beginPath();
      if (front) c.rect(-size, 0, size * 2, size); else c.rect(-size, -size, size * 2, size);
      c.clip();
      const bands = [[1.45, 0.1, 0.22], [1.62, 0.14, 0.38], [1.8, 0.05, 0.16], [1.92, 0.1, 0.3], [2.1, 0.06, 0.14]];
      for (const [rr, w, a] of bands) {
        c.strokeStyle = kit.rgba(ringCol, a);
        c.lineWidth = R * w;
        c.beginPath();
        c.ellipse(0, 0, R * rr, R * rr * 0.24, 0, 0, Math.PI * 2);
        c.stroke();
      }
      c.restore();
    };

    // Atmosphere halo.
    kit.glow(c, cx, cy, R * 1.6, col, 0.12);
    rings(false);
    // Body, lit from the upper left.
    c.save();
    c.beginPath();
    c.arc(cx, cy, R, 0, Math.PI * 2);
    c.clip();
    const body = c.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    body.addColorStop(0, mixHex(col, '#ffffff', 0.12));
    body.addColorStop(0.45, mixHex(col, bg, 0.1));
    body.addColorStop(1, mixHex(col, bg, 0.55));
    c.fillStyle = body;
    c.fillRect(cx - R, cy - R, R * 2, R * 2);
    // Soft cloud bands, parallel to the rings.
    c.translate(cx, cy);
    c.rotate(tilt);
    const rand = kit.seeded(97);
    for (let i = 0; i < 9; i++) {
      const y = -R + (i + 0.5) * (2 * R / 9) + (rand() - 0.5) * R * 0.1;
      const h = R * (0.06 + rand() * 0.14);
      c.fillStyle = kit.rgba(rand() < 0.5 ? mixHex(col, '#ffffff', 0.3) : mixHex(col, bg, 0.45), 0.12 + rand() * 0.12);
      c.beginPath();
      c.ellipse(0, y, R * 1.3, h / 2, 0, 0, Math.PI * 2);
      c.fill();
    }
    c.rotate(-tilt);
    c.translate(-cx, -cy);
    // Night side.
    const shade = c.createLinearGradient(cx - R * 0.7, cy - R * 0.7, cx + R * 0.7, cy + R * 0.7);
    shade.addColorStop(0, kit.rgba(bg, 0));
    shade.addColorStop(0.45, kit.rgba(bg, 0.12));
    shade.addColorStop(0.75, kit.rgba(bg, 0.6));
    shade.addColorStop(1, kit.rgba(bg, 0.88));
    c.fillStyle = shade;
    c.fillRect(cx - R, cy - R, R * 2, R * 2);
    c.restore();
    // Thin lit rim.
    c.strokeStyle = kit.rgba(mixHex(col, '#ffffff', 0.5), 0.35);
    c.lineWidth = 1.2;
    c.beginPath();
    c.arc(cx, cy, R - 0.6, Math.PI * 0.85, Math.PI * 1.65);
    c.stroke();
    rings(true);
    return { L, x: W * 0.82 - size / 2, y: H * 0.26 - size / 2 };
  }

  function build() {
    D = Math.ceil(Math.hypot(W, H)) + 4;
    const bg = p('background');
    const A = p('nebulaA');
    const B = p('nebulaB');
    const C = p('nebulaC');

    base = kit.layer(W, H);
    kit.vGradient(base.ctx, 0, 0, W, H, [[0, mixHex(bg, '#000000', 0.25)], [0.6, bg], [1, mixHex(bg, A, 0.18)]]);

    nebulae = [
      paintNebula(3, [
        { x: 0.05, y: 0.15, angle: 0.6, len: 1.1, steps: 46, size: 0.42, alpha: 0.06, c1: A, c2: B },
        { x: 0.98, y: 0.62, angle: 2.3, len: 0.9, steps: 40, size: 0.38, alpha: 0.07, c1: B, c2: C },
      ]),
      paintNebula(9, [
        { x: 0.75, y: -0.05, angle: 1.9, len: 0.8, steps: 34, size: 0.36, alpha: 0.06, c1: C, c2: A },
        { x: 0.02, y: 0.95, angle: -0.5, len: 0.8, steps: 34, size: 0.4, alpha: 0.065, c1: A, c2: C },
      ]),
    ];

    const rand = kit.seeded(13);
    const area = W * H / (1400 * 860);
    starLayers = [
      { L: paintStars(rand, Math.round(700 * area), 0.35, 0.8, 0.25, 0.6, 0), speed: 1.2 },
      { L: paintStars(rand, Math.round(260 * area), 0.6, 1.2, 0.4, 0.85, 0.15), speed: 2.6 },
      { L: paintStars(rand, Math.round(60 * area), 0.9, 1.8, 0.6, 1, 0.6), speed: 5 },
    ];
    twinkles = [];
    for (let i = 0; i < Math.round(26 * area); i++) {
      twinkles.push({ x: rand() * W, y: rand() * H, r: 1.2 + rand() * 1.1, phase: rand() * Math.PI * 2, speed: 0.25 + rand() * 0.5 });
    }
    planet = p('planet') ? paintPlanet() : null;
  }
  build();

  // A shooting star at most once per period, at a seeded moment and place.
  function shootingStar(time) {
    const n = Math.floor(time / SHOOT_PERIOD);
    const r = kit.seeded(1000 + n);
    if (r() < 0.25) return; // some periods stay empty
    const start = 4 + r() * (SHOOT_PERIOD - SHOOT_LIFE - 5);
    const age = time - n * SHOOT_PERIOD - start;
    if (age < 0 || age > SHOOT_LIFE) return;
    const k = age / SHOOT_LIFE;
    // Either from the upper left, or low on the right (clear of the planet).
    const left = r() < 0.5;
    const x0 = W * (left ? 0.04 + r() * 0.24 : 0.74 + r() * 0.2);
    const y0 = H * (left ? 0.05 + r() * 0.25 : 0.5 + r() * 0.18);
    const ang = Math.PI * (left ? 0.12 + r() * 0.08 : 0.78 + r() * 0.08);
    const dist = Math.min(W, H) * 0.45;
    const hx = x0 + Math.cos(ang) * dist * k;
    const hy = y0 + Math.sin(ang) * dist * k;
    const tail = Math.min(W, H) * 0.12 * Math.min(1, k * 4);
    const fade = Math.sin(k * Math.PI);
    const tx = hx - Math.cos(ang) * tail;
    const ty = hy - Math.sin(ang) * tail;
    const col = p('starColor');
    const g = ctx.createLinearGradient(tx, ty, hx, hy);
    g.addColorStop(0, kit.rgba(col, 0));
    g.addColorStop(1, kit.rgba(col, 0.75 * fade));
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    kit.glow(ctx, hx, hy, 6, col, 0.5 * fade);
  }

  function render(time) {
    const drift = p('drift');
    const neb = p('nebula');
    ctx.drawImage(base.canvas, 0, 0);

    // Nebulae: two layers turning very slowly in opposite directions and
    // breathing in and out of each other.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < nebulae.length; i++) {
      const dir = i === 0 ? 1 : -0.7;
      const breathe = 0.82 + 0.18 * Math.sin(time * 0.05 * (1 + drift * 0.3) + i * Math.PI);
      ctx.save();
      ctx.globalAlpha = Math.min(1, neb * breathe);
      ctx.translate(W / 2, H / 2);
      ctx.rotate(time * 0.0025 * drift * dir);
      ctx.drawImage(nebulae[i].canvas, -D / 2, -D / 2, D, D);
      ctx.restore();
    }
    ctx.restore();

    // Parallax stars drifting slowly left.
    for (const s of starLayers) {
      const off = ((time * s.speed * drift) % W + W) % W;
      ctx.drawImage(s.L.canvas, -off, 0);
      ctx.drawImage(s.L.canvas, W - off, 0);
    }
    const col = p('starColor');
    ctx.fillStyle = col;
    for (const t of twinkles) {
      const x = ((t.x - time * 5 * drift) % W + W) % W;
      const tw = 0.5 + 0.5 * Math.sin(time * t.speed + t.phase);
      ctx.globalAlpha = 0.3 + 0.6 * tw;
      ctx.fillRect(x - t.r / 2, t.y - t.r / 2, t.r, t.r);
    }
    ctx.globalAlpha = 1;

    if (planet) ctx.drawImage(planet.L.canvas, planet.x, planet.y);

    shootingStar(time);
  }

  return {
    resize(width, height) { W = width; H = height; build(); },
    render,
    destroy() { base = null; nebulae = []; starLayers = []; twinkles = []; planet = null; },
  };
}

module.exports = { id: 'space', params, create };
