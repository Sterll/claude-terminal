/**
 * Internationalization (i18n) Module
 * Handles language detection, loading, and translation
 */

const { State } = require('../state/State');

// Supported languages
const SUPPORTED_LANGUAGES = ['fr', 'en', 'es'];
const DEFAULT_LANGUAGE = 'fr';

// Display names, kept here so the language picker does not have to load every
// locale file just to read `language.name` out of it.
const LANGUAGE_NAMES = {
  fr: 'Français',
  en: 'English',
  es: 'Español'
};

// ── Locale loading ────────────────────────────────────────────────────────
//
// Only English is bundled eagerly. It is the fallback locale used by t() for
// any key missing from the active language, so it has to be available
// synchronously at all times; the other locales are loaded on demand the
// first time they become active (~150 KB of JSON each that most users never
// need).
//
// The on-demand load is *synchronous* on purpose. initI18n() and
// setLanguage() are called from synchronous code (renderer.js, SettingsPanel)
// and every t() call right after them expects the new strings to be there
// already, so an awaited import would have painted a frame of English first.
// In the packaged renderer the JSON is read through the preload fs bridge
// from dist/locales/, which scripts/build-renderer.js copies next to the
// bundle; under Node/Jest it comes straight from the source tree.
const locales = {
  en: require('./locales/en.json')
};

// `module.require` exists under Node/Jest but not in the esbuild browser
// bundle, which lets the source-tree path stay invisible to the bundler (no
// locale JSON is pulled into renderer.bundle.js beyond English).
const _nodeRequire =
  typeof module === 'object' && module !== null && typeof module.require === 'function'
    ? module.require.bind(module)
    : null;

// Project-type translations merged before their locale was loaded.
const _pendingMerges = {};

/**
 * Read a locale JSON that is not bundled with the renderer.
 * @param {string} code - Language code
 * @returns {Object|null} Parsed translations, or null when unavailable
 */
function readLocaleFile(code) {
  // Node / Jest: the locale files sit next to this module.
  if (_nodeRequire) {
    try {
      return _nodeRequire('./locales/' + code + '.json');
    } catch (e) {
      /* fall through to the renderer path */
    }
  }

  // Renderer: read the copy the build placed in dist/locales/.
  try {
    const nodeModules = typeof window !== 'undefined' ? window.electron_nodeModules : null;
    if (!nodeModules || !nodeModules.fs || !nodeModules.path) return null;
    const file = nodeModules.path.join(nodeModules.__dirname, 'dist', 'locales', code + '.json');
    if (nodeModules.fs.existsSync && !nodeModules.fs.existsSync(file)) return null;
    const raw = nodeModules.fs.readFileSync(file, 'utf8');
    if (typeof raw !== 'string' || !raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[i18n] Could not load locale "${code}":`, e && e.message);
    return null;
  }
}

/**
 * Get a locale's translations, loading it on first use.
 * @param {string} code - Language code
 * @returns {Object|null} Translations, or null when the locale is unavailable
 */
function loadLocale(code) {
  if (locales[code]) return locales[code];

  const translations = readLocaleFile(code);
  if (!translations) return null;

  locales[code] = translations;

  // Replay any project-type translations merged before this locale existed.
  const pending = _pendingMerges[code];
  if (pending) {
    delete _pendingMerges[code];
    pending.forEach(extra => deepMerge(translations, extra));
  }

  return translations;
}

// Current language state.
// Starts on the English strings: the active locale is only known once
// initI18n() runs, and English is the guaranteed-loaded fallback.
const i18nState = new State({
  currentLanguage: DEFAULT_LANGUAGE,
  translations: locales.en
});

// Flat translation cache for O(1) lookups (invalidated on language change)
let _tCache = new Map();
let _tCacheLang = null;

/**
 * Swap the active translations and invalidate the lookup cache.
 * The cache must be cleared explicitly: the translations object can change
 * while `currentLanguage` stays the same (locale loaded after the initial
 * English placeholder, or mergeTranslations on the active language).
 * @param {string} langCode
 * @param {Object} translations
 */
function applyTranslations(langCode, translations) {
  _tCache.clear();
  _tCacheLang = langCode;
  i18nState.set({ currentLanguage: langCode, translations });
}

/**
 * Detect system language from navigator or Electron
 * @returns {string} Language code (fr or en)
 */
function detectSystemLanguage() {
  try {
    // Try navigator.language first (works in renderer process)
    let systemLang = navigator.language || navigator.userLanguage || '';

    // Extract language code (e.g., 'fr-FR' -> 'fr')
    const langCode = systemLang.split('-')[0].toLowerCase();

    // Return if supported, otherwise default
    if (SUPPORTED_LANGUAGES.includes(langCode)) {
      return langCode;
    }

    // Fallback to English for unsupported languages
    return 'en';
  } catch (e) {
    console.warn('Could not detect system language:', e);
    return DEFAULT_LANGUAGE;
  }
}

/**
 * Initialize i18n with auto-detection or saved preference
 * @param {string|null} savedLanguage - Previously saved language preference
 */
function initI18n(savedLanguage = null) {
  let language;

  if (savedLanguage && SUPPORTED_LANGUAGES.includes(savedLanguage)) {
    // Use saved preference
    language = savedLanguage;
  } else {
    // Auto-detect from system
    language = detectSystemLanguage();
  }

  setLanguage(language);
}

/**
 * Set the current language
 * @param {string} langCode - Language code (fr or en)
 */
function setLanguage(langCode) {
  if (!SUPPORTED_LANGUAGES.includes(langCode)) {
    console.warn(`[i18n] Unsupported language: ${langCode}, falling back to ${DEFAULT_LANGUAGE}`);
    langCode = DEFAULT_LANGUAGE;
  }

  // If the locale cannot be loaded, keep the selected language but render the
  // English strings - t() would fall back to them key by key anyway.
  const translations = loadLocale(langCode) || locales.en;

  applyTranslations(langCode, translations);
}

/**
 * Get the current language code
 * @returns {string}
 */
function getCurrentLanguage() {
  return i18nState.get().currentLanguage;
}

/**
 * Resolve a dot-separated key path against a translations object.
 * @param {Object} source - Translations object to walk
 * @param {string[]} keys - Pre-split key path segments
 * @returns {string|null} The string value, or null when unresolved
 */
function resolveKeyPath(source, keys) {
  let value = source;
  for (const key of keys) {
    if (value && typeof value === 'object' && key in value) {
      value = value[key];
    } else {
      return null;
    }
  }
  return typeof value === 'string' ? value : null;
}

/**
 * Get translation by key path (e.g., 'common.close')
 * Supports interpolation with {variable} syntax.
 * Missing keys fall back to the English value so an untranslated string
 * degrades to readable English instead of a raw dot-path.
 * @param {string} keyPath - Dot-separated key path
 * @param {Object} params - Optional parameters for interpolation
 * @returns {string}
 */
function t(keyPath, params = {}) {
  const currentLang = i18nState.get().currentLanguage;

  // Invalidate cache on language change
  if (currentLang !== _tCacheLang) {
    _tCache.clear();
    _tCacheLang = currentLang;
  }

  const hasParams = typeof params === 'object' && Object.keys(params).length > 0;

  // Fast path: cached param-free lookups (the vast majority)
  if (!hasParams && _tCache.has(keyPath)) {
    return _tCache.get(keyPath);
  }

  const translations = i18nState.get().translations;
  const keys = keyPath.split('.');

  let value = resolveKeyPath(translations, keys);

  // Fallback 1: the English locale (readable, if untranslated)
  if (value === null && currentLang !== 'en') {
    value = resolveKeyPath(locales.en, keys);
  }

  // Fallback 2 (last resort): the key path itself
  if (value === null) {
    return keyPath;
  }

  // Cache param-free results
  if (!hasParams) {
    _tCache.set(keyPath, value);
    return value;
  }

  // Interpolate parameters
  return value.replace(/\{(\w+)\}/g, (match, key) => {
    return params[key] !== undefined ? params[key] : match;
  });
}

/**
 * Subscribe to language changes
 * @param {Function} listener
 * @returns {Function} Unsubscribe function
 */
function onLanguageChange(listener) {
  return i18nState.subscribe(listener);
}

/**
 * Get all available languages
 * @returns {Array<{code: string, name: string}>}
 */
function getAvailableLanguages() {
  return SUPPORTED_LANGUAGES.map(code => ({
    code,
    name: getLanguageName(code)
  }));
}

/**
 * Get language name by code
 * @param {string} code
 * @returns {string}
 */
function getLanguageName(code) {
  return locales[code]?.language?.name || LANGUAGE_NAMES[code] || code;
}

/**
 * Deep merge `source` into `target`, in place.
 * @param {Object} target
 * @param {Object} source
 */
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

/**
 * Deep merge translations into a locale.
 * Locales that have not been loaded yet (project types register their
 * translations for all three languages at boot) keep the merge queued and
 * replay it when the locale is actually loaded.
 * @param {string} langCode - Language code (fr, en or es)
 * @param {Object} newTranslations - Translations to merge (deep)
 */
function mergeTranslations(langCode, newTranslations) {
  if (!SUPPORTED_LANGUAGES.includes(langCode)) return;

  if (!locales[langCode]) {
    (_pendingMerges[langCode] = _pendingMerges[langCode] || []).push(newTranslations);
    return;
  }

  deepMerge(locales[langCode], newTranslations);

  // Invalidate translation cache
  _tCache.clear();

  // Refresh current translations if this is the active language
  const currentLang = i18nState.get().currentLanguage;
  if (currentLang === langCode) {
    i18nState.setProp('translations', locales[langCode]);
  }
}

module.exports = {
  initI18n,
  setLanguage,
  getCurrentLanguage,
  t,
  onLanguageChange,
  getAvailableLanguages,
  getLanguageName,
  detectSystemLanguage,
  mergeTranslations,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  i18nState
};
