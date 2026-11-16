const { BUILTIN_THEMES, normalizeTheme, CLASSIC_ID, CATEGORIES } = require('../../src/renderer/ambience/themes');
const { SCENES, getScene } = require('../../src/renderer/ambience/scenes');
const en = require('../../src/renderer/i18n/locales/en.json');

describe('built-in themes', () => {
  test('ids are unique and the classic theme exists without a scene', () => {
    const ids = BUILTIN_THEMES.map((th) => th.id);
    expect(new Set(ids).size).toBe(ids.length);
    const classic = BUILTIN_THEMES.find((th) => th.id === CLASSIC_ID);
    expect(classic.scene).toBeNull();
    expect(classic.palette).toBeNull();
  });

  test.each(BUILTIN_THEMES.map((th) => [th.id, th]))('%s references a real scene, valid params and a name', (_id, theme) => {
    expect(CATEGORIES).toContain(theme.category);
    expect(en.ambience.theme[theme.id]).toBeTruthy();
    if (!theme.scene) return;
    const scene = getScene(theme.scene);
    expect(scene).toBeTruthy();
    const keys = new Set(scene.params.map((p) => p.key));
    for (const key of Object.keys(theme.sceneParams)) expect(keys).toContain(key);
    for (const k of ['bg', 'surface', 'text', 'accent']) expect(theme.palette[k]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  test('normalizeTheme bounds glass values and fills defaults', () => {
    const th = normalizeTheme({ id: 'x', glass: { panel: 5, blur: -3, scrim: 'oops' } });
    expect(th.glass.panel).toBe(1);
    expect(th.glass.blur).toBe(0);
    expect(Number.isFinite(th.glass.scrim)).toBe(true);
    expect(th.terminal).toBe('auto');
  });
});

describe('scenes', () => {
  test.each(SCENES.map((s) => [s.id, s]))('%s declares a usable params schema and a name', (_id, scene) => {
    expect(typeof scene.create).toBe('function');
    expect(en.ambience.scene[scene.id]).toBeTruthy();
    for (const p of scene.params) {
      expect(['color', 'range', 'toggle', 'text']).toContain(p.type);
      expect(en.ambience.param[p.key]).toBeTruthy();
      if (p.type === 'color') expect(p.default).toMatch(/^#[0-9a-f]{6}$/i);
      if (p.type === 'range') {
        expect(p.min).toBeLessThan(p.max);
        expect(p.default).toBeGreaterThanOrEqual(p.min);
        expect(p.default).toBeLessThanOrEqual(p.max);
      }
    }
  });
});
