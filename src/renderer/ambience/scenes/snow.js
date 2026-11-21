/**
 * Snow - a quiet snowy evening (or a bright winter day, by colours alone):
 * layered mountains, snow-laden pine forests, an optional cabin with a warm
 * window and a wisp of chimney smoke, and soft snowfall in three depths.
 */
const kit = require('./_kit');

const params = [
  { key: 'skyTop', type: 'color', default: '#1c2547' },
  { key: 'skyBottom', type: 'color', default: '#6a6a96' },
  { key: 'mountainColor', type: 'color', default: '#3c4775' },
  { key: 'treeColor', type: 'color', default: '#18213a' },
  { key: 'snowColor', type: 'color', default: '#e4e9f7' },
  { key: 'windowColor', type: 'color', default: '#ffbe6e' },
  { key: 'density', type: 'range', min: 0, max: 1, step: 0.05, default: 0.6 },
  { key: 'wind', type: 'range', min: -1, max: 1, step: 0.05, default: 0.25 },
  { key: 'cabin', type: 'toggle', default: true },
];

/** kit.mix() as a hex string, so it can feed kit.rgba() and mix again. */
function mixHex(a, b, t) {
  const m = kit.mix(a, b, t).match(/\d+/g).map(Number);
  return '#' + m.map((v) => v.toString(16).padStart(2, '0')).join('');
}

function luminance(hex) {
  const { r, g, b } = kit.hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function create(ctx, env) {
  const p = kit.paramReader(params, env.params);
  const ridgeFbm = kit.makeFbm(kit.seeded(19), 5);
  const hillFbm = kit.makeFbm(kit.seeded(29), 3);
  const noise = kit.makeNoise(kit.seeded(37));
  let W = env.width;
  let H = env.height;
  let scene = null;
  let flake = null;
  let flakes = [];
  let cabin = null;

  // A pine as stacked tiers, each with a snowy upper rim.
  function pine(c, x, baseY, h, fill, snow, snowAlpha, rand) {
    const tiers = 4 + Math.floor(rand() * 3);
    const lean = (rand() - 0.5) * h * 0.03;
    c.fillStyle = fill;
    c.fillRect(x - h * 0.02, baseY - h * 0.12, h * 0.04, h * 0.14);
    const tier = (x0, y0, w, tip, k) => {
      c.beginPath();
      c.moveTo(x0 - w, y0);
      c.quadraticCurveTo(x0 - w * 0.3, y0 - h * 0.05, x0 + lean * k, tip);
      c.quadraticCurveTo(x0 + w * 0.3, y0 - h * 0.05, x0 + w, y0);
      c.closePath();
      c.fill();
    };
    for (let t = 0; t < tiers; t++) {
      const k = t / tiers;
      const w = h * 0.24 * (1 - k * 0.75);
      const y0 = baseY - h * 0.1 - h * 0.82 * k;
      const tip = y0 - h * 0.34 * (1 - k * 0.3);
      if (snowAlpha > 0) {
        // Snow resting on the tier: the tier in snow, then the dark tier
        // nudged down and right, leaving a crescent on the lit upper rim.
        c.fillStyle = kit.rgba(snow, snowAlpha);
        tier(x, y0, w, tip, k);
        c.fillStyle = fill;
        tier(x + w * 0.12, y0 + h * 0.018, w * 0.97, tip + h * 0.045, k);
      } else {
        c.fillStyle = fill;
        tier(x, y0, w, tip, k);
      }
    }
  }

  // A mountain range, taller towards the edges, with soft snow caps.
  function range(c, seed, base, height, scale, fill, snow, snowAlpha) {
    const step = 3;
    const ys = [];
    for (let x = -step; x <= W + step; x += step) {
      const u = x / W;
      const edge = 0.45 + 0.55 * Math.pow(Math.abs(u * 2 - 1), 1.2);
      const n = ridgeFbm(x / scale + seed) * 0.5 + 0.5;
      const peaks = Math.pow(Math.abs(ridgeFbm(x / (scale * 0.45) + seed * 2.3)), 1.3);
      ys.push(base - (n * 0.7 + peaks * 0.55) * height * edge);
    }
    c.fillStyle = fill;
    c.beginPath();
    c.moveTo(-step, H);
    for (let i = 0; i < ys.length; i++) c.lineTo(-step + i * step, ys[i]);
    c.lineTo(W + step, H);
    c.closePath();
    c.fill();

    let minY = Infinity;
    for (const y of ys) minY = Math.min(minY, y);
    const span = Math.max(1, base - minY);
    c.save();
    c.beginPath();
    c.moveTo(-step, ys[0]);
    for (let i = 0; i < ys.length; i++) c.lineTo(-step + i * step, ys[i]);
    for (let i = ys.length - 1; i >= 0; i--) {
      const x = -step + i * step;
      const elev = (base - ys[i]) / span;
      const cover = Math.max(0, elev - 0.3) / 0.7;
      c.lineTo(x, ys[i] + span * 0.55 * cover * (0.7 + 0.3 * noise(x / 13 + seed * 5)));
    }
    c.closePath();
    c.fillStyle = kit.rgba(snow, snowAlpha);
    c.fill();
    c.clip();
    // Shade the slopes facing away from the light.
    const d = Math.max(6, scale * 0.1);
    c.globalAlpha = 0.5;
    c.fillStyle = fill;
    c.beginPath();
    c.moveTo(-step, H);
    c.lineTo(-step, ys[0] + d * 0.15);
    for (let i = 0; i < ys.length; i++) c.lineTo(-step + i * step + d, ys[i] + d * 0.15);
    c.lineTo(W + d, H);
    c.closePath();
    c.fill();
    c.restore();
  }

  // Rolling snowy hill; returns its height function sampled every 4px.
  function hill(c, seed, base, amp, scale, top, bottom) {
    const pts = [];
    for (let x = -4; x <= W + 4; x += 4) pts.push(base - (hillFbm(x / scale + seed) * 0.5 + 0.5) * amp);
    c.beginPath();
    c.moveTo(-4, H);
    for (let i = 0; i < pts.length; i++) c.lineTo(-4 + i * 4, pts[i]);
    c.lineTo(W + 4, H);
    c.closePath();
    const g = c.createLinearGradient(0, base - amp, 0, H);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    c.fillStyle = g;
    c.fill();
    return (x) => pts[kit.clamp(Math.round((x + 4) / 4), 0, pts.length - 1)];
  }

  function build() {
    const rand = kit.seeded(5);
    const skyTop = p('skyTop');
    const skyBottom = p('skyBottom');
    const mountain = p('mountainColor');
    const tree = p('treeColor');
    const snow = p('snowColor');
    const win = p('windowColor');
    const night = kit.clamp(1 - luminance(skyTop) * 2.4, 0, 1);

    scene = kit.layer(W, H);
    const c = scene.ctx;

    // Sky with a low warm afterglow.
    kit.vGradient(c, 0, 0, W, H, [[0, skyTop], [0.55, mixHex(skyTop, skyBottom, 0.75)], [0.8, skyBottom], [1, skyBottom]]);
    const glowY = H * 0.62;
    const ag = c.createRadialGradient(W * 0.3, glowY, 0, W * 0.3, glowY, W * 0.5);
    ag.addColorStop(0, kit.rgba(mixHex(skyBottom, win, 0.45), 0.22));
    ag.addColorStop(1, kit.rgba(win, 0));
    c.fillStyle = ag;
    c.fillRect(0, 0, W, H);

    // Faint stars, only when the sky is dark enough to hold them.
    if (night > 0.05) {
      const n = Math.round(W * H / 6000);
      for (let i = 0; i < n; i++) {
        const y = Math.pow(rand(), 1.8) * H * 0.5;
        c.fillStyle = `rgba(255, 255, 255, ${night * (0.15 + rand() * 0.45) * (1 - y / (H * 0.5))})`;
        const r = rand() < 0.07 ? 1.4 : 0.6 + rand() * 0.6;
        c.fillRect(rand() * W, y, r, r);
      }
    }

    // Mountain layers, fading into the sky with distance.
    range(c, 2.3, H * 0.6, H * 0.3, 300, mixHex(mountain, skyBottom, 0.55), mixHex(snow, skyBottom, 0.3), 0.55);
    // Mist between ranges.
    kit.vGradient(c, 0, H * 0.48, W, H * 0.14, [[0, kit.rgba(skyBottom, 0)], [1, kit.rgba(skyBottom, 0.5)]]);
    range(c, 6.7, H * 0.66, H * 0.22, 200, mixHex(mountain, skyBottom, 0.2), mixHex(snow, skyBottom, 0.15), 0.7);
    kit.vGradient(c, 0, H * 0.56, W, H * 0.11, [[0, kit.rgba(skyBottom, 0)], [1, kit.rgba(skyBottom, 0.45)]]);

    // Far snowy hill with a misty pine forest along it.
    const farHill = hill(c, 1.1, H * 0.7, H * 0.07, 420, mixHex(snow, skyBottom, 0.45), mixHex(snow, mountain, 0.55));
    const farTree = mixHex(tree, skyBottom, 0.5);
    for (let x = 0; x < W; x += 5 + rand() * 7) {
      const u = x / W;
      const dense = noise(x / 90 + 3) * 0.5 + 0.5;
      const centreGap = Math.exp(-Math.pow((u - 0.5) / 0.12, 2));
      if (rand() > dense * (1 - centreGap * 0.7)) continue;
      const h = H * (0.025 + rand() * 0.03);
      pine(c, x, farHill(x) + h * 0.35, h, farTree, snow, 0, rand);
    }
    kit.vGradient(c, 0, H * 0.62, W, H * 0.1, [[0, kit.rgba(skyBottom, 0)], [1, kit.rgba(skyBottom, 0.2)]]);

    // Mid hill, nearer trees with snow on their boughs.
    const midHill = hill(c, 4.2, H * 0.78, H * 0.08, 360, mixHex(snow, skyBottom, 0.3), mixHex(snow, mountain, 0.5));
    const midTree = mixHex(tree, skyBottom, 0.28);
    for (let x = 0; x < W; x += 8 + rand() * 14) {
      const u = x / W;
      const edge = Math.abs(u * 2 - 1);
      if (rand() > 0.15 + edge * 0.85) continue;
      const h = H * (0.05 + rand() * 0.05) * (0.7 + edge * 0.5);
      pine(c, x, midHill(x) + h * 0.2, h, midTree, mixHex(snow, skyBottom, 0.25), 0.7, rand);
    }

    // Foreground snow field with soft drifts.
    const groundY = H * 0.86;
    const ground = hill(c, 8.8, groundY, H * 0.05, 500, mixHex(snow, skyBottom, 0.12), mixHex(snow, mountain, 0.45));
    for (let i = 0; i < 5; i++) {
      const y = groundY + (H - groundY) * (0.15 + i * 0.18);
      c.strokeStyle = kit.rgba(mountain, 0.08);
      c.lineWidth = 2;
      c.beginPath();
      for (let x = 0; x <= W; x += 12) {
        const yy = y + hillFbm(x / 260 + i * 7) * H * 0.02;
        if (x === 0) c.moveTo(x, yy); else c.lineTo(x, yy);
      }
      c.stroke();
    }

    // Soft blue shadows pooled in the drifts.
    for (let i = 0; i < 4; i++) {
      const u = [0.12, 0.38, 0.62, 0.9][i];
      c.save();
      c.translate(W * u, groundY + (H - groundY) * (0.55 + 0.2 * (i % 2)));
      c.scale(1, 0.12);
      kit.glow(c, 0, 0, W * 0.16, mountain, 0.14);
      c.restore();
    }

    // Cabin on the right, nestled among the near pines.
    cabin = null;
    if (p('cabin')) {
      const cw = Math.max(46, H * 0.13);
      const ch = cw * 0.55;
      const cx = W * 0.8;
      const by = ground(cx) + ch * 0.12;
      const wall = mixHex(tree, '#5a3b2c', 0.55);
      const wallDark = mixHex(wall, '#000000', 0.3);
      // Body.
      c.fillStyle = wall;
      c.fillRect(cx - cw / 2, by - ch, cw, ch);
      // Log lines.
      c.fillStyle = kit.rgba('#000000', 0.18);
      for (let y = by - ch + ch / 6; y < by; y += ch / 6) c.fillRect(cx - cw / 2, y, cw, 1);
      // Chimney.
      const chx = cx + cw * 0.24;
      c.fillStyle = wallDark;
      c.fillRect(chx - cw * 0.05, by - ch - cw * 0.42, cw * 0.1, cw * 0.3);
      c.fillStyle = kit.rgba(snow, 0.95);
      c.fillRect(chx - cw * 0.065, by - ch - cw * 0.44, cw * 0.13, cw * 0.035);
      // Roof under a thick blanket of snow.
      const ry = by - ch;
      c.fillStyle = wallDark;
      c.beginPath();
      c.moveTo(cx - cw * 0.62, ry + cw * 0.02);
      c.lineTo(cx, ry - cw * 0.36);
      c.lineTo(cx + cw * 0.62, ry + cw * 0.02);
      c.closePath();
      c.fill();
      c.fillStyle = snow;
      c.beginPath();
      c.moveTo(cx - cw * 0.66, ry + cw * 0.01);
      c.quadraticCurveTo(cx - cw * 0.4, ry - cw * 0.22, cx, ry - cw * 0.42);
      c.quadraticCurveTo(cx + cw * 0.4, ry - cw * 0.22, cx + cw * 0.66, ry + cw * 0.01);
      c.quadraticCurveTo(cx + cw * 0.3, ry - cw * 0.12, cx, ry - cw * 0.3);
      c.quadraticCurveTo(cx - cw * 0.3, ry - cw * 0.12, cx - cw * 0.66, ry + cw * 0.01);
      c.closePath();
      c.fill();
      // Door.
      c.fillStyle = wallDark;
      c.fillRect(cx + cw * 0.14, by - ch * 0.68, cw * 0.17, ch * 0.68);
      // Snow banked against the walls.
      c.fillStyle = snow;
      c.beginPath();
      c.moveTo(cx - cw * 0.7, by + 2);
      c.quadraticCurveTo(cx - cw * 0.4, by - ch * 0.22, cx, by - ch * 0.08);
      c.quadraticCurveTo(cx + cw * 0.4, by - ch * 0.02, cx + cw * 0.7, by + 2);
      c.closePath();
      c.fill();
      // A trodden path winding from the door towards the viewer.
      c.strokeStyle = kit.rgba(mountain, 0.13);
      c.lineCap = 'round';
      for (let k = 0; k < 2; k++) {
        c.lineWidth = cw * (0.16 - k * 0.07);
        c.beginPath();
        c.moveTo(cx + cw * 0.22, by + 2);
        c.bezierCurveTo(cx + cw * 0.3, by + (H - by) * 0.45, cx - cw * 0.9, by + (H - by) * 0.55, cx - cw * 0.7, H + 4);
        c.stroke();
      }
      cabin = {
        wx: cx - cw * 0.3, wy: by - ch * 0.72, ww: cw * 0.22, wh: ch * 0.36,
        chx, chy: by - ch - cw * 0.44, cw,
      };
    }

    // Near pines framing the edges.
    const nearSnow = mixHex(snow, skyBottom, 0.1);
    const spots = [
      [0.035, 1.0, 0.36], [0.1, 0.99, 0.26], [0.16, 1.0, 0.17],
      [0.9, 1.0, 0.3], [0.965, 1.0, 0.4], [0.7, 0.98, 0.13],
    ];
    for (const [u, v, s] of spots) {
      if (!p('cabin') && u === 0.7) continue;
      c.save();
      c.translate(W * u + H * s * 0.08, H * v - H * s * 0.02);
      c.scale(1, 0.18);
      kit.glow(c, 0, 0, H * s * 0.45, mountain, 0.28);
      c.restore();
      pine(c, W * u, H * v, H * s, tree, nearSnow, 0.8, rand);
    }

    // Snowflake sprite and flakes in three depths.
    flake = kit.layer(16, 16);
    const fg = flake.ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
    fg.addColorStop(0, kit.rgba(snow, 1));
    fg.addColorStop(0.45, kit.rgba(snow, 0.55));
    fg.addColorStop(1, kit.rgba(snow, 0));
    flake.ctx.fillStyle = fg;
    flake.ctx.fillRect(0, 0, 16, 16);

    const density = p('density');
    const area = W * H / (1400 * 860);
    const depths = [
      { n: 260, size: [1, 1.8], fall: [10, 16], sway: 6, alpha: 0.5 },
      { n: 120, size: [2.5, 4], fall: [20, 30], sway: 12, alpha: 0.7 },
      { n: 40, size: [5, 8], fall: [36, 50], sway: 20, alpha: 0.8 },
    ];
    flakes = [];
    for (let d = 0; d < depths.length; d++) {
      const L = depths[d];
      const n = Math.round(L.n * density * area);
      for (let i = 0; i < n; i++) {
        flakes.push({
          d,
          x: rand() * W,
          y: rand() * H,
          s: kit.lerp(L.size[0], L.size[1], rand()),
          fall: kit.lerp(L.fall[0], L.fall[1], rand()),
          sway: L.sway * (0.5 + rand() * 0.5),
          swayF: 0.15 + rand() * 0.25,
          phase: rand() * Math.PI * 2,
          a: L.alpha * (0.6 + rand() * 0.4),
        });
      }
    }
  }
  build();

  function render(time) {
    ctx.drawImage(scene.canvas, 0, 0);
    const win = p('windowColor');
    const snow = p('snowColor');

    if (cabin) {
      const flicker = 0.9 + 0.1 * noise(time * 0.35);
      const { wx, wy, ww, wh } = cabin;
      kit.glow(ctx, wx + ww / 2, wy + wh / 2, cabin.cw * 1.1, win, 0.22 * flicker);
      kit.glow(ctx, wx + ww / 2, wy + wh * 1.6, cabin.cw * 0.7, win, 0.14 * flicker);
      ctx.fillStyle = mixHex(win, '#ffffff', 0.15 * flicker);
      ctx.fillRect(wx, wy, ww, wh);
      ctx.fillStyle = kit.rgba('#000000', 0.35);
      ctx.fillRect(wx + ww / 2 - 1, wy, 2, wh);
      ctx.fillRect(wx, wy + wh / 2 - 1, ww, 2);
      // Smoke: a few soft puffs drifting up and away with the wind.
      const wind = p('wind');
      for (let i = 0; i < 6; i++) {
        const ph = (time * 0.035 + i / 6) % 1;
        const x = cabin.chx + Math.sin(ph * 4 + i) * cabin.cw * 0.06 + ph * cabin.cw * (0.4 + wind * 0.9);
        const y = cabin.chy - ph * cabin.cw * 1.8;
        const r = cabin.cw * (0.08 + ph * 0.3);
        kit.glow(ctx, x, y, r, mixHex(snow, p('skyBottom'), 0.3), 0.32 * (1 - ph) * Math.min(1, ph * 6));
      }
    }

    const wind = p('wind');
    const img = flake.canvas;
    ctx.fillStyle = snow;
    for (const f of flakes) {
      const span = H + 20;
      let y = (f.y + time * f.fall) % span;
      if (y < 0) y += span;
      y -= 10;
      let x = f.x + Math.sin(time * f.swayF + f.phase) * f.sway + time * wind * f.fall * 0.6;
      x = ((x % (W + 20)) + W + 20) % (W + 20) - 10;
      ctx.globalAlpha = f.a;
      if (f.d === 0) ctx.fillRect(x, y, f.s, f.s);
      else ctx.drawImage(img, x - f.s, y - f.s, f.s * 2, f.s * 2);
    }
    ctx.globalAlpha = 1;
  }

  return {
    resize(width, height) { W = width; H = height; build(); },
    render,
    destroy() { scene = null; flake = null; flakes = []; cabin = null; },
  };
}

module.exports = { id: 'snow', params, create };
