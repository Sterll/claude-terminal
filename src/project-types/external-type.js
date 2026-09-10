/**
 * External (extension) project type — descriptor builder.
 *
 * Turns a validated manifest, as returned by
 * `ProjectTypeExtensionService.listExtensions()`, into the same shape
 * `createType()` produces for a built-in. Every hook below is *this* file's
 * code: the manifest contributes strings, colours and marker names, never
 * behaviour. An extension cannot supply a function, so no function it supplied
 * can be called.
 *
 * Lint note: this file sits beside `registry.js`, which — like this one — matches
 * none of the globs in eslint.config.js: the project-type glob there reaches one
 * directory deeper than this. Nothing enforces the renderer boundary here, so it
 * is respected by hand: no `fs`, no `electron`, no reach into `src/main/`. Do not
 * add any.
 */

const { createType } = require('./base-type');
const { validateIcon, isPlainText, LIMITS } = require('../shared/project-type-manifest');

/**
 * Fallback icon, used when the manifest has none or supplied one that failed
 * validation. A type with no icon at all renders as a hole in the wizard, and an
 * extension being iconless is not a reason to make the grid look broken.
 */
const DEFAULT_ICON =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 2 7l10 5 10-5-10-5zm0 7.5L4.5 6 12 3.75 19.5 6 12 9.5zM2 17l10 5 10-5-2.1-1.05L12 19.5l-7.9-3.55L2 17zm0-5 10 5 10-5-2.1-1.05L12 14.5l-7.9-3.55L2 12z"/></svg>';

/**
 * Stylesheet for one extension.
 *
 * The manifest offers a hex colour and nothing else — no CSS. Under this app's
 * CSP a stylesheet cannot execute script, but it can reposition and recolour any
 * element on the page, and bounding that is much harder than bounding one hex
 * value. So the template is fixed, first-party, and every selector is scoped to
 * the type's own `ext-` class.
 *
 * @param {string} typeId - already `ext-`-prefixed and matched against /^[a-z0-9-]+$/
 * @param {string|null} color - validated `#rrggbb`, or null
 * @returns {string|null}
 */
function buildStyles(typeId, color) {
  if (!color) return null;
  const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)).join(', ');
  return `
/* ========== ${typeId} (extension) ========== */

.project-type-icon.${typeId} svg,
.wizard-type-badge-icon.${typeId} svg {
  color: ${color};
}

.dashboard-project-type.${typeId} {
  background: rgba(${rgb}, 0.15);
  color: ${color};
}

.project-item.${typeId}-project .project-name svg {
  color: ${color};
  width: 14px;
  height: 14px;
  margin-right: 6px;
  flex-shrink: 0;
}

.${typeId}-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 10px;
  font-size: var(--font-2xs);
  font-weight: 600;
  background: rgba(${rgb}, 0.15);
  color: ${color};
  white-space: nowrap;
}
`;
}

/**
 * Build the i18n bundle for one extension.
 *
 * Everything is namespaced under `ext.<id>.*`, so an extension can define its own
 * name and nothing else — it cannot reword a first-party string. The manifest's
 * own `name`/`description` are the value for every locale that ships no override,
 * which is also what makes a translation-less extension display correctly.
 *
 * @param {Object} manifest
 * @param {string[]} locales
 * @returns {Object<string, Object>}
 */
function buildTranslations(manifest, locales) {
  const bundle = {};
  for (const locale of locales) {
    const override = (manifest.translations && manifest.translations[locale]) || {};
    bundle[locale] = {
      ext: {
        [manifest.id]: {
          name: isPlainText(override.name, LIMITS.name) ? override.name : manifest.name,
          description: isPlainText(override.description, LIMITS.description)
            ? override.description
            : (manifest.description || ''),
        },
      },
    };
  }
  return bundle;
}

/**
 * Build a type descriptor from a validated manifest.
 *
 * Throws on a manifest that is not shaped as `validateManifest()` returns —
 * callers are expected to catch, so that one bad extension removes itself and
 * nothing else.
 *
 * @param {Object} manifest - a validated manifest, plus `translations`
 * @param {Object} [opts]
 * @param {string[]} [opts.locales] - locales to build a bundle for
 * @returns {Object} type descriptor, ready for registry.register()
 */
function createExternalType(manifest, opts = {}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('createExternalType: manifest must be an object');
  }
  const typeId = manifest.typeId;
  if (typeof typeId !== 'string' || !/^ext-[a-z][a-z0-9-]*$/.test(typeId)) {
    throw new Error(`createExternalType: unusable typeId ${JSON.stringify(typeId)}`);
  }

  // Re-validated rather than trusted. The manifest arrives over IPC from a
  // service that already checked it, but this builder is also the entry point
  // the tests and any future caller use, and a validator that only runs
  // somewhere else is a validator that eventually stops running.
  const icon = validateIcon(manifest.icon) || DEFAULT_ICON;
  const styles = buildStyles(typeId, manifest.color);
  const locales = opts.locales || ['en', 'fr', 'es', 'id', 'zh-CN'];
  const translations = buildTranslations(manifest, locales);

  const badge = isPlainText(manifest.badge, LIMITS.badge) ? manifest.badge : null;
  const markers = {
    files: Array.isArray(manifest.detect && manifest.detect.files) ? manifest.detect.files : [],
    dirs: Array.isArray(manifest.detect && manifest.detect.dirs) ? manifest.detect.dirs : [],
  };

  return createType({
    id: typeId,
    nameKey: `ext.${manifest.id}.name`,
    descKey: `ext.${manifest.id}.description`,
    category: manifest.category || 'general',
    icon,

    /** Marks this descriptor as coming from disk, for the UI and for teardown. */
    external: true,
    extensionId: manifest.id,
    extensionDir: manifest.dirName || null,

    /**
     * Detection markers, exposed as data. Matching them against a project
     * directory is the caller's job and uses the caller's `fs` — this module has
     * none, by design.
     */
    detectMarkers: markers,

    getProjectIcon: () => icon,
    getProjectItemClass: () => `${typeId}-project`,
    getDashboardIcon: () => icon,

    getDashboardBadge: () => (badge ? { label: badge, className: `${typeId}-badge` } : null),

    getStyles: () => styles,
    getTranslations: () => translations,

    // Everything else stays at the base-type default. An extension has no code,
    // so it has no wizard fields, no terminal panels, no console and no preload
    // bridge — those hooks exist to run type-specific behaviour, and there is
    // none to run.
  });
}

module.exports = { createExternalType, buildStyles, buildTranslations, DEFAULT_ICON };
