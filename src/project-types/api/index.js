/**
 * API Project Type
 * Backend API server management (Express, FastAPI, Django, etc.)
 */

const { createType } = require('../base-type');

module.exports = createType({
  id: 'api',
  nameKey: 'newProject.types.api',
  descKey: 'newProject.types.apiDesc',
  category: 'general',
  icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 1h16a2 2 0 012 2v3a2 2 0 01-2 2H4a2 2 0 01-2-2V3a2 2 0 012-2zm0 8h16a2 2 0 012 2v3a2 2 0 01-2 2H4a2 2 0 01-2-2v-3a2 2 0 012-2zm0 8h16a2 2 0 012 2v3a2 2 0 01-2 2H4a2 2 0 01-2-2v-3a2 2 0 012-2zm1-13v1h2V4H5zm0 8v1h2v-1H5zm0 8v1h2v-1H5z"/></svg>',

  // Main process (registered via src/main/ipc/index.js, not via registry)
  mainModule: () => null,

  initialize: () => {},
  cleanup: () => {},

  // ProjectList (sidebar)
  getSidebarButtons: (ctx) => {
    return require('./renderer/ApiProjectList').getSidebarButtons(ctx);
  },

  getProjectIcon: () => {
    return require('./renderer/ApiProjectList').getProjectIcon();
  },

  getStatusIndicator: (ctx) => {
    return require('./renderer/ApiProjectList').getStatusIndicator(ctx);
  },

  getProjectItemClass: () => {
    return require('./renderer/ApiProjectList').getProjectItemClass();
  },

  getMenuItems: (ctx) => {
    return require('./renderer/ApiProjectList').getMenuItems(ctx);
  },

  getDashboardIcon: () => {
    return require('./renderer/ApiProjectList').getDashboardIcon();
  },

  bindSidebarEvents: (list, callbacks) => {
    require('./renderer/ApiProjectList').bindSidebarEvents(list, callbacks);
  },

  // Dashboard
  getDashboardBadge: (project) => {
    return require('./renderer/ApiDashboard').getDashboardBadge(project);
  },

  getDashboardStats: (ctx) => {
    return require('./renderer/ApiDashboard').getDashboardStats(ctx);
  },

  // TerminalManager
  getTerminalPanels: (ctx) => {
    const Panel = require('./renderer/ApiTerminalPanel');
    return [{
      id: 'api-console',
      getWrapperHtml: () => Panel.getViewSwitcherHtml(),
      setupPanel: (wrapper, terminalId, projectIndex, project, deps) => {
        Panel.setupViewSwitcher(wrapper, terminalId, projectIndex, project, deps);
      }
    }];
  },

  // Wizard
  getWizardFields: () => {
    return require('./renderer/ApiWizard').getWizardFields();
  },

  onWizardTypeSelected: (form, isSelected) => {
    require('./renderer/ApiWizard').onWizardTypeSelected(form, isSelected);
  },

  bindWizardEvents: (form, api) => {
    require('./renderer/ApiWizard').bindWizardEvents(form, api);
  },

  getWizardConfig: (form) => {
    return require('./renderer/ApiWizard').getWizardConfig(form);
  },

  // Suppression
  onProjectDelete: (project, idx) => {
    try {
      const { getApiServer } = require('./renderer/ApiState');
      const { stopApiServer } = require('./renderer/ApiRendererService');
      const server = getApiServer(idx);
      if (server.status !== 'stopped') {
        stopApiServer(idx);
      }
    } catch (e) {
      console.error('[API] Error stopping server on delete:', e);
    }
  },

  // Project settings (per-project modal)
  getProjectSettings: (project) => [
    {
      key: 'devCommand',
      labelKey: 'api.devCommandLabel',
      type: 'text',
      placeholder: 'npm run dev, uvicorn main:app, python manage.py runserver...',
      hintKey: 'api.devCommandHint'
    }
  ],

  // Assets
  getStyles: () => `
/* ========== API Type Styles ========== */

.api-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  margin-right: 6px;
  background: var(--text-secondary);
}

.api-status-dot.stopped {
  background: var(--text-secondary);
}

.api-status-dot.starting {
  background: #d29922;
  animation: api-pulse 1s ease-in-out infinite;
}

.api-status-dot.running {
  background: #3fb950;
  box-shadow: 0 0 6px rgba(63, 185, 80, 0.4);
}

@keyframes api-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.btn-action-primary.btn-api-start {
  background: var(--success);
}

.btn-action-primary.btn-api-start:hover {
  background: #16a34a;
}

.btn-action-primary.btn-api-stop {
  background: var(--danger);
}

.btn-action-primary.btn-api-stop:hover {
  background: #dc2626;
}

.btn-action-icon.btn-api-console {
  background: rgba(168, 85, 247, 0.15);
  color: #a855f7;
}

.btn-action-icon.btn-api-console:hover {
  background: #a855f7;
  color: white;
}

/* Terminal tab */
.terminal-tab.api-tab {
  border-bottom-color: #a855f7;
}

.terminal-tab.api-tab .status-dot.api-dot {
  background: #a855f7;
}

.terminal-tab.api-tab.active {
  color: #a855f7;
  border-bottom-color: #a855f7;
}

/* Wrapper */
.api-wrapper {
  display: flex;
  flex-direction: column;
  flex: 1;
  height: 100%;
  min-height: 0;
}

.api-view-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.dashboard-project-type.api {
  background: rgba(168, 85, 247, 0.15);
  color: #a855f7;
}

.project-type-icon.api svg,
.wizard-type-badge-icon.api svg {
  color: #a855f7;
}

.project-item.api-project .project-name svg {
  color: #a855f7;
  width: 14px;
  height: 14px;
  margin-right: 6px;
  flex-shrink: 0;
}

/* View switcher */
.api-view-switcher {
  display: flex;
  gap: 1px;
  padding: 4px 8px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.api-view-tab {
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

.api-view-tab:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.api-view-tab.active {
  background: rgba(168, 85, 247, 0.12);
  color: #a855f7;
}

.api-view-tab.active svg { opacity: 1; }
.api-view-tab svg { opacity: 0.5; }

/* Console view fills all space */
.api-console-view {
  flex: 1;
  min-height: 0;
}

/* Info view */
.api-info-view {
  overflow-y: auto;
}

.api-info-panel {
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 500px;
}

.api-info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--bg-secondary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
  transition: background 0.15s;
}

.api-info-row.clickable:hover {
  background: var(--bg-hover);
  border-color: #a855f7;
}

.api-info-label {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
}

.api-info-value {
  color: var(--text-primary);
  font-size: 12px;
  display: flex;
  align-items: center;
}

.api-info-value code {
  background: var(--bg-tertiary);
  padding: 2px 8px;
  border-radius: 4px;
  font-family: 'Consolas', monospace;
  font-size: 11.5px;
  color: var(--text-primary);
}

.api-url-link {
  color: #a855f7;
  font-family: 'Consolas', monospace;
  font-size: 12px;
}

.api-stat {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.api-stat .api-url-link {
  font-family: 'Consolas', monospace;
}

/* ========== Routes Panel ========== */

.api-routes-container {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.api-routes-sidebar {
  width: 320px;
  min-width: 260px;
  max-width: 420px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-color);
  background: var(--bg-primary);
}

.api-routes-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.api-routes-toolbar-left {
  display: flex;
  align-items: baseline;
  gap: 5px;
}

.api-routes-count {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  font-family: 'Consolas', monospace;
  line-height: 1;
}

.api-routes-count-label {
  font-size: 11px;
  color: var(--text-secondary);
  font-weight: 400;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.api-routes-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.api-routes-scan-btn,
.api-routes-add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
}

.api-routes-scan-btn:hover,
.api-routes-add-btn:hover {
  background: rgba(168, 85, 247, 0.1);
  border-color: rgba(168, 85, 247, 0.3);
  color: #a855f7;
}

.api-routes-scan-btn:disabled,
.api-routes-add-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Toggle switch */
.api-routes-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.api-routes-toggle-input {
  display: none;
}

.api-routes-toggle-slider {
  width: 28px;
  height: 16px;
  background: var(--bg-hover);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  position: relative;
  transition: all 0.2s;
  flex-shrink: 0;
}

.api-routes-toggle-slider::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 10px;
  height: 10px;
  background: var(--text-secondary);
  border-radius: 50%;
  transition: all 0.2s;
}

.api-routes-toggle-input:checked + .api-routes-toggle-slider {
  background: rgba(168, 85, 247, 0.25);
  border-color: #a855f7;
}

.api-routes-toggle-input:checked + .api-routes-toggle-slider::after {
  left: 14px;
  background: #a855f7;
}

.api-routes-toggle-label {
  font-size: 10px;
  color: var(--text-secondary);
}

/* ========== Variables Panel ========== */

.api-vars-panel {
  border-bottom: 1px solid var(--border-color);
  background: rgba(168, 85, 247, 0.02);
  flex-shrink: 0;
}

.api-vars-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  font-size: 11px;
  font-weight: 600;
  color: #a855f7;
  border-bottom: 1px solid rgba(168, 85, 247, 0.08);
}

.api-vars-header svg {
  opacity: 0.7;
  flex-shrink: 0;
}

.api-vars-hint {
  font-weight: 400;
  font-size: 10px;
  color: var(--text-secondary);
  margin-left: auto;
}

.api-vars-list {
  padding: 8px 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.api-var-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.api-var-name {
  font-size: 11px;
  font-family: 'Consolas', monospace;
  color: #c4a0f5;
  white-space: nowrap;
  min-width: 80px;
  flex-shrink: 0;
  background: rgba(168, 85, 247, 0.06);
  padding: 4px 8px;
  border-radius: 4px;
  font-weight: 500;
  border: 1px solid rgba(168, 85, 247, 0.08);
}

.api-var-input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 11px;
  font-family: 'Consolas', monospace;
  border-radius: 4px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.api-var-input:focus {
  border-color: #a855f7;
  box-shadow: 0 0 0 1px rgba(168, 85, 247, 0.15);
}

.api-var-input::placeholder {
  color: var(--text-secondary);
  opacity: 0.4;
}

/* ========== Unresolved route indicator ========== */

.api-route-item.unresolved {
  opacity: 0.65;
}

.api-route-item.unresolved:hover {
  opacity: 0.85;
}

.api-route-unresolved {
  color: #c4a0f5;
  opacity: 0.65;
  font-style: italic;
}

/* Add route form */
.api-add-route-form {
  padding: 10px 14px;
  border-top: 1px solid var(--border-color);
  background: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.api-add-route-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.api-add-route-method {
  padding: 5px 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 600;
  border-radius: 5px;
  cursor: pointer;
  flex-shrink: 0;
}

.api-add-route-path,
.api-add-route-handler {
  flex: 1;
  padding: 5px 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 11px;
  font-family: 'Consolas', monospace;
  border-radius: 5px;
  outline: none;
  min-width: 0;
}

.api-add-route-path:focus,
.api-add-route-handler:focus {
  border-color: #a855f7;
}

.api-add-route-confirm {
  padding: 5px 12px;
  background: #a855f7;
  color: white;
  border: none;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s;
}

.api-add-route-confirm:hover {
  background: #9333ea;
}

.api-add-route-cancel {
  padding: 5px 8px;
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: 5px;
  font-size: 13px;
  cursor: pointer;
  line-height: 1;
}

.api-add-route-cancel:hover {
  color: #ff7b72;
  border-color: #ff7b72;
}

/* Delete route button */
.api-route-delete-btn {
  margin-left: auto;
  padding: 0 4px;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  opacity: 0;
  transition: all 0.15s;
  flex-shrink: 0;
  line-height: 1;
}

.api-route-item:hover .api-route-delete-btn {
  opacity: 0.5;
}

.api-route-delete-btn:hover {
  opacity: 1 !important;
  color: #ff7b72;
}

/* Search filter with icon */
.api-routes-filter {
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  position: relative;
}

.api-routes-search-icon {
  position: absolute;
  left: 22px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-secondary);
  opacity: 0.35;
  pointer-events: none;
}

.api-routes-search {
  width: 100%;
  padding: 6px 8px 6px 28px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 11px;
  border-radius: 6px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.api-routes-search:focus {
  border-color: rgba(168, 85, 247, 0.4);
  box-shadow: 0 0 0 1px rgba(168, 85, 247, 0.1);
}

.api-routes-search::placeholder {
  color: var(--text-secondary);
  opacity: 0.4;
}

/* Route list */
.api-routes-list {
  flex: 1;
  overflow-y: auto;
  padding: 2px 0;
}

.api-routes-list::-webkit-scrollbar {
  width: 4px;
}

.api-routes-list::-webkit-scrollbar-track {
  background: transparent;
}

.api-routes-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.06);
  border-radius: 4px;
}

.api-routes-list::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.12);
}

/* Empty state */
.api-routes-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 48px 24px;
  text-align: center;
  flex: 1;
}

.api-routes-empty-icon {
  opacity: 0.06;
}

.api-routes-empty-text {
  font-size: 11.5px;
  color: var(--text-secondary);
  opacity: 0.5;
  max-width: 200px;
  line-height: 1.5;
}

/* Route items */
.api-route-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px 0 0;
  cursor: pointer;
  transition: background 0.1s ease;
  position: relative;
  min-height: 36px;
}

.api-route-accent {
  width: 3px;
  align-self: stretch;
  background: transparent;
  border-radius: 0 2px 2px 0;
  flex-shrink: 0;
  transition: background 0.12s ease;
}

.api-route-item:hover {
  background: rgba(255, 255, 255, 0.02);
}

.api-route-item:hover .api-route-accent {
  background: color-mix(in srgb, var(--route-color, #8b949e) 30%, transparent);
}

.api-route-item.selected {
  background: rgba(255, 255, 255, 0.03);
}

.api-route-item.selected .api-route-accent {
  background: var(--route-color, #a855f7);
}

.api-method-badge {
  font-size: 9.5px;
  font-weight: 700;
  padding: 3px 0;
  width: 52px;
  text-align: center;
  border-radius: 4px;
  font-family: 'Consolas', monospace;
  text-transform: uppercase;
  flex-shrink: 0;
  letter-spacing: 0.5px;
  color: var(--method-color, #8b949e);
  background: color-mix(in srgb, var(--method-color, #8b949e) 10%, transparent);
}

.api-route-path {
  font-size: 12px;
  font-family: 'Consolas', monospace;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.api-route-handler {
  font-size: 10px;
  color: var(--text-secondary);
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.api-route-item:hover .api-route-handler {
  opacity: 0.5;
}

/* Custom URL */
.api-custom-url-section {
  padding: 10px 14px;
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;
  background: var(--bg-secondary);
}

.api-custom-url-row {
  display: flex;
  gap: 4px;
}

.api-custom-method {
  padding: 6px 4px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 10px;
  font-weight: 700;
  font-family: 'Consolas', monospace;
  border-radius: 6px;
  cursor: pointer;
  flex-shrink: 0;
}

.api-custom-url-input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 11.5px;
  font-family: 'Consolas', monospace;
  border-radius: 6px;
  outline: none;
  transition: border-color 0.15s;
}

.api-custom-url-input:focus {
  border-color: rgba(168, 85, 247, 0.4);
}

.api-custom-send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  background: #a855f7;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s;
}

.api-custom-send-btn:hover {
  background: #9333ea;
}

/* ========== Tester Panel (right side) ========== */

.api-tester-panel {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-primary);
}

/* Empty state */
.api-tester-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex: 1;
  color: var(--text-secondary);
  padding: 48px 24px;
}

.api-tester-empty svg {
  stroke: var(--text-primary);
}

.api-tester-empty-text {
  font-size: 12px;
  color: var(--text-secondary);
  opacity: 0.5;
}

.api-tester-empty-hint {
  font-size: 10px;
  color: var(--text-secondary);
  opacity: 0.3;
  font-family: 'Consolas', monospace;
}

/* Request section */
.api-tester-request {
  flex-shrink: 0;
}

/* URL bar */
.api-tester-url-bar {
  display: flex;
  gap: 6px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
  align-items: center;
}

.api-tester-method {
  padding: 7px 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--method-color, var(--text-primary));
  font-size: 10px;
  font-weight: 700;
  font-family: 'Consolas', monospace;
  border-radius: 6px;
  cursor: pointer;
  flex-shrink: 0;
  letter-spacing: 0.3px;
  transition: border-color 0.15s;
}

.api-tester-method:hover {
  border-color: var(--method-color, #a855f7);
}

.api-tester-url {
  flex: 1;
  min-width: 0;
  padding: 7px 12px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 11.5px;
  font-family: 'Consolas', monospace;
  border-radius: 6px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.api-tester-url:focus {
  border-color: rgba(168, 85, 247, 0.4);
  box-shadow: 0 0 0 1px rgba(168, 85, 247, 0.1);
}

.api-tester-send-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 16px;
  background: #a855f7;
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s;
  letter-spacing: 0.2px;
}

.api-tester-send-btn:hover {
  background: #9333ea;
  box-shadow: 0 2px 8px rgba(168, 85, 247, 0.25);
}

.api-tester-send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  box-shadow: none;
}

.api-tester-send-btn.sending {
  background: rgba(168, 85, 247, 0.6);
}

.api-tester-send-btn svg {
  flex-shrink: 0;
}

.api-tester-send-btn .api-loading-dots span {
  width: 4px;
  height: 4px;
  background: white;
}

/* Collapsible sections */
.api-tester-sections {
  border-bottom: 1px solid var(--border-color);
}

.api-tester-section {
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}

.api-tester-section:last-child {
  border-bottom: none;
}

.api-tester-section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  cursor: pointer;
  font-size: 11px;
  color: var(--text-secondary);
  user-select: none;
  transition: color 0.15s, background 0.15s;
}

.api-tester-section-header:hover {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.015);
}

.api-tester-section-title {
  font-weight: 600;
  letter-spacing: 0.2px;
}

.api-tester-section-count {
  font-size: 9px;
  font-weight: 600;
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.05);
  padding: 1px 6px;
  border-radius: 8px;
  font-family: 'Consolas', monospace;
  opacity: 0.6;
}

.api-tester-chevron {
  transition: transform 0.2s ease;
  flex-shrink: 0;
  opacity: 0.4;
}

.api-tester-chevron.open {
  transform: rotate(90deg);
}

.api-tester-add-header-btn {
  margin-left: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  border-radius: 5px;
  cursor: pointer;
  transition: all 0.15s;
}

.api-tester-add-header-btn:hover {
  background: rgba(168, 85, 247, 0.1);
  border-color: rgba(168, 85, 247, 0.3);
  color: #a855f7;
}

/* Header rows */
.api-tester-headers-list {
  padding: 4px 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.api-tester-header-row {
  display: flex;
  gap: 4px;
  align-items: center;
}

.api-tester-header-key,
.api-tester-header-val {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 11px;
  font-family: 'Consolas', monospace;
  border-radius: 5px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.api-tester-header-key {
  color: #c4a0f5;
}

.api-tester-header-key:focus,
.api-tester-header-val:focus {
  border-color: rgba(168, 85, 247, 0.4);
  box-shadow: 0 0 0 1px rgba(168, 85, 247, 0.08);
}

.api-tester-header-key::placeholder,
.api-tester-header-val::placeholder {
  color: var(--text-secondary);
  opacity: 0.3;
}

.api-tester-header-del {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  border-radius: 4px;
  flex-shrink: 0;
  transition: all 0.15s;
  opacity: 0.3;
}

.api-tester-header-row:hover .api-tester-header-del {
  opacity: 0.6;
}

.api-tester-header-del:hover {
  opacity: 1 !important;
  background: rgba(255, 123, 114, 0.1);
  color: #ff7b72;
}

/* Body textarea */
.api-tester-body-section {
  padding: 4px 14px 10px;
}

.api-tester-body {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 11.5px;
  font-family: 'Consolas', monospace;
  border-radius: 6px;
  outline: none;
  resize: vertical;
  box-sizing: border-box;
  line-height: 1.6;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.api-tester-body:focus {
  border-color: rgba(168, 85, 247, 0.4);
  box-shadow: 0 0 0 1px rgba(168, 85, 247, 0.1);
}

/* ========== Response ========== */

.api-tester-response {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.api-tester-response-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex: 1;
  padding: 32px;
  font-size: 10px;
  color: var(--text-secondary);
  opacity: 0.35;
  font-family: 'Consolas', monospace;
}

.api-response-error {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px 16px;
  color: #ff7b72;
  font-size: 12px;
  background: rgba(255, 123, 114, 0.06);
  border-left: 3px solid rgba(255, 123, 114, 0.3);
  margin: 12px 14px;
  border-radius: 0 6px 6px 0;
  line-height: 1.5;
}

.api-response-error svg {
  flex-shrink: 0;
  margin-top: 1px;
}

/* Status bar */
.api-response-status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
  flex-shrink: 0;
}

.api-response-status {
  display: flex;
  align-items: center;
  gap: 8px;
}

.api-response-status-code {
  padding: 3px 10px;
  border-radius: 5px;
  font-family: 'Consolas', monospace;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: var(--status-color, #8b949e);
  background: color-mix(in srgb, var(--status-color, #8b949e) 10%, transparent);
}

.api-response-status-text {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
  opacity: 0.7;
}

.api-response-meta {
  display: flex;
  gap: 14px;
  font-size: 10.5px;
  color: var(--text-secondary);
  font-family: 'Consolas', monospace;
}

.api-response-meta-item {
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0.6;
}

.api-response-meta-item svg {
  opacity: 0.5;
}

/* Response tabs */
.api-response-tabs {
  display: flex;
  gap: 2px;
  padding: 4px 14px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.api-response-tab {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  border-radius: 5px;
  transition: all 0.15s;
  letter-spacing: 0.1px;
}

.api-response-tab svg {
  opacity: 0.4;
  flex-shrink: 0;
}

.api-response-tab:hover {
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-primary);
}

.api-response-tab.active {
  background: rgba(168, 85, 247, 0.08);
  color: #a855f7;
}

.api-response-tab.active svg {
  opacity: 0.7;
}

.api-response-tab-count {
  font-size: 9px;
  font-weight: 600;
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.05);
  padding: 1px 5px;
  border-radius: 6px;
  font-family: 'Consolas', monospace;
  opacity: 0.5;
}

/* Response content */
.api-response-body-content,
.api-response-headers-content {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.api-response-body-content::-webkit-scrollbar,
.api-response-headers-content::-webkit-scrollbar {
  width: 4px;
}

.api-response-body-content::-webkit-scrollbar-track,
.api-response-headers-content::-webkit-scrollbar-track {
  background: transparent;
}

.api-response-body-content::-webkit-scrollbar-thumb,
.api-response-headers-content::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.06);
  border-radius: 4px;
}

.api-response-body {
  margin: 0;
  padding: 14px;
  font-size: 11.5px;
  font-family: 'Consolas', monospace;
  color: var(--text-primary);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.api-response-header {
  display: flex;
  padding: 4px 14px;
  font-size: 11px;
  font-family: 'Consolas', monospace;
  gap: 4px;
  transition: background 0.1s;
}

.api-response-header:hover {
  background: rgba(255, 255, 255, 0.015);
}

.api-response-header-key {
  color: #c4a0f5;
  white-space: nowrap;
  flex-shrink: 0;
}

.api-response-header-key::after {
  content: ':';
  color: var(--text-secondary);
  opacity: 0.3;
  margin-left: 1px;
}

.api-response-header-val {
  color: var(--text-primary);
  opacity: 0.7;
  word-break: break-all;
}

/* Routes view fills space */
.api-routes-view {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

/* ========== Animations ========== */

@keyframes api-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.api-spin {
  animation: api-spin 0.8s linear infinite;
}

.api-spin-text {
  opacity: 0.5;
  font-size: 12px;
}

/* Loading dots animation */
.api-loading-dots {
  display: flex;
  align-items: center;
  gap: 4px;
}

.api-loading-dots span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #a855f7;
  opacity: 0.3;
  animation: api-dot-pulse 1.2s ease-in-out infinite;
}

.api-loading-dots span:nth-child(2) {
  animation-delay: 0.2s;
}

.api-loading-dots span:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes api-dot-pulse {
  0%, 60%, 100% { opacity: 0.15; transform: scale(0.8); }
  30% { opacity: 0.8; transform: scale(1); }
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
    namespace: 'api',
    channels: {
      invoke: ['api-start', 'api-stop', 'api-detect-framework', 'api-get-port', 'api-detect-routes', 'api-test-request'],
      send: ['api-input', 'api-resize'],
      on: ['api-data', 'api-exit', 'api-port-detected']
    }
  })
});
