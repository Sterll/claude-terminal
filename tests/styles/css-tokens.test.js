/**
 * Guards a silent class of CSS bug: a `var(--token)` written with no fallback
 * for a custom property that no stylesheet declares.
 *
 * CSS resolves that at computed-value time, and the rule is that the WHOLE
 * declaration becomes invalid - not just the one value. `border: 3px solid
 * var(--nope)` does not fall back to a default border, it drops the border
 * entirely. Nothing throws, no build warns, and the element simply renders
 * without the thing you asked for.
 *
 * Three of these shipped before this test existed:
 *
 *   - `.terminal-loading-spinner` read `var(--border)` (the token is
 *     `--border-color`), so its 3px ring never rendered: an invisible spinner.
 *   - `.overview-card` read `var(--radius-md)`, which never existed, so the
 *     dashboard's cards had square corners.
 *   - `--font-mono` was declared nowhere while four rules read it bare, so
 *     branch names, commit hashes and key combos rendered in the body's
 *     sans-serif.
 *
 * They were found by importing the stylesheets into an external validator, not
 * by this repository. This test closes that gap.
 *
 * A property that is legitimately set per element from JavaScript belongs in
 * RUNTIME_INJECTED below, with the site that sets it. Everything else is a bug:
 * either declare the token, or give the `var()` a fallback.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const STYLES_DIR = path.join(__dirname, '..', '..', 'styles');

/**
 * Custom properties no stylesheet declares on purpose: the app sets them on
 * individual elements at runtime. Each entry names where that happens, so a
 * reader can check the claim instead of trusting the list.
 */
const RUNTIME_INJECTED = new Map([
  ['--account-color', 'renderer.js:7027 and ProjectBar.js:155 (per-account tint)'],
  ['--chip-color', 'ChatView.js:700 and 4103 (mention chip colour)'],
  ['--type-color', 'DashboardService.js:2505, WebAppWizard.js:51 (project-type colour)'],
  ['--tc', 'SessionReplayPanel.js:1087 (per-step tone, used as rgba(var(--tc), …))'],
  ['--d', 'ChatView.js:5914 (per-row animation delay index)'],
]);

/** @returns {string[]} every .css file under styles/ */
function stylesheets() {
  return fs.readdirSync(STYLES_DIR)
    .filter((f) => f.endsWith('.css'))
    .map((f) => path.join(STYLES_DIR, f));
}

describe('CSS custom properties', () => {
  const declared = new Set();
  /** @type {Map<string, Set<string>>} token -> files that read it bare */
  const bareReads = new Map();

  beforeAll(() => {
    for (const file of stylesheets()) {
      const css = fs.readFileSync(file, 'utf8');
      for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:/g)) declared.add(m[1]);
      // Bare only: `var(--x)`. `var(--x, fallback)` degrades gracefully and is
      // a legitimate way to read a property that may not be set.
      for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)) {
        if (!bareReads.has(m[1])) bareReads.set(m[1], new Set());
        bareReads.get(m[1]).add(path.basename(file));
      }
    }
  });

  test('every bare var() reads a property some stylesheet declares', () => {
    const offenders = [...bareReads]
      .filter(([token]) => !declared.has(token) && !RUNTIME_INJECTED.has(token))
      .map(([token, files]) => `  ${token} - read bare in ${[...files].sort().join(', ')}`);

    expect(offenders.join('\n') && `Undeclared custom properties read without a fallback:\n${
      offenders.join('\n')}\n\nThe whole declaration is invalid at computed-value time, so the\nproperty silently does not apply. Declare the token in styles/base.css,\ngive the var() a fallback, or - if the app sets it per element from JS -\nadd it to RUNTIME_INJECTED in this test with the site that sets it.`)
      .toBe('');
  });

  test('every RUNTIME_INJECTED entry is still read by some stylesheet', () => {
    // Keeps the allowlist from outliving the CSS it excuses.
    const unused = [...RUNTIME_INJECTED.keys()].filter((t) => !bareReads.has(t));
    expect(unused).toEqual([]);
  });

  test('no RUNTIME_INJECTED entry is also declared in CSS', () => {
    // If a stylesheet started declaring one, the allowlist entry is a lie and
    // the token should simply be validated like any other.
    const nowDeclared = [...RUNTIME_INJECTED.keys()].filter((t) => declared.has(t));
    expect(nowDeclared).toEqual([]);
  });

  test('the token contract base.css advertises is intact', () => {
    // A handful of tokens are named in CLAUDE.md, in the design-system export
    // and across the stylesheets; losing one silently is a wide blast radius.
    const base = fs.readFileSync(path.join(STYLES_DIR, 'base.css'), 'utf8');
    for (const token of [
      '--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-hover', '--bg-active',
      '--border-color', '--text-primary', '--text-secondary', '--text-tertiary', '--text-muted',
      '--accent', '--accent-hover', '--accent-dim', '--accent-rgb',
      '--success', '--warning', '--danger', '--info', '--purple',
      '--radius', '--radius-sm', '--shadow', '--font-mono',
      '--font-2xs', '--font-xs', '--font-sm', '--font-base', '--font-md', '--font-lg',
    ]) {
      expect(base).toMatch(new RegExp(`^\\s*${token}\\s*:`, 'm'));
    }
  });
});
