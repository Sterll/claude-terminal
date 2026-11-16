/**
 * ThemeEngine - applies the app theme: colour tokens, glass, the animated
 * scene behind the window, the matching terminal colours, the soundscape and
 * the layout preferences.
 *
 * It is driven by settings alone. The engine subscribes to settingsState and
 * re-applies whatever part changed, so every surface that can change a theme
 * (Settings, the titlebar ambience popover, the Theme Studio, the MCP
 * `settings_set` tool through the settings trigger) only has to write a key.
 *
 * Settings it reads (defaults in settings.state.js):
 *   appTheme, customThemes, ambientMotion, ambientQuality, ambientFps,
 *   ambientPauseUnfocused, ambientSoundEnabled, ambientSoundVolume,
 *   ambientSoundTrack, layoutStyle, uiFont, chatWidth, uiRadius, zenMode
 *
 * The "classic" theme is the app as it always looked: no scene, no inline
 * token overrides, base.css untouched. Choosing it must leave nothing behind.
 */

const { AmbientBackground } = require('./AmbientBackground');
const { getScene } = require('./scenes');
const { BUILTIN_THEMES, CLASSIC_ID, normalizeTheme } = require('./themes');
const { deriveTokens, deriveTerminalTheme } = require('./palette');
const { t } = require('../i18n');

/** base.css colours, for what the classic theme derives (terminal colours). */
const CLASSIC_PALETTE = { bg: '#0d0d0d', surface: '#151515', text: '#e0e0e0', accent: '#d97706' };

const LAYOUT_CLASSES = {
  layoutStyle: { classic: null, floating: 'ct-layout-floating' },
  uiFont: { system: null, rounded: 'ct-font-rounded', serif: 'ct-font-serif', mono: 'ct-font-mono' },
  chatWidth: { full: null, comfortable: 'ct-chat-comfortable', narrow: 'ct-chat-narrow' },
  uiRadius: { sharp: 'ct-radius-sharp', normal: null, round: 'ct-radius-round' },
  uiBorders: { normal: null, subtle: 'ct-borders-subtle', none: 'ct-borders-none' },
};

/** Inline properties this engine may set on :root, cleared on the way back to classic. */
let appliedTokenNames = [];

const state = {
  settingsState: null,
  setSetting: null,
  applyAccentColor: null,
  registerTerminalTheme: null,
  applyTerminalTheme: null,
  background: null,
  sound: null,
  previewTheme: null,
  lastThemeSig: '',
  lastOptionsSig: '',
  lastSoundSig: '',
  lastLayoutSig: '',
};

function settings() { return state.settingsState?.get() || {}; }

function allThemes() {
  const custom = Array.isArray(settings().customThemes) ? settings().customThemes : [];
  return [...BUILTIN_THEMES, ...custom.map((t) => normalizeTheme({ ...t, custom: true }))];
}

function resolveTheme(id) {
  return allThemes().find((t) => t.id === id) || BUILTIN_THEMES.find((t) => t.id === CLASSIC_ID);
}

function activeTheme() {
  return state.previewTheme || resolveTheme(settings().appTheme || CLASSIC_ID);
}

// ── Tokens and glass ──────────────────────────────────────────────────────

function clearTokens(root) {
  for (const name of appliedTokenNames) root.style.removeProperty(name);
  appliedTokenNames = [];
}

function applyTokens(theme) {
  const root = document.documentElement;
  clearTokens(root);
  if (!theme.palette) return;
  const tokens = deriveTokens(theme.palette);
  const g = theme.glass;
  tokens['--glass-alpha'] = String(g.panel);
  tokens['--glass-blur'] = `${g.blur}px`;
  tokens['--scrim-alpha'] = String(g.scrim);
  tokens['--scene-blur'] = `${g.sceneBlur}px`;
  // Percentages for color-mix(): chrome panels at the theme's opacity, cards
  // inside the panes a step more opaque, since they carry the dense content.
  const pct = (v) => `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`;
  tokens['--glass-pct'] = pct(g.panel);
  tokens['--card-pct'] = pct(g.panel + 0.2);
  tokens['--page-pct'] = pct(g.panel + 0.1);
  // A CSS string for ::before content; newlines were stripped by normalizeTheme.
  if (theme.tagline) tokens['--theme-tagline'] = JSON.stringify(theme.tagline);
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(name, value);
    appliedTokenNames.push(name);
  }
}

// ── Scene ─────────────────────────────────────────────────────────────────

function ambientOptions() {
  const s = settings();
  return {
    motion: s.ambientMotion !== false,
    quality: s.ambientQuality || 'medium',
    fps: Number(s.ambientFps) || 30,
    pauseUnfocused: !!s.ambientPauseUnfocused,
  };
}

function applyScene(theme) {
  const scene = theme.scene ? getScene(theme.scene) : null;
  document.body.classList.toggle('ct-ambient', !!scene);
  if (!scene) {
    state.background?.unmount();
    return;
  }
  if (!state.background) state.background = new AmbientBackground();
  state.background.setOptions({
    ...ambientOptions(),
    pixel: theme.render?.mode === 'pixel' ? theme.render.cell : 0,
  });
  state.background.setScene(scene, theme.sceneParams);
}

// ── Sound ─────────────────────────────────────────────────────────────────

function soundController() {
  if (!state.sound) {
    // Required lazily: nothing audio-related loads for a user who never turns it on.
    const { createAmbientSound } = require('./AmbientSound');
    state.sound = createAmbientSound();
  }
  return state.sound;
}

function soundTrackFor(theme) {
  const s = settings();
  const track = s.ambientSoundTrack || 'auto';
  return track === 'auto' ? (theme.sound || null) : track;
}

function applySound(theme) {
  const s = settings();
  const track = s.ambientSoundEnabled ? soundTrackFor(theme) : null;
  if (!track) {
    if (state.sound) state.sound.stop();
    return;
  }
  const ctl = soundController();
  ctl.setVolume(typeof s.ambientSoundVolume === 'number' ? s.ambientSoundVolume : 0.5);
  if (ctl.current() !== track) ctl.play(track);
}

// ── Layout ────────────────────────────────────────────────────────────────

function applyLayout() {
  const s = settings();
  const body = document.body;
  for (const [key, map] of Object.entries(LAYOUT_CLASSES)) {
    for (const cls of Object.values(map)) if (cls) body.classList.remove(cls);
    const cls = map[s[key]];
    if (cls) body.classList.add(cls);
  }
  body.classList.toggle('ct-zen', !!s.zenMode);
  const brightness = Number(s.ambientBrightness);
  document.documentElement.style.setProperty('--scene-brightness',
    String(Number.isFinite(brightness) ? Math.min(1, Math.max(0.3, brightness)) : 0.7));
}

// ── Orchestration ─────────────────────────────────────────────────────────

function applyTheme(theme) {
  applyTokens(theme);
  applyScene(theme);
  document.body.dataset.appTheme = theme.id;
  // The derived terminal colours are always registered, so a saved
  // `terminalTheme: 'ambient'` resolves at boot before any terminal exists.
  // Registered for the classic theme too (from the base palette), so the
  // terminal colour grid always offers "follow the app theme".
  const palette = theme.palette || { ...CLASSIC_PALETTE, accent: settings().accentColor || CLASSIC_PALETTE.accent };
  state.registerTerminalTheme?.(deriveTerminalTheme(palette, t('ambience.terminalFollowsTheme')));
  if (theme.palette) {
    // Open terminals hold the previous object; recolour them if they follow the theme.
    if (!state.previewTheme && settings().terminalTheme === 'ambient') state.applyTerminalTheme?.('ambient');
  }
}

function terminalIdFor(theme) {
  if (!theme.palette) return theme.terminal || 'claude';
  return !theme.terminal || theme.terminal === 'auto' ? 'ambient' : theme.terminal;
}

function sig(obj) { return JSON.stringify(obj); }

/** Re-apply only what changed since last time; cheap enough for every settings notify. */
function sync(force = false) {
  const s = settings();
  const theme = activeTheme();
  const themeSig = sig([theme, state.previewTheme ? 'preview' : '']);
  if (force || themeSig !== state.lastThemeSig) {
    state.lastThemeSig = themeSig;
    applyTheme(theme);
  }
  const optSig = sig(ambientOptions());
  if (force || optSig !== state.lastOptionsSig) {
    state.lastOptionsSig = optSig;
    state.background?.setOptions(ambientOptions());
  }
  const soundSig = sig([s.ambientSoundEnabled, s.ambientSoundVolume, soundTrackFor(theme)]);
  if (force || soundSig !== state.lastSoundSig) {
    state.lastSoundSig = soundSig;
    applySound(theme);
  }
  const layoutSig = sig(Object.keys(LAYOUT_CLASSES).map((k) => s[k]).concat(s.zenMode, s.ambientBrightness));
  if (force || layoutSig !== state.lastLayoutSig) {
    state.lastLayoutSig = layoutSig;
    applyLayout();
  }
}

/**
 * @param {object} deps
 * @param {object} deps.settingsState
 * @param {(key: string, value: any) => void} deps.setSetting
 * @param {(hex: string) => void} deps.applyAccentColor
 * @param {(xtermTheme: object) => void} deps.registerTerminalTheme  define the 'ambient' terminal theme
 * @param {(id: string) => void} deps.applyTerminalTheme  recolour open terminals
 */
function init(deps) {
  Object.assign(state, deps);
  sync(true);
  state.settingsState.subscribe(() => sync());
}

/**
 * Make `id` the app theme. Its accent becomes the accent colour and its
 * terminal colours the terminal theme, both still overridable afterwards
 * from their own settings, which is why they are written rather than derived.
 */
function selectTheme(id) {
  const theme = resolveTheme(id);
  state.previewTheme = null;
  state.setSetting('appTheme', theme.id);
  const termId = terminalIdFor(theme);
  state.setSetting('terminalTheme', termId);
  state.applyTerminalTheme?.(termId);
  if (theme.palette?.accent) {
    state.setSetting('accentColor', theme.palette.accent);
    state.applyAccentColor?.(theme.palette.accent);
  }
}

/** Show `theme` without saving it (the studio's live preview). Pass null to stop. */
function preview(theme) {
  state.previewTheme = theme ? normalizeTheme(theme) : null;
  sync();
  if (state.previewTheme) {
    if (state.previewTheme.palette?.accent) state.applyAccentColor?.(state.previewTheme.palette.accent);
    state.applyTerminalTheme?.(terminalIdFor(state.previewTheme));
  } else {
    state.applyAccentColor?.(settings().accentColor || '#d97706');
    state.applyTerminalTheme?.(settings().terminalTheme || 'claude');
  }
}

function toggleZen() {
  state.setSetting('zenMode', !settings().zenMode);
}

module.exports = {
  init,
  sync,
  selectTheme,
  preview,
  toggleZen,
  allThemes,
  resolveTheme,
  activeTheme,
  soundController,
  LAYOUT_CLASSES,
};
