#!/usr/bin/env node
/**
 * check-docs — guard against CLAUDE.md drifting from the tree it describes.
 *
 * CLAUDE.md is the file Claude reads at the start of every session, so a wrong
 * claim in it is worse than a missing one: it sends the reader to a directory
 * that no longer exists. This script was written after the file had drifted a
 * full minor version behind (v1.2.18 documented while the app shipped 1.3.1,
 * 26 IPC files documented while 35 existed, and a whole section pointing at
 * `src/main/workflow-triggers/` months after that directory was deleted).
 *
 * It deliberately checks only what a machine can check without judgement:
 *
 *   1. numbers CLAUDE.md states about the tree (file counts, handler counts,
 *      locale key counts), and
 *   2. that every repo path it mentions actually exists.
 *
 * Prose is left alone. The point is not to generate the documentation — a
 * generated CLAUDE.md would lose the "why" that makes it worth reading — but to
 * fail loudly when a claim has become false.
 *
 * Usage:  node scripts/check-docs.js        (exit 1 on any failure)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'CLAUDE.md');

const doc = fs.readFileSync(DOC, 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const failures = [];
const checks = [];

/**
 * Record one check.
 *
 * @param {string} name    - what is being verified, shown in the report
 * @param {*}      claimed - the value CLAUDE.md states (null = the claim itself
 *                           could not be located, which is a failure too: it
 *                           means the section was reworded and this check has
 *                           silently stopped guarding anything)
 * @param {*}      actual  - the value read off the tree
 */
function expect(name, claimed, actual) {
  const ok = claimed !== null && claimed !== undefined && String(claimed) === String(actual);
  checks.push({ name, claimed, actual, ok });
  if (!ok) {
    failures.push(
      claimed === null || claimed === undefined
        ? `${name}: could not find the claim in CLAUDE.md (section reworded?) — actual is ${actual}`
        : `${name}: CLAUDE.md says ${claimed}, tree says ${actual}`
    );
  }
}

/** First capture group of `re` in CLAUDE.md, or null when it does not match. */
function claim(re) {
  const m = doc.match(re);
  return m ? m[1] : null;
}

/** Number of entries directly inside `rel` (non-recursive), optionally filtered. */
function count(rel, filter = () => true) {
  const dir = path.join(ROOT, rel);
  if (!fs.existsSync(dir)) return `<missing dir ${rel}>`;
  return fs.readdirSync(dir).filter(filter).length;
}

/** Recursive file walk, returning paths relative to ROOT. */
function walk(rel, out = []) {
  const dir = path.join(ROOT, rel);
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) walk(child, out);
    else out.push(child);
  }
  return out;
}

// ── 1. Version ───────────────────────────────────────────────────────────────

expect('version', claim(/\(\*\*v([\d.]+)\*\*\)/), pkg.version);

// ── 2. Directory sizes claimed in the architecture tree ──────────────────────

const js = (f) => f.endsWith('.js');

// `index.js` is the orchestrator, not an IPC file, and is excluded the same way
// it is for services and utils below.
expect('IPC files', claim(/# (\d+) IPC files/), count('src/main/ipc', js) - 1);
expect('main services', claim(/src\/main\/services\/\s+# (\d+) services/), count('src/main/services', js) - 1); // -1 for index.js
expect('main utils', claim(/src\/main\/utils\/\s+# (\d+) utilities/), count('src/main/utils', js) - 1);
expect('workflow nodes', claim(/# (\d+) workflow node types/), count('src/main/workflow-nodes', (f) => f.endsWith('.node.js')));
expect('state modules', claim(/# (\d+) observable state modules/), count('src/renderer/state', js) - 2); // -index.js -State.js
expect('renderer services', claim(/# (\d+) services \+ modular markdown/), count('src/renderer/services', js) - 1);
expect('UI components', claim(/# (\d+) UI components/), count('src/renderer/ui/components', js) - 1);
expect('UI panels', claim(/# (\d+) UI panels/), count('src/renderer/ui/panels', js) - 1);
expect('workflow fields', claim(/# (\d+) custom UI fields/), count('src/renderer/workflow-fields', (f) => f.endsWith('.field.js')));
expect('workflow triggers', claim(/# (\d+) trigger types/), count('src/renderer/workflow-triggers', (f) => f.endsWith('.trigger.js')));
expect('shared modules', claim(/# (\d+) modules shared between/), count('src/shared', js));
expect('CSS files', claim(/# (\d+) modular CSS files/), count('styles', (f) => f.endsWith('.css')));

// The same fact is stated twice — once in the architecture tree above, once in
// the "CSS Architecture" section header — and only the first was checked, so
// the header sat a full release behind (26 files / 50,700 lines against a tree
// of 30 / 57,000) while this script reported all green. Any number CLAUDE.md
// repeats needs checking at every site it appears.
expect('CSS files (section header)',
  claim(/## CSS Architecture \(`styles\/` - (\d+) files/),
  count('styles', (f) => f.endsWith('.css')));

/** Total lines across every stylesheet. */
const cssLines = fs
  .readdirSync(path.join(ROOT, 'styles'))
  .filter((f) => f.endsWith('.css'))
  .reduce((n, f) => n + fs.readFileSync(path.join(ROOT, 'styles', f), 'utf8').split('\n').length - 1, 0);

// Checked with a tolerance rather than exactly: the header says "~57,000", and
// a guard that fails on every stylesheet edit is a guard that gets deleted.
// 5% still catches a claim that has fallen a release behind.
{
  const claimed = claim(/## CSS Architecture \(`styles\/` - \d+ files, ~([\d,]+) lines\)/);
  const claimedNum = claimed === null ? null : Number(claimed.replace(/,/g, ''));
  const drift = claimedNum === null ? Infinity : Math.abs(claimedNum - cssLines) / cssLines;
  const ok = drift <= 0.05;
  checks.push({ name: 'CSS total lines (±5%)', claimed, actual: cssLines, ok });
  if (!ok) {
    failures.push(`CSS total lines: CLAUDE.md says ~${claimed}, tree has ${cssLines} (${(drift * 100).toFixed(1)}% off)`);
  }
}
expect('MCP tool modules', claim(/# (\d+) tool modules/), count('resources/mcp-servers/tools', (f) => js(f) && !f.startsWith('_')));

// ── 3. IPC handler total ─────────────────────────────────────────────────────

const handlers = fs
  .readdirSync(path.join(ROOT, 'src/main/ipc'))
  .filter(js)
  .reduce((sum, f) => {
    const src = fs.readFileSync(path.join(ROOT, 'src/main/ipc', f), 'utf8');
    return sum + (src.match(/ipcMain\.(handle|on)\b/g) || []).length;
  }, 0);

expect('IPC handlers', claim(/# \d+ IPC files, (\d+) handlers total/), handlers);
expect('IPC handlers (total line)', claim(/\*\*Total: (\d+) IPC handlers/), handlers);

// ── 4. i18n ──────────────────────────────────────────────────────────────────

const localeDir = path.join(ROOT, 'src/renderer/i18n/locales');
const locales = fs.readdirSync(localeDir).filter((f) => f.endsWith('.json'));
const countKeys = (o) =>
  Object.values(o).reduce((n, v) => n + (v && typeof v === 'object' ? countKeys(v) : 1), 0);
const keyCounts = new Set(
  locales.map((f) => countKeys(JSON.parse(fs.readFileSync(path.join(localeDir, f), 'utf8'))))
);

expect('locale key count', claim(/locales \((\d+) keys each\)/), [...keyCounts].join('/'));

// ── 5. Test files ────────────────────────────────────────────────────────────

const testFiles = walk('tests').filter((f) => f.endsWith('.test.js')).length;
expect('test files', claim(/jsdom, (\d+) test files/), testFiles);

// ── 6. Every repo path CLAUDE.md mentions must exist ─────────────────────────
//
// This is the check that would have caught `src/main/workflow-triggers/`.
// Only inline-code spans are considered, and only those that look like a real
// repo path: globs, placeholders and home-relative paths are skipped because
// they do not name a file on disk.

const TRACKED_ROOTS = ['src/', 'styles/', 'resources/', 'tests/', 'remote-ui/', 'scripts/', '.github/', 'assets/'];

/**
 * Paths CLAUDE.md names *because* they are gone.
 *
 * Saying "there is no src/main/workflow-triggers/" is the single most useful
 * line in that section — it stops the next reader hunting for a directory the
 * old documentation promised. So the absence has to be allowed, but explicitly:
 * an entry here is a claim that the path should NOT exist, and is checked as
 * such below.
 */
const KNOWN_ABSENT = ['src/main/workflow-triggers/'];

for (const absent of KNOWN_ABSENT) {
  const exists = fs.existsSync(path.join(ROOT, absent.replace(/\/$/, '')));
  checks.push({ name: `${absent} stays absent`, claimed: 'absent', actual: exists ? 'exists' : 'absent', ok: !exists });
  if (exists) {
    failures.push(`${absent} exists again, but CLAUDE.md documents it as removed — drop it from KNOWN_ABSENT and document the directory`);
  }
}

const missingPaths = [];

for (const [, spanRaw] of doc.matchAll(/`([^`\n]+)`/g)) {
  const span = spanRaw.trim();
  if (!TRACKED_ROOTS.some((r) => span.startsWith(r))) continue;
  if (/[*{}<>%$|]/.test(span)) continue; // glob or placeholder
  if (KNOWN_ABSENT.includes(span)) continue;
  const target = span.replace(/\/$/, '');
  if (!fs.existsSync(path.join(ROOT, target))) missingPaths.push(span);
}

const uniqueMissing = [...new Set(missingPaths)];
checks.push({ name: 'referenced paths exist', claimed: 'all', actual: uniqueMissing.length ? `${uniqueMissing.length} missing` : 'all', ok: !uniqueMissing.length });
if (uniqueMissing.length) {
  failures.push(`referenced paths do not exist: ${uniqueMissing.join(', ')}`);
}

// ── Report ───────────────────────────────────────────────────────────────────

const pad = Math.max(...checks.map((c) => c.name.length));
for (const c of checks) {
  const mark = c.ok ? 'ok  ' : 'FAIL';
  console.log(`${mark} ${c.name.padEnd(pad)}  ${c.ok ? c.actual : `doc=${c.claimed} tree=${c.actual}`}`);
}

if (failures.length) {
  console.error(`\n${failures.length} CLAUDE.md claim(s) no longer match the repository:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error('\nUpdate CLAUDE.md in the same commit as the change that invalidated it.');
  process.exit(1);
}

console.log(`\nCLAUDE.md matches the tree (${checks.length} checks).`);
