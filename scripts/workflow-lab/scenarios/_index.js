/**
 * Scenario index.
 *
 * Every `<type>.scenario.js` in this folder is picked up automatically, so
 * adding a node means adding one file here — no registration step to forget.
 *
 * A scenario module exports:
 *   {
 *     type: 'shell',                       // short node type
 *     skip: 'reason',                      // OPTIONAL — reported loudly, never silent
 *     scenarios: [
 *       {
 *         name: 'what this proves',
 *         async setup(sb) {},              // optional fixtures
 *         config: {...} | (sb) => ({...}),  // node properties
 *         graph: (sb) => ({nodes, links}), // OPTIONAL — drive the runner instead of run()
 *         async assert(out, sb) {},        // throw to fail
 *       },
 *     ],
 *   }
 */

'use strict';

const fs   = require('fs');
const path = require('path');

function loadScenarios() {
  const files = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.scenario.js'))
    .sort();

  const modules = [];
  for (const f of files) {
    const mod = require(path.join(__dirname, f));
    if (!mod.type) throw new Error(`${f} does not export a "type"`);
    if (!mod.skip && (!Array.isArray(mod.scenarios) || !mod.scenarios.length)) {
      throw new Error(`${f} declares no scenarios and no skip reason`);
    }
    modules.push(mod);
  }
  return modules;
}

module.exports = { loadScenarios };
