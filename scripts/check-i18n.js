#!/usr/bin/env node
// check-i18n.js — i18n coverage checker for Claude Terminal
// Usage:
//   node scripts/check-i18n.js              # Check all locales (human-readable)
//   node scripts/check-i18n.js --json       # Output JSON (useful for CI/badge generation)
//   node scripts/check-i18n.js --locale=fr  # Check only the 'fr' locale
//
// Exit code: 0 if all locales >= 80% coverage, 1 otherwise.
// Node.js 18+ built-ins only — no external dependencies required.

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────

const LOCALES_DIR = path.join(__dirname, '..', 'src', 'renderer', 'i18n', 'locales');
const BASE_LOCALE = 'en';
const COVERAGE_THRESHOLD = 80; // percent — exit code 1 if any locale is below this

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Recursively collect all dot-notation leaf keys from a nested object.
 * @param {object} obj
 * @param {string} [prefix]
 * @returns {string[]}
 */
function getLeafKeys(obj, prefix = '') {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...getLeafKeys(v, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

/**
 * Load and parse a JSON locale file.
 * @param {string} filePath
 * @returns {object}
 */
function loadLocale(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    process.stderr.write(`Error reading ${filePath}: ${err.message}\n`);
    process.exit(2);
  }
}

/**
 * Determine badge color based on coverage percentage.
 * @param {number} pct
 * @returns {'brightgreen'|'yellow'|'red'}
 */
function badgeColor(pct) {
  if (pct >= 90) return 'brightgreen';
  if (pct >= 60) return 'yellow';
  return 'red';
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const outputJson = args.includes('--json');
const localeFlag = args.find(a => a.startsWith('--locale='));
const filterLocale = localeFlag ? localeFlag.split('=')[1].trim() : null;

// ─── Load base (English) ──────────────────────────────────────────────────────

const baseFile = path.join(LOCALES_DIR, `${BASE_LOCALE}.json`);
if (!fs.existsSync(baseFile)) {
  process.stderr.write(`Base locale file not found: ${baseFile}\n`);
  process.exit(2);
}

const baseData = loadLocale(baseFile);
const baseKeys = getLeafKeys(baseData);
const baseKeySet = new Set(baseKeys);

// ─── Discover other locales ───────────────────────────────────────────────────

const allFiles = fs.readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json'));
const localeFiles = allFiles
  .filter(f => f !== `${BASE_LOCALE}.json`)
  .filter(f => !filterLocale || f === `${filterLocale}.json`);

if (filterLocale && localeFiles.length === 0) {
  process.stderr.write(`Locale '${filterLocale}' not found in ${LOCALES_DIR}\n`);
  process.exit(2);
}

// ─── Analyse each locale ──────────────────────────────────────────────────────

const results = [];
let anyBelowThreshold = false;

for (const file of localeFiles) {
  const lang = file.replace('.json', '');
  const filePath = path.join(LOCALES_DIR, file);
  const data = loadLocale(filePath);
  const keys = getLeafKeys(data);
  const keySet = new Set(keys);

  const missing = baseKeys.filter(k => !keySet.has(k));
  const extra = keys.filter(k => !baseKeySet.has(k));
  const coveredCount = baseKeys.length - missing.length;
  const pct = Math.round((coveredCount / baseKeys.length) * 100);

  if (pct < COVERAGE_THRESHOLD) anyBelowThreshold = true;

  results.push({
    locale: lang,
    file,
    totalBase: baseKeys.length,
    totalLocale: keys.length,
    covered: coveredCount,
    missing: missing.length,
    extra: extra.length,
    percentage: pct,
    color: badgeColor(pct),
    missingKeys: missing,
    extraKeys: extra,
  });
}

// ─── Output ───────────────────────────────────────────────────────────────────

if (outputJson) {
  const output = {
    base: {
      locale: BASE_LOCALE,
      file: `${BASE_LOCALE}.json`,
      totalKeys: baseKeys.length,
      percentage: 100,
      color: 'brightgreen',
    },
    locales: results.map(r => ({
      locale: r.locale,
      file: r.file,
      totalBase: r.totalBase,
      totalLocale: r.totalLocale,
      covered: r.covered,
      missing: r.missing,
      extra: r.extra,
      percentage: r.percentage,
      color: r.color,
    })),
    threshold: COVERAGE_THRESHOLD,
    allPassing: !anyBelowThreshold,
  };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
} else {
  // Human-readable output
  const sep = '─'.repeat(60);
  process.stdout.write(`\n${sep}\n`);
  process.stdout.write(` i18n Coverage Report — Claude Terminal\n`);
  process.stdout.write(`${sep}\n`);
  process.stdout.write(` Base locale : ${BASE_LOCALE}.json  (${baseKeys.length} keys — 100%)\n`);
  process.stdout.write(` Threshold   : ${COVERAGE_THRESHOLD}%\n`);
  process.stdout.write(`${sep}\n\n`);

  if (results.length === 0) {
    process.stdout.write(' No other locales found.\n\n');
  }

  for (const r of results) {
    const status = r.percentage >= COVERAGE_THRESHOLD ? '✓ PASS' : '✗ FAIL';
    process.stdout.write(` Locale  : ${r.locale} (${r.file})\n`);
    process.stdout.write(` Status  : ${status}\n`);
    process.stdout.write(` Coverage: ${r.covered}/${r.totalBase} keys (${r.percentage}%)\n`);
    process.stdout.write(` Missing : ${r.missing} key(s)\n`);
    process.stdout.write(` Extra   : ${r.extra} key(s) not in base\n`);

    if (r.missingKeys.length > 0 && r.missingKeys.length <= 20) {
      process.stdout.write(` Missing keys:\n`);
      for (const k of r.missingKeys) {
        process.stdout.write(`   - ${k}\n`);
      }
    } else if (r.missingKeys.length > 20) {
      process.stdout.write(` Missing keys (first 20 of ${r.missingKeys.length}):\n`);
      for (const k of r.missingKeys.slice(0, 20)) {
        process.stdout.write(`   - ${k}\n`);
      }
    }
    process.stdout.write(`\n`);
  }

  process.stdout.write(`${sep}\n`);
  if (anyBelowThreshold) {
    process.stdout.write(` ✗ At least one locale is below the ${COVERAGE_THRESHOLD}% threshold.\n`);
  } else {
    process.stdout.write(` ✓ All locales meet the ${COVERAGE_THRESHOLD}% threshold.\n`);
  }
  process.stdout.write(`${sep}\n\n`);
}

// ─── Exit code ────────────────────────────────────────────────────────────────

process.exit(anyBelowThreshold ? 1 : 0);
