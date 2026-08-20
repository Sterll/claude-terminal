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

  // Console management (type-specific consoles)
  getConsoleConfig: (project, projectIndex) => ({
    typeId: 'webapp',
    tabIcon: '🌐',
    tabClass: 'webapp-tab',
    dotClass: 'webapp-dot',
    wrapperClass: 'webapp-wrapper',
    consoleViewSelector: '.webapp-console-view',
    ipcNamespace: 'webapp',
    scrollback: 10000,
    getExistingLogs: (pi) => {
      try {
        const { getWebAppServer } = require('./renderer/WebAppState');
        const server = getWebAppServer(pi);
        return (server && server.logs) ? server.logs : [];
      } catch (e) { return []; }
    },
    onCleanup: (wrapper) => {
      try { require('./renderer/WebAppTerminalPanel').cleanup(wrapper); } catch (e) {}
    }
  }),

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

  getTemplateGridHtml: (t) => {
    return require('./renderer/WebAppWizard').getTemplateGridHtml(t);
  },

  getScaffoldTemplates: () => {
    return require('./renderer/WebAppWizard').SCAFFOLD_TEMPLATES;
  },

  detectFramework: (pkg) => {
    return require('./renderer/WebAppWizard').detectFramework(pkg);
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

:root {
  --wa-green:  #4ade80;
  --wa-amber:  #fb923c;
  --wa-red:    #f87171;
  --wa-mono:   'Consolas', 'Cascadia Code', 'Fira Code', monospace;
}

/* ── Keyframes ── */
@keyframes wa-spin  { to { transform: rotate(360deg); } }
@keyframes wa-blink { 50% { opacity: 0.3; } }
@keyframes wa-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ════════════════════════════════════════════════════════
   LEGACY — dashboard dots & actions
   ════════════════════════════════════════════════════════ */
.webapp-status-dot {
  width: 6px; height: 6px; border-radius: 50%; display: inline-block;
  margin-right: 7px; flex-shrink: 0; background: rgba(255,255,255,0.15);
}
.webapp-status-dot.starting { background: var(--wa-amber); animation: wa-blink 1s ease-in-out infinite; }
.webapp-status-dot.running  { background: var(--wa-green); }

.btn-action-primary.btn-webapp-start { background: #fff; color: #0a0a0a; font-weight: 600; }
.btn-action-primary.btn-webapp-start:hover { background: #e8e8e8; }
.btn-action-primary.btn-webapp-stop { background: transparent; color: var(--wa-red); border: 1px solid rgba(248,113,113,0.3); }
.btn-action-primary.btn-webapp-stop:hover { background: rgba(248,113,113,0.08); }
.btn-action-icon.btn-webapp-console { background: rgba(255,255,255,0.04); color: var(--text-secondary); }
.btn-action-icon.btn-webapp-console:hover { background: rgba(255,255,255,0.07); color: var(--text-primary); }

.terminal-tab.webapp-tab { border-bottom-color: rgba(255,255,255,0.35); }
.terminal-tab.webapp-tab .status-dot.webapp-dot { background: rgba(255,255,255,0.5); }
.terminal-tab.webapp-tab.active { color: #fff; border-bottom-color: #fff; }

.dashboard-project-type.webapp { background: rgba(255,255,255,0.05); color: var(--text-secondary); }
.project-type-icon.webapp svg, .wizard-type-badge-icon.webapp svg { color: var(--text-secondary); }
.project-item.webapp-project .project-name svg { color: var(--text-secondary); width: 14px; height: 14px; margin-right: 6px; flex-shrink: 0; }
.webapp-stat { display: flex; align-items: center; gap: 6px; font-size: var(--font-xs); }
.webapp-url-link { color: rgba(255,255,255,0.5); font-family: var(--wa-mono); font-size: 11px; }

/* ════════════════════════════════════════════════════════
   SHELL — main container
   ════════════════════════════════════════════════════════ */
.webapp-wrapper {
  display: flex;
  flex-direction: column;
  flex: 1;
  height: 100%;
  min-height: 0;
}

.wa-shell {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ════════════════════════════════════════════════════════
   TAB BAR
   ════════════════════════════════════════════════════════ */
.wa-tabbar {
  display: flex;
  align-items: stretch;
  height: 36px;
  flex-shrink: 0;
  background: var(--bg-secondary);
  border-bottom: 1px solid rgba(255,255,255,0.07);
  padding: 0 6px 0 4px;
}

.wa-tabs {
  display: flex;
  align-items: stretch;
  flex: 1;
}

.wa-tab {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 12px;
  border: none;
  background: transparent;
  color: rgba(255,255,255,0.28);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  position: relative;
  transition: color 0.12s;
  white-space: nowrap;
  letter-spacing: 0.01em;
  /* underline tab style */
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.wa-tab svg { opacity: 0.6; flex-shrink: 0; transition: opacity 0.12s; }
.wa-tab:hover { color: rgba(255,255,255,0.58); }
.wa-tab:hover svg { opacity: 0.8; }
.wa-tab.active {
  color: rgba(255,255,255,0.88);
  border-bottom-color: rgba(255,255,255,0.6);
}
.wa-tab.active svg { opacity: 1; }

.wa-tabbar-right {
  display: flex;
  align-items: center;
  padding: 0 6px;
}

/* Server status indicator */
.wa-server-status {
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
.wa-server-status[data-status="running"] {
  background: rgba(74,222,128,0.08);
  color: rgba(74,222,128,0.7);
}
.wa-server-status[data-status="starting"] {
  background: rgba(251,146,60,0.08);
  color: rgba(251,146,60,0.7);
}

.wa-status-pip {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
  opacity: 0.5;
  transition: opacity 0.3s;
}
.wa-server-status[data-status="stopped"] .wa-status-pip { background: rgba(255,255,255,0.2); opacity: 1; }
.wa-server-status[data-status="running"]  .wa-status-pip { opacity: 1; }
.wa-server-status[data-status="starting"] .wa-status-pip { animation: wa-blink 1s ease-in-out infinite; opacity: 1; }

/* ════════════════════════════════════════════════════════
   VIEW BODY
   ════════════════════════════════════════════════════════ */
.wa-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.wa-view {
  flex: 1;
  min-height: 0;
  display: none;
  flex-direction: column;
  overflow: hidden;
}

.wa-view.wa-view-active {
  display: flex;
}

.webapp-console-view { flex: 1; min-height: 0; }

/* ════════════════════════════════════════════════════════
   BROWSER — preview pane
   ════════════════════════════════════════════════════════ */
.webapp-preview-view { animation: wa-in 0.15s ease; }

.wa-browser {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.wa-browser-bar {
  display: flex;
  align-items: center;
  height: 36px;
  padding: 0 8px;
  gap: 6px;
  background: var(--bg-secondary);
  border-bottom: 1px solid rgba(255,255,255,0.055);
  flex-shrink: 0;
}

.wa-browser-nav {
  display: flex;
  align-items: center;
  gap: 1px;
  flex-shrink: 0;
}

.wa-browser-btn {
  width: 26px; height: 26px;
  border: none; border-radius: 5px;
  background: transparent;
  color: rgba(255,255,255,0.22);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.1s, color 0.1s;
  flex-shrink: 0;
}
.wa-browser-btn:hover {
  background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.7);
}
.wa-browser-btn:active { opacity: 0.5; }
.wa-reload:hover svg { animation: wa-spin 0.35s linear; }

/* Address bar */
.wa-address-bar {
  flex: 1;
  height: 24px;
  display: flex;
  align-items: center;
  background: rgba(0,0,0,0.35);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 5px;
  padding: 0 9px;
  min-width: 0;
  font-family: var(--wa-mono);
  font-size: 11px;
  overflow: hidden;
  white-space: nowrap;
  cursor: default;
  gap: 0;
}
.wa-addr-scheme { color: rgba(255,255,255,0.2); }
.wa-addr-host   { color: rgba(255,255,255,0.55); }
.wa-addr-port   { color: rgba(255,255,255,0.3); }

/* webview — visibility managed via DOM attach/detach in JS */
.webapp-preview-webview {
  flex: 1; width: 100%; border: none; background: #fff; min-height: 0;
}
.wa-addr-path {
  color: rgba(255,255,255,0.35);
}

/* ── Inspect button ── */
.wa-inspect { position: relative; }
.wa-inspect.active { background: rgba(217,119,6,0.15); color: var(--accent); }
.inspect-mode .webapp-preview-webview { cursor: crosshair; }

/* Inspect badge count */
.wa-inspect-count { position: absolute; top: -4px; right: -4px; min-width: 14px; height: 14px; border-radius: 7px; background: var(--accent); color: #fff; font-size: 8px; font-weight: 700; display: none; align-items: center; justify-content: center; padding: 0 3px; line-height: 1; }
.wa-inspect-count.visible { display: flex; }

/* Send all button in browser bar */
.wa-send-all { display: none; align-items: center; gap: 4px; padding: 4px 10px; background: var(--accent); color: #fff; border: none; border-radius: 5px; font-size: 10.5px; font-weight: 600; cursor: pointer; white-space: nowrap; flex-shrink: 0; }
.wa-send-all.visible { display: flex; }
.wa-send-all:hover { background: var(--accent-hover); }

/* ── Browser viewport wrapper ── */
.wa-browser-viewport { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* ── Responsive checker ── */
.wa-responsive-group { display: flex; align-items: center; gap: 1px; flex-shrink: 0; padding: 0 2px; }
.wa-responsive-sep { width: 1px; height: 16px; background: rgba(255,255,255,0.08); margin: 0 4px; flex-shrink: 0; }
.wa-responsive-btn { height: 24px; border: none; border-radius: 4px; background: transparent; color: rgba(255,255,255,0.22); cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 3px; padding: 0 6px; transition: background 0.1s, color 0.1s; flex-shrink: 0; font-size: 0; }
.wa-responsive-btn:hover { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.6); }
.wa-responsive-btn.active { background: rgba(217,119,6,0.12); color: var(--accent); }
.wa-responsive-btn.active:hover { background: rgba(217,119,6,0.18); }
.wa-responsive-label { font-size: 9px; font-family: var(--wa-mono); font-weight: 500; line-height: 1; }

/* ── Responsive frame (webview constraint wrapper) ── */
.wa-responsive-frame { width: 100%; height: 100%; margin: 0 auto; display: flex; flex-direction: column; transition: max-width 0.2s cubic-bezier(0.4,0,0.2,1); position: relative; }
.wa-responsive-frame.constrained { border-left: 1px solid rgba(255,255,255,0.08); border-right: 1px solid rgba(255,255,255,0.08); box-shadow: -1px 0 12px rgba(0,0,0,0.15), 1px 0 12px rgba(0,0,0,0.15); }
.wa-browser-viewport.responsive-active { background: repeating-linear-gradient(90deg, rgba(255,255,255,0.012) 0px, rgba(255,255,255,0.012) 1px, transparent 1px, transparent 20px), var(--bg-primary); }

/* ── Responsive indicator bar ── */
.wa-responsive-indicator { display: none; height: 20px; flex-shrink: 0; background: var(--bg-secondary); border-top: 1px solid rgba(255,255,255,0.055); align-items: center; justify-content: center; font-size: 10px; font-family: var(--wa-mono); color: rgba(255,255,255,0.3); letter-spacing: 0.03em; }
.wa-responsive-indicator.visible { display: flex; }

/* ── Pins overlay ── */
.wa-pins-overlay { position: absolute; inset: 0; pointer-events: none; z-index: 10; overflow: hidden; }

/* Pin circle */
.wa-pin { position: absolute; pointer-events: auto; cursor: pointer; width: 22px; height: 22px; border-radius: 50%; background: var(--accent); color: #fff; font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 8px rgba(0,0,0,0.4); border: 2px solid rgba(255,255,255,0.9); transition: transform 0.12s; z-index: 2; animation: wa-pin-in 0.2s cubic-bezier(0.34,1.56,0.64,1); }
.wa-pin:hover { transform: scale(1.2); }
.wa-pin.wa-pin-other-viewport { opacity: 0.4; border-color: rgba(255,255,255,0.4); transform: scale(0.85); }
.wa-pin.wa-pin-other-viewport:hover { opacity: 0.8; transform: scale(1); }
@keyframes wa-pin-in { from { transform: scale(0); opacity: 0; } to { transform: scale(1); opacity: 1; } }

/* Popover */
.wa-pin-popover { position: absolute; pointer-events: auto; z-index: 3; width: 280px; background: var(--bg-secondary); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); padding: 10px; display: flex; flex-direction: column; gap: 8px; animation: wa-in 0.12s ease; }
.wa-popover-header { display: flex; align-items: center; gap: 8px; min-width: 0; }
.wa-popover-selector { font-family: var(--wa-mono); font-size: 10.5px; color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.wa-popover-close { width: 20px; height: 20px; border: none; background: transparent; color: rgba(255,255,255,0.3); font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; border-radius: 4px; flex-shrink: 0; }
.wa-popover-close:hover { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.6); }
.wa-popover-delete { padding: 5px 12px; background: transparent; color: var(--danger); border: 1px solid rgba(239,68,68,0.25); border-radius: 5px; font-size: 11px; font-weight: 600; cursor: pointer; }
.wa-popover-delete:hover { background: rgba(239,68,68,0.15); }
.wa-popover-input { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; color: var(--text-primary); font-size: 12px; padding: 7px 9px; resize: none; outline: none; font-family: inherit; min-height: 30px; max-height: 80px; }
.wa-popover-input:focus { border-color: rgba(217,119,6,0.4); }
.wa-popover-input::placeholder { color: rgba(255,255,255,0.2); }
.wa-popover-actions { display: flex; gap: 6px; justify-content: flex-end; align-items: center; }
.wa-popover-ok { padding: 5px 12px; background: var(--accent); color: #fff; border: none; border-radius: 5px; font-size: 11px; font-weight: 600; cursor: pointer; }
.wa-popover-ok:hover { background: var(--accent-hover); }

/* Auto-scan pins */
.wa-pin-auto { background: var(--info); border-color: rgba(59,130,246,0.8); font-size: 9px; font-weight: 700; letter-spacing: -0.02em; }
.wa-pin-auto:hover { transform: scale(1.2); }
.wa-pin-auto[data-pin-type="overflow"]     { background: var(--warning); border-color: rgba(245,158,11,0.8); }
.wa-pin-auto[data-pin-type="contrast"]     { background: #8b5cf6; border-color: rgba(139,92,246,0.8); }
.wa-pin-auto[data-pin-type="broken-image"] { background: var(--danger); border-color: rgba(239,68,68,0.8); }
.wa-pin-auto[data-pin-type="z-index"]      { background: #06b6d4; border-color: rgba(6,182,212,0.8); }
.wa-pin-auto[data-pin-type="aria"]         { background: #f472b6; border-color: rgba(244,114,182,0.8); }
.wa-pin-auto[data-pin-type="alt-text"]     { background: #fb923c; border-color: rgba(251,146,60,0.8); }
.wa-pin-auto[data-pin-type="keyboard"]     { background: #a78bfa; border-color: rgba(167,139,250,0.8); }
.wa-pin-auto[data-pin-type="structure"]    { background: #2dd4bf; border-color: rgba(45,212,191,0.8); }
.wa-pin-auto[data-pin-type="a11y"]         { background: #60a5fa; border-color: rgba(96,165,250,0.8); }
.wa-pin-auto.wa-pin-other-viewport { opacity: 0.3; border-color: rgba(255,255,255,0.3); transform: scale(0.8); }

/* Scan button */
.wa-scan { position: relative; }
.wa-scan.scanning { background: rgba(59,130,246,0.15); color: var(--info); }
.wa-scan.scanning svg { animation: wa-spin 1s linear infinite; }
.wa-scan.scan-found { background: rgba(59,130,246,0.15); color: var(--info); }
.wa-scan.scan-clear { background: rgba(34,197,94,0.12); color: var(--success); }
@keyframes wa-spin { to { transform: rotate(360deg); } }

/* Scan badge */
.wa-scan-count { position: absolute; top: -4px; right: -4px; min-width: 14px; height: 14px; border-radius: 7px; background: var(--info); color: #fff; font-size: 8px; font-weight: 700; display: none; align-items: center; justify-content: center; padding: 0 3px; line-height: 1; }
.wa-scan-count.visible { display: flex; }

/* Auto-detect popover */
.wa-pin-popover-auto { border-color: rgba(59,130,246,0.2); }
.wa-scan-type-badge { display: inline-flex; align-items: center; padding: 1px 6px; border-radius: 3px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; flex-shrink: 0; }
.wa-scan-type-badge[data-type="overflow"]     { background: rgba(245,158,11,0.15); color: var(--warning); }
.wa-scan-type-badge[data-type="contrast"]     { background: rgba(139,92,246,0.15); color: #8b5cf6; }
.wa-scan-type-badge[data-type="broken-image"] { background: rgba(239,68,68,0.15); color: var(--danger); }
.wa-scan-type-badge[data-type="z-index"]      { background: rgba(6,182,212,0.15); color: #06b6d4; }
.wa-scan-type-badge[data-type="aria"]         { background: rgba(244,114,182,0.15); color: #f472b6; }
.wa-scan-type-badge[data-type="alt-text"]     { background: rgba(251,146,60,0.15); color: #fb923c; }
.wa-scan-type-badge[data-type="keyboard"]     { background: rgba(167,139,250,0.15); color: #a78bfa; }
.wa-scan-type-badge[data-type="structure"]    { background: rgba(45,212,191,0.15); color: #2dd4bf; }
.wa-scan-type-badge[data-type="a11y"]         { background: rgba(96,165,250,0.15); color: #60a5fa; }
.wa-scan-description { font-size: 11px; color: rgba(255,255,255,0.55); font-family: var(--wa-mono); line-height: 1.4; padding: 4px 0; }

/* Scan filter bar */
.wa-scan-filters { display: none; gap: 4px; padding: 4px 8px; background: rgba(0,0,0,0.25); border-bottom: 1px solid var(--wa-border); flex-wrap: wrap; align-items: center; }
.wa-scan-filters.visible { display: flex; }
.wa-scan-filter-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--wa-border); background: transparent; color: var(--wa-text-muted); font-size: 10px; font-weight: 600; font-family: var(--wa-mono); cursor: pointer; transition: all 0.15s; opacity: 0.45; user-select: none; }
.wa-scan-filter-chip.active { opacity: 1; background: rgba(255,255,255,0.06); color: var(--wa-text); border-color: rgba(255,255,255,0.15); }
.wa-scan-filter-chip:hover { background: rgba(255,255,255,0.08); }
.wa-scan-filter-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.wa-scan-filter-dot[data-type="overflow"]     { background: var(--warning); }
.wa-scan-filter-dot[data-type="contrast"]     { background: #8b5cf6; }
.wa-scan-filter-dot[data-type="broken-image"] { background: var(--danger); }
.wa-scan-filter-dot[data-type="z-index"]      { background: #06b6d4; }
.wa-scan-filter-dot[data-type="aria"]         { background: #f472b6; }
.wa-scan-filter-dot[data-type="alt-text"]     { background: #fb923c; }
.wa-scan-filter-dot[data-type="keyboard"]     { background: #a78bfa; }
.wa-scan-filter-dot[data-type="structure"]    { background: #2dd4bf; }
.wa-scan-filter-dot[data-type="a11y"]         { background: #60a5fa; }
.wa-scan-filter-count { font-size: 9px; opacity: 0.6; }

/* ── Ruler button ── */
.wa-ruler { position: relative; }
.wa-ruler.active { background: rgba(236,72,153,0.15); color: #ec4899; }
.ruler-mode .webapp-preview-webview { cursor: crosshair; }

/* Ruler badge */
.wa-ruler-count { position: absolute; top: -4px; right: -4px; min-width: 14px; height: 14px; border-radius: 7px; background: #ec4899; color: #fff; font-size: 8px; font-weight: 700; display: none; align-items: center; justify-content: center; padding: 0 3px; line-height: 1; }
.wa-ruler-count.visible { display: flex; }

/* Ruler pins */
.wa-pin-ruler { background: #ec4899; border-color: rgba(236,72,153,0.8); font-size: 11px; }
.wa-pin-ruler:hover { transform: scale(1.2); }
.wa-pin-ruler.wa-pin-other-viewport { opacity: 0.3; border-color: rgba(255,255,255,0.3); transform: scale(0.8); }

/* Ruler popover */
.wa-pin-popover-ruler { border-color: rgba(236,72,153,0.25); }
.wa-pin-popover-ruler .wa-popover-selector { color: #ec4899; }
.wa-pin-popover-ruler .wa-popover-ok { background: #ec4899; }
.wa-pin-popover-ruler .wa-popover-ok:hover { background: #f472b6; }
.wa-pin-popover-ruler .wa-popover-input:focus { border-color: rgba(236,72,153,0.4); }

/* Ruler dimension display */
.wa-ruler-dim { font-family: var(--wa-mono); font-size: 10px; color: rgba(255,255,255,0.4); flex-shrink: 0; }

/* Ruler box model mini display */
.wa-ruler-boxmodel-mini { background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 6px 8px; display: flex; flex-direction: column; gap: 3px; }
.wa-ruler-row { display: flex; align-items: center; gap: 6px; font-family: var(--wa-mono); font-size: 10px; }
.wa-ruler-label { width: 44px; font-weight: 700; text-transform: uppercase; font-size: 8.5px; letter-spacing: 0.05em; flex-shrink: 0; }
.wa-ruler-row.margin .wa-ruler-label  { color: #fb923c; }
.wa-ruler-row.border .wa-ruler-label  { color: #facc15; }
.wa-ruler-row.padding .wa-ruler-label { color: #4ade80; }
.wa-ruler-val { color: rgba(255,255,255,0.5); min-width: 32px; text-align: right; }

/* ════════════════════════════════════════════════════════
   EMPTY STATE
   ════════════════════════════════════════════════════════ */
@keyframes wa-spin-slow { to { transform: rotate(360deg); } }

.wa-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  animation: wa-in 0.2s ease;
  padding: 24px;
}

.wa-empty-visual {
  color: rgba(255,255,255,0.2);
  display: flex;
  align-items: center;
  justify-content: center;
}
.wa-empty.is-stopped .wa-empty-visual { color: rgba(255,255,255,0.1); }

.wa-spin { animation: wa-spin 1s linear infinite; }
.wa-spin-slow { animation: wa-spin-slow 2.5s linear infinite; }

.wa-empty-body { text-align: center; }
.wa-empty-title {
  font-size: 13px;
  color: rgba(255,255,255,0.38);
  font-weight: 500;
  margin: 0 0 5px;
  letter-spacing: -0.01em;
}
.wa-empty.is-stopped .wa-empty-title { color: rgba(255,255,255,0.22); }
.wa-empty-sub {
  font-size: 11px;
  color: rgba(255,255,255,0.16);
  margin: 0;
  max-width: 220px;
  line-height: 1.5;
}

/* ════════════════════════════════════════════════════════
   INFO VIEW — dashboard style
   ════════════════════════════════════════════════════════ */
.webapp-info-view {
  animation: wa-in 0.2s ease;
  overflow-y: auto;
  background: var(--bg-primary);
}

.wa-info {
  display: flex;
  flex-direction: column;
  gap: 0;
  height: 100%;
}

/* ── Hero status block ── */
.wa-info-hero {
  position: relative;
  padding: 22px 20px 18px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  overflow: hidden;
}

/* Subtle tinted BG per status */
.wa-info-hero-bg {
  position: absolute;
  inset: 0;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.4s;
}
.wa-info-hero.running  .wa-info-hero-bg { background: radial-gradient(ellipse 60% 80% at 0% 0%, rgba(74,222,128,0.06), transparent); opacity: 1; }
.wa-info-hero.starting .wa-info-hero-bg { background: radial-gradient(ellipse 60% 80% at 0% 0%, rgba(251,146,60,0.06), transparent); opacity: 1; }

.wa-info-hero-content {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
}

.wa-info-hero-icon {
  flex-shrink: 0;
  color: rgba(255,255,255,0.18);
  display: flex;
  align-items: center;
  justify-content: center;
}
.wa-info-hero.running  .wa-info-hero-icon { color: var(--wa-green); }
.wa-info-hero.starting .wa-info-hero-icon { color: var(--wa-amber); }

.wa-info-hero-text {
  flex: 1;
  min-width: 0;
}

.wa-info-hero-label {
  font-size: 13px;
  font-weight: 600;
  color: rgba(255,255,255,0.75);
  line-height: 1.2;
  letter-spacing: -0.01em;
}
.wa-info-hero.running  .wa-info-hero-label { color: rgba(255,255,255,0.9); }

.wa-info-hero-sub {
  font-size: 11px;
  color: rgba(255,255,255,0.25);
  margin-top: 2px;
  font-family: var(--wa-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wa-info-hero.running .wa-info-hero-sub { color: rgba(255,255,255,0.35); }

/* CTA Button */
.wa-info-cta {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px;
  color: rgba(255,255,255,0.6);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s, transform 0.1s;
  letter-spacing: 0.01em;
}
.wa-info-cta:hover {
  background: rgba(255,255,255,0.11);
  border-color: rgba(255,255,255,0.18);
  color: rgba(255,255,255,0.9);
  transform: translateY(-1px);
}
.wa-info-cta:active { transform: translateY(0); }

/* ── Metrics grid ── */
.wa-info-grid {
  padding: 16px 20px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.wa-info-tile {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 13px;
  background: rgba(255,255,255,0.025);
  border: 1px solid rgba(255,255,255,0.055);
  border-radius: 8px;
  transition: background 0.12s, border-color 0.12s;
  min-width: 0;
}

.wa-info-tile-link {
  cursor: pointer;
}
.wa-info-tile-link:hover {
  background: rgba(255,255,255,0.045);
  border-color: rgba(255,255,255,0.1);
}

.wa-info-tile-icon {
  flex-shrink: 0;
  margin-top: 1px;
  color: rgba(255,255,255,0.2);
  display: flex;
}

.wa-info-tile-body {
  flex: 1;
  min-width: 0;
}

.wa-info-tile-label {
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: rgba(255,255,255,0.18);
  margin-bottom: 4px;
}

.wa-info-tile-val {
  font-size: 12.5px;
  font-weight: 500;
  color: rgba(255,255,255,0.7);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wa-info-tile-val.wa-mono {
  font-family: var(--wa-mono);
  font-size: 12px;
}

.wa-info-tile-arrow {
  flex-shrink: 0;
  color: rgba(255,255,255,0.15);
  display: flex;
  align-items: center;
  align-self: center;
}
.wa-info-tile-link:hover .wa-info-tile-arrow { color: rgba(255,255,255,0.4); }
.wa-info-tile-link:hover .wa-info-tile-val   { color: rgba(255,255,255,0.9); }

/* pip used in status bar */
.wa-pip {
  width: 5px; height: 5px;
  border-radius: 50%;
  background: rgba(255,255,255,0.18);
  flex-shrink: 0;
}
`,

  getTranslations: () => {
    try {
      return {
        en: require('./i18n/en.json'),
        fr: require('./i18n/fr.json'),
        es: require('./i18n/es.json'),
        id: require('./i18n/id.json')
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
