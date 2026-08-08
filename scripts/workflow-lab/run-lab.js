#!/usr/bin/env node
/**
 * run-lab.js — execute every workflow node scenario in an isolated sandbox.
 *
 * DEV TOOL. Not shipped: `scripts/` is absent from electron-builder's `files`.
 *
 *   node scripts/workflow-lab/run-lab.js              # everything
 *   node scripts/workflow-lab/run-lab.js --only=shell # one node type
 *   node scripts/workflow-lab/run-lab.js --verbose    # show failure stacks
 *
 * Exit code is non-zero when a scenario fails OR when a registered node type
 * has no scenario file — that second rule is what makes every new node pass
 * through here. Skips are always printed, never silent.
 */

'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

// ── Re-exec under Electron ──────────────────────────────────────────────────
// Native modules (better-sqlite3, keytar) are rebuilt for Electron's ABI by
// `npm install`, so they refuse to load under plain node. Rather than a
// platform-specific npm script, relaunch ourselves as Electron-as-node so
// `npm run lab` just works everywhere — and so nodes are exercised on the same
// ABI the app actually runs on.
if (!process.versions.electron && !process.env.WF_LAB_CHILD) {
  const { spawnSync } = require('child_process');
  let electronBin;
  try { electronBin = require(path.join(ROOT, 'node_modules', 'electron')); }
  catch { electronBin = null; }

  if (typeof electronBin === 'string') {
    const res = spawnSync(electronBin, [__filename, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WF_LAB_CHILD: '1' },
    });
    process.exit(res.status === null ? 1 : res.status);
  }
  console.warn('[lab] electron not found — running under plain node; nodes using native modules will fail to load.');
}

const { createSandbox, runNode, runGraph } = require('./sandbox');
const { loadScenarios } = require('./scenarios/_index');

const args    = process.argv.slice(2);
const only    = (args.find(a => a.startsWith('--only=')) || '').split('=')[1] || null;
const verbose = args.includes('--verbose');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m',
};

async function runOne(mod, scenario) {
  const sb = createSandbox(mod.type);
  try {
    if (scenario.setup) await scenario.setup(sb);

    let outcome;
    if (scenario.graph) {
      outcome = await runGraph(scenario.graph(sb), sb);
    } else {
      const config = typeof scenario.config === 'function' ? scenario.config(sb) : (scenario.config || {});
      if (scenario.expectThrow) {
        let threw = null;
        try { await runNode(mod.type, config, sb); }
        catch (e) { threw = e; }
        if (!threw) throw new Error('expected run() to reject, but it resolved');
        outcome = threw;
      } else {
        outcome = await runNode(mod.type, config, sb);
      }
    }

    if (scenario.assert) await scenario.assert(outcome, sb);
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  } finally {
    await sb.cleanup();
  }
}

(async () => {
  const registry = require(path.join(ROOT, 'src/main/workflow-nodes/_registry'));
  registry.loadRegistry();
  const registered = registry.getAll()
    .map(d => d.type.replace('workflow/', ''))
    .filter(t => t !== 'trigger')     // entry point, never executed as a step
    .sort();

  const modules = loadScenarios();
  const covered = new Set(modules.map(m => m.type));
  const missing = registered.filter(t => !covered.has(t));

  const targets = only ? modules.filter(m => m.type === only) : modules;
  if (only && !targets.length) {
    console.error(`${C.red}No scenario file for "${only}"${C.reset}`);
    process.exit(2);
  }

  let pass = 0, fail = 0, skipped = [];
  const failures = [];

  for (const mod of targets) {
    if (mod.skip) { skipped.push(`${mod.type}: ${mod.skip}`); continue; }

    process.stdout.write(`${C.bold}${mod.type}${C.reset}\n`);
    for (const scenario of mod.scenarios) {
      const { ok, err } = await runOne(mod, scenario);
      if (ok) {
        pass++;
        console.log(`  ${C.green}PASS${C.reset} ${C.dim}${scenario.name}${C.reset}`);
      } else {
        fail++;
        failures.push({ type: mod.type, name: scenario.name, err });
        console.log(`  ${C.red}FAIL${C.reset} ${scenario.name}`);
        console.log(`       ${C.red}${err.message.split('\n')[0]}${C.reset}`);
        if (verbose) console.log(C.dim + (err.stack || '') + C.reset);
      }
    }
  }

  console.log();
  if (skipped.length) {
    console.log(`${C.yellow}SKIPPED (declared, not silent):${C.reset}`);
    for (const s of skipped) console.log(`  - ${s}`);
    console.log();
  }

  if (!only && missing.length) {
    console.log(`${C.red}${C.bold}NODES WITH NO SCENARIO FILE (${missing.length}):${C.reset}`);
    for (const m of missing) console.log(`  ${C.red}- ${m}${C.reset}   -> add scripts/workflow-lab/scenarios/${m}.scenario.js`);
    console.log();
  }

  const coverage = registered.length ? Math.round((covered.size / registered.length) * 100) : 0;
  console.log(`${C.cyan}coverage${C.reset} ${covered.size}/${registered.length} node types (${coverage}%)`);
  console.log(`${C.green}${pass} passed${C.reset}  ${fail ? C.red : C.dim}${fail} failed${C.reset}  ${C.yellow}${skipped.length} skipped${C.reset}`);

  if (failures.length) {
    console.log(`\n${C.bold}Failures:${C.reset}`);
    for (const f of failures) console.log(`  ${C.red}${f.type}${C.reset} / ${f.name}\n      ${f.err.message.split('\n')[0]}`);
  }

  process.exit(fail > 0 || (!only && missing.length > 0) ? 1 : 0);
})().catch(e => {
  console.error(e);
  process.exit(2);
});
