/**
 * Discovers issue tracker adapters: every `*.tracker.js` file in this
 * directory. Files starting with `_` are helpers, not adapters.
 *
 * A file that fails to load or breaks the contract is skipped and reported,
 * never fatal: one broken adapter costs its own provider, not the app.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { validateTracker } = require('./_contract');

/**
 * @param {string} dir
 * @returns {{ trackers: Map<string, object>, problems: Array<{ file: string, problems: string[] }> }}
 */
function loadTrackers(dir) {
  const trackers = new Map();
  const problems = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => !f.startsWith('_') && f.endsWith('.tracker.js')).sort();
  } catch (err) {
    problems.push({ file: dir, problems: [`cannot read directory: ${err.message}`] });
  }
  for (const file of files) {
    let def;
    try {
      def = require(path.join(dir, file));
    } catch (err) {
      problems.push({ file, problems: [`failed to load: ${err.message}`] });
      continue;
    }
    const found = validateTracker(def);
    if (!found.length && trackers.has(def.id)) found.push(`id "${def.id}" is already registered by another file`);
    if (found.length) {
      problems.push({ file, problems: found });
      continue;
    }
    trackers.set(def.id, def);
  }
  return { trackers, problems };
}

let _loaded = null;

function registry() {
  if (!_loaded) {
    _loaded = loadTrackers(__dirname);
    for (const { file, problems } of _loaded.problems) {
      console.error(`[IssueTrackers] skipped ${file}: ${problems.join('; ')}`);
    }
  }
  return _loaded.trackers;
}

/** @returns {object|null} */
function get(id) {
  return registry().get(id) || null;
}

/** @returns {object[]} */
function getAll() {
  return [...registry().values()];
}

/**
 * What the renderer may know about each adapter: plain data, no functions,
 * nothing that depends on a connection.
 *
 * @param {object[]} defs
 */
function describeTrackers(defs) {
  return defs.map((def) => ({
    id: def.id,
    name: def.name,
    auth: { type: def.auth.type, helpUrl: def.auth.helpUrl || null },
    capabilities: {
      priority: def.capabilities.priority,
      labels: def.capabilities.labels,
      estimate: def.capabilities.estimate,
      comments: def.capabilities.comments,
      write: [...def.capabilities.write],
    },
  }));
}

function describe() {
  return describeTrackers(getAll());
}

module.exports = { loadTrackers, get, getAll, describeTrackers, describe };
