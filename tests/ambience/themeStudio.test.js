const { parseImportedTheme, exportable } = require('../../src/renderer/ui/panels/ThemeStudio');

const valid = {
  name: 'Mine',
  scene: 'ocean',
  sceneParams: { skyTop: '#112233', stars: 9, moon: 0, bogus: 'x', waterTop: 'javascript:alert(1)' },
  palette: { bg: '#000000', surface: '#111111', text: '#eeeeee', accent: '#ff8800' },
  glass: { panel: 0.5 },
  sound: 'rain',
};

describe('theme import', () => {
  test('a valid theme imports as a fresh custom theme', () => {
    const th = parseImportedTheme(JSON.stringify(valid));
    expect(th.custom).toBe(true);
    expect(th.id).toMatch(/^custom-/);
    expect(th.scene).toBe('ocean');
    expect(th.sound).toBe('rain');
  });

  test('scene params are filtered to the schema, clamped and colour-checked', () => {
    const th = parseImportedTheme(valid);
    expect(th.sceneParams.skyTop).toBe('#112233');
    expect(th.sceneParams.stars).toBe(1);
    expect(th.sceneParams.moon).toBe(false);
    expect(th.sceneParams).not.toHaveProperty('bogus');
    expect(th.sceneParams).not.toHaveProperty('waterTop');
  });

  test('a palette colour that is not strict hex is refused', () => {
    expect(() => parseImportedTheme({ ...valid, palette: { ...valid.palette, bg: 'red;}' } })).toThrow();
  });

  test('an unknown scene is refused, an unknown sound dropped', () => {
    expect(() => parseImportedTheme({ ...valid, scene: 'nope' })).toThrow();
    expect(parseImportedTheme({ ...valid, sound: 'nope' }).sound).toBeNull();
  });

  test('export round-trips through import', () => {
    const th = parseImportedTheme(valid);
    const again = parseImportedTheme(JSON.stringify(exportable(th)));
    expect(again.palette).toEqual(th.palette);
    expect(again.sceneParams).toEqual(th.sceneParams);
    expect(again.glass).toEqual(th.glass);
  });
});
