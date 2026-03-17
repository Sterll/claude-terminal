/**
 * Discord Bot Project Type
 * Bot lifecycle management, command scanning, event tracking
 */

const { createType } = require('../base-type');

module.exports = createType({
  id: 'discord',
  nameKey: 'newProject.types.discord',
  descKey: 'newProject.types.discordDesc',
  category: 'bots',
  icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>',

  // Main process (registered via src/main/ipc/index.js)
  mainModule: () => null,

  initialize: () => {},
  cleanup: () => {
    // Cleanup handled by DiscordService in main process
  },

  // ProjectList (sidebar)
  getSidebarButtons: (ctx) => {
    return require('./renderer/DiscordProjectList').getSidebarButtons(ctx);
  },

  getProjectIcon: () => {
    return require('./renderer/DiscordProjectList').getProjectIcon();
  },

  getStatusIndicator: (ctx) => {
    return require('./renderer/DiscordProjectList').getStatusIndicator(ctx);
  },

  getProjectItemClass: () => {
    return require('./renderer/DiscordProjectList').getProjectItemClass();
  },

  getMenuItems: (ctx) => {
    return require('./renderer/DiscordProjectList').getMenuItems(ctx);
  },

  getDashboardIcon: () => {
    return require('./renderer/DiscordProjectList').getDashboardIcon();
  },

  bindSidebarEvents: (list, callbacks) => {
    require('./renderer/DiscordProjectList').bindSidebarEvents(list, callbacks);
  },

  // Dashboard
  getDashboardBadge: (project) => {
    return require('./renderer/DiscordDashboard').getDashboardBadge(project);
  },

  getDashboardStats: (ctx) => {
    return require('./renderer/DiscordDashboard').getDashboardStats(ctx);
  },

  // Console management
  getConsoleConfig: (project, projectIndex) => ({
    typeId: 'discord',
    tabIcon: '🤖',
    tabClass: 'discord-tab',
    dotClass: 'discord-dot',
    wrapperClass: 'discord-wrapper',
    consoleViewSelector: '.discord-console-view',
    ipcNamespace: 'discord',
    scrollback: 10000,
    getExistingLogs: (pi) => {
      try {
        const { getDiscordServer } = require('./renderer/DiscordState');
        const server = getDiscordServer(pi);
        return (server && server.logs) ? server.logs : [];
      } catch (e) { return []; }
    },
    onCleanup: (wrapper) => {
      try { require('./renderer/DiscordTerminalPanel').cleanup(wrapper); } catch (e) {}
    }
  }),

  // TerminalManager
  getTerminalPanels: (ctx) => {
    const Panel = require('./renderer/DiscordTerminalPanel');
    return [{
      id: 'discord-console',
      getWrapperHtml: () => Panel.getViewSwitcherHtml(),
      setupPanel: (wrapper, terminalId, projectIndex, project, deps) => {
        Panel.setupViewSwitcher(wrapper, terminalId, projectIndex, project, deps);
      }
    }];
  },

  // Wizard
  getWizardFields: () => {
    return require('./renderer/DiscordWizard').getWizardFields();
  },

  onWizardTypeSelected: (form, isSelected) => {
    require('./renderer/DiscordWizard').onWizardTypeSelected(form, isSelected);
  },

  bindWizardEvents: (form, api) => {
    require('./renderer/DiscordWizard').bindWizardEvents(form, api);
  },

  getWizardConfig: (form) => {
    return require('./renderer/DiscordWizard').getWizardConfig(form);
  },

  getTemplateGridHtml: (t) => {
    return require('./renderer/DiscordWizard').getTemplateGridHtml(t);
  },

  getScaffoldTemplates: () => {
    return require('./renderer/DiscordWizard').SCAFFOLD_TEMPLATES;
  },

  detectFramework: (pkg) => {
    return require('./renderer/DiscordWizard').detectFramework(pkg);
  },

  // Suppression
  onProjectDelete: (project, idx) => {
    try {
      const { getDiscordServer } = require('./renderer/DiscordState');
      const { stopBot } = require('./renderer/DiscordRendererService');
      const server = getDiscordServer(idx);
      if (server.status !== 'stopped') {
        stopBot(idx);
      }
    } catch (e) {
      console.error('[Discord] Error stopping bot on delete:', e);
    }
  },

  // Project settings
  getProjectSettings: (project) => [
    {
      key: 'startCommand',
      labelKey: 'discord.startCommand',
      type: 'text',
      placeholder: 'node bot.js',
      hintKey: 'discord.devCommandHint'
    }
  ],

  // Assets
  getStyles: () => `
/* ========== Discord Bot Type Styles ========== */

:root {
  --dc-blurple: #5865F2;
  --dc-green:   #57F287;
  --dc-yellow:  #FEE75C;
  --dc-fuchsia: #EB459E;
  --dc-red:     #ED4245;
  --dc-dark:    #2C2F33;
  --dc-darker:  #23272A;
}

/* ── Keyframes ── */
@keyframes dc-blink { 50% { opacity: 0.3; } }
@keyframes dc-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ── Status dots ── */
.discord-status-dot {
  width: 6px; height: 6px; border-radius: 50%; display: inline-block;
  margin-right: 7px; flex-shrink: 0; background: rgba(255,255,255,0.15);
}
.discord-status-dot.starting { background: var(--dc-yellow); animation: dc-blink 1s ease-in-out infinite; }
.discord-status-dot.online   { background: var(--dc-green); }

/* ── Sidebar buttons ── */
.btn-action-primary.btn-discord-start { background: var(--dc-blurple); color: #fff; font-weight: 600; }
.btn-action-primary.btn-discord-start:hover { background: #4752C4; }
.btn-action-primary.btn-discord-stop { background: transparent; color: var(--dc-red); border: 1px solid rgba(237,66,69,0.3); }
.btn-action-primary.btn-discord-stop:hover { background: rgba(237,66,69,0.08); }
.btn-action-icon.btn-discord-console { background: rgba(255,255,255,0.04); color: var(--text-secondary); }
.btn-action-icon.btn-discord-console:hover { background: rgba(255,255,255,0.07); color: var(--text-primary); }

/* ── Terminal tab ── */
.terminal-tab.discord-tab { border-bottom-color: rgba(88,101,242,0.35); }
.terminal-tab.discord-tab .status-dot.discord-dot { background: rgba(88,101,242,0.5); }
.terminal-tab.discord-tab.active { color: var(--dc-blurple); border-bottom-color: var(--dc-blurple); }

/* ── Dashboard badge ── */
.dashboard-project-type.discord { background: rgba(88,101,242,0.12); color: var(--dc-blurple); }
.project-type-icon.discord svg, .wizard-type-badge-icon.discord svg { color: var(--dc-blurple); }
.project-item.discord-project .project-name svg { color: var(--dc-blurple); width: 14px; height: 14px; margin-right: 6px; flex-shrink: 0; }
.discord-stat { display: flex; align-items: center; gap: 6px; font-size: var(--font-xs); }

/* ── Shell wrapper ── */
.discord-wrapper {
  display: flex;
  flex-direction: column;
  flex: 1;
  height: 100%;
  min-height: 0;
}

.dc-shell {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.discord-console-view { flex: 1; min-height: 0; }

/* ── Bot status in tabbar ── */
.dc-bot-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px;
  border-radius: 20px;
  font-size: 10.5px;
  font-weight: 500;
  color: rgba(255,255,255,0.18);
  letter-spacing: 0.03em;
  background: transparent;
  transition: background 0.3s, color 0.3s;
}
.dc-bot-status[data-status="online"] {
  background: rgba(87,242,135,0.08);
  color: rgba(87,242,135,0.7);
}
.dc-bot-status[data-status="starting"] {
  background: rgba(254,231,92,0.08);
  color: rgba(254,231,92,0.7);
}
.dc-status-pip {
  width: 5px; height: 5px; border-radius: 50%;
  background: currentColor; flex-shrink: 0; opacity: 0.5;
  transition: opacity 0.3s;
}
.dc-bot-status[data-status="stopped"] .dc-status-pip { background: rgba(255,255,255,0.2); opacity: 1; }
.dc-bot-status[data-status="online"]  .dc-status-pip { opacity: 1; }
.dc-bot-status[data-status="starting"] .dc-status-pip { animation: dc-blink 1s ease-in-out infinite; opacity: 1; }

/* ── Tab count badges ── */
.dc-tab-count {
  font-size: 9px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 8px;
  background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.35);
  min-width: 16px;
  text-align: center;
}

/* ── Commands view ── */
.dc-commands-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  animation: dc-in 0.15s ease;
}

.dc-commands-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
}

.dc-commands-search {
  flex: 1;
  height: 28px;
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 6px;
  padding: 0 10px;
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
}
.dc-commands-search:focus { border-color: rgba(88,101,242,0.4); }
.dc-commands-search::placeholder { color: rgba(255,255,255,0.2); }

.dc-commands-scan-btn {
  padding: 5px 12px;
  background: rgba(88,101,242,0.12);
  border: 1px solid rgba(88,101,242,0.2);
  border-radius: 6px;
  color: var(--dc-blurple);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}
.dc-commands-scan-btn:hover { background: rgba(88,101,242,0.2); }

.dc-commands-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.dc-command-item {
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.04);
  margin-bottom: 4px;
  transition: background 0.1s;
}
.dc-command-item:hover { background: rgba(255,255,255,0.03); }

.dc-command-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--dc-blurple);
  margin-bottom: 2px;
}

.dc-command-desc {
  font-size: 11.5px;
  color: rgba(255,255,255,0.45);
  margin-bottom: 4px;
}

.dc-command-meta {
  display: flex;
  gap: 8px;
  font-size: 10px;
  color: rgba(255,255,255,0.2);
}

.dc-command-type {
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(88,101,242,0.1);
  color: rgba(88,101,242,0.6);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.dc-command-file {
  font-family: 'Consolas', monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dc-commands-empty, .dc-commands-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: rgba(255,255,255,0.2);
  font-size: 12px;
}

/* ── Events view ── */
.dc-events-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  animation: dc-in 0.15s ease;
}

.dc-events-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 6px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
}

.dc-events-clear-btn {
  padding: 4px 10px;
  background: transparent;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 5px;
  color: rgba(255,255,255,0.35);
  font-size: 10.5px;
  cursor: pointer;
}
.dc-events-clear-btn:hover { background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.6); }

.dc-events-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px;
  font-family: 'Consolas', monospace;
  font-size: 11px;
}

.dc-event-item {
  display: flex;
  gap: 8px;
  padding: 3px 6px;
  border-radius: 3px;
}
.dc-event-item:hover { background: rgba(255,255,255,0.02); }

.dc-event-time { color: rgba(255,255,255,0.2); flex-shrink: 0; }
.dc-event-type { color: var(--dc-blurple); font-weight: 600; flex-shrink: 0; }
.dc-event-data { color: rgba(255,255,255,0.4); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dc-events-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: rgba(255,255,255,0.2);
  font-size: 12px;
}

/* ── Builder shared ── */
.dc-builder-layout {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  height: 100%;
  padding: 8px;
  overflow: hidden;
}

.dc-builder-form {
  overflow-y: auto;
  padding-right: 8px;
}

.dc-builder-preview {
  display: flex;
  flex-direction: column;
  background: rgba(0,0,0,0.2);
  border-radius: 8px;
  overflow: hidden;
}

.dc-builder-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  font-size: 11px;
  font-weight: 600;
  color: rgba(255,255,255,0.4);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.dc-builder-actions {
  display: flex;
  gap: 4px;
}

.dc-builder-action-btn {
  padding: 3px 8px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 4px;
  color: rgba(255,255,255,0.45);
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.dc-builder-action-btn:hover { background: rgba(88,101,242,0.12); color: var(--dc-blurple); }

.dc-builder-preview-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.dc-builder-section {
  margin-bottom: 12px;
}

.dc-builder-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: rgba(255,255,255,0.45);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-bottom: 5px;
}

.dc-builder-input, .dc-builder-textarea, .dc-builder-select {
  width: 100%;
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 5px;
  padding: 6px 8px;
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
  margin-bottom: 4px;
  font-family: inherit;
}
.dc-builder-input:focus, .dc-builder-textarea:focus, .dc-builder-select:focus {
  border-color: rgba(88,101,242,0.4);
}
.dc-builder-input::placeholder, .dc-builder-textarea::placeholder { color: rgba(255,255,255,0.15); }
.dc-builder-input-sm { font-size: 11px; padding: 4px 8px; }
.dc-builder-textarea-sm { resize: vertical; min-height: 40px; }
.dc-builder-select { cursor: pointer; }

.dc-builder-color {
  width: 32px; height: 28px; border: none; border-radius: 4px;
  cursor: pointer; background: none; padding: 0;
}

.dc-builder-row { display: flex; gap: 12px; }
.dc-builder-row > * { flex: 1; }

.dc-builder-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: rgba(255,255,255,0.5);
  cursor: pointer;
}
.dc-builder-toggle input[type="checkbox"] { accent-color: var(--dc-blurple); }

.dc-builder-add-btn {
  padding: 1px 6px;
  background: rgba(88,101,242,0.12);
  border: 1px solid rgba(88,101,242,0.2);
  border-radius: 4px;
  color: var(--dc-blurple);
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
}
.dc-builder-add-btn:hover { background: rgba(88,101,242,0.2); }

.dc-builder-remove-btn {
  padding: 0 5px;
  background: transparent;
  border: 1px solid rgba(237,66,69,0.2);
  border-radius: 3px;
  color: var(--dc-red);
  font-size: 12px;
  cursor: pointer;
  line-height: 18px;
}
.dc-builder-remove-btn:hover { background: rgba(237,66,69,0.1); }

/* ── Builder: fields ── */
.dc-builder-field-item {
  padding: 8px;
  background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.04);
  border-radius: 6px;
  margin-bottom: 6px;
}

.dc-builder-field-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.dc-builder-field-row .dc-builder-input { flex: 1; }

/* ── Component Builder: rows ── */
.dc-comp-builder-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dc-comp-row {
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 8px;
  overflow: hidden;
}

.dc-comp-row-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: rgba(255,255,255,0.02);
  font-size: 11px;
  font-weight: 600;
  color: rgba(255,255,255,0.4);
}

.dc-comp-row-actions { display: flex; gap: 4px; }

.dc-comp-row-items {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px;
}

.dc-comp-item {
  flex: 1;
  min-width: 150px;
  max-width: 250px;
  padding: 8px;
  background: rgba(0,0,0,0.15);
  border: 1px solid rgba(255,255,255,0.04);
  border-radius: 6px;
}

.dc-comp-item-select { max-width: 100%; min-width: 100%; }

.dc-comp-item-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 600;
}

.dc-comp-options { margin-top: 6px; }

.dc-comp-option {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-bottom: 4px;
}
.dc-comp-option .dc-builder-input { flex: 1; }

/* ── Builder containers ── */
.dc-embed-builder-container, .dc-comp-builder-container {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  animation: dc-in 0.15s ease;
}
`,

  getTranslations: () => {
    try {
      return {
        en: require('./i18n/en.json'),
        fr: require('./i18n/fr.json'),
        es: require('./i18n/es.json')
      };
    } catch (e) {
      return null;
    }
  },

  getPreloadBridge: () => ({
    namespace: 'discord',
    channels: {
      invoke: ['discord-start', 'discord-stop', 'discord-detect-library', 'discord-scan-commands'],
      send: ['discord-input', 'discord-resize'],
      on: ['discord-data', 'discord-exit', 'discord-status-change']
    }
  })
});
