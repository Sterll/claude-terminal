/**
 * Pixel art for the Claude companion: the body in several colours, its faces,
 * the accessories it can wear, and the props (heart, sparkle, ball, cookie).
 *
 * Everything is SVG rects on a 14x14 grid (the `assets/claude-mascot.svg`
 * sprite), so a face or a hat is a string swap, crisp at any scale. The
 * viewBox starts HAT_ROOM units above the head so hats have somewhere to go;
 * the sprite element is sized for that and overflows its box upwards.
 */

const GRID = 14;
const HAT_ROOM = 5;

const px = (x, y, w, h, fill) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;

const PALETTES = {
  orange: { body: '#d97706', light: '#f2a03d', dark: '#b45309', ink: '#451a03', shine: '#fff7ed' },
  blue: { body: '#3b82f6', light: '#93c5fd', dark: '#1d4ed8', ink: '#172554', shine: '#eff6ff' },
  green: { body: '#22c55e', light: '#86efac', dark: '#15803d', ink: '#052e16', shine: '#f0fdf4' },
  pink: { body: '#f472b6', light: '#fbcfe8', dark: '#db2777', ink: '#500724', shine: '#fdf2f8' },
  purple: { body: '#8b5cf6', light: '#c4b5fd', dark: '#6d28d9', ink: '#2e1065', shine: '#f5f3ff' },
  ghost: { body: '#e5e7eb', light: '#ffffff', dark: '#9ca3af', ink: '#1f2937', shine: '#ffffff' },
  night: { body: '#334155', light: '#64748b', dark: '#1e293b', ink: '#e0f2fe', shine: '#38bdf8' },
};
const BLUSH = '#fb7185';

const EYES = {
  open: (c, [lx, ly]) =>
    `<g class="ctc-eyes-open">${px(4 + lx, 5 + ly, 2, 2, c.ink)}${px(8 + lx, 5 + ly, 2, 2, c.ink)}</g>` +
    `<g class="ctc-eyes-blink">${px(4, 6, 2, 1, c.ink)}${px(8, 6, 2, 1, c.ink)}</g>`,
  happy: (c) =>
    px(4, 5, 2, 1, c.ink) + px(3, 6, 1, 1, c.ink) + px(6, 6, 1, 1, c.ink) +
    px(8, 5, 2, 1, c.ink) + px(7, 6, 1, 1, c.ink) + px(10, 6, 1, 1, c.ink),
  closed: (c) => px(4, 6, 2, 1, c.ink) + px(8, 6, 2, 1, c.ink),
  wide: (c) =>
    px(4, 4, 2, 3, c.ink) + px(8, 4, 2, 3, c.ink) + px(4, 4, 1, 1, c.shine) + px(8, 4, 1, 1, c.shine),
  dizzy: (c) =>
    px(4, 5, 1, 1, c.ink) + px(5, 6, 1, 1, c.ink) + px(5, 4, 1, 1, c.ink) + px(3, 6, 1, 1, c.ink) +
    px(9, 5, 1, 1, c.ink) + px(8, 6, 1, 1, c.ink) + px(8, 4, 1, 1, c.ink) + px(10, 6, 1, 1, c.ink),
};

const MOUTHS = {
  neutral: (c) => px(5, 8, 4, 1, c.ink),
  smile: (c) => px(4, 8, 1, 1, c.ink) + px(5, 9, 4, 1, c.ink) + px(9, 8, 1, 1, c.ink),
  open: (c) => px(6, 8, 2, 2, c.ink),
  small: (c) => px(6, 9, 2, 1, c.ink),
  wavy: (c) => px(4, 9, 1, 1, c.ink) + px(5, 8, 1, 1, c.ink) + px(6, 9, 1, 1, c.ink) + px(7, 8, 1, 1, c.ink) + px(8, 9, 1, 1, c.ink) + px(9, 8, 1, 1, c.ink),
  yawn: (c) => px(5, 8, 4, 2, c.ink) + px(6, 9, 2, 1, BLUSH),
};

/** Face for each mood: [eyes, mouth, blush]. */
const FACES = {
  idle: ['open', 'neutral', false],
  walk: ['open', 'neutral', false],
  happy: ['happy', 'smile', true],
  held: ['wide', 'open', false],
  air: ['wide', 'smile', false],
  dizzy: ['dizzy', 'wavy', false],
  sleep: ['closed', 'small', false],
  sleepHappy: ['closed', 'smile', true],
  working: ['open', 'small', false],
  waiting: ['wide', 'open', false],
  done: ['happy', 'smile', true],
  breathe: ['closed', 'small', false],
  breatheIn: ['closed', 'open', false],
  stretch: ['closed', 'smile', false],
  chase: ['open', 'smile', false],
  chomp: ['happy', 'open', true],
  chew: ['happy', 'small', true],
  yawn: ['closed', 'yawn', false],
};

/** Accessories, drawn over the face. y < 0 is above the head. */
const ACCESSORIES = {
  none: () => '',
  party: () =>
    px(6, -4, 2, 1, '#fde047') + px(6, -3, 2, 1, '#a855f7') + px(5, -2, 4, 1, '#facc15') +
    px(5, -1, 4, 1, '#a855f7') + px(4, 0, 6, 1, '#facc15') + px(4, 1, 6, 1, '#a855f7'),
  crown: () =>
    px(3, -2, 1, 1, '#facc15') + px(6, -2, 2, 1, '#facc15') + px(10, -2, 1, 1, '#facc15') +
    px(3, -1, 8, 2, '#facc15') + px(4, 1, 6, 1, '#ca8a04') +
    px(5, 0, 1, 1, '#ef4444') + px(8, 0, 1, 1, '#38bdf8') + px(6, -1, 1, 1, '#fef9c3'),
  headphones: () =>
    px(3, -1, 8, 1, '#1f2937') + px(2, 0, 1, 1, '#1f2937') + px(11, 0, 1, 1, '#1f2937') +
    px(1, 1, 1, 3, '#1f2937') + px(12, 1, 1, 3, '#1f2937') +
    px(0, 4, 2, 4, '#1f2937') + px(12, 4, 2, 4, '#1f2937') +
    px(1, 5, 1, 2, '#ef4444') + px(12, 5, 1, 2, '#ef4444'),
  flower: () =>
    px(11, -1, 1, 1, '#f472b6') + px(10, 0, 1, 1, '#f472b6') + px(12, 0, 1, 1, '#f472b6') +
    px(11, 1, 1, 1, '#f472b6') + px(11, 0, 1, 1, '#fde047') + px(12, 1, 1, 1, '#22c55e'),
  beanie: () =>
    px(6, -3, 2, 2, '#fecaca') + px(4, -1, 6, 1, '#ef4444') + px(3, 0, 8, 1, '#ef4444') +
    px(2, 1, 10, 1, '#ef4444') + px(2, 2, 10, 1, '#b91c1c') + px(4, 0, 1, 1, '#f87171'),
  shades: () =>
    px(3, 5, 3, 2, '#111827') + px(8, 5, 3, 2, '#111827') + px(6, 5, 2, 1, '#111827') +
    px(3, 5, 1, 1, '#6b7280') + px(8, 5, 1, 1, '#6b7280'),
  bow: () =>
    px(3, 0, 2, 2, '#f472b6') + px(5, 0, 1, 1, '#db2777') + px(6, 0, 2, 2, '#f472b6') +
    px(3, 0, 1, 1, '#fbcfe8') + px(6, 0, 1, 1, '#fbcfe8'),
};

/**
 * @param {string} mood   a FACES key (unknown falls back to idle)
 * @param {[number, number]} look  pupil offset, -1..1 each
 * @param {{ color?: string, hat?: string }} [style]
 * @param {number} [scale]  CSS px per sprite pixel
 */
function spriteSvg(mood, look = [0, 0], style = {}, scale = 5) {
  const c = PALETTES[style.color] || PALETTES.orange;
  const [eyes, mouth, blush] = FACES[mood] || FACES.idle;
  const accessory = (ACCESSORIES[style.hat] || ACCESSORIES.none)();
  const body =
    px(2, 1, 2, 2, c.body) + px(10, 1, 2, 2, c.body) + px(3, 2, 8, 1, c.body) + px(2, 3, 10, 9, c.body) +
    px(3, 3, 2, 1, c.light) + px(2, 4, 1, 2, c.light) + px(2, 11, 10, 1, c.dark) +
    `<g class="ctc-foot ctc-foot-l">${px(3, 12, 2, 1, c.body)}</g>` +
    `<g class="ctc-foot ctc-foot-r">${px(9, 12, 2, 1, c.body)}</g>`;
  const h = GRID + HAT_ROOM;
  return `<svg viewBox="0 ${-HAT_ROOM} ${GRID} ${h}" width="${GRID * scale}" height="${h * scale}" shape-rendering="crispEdges" aria-hidden="true">` +
    body + EYES[eyes](c, look) + MOUTHS[mouth](c) + (blush ? px(3, 8, 1, 1, BLUSH) + px(10, 8, 1, 1, BLUSH) : '') + accessory +
    '</svg>';
}

const HEART_SVG = `<svg viewBox="0 0 7 6" width="21" height="18" shape-rendering="crispEdges" aria-hidden="true">${
  px(1, 0, 2, 1, BLUSH) + px(4, 0, 2, 1, BLUSH) + px(0, 1, 7, 2, BLUSH) + px(1, 3, 5, 1, BLUSH) + px(2, 4, 3, 1, BLUSH) + px(3, 5, 1, 1, BLUSH) + px(1, 1, 1, 1, '#fff7ed')
}</svg>`;

const SPARK_SVG = `<svg viewBox="0 0 5 5" width="15" height="15" shape-rendering="crispEdges" aria-hidden="true">${
  px(2, 0, 1, 5, '#fde68a') + px(0, 2, 5, 1, '#fde68a') + px(2, 2, 1, 1, '#ffffff')
}</svg>`;

const CRUMB_SVG = `<svg viewBox="0 0 2 2" width="6" height="6" shape-rendering="crispEdges" aria-hidden="true">${px(0, 0, 2, 2, '#b7793a')}</svg>`;

const BALL_SIZE = 22;
const BALL_SVG = `<svg viewBox="0 0 11 11" width="${BALL_SIZE}" height="${BALL_SIZE}" shape-rendering="crispEdges" aria-hidden="true">${
  px(3, 0, 5, 1, '#2563eb') + px(1, 1, 9, 2, '#3b82f6') + px(0, 3, 11, 5, '#3b82f6') + px(1, 8, 9, 2, '#2563eb') + px(3, 10, 5, 1, '#1d4ed8') +
  px(0, 5, 11, 1, '#f8fafc') + px(5, 0, 1, 11, '#f8fafc') + px(2, 2, 2, 1, '#bfdbfe')
}</svg>`;

const COOKIE_SIZE = 24;
const COOKIE_SVG = `<svg viewBox="0 0 8 8" width="${COOKIE_SIZE}" height="${COOKIE_SIZE}" shape-rendering="crispEdges" aria-hidden="true">${
  px(2, 0, 4, 1, '#c98b4b') + px(1, 1, 6, 1, '#d99a58') + px(0, 2, 8, 4, '#d99a58') + px(1, 6, 6, 1, '#b7793a') + px(2, 7, 4, 1, '#9a6230') +
  px(2, 2, 1, 1, '#4a2511') + px(5, 1, 1, 1, '#4a2511') + px(4, 4, 1, 1, '#4a2511') + px(1, 4, 1, 1, '#4a2511') + px(6, 4, 1, 1, '#4a2511') +
  px(2, 1, 1, 1, '#f1c27d')
}</svg>`;

module.exports = {
  GRID, HAT_ROOM, PALETTES, ACCESSORIES, FACES,
  spriteSvg, HEART_SVG, SPARK_SVG, CRUMB_SVG, BALL_SVG, BALL_SIZE, COOKIE_SVG, COOKIE_SIZE,
};
