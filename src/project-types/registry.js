/**
 * Project Types Registry
 * Auto-discovers and manages project type descriptors.
 */

const { BASE_TYPE } = require('./base-type');

// Registered project types
const types = new Map();

// Categories for wizard grouping
const categories = [
  { id: 'general', nameKey: 'newProject.categories.general' },
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

  console.debug(`[Registry] Discovered ${types.size} project type(s): ${[...types.keys()].join(', ')}`);
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
