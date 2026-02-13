/**
 * Web App Project Type
 * Dev server management for web projects (Next.js, Vite, CRA, etc.)
 */

const { createType } = require('../base-type');

module.exports = createType({
  id: 'webapp',
  nameKey: 'newProject.types.webapp',
  descKey: 'newProject.types.webappDesc',
  category: 'general',
  icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.36 14c.08-.66.14-1.32.14-2 0-.68-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2m-5.15 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56M14.34 14H9.66c-.1-.66-.16-1.32-.16-2 0-.68.06-1.35.16-2h4.68c.09.65.16 1.32.16 2 0 .68-.07 1.34-.16 2M12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96M8 8H5.08A7.923 7.923 0 0 1 9.4 4.44C8.8 5.55 8.35 6.75 8 8m-2.92 8H8c.35 1.25.8 2.45 1.4 3.56A8.008 8.008 0 0 1 5.08 16m-.82-2C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2 0 .68.06 1.34.14 2M12 4.03c.83 1.2 1.48 2.54 1.91 3.97H10.09c.43-1.43 1.08-2.77 1.91-3.97M18.92 8h-2.95a15.65 15.65 0 0 0-1.38-3.56c1.84.63 3.37 1.9 4.33 3.56M12 2C6.47 2 2 6.5 2 12a10 10 0 0 0 10 10 10 10 0 0 0 10-10A10 10 0 0 0 12 2Z"/></svg>',

  // Main process (registered via src/main/ipc/index.js, not via registry)
  mainModule: () => null,

  initialize: () => {},
  cleanup: () => {},

  // ProjectList (sidebar)
  getSidebarButtons: (ctx) => {
    return require('./renderer/WebAppProjectList').getSidebarButtons(ctx);
  },

  getProjectIcon: () => {
    return require('./renderer/WebAppProjectList').getProjectIcon();
  },

  getStatusIndicator: (ctx) => {
    return require('./renderer/WebAppProjectList').getStatusIndicator(ctx);
  },

  getProjectItemClass: () => {
    return require('./renderer/WebAppProjectList').getProjectItemClass();
  },

  getMenuItems: (ctx) => {
    return require('./renderer/WebAppProjectList').getMenuItems(ctx);
  },

  getDashboardIcon: () => {
    return require('./renderer/WebAppProjectList').getDashboardIcon();
  },

  bindSidebarEvents: (list, callbacks) => {
    require('./renderer/WebAppProjectList').bindSidebarEvents(list, callbacks);
  },

  // Dashboard
  getDashboardBadge: (project) => {
    return require('./renderer/WebAppDashboard').getDashboardBadge(project);
  },

  getDashboardStats: (ctx) => {
    return require('./renderer/WebAppDashboard').getDashboardStats(ctx);
  },

  // TerminalManager
  getTerminalPanels: (ctx) => {
    const Panel = require('./renderer/WebAppTerminalPanel');
    return [{
      id: 'webapp-console',
      getWrapperHtml: () => Panel.getViewSwitcherHtml(),
      setupPanel: (wrapper, terminalId, projectIndex, project, deps) => {
        Panel.setupViewSwitcher(wrapper, terminalId, projectIndex, project, deps);
      }
    }];
  },

  // Wizard
  getWizardFields: () => {
    return require('./renderer/WebAppWizard').getWizardFields();
  },

  onWizardTypeSelected: (form, isSelected) => {
    require('./renderer/WebAppWizard').onWizardTypeSelected(form, isSelected);
  },

  bindWizardEvents: (form, api) => {
    require('./renderer/WebAppWizard').bindWizardEvents(form, api);
  },

  getWizardConfig: (form) => {
    return require('./renderer/WebAppWizard').getWizardConfig(form);
  },

  // Suppression
  onProjectDelete: (project, idx) => {
    try {
      const { getWebAppServer } = require('./renderer/WebAppState');
      const { stopDevServer } = require('./renderer/WebAppRendererService');
      const server = getWebAppServer(idx);
      if (server.status !== 'stopped') {
        stopDevServer(idx);
      }
    } catch (e) {
      console.error('[WebApp] Error stopping dev server on delete:', e);
    }
  },

  // Project settings (per-project modal)
  getProjectSettings: (project) => [
    {
      key: 'devCommand',
      labelKey: 'newProject.devCommand',
      type: 'text',
      placeholder: 'npm run dev',
      hintKey: 'webapp.devCommandHint'
    }
  ],

  // Settings
  getSettingsFields: () => [
    {
      key: 'webappPreviewEnabled',
      tab: 'performance',
      tabIcon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.46 10a1 1 0 0 0-.07 1 7.55 7.55 0 0 1 .52 1.81 8 8 0 0 1-.69 4.73 1 1 0 0 1-.89.53H5.68a1 1 0 0 1-.89-.54A8 8 0 0 1 13 4.14a1 1 0 0 1 .91 1.14 1 1 0 0 1-1.14.8A6 6 0 0 0 6.46 16h11.08A6 6 0 0 0 18 12.37a5.82 5.82 0 0 0-.39-1.37 1 1 0 0 1 .08-1 1 1 0 0 1 1.77 0zM12.71 9.71l3-3a1 1 0 1 0-1.42-1.42l-3 3a2 2 0 1 0 1.42 1.42z"/></svg>',
      tabLabel: 'Performance',
      sectionLabel: 'Web App',
      type: 'toggle',
      label: 'In-app Preview',
      labelKey: 'webapp.settings.previewEnabled',
      description: 'Show live preview of the dev server directly in the app',
      descKey: 'webapp.settings.previewEnabledDesc',
      default: true
    }
  ],

  // Assets
  getStyles: () => `
/* ========== Web App Type Styles ========== */

.webapp-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  margin-right: 6px;
  background: var(--text-secondary);
}

.webapp-status-dot.stopped {
  background: var(--text-secondary);
}

.webapp-status-dot.starting {
  background: #d29922;
  animation: webapp-pulse 1s ease-in-out infinite;
}

.webapp-status-dot.running {
  background: #3fb950;
  box-shadow: 0 0 6px rgba(63, 185, 80, 0.4);
}

@keyframes webapp-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.btn-action-primary.btn-webapp-start {
  background: var(--success);
}

.btn-action-primary.btn-webapp-start:hover {
  background: #16a34a;
}

.btn-action-primary.btn-webapp-stop {
  background: var(--danger);
}

.btn-action-primary.btn-webapp-stop:hover {
  background: #dc2626;
}

.btn-action-icon.btn-webapp-console {
  background: rgba(88, 166, 255, 0.15);
  color: #58a6ff;
}

.btn-action-icon.btn-webapp-console:hover {
  background: #58a6ff;
  color: white;
}

/* Terminal tab */
.terminal-tab.webapp-tab {
  border-bottom-color: #58a6ff;
}

.terminal-tab.webapp-tab .status-dot.webapp-dot {
  background: #58a6ff;
}

.terminal-tab.webapp-tab.active {
  color: #58a6ff;
  border-bottom-color: #58a6ff;
}

/* Wrapper */
.webapp-wrapper {
  display: flex;
  flex-direction: column;
  flex: 1;
  height: 100%;
  min-height: 0;
}

.webapp-view-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.dashboard-project-type.webapp {
  background: rgba(56, 139, 253, 0.15);
  color: #58a6ff;
}

.project-type-icon.webapp svg,
.wizard-type-badge-icon.webapp svg {
  color: #58a6ff;
}

.project-item.webapp-project .project-name svg {
  color: #58a6ff;
  width: 14px;
  height: 14px;
  margin-right: 6px;
  flex-shrink: 0;
}

/* View switcher */
.webapp-view-switcher {
  display: flex;
  gap: 1px;
  padding: 4px 8px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.webapp-view-tab {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 14px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s ease;
  letter-spacing: 0.2px;
}

.webapp-view-tab:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.webapp-view-tab.active {
  background: rgba(56, 139, 253, 0.12);
  color: #58a6ff;
}

.webapp-view-tab.active svg { opacity: 1; }
.webapp-view-tab svg { opacity: 0.5; }

/* Console view fills all space */
.webapp-console-view {
  flex: 1;
  min-height: 0;
}

/* Preview view */
.webapp-preview-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.webapp-preview-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.webapp-preview-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
  flex-shrink: 0;
}

.webapp-preview-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.webapp-preview-urlbar {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  height: 28px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  min-width: 0;
}

.webapp-preview-url-input {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: 'Consolas', monospace;
  font-size: 11.5px;
  outline: none;
  min-width: 0;
}

.webapp-preview-iframe {
  flex: 1;
  width: 100%;
  border: none;
  background: #fff;
  min-height: 0;
}

.webapp-preview-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-secondary);
  font-size: 13px;
}


/* Info view */
.webapp-info-view {
  overflow-y: auto;
}

.webapp-info-panel {
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 500px;
}

.webapp-info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--bg-secondary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
  transition: background 0.15s;
}

.webapp-info-row.clickable:hover {
  background: var(--bg-hover);
  border-color: #58a6ff;
}

.webapp-info-label {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
}

.webapp-info-value {
  color: var(--text-primary);
  font-size: 12px;
  display: flex;
  align-items: center;
}

.webapp-info-value code {
  background: var(--bg-tertiary);
  padding: 2px 8px;
  border-radius: 4px;
  font-family: 'Consolas', monospace;
  font-size: 11.5px;
  color: var(--text-primary);
}

.webapp-url-link {
  color: #58a6ff;
  font-family: 'Consolas', monospace;
  font-size: 12px;
}

.webapp-stat {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.webapp-stat .webapp-url-link {
  font-family: 'Consolas', monospace;
}
`,

  getTranslations: () => {
    try {
      return {
        en: require('./i18n/en.json'),
        fr: require('./i18n/fr.json')
      };
    } catch (e) {
      return null;
    }
  },

  getPreloadBridge: () => ({
    namespace: 'webapp',
    channels: {
      invoke: ['webapp-start', 'webapp-stop', 'webapp-detect-framework', 'webapp-get-port'],
      send: ['webapp-input', 'webapp-resize'],
      on: ['webapp-data', 'webapp-exit', 'webapp-port-detected']
    }
  })
});
