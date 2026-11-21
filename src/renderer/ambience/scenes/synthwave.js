/**
 * Synthwave - a retro 80s sunset, kept soft: a striped sun sinking behind
 * dusky mountains with a faint neon rim, a perspective grid floor sliding
 * slowly toward the viewer and a few quiet stars.
 */
const kit = require('./_kit');

const params = [
  { key: 'skyTop', type: 'color', default: '#130f2e' },
  { key: 'skyMid', type: 'color', default: '#3b2457' },
  { key: 'skyBottom', type: 'color', default: '#a4537a' },
  { key: 'sunTop', type: 'color', default: '#ffd59a' },
  { key: 'sunBottom', type: 'color', default: '#f0648e' },
  { key: 'gridColor', type: 'color', default: '#d86bd0' },
  { key: 'mountainColor', type: 'color', default: '#1f1638' },
  { key: 'groundColor', type: 'color', default: '#140d26' },
  { key: 'gridSpeed', type: 'range', min: 0, max: 3, step: 0.05, default: 1 },
  { key: 'stars', type: 'range', min: 0, max: 1, step: 0.05, default: 0.5 },
  { key: 'sun', type: 'toggle', default: true },
];

const TAU = Math.PI * 2;
const ROWS = 22;

function create(ctx, env) {
  const p = kit.paramReader(params, env.params);
  const fbm = kit.makeFbm(kit.seeded(29), 5);
  let W = env.width;
  let H = env.height;
  let horizonY = 0;
  let back = null;
  let floor = null;
  let stars = [];

  function ridge(c, base, amp, freq, seedOff, color, rim) {
    const pts = [];
    for (let x = -4; x <= W + 4; x += 3) {
      const d = Math.abs(x / W - 0.5) * 2;
      // Low in the middle (where the sun sets), rising toward the edges.
      const env01 = 0.06 + 0.94 * Math.pow(d, 1.6);
      const n = fbm(x / W * freq + seedOff) * 0.5 + 0.5;
      const ridgeN = 1 - Math.abs(fbm(x / W * freq * 2.3 + seedOff + 9));
      pts.push([x, base - amp * env01 * (0.35 + n * 0.45 + ridgeN * 0.35)]);
    }
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(-4, base + 2);
    for (const [x, y] of pts) c.lineTo(x, y);
    c.lineTo(W + 4, base + 2);
    c.closePath();
    c.fill();
    if (rim) {
      c.save();
      c.lineJoin = 'round';
      c.strokeStyle = kit.rgba(p('gridColor'), rim * 0.35);
      c.lineWidth = 4;
      c.filter = 'blur(3px)';
      c.beginPath();
      pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.stroke();
      c.filter = 'none';
      c.strokeStyle = kit.rgba(p('gridColor'), rim);
      c.lineWidth = 1.2;
      c.stroke();
      c.restore();
    }
  }

  function build() {
    const rand = kit.seeded(13);
    horizonY = Math.round(H * 0.62);
    const unit = Math.min(W, H);

    // Sky, stars, sun, mountains: everything above the horizon is static.
    back = kit.layer(W, horizonY + 1);
    const b = back.ctx;
    kit.vGradient(b, 0, 0, W, horizonY + 1, [[0, p('skyTop')], [0.55, p('skyMid')], [1, p('skyBottom')]]);

    stars = [];
    const count = Math.round(W * H / 5500 * p('stars'));
    for (let i = 0; i < count; i++) {
      const y = Math.pow(rand(), 1.8) * horizonY * 0.7;
      const r = rand() < 0.07 ? 1.6 : 0.6 + rand() * 0.6;
      const a = (0.25 + rand() * 0.5) * (1 - y / (horizonY * 0.75));
      if (rand() < 0.15) {
        stars.push({ x: rand() * W, y, r, a, phase: rand() * TAU, speed: TAU / (6 + rand() * 10) });
      } else {
        b.fillStyle = `rgba(255, 240, 255, ${a})`;
        b.fillRect(rand() * W, y, r, r);
      }
    }

    const sunR = unit * 0.24;
    const sunX = W * 0.5;
    const sunY = horizonY - sunR * 0.62;
    if (p('sun')) {
      kit.glow(b, sunX, sunY, sunR * 2.8, p('sunBottom'), 0.22);
      kit.glow(b, sunX, sunY, sunR * 1.5, p('sunTop'), 0.14);
      const sun = kit.layer(sunR * 2 + 2, sunR * 2 + 2);
      const s = sun.ctx;
      const g = s.createLinearGradient(0, 0, 0, sunR * 2);
      g.addColorStop(0, p('sunTop'));
      g.addColorStop(1, p('sunBottom'));
      s.fillStyle = g;
      s.beginPath();
      s.arc(sunR + 1, sunR + 1, sunR, 0, TAU);
      s.fill();
      // Stripes cut out of the lower half, growing thicker toward the bottom.
      s.globalCompositeOperation = 'destination-out';
      const bands = 7;
      for (let i = 0; i < bands; i++) {
        const k = i / bands;
        const y = sunR * (0.9 + k * 1.0) + 1;
        const h = Math.max(1, sunR * (0.018 + k * 0.06));
        s.fillRect(0, y, sunR * 2 + 2, h);
      }
      s.globalCompositeOperation = 'source-over';
      b.drawImage(sun.canvas, sunX - sunR - 1, sunY - sunR - 1);
    }

    // Haze band on the horizon.
    const haze = b.createLinearGradient(0, horizonY - H * 0.12, 0, horizonY);
    haze.addColorStop(0, kit.rgba(p('skyBottom'), 0));
    haze.addColorStop(1, kit.rgba(p('skyBottom'), 0.55));
    b.fillStyle = haze;
    b.fillRect(0, horizonY - H * 0.12, W, H * 0.12 + 1);

    // Two ridges: a far hazy one and a near one with a neon rim.
    ridge(b, horizonY, unit * 0.34, 3.2, 4.1, kit.mix(p('mountainColor'), p('skyBottom'), 0.45), 0);
    ridge(b, horizonY, unit * 0.24, 2.4, 11.7, p('mountainColor'), 0.55);
    // Mist pooling at the foot of the mountains.
    const mist = b.createLinearGradient(0, horizonY - H * 0.07, 0, horizonY);
    mist.addColorStop(0, kit.rgba(p('skyBottom'), 0));
    mist.addColorStop(1, kit.rgba(p('skyBottom'), 0.3));
    b.fillStyle = mist;
    b.fillRect(0, horizonY - H * 0.07, W, H * 0.07 + 1);

    // The floor: gradient, sun reflection and the static converging lines.
    const fh = H - horizonY;
    floor = kit.layer(W, fh);
    const f = floor.ctx;
    kit.vGradient(f, 0, 0, W, fh, [[0, kit.mix(p('groundColor'), p('skyBottom'), 0.35)], [0.25, p('groundColor')], [1, p('groundColor')]]);
    if (p('sun')) {
      const rg = f.createRadialGradient(sunX, 0, 0, sunX, 0, W * 0.4);
      rg.addColorStop(0, kit.rgba(p('sunBottom'), 0.22));
      rg.addColorStop(1, kit.rgba(p('sunBottom'), 0));
      f.fillStyle = rg;
      f.fillRect(0, 0, W, fh);
    }

    const lines = kit.layer(W, fh);
    const l = lines.ctx;
    l.strokeStyle = p('gridColor');
    const spread = W * 0.09;
    const half = Math.ceil(W / spread * 1.6);
    const drawVerticals = () => {
      l.beginPath();
      for (let i = -half; i <= half; i++) {
        l.moveTo(W / 2 + i * spread * 0.06, 0);
        l.lineTo(W / 2 + i * spread * 1.6, fh);
      }
      l.stroke();
    };
    l.lineWidth = 4;
    l.globalAlpha = 0.18;
    l.filter = 'blur(3px)';
    drawVerticals();
    l.filter = 'none';
    l.lineWidth = 1;
    l.globalAlpha = 0.55;
    drawVerticals();
    l.globalAlpha = 1;
    // Fade the lines out into the distance.
    l.globalCompositeOperation = 'destination-in';
    const fade = l.createLinearGradient(0, 0, 0, fh);
    fade.addColorStop(0, 'rgba(0, 0, 0, 0.05)');
    fade.addColorStop(0.35, 'rgba(0, 0, 0, 0.6)');
    fade.addColorStop(1, 'rgba(0, 0, 0, 1)');
    l.fillStyle = fade;
    l.fillRect(0, 0, W, fh);
    l.globalCompositeOperation = 'source-over';
    f.drawImage(lines.canvas, 0, 0);
  }
  build();

  function render(time) {
    ctx.drawImage(back.canvas, 0, 0);
    for (const s of stars) {
      ctx.fillStyle = `rgba(255, 240, 255, ${s.a * (0.6 + 0.4 * Math.sin(time * s.speed + s.phase))})`;
      ctx.fillRect(s.x, s.y, s.r, s.r);
    }

    ctx.drawImage(floor.canvas, 0, horizonY);

    // Horizontal grid lines: evenly spaced in depth, so perspective packs
    // them toward the horizon. One cell every ~8 s at speed 1.
    const fh = H - horizonY;
    const scroll = (time * 0.12 * p('gridSpeed')) % 1;
    const camera = fh * 0.9;
    ctx.strokeStyle = p('gridColor');
    for (let i = 0; i < ROWS; i++) {
      const z = i + 1 - scroll; // distance, 0 = at the viewer
      if (z <= 0.05) continue;
      const y = horizonY + camera / (z + 0.9);
      if (y > H + 2) continue;
      const k = (y - horizonY) / fh; // 0 at horizon, 1 at the bottom
      const a = Math.min(1, k * 1.6) * 0.55;
      ctx.globalAlpha = a * 0.3;
      ctx.lineWidth = 3 + k * 3;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      ctx.globalAlpha = a;
      ctx.lineWidth = 0.8 + k * 0.9;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // A thin glowing horizon line.
    ctx.fillStyle = kit.rgba(p('gridColor'), 0.5);
    ctx.fillRect(0, horizonY - 0.5, W, 1);
    kit.vGradient(ctx, 0, horizonY - 6, W, 12, [[0, kit.rgba(p('gridColor'), 0)], [0.5, kit.rgba(p('gridColor'), 0.16)], [1, kit.rgba(p('gridColor'), 0)]]);
  }

  return {
    resize(width, height) { W = width; H = height; build(); },
    render,
    destroy() { back = null; floor = null; stars = []; },
  };
}

module.exports = { id: 'synthwave', params, create };
