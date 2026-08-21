/**
 * Minecraft Project Type
 * Full type descriptor with all hooks for Minecraft server projects.
 */

const { createType } = require('../base-type');

module.exports = createType({
  id: 'minecraft',
  nameKey: 'newProject.types.minecraft',
  descKey: 'newProject.types.minecraftDesc',
  category: 'gamedev',
  icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.644 2.44c-.179.033-.456.182-.603.331-.245.2-.588.232-2.023.133l-1.713-.116.049.713.049.713h.652c.36-.016 1.207-.05 1.876-.083l1.224-.083v3.317l-.44.05c-.425.05-.457.1-.457.862 0 .713-.05.813-.36.863-.26.033-.39.182-.44.464-.016.232-.114.448-.18.497-.08.05-.228.597-.326 1.211-.228 1.526-.375 1.708-1.37 1.84-1.436.167-2.056.134-2.056-.148 0-.2-.244-.25-1.158-.25-1.012 0-1.158-.032-1.24-.33-.065-.25-.228-.333-.62-.333s-.555.083-.62.332c-.082.299-.228.332-1.224.332-1.011 0-1.158.033-1.256.332-.049.182-.18.331-.26.331-.082 0-.148.863-.148 1.99 0 1.609.05 1.99.229 1.99.13 0 .293.15.342.332.082.282.245.332 1.175.332.914 0 1.077.05 1.142.331.13.465 1.11.465 1.24 0 .065-.282.228-.331 1.158-.331.849 0 1.077-.05 1.077-.25 0-.397 2.121-.33 3.426.117 1.583.53 5.14.53 6.82 0 .653-.199 1.256-.332 1.338-.282.359.232.163.896-.343 1.178-.587.298-.587.563 0 1.956l.343.797 1.599-.067c1.73-.083 2.822-.48 3.915-1.41l.539-.464-.31-.912c-.327-.962-.734-1.327-1.518-1.327-.342 0-.473-.149-.766-.796-.506-1.144-1.224-1.758-2.758-2.355-.799-.315-1.582-.746-1.99-1.127-.604-.548-.685-.73-.832-1.775-.098-.63-.245-1.194-.326-1.244-.066-.05-.164-.265-.18-.497-.049-.282-.18-.431-.424-.464-.326-.05-.375-.15-.375-.863 0-.763-.033-.812-.44-.862-.458-.05-.458-.05-.507-1.526-.032-.929.017-1.542.13-1.658.115-.116.93-.183 2.09-.183h1.908l.05-.564c.032-.298-.017-.63-.099-.713-.098-.1-.816-.083-1.909.05-1.256.15-1.778.15-1.86.017-.146-.25-.848-.481-1.24-.398z"/></svg>',

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
