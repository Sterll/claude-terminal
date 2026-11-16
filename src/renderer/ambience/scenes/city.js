/**
 * City - a skyline at night seen from a rooftop: three depths of buildings
 * whose windows now and then switch on or off (slowly), a moon behind thin
 * drifting clouds, an elevated train gliding past and tiny car lights on the
 * avenue below.
 */
const kit = require('./_kit');

const params = [
  { key: 'skyTop', type: 'color', default: '#141936' },
  { key: 'skyBottom', type: 'color', default: '#463562' },
  { key: 'horizonGlow', type: 'color', default: '#e39a86' },
  { key: 'farColor', type: 'color', default: '#3a3560' },
  { key: 'midColor', type: 'color', default: '#252444' },
  { key: 'nearColor', type: 'color', default: '#13132a' },
  { key: 'windowColor', type: 'color', default: '#ffc982' },
  { key: 'moonColor', type: 'color', default: '#f4e8c8' },
  { key: 'cloudColor', type: 'color', default: '#8d7fb0' },
  { key: 'moon', type: 'toggle', default: true },
  { key: 'traffic', type: 'toggle', default: true },
  { key: 'windows', type: 'range', min: 0, max: 1, step: 0.05, default: 0.35 },
  { key: 'clouds', type: 'range', min: 0, max: 1, step: 0.05, default: 0.5 },
];

const TAU = Math.PI * 2;
const MAX_TOGGLERS = 48;

/** Integer hash to [0, 1): stateless per-window coin flips. */
function hash01(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

function glowSprite(color, size = 64) {
  const l = kit.layer(size, size);
  kit.glow(l.ctx, size / 2, size / 2, size / 2, color, 1);
  return l.canvas;
}

function create(ctx, env) {
  const p = kit.paramReader(params, env.params);
  const fbm = kit.makeFbm(kit.seeded(19), 3);
  const warmLight = glowSprite('#fff1d6');
  const redLight = glowSprite('#ff5a4a');
  const winLight = glowSprite(p('windowColor'));
  let W = env.width;
  let H = env.height;
  let S = 1;
  let sky = null;
  let far = null;
  let mid = null;
  let near = null;
  let cloudSprites = [];
  let clouds = [];
  let togglers = [];
  let beacons = [];
  let cars = [];
  let trackY = 0;
  let roadY = 0;

  function buildingWindows(c, rand, x, top, w, bottom, cfg, depth) {
    const cw = cfg.winW * S;
    const ch = cfg.winH * S;
    const gx = cw * cfg.gapX;
    const gy = ch * cfg.gapY;
    const cols = Math.max(1, Math.floor((w - gx) / (cw + gx)));
    const ox = x + (w - cols * (cw + gx) + gx) / 2;
    const unlit = kit.mix(cfg.color, p('windowColor'), 0.07);
    const zone = rand(); // whole floors / columns tend to be lit together
    // Fewer lights behind the chat column (the near towers are at the edges anyway).
    const calm = 0.4 + 0.6 * Math.abs((x + w / 2) / W - 0.5) * 2;
    for (let wy = top + gy * 1.6; wy + ch < bottom - gy; wy += ch + gy) {
      const floorLit = rand() < 0.18 ? 0.5 : 0;
      for (let i = 0; i < cols; i++) {
        const wx = ox + i * (cw + gx);
        if (togglers.length < MAX_TOGGLERS && rand() < cfg.toggle) {
          c.fillStyle = unlit;
          c.fillRect(wx, wy, cw, ch);
          togglers.push({ x: wx, y: wy, w: cw, h: ch, depth, unlit, alpha: cfg.alpha, period: 30 + rand() * 70, offset: rand() * 200, id: togglers.length * 31 + 7 });
          continue;
        }
        const lit = rand() < (p('windows') * (0.6 + zone * 0.8) + floorLit) * calm;
        if (lit) {
          c.globalAlpha = cfg.alpha * (0.55 + rand() * 0.45);
          c.fillStyle = rand() < 0.12 ? kit.mix(p('windowColor'), '#ffffff', 0.45) : p('windowColor');
          c.fillRect(wx, wy, cw, ch);
          c.globalAlpha = 1;
        } else {
          c.fillStyle = unlit;
          c.fillRect(wx, wy, cw, ch);
        }
      }
    }
  }

  /** A row of buildings across the width; `heightAt(x)` gives the top. */
  function skyline(c, rand, cfg, depth) {
    let x = -rand() * 30 * S;
    while (x < W) {
      const w = (cfg.minW + rand() * (cfg.maxW - cfg.minW)) * S;
      const top = cfg.heightAt(x + w / 2, rand);
      c.fillStyle = cfg.color;
      c.fillRect(x, top, w, cfg.base - top);
      // Rooftop furniture: setbacks, tanks, antennas.
      const r = rand();
      if (r < 0.25) {
        c.fillRect(x + w * 0.2, top - 10 * S * cfg.detail, w * 0.6, 10 * S * cfg.detail + 1);
      } else if (r < 0.4) {
        const ax = x + w * (0.3 + rand() * 0.4);
        c.fillRect(ax, top - 26 * S * cfg.detail, Math.max(1, 1.5 * S), 26 * S * cfg.detail);
      } else if (r < 0.52) {
        const tx = x + w * (0.15 + rand() * 0.5);
        const tw = 12 * S * cfg.detail;
        c.fillRect(tx, top - tw * 1.1, tw, tw * 1.1);
        c.beginPath();
        c.moveTo(tx - 1, top - tw * 1.1);
        c.lineTo(tx + tw / 2, top - tw * 1.6);
        c.lineTo(tx + tw + 1, top - tw * 1.1);
        c.fill();
      }
      buildingWindows(c, rand, x + 2 * S, top, w - 4 * S, cfg.base, cfg, depth);
      x += w + (rand() < 0.3 ? rand() * 14 * S : 0);
    }
  }

  function build() {
    const rand = kit.seeded(3);
    S = Math.max(0.6, Math.min(W, H) / 860);
    togglers = [];
    beacons = [];

    // Sky, stars, moon, horizon glow.
    sky = kit.layer(W, H);
    const s = sky.ctx;
    kit.vGradient(s, 0, 0, W, H, [[0, p('skyTop')], [0.6, p('skyBottom')], [1, kit.mix(p('skyBottom'), p('horizonGlow'), 0.35)]]);
    const hg = s.createLinearGradient(0, H * 0.35, 0, H);
    hg.addColorStop(0, kit.rgba(p('horizonGlow'), 0));
    hg.addColorStop(1, kit.rgba(p('horizonGlow'), 0.32));
    s.fillStyle = hg;
    s.fillRect(0, 0, W, H);
    const starCount = Math.round(W * H / 6500);
    for (let i = 0; i < starCount; i++) {
      const y = Math.pow(rand(), 1.5) * H * 0.55;
      s.fillStyle = `rgba(255, 255, 255, ${(0.2 + rand() * 0.55) * (1 - y / (H * 0.6))})`;
      const r = rand() < 0.06 ? 1.6 : 0.6 + rand() * 0.6;
      s.fillRect(rand() * W, y, r, r);
    }
    if (p('moon')) {
      const mx = W * 0.8;
      const my = H * 0.2;
      const mr = Math.max(14, Math.min(W, H) * 0.048);
      kit.glow(s, mx, my, mr * 8, p('moonColor'), 0.14);
      kit.glow(s, mx, my, mr * 2.6, p('moonColor'), 0.3);
      s.fillStyle = p('moonColor');
      s.beginPath();
      s.arc(mx, my, mr, 0, TAU);
      s.fill();
      // A few soft maria.
      s.globalAlpha = 0.09;
      s.fillStyle = p('skyBottom');
      for (const [dx, dy, rr] of [[-0.3, -0.2, 0.32], [0.25, 0.1, 0.24], [-0.05, 0.38, 0.18]]) {
        s.beginPath();
        s.arc(mx + dx * mr, my + dy * mr, rr * mr, 0, TAU);
        s.fill();
      }
      s.globalAlpha = 1;
    }

    // Clouds: a few long soft wisps, drifting.
    cloudSprites = [];
    clouds = [];
    const cloudCount = Math.round(p('clouds') * 6);
    for (let i = 0; i < cloudCount; i++) {
      const cw = (260 + rand() * 320) * S;
      const ch = cw * 0.22;
      const l = kit.layer(cw, ch);
      for (let k = 0; k < 14; k++) {
        const t = k / 13;
        const bx = cw * (0.12 + t * 0.76);
        const by = ch * (0.55 + Math.sin(t * 5 + i) * 0.12);
        const br = ch * (0.22 + Math.sin(t * Math.PI) * 0.3 + rand() * 0.1);
        l.ctx.save();
        l.ctx.translate(bx, by);
        l.ctx.scale(1.9, 1);
        kit.glow(l.ctx, 0, 0, br, p('cloudColor'), 0.16);
        l.ctx.restore();
      }
      cloudSprites.push(l.canvas);
      clouds.push({ w: cw, h: ch, x: rand() * W, y: H * (0.06 + rand() * 0.34), speed: (2 + rand() * 4) * S, a: 0.5 + rand() * 0.5 });
    }

    // Far skyline: low, hazy, lots of tiny windows.
    const edge = (x) => Math.abs(x / W - 0.5) * 2;
    far = kit.layer(W, H);
    skyline(far.ctx, rand, {
      color: p('farColor'), base: H, minW: 24, maxW: 60, detail: 0.6,
      winW: 2.2, winH: 3, gapX: 1.4, gapY: 1.2, alpha: 0.45, toggle: 0.004,
      heightAt: (x, r) => H * (0.6 - r() * 0.13 - fbm(x / 300) * 0.06 - edge(x) * 0.05),
    }, 0);
    const haze = far.ctx.createLinearGradient(0, H * 0.4, 0, H * 0.85);
    haze.addColorStop(0, kit.rgba(p('horizonGlow'), 0.1));
    haze.addColorStop(1, kit.rgba(p('horizonGlow'), 0.22));
    far.ctx.globalCompositeOperation = 'source-atop';
    far.ctx.fillStyle = haze;
    far.ctx.fillRect(0, 0, W, H);
    far.ctx.globalCompositeOperation = 'source-over';

    // Mid skyline + the elevated track and the avenue below it.
    mid = kit.layer(W, H);
    const m = mid.ctx;
    trackY = H * 0.79;
    roadY = H * 0.9;
    skyline(m, rand, {
      color: p('midColor'), base: roadY, minW: 40, maxW: 90, detail: 0.85,
      winW: 3.2, winH: 4.4, gapX: 1.2, gapY: 1.0, alpha: 0.7, toggle: 0.01,
      heightAt: (x, r) => H * (0.7 - r() * 0.12 - edge(x) * edge(x) * 0.2),
    }, 1);
    // Street glow rising up the facades.
    const street = m.createLinearGradient(0, H * 0.5, 0, roadY);
    street.addColorStop(0, kit.rgba(p('horizonGlow'), 0));
    street.addColorStop(1, kit.rgba(p('horizonGlow'), 0.16));
    m.globalCompositeOperation = 'source-atop';
    m.fillStyle = street;
    m.fillRect(0, H * 0.5, W, roadY - H * 0.5);
    m.globalCompositeOperation = 'source-over';
    m.fillStyle = kit.mix(p('midColor'), p('nearColor'), 0.5);
    m.fillRect(0, trackY, W, 5 * S);
    for (let x = 30 * S; x < W; x += 120 * S) m.fillRect(x, trackY, 6 * S, roadY - trackY);
    kit.vGradient(m, 0, roadY, W, H - roadY, [[0, kit.mix(p('nearColor'), p('horizonGlow'), 0.16)], [1, p('nearColor')]]);

    // Near: tall towers framing the edges, a rooftop ledge in the middle.
    near = kit.layer(W, H);
    const n = near.ctx;
    const nearCfg = {
      color: p('nearColor'), winW: 5, winH: 7, gapX: 1.0, gapY: 0.8, alpha: 0.9, toggle: 0.02,
    };
    const towers = [
      [-0.01, 0.1, 0.3], [0.09, 0.17, 0.52], [0.84, 0.92, 0.42], [0.91, 1.01, 0.22],
    ];
    for (const [a, b, top] of towers) {
      const x = W * a;
      const w = W * (b - a);
      const ty = H * top;
      n.fillStyle = p('nearColor');
      n.fillRect(x, ty, w, H - ty);
      n.fillRect(x + w * 0.45, ty - 40 * S, 2 * S, 40 * S);
      beacons.push({ x: x + w * 0.45 + S, y: ty - 40 * S, phase: rand() * TAU });
      // A faint rim of sky light on the side facing the centre.
      n.fillStyle = kit.rgba(p('horizonGlow'), 0.08);
      n.fillRect(a < 0.5 ? x + w - 2 * S : x, ty, 2 * S, H - ty);
      buildingWindows(n, rand, x + 4 * S, ty, w - 8 * S, H, nearCfg, 2);
    }
    // Rooftop ledge with a water tank and a vent, the viewer's own roof.
    const ledge = H * 0.95;
    n.fillStyle = p('nearColor');
    n.fillRect(0, ledge, W, H - ledge);
    n.fillStyle = kit.rgba(p('horizonGlow'), 0.1);
    n.fillRect(0, ledge, W, Math.max(1, S));
    n.fillStyle = p('nearColor');
    const tx = W * 0.24;
    const tw = 46 * S;
    n.fillRect(tx, ledge - tw * 1.2, tw, tw * 1.2);
    n.beginPath();
    n.moveTo(tx - 3 * S, ledge - tw * 1.2);
    n.lineTo(tx + tw / 2, ledge - tw * 1.65);
    n.lineTo(tx + tw + 3 * S, ledge - tw * 1.2);
    n.fill();
    n.fillRect(tx + tw * 0.1, ledge - tw * 1.2, 3 * S, tw * 1.2 + 4);
    n.fillRect(W * 0.72, ledge - 18 * S, 30 * S, 18 * S);
    n.fillRect(W * 0.72 + 12 * S, ledge - 34 * S, 6 * S, 16 * S);

    // Traffic on the avenue.
    cars = [];
    for (let i = 0; i < 9; i++) {
      const dir = i % 2 ? 1 : -1;
      cars.push({
        dir,
        speed: (14 + rand() * 18) * S,
        offset: rand() * 5000,
        y: roadY + (dir > 0 ? 0.35 : 0.6) * (H * 0.95 - roadY),
      });
    }
  }
  build();

  function drawTogglers(depth, time) {
    for (const t of togglers) {
      if (t.depth !== depth) continue;
      const u = (time + t.offset) / t.period;
      const cycle = Math.floor(u);
      const local = (u - cycle) * t.period;
      const lit = p('windows') + 0.15;
      const now = hash01(t.id, cycle) < lit ? 1 : 0;
      const before = hash01(t.id, cycle - 1) < lit ? 1 : 0;
      const a = kit.lerp(before, now, kit.smooth(Math.min(1, local / 2.5)));
      if (a <= 0.01) continue;
      ctx.globalAlpha = a * t.alpha;
      ctx.fillStyle = p('windowColor');
      ctx.fillRect(t.x, t.y, t.w, t.h);
    }
    ctx.globalAlpha = 1;
  }

  function render(time) {
    ctx.drawImage(sky.canvas, 0, 0);

    for (let i = 0; i < clouds.length; i++) {
      const c = clouds[i];
      const span = W + c.w;
      const x = ((c.x + time * c.speed) % span + span) % span - c.w;
      ctx.globalAlpha = c.a;
      ctx.drawImage(cloudSprites[i], x, c.y);
    }
    ctx.globalAlpha = 1;

    ctx.drawImage(far.canvas, 0, 0);
    drawTogglers(0, time);
    ctx.drawImage(mid.canvas, 0, 0);
    drawTogglers(1, time);

    if (p('traffic')) {
      // The train: one pass every 70 s, about 40 s to cross.
      const len = Math.max(220, W * 0.3);
      const period = 70;
      const k = ((time + 18) % period) / 40;
      if (k < 1) {
        const x = -len + k * (W + len);
        const cars = 5;
        const cl = len / cars;
        const th = 12 * S;
        const y = trackY - th - 1;
        for (let i = 0; i < cars; i++) {
          const cx = x + i * cl;
          ctx.fillStyle = kit.mix(p('midColor'), p('nearColor'), 0.6);
          ctx.fillRect(cx + 1, y, cl - 3, th);
          ctx.fillStyle = kit.rgba(p('windowColor'), 0.75);
          ctx.fillRect(cx + 4, y + th * 0.25, cl - 9, th * 0.32);
        }
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.25;
        ctx.drawImage(winLight, x - 10, y - th, len + 20, th * 3);
        ctx.globalAlpha = 0.6;
        ctx.drawImage(warmLight, x + len - 10 * S, y - 6 * S, 24 * S, 24 * S);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      ctx.globalCompositeOperation = 'lighter';
      for (const c of cars) {
        const span = W + 200;
        const x = ((c.offset + time * c.speed * c.dir) % span + span) % span - 100;
        const sprite = c.dir > 0 ? redLight : warmLight;
        const r = (c.dir > 0 ? 7 : 9) * S;
        ctx.globalAlpha = c.dir > 0 ? 0.55 : 0.7;
        ctx.drawImage(sprite, x - r, c.y - r, r * 2, r * 2);
        ctx.drawImage(sprite, x + 6 * S - r, c.y - r, r * 2, r * 2);
        // Short soft streak behind, like a long exposure.
        ctx.globalAlpha = 0.18;
        ctx.drawImage(sprite, c.dir > 0 ? x - 40 * S : x, c.y - r * 0.4, 40 * S, r * 0.8);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.drawImage(near.canvas, 0, 0);
    drawTogglers(2, time);

    // Aviation beacons: a slow red breath, never a blink.
    ctx.globalCompositeOperation = 'lighter';
    for (const b of beacons) {
      ctx.globalAlpha = 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(time * TAU / 6 + b.phase));
      const r = 9 * S;
      ctx.drawImage(redLight, b.x - r, b.y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  return {
    resize(width, height) { W = width; H = height; build(); },
    render,
    destroy() { sky = far = mid = near = null; cloudSprites = []; clouds = []; togglers = []; cars = []; beacons = []; },
  };
}

module.exports = { id: 'city', params, create };
