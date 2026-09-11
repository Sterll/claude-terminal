/**
 * Project Types Registry
 * Auto-discovers and manages project type descriptors.
 *
 * -- Identity is eager, behaviour is not ------------------------------------
 *
 * Every type has two halves. `<type>/meta.js` is its identity - id, nameKey,
 * descKey, category, icon - a few hundred bytes, and the registry needs all
 * seven of them at boot to list the types in the new-project wizard and to look
 * one up by id. `<type>/index.js` is its behaviour: ~30 hooks, and behind them
 * the dashboards, wizards, sidebar renderers and terminal panels that made the
 * seven types 362 KB of the startup bundle for every user, including the ones
 * who have never owned a FiveM server or a Discord bot.
 *
 * So `discoverAll()` registers seven identities synchronously and loads no
 * behaviour at all; `ensureLoaded()` merges a type's hooks in when something
 * actually needs them. A type that has not been loaded yet answers every
 * behaviour hook with the BASE_TYPE no-op, which is the same answer it already
 * gives for a hook it does not implement.
 *
 * That fallback is safe only because callers are disciplined about it, and the
 * discipline is: anything that can reach a hook must have awaited the load
 * first. In practice there are three shapes of caller:
 *
 *   - `registry.get(project.type)` - keyed on a project that exists, and the
 *     boot path awaits ensureLoadedMany() for every type present in
 *     projects.json before the first render. ProjectList, DashboardService,
 *     QuickPicker and TerminalManager are all this shape.
 *   - `registry.getAll().forEach(t => t.someHook(...))` - a broadcast. An
 *     unloaded type contributing nothing is correct here: it has no project in
 *     the list, so it has nothing in the menu being bound either.
 *   - "show me every type" surfaces - the new-project wizard and the settings
 *     panel's per-type tabs. Both await `ensureAllLoaded()` in renderer.js
 *     before they render.
 *
 * The import() calls below are a literal map rather than a computed specifier
 * on purpose: esbuild resolves a template-literal import() by bundling the
 * whole directory, which would put every type back in the graph and quietly
 * undo all of this.
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

// -- Built-in types ---------------------------------------------------------

/**
 * The behaviour loader for each built-in, by type id. Literal specifiers, one
 * per line - see the file header for why this is not a computed import().
 *
 * 'standalone' is absent deliberately: general/index.js is identity and nothing
 * else, so it is registered whole at discovery and has no second half to fetch.
 */
const BEHAVIOUR_LOADERS = {
  fivem: () => import('./fivem'),
  webapp: () => import('./webapp'),
  python: () => import('./python'),
  api: () => import('./api'),
  minecraft: () => import('./minecraft'),
  discord: () => import('./discord'),
};

/** Identity halves, required eagerly. Cheap: five fields and an inline SVG. */
const BUILTIN_META = [
  require('./general'),
  require('./fivem/meta'),
  require('./webapp/meta'),
  require('./python/meta'),
  require('./api/meta'),
  require('./minecraft/meta'),
  require('./discord/meta'),
];

/**
 * The renderer's i18n merge function, kept from the loadAllTranslations() call
 * on the boot path.
 *
 * Every type used to be present by the time that ran, so merging once was
 * enough. Now a type arrives whenever something needs it, and its strings have
 * to follow it in - a FiveM console labelled with raw dot-paths is exactly the
 * failure this lazy loading would otherwise introduce.
 * @type {Function|null}
 */
let translationMerger = null;

/**
 * Inject a type's stylesheet and merge its translations. Idempotent: the style
 * tag is keyed by type id and replaced, and merging the same bundle twice is a
 * no-op for the i18n catalog.
 * @param {Object} type
 */
function applyTypeAssets(type) {
  if (!type) return;

  if (translationMerger) {
    let bundle = null;
    try {
      bundle = type.getTranslations();
    } catch (e) {
      console.warn(`[Registry] ${type.id} translations failed to load:`, e && e.message);
    }
    if (bundle) {
      for (const lang of Object.keys(bundle)) {
        try {
          translationMerger(lang, bundle[lang]);
        } catch (e) {
          // One locale that will not merge costs this type its strings in that
          // language, and nothing else.
          console.warn(`[Registry] ${type.id} translations failed for ${lang}:`, e && e.message);
        }
      }
    }
  }

  if (typeof document === 'undefined') return;
  let css = null;
  try {
    css = type.getStyles();
  } catch (e) {
    console.warn(`[Registry] ${type.id} styles failed to load:`, e && e.message);
  }
  if (!css) return;
  const existing = document.querySelector(`style[data-project-type="${type.id}"]`);
  if (existing) existing.remove();
  const style = document.createElement('style');
  style.setAttribute('data-project-type', type.id);
  style.textContent = css;
  document.head.appendChild(style);
}

/** In-flight or settled behaviour loads, by type id. */
const behaviourLoads = new Map();

/** Ids whose behaviour half is merged in and ready. */
const loadedBehaviour = new Set();

/** The five fields meta.js owns, and that a behaviour half may not restate. */
function pickIdentity(type) {
  return {
    id: type.id,
    nameKey: type.nameKey,
    descKey: type.descKey,
    category: type.category,
    icon: type.icon,
  };
}

/**
 * Discover and register all project types.
 *
 * Synchronous, and it loads no behaviour: what lands in `types` is each
 * built-in's identity merged over the BASE_TYPE no-ops. Call `ensureLoaded()`
 * before invoking a hook on one of them.
 */
function discoverAll() {
  // Clear previous registrations
  types.clear();
  externalIds.clear();
  behaviourLoads.clear();
  loadedBehaviour.clear();

  for (const meta of BUILTIN_META) {
    register({ ...BASE_TYPE, ...meta });
  }
  // general/index.js has no behaviour half to wait for.
  loadedBehaviour.add('standalone');

  console.debug(`[Registry] Discovered ${types.size} project type(s): ${[...types.keys()].join(', ')}`);
}

/**
 * Is this type ready to have its hooks called?
 * @param {string} typeId
 * @returns {boolean}
 */
function isLoaded(typeId) {
  return loadedBehaviour.has(typeId) || externalIds.has(typeId);
}

/**
 * Load one built-in's behaviour half and merge it over its identity.
 *
 * Never rejects. A type whose chunk will not load keeps the identity it was
 * discovered with and answers hooks with the base no-ops - the same outcome
 * discoverAll() used to produce when one of its require() calls threw, which is
 * what the try/catch around each one was for.
 *
 * @param {string} typeId
 * @returns {Promise<boolean>} true once the behaviour is in place
 */
function ensureLoaded(typeId) {
  if (!typeId || isLoaded(typeId)) return Promise.resolve(true);

  const loader = BEHAVIOUR_LOADERS[typeId];
  if (!loader) return Promise.resolve(false);

  const existing = behaviourLoads.get(typeId);
  if (existing) return existing;

  const load = loader().then((mod) => {
    // esbuild exposes a CommonJS module's exports as the default export.
    const behaviour = mod.default || mod;
    if (!behaviour || behaviour.id !== typeId) {
      throw new Error(`behaviour module for "${typeId}" declared id "${behaviour && behaviour.id}"`);
    }
    // Identity stays whatever discovery registered, so a behaviour half cannot
    // rename or recategorise a type after the wizard has already drawn it.
    const identity = types.get(typeId);
    types.set(typeId, { ...behaviour, ...(identity ? pickIdentity(identity) : {}) });
    loadedBehaviour.add(typeId);
    // The boot-path injectAllStyles()/loadAllTranslations() ran before this
    // type existed in anything but name, so its assets arrive with it.
    applyTypeAssets(types.get(typeId));
    return true;
  }).catch((err) => {
    console.warn(`[Registry] Failed to load the ${typeId} type:`, err && err.message);
    // Dropped rather than kept, so a load that failed on a flaky first attempt
    // is retried the next time something needs the type.
    behaviourLoads.delete(typeId);
    return false;
  });

  behaviourLoads.set(typeId, load);
  return load;
}

/**
 * Load the behaviour of several types at once.
 *
 * Resolves to the ids that were *newly* loaded, so a caller watching the
 * project list can repaint only when something actually arrived. Ids that are
 * already loaded, and ids no built-in loader answers to (an external type, a
 * type string from a projects.json this build does not know), are filtered out
 * first - otherwise a watcher would retry them on every state change forever.
 *
 * @param {Iterable<string>} typeIds
 * @returns {Promise<string[]>} the ids whose behaviour this call brought in
 */
function ensureLoadedMany(typeIds) {
  const ids = [...new Set([...(typeIds || [])].filter(Boolean))]
    .filter(id => !isLoaded(id) && BEHAVIOUR_LOADERS[id]);
  if (!ids.length) return Promise.resolve([]);
  return Promise.all(ids.map(ensureLoaded)).then(ok => ids.filter((_, i) => ok[i]));
}

/**
 * Load every built-in's behaviour.
 *
 * For the two surfaces that show all types at once - the new-project wizard and
 * the settings panel's per-type tabs. Both are opened by a deliberate user
 * action, which is the point: nobody pays for the FiveM console renderer on the
 * way to their first paint.
 *
 * @returns {Promise<void>}
 */
function ensureAllLoaded() {
  return ensureLoadedMany(Object.keys(BEHAVIOUR_LOADERS));
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
  // Kept for the types that are not loaded yet - see applyTypeAssets().
  translationMerger = mergeFn;
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
  ensureLoaded,
  ensureLoadedMany,
  ensureAllLoaded,
  isLoaded,
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
