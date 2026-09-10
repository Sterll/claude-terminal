/**
 * Project Types Registry
 * Auto-discovers and manages project type descriptors.
 */

const { BASE_TYPE } = require('./base-type');
const { createExternalType } = require('./external-type');

// Registered project types
const types = new Map();

// Ids of the types that came from ~/.claude-terminal/project-types/ rather than
// from this repo. Tracked separately so external types can be replaced on a
// reload without disturbing the built-ins, and so the UI can tell them apart.
const externalIds = new Set();

// Categories for wizard grouping
const categories = [
  { id: 'general', nameKey: 'newProject.categories.general' },
  { id: 'bots', nameKey: 'newProject.categories.bots' },
  { id: 'gamedev', nameKey: 'newProject.categories.gameDev' }
];

/**
 * Register a project type
 * @param {Object} typeDescriptor - Complete type descriptor (merged with base)
 */
function register(typeDescriptor) {
  if (!typeDescriptor.id) {
    console.error('[Registry] Type descriptor missing id:', typeDescriptor);
    return;
  }
  types.set(typeDescriptor.id, typeDescriptor);
}

/**
 * Discover and register all project types.
 * In bundled context, we manually require known types.
 */
function discoverAll() {
  // Clear previous registrations
  types.clear();
  externalIds.clear();

  // Require known types
  register(require('./general'));
  try {
    register(require('./fivem'));
  } catch (e) {
    console.warn('[Registry] Failed to load fivem type:', e.message);
  }
  try {
    register(require('./webapp'));
  } catch (e) {
    console.warn('[Registry] Failed to load webapp type:', e.message);
  }
  try {
    register(require('./python'));
  } catch (e) {
    console.warn('[Registry] Failed to load python type:', e.message);
  }
  try {
    register(require('./api'));
  } catch (e) {
    console.warn('[Registry] Failed to load api type:', e.message);
  }
  try {
    register(require('./minecraft'));
  } catch (e) {
    console.warn('[Registry] Failed to load minecraft type:', e.message);
  }
  try {
    register(require('./discord'));
  } catch (e) {
    console.warn('[Registry] Failed to load discord type:', e.message);
  }

  console.debug(`[Registry] Discovered ${types.size} project type(s): ${[...types.keys()].join(', ')}`);
}

// ── External (extension) types ───────────────────────────────────────────────
//
// Third-party project types, loaded from ~/.claude-terminal/project-types/ and
// off by default. What arrives here is *data* — a validated manifest, already
// checked by the main process — and the descriptor is built out of it by
// first-party code in `external-type.js`. No extension code is required, eval'd
// or otherwise executed, in this process or any other. The reasoning is in
// `design/project-type-extensions.md`; the short version is that a renderer
// module would hold the whole `electron_api` surface, so v1 does not load one.

/**
 * Drop every external type, leaving the built-ins alone.
 *
 * Also removes their injected stylesheets, so disabling an extension takes its
 * colours with it rather than leaving them applied to nothing.
 */
function clearExternal() {
  for (const id of externalIds) {
    types.delete(id);
    if (typeof document !== 'undefined') {
      const tag = document.querySelector(`style[data-project-type="${id}"]`);
      if (tag) tag.remove();
    }
  }
  externalIds.clear();
}

/**
 * Register the extensions returned by `electron_api.projectTypes.listExtensions()`.
 *
 * Only entries with `status === 'enabled'` are registered — the main process has
 * already applied both consent gates (the master switch and the per-extension
 * allowlist), and this re-checks the result rather than re-deriving it.
 *
 * Never throws. Each descriptor is built inside its own try/catch, so a manifest
 * that slips past validation and breaks the builder removes exactly itself. The
 * caller is the renderer's boot path; an exception here would be a blank window.
 *
 * @param {Array<Object>} entries - validated manifests from the main process
 * @param {Object} [options]
 * @param {Function} [options.mergeTranslations] - (lang, translations) => void
 * @returns {{registered: string[], failed: Array<{id: string, error: string}>}}
 */
function registerExternal(entries, options = {}) {
  clearExternal();

  const registered = [];
  const failed = [];
  if (!Array.isArray(entries)) return { registered, failed };

  for (const entry of entries) {
    try {
      if (!entry || entry.status !== 'enabled') continue;

      const type = createExternalType(entry);
      if (types.has(type.id)) {
        // A built-in already owns this id. Cannot happen while ids are
        // `ext-`-prefixed, but the prefix is a convention enforced elsewhere and
        // shadowing a built-in type is not a failure mode worth allowing back in
        // by accident.
        failed.push({ id: entry.id, error: `id "${type.id}" is already registered` });
        continue;
      }

      types.set(type.id, type);
      externalIds.add(type.id);
      registered.push(type.id);

      if (typeof options.mergeTranslations === 'function') {
        const bundle = type.getTranslations();
        if (bundle) {
          for (const lang of Object.keys(bundle)) {
            try {
              options.mergeTranslations(lang, bundle[lang]);
            } catch (e) {
              // A locale that will not merge costs this extension its name in
              // that language, and nothing else.
              console.warn(`[Registry] Extension "${entry.id}" translations failed for ${lang}:`, e.message);
            }
          }
        }
      }

      if (typeof document !== 'undefined') {
        const css = type.getStyles();
        if (css) {
          const existing = document.querySelector(`style[data-project-type="${type.id}"]`);
          if (existing) existing.remove();
          const style = document.createElement('style');
          style.setAttribute('data-project-type', type.id);
          style.textContent = css;
          document.head.appendChild(style);
        }
      }
    } catch (e) {
      failed.push({ id: (entry && entry.id) || null, error: e && e.message ? e.message : String(e) });
      console.warn(`[Registry] Failed to register extension "${entry && entry.id}":`, e && e.message);
    }
  }

  return { registered, failed };
}

/**
 * Ids of the currently registered external types.
 * @returns {string[]}
 */
function getExternalIds() {
  return [...externalIds];
}

/**
 * Is this type id one that came from an extension?
 * @param {string} typeId
 * @returns {boolean}
 */
function isExternal(typeId) {
  return externalIds.has(typeId);
}

/**
 * Get a type descriptor by ID (fallback to 'standalone')
 * @param {string} typeId
 * @returns {Object}
 */
function get(typeId) {
  return types.get(typeId) || types.get('standalone') || { ...BASE_TYPE, id: 'standalone' };
}

/**
 * Get all registered types
 * @returns {Object[]}
 */
function getAll() {
  return [...types.values()];
}

/**
 * Get types grouped by category for the wizard
 * @returns {Array<{category: Object, types: Object[]}>}
 */
function getByCategory() {
  return categories.map(cat => ({
    category: cat,
    types: getAll().filter(t => t.category === cat.id)
  })).filter(group => group.types.length > 0);
}

/**
 * Get all categories
 * @returns {Array}
 */
function getCategories() {
  return categories;
}

/**
 * Initialize all types
 * @param {Object} context - App context (mainWindow, etc.)
 */
function initializeAll(context) {
  types.forEach(type => {
    try {
      type.initialize(context);
    } catch (e) {
      console.error(`[Registry] Error initializing type ${type.id}:`, e);
    }
  });
}

/**
 * Cleanup all types
 */
function cleanupAll() {
  types.forEach(type => {
    try {
      type.cleanup();
    } catch (e) {
      console.error(`[Registry] Error cleaning up type ${type.id}:`, e);
    }
  });
}

/**
 * Inject all type-specific CSS into the document
 */
function injectAllStyles() {
  types.forEach(type => {
    const css = type.getStyles();
    if (css) {
      // Remove existing style tag for this type
      const existing = document.querySelector(`style[data-project-type="${type.id}"]`);
      if (existing) existing.remove();

      const style = document.createElement('style');
      style.setAttribute('data-project-type', type.id);
      style.textContent = css;
      document.head.appendChild(style);
    }
  });
}

/**
 * Load and merge all type-specific translations
 * @param {Function} mergeFn - i18n merge function (lang, translations) => void
 */
function loadAllTranslations(mergeFn) {
  types.forEach(type => {
    const translations = type.getTranslations();
    if (translations) {
      Object.keys(translations).forEach(lang => {
        mergeFn(lang, translations[lang]);
      });
    }
  });
}

/**
 * Register all type-specific IPC handlers (main process)
 * @param {Object} context - { mainWindow }
 */
function registerAllMainHandlers(context) {
  types.forEach(type => {
    const mainModule = type.mainModule();
    if (mainModule && mainModule.registerHandlers) {
      mainModule.registerHandlers(context);
    }
  });
}

/**
 * Get preload bridge configuration for all types
 * @returns {Object[]} Array of { namespace, channels }
 */
function getAllPreloadBridges() {
  const bridges = [];
  types.forEach(type => {
    const bridge = type.getPreloadBridge();
    if (bridge) bridges.push(bridge);
  });
  return bridges;
}

/**
 * Collect settings fields from all types, grouped by tab
 * @returns {Map<string, { icon: string, label: string, fields: Array }>}
 */
function collectAllSettingsFields() {
  const tabs = new Map();
  types.forEach(type => {
    const fields = type.getSettingsFields();
    if (!fields || !fields.length) return;
    for (const field of fields) {
      if (!field.tab) continue;
      if (!tabs.has(field.tab)) {
        tabs.set(field.tab, {
          icon: field.tabIcon || '',
          label: field.tabLabel || field.tab,
          sections: new Map()
        });
      }
      const tab = tabs.get(field.tab);
      const sectionId = type.id;
      if (!tab.sections.has(sectionId)) {
        tab.sections.set(sectionId, {
          typeId: type.id,
          typeName: field.sectionLabel || type.nameKey,
          typeIcon: type.icon || '',
          fields: []
        });
      }
      tab.sections.get(sectionId).fields.push(field);
    }
  });
  return tabs;
}

module.exports = {
  register,
  discoverAll,
  registerExternal,
  clearExternal,
  getExternalIds,
  isExternal,
  get,
  getAll,
  getByCategory,
  getCategories,
  initializeAll,
  cleanupAll,
  injectAllStyles,
  loadAllTranslations,
  registerAllMainHandlers,
  getAllPreloadBridges,
  collectAllSettingsFields
};
