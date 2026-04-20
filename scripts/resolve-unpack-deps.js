'use strict';

/**
 * Resolve transitive dependencies for electron-builder asarUnpack.
 *
 * Walks package.json dependencies recursively from a set of root packages and
 * returns deduplicated glob patterns pointing into node_modules. Used by
 * electron-builder.config.js to build the asarUnpack list at build time.
 *
 * Why: the MCP server runs as an external `node` process which cannot read
 * asar archives. Every runtime-required module — including deep transitive
 * deps like `is-property` — must live under app.asar.unpacked. Manually
 * enumerating transitives was brittle and broke whenever an upstream package
 * added a dependency. This script computes the closure automatically.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ROOT_NODE_MODULES = path.join(PROJECT_ROOT, 'node_modules');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolve the installation directory for `name` starting from `fromDir`.
 * Walks up parent node_modules to handle both hoisted and nested installs.
 */
function resolvePackageDir(name, fromDir) {
  let current = fromDir;
  while (true) {
    const candidate = path.join(current, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Recursively collect all transitive dependencies (including optional) of the
 * given root package names. Returns a Set of absolute directory paths.
 */
function collectDependencies(rootNames) {
  const visited = new Set();
  const stack = [];

  for (const name of rootNames) {
    const dir = resolvePackageDir(name, PROJECT_ROOT);
    if (!dir) {
      console.warn(`[resolve-unpack-deps] root package not found: ${name}`);
      continue;
    }
    stack.push(dir);
  }

  while (stack.length) {
    const dir = stack.pop();
    if (visited.has(dir)) continue;
    visited.add(dir);

    const pkg = readJson(path.join(dir, 'package.json'));
    if (!pkg) continue;

    const deps = {
      ...(pkg.dependencies || {}),
      ...(pkg.optionalDependencies || {}),
    };

    for (const depName of Object.keys(deps)) {
      const depDir = resolvePackageDir(depName, dir);
      if (depDir && !visited.has(depDir)) {
        stack.push(depDir);
      }
    }
  }

  return visited;
}

/**
 * Return sorted asarUnpack glob patterns (relative paths with forward slashes)
 * for the transitive closure of `rootNames`.
 */
function resolveUnpackGlobs(rootNames) {
  const dirs = collectDependencies(rootNames);
  const globs = new Set();
  for (const dir of dirs) {
    const rel = path.relative(PROJECT_ROOT, dir).replace(/\\/g, '/');
    if (!rel.startsWith('node_modules/')) continue;
    globs.add(`${rel}/**/*`);
  }
  return [...globs].sort();
}

module.exports = { resolveUnpackGlobs, collectDependencies };

// CLI: print the list when run directly, useful for debugging.
if (require.main === module) {
  const roots = process.argv.slice(2);
  if (!roots.length) {
    console.error('Usage: node scripts/resolve-unpack-deps.js <pkg1> [pkg2 ...]');
    process.exit(1);
  }
  const globs = resolveUnpackGlobs(roots);
  console.log(`Resolved ${globs.length} packages from roots: ${roots.join(', ')}`);
  for (const g of globs) console.log(g);
}
