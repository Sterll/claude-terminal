/**
 * Base Project Type
 * Default (no-op) implementations for all hooks.
 * Each project type extends this by overriding only what it needs.
 */

const BASE_TYPE = {
  // Identity
  id: '__base__',
  nameKey: '',
  descKey: '',
  category: 'general',
  icon: '',

  // Main process
  mainModule: () => null,

  // State renderer
  createState: () => null,

  // Lifecycle
  initialize: (context) => {},
  cleanup: () => {},

  // ProjectList (sidebar)
  getSidebarButtons: (ctx) => '',
  getProjectIcon: (ctx) => null,
  getStatusIndicator: (ctx) => '',
  getProjectItemClass: (ctx) => '',
  getMenuItems: (ctx) => '',
  getDashboardIcon: (project) => null,
  bindSidebarEvents: (list, callbacks) => {},

  // Dashboard
  getDashboardBadge: (project) => null,
  getDashboardStats: (ctx) => '',

  // TerminalManager
  getTerminalPanels: (ctx) => [],

  // Wizard creation
  getWizardFields: () => '',
  onWizardTypeSelected: (form, isSelected) => {},
  bindWizardEvents: (form, api) => {},
  getWizardConfig: (form) => ({}),

  // Suppression
  onProjectDelete: (project, idx) => {},

  // Settings (global app settings)
  getSettingsFields: () => [],

  // Project-specific settings (shown in per-project settings modal)
  getProjectSettings: (project) => [],

  // Assets
  getStyles: () => null,
  getTranslations: () => null,
  getPreloadBridge: () => null
};

/**
 * Merge a type descriptor with the base defaults
 * @param {Object} typeDescriptor - Partial type descriptor
 * @returns {Object} Complete type descriptor with all hooks
 */
function createType(typeDescriptor) {
  return { ...BASE_TYPE, ...typeDescriptor };
}

module.exports = { BASE_TYPE, createType };
