/**
 * Minecraft Project Type
 * Full type descriptor with all hooks for Minecraft server projects.
 */

const { createType } = require('../base-type');

module.exports = createType({
  ...require('./meta'),


  // Main process module (registered via src/main/ipc/index.js, not via registry)
  mainModule: () => null,

  // Lifecycle
  initialize: (context) => {
    // Minecraft state initialization is handled by the state module
  },

  cleanup: () => {
    // Cleanup handled by MinecraftService
  },

  // ProjectList (sidebar)
  getSidebarButtons: (ctx) => {
    const MinecraftProjectList = require('./renderer/MinecraftProjectList');
    return MinecraftProjectList.getSidebarButtons(ctx);
  },

  getProjectIcon: (ctx) => {
    const MinecraftProjectList = require('./renderer/MinecraftProjectList');
    return MinecraftProjectList.getProjectIcon(ctx);
  },

  getStatusIndicator: (ctx) => {
    const MinecraftProjectList = require('./renderer/MinecraftProjectList');
    return MinecraftProjectList.getStatusIndicator(ctx);
  },

  getProjectItemClass: (ctx) => {
    const MinecraftProjectList = require('./renderer/MinecraftProjectList');
    return MinecraftProjectList.getProjectItemClass(ctx);
  },

  getMenuItems: (ctx) => {
    const MinecraftProjectList = require('./renderer/MinecraftProjectList');
    return MinecraftProjectList.getMenuItems(ctx);
  },

  getDashboardIcon: (project) => {
    const MinecraftProjectList = require('./renderer/MinecraftProjectList');
    return MinecraftProjectList.getDashboardIcon();
  },

  bindSidebarEvents: (list, callbacks) => {
    const MinecraftProjectList = require('./renderer/MinecraftProjectList');
    MinecraftProjectList.bindSidebarEvents(list, callbacks);
  },

  // Dashboard
  getDashboardBadge: (project) => {
    const MinecraftDashboard = require('./renderer/MinecraftDashboard');
    return MinecraftDashboard.getDashboardBadge(project);
  },

  getDashboardStats: (ctx) => {
    const MinecraftDashboard = require('./renderer/MinecraftDashboard');
    return MinecraftDashboard.getDashboardStats(ctx);
  },

  // TerminalManager
  getTerminalPanels: (ctx) => {
    const MinecraftTerminalPanel = require('./renderer/MinecraftTerminalPanel');
    return [{
      id: 'minecraft-console',
      getWrapperHtml: () => MinecraftTerminalPanel.getWrapperHtml(),
      setupPanel: (wrapper, terminalId, projectIndex, project, deps) => {
        MinecraftTerminalPanel.setupPanel(wrapper, terminalId, projectIndex, project, deps);
      }
    }];
  },

  // Wizard creation
  getWizardFields: () => {
    const MinecraftWizard = require('./renderer/MinecraftWizard');
    return MinecraftWizard.getWizardFields();
  },

  onWizardTypeSelected: (form, isSelected) => {
    const MinecraftWizard = require('./renderer/MinecraftWizard');
    MinecraftWizard.onWizardTypeSelected(form, isSelected);
  },

  bindWizardEvents: (form, api) => {
    const MinecraftWizard = require('./renderer/MinecraftWizard');
    MinecraftWizard.bindWizardEvents(form, api);
  },

  getWizardConfig: (form) => {
    const MinecraftWizard = require('./renderer/MinecraftWizard');
    return MinecraftWizard.getWizardConfig(form);
  },

  // Project deletion cleanup
  onProjectDelete: (project, idx) => {
    try {
      const { getMinecraftServer } = require('./renderer/MinecraftState');
      const { stopMinecraftServer } = require('./renderer/MinecraftRendererService');
      const server = getMinecraftServer(idx);
      if (server.status !== 'stopped') {
        stopMinecraftServer(idx);
      }
    } catch (e) {
      console.error('[Minecraft] Error stopping server on delete:', e);
    }
  },

  // Project settings (per-project modal)
  getProjectSettings: (project) => [
    {
      key: 'minecraftConfig.jvmMemory',
      labelKey: 'minecraft.wizard.jvmMemory',
      type: 'text',
      placeholder: '2G',
      hintKey: 'minecraft.wizard.jvmMemoryHint'
    }
  ],

  // Assets
  getStyles: () => `
    .minecraft-status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
      background: var(--text-muted);
    }
    .minecraft-status-dot.stopped { background: var(--text-muted); }
    .minecraft-status-dot.starting { background: #f59e0b; animation: pulse 1.5s infinite; }
    .minecraft-status-dot.running { background: var(--success); box-shadow: 0 0 6px var(--success); }
    .dashboard-project-type.minecraft { background: rgba(34, 197, 94, 0.15); color: #22c55e; }
  `,

  afterProjectCreate: async (project, projectPath) => {
    if (project.minecraftConfig?.plugin) {
      try {
        const MinecraftWizard = require('./renderer/MinecraftWizard');
        await MinecraftWizard.generatePluginFiles(projectPath, project.minecraftConfig.plugin);
      } catch (e) {
        console.error('[Minecraft] Error generating plugin files:', e);
      }
    }
  },

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
      console.warn('[Minecraft] Failed to load translations:', e.message);
      return null;
    }
  },

  getPreloadBridge: () => ({
    namespace: 'minecraft',
    channels: {
      invoke: ['minecraft-start', 'minecraft-stop', 'minecraft-detect', 'minecraft-get-status'],
      send: ['minecraft-input', 'minecraft-resize'],
      on: ['minecraft-data', 'minecraft-exit', 'minecraft-status', 'minecraft-playercount']
    }
  })
});
