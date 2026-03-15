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

describe('i18n coherence — main locales', () => {
  let enData, frData, enKeys, frKeys;
  let enRaw, frRaw;

  beforeAll(() => {
    enRaw = fs.readFileSync(path.join(mainLocalesDir, 'en.json'), 'utf8');
    frRaw = fs.readFileSync(path.join(mainLocalesDir, 'fr.json'), 'utf8');
    enData = JSON.parse(enRaw);
    frData = JSON.parse(frRaw);
    enKeys = extractKeys(enData);
    frKeys = extractKeys(frData);
  });

  test('en.json and fr.json both load as valid JSON', () => {
    expect(enData).toBeDefined();
    expect(frData).toBeDefined();
    expect(typeof enData).toBe('object');
    expect(typeof frData).toBe('object');
  });

  test('every key in en.json exists in fr.json', () => {
    const frKeySet = new Set(frKeys);
    const missingInFr = enKeys.filter(k => !frKeySet.has(k));
    if (missingInFr.length > 0) {
      // Report missing keys for debugging
      console.warn(`Keys in en.json missing from fr.json (${missingInFr.length}):\n  ${missingInFr.slice(0, 20).join('\n  ')}${missingInFr.length > 20 ? '\n  ...' : ''}`);
    }
    expect(missingInFr).toEqual([]);
  });

  test('every key in fr.json exists in en.json', () => {
    const enKeySet = new Set(enKeys);
    const missingInEn = frKeys.filter(k => !enKeySet.has(k));
    if (missingInEn.length > 0) {
      console.warn(`Keys in fr.json missing from en.json (${missingInEn.length}):\n  ${missingInEn.slice(0, 20).join('\n  ')}${missingInEn.length > 20 ? '\n  ...' : ''}`);
    }
    expect(missingInEn).toEqual([]);
  });

  test('no empty string values in en.json', () => {
    const emptyKeys = enKeys.filter(k => getValueAtPath(enData, k) === '');
    if (emptyKeys.length > 0) {
      console.warn(`Empty values in en.json:\n  ${emptyKeys.join('\n  ')}`);
    }
    expect(emptyKeys).toEqual([]);
  });

  test('no empty string values in fr.json', () => {
    const emptyKeys = frKeys.filter(k => getValueAtPath(frData, k) === '');
    if (emptyKeys.length > 0) {
      console.warn(`Empty values in fr.json:\n  ${emptyKeys.join('\n  ')}`);
    }
    expect(emptyKeys).toEqual([]);
  });

  test('no duplicate keys in en.json', () => {
    const dups = findDuplicateKeysInJson(enRaw);
    expect(dups).toEqual([]);
  });

  test('no duplicate keys in fr.json', () => {
    const dups = findDuplicateKeysInJson(frRaw);
    expect(dups).toEqual([]);
  });

  test('both locales have a reasonable number of keys (>100)', () => {
    expect(enKeys.length).toBeGreaterThan(100);
    expect(frKeys.length).toBeGreaterThan(100);
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
