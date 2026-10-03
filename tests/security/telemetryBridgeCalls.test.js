/**
 * Renderer calls into `electron_api.telemetry` must name a method the preload
 * still exposes.
 *
 * The telemetry rewrite moved feature pings into the main process and dropped
 * `sendFeature` from the bridge, but four renderer call sites kept calling it
 * as `api.telemetry?.sendFeature(...)`. The `?.` guards the namespace, not the
 * method, so each threw a TypeError right after the operation succeeded: a
 * commit, pull or push from the Git panel landed, then never cleared the
 * message, never toasted and never refreshed, which reads as "nothing
 * happened". Found by driving the real app; jsdom's mocked bridge hid it.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function exposedTelemetryMethods() {
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
  const block = /\btelemetry:\s*\{([\s\S]*?)\n\s*\},/.exec(preload);
  if (!block) throw new Error('telemetry namespace not found in preload.js');
  return new Set([...block[1].matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]));
}

function rendererFiles() {
  const out = [path.join(ROOT, 'renderer.js')];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  walk(path.join(ROOT, 'src', 'renderer'));
  return out;
}

test('every renderer telemetry call names a method the preload exposes', () => {
  const exposed = exposedTelemetryMethods();
  expect(exposed.has('getStatus')).toBe(true);
  const offenders = [];
  for (const file of rendererFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const m of source.matchAll(/\btelemetry\??\.(\w+)\s*(\?\.)?\(/g)) {
      const [, method, optionalCall] = m;
      if (exposed.has(method) || optionalCall) continue;
      offenders.push(`${path.relative(ROOT, file)}: telemetry.${method}()`);
    }
  }
  expect(offenders).toEqual([]);
});
