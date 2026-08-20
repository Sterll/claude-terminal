const {
  t,
  setLanguage,
  getCurrentLanguage,
  initI18n,
  detectSystemLanguage,
  matchSupportedLanguage,
  getAvailableLanguages,
  getLanguageName,
  mergeTranslations,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  i18nState
} = require('../../src/renderer/i18n/index');

beforeEach(() => {
  // Reset to default language
  setLanguage(DEFAULT_LANGUAGE);
});

// ── t() ──

describe('t()', () => {
  test('resolves dot-notation key', () => {
    const result = t('common.close');
    expect(typeof result).toBe('string');
    expect(result).not.toBe('common.close'); // should not fall back to key
  });

  test('returns key path as fallback for missing key', () => {
    const result = t('nonexistent.key.path');
    expect(result).toBe('nonexistent.key.path');
  });

  test('interpolates {variable} placeholders', () => {
    // Find a key that uses interpolation in the current language
    setLanguage('en');
    const result = t('chat.suggestGit', { count: 5 });
    expect(result).toContain('5');
    expect(result).not.toContain('{count}');
  });

  test('leaves unmatched placeholders as-is', () => {
    setLanguage('en');
    // Use a key with interpolation but pass wrong param name
    const result = t('chat.suggestGit', { wrong: 99 });
    expect(result).toContain('{count}');
  });

  test('works without params on non-interpolated keys', () => {
    const result = t('common.close');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('returns key path for non-string value (nested object)', () => {
    // 'common' resolves to an object, not a string
    const result = t('common');
    expect(result).toBe('common');
  });
});

// ── setLanguage / getCurrentLanguage ──

describe('setLanguage', () => {
  test('switches to English', () => {
    setLanguage('en');
    expect(getCurrentLanguage()).toBe('en');
  });

  test('switches to French', () => {
    setLanguage('fr');
    expect(getCurrentLanguage()).toBe('fr');
  });

  test('switches to Spanish', () => {
    setLanguage('es');
    expect(getCurrentLanguage()).toBe('es');
  });

  test('falls back to default for unsupported language', () => {
    setLanguage('zh');
    expect(getCurrentLanguage()).toBe(DEFAULT_LANGUAGE);
  });

  test('translations change after language switch', () => {
    setLanguage('en');
    const en = t('common.close');
    setLanguage('fr');
    const fr = t('common.close');
    // The translations should differ between languages
    expect(en).not.toBe(fr);
  });
});

// ── initI18n ──

describe('initI18n', () => {
  test('uses saved language when valid', () => {
    initI18n('en');
    expect(getCurrentLanguage()).toBe('en');
  });

  test('ignores invalid saved language and auto-detects', () => {
    initI18n('xx');
    // Should fall back to auto-detected or default
    expect(SUPPORTED_LANGUAGES).toContain(getCurrentLanguage());
  });

  test('auto-detects when null passed', () => {
    initI18n(null);
    expect(SUPPORTED_LANGUAGES).toContain(getCurrentLanguage());
  });
});

// ── detectSystemLanguage ──

describe('detectSystemLanguage', () => {
  const originalNavigator = global.navigator;

  afterEach(() => {
    Object.defineProperty(global, 'navigator', { value: originalNavigator, writable: true });
  });

  test('extracts language code from navigator.language', () => {
    Object.defineProperty(global, 'navigator', {
      value: { language: 'fr-FR' },
      writable: true,
    });
    expect(detectSystemLanguage()).toBe('fr');
  });

  test('returns en for English navigator', () => {
    Object.defineProperty(global, 'navigator', {
      value: { language: 'en-US' },
      writable: true,
    });
    expect(detectSystemLanguage()).toBe('en');
  });

  test('returns en for unsupported language', () => {
    Object.defineProperty(global, 'navigator', {
      value: { language: 'ja-JP' },
      writable: true,
    });
    expect(detectSystemLanguage()).toBe('en');
  });

  test('falls back to the primary subtag when the region is not a locale', () => {
    // 'fr-CA' has no dedicated locale, so it must resolve to plain 'fr'.
    Object.defineProperty(global, 'navigator', {
      value: { language: 'fr-CA' },
      writable: true,
    });
    expect(detectSystemLanguage()).toBe('fr');
  });
});

// ── matchSupportedLanguage ──

describe('matchSupportedLanguage', () => {
  test('matches a plain code', () => {
    expect(matchSupportedLanguage('fr')).toBe('fr');
  });

  test('matches a regional tag on its primary subtag', () => {
    expect(matchSupportedLanguage('es-MX')).toBe('es');
  });

  test('is case insensitive', () => {
    expect(matchSupportedLanguage('FR-fr')).toBe('fr');
  });

  test('returns null for unsupported and empty input', () => {
    expect(matchSupportedLanguage('ja')).toBeNull();
    expect(matchSupportedLanguage('')).toBeNull();
    expect(matchSupportedLanguage(null)).toBeNull();
    expect(matchSupportedLanguage(undefined)).toBeNull();
  });

  describe('with regional locales registered', () => {
    // SUPPORTED_LANGUAGES is exported by reference and read on every call, so
    // registering variants here exercises the real resolution order.
    beforeEach(() => SUPPORTED_LANGUAGES.push('zh-CN', 'zh-TW'));
    afterEach(() => SUPPORTED_LANGUAGES.splice(SUPPORTED_LANGUAGES.indexOf('zh-CN'), 2));

    test('resolves a script-specific locale exactly', () => {
      // The zh-CN / zh-TW case: these are different translations, so the tag
      // must not be collapsed onto a generic 'zh' that no locale file matches.
      expect(matchSupportedLanguage('zh-CN')).toBe('zh-CN');
      expect(matchSupportedLanguage('zh-TW')).toBe('zh-TW');
    });

    test('normalizes the region casing before matching', () => {
      expect(matchSupportedLanguage('zh-cn')).toBe('zh-CN');
    });

    test('does not match a bare primary subtag that has no locale of its own', () => {
      expect(matchSupportedLanguage('zh')).toBeNull();
    });

    test('an unregistered region still falls back to the primary subtag', () => {
      expect(matchSupportedLanguage('fr-BE')).toBe('fr');
    });
  });
});

// ── getAvailableLanguages ──

describe('getAvailableLanguages', () => {
  test('returns array of supported languages', () => {
    const langs = getAvailableLanguages();
    expect(langs).toHaveLength(SUPPORTED_LANGUAGES.length);
    langs.forEach(lang => {
      expect(lang).toHaveProperty('code');
      expect(lang).toHaveProperty('name');
      expect(SUPPORTED_LANGUAGES).toContain(lang.code);
    });
  });
});

// ── getLanguageName ──

describe('getLanguageName', () => {
  test('returns name for valid language code', () => {
    const name = getLanguageName('en');
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });

  test('returns code for unknown language', () => {
    expect(getLanguageName('xx')).toBe('xx');
  });
});

// ── mergeTranslations ──

describe('mergeTranslations', () => {
  test('merges new keys into existing locale', () => {
    mergeTranslations('en', { custom: { testKey: 'test value' } });
    setLanguage('en');
    expect(t('custom.testKey')).toBe('test value');
  });

  test('does nothing for unknown locale', () => {
    // Should not throw
    mergeTranslations('xx', { foo: 'bar' });
  });

  test('refreshes current translations if merging active language', () => {
    setLanguage('en');
    mergeTranslations('en', { custom: { liveKey: 'live' } });
    expect(t('custom.liveKey')).toBe('live');
  });
});
