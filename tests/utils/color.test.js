const { hexToRgb, rgbToHex, lightenColor, darkenColor, sanitizeColor, ACCENT_COLORS, resolveTheme, applyTheme } = require('../../src/renderer/utils/color');

describe('hexToRgb', () => {
  test('#ff0000 returns {r:255, g:0, b:0}', () => {
    expect(hexToRgb('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
  });

  test('ff0000 without # returns {r:255, g:0, b:0}', () => {
    expect(hexToRgb('ff0000')).toEqual({ r: 255, g: 0, b: 0 });
  });

  test('#000000 returns {r:0, g:0, b:0}', () => {
    expect(hexToRgb('#000000')).toEqual({ r: 0, g: 0, b: 0 });
  });

  test('#ffffff returns {r:255, g:255, b:255}', () => {
    expect(hexToRgb('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
  });

  test('"invalid" returns null', () => {
    expect(hexToRgb('invalid')).toBeNull();
  });

  test('empty string returns null', () => {
    expect(hexToRgb('')).toBeNull();
  });
});

describe('rgbToHex', () => {
  test('(255, 0, 0) returns "#ff0000"', () => {
    expect(rgbToHex(255, 0, 0)).toBe('#ff0000');
  });

  test('(0, 0, 0) returns "#000000"', () => {
    expect(rgbToHex(0, 0, 0)).toBe('#000000');
  });

  test('(255, 255, 255) returns "#ffffff"', () => {
    expect(rgbToHex(255, 255, 255)).toBe('#ffffff');
  });

  test('clamping: (300, -5, 0) returns "#ff0000"', () => {
    expect(rgbToHex(300, -5, 0)).toBe('#ff0000');
  });
});

describe('lightenColor', () => {
  test('#000000 lightened 50% gives medium grey', () => {
    const result = lightenColor('#000000', 50);
    // 0 + (255 - 0) * 50/100 = 127 → floor = 127
    expect(result).toBe('#7f7f7f');
  });

  test('#ff0000 lightened 0% stays #ff0000', () => {
    expect(lightenColor('#ff0000', 0)).toBe('#ff0000');
  });

  test('invalid hex returns the input unchanged', () => {
    expect(lightenColor('invalid', 50)).toBe('invalid');
  });

  test('#000000 lightened 100% gives #ffffff', () => {
    expect(lightenColor('#000000', 100)).toBe('#ffffff');
  });
});

describe('darkenColor', () => {
  test('#ffffff darkened 50% gives medium grey', () => {
    const result = darkenColor('#ffffff', 50);
    // 255 * (100 - 50) / 100 = 127 → floor = 127
    expect(result).toBe('#7f7f7f');
  });

  test('#ff0000 darkened 0% stays #ff0000', () => {
    expect(darkenColor('#ff0000', 0)).toBe('#ff0000');
  });

  test('#ffffff darkened 100% gives #000000', () => {
    expect(darkenColor('#ffffff', 100)).toBe('#000000');
  });

  test('invalid hex returns the input unchanged', () => {
    expect(darkenColor('invalid', 50)).toBe('invalid');
  });
});

describe('sanitizeColor', () => {
  test('accepts valid #rrggbb', () => {
    expect(sanitizeColor('#d97706')).toBe('#d97706');
  });

  test('accepts valid #rgb', () => {
    expect(sanitizeColor('#f00')).toBe('#f00');
  });

  test('accepts valid #rrggbbaa', () => {
    expect(sanitizeColor('#d97706ff')).toBe('#d97706ff');
  });

  test('accepts valid #rgba', () => {
    expect(sanitizeColor('#f00a')).toBe('#f00a');
  });

  test('rejects hex without #', () => {
    expect(sanitizeColor('d97706')).toBe('');
  });

  test('rejects empty string', () => {
    expect(sanitizeColor('')).toBe('');
  });

  test('rejects non-string (number)', () => {
    expect(sanitizeColor(123)).toBe('');
  });

  test('rejects null', () => {
    expect(sanitizeColor(null)).toBe('');
  });

  test('rejects undefined', () => {
    expect(sanitizeColor(undefined)).toBe('');
  });

  test('rejects CSS expression (injection)', () => {
    expect(sanitizeColor('expression(alert(1))')).toBe('');
  });

  test('rejects url() value', () => {
    expect(sanitizeColor('url(javascript:alert(1))')).toBe('');
  });

  test('rejects rgb() value', () => {
    expect(sanitizeColor('rgb(255,0,0)')).toBe('');
  });

  test('rejects color name', () => {
    expect(sanitizeColor('red')).toBe('');
  });

  test('trims whitespace around valid color', () => {
    expect(sanitizeColor('  #ff0000  ')).toBe('#ff0000');
  });

  test('rejects too-long hex', () => {
    expect(sanitizeColor('#ff00ff00ff')).toBe('');
  });
});

describe('theme', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    window.matchMedia = jest.fn().mockImplementation(q => ({
      matches: false, media: q, addEventListener: jest.fn(), removeEventListener: jest.fn(),
    }));
  });

  test('resolveTheme returns explicit values unchanged', () => {
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
  });

  test('resolveTheme maps system to dark when OS is not light', () => {
    expect(resolveTheme('system')).toBe('dark');
  });

  test('resolveTheme maps system to light when OS prefers light', () => {
    window.matchMedia = jest.fn().mockImplementation(q => ({ matches: true, addEventListener: jest.fn() }));
    expect(resolveTheme('system')).toBe('light');
  });

  test('resolveTheme falls back to dark on bad input', () => {
    expect(resolveTheme('bogus')).toBe('dark');
  });

  test('applyTheme sets data-theme on documentElement and returns resolved', () => {
    expect(applyTheme('light')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('ACCENT_COLORS', () => {
  test('is an array of 10 items', () => {
    expect(ACCENT_COLORS).toHaveLength(10);
  });

  test('each item has name and hex properties', () => {
    ACCENT_COLORS.forEach(color => {
      expect(color).toHaveProperty('name');
      expect(color).toHaveProperty('hex');
      expect(typeof color.name).toBe('string');
      expect(color.hex).toMatch(/^#[0-9a-f]{6}$/);
    });
  });
});
