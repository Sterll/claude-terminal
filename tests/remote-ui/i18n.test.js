/**
 * The PWA ships its own translations, separate from the desktop's locale files
 * and not covered by their coherence check. A key added to one language and
 * forgotten in another falls back to English silently, so nothing surfaces the
 * gap until a user sees it.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'remote-ui', 'i18n.js'), 'utf8');

/** Slice the source into one key set per language block. */
function keysByLang() {
  const marks = [...SRC.matchAll(/^ {2}(fr|en|es|id): \{/gm)].map(m => ({ lang: m[1], idx: m.index }));
  expect(marks.length).toBeGreaterThan(1);
  marks.push({ lang: null, idx: SRC.length });

  const out = {};
  for (let i = 0; i < marks.length - 1; i++) {
    const chunk = SRC.slice(marks[i].idx, marks[i + 1].idx);
    out[marks[i].lang] = [...chunk.matchAll(/^\s*'([^']+)':/gm)].map(m => m[1]);
  }
  return out;
}

describe('PWA translations', () => {
  const langs = keysByLang();

  test('declares every supported language', () => {
    const supported = SRC.match(/const SUPPORTED_LANGS = \[([^\]]+)\]/)[1]
      .split(',').map(s => s.trim().replace(/'/g, ''));
    expect(Object.keys(langs).sort()).toEqual([...supported].sort());
  });

  test.each(Object.keys(langs))('%s has no duplicate keys', (lang) => {
    const seen = new Set();
    const dupes = langs[lang].filter(k => seen.size === seen.add(k).size);
    expect(dupes).toEqual([]);
  });

  test.each(Object.keys(langs).filter(l => l !== 'en'))('%s covers every English key', (lang) => {
    const here = new Set(langs[lang]);
    expect(langs.en.filter(k => !here.has(k))).toEqual([]);
  });

  test.each(Object.keys(langs).filter(l => l !== 'en'))('%s adds no key English lacks', (lang) => {
    const en = new Set(langs.en);
    expect(langs[lang].filter(k => !en.has(k))).toEqual([]);
  });

  test('every key used by app.js exists', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', '..', 'remote-ui', 'app.js'), 'utf8');
    const used = new Set([...app.matchAll(/\bt\('([^']+)'/g)].map(m => m[1]));
    const en = new Set(langs.en);
    expect([...used].filter(k => !en.has(k))).toEqual([]);
  });

  test('every data-i18n attribute in index.html exists', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'remote-ui', 'index.html'), 'utf8');
    const used = new Set([...html.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]));
    const en = new Set(langs.en);
    expect([...used].filter(k => !en.has(k))).toEqual([]);
  });
});
