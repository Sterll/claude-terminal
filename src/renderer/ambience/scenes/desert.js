/**
 * Desert - a desert night (or a golden day, by colours alone): a starry sky
 * with a faint galactic band, a big moon, smooth layered dunes shaded by the
 * moonlight with crisp crests, a distant caravan and sand wisps drifting off
 * the crests in the wind.
 */
const kit = require('./_kit');

const params = [
  { key: 'skyTop', type: 'color', default: '#0c1132' },
  { key: 'skyBottom', type: 'color', default: '#3e3468' },
  { key: 'horizonColor', type: 'color', default: '#b67f8e' },
  { key: 'orbColor', type: 'color', default: '#f6ead0' },
  { key: 'duneLight', type: 'color', default: '#b08aa6' },
  { key: 'duneShadow', type: 'color', default: '#2a2249' },
  { key: 'caravanColor', type: 'color', default: '#1c1733' },
  { key: 'caravan', type: 'toggle', default: true },
  { key: 'stars', type: 'range', min: 0, max: 1, step: 0.05, default: 0.65 },
  { key: 'wind', type: 'range', min: 0, max: 2, step: 0.05, default: 0.7 },
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
  const warp = kit.makeFbm(kit.seeded(13), 3);
  const heightNoise = kit.makeNoise(kit.seeded(29));
  const wispNoise = kit.makeNoise(kit.seeded(61));
  let W = env.width;
  let H = env.height;
  let sky = null;
  let land = null;
  let stars = [];
  let wisps = [];
  let crests = [];

  function orb() {
    const r = Math.max(18, Math.min(W, H) * 0.075);
    return { x: W * 0.77, y: H * 0.25, r };
  }

  // Dune profile along x: a crest, a long gentle face descending to the right
  // (towards the moon, lit), a trough, then a short steep slip face rising to
  // the next crest (in shadow). Returns height in [0, 1] and the cell index.
  function duneHeight(x, def) {
    const u0 = (x + warp(x / def.period * 1.1 + def.seed) * def.period * 0.55) / def.period + def.seed;
    const cell = Math.floor(u0);
    const v = u0 - cell;
    const trough = 0.62;
    const h = v < trough ? Math.pow(1 - kit.smooth(v / trough) * 0.6 - v / trough * 0.4, 1.2) : Math.pow((v - trough) / (1 - trough), 1.5);
    const sc = (c) => 0.3 + 0.7 * (heightNoise(c * 1.91 + def.seed * 3) * 0.5 + 0.5);
    const scale = v < trough ? sc(cell) : sc(cell + 1);
    // Trough depth blends smoothly so the profile has no jumps.
    return { h: h * scale, cell };
  }

  function buildSky() {
    const horizonY = H * 0.68;
    sky = kit.layer(W, H);
    const s = sky.ctx;
    kit.vGradient(s, 0, 0, W, H, [
      [0, p('skyTop')], [0.42, p('skyBottom')], [0.68, p('horizonColor')], [1, p('horizonColor')],
    ]);

    // Faint galactic band: many soft blobs along a diagonal arc.
    const rand = kit.seeded(17);
    const starAmt = p('stars');
    if (starAmt > 0) {
      for (let i = 0; i < 70; i++) {
        const t = rand();
        const x = -W * 0.05 + t * W * 0.75;
        const y = H * 0.05 + t * H * 0.42 + (rand() - 0.5) * H * 0.12 + Math.sin(t * 3) * H * 0.04;
        kit.glow(s, x, y, H * (0.05 + rand() * 0.08), mixHex(p('skyBottom'), '#ffffff', 0.25), 0.05 * starAmt);
      }
      // Dust of faint static stars, denser along the band.
      const n = Math.round(W * H / 900 * starAmt);
      for (let i = 0; i < n; i++) {
        let x;
        let y;
        if (rand() < 0.45) {
          const t = rand();
          x = -W * 0.05 + t * W * 0.75;
          y = H * 0.05 + t * H * 0.42 + (rand() + rand() - 1) * H * 0.09 + Math.sin(t * 3) * H * 0.04;
        } else {
          x = rand() * W;
          y = Math.pow(rand(), 1.3) * horizonY;
        }
        const fade = 1 - y / horizonY;
        s.fillStyle = `rgba(255, 255, 255, ${(0.08 + rand() * 0.28) * fade})`;
        s.fillRect(x, y, rand() < 0.1 ? 1.2 : 0.8, rand() < 0.1 ? 1.2 : 0.8);
      }
    }

    // Moon (or sun) with halo and soft maria.
    const o = orb();
    const col = p('orbColor');
    kit.glow(s, o.x, o.y, o.r * 9, col, 0.12);
    kit.glow(s, o.x, o.y, o.r * 3, col, 0.22);
    kit.glow(s, o.x, o.y, o.r * 1.5, col, 0.35);
    s.fillStyle = col;
    s.beginPath();
    s.arc(o.x, o.y, o.r, 0, TAU);
    s.fill();
    s.save();
    s.clip();
    const mare = mixHex(col, p('skyBottom'), 0.28);
    const mr = kit.seeded(44);
    for (let i = 0; i < 6; i++) {
      const a = mr() * TAU;
      const d = Math.sqrt(mr()) * o.r * 0.75;
      kit.glow(s, o.x + Math.cos(a) * d, o.y + Math.sin(a) * d, o.r * (0.15 + mr() * 0.25), mare, 0.3);
    }
    // Slight shading on the far side.
    const sh = s.createLinearGradient(o.x + o.r, o.y, o.x - o.r, o.y);
    sh.addColorStop(0, kit.rgba(p('skyBottom'), 0));
    sh.addColorStop(1, kit.rgba(p('skyBottom'), 0.18));
    s.fillStyle = sh;
    s.fillRect(o.x - o.r, o.y - o.r, o.r * 2, o.r * 2);
    s.restore();

    // Glow along the horizon.
    kit.vGradient(s, 0, horizonY - H * 0.12, W, H * 0.12 + 2, [
      [0, kit.rgba(p('horizonColor'), 0)], [1, kit.rgba(p('horizonColor'), 0.45)],
    ]);
  }

  function camel(s, x, y, k, flip) {
    // A small camel silhouette, feet on (x, y), facing right, height ~ 16k.
    s.save();
    s.translate(x, y);
    s.scale(flip ? -k : k, k);
    s.beginPath();
    s.ellipse(0, -10, 6.5, 3.6, 0, 0, TAU); // body
    s.fill();
    s.beginPath();
    s.ellipse(-0.5, -13, 3.6, 3, 0, Math.PI, TAU); // hump
    s.fill();
    s.lineWidth = 1.8;
    s.lineCap = 'round';
    s.strokeStyle = s.fillStyle;
    s.beginPath(); // neck and head
    s.moveTo(5, -11);
    s.quadraticCurveTo(9.5, -11, 9.5, -16);
    s.stroke();
    s.beginPath();
    s.ellipse(10.6, -16.2, 2, 1.1, 0.2, 0, TAU);
    s.fill();
    s.lineWidth = 1.1;
    for (const [lx, sw] of [[-4.5, -0.6], [-2.8, 0.5], [3, -0.5], [4.6, 0.6]]) {
      s.beginPath();
      s.moveTo(lx, -8);
      s.lineTo(lx + sw, 0);
      s.stroke();
    }
    s.restore();
  }

  function walker(s, x, y, k) {
    s.save();
    s.translate(x, y);
    s.scale(k, k);
    s.beginPath();
    s.moveTo(-1.6, 0);
    s.lineTo(-1.2, -8);
    s.quadraticCurveTo(0, -10.5, 1.2, -8);
    s.lineTo(1.6, 0);
    s.closePath();
    s.fill();
    s.beginPath();
    s.arc(0, -11.4, 1.6, 0, TAU);
    s.fill();
    s.restore();
  }

  function buildLand() {
    land = kit.layer(W, H);
    const s = land.ctx;
    const horizonY = H * 0.68;
    const defs = [
      { base: horizonY + H * 0.02, amp: H * 0.07, period: W * 0.32, seed: 1.3, haze: 0.62, edge: 0 },
      { base: horizonY + H * 0.1, amp: H * 0.1, period: W * 0.45, seed: 4.1, haze: 0.42, edge: 0.2 },
      { base: horizonY + H * 0.2, amp: H * 0.12, period: W * 0.62, seed: 7.7, haze: 0.22, edge: 0.45 },
      { base: H * 1.02, amp: H * 0.17, period: W * 0.9, seed: 2.6, haze: 0.04, edge: 0.75 },
    ];
    crests = [];
    const step = 2;
    defs.forEach((def, li) => {
      const n = Math.ceil((W + 8) / step) + 2;
      const ys = new Float32Array(n);
      const cells = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const x = i * step - 4;
        const e = Math.abs(x / W * 2 - 1);
        const env = 1 - def.edge + def.edge * Math.pow(e, 1.4);
        const d = duneHeight(x, def);
        ys[i] = def.base - def.amp * (0.2 + 0.8 * d.h) * env;
        cells[i] = d.cell;
      }
      // Round the crest corners a touch.
      const raw = ys.slice();
      for (let i = 2; i < n - 2; i++) ys[i] = (raw[i - 2] + raw[i - 1] * 2 + raw[i] * 3 + raw[i + 1] * 2 + raw[i + 2]) / 9;
      crests.push({ ys, step, def });
      const hazeCol = mixHex(p('skyBottom'), p('horizonColor'), 0.55);
      const lightC = mixHex(p('duneLight'), hazeCol, def.haze);
      const shadowC = mixHex(p('duneShadow'), hazeCol, def.haze * 0.9);
      const top = def.base - def.amp;
      const depth = def.amp * 1.3 + H * 0.04;

      s.save();
      s.beginPath();
      s.moveTo(-4, H + 2);
      for (let i = 0; i < n; i++) s.lineTo(i * step - 4, ys[i]);
      s.lineTo(W + 8, H + 2);
      s.closePath();
      s.clip();
      // Lit body: bright near the crests, settling into a mid tone.
      kit.vGradient(s, 0, top, W, H - top, [
        [0, lightC], [Math.min(1, depth / (H - top)), mixHex(lightC, shadowC, 0.55)], [1, mixHex(lightC, shadowC, 0.75)],
      ]);
      // Slip faces: from each trough up to its crest, then a sweeping edge
      // running down from the crest.
      const sg = s.createLinearGradient(0, top, 0, top + depth * 1.5);
      sg.addColorStop(0, shadowC);
      sg.addColorStop(1, mixHex(shadowC, lightC, 0.18));
      s.fillStyle = sg;
      let prevPeak = 0;
      for (let i = 1; i < n; i++) {
        if (cells[i] <= cells[i - 1]) continue;
        let ti = prevPeak;
        for (let j = prevPeak; j < i; j++) if (ys[j] > ys[ti]) ti = j;
        prevPeak = i;
        const px = i * step - 4;
        const py = ys[i];
        const tx = ti * step - 4;
        const span = Math.max(8, px - tx);
        s.beginPath();
        s.moveTo(tx, ys[ti]);
        for (let j = ti; j <= i; j++) s.lineTo(j * step - 4, ys[j]);
        s.bezierCurveTo(px + span * 0.35, py + depth * 0.25, px + span * 0.15, py + depth * 0.8, px + span * 0.75, py + depth * 1.8);
        // Lower edge of the shadow: back to the trough as a soft crescent.
        s.bezierCurveTo(px + span * 0.3, py + depth * 2.1, tx + span * 0.15, ys[ti] + depth * 1.7, tx - span * 0.3, ys[ti] + depth * 0.95);
        s.quadraticCurveTo(tx - span * 0.06, ys[ti] + depth * 0.3, tx, ys[ti]);
        s.closePath();
        s.fill();
      }
      // Moon sheen on the faces turned towards it.
      const o = orb();
      kit.glow(s, o.x, top, W * 0.45, p('orbColor'), 0.07 * (1 - def.haze));
      // Depth: darken towards the dune foot so the next layer separates.
      kit.vGradient(s, 0, top, W, H - top, [
        [0, kit.rgba(shadowC, 0)], [Math.min(1, depth * 1.2 / (H - top)), kit.rgba(shadowC, 0.35)], [1, kit.rgba(shadowC, 0.55)],
      ]);
      if (li >= 2) {
        s.lineWidth = 1;
        s.strokeStyle = kit.rgba(p('duneLight'), 0.05);
        const rr = kit.seeded(90 + li);
        for (let r = 0; r < 14; r++) {
          const off = 10 + r * (H * 0.012) + rr() * 4;
          s.beginPath();
          for (let i = 0; i < n; i += 3) {
            const x = i * step - 4;
            const y = ys[i] + off + Math.sin(x / (22 + r * 3) + r) * 2.2;
            if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
          }
          s.stroke();
        }
      }
      s.restore();
      // Moonlit rim on the crests.
      s.strokeStyle = kit.rgba(p('orbColor'), 0.18 - def.haze * 0.12);
      s.lineWidth = 1;
      s.beginPath();
      for (let i = 0; i < ys.length; i++) {
        if (i === 0) s.moveTo(-4, ys[i] + 0.5); else s.lineTo(i * step - 4, ys[i] + 0.5);
      }
      s.stroke();

      // Caravan along the crest of the second dune, right side.
      if (li === 1 && p('caravan')) {
        s.fillStyle = p('caravanColor');
        const k = Math.max(0.7, H / 860) * 1.1;
        const startX = W * 0.83;
        const items = ['walker', 'camel', 'camel', 'camel'];
        let x = startX;
        for (const it of items) {
          const yy = crestY(1, x) + 1;
          if (it === 'walker') { walker(s, x, yy, k); x -= 12 * k; } else { camel(s, x, yy, k, false); x -= 22 * k; }
        }
      }
    });
  }

  function crestY(li, x) {
    const c = crests[li];
    const f = (x + 4) / c.step;
    const i = Math.max(0, Math.min(c.ys.length - 2, Math.floor(f)));
    return kit.lerp(c.ys[i], c.ys[i + 1], kit.clamp(f - i, 0, 1));
  }

  function build() {
    buildSky();
    buildLand();
    const rand = kit.seeded(7);
    const horizonY = H * 0.68;
    stars = [];
    const count = Math.round(W * H / 7000 * p('stars'));
    for (let i = 0; i < count; i++) {
      stars.push({
        x: rand() * W,
        y: Math.pow(rand(), 1.5) * horizonY * 0.85,
        r: rand() < 0.1 ? 1.6 : 0.7 + rand() * 0.7,
        phase: rand() * TAU,
        speed: 0.4 + rand() * 1.2,
      });
    }
    wisps = [];
    const wc = Math.round(W / 22);
    for (let i = 0; i < wc; i++) {
      wisps.push({
        layer: 1 + Math.floor(rand() * 3),
        x: rand(),
        speed: 0.6 + rand() * 0.8,
        len: 18 + rand() * 46,
        lift: 2 + rand() * 7,
        phase: rand() * TAU,
        alpha: 0.1 + rand() * 0.12,
      });
    }
  }
  build();

  function render(time) {
    const horizonY = H * 0.68;
    ctx.drawImage(sky.canvas, 0, 0);

    for (const st of stars) {
      const tw = 0.55 + 0.45 * Math.sin(time * st.speed + st.phase);
      ctx.fillStyle = `rgba(255, 250, 240, ${(0.25 + tw * 0.6) * (1 - st.y / horizonY * 0.6)})`;
      ctx.fillRect(st.x, st.y, st.r, st.r);
    }

    ctx.drawImage(land.canvas, 0, 0);

    // Sand wisps blowing leftwards off the crests (away from the light).
    const wind = p('wind');
    if (wind > 0) {
      const span = W + 120;
      ctx.lineWidth = 1.2;
      ctx.lineCap = 'round';
      const sand = p('duneLight');
      const glint = mixHex(sand, p('orbColor'), 0.5);
      for (const w of wisps) {
        const travel = time * wind * 18 * w.speed;
        const x = ((w.x * span - travel) % span + span) % span - 60;
        // Fade in and out as it crosses its own cycle so wraps never pop.
        const cyc = ((w.x * span - travel) / span) % 1;
        const life = Math.sin((cyc < 0 ? cyc + 1 : cyc) * Math.PI * 4 + w.phase);
        if (life <= 0) continue;
        const a = w.alpha * life * Math.min(1, wind);
        const base = crestY(w.layer, x);
        ctx.strokeStyle = kit.rgba(glint, a);
        ctx.beginPath();
        const n = 6;
        for (let j = 0; j <= n; j++) {
          const xx = x + (j / n) * w.len;
          const yy = Math.min(crestY(w.layer, xx), base) - w.lift * (1 - j / n) * (0.6 + 0.4 * wispNoise(time * 0.5 + w.phase + j * 0.3)) - 1;
          if (j === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
        }
        ctx.stroke();
      }
    }
  }

  return {
    resize(width, height) { W = width; H = height; build(); },
    render,
    destroy() { sky = land = null; stars = []; wisps = []; crests = []; },
  };
}

module.exports = { id: 'desert', params, create };
