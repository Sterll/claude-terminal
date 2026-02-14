/**
 * Renderer Process Bootstrap
 * Entry point for the renderer process modules
 */

// Utils
const utils = require('./utils');

// State
const state = require('./state');

// Services
const services = require('./services');

// UI Components
const ui = require('./ui');

// Features
const features = require('./features');

// Internationalization
const i18n = require('./i18n');

// Event system
const events = require('./events');

/**
 * Initialize all renderer modules
 */
function initialize() {
  // Ensure directories exist
  utils.ensureDirectories();

  // Initialize state
  state.initializeState();

  // Initialize i18n with saved language or auto-detect
  const savedLanguage = state.getSetting('language');
  i18n.initI18n(savedLanguage);

  // Initialize settings (applies accent color, etc.)
  services.SettingsService.initializeSettings();

  // Terminal IPC listeners are handled by TerminalManager's centralized dispatcher

  services.McpService.registerMcpListeners(
    // onOutput callback
    (id, type, data) => {
      // MCP output received
    },
    // onExit callback
    (id, code) => {
      // MCP process exited
    }
  );

  // Register WebApp listeners
  const { registerWebAppListeners } = require('../project-types/webapp/renderer/WebAppRendererService');
  registerWebAppListeners(
    (projectIndex, data) => {},
    (projectIndex, code) => {
      // WebApp dev server stopped - re-render sidebar
    }
  );

  // API listeners are registered in renderer.js (same pattern as webapp)

  services.FivemService.registerFivemListeners(
    // onData callback
    (projectIndex, data) => {
      // FiveM output received
    },
    // onExit callback
    (projectIndex, code) => {
      // FiveM server stopped
    },
    // onError callback
    (projectIndex, error) => {
      // FiveM error detected - show debug button
      ui.TerminalManager.showFivemErrorOverlay(projectIndex, error);
    }
  );

  // Initialize Claude event bus and provider
  events.initClaudeEvents();

  // Load disk-cached dashboard data immediately (sync, fast)
  services.DashboardService.loadAllDiskCaches();

  // Then refresh from APIs in background
  setTimeout(() => {
    services.DashboardService.preloadAllProjects();
  }, 500);

}

// Export everything for use in renderer.js
module.exports = {
  // Utils
  utils,
  ...utils,

  // State
  state,
  ...state,

  // Services
  services,
  ...services,

  // UI
  ui,
  ...ui,

  // Features
  features,
  ...features,

  // i18n
  i18n,
  ...i18n,

  // Events
  events,
  ...events,

  // Initialize function
  initialize
};
