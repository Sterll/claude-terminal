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

/**
 * Initialize all renderer modules
 */
function initialize() {
  // Ensure directories exist
  utils.ensureDirectories();

  // Initialize state
  state.initializeState();

  // Initialize settings (applies accent color, etc.)
  services.SettingsService.initializeSettings();

  // Register IPC listeners
  services.TerminalService.registerTerminalListeners(
    // onData callback
    (id, data) => {
      // Can be used for notifications, title updates, etc.
    },
    // onExit callback
    (id) => {
      // Terminal exited
    }
  );

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

  // Preload dashboard data for all projects in background
  // Use setTimeout to not block the UI initialization
  setTimeout(() => {
    services.DashboardService.preloadAllProjects();
  }, 500);

  console.log('Renderer modules initialized');
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

  // Initialize function
  initialize
};
