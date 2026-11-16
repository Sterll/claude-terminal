/**
 * Rain - a rainy window at night: the city melts into soft bokeh behind the
 * glass, slow breathing lights, thin rain slanting in the distance and a few
 * drops on the pane that now and then let go and slide down, leaving a trail.
 */
const kit = require('./_kit');

const params = [
  { key: 'bgTop', type: 'color', default: '#161b3a' },
  { key: 'bgBottom', type: 'color', default: '#33264a' },
  { key: 'bokeh1', type: 'color', default: '#ffaa66' },
  { key: 'bokeh2', type: 'color', default: '#ff7096' },
  { key: 'bokeh3', type: 'color', default: '#6cb8ff' },
  { key: 'rainColor', type: 'color', default: '#cfdcff' },
  { key: 'rainDensity', type: 'range', min: 0, max: 1, step: 0.05, default: 0.55 },
  { key: 'wind', type: 'range', min: -1, max: 1, step: 0.05, default: 0.35 },
  { key: 'droplets', type: 'toggle', default: true },
];

const TAU = Math.PI * 2;
const SLIDERS = 7;

/** A soft lens disc: flat body, slightly brighter rim, feathered edge. */
function bokehSprite(color) {
  const S = 128;
  const l = kit.layer(S, S);
  const g = l.ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, kit.rgba(color, 0.55));
  g.addColorStop(0.62, kit.rgba(color, 0.62));
  g.addColorStop(0.8, kit.rgba(color, 0.5));
  g.addColorStop(1, kit.rgba(color, 0));
  l.ctx.fillStyle = g;
  l.ctx.fillRect(0, 0, S, S);
  return l.canvas;
}

/** A water drop on glass: lit rim at the bottom, a highlight, a faint shadow. */
function dropSprite(color) {
  const S = 48;
  const l = kit.layer(S, S);
  const c = l.ctx;
  const r = S * 0.36;
  const cx = S / 2;
  const cy = S / 2;
  // Contact shadow, offset up-left.
  c.fillStyle = 'rgba(0, 0, 0, 0.22)';
  c.beginPath();
  c.arc(cx - 1.5, cy - 1.5, r * 1.02, 0, TAU);
  c.fill();
  // Body: refracting the city, lighter towards the lower rim.
  const g = c.createRadialGradient(cx, cy - r * 0.35, r * 0.1, cx, cy, r);
  g.addColorStop(0, kit.rgba(color, 0.05));
  g.addColorStop(0.7, kit.rgba(color, 0.16));
  g.addColorStop(1, kit.rgba(color, 0.42));
  c.fillStyle = g;
  c.beginPath();
  c.arc(cx, cy, r, 0, TAU);
  c.fill();
  // Specular highlight.
  c.fillStyle = kit.rgba('#ffffff', 0.75);
  c.beginPath();
  c.arc(cx - r * 0.35, cy - r * 0.4, r * 0.2, 0, TAU);
  c.fill();
  return l.canvas;
}

function create(ctx, env) {
  const p = kit.paramReader(params, env.params);
  const noise = kit.makeNoise(kit.seeded(41));
  const bokehColors = [p('bokeh1'), p('bokeh2'), p('bokeh3')];
  const sprites = bokehColors.map(bokehSprite);
  const drop = dropSprite(p('rainColor'));
  let W = env.width;
  let H = env.height;
  let bg = null;
  let glass = null;
  let lights = [];
  let streaks = [];
  let sliders = [];

  /** Weight that keeps the busiest light away from the chat column. */
  function edgeBias(x) {
    const d = Math.abs(x / W - 0.5) * 2;
    return 0.45 + 0.55 * d;
  }

  function build() {
    const rand = kit.seeded(5);

    // Background: the night, with the far city pre-blurred into it.
    bg = kit.layer(W, H);
    const b = bg.ctx;
    const scale = Math.min(W, H) / 860;
    kit.vGradient(b, 0, 0, W, H, [[0, p('bgTop')], [0.5, kit.mix(p('bgTop'), p('bgBottom'), 0.55)], [1, p('bgBottom')]]);

    // Out-of-focus towers: dark masses with a grid of warm windows, blurred.
    const city = kit.layer(W, H);
    const c = city.ctx;
    const towerTone = kit.mix(p('bgTop'), '#000000', 0.45);
    let x = -20 * scale;
    while (x < W) {
      const w = (60 + rand() * 120) * scale;
      const mid = Math.abs((x + w / 2) / W - 0.5) * 2;
      const h = H * (0.22 + rand() * 0.28 + mid * 0.22);
      const top = H - h;
      c.fillStyle = towerTone;
      c.globalAlpha = 0.55 + rand() * 0.3;
      c.fillRect(x, top, w, h);
      const lit = 0.25 + rand() * 0.35;
      const cell = 14 * scale;
      for (let wy = top + cell; wy < H - cell; wy += cell) {
        for (let wx = x + cell * 0.6; wx < x + w - cell * 0.6; wx += cell) {
          if (rand() > lit) continue;
          c.globalAlpha = 0.5 + rand() * 0.5;
          c.fillStyle = rand() < 0.8 ? p('bokeh1') : bokehColors[1 + ((rand() * 2) | 0)];
          c.fillRect(wx, wy, cell * 0.45, cell * 0.55);
        }
      }
      x += w + (rand() * 30 - 8) * scale;
    }
    c.globalAlpha = 1;
    b.filter = `blur(${Math.max(4, 10 * scale)}px)`;
    b.globalAlpha = 0.85;
    b.drawImage(city.canvas, 0, 0);
    b.filter = 'none';
    b.globalAlpha = 1;

    // A warm haze where the street would be.
    const haze = b.createRadialGradient(W * 0.5, H * 1.1, 0, W * 0.5, H * 1.1, Math.max(W, H) * 0.7);
    haze.addColorStop(0, kit.rgba(p('bokeh1'), 0.28));
    haze.addColorStop(1, kit.rgba(p('bokeh1'), 0));
    b.fillStyle = haze;
    b.fillRect(0, 0, W, H);

    // Far lights: small discs, mostly in the lower half.
    const farCount = Math.round(W * H / 9000);
    b.globalCompositeOperation = 'lighter';
    for (let i = 0; i < farCount; i++) {
      const fx = rand() * W;
      const fy = H * (0.35 + Math.pow(rand(), 0.6) * 0.7);
      const r = (5 + rand() * 16) * scale * (0.6 + 0.6 * (fy / H));
      b.globalAlpha = (0.1 + rand() * 0.3) * edgeBias(fx);
      b.drawImage(sprites[(rand() * 3) | 0], fx - r, fy - r, r * 2, r * 2);
    }
    // A string of street lamps along the lower third.
    for (let i = 0; i < 12; i++) {
      const lx = (i + 0.2 + rand() * 0.6) / 12 * W;
      const ly = H * (0.76 + rand() * 0.04) + Math.sin(i * 0.9) * H * 0.015;
      const r = (16 + rand() * 10) * scale;
      b.globalAlpha = 0.45 * edgeBias(lx);
      b.drawImage(sprites[0], lx - r, ly - r, r * 2, r * 2);
    }
    b.globalAlpha = 1;
    b.globalCompositeOperation = 'source-over';

    // Vignette, as if looking out from a dim room.
    const v = b.createRadialGradient(W / 2, H * 0.5, Math.min(W, H) * 0.35, W / 2, H * 0.5, Math.hypot(W, H) * 0.62);
    v.addColorStop(0, 'rgba(0, 0, 0, 0)');
    v.addColorStop(1, 'rgba(4, 4, 12, 0.4)');
    b.fillStyle = v;
    b.fillRect(0, 0, W, H);

    // Breathing lights: bigger, closer discs drawn each frame.
    lights = [];
    const lightCount = Math.max(10, Math.round(W * H / 50000));
    for (let i = 0; i < lightCount; i++) {
      let lx = rand() * W;
      if (rand() < 0.6) lx = rand() < 0.5 ? rand() * W * 0.28 : W - rand() * W * 0.28;
      const ly = H * (0.28 + Math.pow(rand(), 0.7) * 0.78);
      const bright = rand() < 0.3;
      lights.push({
        x: lx,
        y: ly,
        r: (bright ? 22 + rand() * 26 : 40 + rand() * 60) * scale,
        c: (rand() * 3) | 0,
        a: (bright ? 0.4 + rand() * 0.2 : 0.14 + rand() * 0.16) * edgeBias(lx),
        phase: rand() * TAU,
        freq: TAU / (18 + rand() * 30),
        vx: rand() < 0.25 ? (rand() < 0.5 ? -1 : 1) * (2 + rand() * 4) * scale : 0,
      });
    }

    // Distant rain streaks.
    streaks = [];
    const streakCount = Math.round(W * H / 5000 * p('rainDensity'));
    for (let i = 0; i < streakCount; i++) {
      streaks.push({
        x: rand() * (W + 400) - 200,
        y: rand() * H,
        len: (12 + rand() * 30) * scale,
        speed: (260 + rand() * 260) * scale,
        bucket: (rand() * 3) | 0,
      });
    }

    // The glass: static drops, sparser over the chat column.
    glass = null;
    sliders = [];
    if (p('droplets')) {
      glass = kit.layer(W, H);
      const g = glass.ctx;
      const dropCount = Math.round(W * H / 3200);
      for (let i = 0; i < dropCount; i++) {
        const x = rand() * W;
        const y = rand() * H;
        if (rand() > edgeBias(x)) continue;
        const r = (rand() < 0.1 ? 3 + rand() * 3 : 0.8 + rand() * 2) * Math.max(0.7, scale);
        g.globalAlpha = 0.5 + rand() * 0.5;
        g.drawImage(drop, x - r * 1.4, y - r * 1.4, r * 2.8, r * 2.8);
      }
      g.globalAlpha = 1;
      for (let i = 0; i < SLIDERS; i++) {
        sliders.push({ period: 16 + rand() * 16, offset: rand() * 40, seed: 101 + i * 977 });
      }
    }
  }
  build();

  function drawSlider(s, time) {
    const t = time + s.offset;
    const cycle = Math.floor(t / s.period);
    const local = t - cycle * s.period;
    const r = kit.seeded(s.seed + cycle * 7919);
    let x = r() * W;
    if (r() > edgeBias(x)) x = r() < 0.5 ? r() * W * 0.28 : W - r() * W * 0.28;
    const y0 = H * (0.04 + r() * 0.45);
    const size = (3.5 + r() * 2.5) * Math.max(0.8, Math.min(W, H) / 860);
    const hold = s.period * (0.25 + r() * 0.25);
    const wob = r() * 50;

    // Grow in gently, hold, then let go with a slow acceleration.
    let y = y0;
    let trail = 0;
    const a = Math.min(1, local / 3);
    if (local > hold) {
      const k = local - hold;
      y = y0 + 6 * k + 9 * k * k;
      trail = 1 - kit.smooth(kit.clamp(k / (s.period - hold), 0, 1));
    }
    const xAt = (yy) => x + noise((yy + wob) / 38) * 4;

    if (y > y0 + 2) {
      // Trail: thin wet path, brightest just behind the drop.
      ctx.lineWidth = Math.max(1, size * 0.45);
      ctx.lineCap = 'round';
      const g = ctx.createLinearGradient(0, y0, 0, y);
      g.addColorStop(0, kit.rgba(p('rainColor'), 0.05 * trail));
      g.addColorStop(1, kit.rgba(p('rainColor'), 0.22 * trail));
      ctx.strokeStyle = g;
      ctx.beginPath();
      ctx.moveTo(xAt(y0), y0);
      const end = Math.min(y, H + 10);
      for (let yy = y0 + 8; yy < end; yy += 8) ctx.lineTo(xAt(yy), yy);
      ctx.lineTo(xAt(end), end);
      ctx.stroke();
    }
    if (y < H + size * 2) {
      const d = size * 2.8;
      const stretch = y > y0 + 2 ? 1.25 : 1;
      ctx.globalAlpha = a;
      ctx.drawImage(drop, xAt(y) - d / 2, y - d * stretch / 2, d, d * stretch);
      ctx.globalAlpha = 1;
    }
  }

  function render(time) {
    ctx.drawImage(bg.canvas, 0, 0);

    // Close lights breathing slowly, a few drifting like distant traffic.
    ctx.globalCompositeOperation = 'lighter';
    for (const l of lights) {
      let x = l.x + l.vx * time;
      if (l.vx) {
        const span = W + l.r * 4;
        x = ((x + l.r * 2) % span + span) % span - l.r * 2;
      }
      const breath = 0.65 + 0.35 * Math.sin(time * l.freq + l.phase);
      ctx.globalAlpha = l.a * breath;
      ctx.drawImage(sprites[l.c], x - l.r, l.y - l.r, l.r * 2, l.r * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // Rain in the distance, three soft alpha buckets so it's three strokes.
    if (streaks.length) {
      const slant = p('wind') * 0.4;
      ctx.lineWidth = 1;
      ctx.lineCap = 'butt';
      for (let bkt = 0; bkt < 3; bkt++) {
        ctx.strokeStyle = kit.rgba(p('rainColor'), 0.07 + bkt * 0.05);
        ctx.beginPath();
        for (let i = 0; i < streaks.length; i++) {
          const s = streaks[i];
          if (s.bucket !== bkt) continue;
          const span = H + s.len;
          const y = ((s.y + time * s.speed) % span + span) % span - s.len;
          const x = s.x + y * slant;
          ctx.moveTo(x, y);
          ctx.lineTo(x + s.len * slant, y + s.len);
        }
        ctx.stroke();
      }
    }

    if (glass) {
      ctx.drawImage(glass.canvas, 0, 0);
      for (const s of sliders) drawSlider(s, time);
    }
  }

  return {
    resize(width, height) { W = width; H = height; build(); },
    render,
    destroy() { bg = null; glass = null; lights = []; streaks = []; sliders = []; },
  };
}

module.exports = { id: 'rain', params, create };
