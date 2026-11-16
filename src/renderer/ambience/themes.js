/**
 * Built-in app themes.
 *
 * A theme is data only, so the same shape serves the built-ins, the user's own
 * themes (settings.customThemes) and an imported JSON file:
 *
 *   {
 *     id, name,                  // name shown for custom themes; built-ins use i18n `ambience.theme.<id>`
 *     category,                  // gallery grouping, see CATEGORIES
 *     scene, sceneParams,        // scene id from ./scenes (null = no animated background)
 *     palette: { bg, surface, text, accent },   // everything else is derived (palette.js)
 *     glass: { panel, blur, scrim, sceneBlur }, // panel opacity 0..1, blur px, scrim 0..1, scene blur px
 *     terminal,                  // 'auto' (derived from the palette) or a terminal theme id
 *     sound,                     // default soundscape id (AmbientSound), or null
 *     render: { mode, cell },    // 'smooth' or 'pixel' (tiles of `cell` CSS px, 4..12)
 *     tagline,                   // a line shown above an empty conversation, in the accent colour
 *   }
 *
 * UI palettes stay dark even over a bright scene: the scrim tints the scene
 * towards `bg`, and the app's stylesheets still hold ~2,600 hard-coded colour
 * literals tuned for a dark surface, so a light UI would break more than it
 * pleases.
 */

const CLASSIC_ID = 'classic';

// Built-in themes use the pixel renderer unless their scene is meant to be soft (Minimal).
const CATEGORIES = ['classic', 'pixel', 'night', 'nature', 'cozy', 'dream', 'retro', 'minimal', 'custom'];

const DEFAULT_GLASS = { panel: 0.62, blur: 18, scrim: 0.42, sceneBlur: 0 };

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/**
 * Fill in and bound everything, so a hand-edited or imported theme can never
 * hand the engine NaN opacities or a missing palette.
 */
function normalizeTheme(t) {
  const glass = { ...DEFAULT_GLASS, ...(t.glass || {}) };
  return {
    id: String(t.id || ''),
    name: String(t.name || t.id || ''),
    category: CATEGORIES.includes(t.category) ? t.category : (t.custom ? 'custom' : 'minimal'),
    custom: !!t.custom,
    basedOn: t.basedOn || null,
    scene: t.scene || null,
    sceneParams: t.sceneParams && typeof t.sceneParams === 'object' ? { ...t.sceneParams } : {},
    palette: t.palette ? { ...t.palette } : null,
    glass: {
      panel: clampNum(glass.panel, 0.15, 1, DEFAULT_GLASS.panel),
      blur: clampNum(glass.blur, 0, 40, DEFAULT_GLASS.blur),
      scrim: clampNum(glass.scrim, 0, 0.9, DEFAULT_GLASS.scrim),
      sceneBlur: clampNum(glass.sceneBlur, 0, 20, DEFAULT_GLASS.sceneBlur),
    },
    terminal: t.terminal || 'auto',
    sound: t.sound || null,
    render: {
      mode: t.render?.mode === 'pixel' ? 'pixel' : 'smooth',
      cell: Math.round(clampNum(t.render?.cell, 4, 12, 6)),
    },
    tagline: typeof t.tagline === 'string' ? t.tagline.replace(/[\r\n]+/g, ' ').slice(0, 60) : '',
  };
}

const RAW = [
  { id: CLASSIC_ID, category: 'classic', scene: null, palette: null, terminal: 'claude', sound: null },

  // ── Pixel ──
  {
    id: 'neon-rain', category: 'pixel', scene: 'neonrain', sound: 'rain',
    render: { mode: 'pixel', cell: 6 },
    tagline: 'rain outside, code inside',
    palette: { bg: '#0b0a1d', surface: '#15132b', text: '#ece8ff', accent: '#ff6fa8' },
    glass: { panel: 0.6, blur: 16, scrim: 0.12, sceneBlur: 0 },
  },

  // ── Night ──
  {
    id: 'midnight-ocean', category: 'night', scene: 'ocean', sound: 'waves',
    render: { mode: 'pixel', cell: 6 },
    tagline: 'tide in, thoughts out',
    palette: { bg: '#070b1d', surface: '#0f1630', text: '#e4e9ff', accent: '#8ab4ff' },
    glass: { panel: 0.58, blur: 18, scrim: 0.38, sceneBlur: 0 },
  },
  {
    id: 'aurora-borealis', category: 'night', scene: 'aurora', sound: 'wind',
    render: { mode: 'pixel', cell: 6 },
    tagline: 'northern lights, quiet mind',
    palette: { bg: '#061019', surface: '#0c1c26', text: '#e2fbf3', accent: '#5ef2b4' },
    glass: { panel: 0.56, blur: 18, scrim: 0.36, sceneBlur: 0 },
  },
  {
    id: 'moonlit-forest', category: 'night', scene: 'forest', sound: 'night',
    render: { mode: 'pixel', cell: 6 },
    tagline: 'fireflies and focus',
    palette: { bg: '#0d1024', surface: '#161a33', text: '#ecebf7', accent: '#ffd27a' },
    glass: { panel: 0.6, blur: 18, scrim: 0.4, sceneBlur: 0 },
  },
  {
    id: 'starry-meadow', category: 'night', scene: 'meadow', sound: 'night',
    render: { mode: 'pixel', cell: 6 },
    tagline: 'under the stars, shipping',
    palette: { bg: '#0a0e26', surface: '#121836', text: '#e9e8ff', accent: '#d6e87a' },
    glass: { panel: 0.58, blur: 18, scrim: 0.36, sceneBlur: 0 },
  },
  {
    id: 'desert-night', category: 'night', scene: 'desert', sound: 'wind',
    render: { mode: 'pixel', cell: 6 },
    tagline: 'dunes, stars, deep work',
    palette: { bg: '#0d0b22', surface: '#171331', text: '#f1e9f5', accent: '#e8a0b4' },
    glass: { panel: 0.6, blur: 18, scrim: 0.4, sceneBlur: 0 },
  },
  {
    id: 'deep-space', category: 'night', scene: 'space', sound: 'space',
    render: { mode: 'pixel', cell: 6 },
    tagline: 'drifting through the build',
    palette: { bg: '#07071a', surface: '#10112b', text: '#eceeff', accent: '#a78bfa' },
    glass: { panel: 0.56, blur: 16, scrim: 0.34, sceneBlur: 0 },
  },

  // ── Nature (daylight) ──
  {
    id: 'lagoon', category: 'nature', scene: 'ocean', sound: 'waves',
    sceneParams: {
      skyTop: '#2b7bb9', skyBottom: '#9fd8e8', waterTop: '#3aa6b9', waterBottom: '#0b4a63',
      moonColor: '#fff6d8', islandColor: '#1d5a52', stars: 0, horizon: 0.5,
    },
    render: { mode: 'pixel', cell: 6 },
    tagline: 'clear water, clear code',
    palette: { bg: '#06222b', surface: '#0b303b', text: '#e3f7f8', accent: '#2dd4bf' },
    glass: { panel: 0.62, blur: 22, scrim: 0.52, sceneBlur: 0 },
  },
  {
    id: 'misty-morning', category: 'nature', scene: 'forest', sound: 'forest',
    sceneParams: {
      skyTop: '#8fa6c4', skyBottom: '#dfe3ea', moonColor: '#fff8e7', treeFar: '#93a3b8', treeNear: '#2c3a4a',
      fogColor: '#eef1f5', fireflyColor: '#fff6d0', fireflies: 0, stars: 0, moon: false, rays: true, fog: 0.8,
    },
    render: { mode: 'pixel', cell: 6 },
    tagline: 'fog outside, clarity inside',
    palette: { bg: '#121a24', surface: '#1b2633', text: '#eef2f7', accent: '#9cc3e6' },
    glass: { panel: 0.64, blur: 22, scrim: 0.55, sceneBlur: 0 },
  },
  {
    id: 'autumn-gold', category: 'nature', scene: 'autumn', sound: 'forest',
    render: { mode: 'pixel', cell: 6 },
    tagline: 'falling leaves, rising commits',
    palette: { bg: '#1a1018', surface: '#261824', text: '#fbeee6', accent: '#f0a04b' },
    glass: { panel: 0.62, blur: 20, scrim: 0.48, sceneBlur: 0 },
  },
  {
    id: 'dawn-meadow', category: 'nature', scene: 'meadow', sound: 'forest',
    sceneParams: {
      skyTop: '#5d6aa8', skyBottom: '#f0b9a6', horizonGlow: '#ffd3a8', milkyColor: '#ffffff', hillFar: '#7c79a8',
      hillNear: '#4d4a7a', grassColor: '#2a2a4a', grassTip: '#9a94c4', fireflyColor: '#fff0b0',
      stars: 0.15, fireflies: 0.2, milkyWay: false,
    },
    render: { mode: 'pixel', cell: 6 },
    tagline: 'first light, first commit',
    palette: { bg: '#171833', surface: '#222447', text: '#f4ecff', accent: '#ffb39a' },
    glass: { panel: 0.62, blur: 20, scrim: 0.5, sceneBlur: 0 },
  },
  {
    id: 'golden-dunes', category: 'nature', scene: 'desert', sound: 'wind',
    sceneParams: {
      skyTop: '#5b7fbf', skyBottom: '#f3c98b', horizonColor: '#f6b37a', orbColor: '#fff1c9', duneLight: '#e8b06a',
      duneShadow: '#9a5a34', caravanColor: '#5a3420', stars: 0,
    },
    render: { mode: 'pixel', cell: 6 },
    tagline: 'warm sand, warm builds',
    palette: { bg: '#1d130c', surface: '#2a1c12', text: '#fbefe1', accent: '#f2b35a' },
    glass: { panel: 0.64, blur: 22, scrim: 0.55, sceneBlur: 0 },
  },
  {
    id: 'snowy-day', category: 'nature', scene: 'snow', sound: 'wind',
    sceneParams: {
      skyTop: '#7fa6d6', skyBottom: '#e6eef8', mountainColor: '#9fb3d1', treeColor: '#2f4a5e', snowColor: '#ffffff',
      windowColor: '#ffd28a', density: 0.5,
    },
    render: { mode: 'pixel', cell: 6 },
    tagline: 'snow day, deep work',
    palette: { bg: '#101a2a', surface: '#18263a', text: '#f2f6fd', accent: '#7cc4ff' },
    glass: { panel: 0.64, blur: 22, scrim: 0.56, sceneBlur: 0 },
  },
  {
    id: 'deep-sea', category: 'nature', scene: 'underwater', sound: 'underwater',
    render: { mode: 'pixel', cell: 6 },
    tagline: 'deep dive mode',
    palette: { bg: '#041422', surface: '#082033', text: '#def6ff', accent: '#5ee0f0' },
    glass: { panel: 0.6, blur: 20, scrim: 0.42, sceneBlur: 0 },
  },

  // ── Cozy ──
  {
    id: 'rainy-window', category: 'cozy', scene: 'rain', sound: 'rain',
    render: { mode: 'pixel', cell: 6 },
    tagline: 'rain on the glass, code on the screen',
    palette: { bg: '#0f1024', surface: '#191a36', text: '#eceaff', accent: '#ffaa66' },
    glass: { panel: 0.58, blur: 18, scrim: 0.38, sceneBlur: 0 },
  },
  {
    id: 'tokyo-rain', category: 'cozy', scene: 'rain', sound: 'storm',
    sceneParams: {
      bgTop: '#140f2a', bgBottom: '#2a1036', bokeh1: '#ff4fa0', bokeh2: '#3fd6ff', bokeh3: '#b46bff',
      rainColor: '#d6c8ff', rainDensity: 0.75, wind: 0.2,
    },
    render: { mode: 'pixel', cell: 6 },
    tagline: 'neon puddles, green tests',
    palette: { bg: '#0d0a1f', surface: '#171230', text: '#f3eaff', accent: '#ff4fa0' },
    glass: { panel: 0.58, blur: 18, scrim: 0.4, sceneBlur: 0 },
  },
  {
    id: 'snowy-cabin', category: 'cozy', scene: 'snow', sound: 'fire',
    render: { mode: 'pixel', cell: 6 },
    tagline: 'cabin lights, compile nights',
    palette: { bg: '#0f1428', surface: '#181f3a', text: '#eef0fb', accent: '#ffbe6e' },
    glass: { panel: 0.6, blur: 18, scrim: 0.42, sceneBlur: 0 },
  },
  {
    id: 'campfire', category: 'cozy', scene: 'campfire', sound: 'fire',
    render: { mode: 'pixel', cell: 6 },
    tagline: 'stories by the fire',
    palette: { bg: '#120c0a', surface: '#1e1512', text: '#f8ece2', accent: '#ff9a4a' },
    glass: { panel: 0.58, blur: 18, scrim: 0.34, sceneBlur: 0 },
  },
  {
    id: 'lofi-city', category: 'cozy', scene: 'city', sound: 'lofi',
    render: { mode: 'pixel', cell: 6 },
    tagline: 'city hum, steady flow',
    palette: { bg: '#0e0f24', surface: '#181a36', text: '#efeaff', accent: '#ffc982' },
    glass: { panel: 0.58, blur: 18, scrim: 0.38, sceneBlur: 0 },
  },
  {
    id: 'cafe-dusk', category: 'cozy', scene: 'city', sound: 'cafe',
    sceneParams: {
      skyTop: '#2b2350', skyBottom: '#c4796f', horizonGlow: '#ffb27a', farColor: '#5a4170', midColor: '#3a2a52',
      nearColor: '#1c1530', windowColor: '#ffd08a', windows: 0.5, moon: false,
    },
    render: { mode: 'pixel', cell: 6 },
    tagline: 'one more coffee, one more fix',
    palette: { bg: '#17111f', surface: '#231a2e', text: '#fbeee8', accent: '#ffb27a' },
    glass: { panel: 0.6, blur: 20, scrim: 0.44, sceneBlur: 0 },
  },

  // ── Dream ──
  {
    id: 'sakura-dusk', category: 'dream', scene: 'sakura', sound: 'lofi',
    render: { mode: 'pixel', cell: 6 },
    tagline: 'petals fall, bugs too',
    palette: { bg: '#1a1224', surface: '#261a33', text: '#fdeef6', accent: '#f5b3c8' },
    glass: { panel: 0.62, blur: 20, scrim: 0.46, sceneBlur: 0 },
  },
  {
    id: 'dream-bokeh', category: 'dream', scene: 'bokeh', sound: 'lofi',
    render: { mode: 'pixel', cell: 6 },
    tagline: 'soft focus, sharp code',
    palette: { bg: '#120f22', surface: '#1d1830', text: '#f5ecf8', accent: '#e58fa8' },
    glass: { panel: 0.56, blur: 16, scrim: 0.32, sceneBlur: 0 },
  },
  {
    id: 'koi-pond', category: 'dream', scene: 'zen', sound: 'rain',
    render: { mode: 'pixel', cell: 6 },
    tagline: 'ripples and refactors',
    palette: { bg: '#0c1520', surface: '#132030', text: '#e8f0f5', accent: '#e3804f' },
    glass: { panel: 0.56, blur: 16, scrim: 0.3, sceneBlur: 0 },
  },
  {
    id: 'nebula-dream', category: 'dream', scene: 'space', sound: 'space',
    sceneParams: {
      background: '#120a24', nebulaA: '#c26bd8', nebulaB: '#ff8fb1', nebulaC: '#6a7cff', planet: false, nebula: 1.3,
    },
    render: { mode: 'pixel', cell: 6 },
    tagline: 'stardust and stack traces',
    palette: { bg: '#110a22', surface: '#1b1233', text: '#f7ecff', accent: '#ff8fb1' },
    glass: { panel: 0.56, blur: 16, scrim: 0.36, sceneBlur: 0 },
  },

  // ── Retro ──
  {
    id: 'synthwave', category: 'retro', scene: 'synthwave', sound: 'lofi',
    render: { mode: 'pixel', cell: 6 },
    tagline: 'drive into the build',
    palette: { bg: '#110c26', surface: '#1c1438', text: '#fbeaff', accent: '#f0648e' },
    glass: { panel: 0.6, blur: 18, scrim: 0.44, sceneBlur: 0 },
  },
  {
    id: 'outrun-teal', category: 'retro', scene: 'synthwave', sound: 'lofi',
    sceneParams: {
      skyTop: '#061826', skyMid: '#0f3b4f', skyBottom: '#1f7a7a', sunTop: '#d8fff4', sunBottom: '#2ee6c8',
      gridColor: '#2ee6c8', mountainColor: '#06202c', groundColor: '#041019',
    },
    render: { mode: 'pixel', cell: 6 },
    tagline: 'night drive, fast loops',
    palette: { bg: '#04131c', surface: '#0a2230', text: '#e2fffa', accent: '#2ee6c8' },
    glass: { panel: 0.6, blur: 18, scrim: 0.44, sceneBlur: 0 },
  },
  {
    id: 'vaporwave', category: 'retro', scene: 'synthwave', sound: 'lofi',
    sceneParams: {
      skyTop: '#2a1f4f', skyMid: '#6a4b8f', skyBottom: '#f29bc1', sunTop: '#fff2b0', sunBottom: '#ff9ad5',
      gridColor: '#9ef0ff', mountainColor: '#3a2a66', groundColor: '#22183f',
    },
    render: { mode: 'pixel', cell: 6 },
    tagline: 'aesthetic commits only',
    palette: { bg: '#18122e', surface: '#241b42', text: '#fff0fb', accent: '#9ef0ff' },
    glass: { panel: 0.62, blur: 18, scrim: 0.48, sceneBlur: 0 },
  },

  // ── Minimal ──
  {
    id: 'velvet', category: 'minimal', scene: 'gradient', sound: null,
    palette: { bg: '#0e0d1d', surface: '#18162e', text: '#efeaff', accent: '#c58bd6' },
    glass: { panel: 0.55, blur: 16, scrim: 0.28, sceneBlur: 0 },
  },
  {
    id: 'matcha', category: 'minimal', scene: 'gradient', sound: 'forest',
    sceneParams: { baseColor: '#0f1a14', blob1: '#3f7a52', blob2: '#a3b86c', blob3: '#2c5a5a', blob4: '#d8c88a' },
    palette: { bg: '#0c140f', surface: '#142019', text: '#eef5ea', accent: '#a3c86c' },
    glass: { panel: 0.55, blur: 16, scrim: 0.3, sceneBlur: 0 },
  },
  {
    id: 'ink', category: 'minimal', scene: 'gradient', sound: null,
    sceneParams: { baseColor: '#0b0b0f', blob1: '#26263a', blob2: '#3a2f45', blob3: '#1f3340', blob4: '#40362c', grain: 0.5 },
    palette: { bg: '#0a0a0e', surface: '#141419', text: '#e6e6ea', accent: '#cfd3dc' },
    glass: { panel: 0.6, blur: 14, scrim: 0.2, sceneBlur: 0 },
  },
  {
    id: 'zen-sand', category: 'minimal', scene: 'zen', sound: 'wind',
    sceneParams: { sand: true, waterColor: '#b8a888', rippleColor: '#e8dcc0', lilyColor: '#5b5348' },
    palette: { bg: '#15130f', surface: '#211e18', text: '#f5efe3', accent: '#c9a86a' },
    glass: { panel: 0.62, blur: 18, scrim: 0.55, sceneBlur: 0 },
  },
];

const BUILTIN_THEMES = RAW.map(normalizeTheme);

module.exports = { BUILTIN_THEMES, CATEGORIES, CLASSIC_ID, DEFAULT_GLASS, normalizeTheme };
