/**
 * FiveM Project Type
 * Full type descriptor with all hooks for FiveM server projects.
 */

const { createType } = require('../base-type');

module.exports = createType({
  ...require('./meta'),


  // Main process module (registered via src/main/ipc/index.js, not via registry)
  mainModule: () => null,

  // Lifecycle
  initialize: (context) => {
    // FiveM state initialization is handled by the state module
  },

  cleanup: () => {
    // Cleanup handled by FivemService
  },

  // ProjectList (sidebar)
  getSidebarButtons: (ctx) => {
    const FivemProjectList = require('./renderer/FivemProjectList');
    return FivemProjectList.getSidebarButtons(ctx);
  },

  getProjectIcon: (ctx) => {
    const FivemProjectList = require('./renderer/FivemProjectList');
    return FivemProjectList.getProjectIcon(ctx);
  },

  getStatusIndicator: (ctx) => {
    const FivemProjectList = require('./renderer/FivemProjectList');
    return FivemProjectList.getStatusIndicator(ctx);
  },

  getProjectItemClass: (ctx) => {
    const FivemProjectList = require('./renderer/FivemProjectList');
    return FivemProjectList.getProjectItemClass(ctx);
  },

  getMenuItems: (ctx) => {
    const FivemProjectList = require('./renderer/FivemProjectList');
    return FivemProjectList.getMenuItems(ctx);
  },

  getDashboardIcon: (project) => {
    const FivemProjectList = require('./renderer/FivemProjectList');
    return FivemProjectList.getDashboardIcon();
  },

  bindSidebarEvents: (list, callbacks) => {
    const FivemProjectList = require('./renderer/FivemProjectList');
    FivemProjectList.bindSidebarEvents(list, callbacks);
  },

  // Dashboard
  getDashboardBadge: (project) => {
    const FivemDashboard = require('./renderer/FivemDashboard');
    return FivemDashboard.getDashboardBadge(project);
  },

  getDashboardStats: (ctx) => {
    const FivemDashboard = require('./renderer/FivemDashboard');
    return FivemDashboard.getDashboardStats(ctx);
  },

  // Console management (type-specific consoles)
  getConsoleConfig: (project, projectIndex) => {
    const FivemConsoleManager = require('./renderer/FivemConsoleManager');
    return FivemConsoleManager.getConsoleConfig(project, projectIndex);
  },

  showErrorOverlay: (projectIndex, error, tmApi) => {
    const FivemConsoleManager = require('./renderer/FivemConsoleManager');
    FivemConsoleManager.showErrorOverlay(projectIndex, error, tmApi);
  },

  hideErrorOverlay: (projectIndex) => {
    const FivemConsoleManager = require('./renderer/FivemConsoleManager');
    FivemConsoleManager.hideErrorOverlay(projectIndex);
  },

  onConsoleError: (projectIndex, error, tmApi) => {
    const FivemConsoleManager = require('./renderer/FivemConsoleManager');
    FivemConsoleManager.onConsoleError(projectIndex, error, tmApi);
  },

  // TerminalManager
  getTerminalPanels: (ctx) => {
    // Return panel config for FiveM console
    const FivemTerminalPanel = require('./renderer/FivemTerminalPanel');
    return [{
      id: 'fivem-console',
      getWrapperHtml: () => FivemTerminalPanel.getViewSwitcherHtml(),
      setupPanel: (wrapper, terminalId, projectIndex, project, deps) => {
        FivemTerminalPanel.setupViewSwitcher(wrapper, terminalId, projectIndex, project, deps);
        FivemTerminalPanel.updateErrorBadge(wrapper, projectIndex, deps);
      },
      onNewError: (wrapper, projectIndex, deps) => {
        FivemTerminalPanel.onNewError(wrapper, projectIndex, deps);
      },
      updateErrorBadge: (wrapper, projectIndex, deps) => {
        FivemTerminalPanel.updateErrorBadge(wrapper, projectIndex, deps);
      }
    }];
  },

  // Wizard creation
  getWizardFields: () => {
    const FivemWizard = require('./renderer/FivemWizard');
    return FivemWizard.getWizardFields();
  },

  onWizardTypeSelected: (form, isSelected) => {
    const FivemWizard = require('./renderer/FivemWizard');
    FivemWizard.onWizardTypeSelected(form, isSelected);
  },

  bindWizardEvents: (form, api) => {
    const FivemWizard = require('./renderer/FivemWizard');
    FivemWizard.bindWizardEvents(form, api);
  },

  getWizardConfig: (form) => {
    const FivemWizard = require('./renderer/FivemWizard');
    return FivemWizard.getWizardConfig(form);
  },

  // Suppression
  onProjectDelete: (project, idx) => {
    try {
      const { getFivemServer } = require('./renderer/FivemState');
      const { stopFivemServer } = require('./renderer/FivemRendererService');
      const server = getFivemServer(idx);
      if (server.status !== 'stopped') {
        stopFivemServer(idx);
      }
    } catch (e) {
      console.error('[FiveM] Error stopping server on delete:', e);
    }
  },

  // Project settings (per-project modal)
  getProjectSettings: (project) => [
    {
      key: 'runCommand',
      labelKey: 'fivem.runCommand',
      type: 'text',
      placeholder: './FXServer.exe +exec server.cfg',
      hintKey: 'fivem.runCommandHint'
    }
  ],

  // Assets
  getStyles: () => null, // CSS stays in styles.css for now (Phase 7)

  getTranslations: () => {
    try {
      return {
        en: require('./i18n/en.json'),
        fr: require('./i18n/fr.json'),
        es: require('./i18n/es.json'),
        id: require('./i18n/id.json'),
        'zh-CN': require('./i18n/zh-CN.json')
      };
    } catch (e) {
      console.warn('[FiveM] Failed to load translations:', e.message);
      return null;
    }
  },

  getPreloadBridge: () => ({
    namespace: 'fivem',
    channels: {
      invoke: ['fivem-start', 'fivem-stop', 'fivem-scan-resources', 'fivem-resource-command'],
      send: ['fivem-input', 'fivem-resize'],
      on: ['fivem-data', 'fivem-exit']
    }
  })
});
