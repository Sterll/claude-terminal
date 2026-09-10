/**
 * Project type extension manifest — schema, validation and sanitisation.
 *
 * Shared verbatim between the main process (which reads the files off disk) and
 * the tests. It is pure on purpose: no `fs`, no DOM, no `electron`, nothing that
 * would stop `src/shared/**` from being importable by either side. Everything
 * here is a function over strings and plain objects.
 *
 * The design note that explains *why* the manifest is declarative rather than a
 * loadable module lives at `design/project-type-extensions.md`. The one-line
 * version: an extension never becomes code, in either process, so every field
 * below is data that first-party code interprets — and the validation here is
 * the only thing standing between an untrusted file and `innerHTML`.
 */

'use strict';

/** Manifest format version. A manifest declaring anything else is rejected. */
const MANIFEST_VERSION = 1;

/** Directory under ~/.claude-terminal/ that is scanned for extensions. */
const EXTENSIONS_DIRNAME = 'project-types';

/** File each extension directory must contain. */
const MANIFEST_FILENAME = 'project-type.json';

/** Prefix applied to every extension id, so it can never collide with a built-in. */
const EXTERNAL_ID_PREFIX = 'ext-';

/** Locales the app ships. An extension may translate into these and no others. */
const SUPPORTED_LOCALES = ['en', 'fr', 'es', 'id', 'zh-CN'];

/** Categories the wizard groups by — mirrors `categories` in registry.js. */
const CATEGORIES = ['general', 'bots', 'gamedev'];

// Caps. These exist so a hostile or merely broken directory cannot stall
// startup or push megabytes of text into the DOM.
const LIMITS = {
  manifestBytes: 64 * 1024,
  extensions: 64,
  name: 48,
  description: 200,
  badge: 12,
  icon: 4096,
  markers: 16,
  markerLength: 64,
};

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// ── Plain text ───────────────────────────────────────────────────────────────

/**
 * Is this a string safe to interpolate into `innerHTML` without escaping?
 *
 * The wizard does exactly that — `renderer.js` builds the type badge with
 * `badge.innerHTML = ...${t(tp.nameKey)}...` — and adding an escape at that one
 * call site would leave the next one unprotected. So the rule is enforced once,
 * here, at the point the value crosses from an untrusted file into the app:
 * anything that could open a tag or an entity is not a name, it is an attack,
 * and it is rejected rather than repaired.
 *
 * @param {*} value
 * @param {number} maxLength
 * @returns {boolean}
 */
function isPlainText(value, maxLength) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!s.length) return false;
  if (maxLength && s.length > maxLength) return false;
  if (/[<>]/.test(s)) return false;
  if (/&#/.test(s)) return false;
  // Control characters, including the bidi overrides that let a display name
  // read as something other than what it is.
  if (/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(s)) return false;
  return true;
}

// ── Icons ────────────────────────────────────────────────────────────────────

/**
 * Elements an extension icon may use. Everything drawable, nothing that loads,
 * links, scripts or escapes into HTML.
 */
const SVG_ALLOWED_TAGS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'rect', 'defs', 'lineargradient', 'radialgradient', 'stop', 'title',
]);

/**
 * Attributes those elements may carry. Note what is missing: `href`, `xlink:href`,
 * `src`, `style` and every `on*`. `style` is excluded because it is the one
 * attribute that can reach `url()` and positioning without a tag of its own.
 */
const SVG_ALLOWED_ATTRS = new Set([
  'viewbox', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-opacity', 'fill-opacity', 'fill-rule',
  'clip-rule', 'opacity', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1',
  'x2', 'y2', 'points', 'transform', 'offset', 'stop-color', 'stop-opacity',
  'gradientunits', 'gradienttransform', 'id', 'class', 'xmlns', 'preserveaspectratio',
]);

/**
 * Validate an extension-supplied SVG icon against a tag/attribute allowlist.
 *
 * Returns the original string when it passes and `null` when it does not — an
 * invalid icon is dropped, it does not fail the whole extension, because the
 * extension is still perfectly usable without a picture.
 *
 * This is a validator, not a sanitiser: nothing is rewritten. A string that is
 * not obviously safe is refused outright, which is both easier to audit and
 * impossible to smuggle past with a mutation trick.
 *
 * @param {*} raw
 * @returns {string|null}
 */
function validateIcon(raw) {
  if (typeof raw !== 'string') return null;
  const svg = raw.trim();
  if (!svg.length || svg.length > LIMITS.icon) return null;

  // Exactly one <svg> root, and nothing outside it.
  if (!svg.startsWith('<svg') || !svg.endsWith('</svg>')) return null;

  // Cheap structural refusals first: comments, CDATA, processing instructions,
  // doctypes and entities all give a parser something to disagree about, and an
  // icon has no use for any of them.
  if (/<!|<\?|&(?!(amp|lt|gt|quot|apos);)/.test(svg)) return null;

  // Every tag must be allowlisted.
  for (const [, name] of svg.matchAll(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/g)) {
    if (!SVG_ALLOWED_TAGS.has(name.toLowerCase())) return null;
  }
  // Exactly one root element.
  if ((svg.match(/<\s*svg\b/gi) || []).length !== 1) return null;

  // Every attribute must be allowlisted. Matches `name=` at a token boundary,
  // which also catches `on click = ...`-style spacing tricks because the name
  // itself still has to pass the set.
  for (const [, name] of svg.matchAll(/[\s"']([a-zA-Z][a-zA-Z0-9:_-]*)\s*=/g)) {
    if (!SVG_ALLOWED_ATTRS.has(name.toLowerCase())) return null;
  }

  // Belt and braces for the values: no scheme, no url(), no expression.
  if (/javascript\s*:|data\s*:|vbscript\s*:|url\s*\(/i.test(svg)) return null;

  return svg;
}

// ── Version ranges ───────────────────────────────────────────────────────────

/**
 * Compare two dotted version strings. Pre-release suffixes are ignored: the
 * range lives in an untrusted file and full semver precedence is more surface
 * than this needs.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} -1, 0 or 1
 */
function compareVersions(a, b) {
  const parse = (v) => String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Does `version` satisfy `range`?
 *
 * A deliberately small subset of semver — `*`, exact, `>=`, `>`, `<=`, `<`,
 * `^` and `~` — hand-rolled rather than pulled from a dependency. The input is
 * untrusted, so the parser for it should be short enough to read in one sitting,
 * and an unrecognised range is refused rather than guessed at.
 *
 * @param {string} version - the app version, e.g. '1.3.2'
 * @param {string} range
 * @returns {boolean}
 */
function satisfiesRange(version, range) {
  if (range === undefined || range === null) return true;
  const r = String(range).trim();
  if (!r.length || r === '*' || r === 'x' || r === 'latest') return true;

  const m = r.match(/^(>=|<=|>|<|\^|~|=)?\s*v?(\d+(?:\.\d+){0,2})$/);
  if (!m) return false;

  const op = m[1] || '=';
  const target = m[2];
  const cmp = compareVersions(version, target);

  switch (op) {
    case '=':  return cmp === 0;
    case '>=': return cmp >= 0;
    case '>':  return cmp > 0;
    case '<=': return cmp <= 0;
    case '<':  return cmp < 0;
    case '^': {
      // ^1.3.0 → >=1.3.0 and <2.0.0. Below 1.0.0 npm narrows caret to the minor,
      // and an extension pinned against a 0.x app should get the same treatment.
      if (cmp < 0) return false;
      const [tMajor, tMinor] = target.split('.').map((n) => parseInt(n, 10) || 0);
      const [vMajor, vMinor] = version.split('.').map((n) => parseInt(n, 10) || 0);
      return tMajor === 0 ? vMajor === 0 && vMinor === tMinor : vMajor === tMajor;
    }
    case '~': {
      // ~1.3.0 → >=1.3.0 and <1.4.0
      if (cmp < 0) return false;
      const [tMajor, tMinor] = target.split('.').map((n) => parseInt(n, 10) || 0);
      const [vMajor, vMinor] = version.split('.').map((n) => parseInt(n, 10) || 0);
      return vMajor === tMajor && vMinor === tMinor;
    }
    default: return false;
  }
}

// ── Detection markers ────────────────────────────────────────────────────────

/**
 * Marker names are matched against `fs.existsSync(path.join(projectPath, name))`,
 * so anything that could climb out of the project directory is refused here
 * rather than guarded at the call site.
 *
 * @param {*} list
 * @returns {string[]}
 */
function sanitizeMarkers(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (out.length >= LIMITS.markers) break;
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (!name.length || name.length > LIMITS.markerLength) continue;
    if (name.includes('/') || name.includes('\\')) continue;
    if (name === '.' || name === '..' || name.includes('..')) continue;
    if (/[\u0000-\u001f\u007f]/.test(name)) continue;
    out.push(name);
  }
  return out;
}

// ── Manifest ─────────────────────────────────────────────────────────────────

/**
 * Validate a parsed manifest object.
 *
 * Never throws. Returns either `{ ok: true, value }` with a fully normalised
 * descriptor, or `{ ok: false, reason, detail }` where `reason` is a stable
 * machine-readable code the UI can translate and `detail` is the developer-facing
 * specifics.
 *
 * `reason` is one of: `not-an-object`, `bad-manifest-version`, `bad-id`,
 * `bad-name`, `incompatible`.
 *
 * @param {*} raw - parsed JSON, or anything at all
 * @param {Object} [opts]
 * @param {string} [opts.appVersion] - version to check `engines.claudeTerminal` against
 * @returns {{ok: true, value: Object}|{ok: false, reason: string, detail: string}}
 */
function validateManifest(raw, opts = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'not-an-object', detail: `expected an object, got ${Array.isArray(raw) ? 'an array' : typeof raw}` };
  }

  if (raw.manifest !== MANIFEST_VERSION) {
    return {
      ok: false,
      reason: 'bad-manifest-version',
      detail: `"manifest" must be ${MANIFEST_VERSION}, got ${JSON.stringify(raw.manifest)}`,
    };
  }

  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) {
    return { ok: false, reason: 'bad-id', detail: `"id" must match ${ID_RE} — got ${JSON.stringify(raw.id)}` };
  }

  if (!isPlainText(raw.name, LIMITS.name)) {
    return {
      ok: false,
      reason: 'bad-name',
      detail: `"name" must be plain text of 1-${LIMITS.name} characters with no markup`,
    };
  }

  const engineRange = raw.engines && typeof raw.engines === 'object'
    ? raw.engines.claudeTerminal
    : undefined;
  const appVersion = opts.appVersion || null;
  if (appVersion && !satisfiesRange(appVersion, engineRange)) {
    return {
      ok: false,
      reason: 'incompatible',
      detail: `requires Claude Terminal ${engineRange}, running ${appVersion}`,
    };
  }

  const description = isPlainText(raw.description, LIMITS.description) ? raw.description.trim() : null;
  const badge = isPlainText(raw.badge, LIMITS.badge) ? raw.badge.trim() : null;
  const category = CATEGORIES.includes(raw.category) ? raw.category : 'general';
  const color = typeof raw.color === 'string' && COLOR_RE.test(raw.color.trim())
    ? raw.color.trim().toLowerCase()
    : null;

  const detect = raw.detect && typeof raw.detect === 'object' && !Array.isArray(raw.detect)
    ? raw.detect
    : {};

  return {
    ok: true,
    value: {
      manifest: MANIFEST_VERSION,
      id: raw.id,
      typeId: EXTERNAL_ID_PREFIX + raw.id,
      name: raw.name.trim(),
      description,
      badge,
      category,
      color,
      icon: validateIcon(raw.icon),
      engines: { claudeTerminal: typeof engineRange === 'string' ? engineRange : '*' },
      detect: {
        files: sanitizeMarkers(detect.files),
        dirs: sanitizeMarkers(detect.dirs),
      },
    },
  };
}

/**
 * Validate one locale file.
 *
 * Only `name` and `description` are read, and only as plain text. An extension
 * cannot define a key outside its own namespace, so it cannot reword a
 * first-party string — "Bypass permissions" stays what it says.
 *
 * @param {*} raw
 * @returns {{name?: string, description?: string}|null} null when nothing usable
 */
function validateLocaleStrings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  if (isPlainText(raw.name, LIMITS.name)) out.name = raw.name.trim();
  if (isPlainText(raw.description, LIMITS.description)) out.description = raw.description.trim();
  return Object.keys(out).length ? out : null;
}

module.exports = {
  MANIFEST_VERSION,
  EXTENSIONS_DIRNAME,
  MANIFEST_FILENAME,
  EXTERNAL_ID_PREFIX,
  SUPPORTED_LOCALES,
  CATEGORIES,
  LIMITS,
  isPlainText,
  validateIcon,
  compareVersions,
  satisfiesRange,
  sanitizeMarkers,
  validateManifest,
  validateLocaleStrings,
};
