/**
 * Project Type Extension Service
 *
 * Discovers declarative project-type extensions in
 * `~/.claude-terminal/project-types/<name>/` and hands the renderer validated,
 * inert JSON. It never `require()`s anything it finds, never spawns anything,
 * and never reaches the network — the only thing it does with an extension
 * directory is read two kinds of small JSON file out of it.
 *
 * That restriction is the whole design, and `design/project-type-extensions.md`
 * argues it at length. The short version: the renderer half of a project type
 * would get the full `electron_api` surface and the main half would get
 * unrestricted Node, so v1 loads neither and ships a manifest format instead.
 *
 * Two properties this file is written around:
 *
 *   - **It never rejects.** A missing directory, an unreadable one, a directory
 *     full of garbage — all of them resolve normally, with the failures reported
 *     as data in `problems[]`. A broken extension must not be able to stop the
 *     app from starting, and the caller is the renderer's boot path.
 *
 *   - **The off-by-default gate is checked here too.** The renderer checks it
 *     before asking, but a renderer bug must not be sufficient to turn the
 *     feature on, so settings.json is re-read (read-only — it is the renderer's
 *     file to write) and nothing is marked enabled if the master switch is off.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  EXTENSIONS_DIRNAME,
  MANIFEST_FILENAME,
  SUPPORTED_LOCALES,
  LIMITS,
  validateManifest,
  validateLocaleStrings,
} = require('../../shared/project-type-manifest');

const errorLog = require('./ErrorLogService');

/** Where extensions live. Read at call time so tests can relocate HOME. */
function extensionsDir() {
  return path.join(os.homedir(), '.claude-terminal', EXTENSIONS_DIRNAME);
}

function settingsFile() {
  return path.join(os.homedir(), '.claude-terminal', 'settings.json');
}

/**
 * Read the two consent gates out of settings.json.
 *
 * Read-only and best-effort: an unreadable or malformed settings file means the
 * feature stays off, which is the same answer a fresh install gives.
 *
 * @returns {{enabled: boolean, allowed: string[]}}
 */
function readGate() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    const settings = JSON.parse(raw);
    return {
      enabled: settings.projectTypeExtensionsEnabled === true,
      allowed: Array.isArray(settings.enabledProjectTypeExtensions)
        ? settings.enabledProjectTypeExtensions.filter((id) => typeof id === 'string')
        : [],
    };
  } catch {
    return { enabled: false, allowed: [] };
  }
}

/**
 * Read a JSON file, refusing anything larger than the cap.
 *
 * @param {string} file
 * @returns {*} parsed JSON
 * @throws when missing, oversized or malformed — every caller catches
 */
function readJsonCapped(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${path.basename(file)} is not a file`);
  if (stat.size > LIMITS.manifestBytes) {
    throw new Error(`${path.basename(file)} is ${stat.size} bytes, cap is ${LIMITS.manifestBytes}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Read `i18n/<lang>.json` for one extension.
 *
 * Only the five supported locales are looked for, and only `name` /
 * `description` are kept, so an extension cannot define a key outside its own
 * namespace. A locale file that fails to parse is skipped silently: a missing
 * translation is a cosmetic problem, not a reason to refuse the extension.
 *
 * @param {string} dir - the extension directory
 * @returns {Object<string, {name?: string, description?: string}>}
 */
function readTranslations(dir) {
  const out = {};
  const i18nDir = path.join(dir, 'i18n');
  for (const locale of SUPPORTED_LOCALES) {
    try {
      const strings = validateLocaleStrings(readJsonCapped(path.join(i18nDir, `${locale}.json`)));
      if (strings) out[locale] = strings;
    } catch {
      // No file, or an unusable one. Either way the manifest's own strings stand.
    }
  }
  return out;
}

/**
 * Load one extension directory.
 *
 * @param {string} dir
 * @param {string} dirName
 * @param {string} appVersion
 * @returns {{ok: true, value: Object}|{ok: false, reason: string, detail: string}}
 */
function loadOne(dir, dirName, appVersion) {
  let raw;
  try {
    raw = readJsonCapped(path.join(dir, MANIFEST_FILENAME));
  } catch (err) {
    return {
      ok: false,
      reason: err && err.code === 'ENOENT' ? 'no-manifest' : 'unreadable',
      detail: err && err.message ? err.message : String(err),
    };
  }

  const result = validateManifest(raw, { appVersion });
  if (!result.ok) return result;

  return {
    ok: true,
    value: {
      ...result.value,
      dirName,
      translations: readTranslations(dir),
    },
  };
}

/**
 * Discover every extension on disk.
 *
 * Resolves — always — with:
 *
 *   {
 *     dir,               // where it looked, so the UI can offer "open folder"
 *     enabled,           // the master switch
 *     extensions: [ { ...manifest, status, dirName, translations } ],
 *     problems:   [ { id, reason, detail } ]
 *   }
 *
 * `status` is `enabled` (registerable), `disabled` (found, not opted in) or
 * `incompatible`. Incompatible extensions are listed rather than dropped: the
 * person who wrote one needs to see why it did not load.
 *
 * @param {Object} [opts]
 * @param {string} [opts.appVersion]
 * @returns {Promise<Object>}
 */
async function listExtensions(opts = {}) {
  const appVersion = opts.appVersion || require('../../../package.json').version;
  const dir = extensionsDir();
  const gate = readGate();
  const extensions = [];
  const problems = [];

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A missing directory is the normal case on a machine that has never used
    // the feature, and is not worth an error-log entry. Anything else is.
    if (!err || err.code !== 'ENOENT') {
      problems.push({ id: null, reason: 'unreadable-dir', detail: err && err.message ? err.message : String(err) });
      _warn(`Cannot read ${dir}: ${err && err.message}`);
    }
    return { dir, enabled: gate.enabled, extensions, problems };
  }

  const dirs = entries.filter((e) => e.isDirectory()).slice(0, LIMITS.extensions);
  if (entries.filter((e) => e.isDirectory()).length > LIMITS.extensions) {
    problems.push({
      id: null,
      reason: 'too-many',
      detail: `more than ${LIMITS.extensions} extension directories; the rest were ignored`,
    });
  }

  const seen = new Set();

  for (const entry of dirs) {
    // Every extension is loaded inside its own try/catch. One throw removes one
    // extension from the result and touches nothing else — that isolation is
    // the point, so it is not delegated to a shared wrapper further out.
    try {
      const result = loadOne(path.join(dir, entry.name), entry.name, appVersion);

      if (!result.ok) {
        problems.push({ id: entry.name, reason: result.reason, detail: result.detail });
        if (result.reason === 'incompatible') {
          extensions.push({
            id: entry.name,
            dirName: entry.name,
            name: entry.name,
            status: 'incompatible',
            detail: result.detail,
            translations: {},
          });
        }
        _warn(`Extension "${entry.name}" not loaded (${result.reason}): ${result.detail}`);
        continue;
      }

      if (seen.has(result.value.id)) {
        problems.push({ id: entry.name, reason: 'duplicate-id', detail: `id "${result.value.id}" is already used by another directory` });
        _warn(`Extension "${entry.name}" not loaded (duplicate-id): ${result.value.id}`);
        continue;
      }
      seen.add(result.value.id);

      extensions.push({
        ...result.value,
        status: gate.enabled && gate.allowed.includes(result.value.id) ? 'enabled' : 'disabled',
      });
    } catch (err) {
      problems.push({ id: entry.name, reason: 'threw', detail: err && err.message ? err.message : String(err) });
      _warn(`Extension "${entry.name}" threw while loading: ${err && err.message}`);
    }
  }

  return { dir, enabled: gate.enabled, extensions, problems };
}

/**
 * Create the extensions directory and return its path, so the UI can reveal it
 * in the file manager even before the user has put anything in it.
 *
 * @returns {Promise<{dir: string, created: boolean, error?: string}>}
 */
async function ensureExtensionsDir() {
  const dir = extensionsDir();
  try {
    if (fs.existsSync(dir)) return { dir, created: false };
    fs.mkdirSync(dir, { recursive: true });
    return { dir, created: true };
  } catch (err) {
    return { dir, created: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * A load failure is a `warning`, never a `critical`.
 *
 * Per ErrorLogService, `critical` is reserved for uncaughtException and
 * unhandledRejection — it means "the app broke". A malformed file in a folder
 * the user manages is not that, and inflating it would make the panel's
 * critical count stop meaning anything.
 */
function _warn(message) {
  try {
    errorLog.logWarning('project-types', message);
  } catch {
    // Logging must never be the thing that breaks the loader.
  }
}

module.exports = {
  listExtensions,
  ensureExtensionsDir,
  extensionsDir,
  readGate,
};
