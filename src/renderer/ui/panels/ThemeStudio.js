/**
 * ThemeStudio - Settings → Themes: the theme gallery, the theme editor, and
 * the ambience, sound and layout options.
 *
 * Every control writes a setting and nothing else; ThemeEngine is subscribed
 * to settings and applies the change. The editor is the one exception: while
 * a theme is being edited it drives ThemeEngine.preview() so the whole app
 * shows the draft live, and only "Save" writes it to settings.customThemes.
 *
 * Mounted by SettingsPanel into #theme-studio-root, under its own lifecycle:
 * the settings panel re-renders its whole tree, so mount() always starts from
 * an empty root and destroy() stops the preview and the thumbnail queue.
 */

const ThemeEngine = require('../../ambience/ThemeEngine');
const { SCENES, getScene } = require('../../ambience/scenes');
const { CATEGORIES, normalizeTheme } = require('../../ambience/themes');
const { deriveTokens, contrast } = require('../../ambience/palette');
const { escapeHtml } = require('../../utils/dom');
const { t } = require('../../i18n');

const THUMB_W = 264;
const THUMB_H = 150;
const SOUND_IDS = ['rain', 'storm', 'waves', 'forest', 'night', 'fire', 'wind', 'space', 'underwater', 'cafe', 'lofi'];

/** t() with a fallback for keys built from data (scene params, custom ids). */
function tt(key, fallback) {
  const v = t(key);
  return v === key ? fallback : v;
}

function humanize(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

function themeName(theme) {
  return theme.custom ? theme.name : tt(`ambience.theme.${theme.id}`, theme.name || theme.id);
}

function sceneName(id) { return id ? tt(`ambience.scene.${id}`, humanize(id)) : t('ambience.noScene'); }
function soundName(id) { return tt(`ambience.sound.${id}`, humanize(id)); }

function newId() { return `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Validate an imported theme. Returns a normalized custom theme or throws with
 * a user-facing reason. Colours are re-checked as strict hex because they end
 * up in style attributes.
 */
function parseImportedTheme(json) {
  const raw = typeof json === 'string' ? JSON.parse(json) : json;
  if (!raw || typeof raw !== 'object') throw new Error(t('ambience.importInvalid'));
  const p = raw.palette || {};
  for (const k of ['bg', 'surface', 'text', 'accent']) {
    if (!HEX.test(p[k] || '')) throw new Error(t('ambience.importInvalid'));
  }
  if (raw.scene && !getScene(raw.scene)) throw new Error(t('ambience.importUnknownScene', { scene: String(raw.scene) }));
  const sceneParams = {};
  const schema = raw.scene ? getScene(raw.scene).params : [];
  for (const def of schema) {
    const v = raw.sceneParams?.[def.key];
    if (v === undefined) continue;
    if (def.type === 'color' && HEX.test(v)) sceneParams[def.key] = v;
    if (def.type === 'range' && Number.isFinite(Number(v))) sceneParams[def.key] = Math.min(def.max, Math.max(def.min, Number(v)));
    if (def.type === 'toggle') sceneParams[def.key] = !!v;
    if (def.type === 'text') sceneParams[def.key] = String(v).replace(/[^\w .:!?#*+&'<>/-]/g, '').slice(0, 12);
  }
  return normalizeTheme({
    id: newId(),
    name: String(raw.name || t('ambience.untitled')).slice(0, 60),
    custom: true,
    category: 'custom',
    scene: raw.scene || null,
    sceneParams,
    palette: { bg: p.bg, surface: p.surface, text: p.text, accent: p.accent },
    glass: raw.glass,
    terminal: raw.terminal === 'auto' || !raw.terminal ? 'auto' : String(raw.terminal),
    sound: SOUND_IDS.includes(raw.sound) ? raw.sound : null,
    render: raw.render,
    tagline: raw.tagline,
  });
}

/** The fields of a theme worth sharing, without app-specific ids. */
function exportable(theme) {
  const { name, scene, sceneParams, palette, glass, terminal, sound, render, tagline } = theme;
  void name;
  return { name: themeName(theme), scene, sceneParams, palette, glass, terminal, sound, render, tagline, format: 'claude-terminal-theme@1' };
}

/**
 * Paint a still frame of a theme into a canvas: the scene, the scrim, and a
 * sketch of the app's glass so the card shows how the UI will sit on it.
 */
function paintThumbnail(canvas, theme) {
  // No 2D context (a failed GPU process, or jsdom): the card keeps its plain background.
  const ctx = canvas?.getContext?.('2d');
  if (!ctx || !theme) return;
  const w = canvas.width;
  const h = canvas.height;
  const scene = theme.scene ? getScene(theme.scene) : null;
  if (scene) {
    try {
      // A pixel theme is previewed the way the renderer shows it: drawn one
      // pixel per tile into a small canvas, scaled up crisp, grid on top.
      const pixel = theme.render?.mode === 'pixel';
      if (pixel) {
        const cell = Math.max(2, Math.round(theme.render.cell / 2.5));
        const small = document.createElement('canvas');
        small.width = Math.ceil(w / cell);
        small.height = Math.ceil(h / cell);
        const sctx = small.getContext('2d');
        sctx.setTransform(1 / cell, 0, 0, 1 / cell, 0, 0);
        sctx.imageSmoothingEnabled = false;
        const inst = scene.create(sctx, { width: w, height: h, params: theme.sceneParams, cell });
        inst.render(24, 0);
        inst.destroy();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(small, 0, 0, small.width * cell, small.height * cell);
        ctx.imageSmoothingEnabled = true;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
        for (let x = 0; x < w; x += cell) ctx.fillRect(x, 0, 1, h);
        for (let y = 0; y < h; y += cell) ctx.fillRect(0, y, w, 1);
      } else {
        const inst = scene.create(ctx, { width: w, height: h, params: theme.sceneParams });
        inst.render(24, 0);
        inst.destroy();
      }
    } catch {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, w, h);
    }
  } else {
    ctx.fillStyle = theme.palette?.bg || '#0d0d0d';
    ctx.fillRect(0, 0, w, h);
  }
  const pal = theme.palette || { bg: '#0d0d0d', surface: '#151515', text: '#e0e0e0', accent: '#d97706' };
  const tokens = deriveTokens(pal);
  const glass = theme.glass;
  if (scene) {
    ctx.fillStyle = `rgba(${tokens['--theme-bg-rgb']}, ${glass.scrim})`;
    ctx.fillRect(0, 0, w, h);
  }
  const panelA = scene ? glass.panel : 1;
  // Sidebar
  ctx.fillStyle = `rgba(${tokens['--theme-bg-rgb']}, ${panelA})`;
  ctx.fillRect(0, 0, 48, h);
  ctx.fillStyle = pal.accent;
  ctx.fillRect(10, 16, 28, 5);
  ctx.fillStyle = `rgba(${tokens['--theme-text-rgb']}, 0.25)`;
  for (let i = 0; i < 5; i++) ctx.fillRect(10, 30 + i * 12, 22 + (i % 2) * 6, 4);
  // A message card and the user's pill
  const rr = (x, y, ww, hh, r) => { ctx.beginPath(); ctx.roundRect(x, y, ww, hh, r); ctx.fill(); };
  ctx.fillStyle = `rgba(${tokens['--theme-bg-rgb']}, ${Math.max(0.1, panelA - 0.08)})`;
  rr(70, 34, w - 100, 44, 8);
  ctx.fillStyle = `rgba(${tokens['--theme-text-rgb']}, 0.55)`;
  ctx.fillRect(80, 46, w - 150, 4);
  ctx.fillRect(80, 56, w - 180, 4);
  ctx.fillStyle = `rgba(${tokens['--theme-text-rgb']}, 0.3)`;
  ctx.fillRect(80, 66, w - 210, 4);
  ctx.fillStyle = pal.accent;
  ctx.globalAlpha = 0.85;
  rr(w - 110, 14, 80, 14, 7);
  ctx.globalAlpha = 1;
  // Composer
  ctx.fillStyle = `rgba(${tokens['--theme-surface-rgb']}, 0.85)`;
  rr(70, h - 28, w - 100, 18, 9);
  ctx.strokeStyle = pal.accent;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(70.5, h - 27.5, w - 101, 17, 9);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

class ThemeStudio {
  constructor() {
    this.root = null;
    this.deps = null;
    this.filter = 'all';
    this.draft = null;
    this.thumbQueue = [];
    this.thumbRaf = 0;
    this.previewRaf = 0;
  }

  /**
   * @param {HTMLElement} root
   * @param {object} deps { settingsState, setSetting, showToast, TERMINAL_THEMES, onSettingsDomSync }
   */
  mount(root, deps) {
    this.destroy();
    this.root = root;
    this.deps = deps;
    this.render();
  }

  destroy() {
    if (this.draft) ThemeEngine.preview(null);
    this.draft = null;
    cancelAnimationFrame(this.thumbRaf);
    cancelAnimationFrame(this.previewRaf);
    this.thumbQueue = [];
    if (this.root) this.root.innerHTML = '';
    this.root = null;
  }

  settings() { return this.deps.settingsState.get(); }

  set(key, value) { this.deps.setSetting(key, value); }

  // ── Rendering ───────────────────────────────────────────────────────────

  render() {
    if (!this.root) return;
    const s = this.settings();
    this.root.innerHTML = `
      <div class="settings-group" data-section="ambience">
        <div class="settings-group-title">${t('ambience.galleryTitle')}</div>
        <div class="ts-intro">${t('ambience.galleryDesc')}</div>
        <div class="ts-toolbar">
          <div class="ts-filters" role="tablist">
            ${['all', ...CATEGORIES].map((c) => `
              <button type="button" class="ts-filter ${this.filter === c ? 'active' : ''}" data-filter="${c}">${t(`ambience.category.${c}`)}</button>`).join('')}
          </div>
          <div class="ts-toolbar-actions">
            <button type="button" class="btn-outline ts-btn" data-action="new">${t('ambience.newTheme')}</button>
            <button type="button" class="btn-outline ts-btn" data-action="import">${t('ambience.import')}</button>
            <input type="file" accept=".json,application/json" class="ts-import-input" hidden>
          </div>
        </div>
        <div class="ts-grid">${this.gridHtml()}</div>
        <div class="ts-editor-slot"></div>
      </div>

      <div class="settings-group" data-section="ambience-scene">
        <div class="settings-group-title">${t('ambience.sceneTitle')}</div>
        <div class="settings-card">
          <div class="settings-row">
            <div class="settings-label"><div>${t('ambience.brightness')}</div><div class="settings-desc">${t('ambience.brightnessDesc')}</div></div>
            <input type="range" class="ts-range" data-setting="ambientBrightness" min="0.3" max="1" step="0.05" value="${typeof s.ambientBrightness === 'number' ? s.ambientBrightness : 0.7}">
          </div>
          ${this.toggleRow('ambientMotion', t('ambience.motion'), t('ambience.motionDesc'), s.ambientMotion !== false)}
          ${this.selectRow('ambientQuality', t('ambience.quality'), t('ambience.qualityDesc'), s.ambientQuality || 'medium',
            [['low', t('ambience.qualityLow')], ['medium', t('ambience.qualityMedium')], ['high', t('ambience.qualityHigh')]])}
          ${this.selectRow('ambientFps', t('ambience.fps'), t('ambience.fpsDesc'), String(s.ambientFps || 30),
            [['20', '20 fps'], ['30', '30 fps'], ['60', '60 fps']])}
          ${this.toggleRow('ambientPauseUnfocused', t('ambience.pauseUnfocused'), t('ambience.pauseUnfocusedDesc'), !!s.ambientPauseUnfocused)}
        </div>
      </div>

      <div class="settings-group" data-section="ambience-sound">
        <div class="settings-group-title">${t('ambience.soundTitle')}</div>
        <div class="settings-card">
          ${this.toggleRow('ambientSoundEnabled', t('ambience.soundEnabled'), t('ambience.soundEnabledDesc'), !!s.ambientSoundEnabled)}
          ${this.selectRow('ambientSoundTrack', t('ambience.soundTrack'), t('ambience.soundTrackDesc'), s.ambientSoundTrack || 'auto',
            [['auto', t('ambience.soundAuto')], ...SOUND_IDS.map((id) => [id, soundName(id)])])}
          <div class="settings-row">
            <div class="settings-label"><div>${t('ambience.volume')}</div></div>
            <input type="range" class="ts-range" data-setting="ambientSoundVolume" min="0" max="1" step="0.05" value="${typeof s.ambientSoundVolume === 'number' ? s.ambientSoundVolume : 0.5}">
          </div>
        </div>
      </div>

      <div class="settings-group" data-section="layout">
        <div class="settings-group-title">${t('ambience.layoutTitle')}</div>
        <div class="settings-card">
          ${this.segmentRow('layoutMode', t('ambience.layoutMode'), t('ambience.layoutModeDesc'), s.layoutMode || 'standard',
            [['standard', t('ambience.layoutStandard')], ['focus', t('ambience.layoutFocus')]])}
          ${this.segmentRow('layoutStyle', t('ambience.layoutStyle'), t('ambience.layoutStyleDesc'), s.layoutStyle || 'classic',
            [['classic', t('ambience.layoutClassic')], ['floating', t('ambience.layoutFloating')]])}
          ${this.segmentRow('chatWidth', t('ambience.chatWidth'), t('ambience.chatWidthDesc'), s.chatWidth || 'full',
            [['full', t('ambience.chatFull')], ['comfortable', t('ambience.chatComfortable')], ['narrow', t('ambience.chatNarrow')]])}
          ${this.segmentRow('uiFont', t('ambience.font'), t('ambience.fontDesc'), s.uiFont || 'system',
            [['system', t('ambience.fontSystem')], ['rounded', t('ambience.fontRounded')], ['serif', t('ambience.fontSerif')], ['mono', t('ambience.fontMono')]])}
          ${this.segmentRow('uiBorders', t('ambience.borders'), t('ambience.bordersDesc'), s.uiBorders || 'subtle',
            [['normal', t('ambience.bordersNormal')], ['subtle', t('ambience.bordersSubtle')], ['none', t('ambience.bordersNone')]])}
          ${this.segmentRow('uiRadius', t('ambience.radius'), t('ambience.radiusDesc'), s.uiRadius || 'normal',
            [['sharp', t('ambience.radiusSharp')], ['normal', t('ambience.radiusNormal')], ['round', t('ambience.radiusRound')]])}
          ${this.toggleRow('zenMode', t('ambience.zen'), t('ambience.zenDesc'), !!s.zenMode)}
        </div>
      </div>`;
    this.bind();
    this.queueThumbnails();
    if (this.draft) this.renderEditor();
  }

  gridHtml() {
    const active = this.settings().appTheme || 'classic';
    const themes = ThemeEngine.allThemes().filter((th) => this.filter === 'all' || th.category === this.filter);
    if (!themes.length) return `<div class="ts-empty">${t('ambience.noCustomThemes')}</div>`;
    return themes.map((th) => `
      <div class="ts-card ${th.id === active ? 'active' : ''}" data-theme-id="${escapeHtml(th.id)}" tabindex="0" role="button"
           aria-pressed="${th.id === active}" aria-label="${escapeHtml(themeName(th))}">
        <canvas class="ts-thumb" width="${THUMB_W}" height="${THUMB_H}"></canvas>
        <div class="ts-card-meta">
          <span class="ts-card-dot" style="background:${escapeHtml(th.palette?.accent || '#d97706')}"></span>
          <span class="ts-card-name">${escapeHtml(themeName(th))}</span>
          ${th.sound ? `<span class="ts-card-sound" title="${escapeHtml(soundName(th.sound))}">♪</span>` : ''}
        </div>
        <div class="ts-card-actions">
          <button type="button" class="ts-card-btn" data-card-action="customize" title="${t('ambience.customize')}">${t('ambience.customize')}</button>
          ${th.custom ? `
            <button type="button" class="ts-card-btn" data-card-action="export" title="${t('ambience.export')}">${t('ambience.export')}</button>
            <button type="button" class="ts-card-btn danger" data-card-action="delete" title="${t('common.delete')}">${t('common.delete')}</button>` : ''}
        </div>
      </div>`).join('');
  }

  toggleRow(key, label, desc, checked) {
    return `
      <div class="settings-toggle-row">
        <div class="settings-toggle-label"><div>${label}</div>${desc ? `<div class="settings-toggle-desc">${desc}</div>` : ''}</div>
        <label class="settings-toggle">
          <input type="checkbox" data-setting="${key}" ${checked ? 'checked' : ''}>
          <span class="settings-toggle-slider"></span>
        </label>
      </div>`;
  }

  selectRow(key, label, desc, value, options) {
    return `
      <div class="settings-row">
        <div class="settings-label"><div>${label}</div>${desc ? `<div class="settings-desc">${desc}</div>` : ''}</div>
        <select class="ts-select" data-setting="${key}">
          ${options.map(([v, l]) => `<option value="${escapeHtml(v)}" ${v === value ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}
        </select>
      </div>`;
  }

  segmentRow(key, label, desc, value, options) {
    return `
      <div class="settings-row">
        <div class="settings-label"><div>${label}</div>${desc ? `<div class="settings-desc">${desc}</div>` : ''}</div>
        <div class="ts-segment" data-setting="${key}" role="radiogroup">
          ${options.map(([v, l]) => `<button type="button" role="radio" aria-checked="${v === value}" class="${v === value ? 'active' : ''}" data-value="${v}">${escapeHtml(l)}</button>`).join('')}
        </div>
      </div>`;
  }

  // ── Thumbnails, painted a few per frame so opening the tab never stalls ──

  queueThumbnails() {
    cancelAnimationFrame(this.thumbRaf);
    const byId = new Map(ThemeEngine.allThemes().map((th) => [th.id, th]));
    this.thumbQueue = [...this.root.querySelectorAll('.ts-card')].map((card) => ({
      canvas: card.querySelector('canvas'),
      theme: byId.get(card.dataset.themeId),
    }));
    const step = () => {
      const start = performance.now();
      while (this.thumbQueue.length && performance.now() - start < 12) {
        const { canvas, theme } = this.thumbQueue.shift();
        if (theme && canvas?.isConnected) paintThumbnail(canvas, theme);
      }
      if (this.thumbQueue.length) this.thumbRaf = requestAnimationFrame(step);
    };
    this.thumbRaf = requestAnimationFrame(step);
  }

  // ── Events ──────────────────────────────────────────────────────────────

  bind() {
    const root = this.root;
    root.querySelectorAll('.ts-filter').forEach((btn) => {
      btn.onclick = () => {
        this.filter = btn.dataset.filter;
        root.querySelectorAll('.ts-filter').forEach((b) => b.classList.toggle('active', b === btn));
        root.querySelector('.ts-grid').innerHTML = this.gridHtml();
        this.bindCards();
        this.queueThumbnails();
      };
    });
    this.bindCards();

    root.querySelector('[data-action="new"]').onclick = () => this.startEditing(ThemeEngine.activeTheme(), true);
    const fileInput = root.querySelector('.ts-import-input');
    root.querySelector('[data-action="import"]').onclick = () => fileInput.click();
    fileInput.onchange = () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const theme = parseImportedTheme(String(reader.result));
          this.saveCustom(theme);
          ThemeEngine.selectTheme(theme.id);
          this.afterThemeChange();
          this.deps.showToast?.(t('ambience.imported', { name: theme.name }), 'success');
        } catch (e) {
          this.deps.showToast?.(e.message || t('ambience.importInvalid'), 'error');
        }
      };
      reader.readAsText(file);
    };

    root.querySelectorAll('input[type="checkbox"][data-setting]').forEach((el) => {
      el.onchange = () => this.set(el.dataset.setting, el.checked);
    });
    root.querySelectorAll('select[data-setting]').forEach((el) => {
      el.onchange = () => {
        const key = el.dataset.setting;
        this.set(key, key === 'ambientFps' ? Number(el.value) : el.value);
        // Picking a soundscape is a request to hear it.
        if (key === 'ambientSoundTrack' && !this.settings().ambientSoundEnabled) {
          this.set('ambientSoundEnabled', true);
          const toggle = root.querySelector('input[data-setting="ambientSoundEnabled"]');
          if (toggle) toggle.checked = true;
        }
      };
    });
    root.querySelectorAll('input[type="range"][data-setting]').forEach((el) => {
      el.oninput = () => this.set(el.dataset.setting, Number(el.value));
    });
    root.querySelectorAll('.ts-segment[data-setting]').forEach((seg) => {
      seg.querySelectorAll('button').forEach((btn) => {
        btn.onclick = () => {
          seg.querySelectorAll('button').forEach((b) => {
            b.classList.toggle('active', b === btn);
            b.setAttribute('aria-checked', String(b === btn));
          });
          this.set(seg.dataset.setting, btn.dataset.value);
        };
      });
    });
  }

  bindCards() {
    this.root.querySelectorAll('.ts-card').forEach((card) => {
      const id = card.dataset.themeId;
      const choose = () => {
        if (this.draft) this.cancelEditing();
        ThemeEngine.selectTheme(id);
        this.afterThemeChange();
      };
      card.onclick = (e) => { if (!e.target.closest('[data-card-action]')) choose(); };
      card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } };
      card.querySelectorAll('[data-card-action]').forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const theme = ThemeEngine.resolveTheme(id);
          const action = btn.dataset.cardAction;
          if (action === 'customize') this.startEditing(theme, !theme.custom);
          if (action === 'export') this.exportTheme(theme);
          if (action === 'delete') this.deleteCustom(theme);
        };
      });
    });
  }

  /** Repaint the active marks and tell the settings panel its accent/terminal fields moved. */
  afterThemeChange() {
    const active = this.settings().appTheme;
    this.root?.querySelectorAll('.ts-card').forEach((c) => {
      c.classList.toggle('active', c.dataset.themeId === active);
      c.setAttribute('aria-pressed', String(c.dataset.themeId === active));
    });
    this.deps.onSettingsDomSync?.();
  }

  // ── Custom themes ───────────────────────────────────────────────────────

  customThemes() {
    const list = this.settings().customThemes;
    return Array.isArray(list) ? list : [];
  }

  saveCustom(theme) {
    const { custom, ...stored } = normalizeTheme({ ...theme, custom: true, category: 'custom' });
    void custom;
    const list = this.customThemes().filter((x) => x.id !== stored.id);
    this.set('customThemes', [...list, stored]);
  }

  deleteCustom(theme) {
    if (!window.confirm(t('ambience.deleteConfirm', { name: theme.name }))) return;
    this.set('customThemes', this.customThemes().filter((x) => x.id !== theme.id));
    if (this.settings().appTheme === theme.id) ThemeEngine.selectTheme(theme.basedOn || 'classic');
    this.render();
    this.deps.onSettingsDomSync?.();
  }

  async exportTheme(theme) {
    const json = JSON.stringify(exportable(theme), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      this.deps.showToast?.(t('ambience.exported'), 'success');
    } catch {
      this.deps.showToast?.(t('ambience.exportFailed'), 'error');
    }
  }

  // ── Editor ──────────────────────────────────────────────────────────────

  /**
   * Open the editor on `theme`. Editing a built-in (or "new") always works on
   * a copy, so the built-ins stay pristine and "reset" is just picking them.
   */
  startEditing(theme, asCopy) {
    const base = normalizeTheme(theme);
    const palette = base.palette || { bg: '#0d0d0d', surface: '#151515', text: '#e0e0e0', accent: this.settings().accentColor || '#d97706' };
    this.draft = normalizeTheme({
      ...base,
      id: asCopy ? newId() : base.id,
      name: asCopy ? t('ambience.copyOf', { name: themeName(base) }) : base.name,
      custom: true,
      category: 'custom',
      basedOn: asCopy ? base.id : base.basedOn,
      palette: { ...palette },
      sceneParams: { ...base.sceneParams },
    });
    this.isNewDraft = asCopy;
    this.renderEditor();
    this.schedulePreview();
    this.root.querySelector('.ts-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  cancelEditing() {
    this.draft = null;
    ThemeEngine.preview(null);
    const slot = this.root?.querySelector('.ts-editor-slot');
    if (slot) slot.innerHTML = '';
  }

  saveEditing() {
    const d = this.draft;
    if (!d) return;
    d.name = (d.name || '').trim() || t('ambience.untitled');
    this.saveCustom(d);
    this.draft = null;
    ThemeEngine.preview(null);
    ThemeEngine.selectTheme(d.id);
    this.filter = 'custom';
    this.render();
    this.deps.onSettingsDomSync?.();
    this.deps.showToast?.(t('ambience.saved', { name: d.name }), 'success');
  }

  schedulePreview() {
    cancelAnimationFrame(this.previewRaf);
    this.previewRaf = requestAnimationFrame(() => {
      if (this.draft) ThemeEngine.preview(this.draft);
      this.updateContrastBadge();
    });
  }

  renderEditor() {
    const slot = this.root?.querySelector('.ts-editor-slot');
    if (!slot || !this.draft) return;
    const d = this.draft;
    const scene = d.scene ? getScene(d.scene) : null;
    const colorField = (group, key, label, value) => `
      <label class="ts-color">
        <input type="color" data-group="${group}" data-key="${escapeHtml(key)}" value="${escapeHtml(HEX.test(value || '') ? value : '#000000')}">
        <span>${escapeHtml(label)}</span>
      </label>`;
    const sceneControls = scene ? scene.params.map((def) => {
      const value = d.sceneParams[def.key] !== undefined ? d.sceneParams[def.key] : def.default;
      const label = tt(`ambience.param.${def.key}`, humanize(def.key));
      if (def.type === 'color') return colorField('scene', def.key, label, value);
      if (def.type === 'toggle') {
        return `<label class="ts-check"><input type="checkbox" data-group="scene" data-key="${escapeHtml(def.key)}" ${value ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>`;
      }
      if (def.type === 'text') {
        return `<label class="ts-text"><span>${escapeHtml(label)}</span>
          <input type="text" maxlength="12" spellcheck="false" data-group="scene" data-key="${escapeHtml(def.key)}" value="${escapeHtml(String(value ?? ''))}"></label>`;
      }
      return `<label class="ts-slider"><span>${escapeHtml(label)}</span>
        <input type="range" data-group="scene" data-key="${escapeHtml(def.key)}" min="${def.min}" max="${def.max}" step="${def.step || 0.01}" value="${value}"></label>`;
    }).join('') : '';
    const slider = (key, label, min, max, step, value, unit = '') => `
      <label class="ts-slider"><span>${label}</span>
        <input type="range" data-group="glass" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${value}">
        <output>${value}${unit}</output></label>`;
    const terminalOptions = [['auto', t('ambience.terminalAuto')],
      ...Object.entries(this.deps.TERMINAL_THEMES || {}).filter(([id]) => id !== 'ambient').map(([id, th]) => [id, th.name])];

    slot.innerHTML = `
      <div class="ts-editor" role="region" aria-label="${t('ambience.editorTitle')}">
        <div class="ts-editor-head">
          <input type="text" class="ts-name" maxlength="60" value="${escapeHtml(d.name)}" aria-label="${t('ambience.themeName')}">
          <span class="ts-contrast" title="${t('ambience.contrastHint')}"></span>
          <div class="ts-editor-actions">
            <button type="button" class="btn-outline ts-btn" data-editor="cancel">${t('common.cancel')}</button>
            <button type="button" class="btn-primary ts-btn" data-editor="save">${t('common.save')}</button>
          </div>
        </div>
        <div class="ts-editor-grid">
          <section>
            <h4>${t('ambience.sceneSection')}</h4>
            <div class="ts-scene-picker">
              ${[null, ...SCENES.map((s) => s.id)].map((id) => `
                <button type="button" class="ts-scene-chip ${d.scene === id ? 'active' : ''}" data-scene="${id || ''}">${escapeHtml(sceneName(id))}</button>`).join('')}
            </div>
            <div class="ts-fields">${sceneControls}</div>
            ${scene ? `<button type="button" class="ts-link" data-editor="reset-scene">${t('ambience.resetScene')}</button>` : ''}
          </section>
          <section>
            <h4>${t('ambience.paletteSection')}</h4>
            <div class="ts-fields">
              ${colorField('palette', 'bg', t('ambience.colorBg'), d.palette.bg)}
              ${colorField('palette', 'surface', t('ambience.colorSurface'), d.palette.surface)}
              ${colorField('palette', 'text', t('ambience.colorText'), d.palette.text)}
              ${colorField('palette', 'accent', t('ambience.colorAccent'), d.palette.accent)}
            </div>
            <h4>${t('ambience.renderSection')}</h4>
            <div class="ts-segment ts-render" role="radiogroup">
              ${[['smooth', t('ambience.renderSmooth')], ['pixel', t('ambience.renderPixel')]].map(([v, l]) => `
                <button type="button" role="radio" aria-checked="${d.render.mode === v}" class="${d.render.mode === v ? 'active' : ''}" data-render="${v}">${escapeHtml(l)}</button>`).join('')}
            </div>
            <div class="ts-fields ts-fields-col" ${d.render.mode === 'pixel' ? '' : 'hidden'} data-pixel-only>
              <label class="ts-slider"><span>${t('ambience.pixelSize')}</span>
                <input type="range" data-group="render" data-key="cell" min="4" max="12" step="1" value="${d.render.cell}">
                <output>${d.render.cell}px</output></label>
            </div>
            <h4>${t('ambience.glassSection')}</h4>
            <div class="ts-fields ts-fields-col">
              ${slider('scrim', t('ambience.readability'), 0, 0.9, 0.01, d.glass.scrim)}
              ${slider('panel', t('ambience.panelOpacity'), 0.15, 1, 0.01, d.glass.panel)}
              ${slider('blur', t('ambience.blur'), 0, 40, 1, d.glass.blur, 'px')}
              ${slider('sceneBlur', t('ambience.sceneBlur'), 0, 20, 1, d.glass.sceneBlur, 'px')}
            </div>
          </section>
          <section>
            <h4>${t('ambience.extrasSection')}</h4>
            <label class="ts-select-field"><span>${t('ambience.tagline')}</span>
              <input type="text" class="ts-input" maxlength="60" data-group="meta" data-key="tagline" value="${escapeHtml(d.tagline || '')}" placeholder="${escapeHtml(t('ambience.taglinePlaceholder'))}"></label>
            <label class="ts-select-field"><span>${t('ambience.terminalColors')}</span>
              <select class="ts-select" data-group="meta" data-key="terminal">
                ${terminalOptions.map(([v, l]) => `<option value="${escapeHtml(v)}" ${d.terminal === v ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}
              </select></label>
            <label class="ts-select-field"><span>${t('ambience.themeSound')}</span>
              <select class="ts-select" data-group="meta" data-key="sound">
                <option value="" ${!d.sound ? 'selected' : ''}>${t('ambience.soundNone')}</option>
                ${SOUND_IDS.map((id) => `<option value="${id}" ${d.sound === id ? 'selected' : ''}>${escapeHtml(soundName(id))}</option>`).join('')}
              </select></label>
            <button type="button" class="ts-link" data-editor="export">${t('ambience.exportDraft')}</button>
          </section>
        </div>
      </div>`;
    this.bindEditor(slot);
    this.updateContrastBadge();
  }

  bindEditor(slot) {
    const d = this.draft;
    slot.querySelector('.ts-name').oninput = (e) => { d.name = e.target.value; };
    slot.querySelector('[data-editor="cancel"]').onclick = () => this.cancelEditing();
    slot.querySelector('[data-editor="save"]').onclick = () => this.saveEditing();
    slot.querySelector('[data-editor="export"]').onclick = () => this.exportTheme(d);
    const reset = slot.querySelector('[data-editor="reset-scene"]');
    if (reset) reset.onclick = () => { d.sceneParams = {}; this.renderEditor(); this.schedulePreview(); };
    slot.querySelectorAll('[data-render]').forEach((btn) => {
      btn.onclick = () => {
        d.render.mode = btn.dataset.render;
        slot.querySelectorAll('[data-render]').forEach((b) => {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-checked', String(b === btn));
        });
        const pixelOnly = slot.querySelector('[data-pixel-only]');
        if (pixelOnly) pixelOnly.hidden = d.render.mode !== 'pixel';
        this.schedulePreview();
      };
    });
    slot.querySelectorAll('.ts-scene-chip').forEach((chip) => {
      chip.onclick = () => {
        d.scene = chip.dataset.scene || null;
        d.sceneParams = {};
        this.renderEditor();
        this.schedulePreview();
      };
    });
    slot.querySelectorAll('[data-group]').forEach((el) => {
      const handler = () => {
        const { group, key } = el.dataset;
        let value = el.type === 'checkbox' ? el.checked : el.value;
        if (el.type === 'range') value = Number(value);
        if (group === 'scene') d.sceneParams[key] = value;
        if (group === 'palette') d.palette[key] = value;
        if (group === 'glass') {
          d.glass[key] = value;
          const out = el.parentElement.querySelector('output');
          if (out) out.textContent = `${value}${key.toLowerCase().includes('blur') ? 'px' : ''}`;
        }
        if (group === 'meta') d[key] = key === 'tagline' ? String(value || '') : (value || null);
        if (group === 'render') {
          d.render[key] = value;
          const out = el.parentElement.querySelector('output');
          if (out) out.textContent = `${value}px`;
        }
        this.schedulePreview();
      };
      el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', handler);
    });
  }

  /** Worst text-on-surface contrast of the draft, shown as AA / AAA / low. */
  updateContrastBadge() {
    const badge = this.root?.querySelector('.ts-contrast');
    if (!badge || !this.draft) return;
    const tokens = deriveTokens(this.draft.palette);
    const ratio = Math.min(
      contrast(tokens['--text-muted'], tokens['--bg-secondary']),
      contrast(tokens['--text-primary'], tokens['--bg-tertiary']),
    );
    const level = ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : 'low';
    badge.textContent = `${t('ambience.contrast')} ${ratio.toFixed(1)}:1 · ${level === 'low' ? t('ambience.contrastLow') : level}`;
    badge.dataset.level = level;
  }
}

module.exports = { ThemeStudio, parseImportedTheme, exportable, paintThumbnail };
