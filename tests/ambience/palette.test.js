const { deriveTokens, deriveTerminalTheme, contrast, mixHex, ensureContrast } = require('../../src/renderer/ambience/palette');
const { BUILTIN_THEMES } = require('../../src/renderer/ambience/themes');

describe('palette derivation', () => {
  test('mixHex blends towards the second colour', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  test('ensureContrast reaches the ratio against every background', () => {
    const out = ensureContrast('#333333', '#ffffff', ['#111111', '#1a1a1a'], 4.5);
    expect(contrast(out, '#111111')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(out, '#1a1a1a')).toBeGreaterThanOrEqual(4.5);
  });

  test('a palette that would make muted text unreadable is corrected', () => {
    const tokens = deriveTokens({ bg: '#202020', surface: '#2a2a2a', text: '#5a5a5a', accent: '#ff0000' });
    for (const name of ['--text-secondary', '--text-tertiary', '--text-muted']) {
      for (const bg of ['--bg-primary', '--bg-secondary', '--bg-tertiary']) {
        expect(contrast(tokens[name], tokens[bg])).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test('invalid colours fall back instead of producing NaN tokens', () => {
    const tokens = deriveTokens({ bg: 'nope', surface: '', text: null, accent: 'red' });
    for (const value of Object.values(tokens)) expect(String(value)).not.toMatch(/NaN|undefined/);
  });

  test.each(BUILTIN_THEMES.filter((th) => th.palette).map((th) => [th.id, th]))(
    'built-in theme %s keeps every text step at WCAG AA', (_id, theme) => {
      const tokens = deriveTokens(theme.palette);
      for (const name of ['--text-primary', '--text-secondary', '--text-tertiary', '--text-muted']) {
        for (const bg of ['--bg-primary', '--bg-secondary', '--bg-tertiary']) {
          expect(contrast(tokens[name], tokens[bg])).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

  test('derived terminal theme has readable ANSI colours and every slot filled', () => {
    const th = deriveTerminalTheme({ bg: '#070b1d', surface: '#0f1630', text: '#e4e9ff', accent: '#8ab4ff' });
    for (const key of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'brightRed', 'brightWhite', 'black', 'white']) {
      expect(th[key]).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(contrast(th.red, th.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(th.foreground, th.background)).toBeGreaterThanOrEqual(7);
  });
});
