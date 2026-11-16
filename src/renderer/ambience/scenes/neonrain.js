/**
 * Neon Rain - "rain outside, code inside". A pixel city at night: a skyline of
 * lit windows, vertical neon signs spelled in a 5x7 LED font, rain falling in
 * pixel streaks, the signs reflected and rippling on the wet street, and now
 * and then a soft flash of lightning behind the towers.
 *
 * Pixel-native: everything is drawn one tile at a time into a buffer of
 * cols x rows pixels, then blitted without smoothing. Under the pixel
 * renderer (env.cell) that buffer maps 1:1 onto the canvas and the CSS grid
 * draws the gaps; under the smooth renderer it is simply scaled up, still
 * crisp. The static city is built once per resize; a frame is a handful of
 * drawImage calls plus the raindrops.
 *
 * Lightning is deliberately soft (a slow double pulse at low intensity, at
 * most every ~20 s) so it never strobes; reduced motion freezes the scene on
 * a frame without it.
 */
const kit = require('./_kit');
const font = require('./_pixelfont');

const params = [
  { key: 'skyTop', type: 'color', default: '#0a0a22' },
  { key: 'skyBottom', type: 'color', default: '#3b1d52' },
  { key: 'farColor', type: 'color', default: '#2b2452' },
  { key: 'midColor', type: 'color', default: '#1c1838' },
  { key: 'nearColor', type: 'color', default: '#100e24' },
  { key: 'windowA', type: 'color', default: '#f7c66b' },
  { key: 'windowB', type: 'color', default: '#ff7fb2' },
  { key: 'windowC', type: 'color', default: '#7fd8ff' },
  { key: 'neonA', type: 'color', default: '#ff4f9a' },
  { key: 'neonB', type: 'color', default: '#4ff0ff' },
  { key: 'rainColor', type: 'color', default: '#9db2e6' },
  { key: 'flashColor', type: 'color', default: '#c9c4ff' },
  { key: 'signA', type: 'text', default: 'RAMEN' },
  { key: 'signB', type: 'text', default: 'HOTEL' },
  { key: 'signC', type: 'text', default: 'CODE' },
  { key: 'rain', type: 'range', min: 0, max: 1, step: 0.05, default: 0.45 },
  { key: 'windows', type: 'range', min: 0, max: 1, step: 0.05, default: 0.3 },
  { key: 'wind', type: 'range', min: -1, max: 1, step: 0.05, default: 0.25 },
  { key: 'lightning', type: 'toggle', default: true },
  { key: 'moon', type: 'toggle', default: false },
];

const DEFAULT_CELL = 6;

function create(ctx, env) {
  const p = kit.paramReader(params, env.params);
  const cell = env.cell || DEFAULT_CELL;
  let W = env.width;
  let H = env.height;
  let C = 1;
  let R = 1;
  let streetY = 1;
  let buf;
  let sky;
  let city;
  let glow;
  let drops = [];
  let windowsList = [];
  let toggled = [];
  let bolt = [];
  let nextFlash = 9;
  let flashStart = -10;
  let nextToggle = 4;
  const rgb = (hex) => kit.hexToRgb(hex);
  // Timing of window switches and lightning: seeded, so a session replays the same.
  const trand = kit.seeded(77);

  function build() {
    C = Math.max(40, Math.ceil(W / cell));
    R = Math.max(30, Math.ceil(H / cell));
    streetY = Math.round(R * 0.86);
    const rand = kit.seeded(31);
    buf = kit.layer(C, R);
    sky = kit.layer(C, R);
    city = kit.layer(C, R);
    glow = kit.layer(C, R);

    // ── Sky: a dithered gradient, the retro way (ordered 4x4 Bayer). ──
    const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const top = rgb(p('skyTop'));
    const bottom = rgb(p('skyBottom'));
    const img = sky.ctx.createImageData(C, R);
    const levels = 10;
    for (let y = 0; y < R; y++) {
      const t = Math.min(1, Math.pow(y / streetY, 1.6));
      for (let x = 0; x < C; x++) {
        const step = Math.floor(t * levels + BAYER[(y % 4) * 4 + (x % 4)] / 16) / levels;
        const k = Math.min(1, step);
        const i = (y * C + x) * 4;
        img.data[i] = top.r + (bottom.r - top.r) * k;
        img.data[i + 1] = top.g + (bottom.g - top.g) * k;
        img.data[i + 2] = top.b + (bottom.b - top.b) * k;
        img.data[i + 3] = 255;
      }
    }
    sky.ctx.putImageData(img, 0, 0);
    // A few faint stars between the clouds of rain.
    sky.ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (let i = 0; i < C * R / 260; i++) sky.ctx.fillRect(Math.floor(rand() * C), Math.floor(rand() * streetY * 0.5), 1, 1);
    if (p('moon')) {
      const mx = Math.round(C * 0.78);
      const my = Math.round(R * 0.16);
      const mr = Math.max(3, Math.round(Math.min(C, R) * 0.05));
      sky.ctx.fillStyle = kit.rgba(p('flashColor'), 0.12);
      for (let y = -mr * 3; y <= mr * 3; y++) for (let x = -mr * 3; x <= mr * 3; x++) {
        if (x * x + y * y <= mr * mr * 9 && (x + y) % 2 === 0) sky.ctx.fillRect(mx + x, my + y, 1, 1);
      }
      sky.ctx.fillStyle = kit.mix(p('flashColor'), '#ffffff', 0.4);
      for (let y = -mr; y <= mr; y++) for (let x = -mr; x <= mr; x++) if (x * x + y * y <= mr * mr) sky.ctx.fillRect(mx + x, my + y, 1, 1);
    }

    // ── City ──
    const g = city.ctx;
    g.clearRect(0, 0, C, R);
    windowsList = [];
    const winColors = [p('windowA'), p('windowA'), p('windowA'), p('windowB'), p('windowC')];

    function building(x, w, h, color, litChance, plan) {
      const y = streetY - h;
      g.fillStyle = color;
      g.fillRect(x, y, w, h);
      // A rooftop detail now and then: a water tank or an antenna.
      if (w > 6 && rand() < 0.35) g.fillRect(x + 2 + Math.floor(rand() * (w - 5)), y - 2, 2, 2);
      if (rand() < 0.25) g.fillRect(x + Math.floor(w / 2), y - 4, 1, 4);
      // Windows on a 2x3 rhythm, some clusters denser (a shop floor, a bar).
      const cluster = rand() < 0.22;
      const clusterColor = winColors[Math.floor(rand() * winColors.length)];
      for (let wy = y + 2; wy < streetY - 1; wy += 3) {
        for (let wx = x + 1; wx < x + w - 1; wx += 2) {
          if (plan && plan(wx, wy)) continue;
          const lit = rand() < litChance * (cluster ? 2.6 : 0.8);
          const color = cluster && rand() < 0.75 ? clusterColor : winColors[Math.floor(rand() * winColors.length)];
          windowsList.push({ x: wx, y: wy, color, lit, base: color });
          g.fillStyle = lit ? color : kit.mix(color, '#000000', 0.9);
          g.fillRect(wx, wy, 1, 1);
        }
      }
      return { x, y, w, h };
    }

    const lit = p('windows');
    // Far: a continuous skyline, dim.
    for (let x = -2; x < C;) {
      const w = 5 + Math.floor(rand() * 9);
      building(x, w, Math.round(R * (0.2 + rand() * 0.22)), p('farColor'), lit * 0.35);
      x += w;
    }
    // Mid: lower in the middle third, so the conversation column stays calm.
    for (let x = -3; x < C;) {
      const w = 6 + Math.floor(rand() * 10);
      const centre = Math.abs((x + w / 2) / C - 0.5) < 0.2;
      building(x, w, Math.round(R * (centre ? 0.08 + rand() * 0.1 : 0.14 + rand() * 0.18)), p('midColor'), lit * 0.7);
      x += w + (rand() < 0.3 ? 1 : 0);
    }

    // Near: tall towers framing both edges, each carrying a vertical sign.
    const signA = font.sanitizeSign(p('signA'));
    const signB = font.sanitizeSign(p('signB'));
    const signC = font.sanitizeSign(p('signC'));
    const sizeA = font.measure(signA, true);
    const sizeB = font.measure(signB, true);
    const leftW = Math.max(14, Math.round(C * 0.1));
    const rightW = Math.max(14, Math.round(C * 0.09));
    const leftH = Math.min(streetY - 4, Math.max(sizeA.h + 12, Math.round(R * 0.62)));
    const rightH = Math.min(streetY - 4, Math.max(sizeB.h + 12, Math.round(R * 0.56)));
    const plate = (bx, by, size) => (wx, wy) => wx >= bx - 2 && wx <= bx + size.w + 1 && wy >= by - 2 && wy <= by + size.h + 1;
    const aX = 3;
    const aY = streetY - leftH + 5;
    const bX = C - rightW + rightW - font.GLYPH_W - 4;
    const bY = streetY - rightH + 5;
    building(-1, leftW + 1, leftH, p('nearColor'), lit, plate(aX, aY, sizeA));
    building(C - rightW, rightW + 1, rightH, p('nearColor'), lit, plate(bX, bY, sizeB));
    // A low shop front just right of centre with a horizontal sign.
    const sizeC = font.measure(signC, false);
    const shopW = Math.max(sizeC.w + 8, 16);
    const shopX = Math.round(C * 0.62);
    const shopH = Math.round(R * 0.13);
    const cX = shopX + Math.round((shopW - sizeC.w) / 2);
    const cY = streetY - shopH + 3;
    building(shopX, shopW, shopH, p('nearColor'), lit * 0.6, plate(cX, cY, sizeC));

    // Sign plates and letters (letters also go to the glow layer).
    const gl = glow.ctx;
    gl.clearRect(0, 0, C, R);
    const drawSign = (text, sx, sy, vertical, color, size) => {
      if (!text) return;
      g.fillStyle = kit.mix(p('nearColor'), '#000000', 0.45);
      g.fillRect(sx - 2, sy - 2, size.w + 4, size.h + 4);
      g.fillStyle = kit.mix(color, '#000000', 0.55);
      g.fillRect(sx - 2, sy - 2, size.w + 4, 1);
      g.fillRect(sx - 2, sy + size.h + 1, size.w + 4, 1);
      g.fillStyle = color;
      gl.fillStyle = color;
      font.forEachPixel(text, sx, sy, vertical, (x, y) => { g.fillRect(x, y, 1, 1); gl.fillRect(x, y, 1, 1); });
    };
    drawSign(signA, aX, aY, true, p('neonA'), sizeA);
    drawSign(signB, bX, bY, true, p('neonB'), sizeB);
    drawSign(signC, cX, cY, false, p('windowA'), sizeC);
    // Soften the glow: blur the letters into a halo once, drawn additively.
    const halo = kit.layer(C, R);
    halo.ctx.filter = 'blur(2px)';
    halo.ctx.drawImage(glow.canvas, 0, 0);
    halo.ctx.filter = 'blur(5px)';
    halo.ctx.globalAlpha = 0.7;
    halo.ctx.drawImage(glow.canvas, 0, 0);
    glow = halo;

    // Street: dark, wet.
    g.fillStyle = kit.mix(p('nearColor'), '#000000', 0.35);
    g.fillRect(0, streetY, C, R - streetY);
    g.fillStyle = kit.mix(p('midColor'), '#000000', 0.2);
    g.fillRect(0, streetY, C, 1);

    // Rain.
    const count = Math.round((C * R / 95) * p('rain'));
    drops = [];
    for (let i = 0; i < count; i++) {
      drops.push({ x: rand() * C, y: rand() * R, len: 2 + Math.floor(rand() * 3), speed: 26 + rand() * 26, depth: rand() });
    }

    // Lightning bolt path, fixed per size so it is not a new shape each time.
    bolt = [];
    let bx = Math.round(C * (0.18 + rand() * 0.15));
    for (let y = 0; y < R * 0.38; y++) {
      bolt.push([bx, y]);
      if (rand() < 0.45) bx += rand() < 0.5 ? -1 : 1;
      if (y > R * 0.12 && rand() < 0.05) {
        let bx2 = bx;
        for (let k = 0; k < 6; k++) { bx2 += 1; bolt.push([bx2, y + k]); }
      }
    }
    toggled = [];
  }
  build();

  /** Flash envelope in [0, 1]: two soft pulses over ~1.2 s. */
  function flashAt(dt) {
    if (dt < 0 || dt > 1.2) return 0;
    const pulse = (c, w) => Math.max(0, 1 - Math.abs(dt - c) / w);
    return Math.max(pulse(0.12, 0.18), 0.7 * pulse(0.55, 0.3));
  }

  function render(time) {
    const b = buf.ctx;
    b.globalCompositeOperation = 'source-over';
    b.globalAlpha = 1;
    b.drawImage(sky.canvas, 0, 0);

    // Lightning behind the towers.
    if (p('lightning')) {
      if (time >= nextFlash && time - flashStart > 2) {
        flashStart = time;
        nextFlash = time + 20 + trand() * 25;
      }
      const f = flashAt(time - flashStart);
      if (f > 0) {
        b.globalAlpha = 0.16 * f;
        b.fillStyle = p('flashColor');
        b.fillRect(0, 0, C, streetY);
        b.globalAlpha = Math.min(1, f * 1.2);
        b.fillStyle = kit.mix(p('flashColor'), '#ffffff', 0.5);
        for (const [x, y] of bolt) b.fillRect(x, y, 1, 1);
        b.globalAlpha = 1;
      }
    }

    b.drawImage(city.canvas, 0, 0);

    // Windows switching on and off, slowly, a few at a time.
    if (time >= nextToggle && windowsList.length) {
      const w = windowsList[Math.floor(trand() * windowsList.length)];
      w.lit = !w.lit;
      toggled.push(w);
      if (toggled.length > 60) toggled.shift();
      nextToggle = time + 1.5 + trand() * 2.5;
    }
    for (const w of toggled) {
      b.fillStyle = w.lit ? w.base : kit.mix(w.base, '#000000', 0.9);
      b.fillRect(w.x, w.y, 1, 1);
    }

    // Neon glow, breathing gently; sign B stutters for a beat now and then.
    b.globalCompositeOperation = 'lighter';
    b.globalAlpha = 0.55 + 0.12 * Math.sin(time * 1.3);
    b.drawImage(glow.canvas, 0, 0);
    b.globalAlpha = 1;
    b.globalCompositeOperation = 'source-over';

    // Reflections on the wet street: the scene above, mirrored and rippling.
    const depth = R - streetY;
    for (let i = 1; i < depth; i++) {
      const src = streetY - i * 1.6;
      if (src < 0) break;
      const off = Math.round(Math.sin(time * 1.8 + i * 0.9) * (0.4 + i * 0.12));
      b.globalAlpha = 0.32 * (1 - i / depth);
      b.drawImage(buf.canvas, 0, Math.floor(src), C, 1, off, streetY + i, C, 1);
    }
    b.globalAlpha = 1;

    // Rain: one path per brightness, so ~3 fills per frame whatever the count.
    const slant = p('wind') * 0.5;
    const heads = new globalThis.Path2D();
    const tails = new globalThis.Path2D();
    for (const d of drops) {
      const y = (d.y + time * d.speed) % (R + 6) - 3;
      const x = ((d.x + y * slant) % C + C) % C;
      heads.rect(Math.round(x), Math.round(y), 1, 1);
      for (let k = 1; k < d.len; k++) tails.rect(Math.round(x - k * slant), Math.round(y - k), 1, 1);
      // Splash where a drop meets the street.
      if (y > streetY + 1 + d.depth * (depth - 2) && y < streetY + 3 + d.depth * (depth - 2)) {
        heads.rect(Math.round(x) - 1, Math.round(y), 1, 1);
        heads.rect(Math.round(x) + 1, Math.round(y), 1, 1);
      }
    }
    b.fillStyle = kit.rgba(p('rainColor'), 0.22);
    b.fill(tails);
    b.fillStyle = kit.rgba(p('rainColor'), 0.5);
    b.fill(heads);

    // Blit: crisp at any renderer.
    const smoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buf.canvas, 0, 0, C * cell, R * cell);
    ctx.imageSmoothingEnabled = smoothing;
  }

  return {
    resize(width, height) { W = width; H = height; build(); },
    render,
    destroy() { drops = []; windowsList = []; toggled = []; bolt = []; },
  };
}

module.exports = { id: 'neonrain', params, create };
