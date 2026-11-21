/**
 * Aurora - northern lights over snowy mountains and a frozen lake: a starry
 * sky, slow undulating curtains of light, snow-capped ranges and the faint
 * mirror of it all on the ice.
 *
 * The curtains are drawn as one-pixel columns of a pre-rendered gradient
 * sprite into a quarter-resolution buffer, which is then upscaled (the
 * smoothing gives the soft glow for free) and mirrored onto the lake.
 */
const kit = require('./_kit');

const params = [
  { key: 'skyTop', type: 'color', default: '#060a1c' },
  { key: 'skyBottom', type: 'color', default: '#22385c' },
  { key: 'auroraA', type: 'color', default: '#5ef2b4' },
  { key: 'auroraB', type: 'color', default: '#9a7cff' },
  { key: 'mountainColor', type: 'color', default: '#18233d' },
  { key: 'snowColor', type: 'color', default: '#c9d8ee' },
  { key: 'intensity', type: 'range', min: 0, max: 1.5, step: 0.05, default: 0.9 },
  { key: 'speed', type: 'range', min: 0.1, max: 2, step: 0.05, default: 0.6 },
  { key: 'stars', type: 'range', min: 0, max: 1, step: 0.05, default: 0.6 },
];

const DOWN = 4; // aurora buffer downscale

/** kit.mix() as a hex string, so it can feed kit.rgba(). */
function mixHex(a, b, t) {
  const m = kit.mix(a, b, t).match(/\d+/g).map(Number);
  return '#' + m.map((v) => v.toString(16).padStart(2, '0')).join('');
}
const SPRITE_H = 128;

function create(ctx, env) {
  const p = kit.paramReader(params, env.params);
  const fbm = kit.makeFbm(kit.seeded(31), 5);
  const ridgeFbm = kit.makeFbm(kit.seeded(47), 6);
  const noise = kit.makeNoise(kit.seeded(53));
  const rayNoise = kit.makeNoise(kit.seeded(61));
  let W = env.width;
  let H = env.height;
  let horizonY = 0;
  let back = null;
  let front = null;
  let fore = null;
  let aur = null;
  let spriteA = null;
  let spriteB = null;
  let twinkles = [];
  let curtains = [];

  function makeSprite(low, high) {
    const sp = kit.layer(1, SPRITE_H);
    const g = sp.ctx.createLinearGradient(0, 0, 0, SPRITE_H);
    // Top fades into the sky in the upper colour; the lower edge is the
    // brightest part, with a short soft tail below it so it never reads as a
    // hard silhouette.
    g.addColorStop(0, kit.rgba(high, 0));
    g.addColorStop(0.28, kit.rgba(high, 0.2));
    g.addColorStop(0.48, kit.rgba(mixHex(high, low, 0.5), 0.4));
    g.addColorStop(0.64, kit.rgba(low, 0.7));
    g.addColorStop(0.83, kit.rgba(mixHex(low, '#ffffff', 0.3), 1));
    g.addColorStop(0.9, kit.rgba(low, 0.35));
    g.addColorStop(1, kit.rgba(low, 0));
    sp.ctx.fillStyle = g;
    sp.ctx.fillRect(0, 0, 1, SPRITE_H);
    return sp;
  }

  // Height of a mountain range at x: tall at the edges, low in the centre.
  function ridge(x, seed, base, height, scale) {
    const u = x / W;
    const edge = 0.3 + 0.7 * Math.pow(Math.abs(u * 2 - 1), 1.25);
    const n = ridgeFbm(x / scale + seed) * 0.5 + 0.5;
    const peaks = Math.pow(Math.abs(ridgeFbm(x / (scale * 0.45) + seed * 2.3)), 1.4);
    return base - (n * 0.75 + peaks * 0.5) * height * edge;
  }

  function paintRange(c, seed, base, height, scale, fill, snow, snowAmount, lightAlpha) {
    const step = 2;
    const ys = [];
    for (let x = -step; x <= W + step; x += step) ys.push(ridge(x, seed, base, height, scale));
    // Silhouette.
    c.fillStyle = fill;
    c.beginPath();
    c.moveTo(-step, H);
    for (let i = 0; i < ys.length; i++) c.lineTo(-step + i * step, ys[i]);
    c.lineTo(W + step, H);
    c.closePath();
    c.fill();
    // Snow caps: a smooth-edged mantle on the high ground, shaded on the
    // slopes facing away from the light (which comes from the upper left).
    let minY = Infinity;
    for (const y of ys) minY = Math.min(minY, y);
    const span = Math.max(1, base - minY);
    const bottoms = ys.map((y, i) => {
      const x = -step + i * step;
      const elev = (base - y) / span;
      const cover = Math.max(0, elev - 0.32) / 0.68;
      const jag = 0.75 + 0.25 * noise(x / 11 + seed * 3) + 0.2 * noise(x / 37 + seed);
      return y + span * snowAmount * cover * jag;
    });
    c.save();
    c.beginPath();
    c.moveTo(-step, ys[0]);
    for (let i = 0; i < ys.length; i++) c.lineTo(-step + i * step, ys[i]);
    for (let i = ys.length - 1; i >= 0; i--) c.lineTo(-step + i * step, bottoms[i]);
    c.closePath();
    const sg = c.createLinearGradient(0, minY, 0, base);
    sg.addColorStop(0, kit.rgba(snow, lightAlpha));
    sg.addColorStop(1, kit.rgba(snow, lightAlpha * 0.5));
    c.fillStyle = sg;
    c.fill();
    c.clip();
    // Shadow: the silhouette shifted right covers every slope that falls
    // away from the light, leaving lit bands on the slopes that face it.
    const d = Math.max(6, scale * 0.12);
    c.globalAlpha = 0.6;
    c.fillStyle = fill;
    c.beginPath();
    c.moveTo(-step, H);
    c.lineTo(-step, ys[0] + d * 0.15);
    for (let i = 0; i < ys.length; i++) c.lineTo(-step + i * step + d, ys[i] + d * 0.15);
    c.lineTo(W + d, H);
    c.lineTo(W + d, -H);
    c.lineTo(W, -H);
    c.lineTo(W, H);
    c.closePath();
    c.fill();
    c.globalAlpha = 1;
    c.restore();
    return ys;
  }

  function build() {
    horizonY = Math.round(H * 0.66);
    const skyTop = p('skyTop');
    const skyBottom = p('skyBottom');
    const mountain = p('mountainColor');
    const snow = p('snowColor');
    const rand = kit.seeded(7);

    // --- Back: sky, stars, horizon haze, lake ice ------------------------
    back = kit.layer(W, H);
    const b = back.ctx;
    kit.vGradient(b, 0, 0, W, horizonY, [[0, skyTop], [0.65, kit.mix(skyTop, skyBottom, 0.7)], [1, skyBottom]]);
    // A faint wash of aurora colour in the high sky.
    kit.glow(b, W * 0.22, horizonY * 0.35, W * 0.45, p('auroraA'), 0.06);
    kit.glow(b, W * 0.8, horizonY * 0.25, W * 0.4, p('auroraB'), 0.07);

    const count = Math.round((W * horizonY) / 2600 * p('stars'));
    twinkles = [];
    for (let i = 0; i < count; i++) {
      const x = rand() * W;
      const y = Math.pow(rand(), 1.3) * horizonY * 0.92;
      const r = rand() < 0.06 ? 1.5 : 0.5 + rand() * 0.8;
      const a = 0.2 + rand() * 0.55;
      if (r > 1.2 && twinkles.length < 70) {
        twinkles.push({ x, y, r, phase: rand() * Math.PI * 2, speed: 0.3 + rand() * 0.6 });
        kit.glow(b, x, y, r * 4, '#ffffff', 0.08);
      } else {
        b.fillStyle = `rgba(255, 255, 255, ${a * (1 - 0.6 * y / horizonY)})`;
        b.fillRect(x, y, r, r);
      }
    }
    // Horizon haze.
    const hz = b.createLinearGradient(0, horizonY - H * 0.22, 0, horizonY);
    hz.addColorStop(0, kit.rgba(skyBottom, 0));
    hz.addColorStop(1, kit.rgba(mixHex(skyBottom, snow, 0.25), 0.45));
    b.fillStyle = hz;
    b.fillRect(0, horizonY - H * 0.22, W, H * 0.22);

    // Lake: a dark ice sheet, lighter towards the far shore.
    kit.vGradient(b, 0, horizonY, W, H - horizonY, [
      [0, kit.mix(skyBottom, mountain, 0.35)],
      [0.35, kit.mix(skyBottom, mountain, 0.7)],
      [1, kit.mix(mountain, '#000000', 0.25)],
    ]);

    // --- Front: mountains, their reflection, ice, snowy shore ------------
    front = kit.layer(W, H);
    const f = front.ctx;
    const farFill = kit.mix(mountain, skyBottom, 0.55);
    const far = kit.layer(W, H);
    paintRange(far.ctx, 3.7, horizonY + 1, H * 0.34, 340, farFill, snow, 0.32, 0.38);
    const near = kit.layer(W, H);
    paintRange(near.ctx, 9.1, horizonY + 1, H * 0.24, 220, mountain, snow, 0.38, 0.62);
    // Mist between the ranges.
    const mist = far.ctx.createLinearGradient(0, horizonY - H * 0.1, 0, horizonY);
    mist.addColorStop(0, kit.rgba(skyBottom, 0));
    mist.addColorStop(1, kit.rgba(skyBottom, 0.55));
    far.ctx.fillStyle = mist;
    far.ctx.fillRect(0, horizonY - H * 0.1, W, H * 0.1);

    f.drawImage(far.canvas, 0, 0);
    f.drawImage(near.canvas, 0, 0);

    // Reflection: the ranges mirrored about the horizon, squashed and dimmed.
    f.save();
    f.beginPath();
    f.rect(0, horizonY, W, H - horizonY);
    f.clip();
    f.globalAlpha = 0.55;
    f.translate(0, horizonY * 2 + 1);
    f.scale(1, -1);
    f.drawImage(far.canvas, 0, 0, W, horizonY + 1, 0, 0, W, horizonY + 1);
    f.drawImage(near.canvas, 0, 0, W, horizonY + 1, 0, 0, W, horizonY + 1);
    f.restore();
    // Fade the reflection out with a veil of ice colour.
    const veil = f.createLinearGradient(0, horizonY, 0, H);
    const iceTone = mixHex(skyBottom, mountain, 0.6);
    veil.addColorStop(0, kit.rgba(iceTone, 0));
    veil.addColorStop(0.45, kit.rgba(iceTone, 0.25));
    veil.addColorStop(1, kit.rgba(iceTone, 0.7));
    f.fillStyle = veil;
    f.fillRect(0, horizonY, W, H - horizonY);

    // Ice streaks: thin horizontal glints, longer towards the viewer.
    for (let i = 0; i < 70; i++) {
      const k = rand();
      const y = horizonY + 3 + Math.pow(k, 1.5) * (H - horizonY) * 0.85;
      const len = 20 + k * 220 * (0.4 + rand());
      const x = rand() * W;
      const g = f.createLinearGradient(x - len / 2, 0, x + len / 2, 0);
      const a = 0.05 + rand() * 0.09;
      g.addColorStop(0, kit.rgba(snow, 0));
      g.addColorStop(0.5, kit.rgba(snow, a));
      g.addColorStop(1, kit.rgba(snow, 0));
      f.fillStyle = g;
      f.fillRect(x - len / 2, y, len, 1);
    }
    // A thin bright line where ice meets the far shore.
    f.fillStyle = kit.rgba(snow, 0.18);
    f.fillRect(0, horizonY, W, 1);

    // --- Fore: snowy banks and pines, drawn over the ice's sheen ---------
    fore = kit.layer(W, H);
    const fc = fore.ctx;
    const bank = (fromLeft) => {
      const f = fc;
      f.beginPath();
      const x0 = fromLeft ? 0 : W;
      const dir = fromLeft ? 1 : -1;
      const reach = W * 0.34;
      const top = H * 0.86;
      f.moveTo(x0, H);
      f.lineTo(x0, top - H * 0.04);
      for (let s = 0; s <= 1.0001; s += 0.02) {
        const x = x0 + dir * reach * s;
        const y = top - H * 0.04 + (H - top + H * 0.06) * (1 - Math.cos(s * Math.PI / 2)) + fbm(s * 4 + (fromLeft ? 1 : 9)) * H * 0.01;
        f.lineTo(x, y);
      }
      f.lineTo(x0 + dir * reach, H);
      f.closePath();
      const g = f.createLinearGradient(0, top - H * 0.05, 0, H);
      g.addColorStop(0, kit.mix(snow, skyBottom, 0.45));
      g.addColorStop(1, kit.mix(snow, mountain, 0.7));
      f.fillStyle = g;
      f.fill();
    };
    bank(true);
    bank(false);

    // A few dark pines on the right bank.
    const pine = (x, baseY, h) => {
      const f = fc;
      f.fillStyle = kit.mix(mountain, '#000000', 0.35);
      const tiers = 6;
      for (let t = 0; t < tiers; t++) {
        const k = t / tiers;
        const w = h * 0.26 * (1 - k * 0.8);
        const y0 = baseY - h * k * 0.9;
        f.beginPath();
        f.moveTo(x - w, y0);
        f.lineTo(x, y0 - h * 0.3);
        f.lineTo(x + w, y0);
        f.closePath();
        f.fill();
      }
      f.fillRect(x - 1.5, baseY - 2, 3, h * 0.08 + 2);
    };
    pine(W * 0.93, H * 0.9, H * 0.2);
    pine(W * 0.965, H * 0.92, H * 0.15);
    pine(W * 0.885, H * 0.92, H * 0.11);
    pine(W * 0.05, H * 0.9, H * 0.13);

    // --- Aurora buffer and curtains --------------------------------------
    aur = kit.layer(Math.ceil(W / DOWN), Math.ceil(horizonY / DOWN));
    spriteA = makeSprite(p('auroraA'), p('auroraB'));
    spriteB = makeSprite(mixHex(p('auroraA'), p('auroraB'), 0.5), p('auroraB'));
    curtains = [
      { base: 0.56, amp: 0.34, freq: 1.6, h: 0.42, alpha: 1.25, seed: 1.3, sprite: spriteA, drift: 1, fold: 0.07, gap: 0.1 },
      { base: 0.4, amp: 0.3, freq: 2.2, h: 0.32, alpha: 0.8, seed: 7.9, sprite: spriteB, drift: -0.7, fold: 0.05, gap: -0.05 },
      { base: 0.7, amp: 0.22, freq: 1.1, h: 0.26, alpha: 0.75, seed: 4.4, sprite: spriteA, drift: 0.5, fold: 0.04, gap: -0.1 },
    ];
  }
  build();

  function drawAurora(time) {
    const a = aur.ctx;
    const bw = aur.canvas.width;
    const bh = aur.canvas.height;
    a.globalCompositeOperation = 'source-over';
    a.globalAlpha = 1;
    a.clearRect(0, 0, bw, bh);
    a.globalCompositeOperation = 'lighter';
    const t = time * p('speed');
    const intensity = p('intensity');
    for (const c of curtains) {
      const img = c.sprite.canvas;
      // Folds: columns are displaced sideways by slow noise, so where they
      // bunch up the curtain brightens like a pleat of light.
      let prevX = (fbm(c.seed * 3 + t * 0.02 * c.drift)) * bw * c.fold;
      for (let i = 0; i < bw; i++) {
        const xn = i / bw;
        const nextX = i + 1 + fbm((i + 1) / bw * 2.6 + c.seed * 3 + t * 0.02 * c.drift) * bw * c.fold;
        const x = prevX;
        const w = Math.abs(nextX - prevX);
        prevX = nextX;
        const patch = kit.clamp((fbm(xn * 2.1 + c.seed * 2 - t * 0.015 * c.drift) + 0.06 - c.gap) * 2.6, 0, 1);
        if (patch <= 0.01) continue;
        const edge = Math.min(1, xn * 5, (1 - xn) * 5);
        const centre = 1 - 0.3 * Math.exp(-Math.pow((xn - 0.5) / 0.14, 2));
        const rays = 0.5 + 0.5 * rayNoise(i * 0.45 + c.seed * 10 + t * 0.2 * c.drift);
        const bunch = Math.min(1.8, 1 / Math.max(0.35, w));
        const alpha = c.alpha * intensity * patch * edge * centre * (0.3 + 0.9 * rays) * bunch;
        if (alpha < 0.01) continue;
        const yb = (c.base + fbm(xn * c.freq + c.seed + t * 0.022 * c.drift) * c.amp) * bh + rays * 1.5;
        const h = c.h * bh * (0.6 + 0.6 * (noise(xn * 3.2 + c.seed * 5 + t * 0.035) * 0.5 + 0.5)) * (0.75 + 0.35 * rays);
        a.globalAlpha = Math.min(1, alpha);
        a.drawImage(img, 0, 0, 1, SPRITE_H, x, yb - h, Math.max(1, w), h);
      }
    }
    a.globalAlpha = 1;
    a.globalCompositeOperation = 'source-over';
  }

  function render(time) {
    ctx.drawImage(back.canvas, 0, 0);

    for (const st of twinkles) {
      const tw = 0.6 + 0.4 * Math.sin(time * st.speed + st.phase);
      ctx.fillStyle = `rgba(255, 255, 255, ${0.35 + tw * 0.55})`;
      ctx.fillRect(st.x, st.y, st.r, st.r);
    }

    drawAurora(time);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(aur.canvas, 0, 0, W, horizonY);
    ctx.restore();

    ctx.drawImage(front.canvas, 0, 0);

    // Mirror on the ice, squashed and faint, as a sheen over the reflections.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const k = 0.42;
    ctx.globalAlpha = 0.4;
    ctx.translate(0, horizonY * (1 + k));
    ctx.scale(1, -k);
    ctx.drawImage(aur.canvas, 0, 0, W, horizonY);
    ctx.restore();

    ctx.drawImage(fore.canvas, 0, 0);
  }

  return {
    resize(width, height) { W = width; H = height; build(); },
    render,
    destroy() { back = null; front = null; fore = null; aur = null; twinkles = []; curtains = []; },
  };
}

module.exports = { id: 'aurora', params, create };
