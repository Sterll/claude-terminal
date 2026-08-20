/**
 * FiveM Project Type
 * Full type descriptor with all hooks for FiveM server projects.
 */

const { createType } = require('../base-type');

module.exports = createType({
  id: 'fivem',
  nameKey: 'newProject.types.fivem',
  descKey: 'newProject.types.fivemDesc',
  category: 'gamedev',
  icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22.4 24h-5.225c-.117 0-.455-1.127-1.026-3.375c-1.982-6.909-3.124-10.946-3.417-12.12l3.37-3.325h.099c.454 1.42 2.554 7.676 6.299 18.768ZM12.342 7.084h-.048a3.382 3.385 0 0 1-.098-.492v-.098a102.619 102.715 0 0 1 3.272-3.275c.13.196.196.356.196.491v.05a140.694 140.826 0 0 1-3.322 3.324ZM5.994 10.9h-.05c.67-2.12 1.076-3.209 1.223-3.275L14.492.343c.08 0 .258.524.533 1.562zm1.37-4.014h-.05C8.813 2.342 9.612.048 9.71 0h4.495v.05a664.971 664.971 0 0 1-6.841 6.839Zm-2.69 7.874h-.05c.166-.798.554-1.418 1.174-1.855a312.918 313.213 0 0 1 5.71-5.717h.05c-.117.672-.375 1.175-.781 1.52zM1.598 24l-.098-.05c1.399-4.172 2.148-6.322 2.248-6.45l6.74-6.694v.05C10.232 11.88 8.974 16.263 6.73 24Z"/></svg>',

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
        id: require('./i18n/id.json')
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
