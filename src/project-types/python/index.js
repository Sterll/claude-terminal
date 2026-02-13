/**
 * Python Project Type
 * Python environment detection (version, venv, deps, entry point)
 */

const { createType } = require('../base-type');

module.exports = createType({
  id: 'python',
  nameKey: 'newProject.types.python',
  descKey: 'newProject.types.pythonDesc',
  category: 'general',
  icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.585 11.692h4.328s2.432.039 2.432-2.35V5.391S16.714 3 11.936 3C7.362 3 7.647 4.986 7.647 4.986l.006 2.055h4.363v.617H5.92S3 7.28 3 11.874s2.569 4.426 2.569 4.426h1.533v-2.13s-.083-2.569 2.527-2.569l.004.004h-.048v.087zm-.272-4.41a.829.829 0 110-1.658.829.829 0 010 1.658zM14.415 12.308h-4.328s-2.432-.039-2.432 2.35v3.951S7.286 21 12.064 21c4.574 0 4.289-1.986 4.289-1.986l-.006-2.055h-4.363v-.617h6.096S21 16.72 21 12.126s-2.569-4.426-2.569-4.426h-1.533v2.13s.083 2.569-2.527 2.569l-.004-.004h.048v-.087zm.272 4.41a.829.829 0 110 1.658.829.829 0 010-1.658z"/></svg>',

  // Main process (registered via src/main/ipc/index.js, not via registry)
  mainModule: () => null,

  initialize: () => {},
  cleanup: () => {},

  // ProjectList (sidebar)
  getSidebarButtons: (ctx) => {
    return require('./renderer/PythonProjectList').getSidebarButtons(ctx);
  },

  getProjectIcon: () => {
    return require('./renderer/PythonProjectList').getProjectIcon();
  },

  getStatusIndicator: (ctx) => {
    return require('./renderer/PythonProjectList').getStatusIndicator(ctx);
  },

  getProjectItemClass: () => {
    return require('./renderer/PythonProjectList').getProjectItemClass();
  },

  getMenuItems: (ctx) => {
    return require('./renderer/PythonProjectList').getMenuItems(ctx);
  },

  getDashboardIcon: () => {
    return require('./renderer/PythonProjectList').getDashboardIcon();
  },

  bindSidebarEvents: (list, callbacks) => {
    require('./renderer/PythonProjectList').bindSidebarEvents(list, callbacks);
  },

  // Dashboard
  getDashboardBadge: (project) => {
    return require('./renderer/PythonDashboard').getDashboardBadge(project);
  },

  getDashboardStats: (ctx) => {
    return require('./renderer/PythonDashboard').getDashboardStats(ctx);
  },

  // Wizard
  getWizardFields: () => {
    return require('./renderer/PythonWizard').getWizardFields();
  },

  onWizardTypeSelected: (form, isSelected) => {
    require('./renderer/PythonWizard').onWizardTypeSelected(form, isSelected);
  },

  bindWizardEvents: (form, api) => {
    require('./renderer/PythonWizard').bindWizardEvents(form, api);
  },

  getWizardConfig: (form) => {
    return require('./renderer/PythonWizard').getWizardConfig(form);
  },

  // Suppression
  onProjectDelete: (project, idx) => {
    try {
      const { removePythonInfo } = require('./renderer/PythonState');
      removePythonInfo(idx);
    } catch (e) {
      console.error('[Python] Error cleaning up on delete:', e);
    }
  },

  // Assets
  getStyles: () => `
/* ========== Python Type Styles ========== */

.python-version-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 600;
  background: rgba(55, 118, 171, 0.15);
  color: #3776ab;
  white-space: nowrap;
}

.python-version-badge svg {
  color: #3776ab;
}

.python-venv-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}

.python-venv-dot.python-venv-active {
  background: #3fb950;
  box-shadow: 0 0 6px rgba(63, 185, 80, 0.4);
}

.python-venv-dot.python-venv-absent {
  background: var(--text-secondary);
  opacity: 0.5;
}

.dashboard-project-type.python {
  background: rgba(55, 118, 171, 0.15);
  color: #3776ab;
}

.project-type-icon.python svg,
.wizard-type-badge-icon.python svg {
  color: #3776ab;
}

.project-item.python-project .project-name svg {
  color: #3776ab;
  width: 14px;
  height: 14px;
  margin-right: 6px;
  flex-shrink: 0;
}

.python-stat {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
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
    namespace: 'python',
    channels: {
      invoke: ['python-detect-info'],
      send: [],
      on: []
    }
  })
});
