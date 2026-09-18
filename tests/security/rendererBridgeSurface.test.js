// The sandboxed preload no longer hands the renderer Node's `path` and `fs`.
// It hands over a proxy that forwards a fixed list of methods to the main
// process, and that list lives twice: once in `src/main/preload.js`, once in
// `src/main/utils/rendererFiles.js`. A sandboxed preload can only require
// electron, events, timers and url, so it cannot import a shared constant and
// the duplication is structural.
//
// This shipped missing `path.extname`, `path.normalize` and `path.isAbsolute`,
// all three of which the renderer calls. They resolved to `undefined`, so
// opening a folder in the file explorer threw on the first file it listed.
//
// Nothing caught it: `tests/setup.js` mocks `window.electron_nodeModules` with
// Node's real `path`, so every jsdom suite in this repository runs against the
// module the proxy replaced, and the e2e smoke opens the tabs without
// populating a file tree.
//
// So the guard has to compare the proxy's surface against the renderer's real
// usage, read off the source.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'src/main/preload.js'), 'utf8');
const { PATH_METHODS } = require('../../src/main/utils/rendererFiles');

/** The method list a `for (const method of [...])` loop iterates in the preload. */
function preloadList(afterMarker) {
  const at = PRELOAD.indexOf(afterMarker);
  expect(at).toBeGreaterThan(-1);
  const loop = /for \(const method of \[([^\]]+)\]\)/.exec(PRELOAD.slice(at));
  expect(loop).not.toBeNull();
  return loop[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

/** Every renderer source file, which is where the proxy is actually consumed. */
function rendererSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'locales') walk(full); }
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  walk(path.join(ROOT, 'src/renderer'));
  walk(path.join(ROOT, 'src/project-types'));
  out.push(path.join(ROOT, 'renderer.js'));
  return out;
}

const SOURCES = rendererSources().map(file => ({ file, text: fs.readFileSync(file, 'utf8') }));

/**
 * Calls on something that plausibly *is* the bridge's `path`.
 *
 * Matches `path.x(`, `_path.x(`, `api.path.x(`, `this._path.x(` and so on. A
 * git status entry named `file.path` is a property, not a call, so the
 * trailing paren is what keeps this from drowning in false positives.
 */
function usedPathMethods() {
  const found = new Map();
  const re = /(?:^|[^\w.])(?:[\w$]*\.)?_?path\.([a-zA-Z]+)\s*\(/g;
  for (const { file, text } of SOURCES) {
    for (const m of text.matchAll(re)) {
      if (!found.has(m[1])) found.set(m[1], file);
    }
  }
  return found;
}

describe('sandboxed renderer bridge surface', () => {
  test('the preload and the main-process handler expose the same path methods', () => {
    // Two lists, one contract. Drift here is silent until a renderer call
    // lands on undefined.
    expect(preloadList('const pathApi').sort()).toEqual([...PATH_METHODS].sort());
  });

  test('every path method the renderer calls is forwarded', () => {
    const used = usedPathMethods();
    // A name the regex caught that is not a path method at all is a string
    // operation on a path-valued property: `project.path.trim()`,
    // `file.path.split('/')`. Only a real `path` member can be a bridge call.
    const missing = [...used].filter(([method]) =>
      typeof path[method] === 'function' && !PATH_METHODS.includes(method));
    // Reported with the file so the failure names where to look, not just what.
    expect(missing.map(([method, file]) => `${method} (${path.relative(ROOT, file)})`)).toEqual([]);
  });

  test('the forwarded path methods all exist on Node path', () => {
    // A typo in either list would otherwise only surface as a thrown call.
    for (const method of PATH_METHODS) expect(typeof path[method]).toBe('function');
  });

  test('the forwarded fs methods all exist on Node fs', () => {
    for (const method of preloadList('const fileApi')) {
      expect(typeof fs[method + 'Sync']).toBe('function');
      if (method !== 'exists') expect(typeof fs.promises[method]).toBe('function');
    }
  });

  test('path.sep is exposed, since the renderer builds paths with it', () => {
    expect(PRELOAD).toMatch(/sep:\s*bootstrap\.sep/);
  });
});
