/**
 * Guards the gap the coherence suite cannot see.
 *
 * i18n-coherence.test.js compares the locale files against EACH OTHER, so three
 * files that are perfectly in sync still pass while the code calls t() with a
 * key none of them define. Those render as a raw dot-path in the UI — users saw
 * literal "chat.slashPlan" in the chat menu, and "cloud.networkErrorTitle" in a
 * toast, for exactly this reason.
 *
 * This scans the renderer for literal t('a.b') calls and asserts every key
 * exists in en.json (the reference locale, and the runtime fallback source).
 */
const fs = require('fs');
const path = require('path');

const RENDERER_DIR = path.resolve(__dirname, '../../src/renderer');
const ENTRY_FILE = path.resolve(__dirname, '../../renderer.js');
const EN = require('../../src/renderer/i18n/locales/en.json');

/** Keys built at runtime by concatenation, e.g. t('workflow.widget.' + type). */
const DYNAMIC_PREFIXES = ['workflow.widget.'];

function flatten(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? flatten(v, `${prefix}${k}.`)
      : [`${prefix}${k}`]
  );
}

function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'locales') continue;
      out.push(...collectJsFiles(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

describe('i18n usage — every t() key exists', () => {
  const known = new Set(flatten(EN));
  const files = [...collectJsFiles(RENDERER_DIR), ENTRY_FILE];

  test('scan covers the renderer (guards against a broken glob)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(known.size).toBeGreaterThan(1000);
  });

  test('no t() call references a key missing from en.json', () => {
    const missing = new Map();

    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const match of src.matchAll(/\bt\(\s*'([a-zA-Z][\w.]*\.[\w.]+)'/g)) {
        const key = match[1];
        if (known.has(key)) continue;
        if (DYNAMIC_PREFIXES.some(p => key === p || key.startsWith(p))) continue;
        if (!missing.has(key)) missing.set(key, new Set());
        missing.get(key).add(path.relative(process.cwd(), file));
      }
    }

    const report = [...missing].map(([key, where]) => `${key}  <- ${[...where].join(', ')}`);
    expect(report).toEqual([]);
  });
});
