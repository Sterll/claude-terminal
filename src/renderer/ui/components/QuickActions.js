/**
 * QuickActions Component
 * Handles quick action bar rendering, configuration, and execution
 */

const { BaseComponent } = require('../../core/BaseComponent');
const {
  projectsState,
  settingsState,
  getQuickActions,
  addQuickAction,
  updateQuickAction,
  deleteQuickAction,
  getProjectEnvVars,
  setProjectEnvVars,
} = require('../../state');
const { escapeHtml } = require('../../utils');
const { t } = require('../../i18n');
const { createModal, showModal: showModalElement, closeModal } = require('./Modal');

// Icons available for quick actions
const QUICK_ACTION_ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>',
  build: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  test: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15l2 2 4-4"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
  package: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8v13H3V8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>',
  cloudUpload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/><polyline points="16 16 12 12 8 16"/></svg>',
  cloudDownload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  hammer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 12l-8.5 8.5a2.12 2.12 0 1 1-3-3L12 9"/><path d="M17.64 15L22 10.64"/><path d="M20.91 11.7l-1.25-1.25a2.83 2.83 0 0 1 0-4l1.5-1.5a3 3 0 0 0-4.24-4.24L11 6.7"/></svg>',
  bug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="6" width="8" height="14" rx="4"/><path d="M19 7l-3 2"/><path d="M5 7l3 2"/><path d="M19 19l-3-2"/><path d="M5 19l3-2"/><path d="M20 13h-4"/><path d="M4 13h4"/><path d="M10 4l1 2"/><path d="M14 4l-1 2"/></svg>',
  rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
  flame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>',
  git: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>',
  branch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
  commit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/></svg>',
  merge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>',
  clean: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>',
  monitor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>',
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>'
};

// Presets for common actions
const QUICK_ACTION_PRESETS = [
  { name: 'Build', command: 'npm run build', icon: 'build' },
  { name: 'Test', command: 'npm test', icon: 'test' },
  { name: 'Lint', command: 'npm run lint', icon: 'code' },
  { name: 'Dev', command: 'npm run dev', icon: 'play' },
  { name: 'Install', command: 'npm install', icon: 'download' }
];

/**
 * Render the list of actions for configuration
 */
function renderActionsList(actions) {
  if (actions.length === 0) {
    return `<div class="quick-actions-empty-config">${t('quickActions.noActions')}</div>`;
  }

  return actions.map(action => {
    const iconSvg = QUICK_ACTION_ICONS[action.icon] || QUICK_ACTION_ICONS.play;
    return `
      <div class="quick-action-item" data-action-id="${action.id}">
        <div class="quick-action-item-icon">${iconSvg}</div>
        <div class="quick-action-item-info">
          <div class="quick-action-item-name">${escapeHtml(action.name)}</div>
          <div class="quick-action-item-command">${escapeHtml(action.command)}</div>
        </div>
        <div class="quick-action-item-actions">
          <button class="btn-pin${action.pinned ? ' active' : ''}" data-action-id="${action.id}" title="${action.pinned ? t('quickActions.unpinFromCard') : t('quickActions.pinToCard')}">
            <svg viewBox="0 0 24 24" fill="${action.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l2 6h6l-5 4 2 7-5-4-5 4 2-7-5-4h6z"/></svg>
          </button>
          <button class="btn-edit" data-action-id="${action.id}" title="${t('quickActions.editAction')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn-delete" data-action-id="${action.id}" title="${t('quickActions.deleteAction')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Render the action edit form
 */
function renderActionForm(action = null) {
  const iconOptions = Object.keys(QUICK_ACTION_ICONS).map(icon => `
    <button type="button" class="quick-action-icon-option${action?.icon === icon ? ' selected' : ''}" data-icon="${icon}">
      ${QUICK_ACTION_ICONS[icon]}
    </button>
  `).join('');

  return `
    <div class="quick-action-form" data-action-id="${action?.id || 'new'}">
      <div class="quick-action-form-row">
        <div class="quick-action-form-field">
          <label>${t('quickActions.name')}</label>
          <input type="text" id="qa-form-name" placeholder="${t('quickActions.namePlaceholder')}">
        </div>
      </div>
      <div class="quick-action-form-row">
        <div class="quick-action-form-field">
          <label>${t('quickActions.command')}</label>
          <input type="text" id="qa-form-command" placeholder="${t('quickActions.commandPlaceholder')}">
          <div class="qa-variables-hint">
            <span>${t('quickActions.availableVars')}:</span>
            <code>$PROJECT_PATH</code> <code>$BRANCH</code> <code>$PROJECT_NAME</code> <code>$HOME</code>
          </div>
        </div>
      </div>
      <div class="quick-action-form-row">
        <div class="quick-action-form-field">
          <label>${t('quickActions.icon')}</label>
          <div class="quick-action-icon-selector" id="qa-form-icons">
            ${iconOptions}
          </div>
        </div>
      </div>
      <div class="quick-action-form-actions">
        <button type="button" class="btn-cancel" id="qa-form-cancel">${t('common.cancel')}</button>
        <button type="button" class="btn-save" id="qa-form-save">${t('common.save')}</button>
      </div>
    </div>
  `;
}

class QuickActions extends BaseComponent {
  constructor() {
    super(null);
    this._api = window.electron_api;
    this._actionTerminals = new Map();
    this._gitRepoStatus = new Map();
    this._createTerminalCallback = null;
    this._currentConfigModal = null;
  }

  setGitRepoStatus(status) {
    this._gitRepoStatus = status;
  }

  setTerminalCallback(callback) {
    this._createTerminalCallback = callback;
  }

  _substituteVariables(command, project) {
    const branch = this._gitRepoStatus.get(project.id)?.branch || '';
    const vars = {
      '$PROJECT_PATH': project.path,
      '$PROJECT_NAME': project.name,
      '$BRANCH': branch,
      '$HOME': window.electron_nodeModules.os.homedir(),
    };
    const envVars = getProjectEnvVars(project.id);
    for (const [key, value] of Object.entries(envVars)) {
      vars[`$${key}`] = value;
    }
    let result = command;
    for (const [key, value] of Object.entries(vars)) {
      result = result.replaceAll(key, value);
    }
    return result;
  }

  _getAllPresets() {
    const builtIn = QUICK_ACTION_PRESETS.map(p => ({
      ...p,
      label: t(`quickActions.preset.${p.name.toLowerCase()}`) || p.name
    }));
    const custom = (settingsState.get().customPresets || []).map(p => ({
      ...p,
      label: p.name
    }));
    return [...builtIn, ...custom];
  }

  renderQuickActionsBar(project) {
    const wrapper = document.getElementById('actions-dropdown-wrapper');
    const dropdown = document.getElementById('actions-dropdown');
    const actionsBtn = document.getElementById('filter-btn-actions');

    if (!wrapper || !dropdown) return;

    if (!project) {
      wrapper.style.display = 'none';
      return;
    }

    const actions = getQuickActions(project.id);

    wrapper.style.display = 'flex';

    const actionsHtml = actions.map(action => {
      const isRunning = this._actionTerminals.has(action.id);
      const iconSvg = QUICK_ACTION_ICONS[action.icon] || QUICK_ACTION_ICONS.play;
      return `
        <button class="actions-dropdown-item${isRunning ? ' running' : ''}" data-action-id="${action.id}" title="${escapeHtml(action.command)}">
          <span class="actions-item-icon">${isRunning ? QUICK_ACTION_ICONS.refresh : iconSvg}</span>
          <span>${escapeHtml(action.name)}</span>
        </button>
      `;
    }).join('');

    const emptyHtml = actions.length === 0
      ? `<div class="actions-dropdown-empty">${t('quickActions.noActions')}</div>`
      : '';

    dropdown.innerHTML = actionsHtml + emptyHtml + `
      <div class="actions-dropdown-footer" id="actions-dropdown-config">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span>${t('quickActions.configure')}</span>
      </div>
    `;

    dropdown.querySelectorAll('.actions-dropdown-item').forEach(btn => {
      btn.onclick = () => {
        dropdown.classList.remove('active');
        actionsBtn.classList.remove('open');
        this.executeQuickAction(project, btn.dataset.actionId);
      };
    });

    const configFooter = dropdown.querySelector('#actions-dropdown-config');
    if (configFooter) {
      configFooter.onclick = () => {
        dropdown.classList.remove('active');
        actionsBtn.classList.remove('open');
        this._openConfigModal(project);
      };
    }

    actionsBtn.onclick = (e) => {
      e.stopPropagation();
      const isOpen = dropdown.classList.contains('active');

      const branchDropdown = document.getElementById('branch-dropdown');
      const filterBtnBranch = document.getElementById('filter-btn-branch');
      const gitChangesPanel = document.getElementById('git-changes-panel');
      const promptsDropdown = document.getElementById('prompts-dropdown');
      const promptsBtn = document.getElementById('filter-btn-prompts');
      if (branchDropdown) branchDropdown.classList.remove('active');
      if (filterBtnBranch) filterBtnBranch.classList.remove('open');
      if (gitChangesPanel) gitChangesPanel.classList.remove('active');
      if (promptsDropdown) promptsDropdown.classList.remove('active');
      if (promptsBtn) promptsBtn.classList.remove('open');

      dropdown.classList.toggle('active', !isOpen);
      actionsBtn.classList.toggle('open', !isOpen);
    };

    const closeHandler = (e) => {
      if (!wrapper.contains(e.target)) {
        dropdown.classList.remove('active');
        actionsBtn.classList.remove('open');
      }
    };
    document.removeEventListener('click', wrapper._closeHandler);
    wrapper._closeHandler = closeHandler;
    document.addEventListener('click', closeHandler);
  }

  hideQuickActionsBar() {
    const wrapper = document.getElementById('actions-dropdown-wrapper');
    if (wrapper) wrapper.style.display = 'none';
  }

  async executeQuickAction(project, actionId) {
    const actions = getQuickActions(project.id);
    const action = actions.find(a => a.id === actionId);
    if (!action) return;

    const existing = this._actionTerminals.get(actionId);
    const resolvedCommand = this._substituteVariables(action.command, project);

    // Restart: tear the existing terminal down completely (kills the PTY tree
    // via taskkill /T /F on Windows / SIGKILL on POSIX), then re-spawn a fresh
    // one. Sending Ctrl+C to a running .bat under cmd.exe triggers the
    // "Terminer le programme de commandes (O/N) ?" prompt and the next command
    // ends up swallowed by it; closing the tab avoids that and prevents stale
    // output from mixing into the new run.
    if (existing && existing.projectId === project.id) {
      this._actionTerminals.delete(actionId);
      await this._closeAndWait(existing.terminalId);
    }

    try {
      if (this._createTerminalCallback) {
        const terminalId = await this._createTerminalCallback(project, {
          runClaude: false,
          skipPermissions: true,
          name: action.name,
          actionCommand: action.command
        });

        this._actionTerminals.set(actionId, { terminalId, projectId: project.id });

        setTimeout(() => {
          this._api.terminal.input({ id: terminalId, data: resolvedCommand + '\r' });
        }, 300);

        const unsubscribe = this._api.terminal.onExit((data) => {
          if (data && data.id === terminalId) {
            this._actionTerminals.delete(actionId);
            const currentFilter = projectsState.get().selectedProjectFilter;
            const projects = projectsState.get().projects;
            if (projects[currentFilter]?.id === project.id) {
              this.renderQuickActionsBar(project);
            }
            unsubscribe();
          }
        });
      }
    } catch (error) {
      console.error('Error executing quick action:', error);
    }
  }

  _closeAndWait(terminalId, timeoutMs = 1500) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try { unsubscribe && unsubscribe(); } catch (_) {}
        clearTimeout(safety);
        resolve();
      };

      const unsubscribe = this._api.terminal.onExit((data) => {
        if (data && data.id === terminalId) finish();
      });

      const safety = setTimeout(finish, timeoutMs);

      try {
        const TerminalManager = require('./TerminalManager');
        if (TerminalManager && typeof TerminalManager.closeTerminal === 'function') {
          TerminalManager.closeTerminal(terminalId);
        } else {
          this._api.terminal.kill({ id: terminalId });
        }
      } catch (_) {
        try { this._api.terminal.kill({ id: terminalId }); } catch (__) {}
      }
    });
  }

  _openConfigModal(project) {
    const actions = getQuickActions(project.id);

    const content = `
      <div class="quick-actions-modal-body">
        <div class="qa-section">
          <div class="qa-section-header">
            <span class="qa-section-title">${t('quickActions.presets')}</span>
            <span class="qa-section-hint">${t('quickActions.presetsHint') || 'Cliquer pour ajouter'}</span>
          </div>
          <div class="quick-actions-presets">
            ${this._getAllPresets().map(preset => `
              <button class="preset-btn" data-preset="${JSON.stringify({name: preset.name, command: preset.command, icon: preset.icon}).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">
                <span class="preset-btn-icon">${QUICK_ACTION_ICONS[preset.icon] || QUICK_ACTION_ICONS.play}</span>
                <span class="preset-btn-label">${preset.label || preset.name}</span>
                <span class="preset-btn-cmd">${escapeHtml(preset.command)}</span>
              </button>
            `).join('')}
          </div>
        </div>

        <div class="qa-section">
          <div class="qa-section-header">
            <span class="qa-section-title">${t('quickActions.actions') || 'Actions'}</span>
            <span class="qa-section-count">${actions.length}</span>
          </div>
          <div class="quick-actions-list-config" id="quick-actions-config-list">
            ${renderActionsList(actions)}
          </div>
        </div>

        <div class="quick-action-add-buttons">
          <button class="quick-action-add-btn" id="btn-add-quick-action">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            <span>${t('quickActions.addAction')}</span>
          </button>
          <button class="quick-action-add-btn" id="btn-add-script">
            ${QUICK_ACTION_ICONS.terminal}
            <span>${t('quickActions.addScript')}</span>
          </button>
        </div>
      </div>
    `;

    this._currentConfigModal = createModal({
      id: 'quick-actions-config-modal',
      title: t('quickActions.configure'),
      content,
      buttons: [
        {
          label: t('common.close'),
          action: 'close',
          onClick: (modal) => {
            closeModal(modal);
            this.renderQuickActionsBar(project);
          }
        }
      ],
      size: 'large',
      onClose: () => {
        this.renderQuickActionsBar(project);
      }
    });

    showModalElement(this._currentConfigModal);

    setTimeout(() => this._setupModalHandlers(project), 0);
  }

  _setupModalHandlers(project) {
    const listContainer = document.getElementById('quick-actions-config-list');
    const addBtn = document.getElementById('btn-add-quick-action');

    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.onclick = () => {
        const preset = JSON.parse(btn.dataset.preset);
        addQuickAction(project.id, preset);
        this._refreshModalList(project);
      };
    });

    if (addBtn) {
      addBtn.onclick = () => this._showActionForm(project, null, listContainer);
    }

    const addScriptBtn = document.getElementById('btn-add-script');
    if (addScriptBtn) {
      addScriptBtn.onclick = async () => {
        const filePath = await this._api.dialog.selectFile({
          filters: [{ name: 'Scripts', extensions: ['bat', 'cmd', 'ps1'] }]
        });
        if (!filePath) return;

        const fileName = filePath.replace(/\\/g, '/').split('/').pop();
        const name = fileName.replace(/\.(bat|cmd|ps1)$/i, '');
        const command = `& "${filePath}"`;

        addQuickAction(project.id, { name, command, icon: 'terminal' });
        this._refreshModalList(project);
      };
    }

    this._setupListButtonHandlers(project, listContainer);
  }

  _setupListButtonHandlers(project, listContainer) {
    listContainer.querySelectorAll('.btn-pin').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const actionId = btn.dataset.actionId;
        const actions = getQuickActions(project.id);
        const action = actions.find(a => a.id === actionId);
        if (!action) return;
        const willPin = !action.pinned;
        if (willPin) {
          const pinnedCount = actions.filter(a => a.pinned && a.id !== actionId).length;
          if (pinnedCount >= 3) {
            const toastMsg = t('quickActions.pinLimitReached') || 'Max 3 pinned actions';
            // Keep it simple: alert-like inline note via title shake
            btn.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }], { duration: 200 });
            btn.title = toastMsg;
            return;
          }
        }
        updateQuickAction(project.id, actionId, { pinned: willPin });
        this._refreshModalList(project);
        // Re-render project list so the pinned icon appears/disappears on the card
        try {
          const ProjectList = require('./ProjectList');
          if (ProjectList && typeof ProjectList.render === 'function') ProjectList.render();
        } catch (_) {}
      };
    });

    listContainer.querySelectorAll('.btn-edit').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const actionId = btn.dataset.actionId;
        const actions = getQuickActions(project.id);
        const action = actions.find(a => a.id === actionId);
        if (action) {
          this._showActionForm(project, action, listContainer);
        }
      };
    });

    listContainer.querySelectorAll('.btn-delete').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const actionId = btn.dataset.actionId;
        deleteQuickAction(project.id, actionId);
        this._refreshModalList(project);
      };
    });
  }

  _showActionForm(project, action, listContainer) {
    const addBtn = document.getElementById('btn-add-quick-action');
    if (addBtn) addBtn.style.display = 'none';

    const existingForm = listContainer.querySelector('.quick-action-form');
    if (existingForm) {
      existingForm.outerHTML = renderActionForm(action);
    } else {
      listContainer.insertAdjacentHTML('beforeend', renderActionForm(action));
    }

    const form = listContainer.querySelector('.quick-action-form');
    let selectedIcon = action?.icon || 'play';

    form.querySelector('#qa-form-name').value = action?.name || '';
    form.querySelector('#qa-form-command').value = action?.command || '';

    form.querySelectorAll('.quick-action-icon-option').forEach(iconBtn => {
      iconBtn.onclick = () => {
        form.querySelectorAll('.quick-action-icon-option').forEach(b => b.classList.remove('selected'));
        iconBtn.classList.add('selected');
        selectedIcon = iconBtn.dataset.icon;
      };
    });

    form.querySelector('#qa-form-cancel').onclick = () => {
      form.remove();
      if (addBtn) addBtn.style.display = '';
    };

    form.querySelector('#qa-form-save').onclick = () => {
      const name = form.querySelector('#qa-form-name').value.trim();
      const command = form.querySelector('#qa-form-command').value.trim();

      if (!name || !command) return;

      if (action) {
        updateQuickAction(project.id, action.id, { name, command, icon: selectedIcon });
      } else {
        addQuickAction(project.id, { name, command, icon: selectedIcon });
      }

      this._refreshModalList(project);
    };

    form.querySelector('#qa-form-name').focus();
  }

  _refreshModalList(project) {
    const listContainer = document.getElementById('quick-actions-config-list');
    const addBtn = document.getElementById('btn-add-quick-action');

    if (listContainer) {
      const actions = getQuickActions(project.id);
      listContainer.innerHTML = renderActionsList(actions);
      this._setupListButtonHandlers(project, listContainer);
    }

    if (addBtn) addBtn.style.display = '';
  }

  destroy() {
    this._actionTerminals.clear();
    this._createTerminalCallback = null;
    this._currentConfigModal = null;
    super.destroy();
  }
}

// ── Singleton + legacy bridge ──
let _instance = null;
function _getInstance() {
  if (!_instance) _instance = new QuickActions();
  return _instance;
}

module.exports = {
  QuickActions,
  renderQuickActionsBar: (project) => _getInstance().renderQuickActionsBar(project),
  hideQuickActionsBar: () => _getInstance().hideQuickActionsBar(),
  executeQuickAction: (project, actionId) => _getInstance().executeQuickAction(project, actionId),
  setTerminalCallback: (cb) => _getInstance().setTerminalCallback(cb),
  setGitRepoStatus: (status) => _getInstance().setGitRepoStatus(status),
  QUICK_ACTION_ICONS,
  QUICK_ACTION_PRESETS
};
