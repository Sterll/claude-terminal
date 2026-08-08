const fs = require('fs');
const path = require('path');

/**
 * Recursively extract all keys from a nested object, returning dot-notation paths.
 * @param {Object} obj
 * @param {string} prefix
 * @returns {string[]}
 */
function extractKeys(obj, prefix = '') {
  const keys = [];
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      keys.push(...extractKeys(obj[key], fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

/**
 * Get the value at a dot-notation path in a nested object.
 * @param {Object} obj
 * @param {string} dotPath
 * @returns {*}
 */
function getValueAtPath(obj, dotPath) {
  return dotPath.split('.').reduce((acc, part) => acc?.[part], obj);
}

/**
 * Check for duplicate keys at every nesting level.
 * JSON.parse won't actually duplicate keys (last one wins), but we can
 * parse the raw text to find them.
 * @param {string} jsonString
 * @returns {string[]} list of duplicate key paths
 */
function findDuplicateKeysInJson(jsonString) {
  const duplicates = [];
  const keyStack = [];

  // Track keys at each nesting level
  const seenAtLevel = [new Set()];

  let inString = false;
  let escaped = false;
  let currentKey = '';
  let readingKey = false;
  let depth = 0;

  // Simple state-machine approach: find all "key": patterns
  // This is a simplified duplicate detector
  const lines = jsonString.split('\n');
  const levelKeys = new Map(); // depth -> Set of keys

  for (const line of lines) {
    const trimmed = line.trim();
    // Match "key": pattern
    const match = trimmed.match(/^"([^"]+)"\s*:/);
    if (match) {
      const key = match[1];
      if (!levelKeys.has(depth)) {
        levelKeys.set(depth, new Map());
      }
      const keysAtDepth = levelKeys.get(depth);
      if (keysAtDepth.has(key)) {
        keysAtDepth.set(key, keysAtDepth.get(key) + 1);
      } else {
        keysAtDepth.set(key, 1);
      }
    }

    // Track depth changes
    for (const ch of trimmed) {
      if (ch === '{') {
        depth++;
        if (!levelKeys.has(depth)) levelKeys.set(depth, new Map());
      } else if (ch === '}') {
        // Check for duplicates at this level before leaving
        if (levelKeys.has(depth)) {
          for (const [k, count] of levelKeys.get(depth)) {
            if (count > 1) {
              duplicates.push(`depth=${depth}, key="${k}" appears ${count} times`);
            }
          }
          levelKeys.delete(depth);
        }
        depth--;
      }
    }
  }

  return duplicates;
}

// ── Main i18n locale files ──

const mainLocalesDir = path.resolve(__dirname, '../../src/renderer/i18n/locales');
const projectTypesDir = path.resolve(__dirname, '../../src/project-types');

// The locale every other locale is compared against.
const REFERENCE_LOCALE = 'en';

/**
 * Enumerate every locale shipped in the main locales directory.
 * Done at module load (not in beforeAll) so `test.each` can build cases.
 * @returns {string[]} locale codes, e.g. ['en', 'es', 'fr']
 */
function discoverLocales() {
  return fs.readdirSync(mainLocalesDir)
    .filter(f => f.endsWith('.json'))
    .map(f => path.basename(f, '.json'))
    .sort();
}

const allLocales = discoverLocales();
const otherLocales = allLocales.filter(l => l !== REFERENCE_LOCALE);

/** Read + parse a locale, returning its raw text, data and key list. */
function loadLocale(locale) {
  const raw = fs.readFileSync(path.join(mainLocalesDir, `${locale}.json`), 'utf8');
  const data = JSON.parse(raw);
  return { raw, data, keys: extractKeys(data) };
}

describe('i18n coherence — main locales', () => {
  const loaded = {};

  beforeAll(() => {
    for (const locale of allLocales) {
      loaded[locale] = loadLocale(locale);
    }
  });

  test('the reference locale exists and other locales were discovered', () => {
    expect(allLocales).toContain(REFERENCE_LOCALE);
    expect(otherLocales.length).toBeGreaterThan(0);
  });

  test.each(allLocales)('%s.json loads as valid JSON', (locale) => {
    expect(loaded[locale].data).toBeDefined();
    expect(typeof loaded[locale].data).toBe('object');
  });

  test.each(otherLocales)('every key in en.json exists in %s.json', (locale) => {
    const localeKeySet = new Set(loaded[locale].keys);
    const missing = loaded[REFERENCE_LOCALE].keys.filter(k => !localeKeySet.has(k));
    if (missing.length > 0) {
      // Report missing keys for debugging
      console.warn(`Keys in ${REFERENCE_LOCALE}.json missing from ${locale}.json (${missing.length}):\n  ${missing.slice(0, 20).join('\n  ')}${missing.length > 20 ? '\n  ...' : ''}`);
    }
    expect(missing).toEqual([]);
  });

  test.each(otherLocales)('every key in %s.json exists in en.json', (locale) => {
    const referenceKeySet = new Set(loaded[REFERENCE_LOCALE].keys);
    const extra = loaded[locale].keys.filter(k => !referenceKeySet.has(k));
    if (extra.length > 0) {
      console.warn(`Keys in ${locale}.json missing from ${REFERENCE_LOCALE}.json (${extra.length}):\n  ${extra.slice(0, 20).join('\n  ')}${extra.length > 20 ? '\n  ...' : ''}`);
    }
    expect(extra).toEqual([]);
  });

  test.each(allLocales)('no empty string values in %s.json', (locale) => {
    const { data, keys } = loaded[locale];
    const emptyKeys = keys.filter(k => getValueAtPath(data, k) === '');
    if (emptyKeys.length > 0) {
      console.warn(`Empty values in ${locale}.json:\n  ${emptyKeys.join('\n  ')}`);
    }
    expect(emptyKeys).toEqual([]);
  });

  test.each(allLocales)('no duplicate keys in %s.json', (locale) => {
    const dups = findDuplicateKeysInJson(loaded[locale].raw);
    expect(dups).toEqual([]);
  });

  test.each(allLocales)('%s.json has a reasonable number of keys (>100)', (locale) => {
    expect(loaded[locale].keys.length).toBeGreaterThan(100);
  });
});

// ── Project-type i18n files ──

describe('i18n coherence — project types', () => {
  const projectTypes = [];

  beforeAll(() => {
    // Discover project types with i18n directories
    if (!fs.existsSync(projectTypesDir)) return;
    const dirs = fs.readdirSync(projectTypesDir);
    for (const dir of dirs) {
      const i18nDir = path.join(projectTypesDir, dir, 'i18n');
      const enFile = path.join(i18nDir, 'en.json');
      const frFile = path.join(i18nDir, 'fr.json');
      if (fs.existsSync(enFile) && fs.existsSync(frFile)) {
        projectTypes.push({
          name: dir,
          enFile,
          frFile
        });
      }
    }
  });

  test('at least one project type has i18n files', () => {
    expect(projectTypes.length).toBeGreaterThan(0);
  });

  test.each([
    'api', 'fivem', 'minecraft', 'python', 'webapp'
  ])('%s: every en.json key exists in fr.json', (typeName) => {
    const enFile = path.join(projectTypesDir, typeName, 'i18n', 'en.json');
    const frFile = path.join(projectTypesDir, typeName, 'i18n', 'fr.json');

    if (!fs.existsSync(enFile) || !fs.existsSync(frFile)) {
      // Skip if files don't exist
      return;
    }

    const enData = JSON.parse(fs.readFileSync(enFile, 'utf8'));
    const frData = JSON.parse(fs.readFileSync(frFile, 'utf8'));
    const enKeys = extractKeys(enData);
    const frKeySet = new Set(extractKeys(frData));

    const missingInFr = enKeys.filter(k => !frKeySet.has(k));
    if (missingInFr.length > 0) {
      console.warn(`[${typeName}] Keys in en.json missing from fr.json:\n  ${missingInFr.join('\n  ')}`);
    }
    expect(missingInFr).toEqual([]);
  });

  test.each([
    'api', 'fivem', 'minecraft', 'python', 'webapp'
  ])('%s: every fr.json key exists in en.json', (typeName) => {
    const enFile = path.join(projectTypesDir, typeName, 'i18n', 'en.json');
    const frFile = path.join(projectTypesDir, typeName, 'i18n', 'fr.json');

    if (!fs.existsSync(enFile) || !fs.existsSync(frFile)) {
      return;
    }

    const enData = JSON.parse(fs.readFileSync(enFile, 'utf8'));
    const frData = JSON.parse(fs.readFileSync(frFile, 'utf8'));
    const frKeys = extractKeys(frData);
    const enKeySet = new Set(extractKeys(enData));

    const missingInEn = frKeys.filter(k => !enKeySet.has(k));
    if (missingInEn.length > 0) {
      console.warn(`[${typeName}] Keys in fr.json missing from en.json:\n  ${missingInEn.join('\n  ')}`);
    }
    expect(missingInEn).toEqual([]);
  });

  test.each([
    'api', 'fivem', 'minecraft', 'python', 'webapp'
  ])('%s: no empty string values', (typeName) => {
    const enFile = path.join(projectTypesDir, typeName, 'i18n', 'en.json');
    const frFile = path.join(projectTypesDir, typeName, 'i18n', 'fr.json');

    if (!fs.existsSync(enFile) || !fs.existsSync(frFile)) {
      return;
    }

    const enData = JSON.parse(fs.readFileSync(enFile, 'utf8'));
    const frData = JSON.parse(fs.readFileSync(frFile, 'utf8'));

    const emptyEn = extractKeys(enData).filter(k => getValueAtPath(enData, k) === '');
    const emptyFr = extractKeys(frData).filter(k => getValueAtPath(frData, k) === '');

    expect(emptyEn).toEqual([]);
    expect(emptyFr).toEqual([]);
  });
});
