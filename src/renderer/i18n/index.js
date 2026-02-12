/**
 * Internationalization (i18n) Module
 * Handles language detection, loading, and translation
 */

const { State } = require('../state/State');

// Supported languages
const SUPPORTED_LANGUAGES = ['fr', 'en'];
const DEFAULT_LANGUAGE = 'fr';

// Load locale files
const locales = {
  fr: require('./locales/fr.json'),
  en: require('./locales/en.json')
};

// Current language state
const i18nState = new State({
  currentLanguage: DEFAULT_LANGUAGE,
  translations: locales[DEFAULT_LANGUAGE]
});

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

  i18nState.set({
    currentLanguage: langCode,
    translations: locales[langCode]
  });
}

/**
 * Get the current language code
 * @returns {string}
 */
function getCurrentLanguage() {
  return i18nState.get().currentLanguage;
}

/**
 * Get translation by key path (e.g., 'common.close')
 * Supports interpolation with {variable} syntax
 * @param {string} keyPath - Dot-separated key path
 * @param {Object} params - Optional parameters for interpolation
 * @returns {string}
 */
function t(keyPath, params = {}) {
  const translations = i18nState.get().translations;
  const keys = keyPath.split('.');

  let value = translations;
  for (const key of keys) {
    if (value && typeof value === 'object' && key in value) {
      value = value[key];
    } else {
      // Key not found, return the key path as fallback
      console.warn(`[i18n] Missing translation: ${keyPath}`);
      return keyPath;
    }
  }

  if (typeof value !== 'string') {
    console.warn(`[i18n] Translation is not a string: ${keyPath}`);
    return keyPath;
  }

  // Interpolate parameters
  if (Object.keys(params).length > 0) {
    return value.replace(/\{(\w+)\}/g, (match, key) => {
      return params[key] !== undefined ? params[key] : match;
    });
  }

  return value;
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
    name: locales[code].language.name
  }));
}

/**
 * Get language name by code
 * @param {string} code
 * @returns {string}
 */
function getLanguageName(code) {
  return locales[code]?.language?.name || code;
}

/**
 * Deep merge translations into a locale
 * @param {string} langCode - Language code (fr or en)
 * @param {Object} newTranslations - Translations to merge (deep)
 */
function mergeTranslations(langCode, newTranslations) {
  if (!locales[langCode]) return;

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

  deepMerge(locales[langCode], newTranslations);

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
