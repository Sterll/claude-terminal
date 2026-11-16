/**
 * Ocean - a calm sea under a moon (or a sun, by colours alone): twinkling
 * stars, a halo, distant islands, rolling swells in perspective and the moon's
 * shimmering path on the water.
 */
const kit = require('./_kit');

const params = [
  { key: 'skyTop', type: 'color', default: '#070b1f' },
  { key: 'skyBottom', type: 'color', default: '#1d2a55' },
  { key: 'waterTop', type: 'color', default: '#142048' },
  { key: 'waterBottom', type: 'color', default: '#04060f' },
  { key: 'moonColor', type: 'color', default: '#f4ecd2' },
  { key: 'islandColor', type: 'color', default: '#0a0f24' },
  { key: 'moon', type: 'toggle', default: true },
  { key: 'stars', type: 'range', min: 0, max: 1, step: 0.05, default: 0.6 },
  { key: 'waveSpeed', type: 'range', min: 0.1, max: 2, step: 0.05, default: 0.6 },
  { key: 'horizon', type: 'range', min: 0.35, max: 0.75, step: 0.01, default: 0.56 },
];

function create(ctx, env) {
  const p = kit.paramReader(params, env.params);
  const rand = kit.seeded(7);
  const fbm = kit.makeFbm(kit.seeded(11), 4);
  const shimmerNoise = kit.makeNoise(kit.seeded(23));
  let W = env.width;
  let H = env.height;
  let sky = null;
  let stars = [];

  function build() {
    const horizonY = H * p('horizon');
    sky = kit.layer(W, horizonY + 2);
    const s = sky.ctx;
    kit.vGradient(s, 0, 0, W, horizonY + 2, [[0, p('skyTop')], [1, p('skyBottom')]]);

    // Distant islands sitting on the horizon.
    s.fillStyle = p('islandColor');
    s.beginPath();
    s.moveTo(0, horizonY + 2);
    for (let x = 0; x <= W; x += 4) {
      const n = fbm(x / 260 + 3.1);
      const lift = Math.max(0, n - 0.05) * H * 0.16;
      s.lineTo(x, horizonY - lift);
    }
    s.lineTo(W, horizonY + 2);
    s.closePath();
    s.fill();

    const count = Math.round(W * H / 5200 * p('stars'));
    stars = [];
    for (let i = 0; i < count; i++) {
      stars.push({
        x: rand() * W,
        y: Math.pow(rand(), 1.6) * horizonY * 0.9,
        r: rand() < 0.08 ? 1.4 : 0.5 + rand() * 0.7,
        phase: rand() * Math.PI * 2,
        speed: 0.6 + rand() * 1.6,
      });
    }
  }
  build();

  function moonPos() {
    return { x: W * 0.72, y: H * p('horizon') * 0.38, r: Math.max(14, Math.min(W, H) * 0.045) };
  }

  function render(time) {
    const horizonY = H * p('horizon');
    ctx.drawImage(sky.canvas, 0, 0);

    for (const st of stars) {
      const tw = 0.55 + 0.45 * Math.sin(time * st.speed + st.phase);
      ctx.fillStyle = `rgba(255, 255, 255, ${0.25 + tw * 0.6})`;
      ctx.fillRect(st.x, st.y, st.r, st.r);
    }

    const moon = moonPos();
    if (p('moon')) {
      kit.glow(ctx, moon.x, moon.y, moon.r * 7, p('moonColor'), 0.18);
      kit.glow(ctx, moon.x, moon.y, moon.r * 2.4, p('moonColor'), 0.35);
      ctx.fillStyle = p('moonColor');
      ctx.beginPath();
      ctx.arc(moon.x, moon.y, moon.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Water body.
    kit.vGradient(ctx, 0, horizonY, W, H - horizonY, [[0, p('waterTop')], [1, p('waterBottom')]]);

    // Swells: rows packed near the horizon and spreading towards the viewer.
    const speed = p('waveSpeed');
    const rows = 30;
    ctx.lineWidth = 1;
    for (let i = 0; i < rows; i++) {
      const k = i / rows;
      const depth = Math.pow(k, 1.9);
      const y = horizonY + depth * (H - horizonY) + 2;
      const amp = 0.6 + depth * 9;
      const wl = 30 + depth * 260;
      const drift = time * speed * (12 + depth * 40) * (i % 2 ? 1 : -0.6);
      ctx.strokeStyle = kit.rgba(p('moonColor'), 0.035 + depth * 0.07);
      ctx.beginPath();
      for (let x = -10; x <= W + 10; x += 10) {
        const yy = y + Math.sin((x + drift) / wl * Math.PI * 2 + i) * amp + fbm((x + drift) / 400 + i * 3) * amp;
        if (x === -10) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }

    // The moon's path: a soft column of light, then rounded glints on top that
    // widen towards the viewer and drift with the swell.
    if (p('moon')) {
      const col = ctx.createLinearGradient(moon.x - moon.r * 4, 0, moon.x + moon.r * 4, 0);
      col.addColorStop(0, kit.rgba(p('moonColor'), 0));
      col.addColorStop(0.5, kit.rgba(p('moonColor'), 0.07));
      col.addColorStop(1, kit.rgba(p('moonColor'), 0));
      ctx.fillStyle = col;
      ctx.fillRect(moon.x - moon.r * 4, horizonY, moon.r * 8, H - horizonY);
      ctx.lineCap = 'round';
      for (let i = 0; i < 54; i++) {
        const k = i / 54;
        const depth = Math.pow(k, 1.6);
        const y = horizonY + 3 + depth * (H - horizonY);
        const spread = moon.r * (0.8 + depth * 5);
        for (let j = 0; j < 2; j++) {
          const n = shimmerNoise(i * 1.7 + j * 9.1 + time * speed * 1.4);
          const w = spread * (0.15 + 0.45 * Math.abs(n));
          const x = moon.x + shimmerNoise(i * 3.1 + j * 5.3 - time * speed) * spread * 0.7;
          ctx.strokeStyle = kit.rgba(p('moonColor'), (0.55 - depth * 0.3) * (0.35 + 0.65 * Math.abs(n)));
          ctx.lineWidth = 0.8 + depth * 2.2;
          ctx.beginPath();
          ctx.moveTo(x - w / 2, y);
          ctx.lineTo(x + w / 2, y);
          ctx.stroke();
        }
      }
      ctx.lineCap = 'butt';
    }
  }

  return {
    resize(width, height) { W = width; H = height; build(); },
    render,
    destroy() { sky = null; stars = []; },
  };
}

module.exports = { id: 'ocean', params, create };
