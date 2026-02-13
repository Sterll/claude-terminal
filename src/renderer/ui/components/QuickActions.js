/**
 * QuickActions Component
 * Handles quick action bar rendering, configuration, and execution
 */

const api = window.electron_api;
const {
  projectsState,
  settingsState,
  getQuickActions,
  addQuickAction,
  updateQuickAction,
  deleteQuickAction
} = require('../../state');
const { escapeHtml } = require('../../utils');
const { t } = require('../../i18n');
const { createModal, showModal: showModalElement, closeModal } = require('./Modal');

// Icons available for quick actions
const QUICK_ACTION_ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  build: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  test: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15l2 2 4-4"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
  package: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  git: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>',
  clean: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
};

// Presets for common actions
const QUICK_ACTION_PRESETS = [
  { name: 'Build', command: 'npm run build', icon: 'build' },
  { name: 'Test', command: 'npm test', icon: 'test' },
  { name: 'Lint', command: 'npm run lint', icon: 'code' },
  { name: 'Dev', command: 'npm run dev', icon: 'play' },
  { name: 'Install', command: 'npm install', icon: 'download' }
];

// Track running actions: actionId -> { terminalId, projectId }
const actionTerminals = new Map();

/**
 * Get all presets (built-in + custom from settings)
 * @returns {Array}
 */
function getAllPresets() {
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

// Callback for creating terminals
let createTerminalCallback = null;

/**
 * Set callback for terminal creation
 * @param {Function} callback
 */
function setTerminalCallback(callback) {
  createTerminalCallback = callback;
}

/**
 * Render quick actions dropdown for a project
 * @param {Object} project
 */
function renderQuickActionsBar(project) {
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

  // Build dropdown items
  const actionsHtml = actions.map(action => {
    const isRunning = actionTerminals.has(action.id);
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

  // Add click handlers for action items
  dropdown.querySelectorAll('.actions-dropdown-item').forEach(btn => {
    btn.onclick = () => {
      // Close dropdown
      dropdown.classList.remove('active');
      actionsBtn.classList.remove('open');
      executeQuickAction(project, btn.dataset.actionId);
    };
  });

  // Config footer handler
  const configFooter = dropdown.querySelector('#actions-dropdown-config');
  if (configFooter) {
    configFooter.onclick = () => {
      dropdown.classList.remove('active');
      actionsBtn.classList.remove('open');
      openConfigModal(project);
    };
  }

  // Toggle dropdown on button click
  actionsBtn.onclick = (e) => {
    e.stopPropagation();
    const isOpen = dropdown.classList.contains('active');

    // Close other dropdowns
    const branchDropdown = document.getElementById('branch-dropdown');
    const filterBtnBranch = document.getElementById('filter-btn-branch');
    const gitChangesPanel = document.getElementById('git-changes-panel');
    if (branchDropdown) branchDropdown.classList.remove('active');
    if (filterBtnBranch) filterBtnBranch.classList.remove('open');
    if (gitChangesPanel) gitChangesPanel.classList.remove('active');

    dropdown.classList.toggle('active', !isOpen);
    actionsBtn.classList.toggle('open', !isOpen);
  };

  // Close on outside click
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

/**
 * Hide quick actions dropdown
 */
function hideQuickActionsBar() {
  const wrapper = document.getElementById('actions-dropdown-wrapper');
  if (wrapper) wrapper.style.display = 'none';
}

/**
 * Execute a quick action, reusing existing terminal if available
 * @param {Object} project
 * @param {string} actionId
 */
async function executeQuickAction(project, actionId) {
  const actions = getQuickActions(project.id);
  const action = actions.find(a => a.id === actionId);
  if (!action) return;

  const existing = actionTerminals.get(actionId);

  if (existing && existing.projectId === project.id) {
    // Reuse existing terminal: send Ctrl+C to interrupt, then rerun
    api.terminal.input({ id: existing.terminalId, data: '\x03' });
    setTimeout(() => {
      api.terminal.input({ id: existing.terminalId, data: action.command + '\r' });
    }, 200);
    return;
  }

  // Create a new terminal for this action
  try {
    if (createTerminalCallback) {
      const terminalId = await createTerminalCallback(project, {
        runClaude: false,
        skipPermissions: true,
        name: action.name,
        actionCommand: action.command
      });

      // Track this terminal for reuse
      actionTerminals.set(actionId, { terminalId, projectId: project.id });

      // Send the command after a short delay for terminal to initialize
      setTimeout(() => {
        api.terminal.input({ id: terminalId, data: action.command + '\r' });
      }, 300);

      // Listen for terminal exit to clean up mapping
      const unsubscribe = api.terminal.onExit((data) => {
        if (data && data.id === terminalId) {
          actionTerminals.delete(actionId);
          const currentFilter = projectsState.get().selectedProjectFilter;
          const projects = projectsState.get().projects;
          if (projects[currentFilter]?.id === project.id) {
            renderQuickActionsBar(project);
          }
          unsubscribe();
        }
      });
    }
  } catch (error) {
    console.error('Error executing quick action:', error);
  }
}

// Current modal reference for cleanup
let currentConfigModal = null;

/**
 * Open configuration modal for quick actions
 * @param {Object} project
 */
function openConfigModal(project) {
  const actions = getQuickActions(project.id);

  const content = `
    <div class="quick-actions-modal-body">
      <div class="qa-section">
        <div class="qa-section-header">
          <span class="qa-section-title">${t('quickActions.presets')}</span>
          <span class="qa-section-hint">${t('quickActions.presetsHint') || 'Cliquer pour ajouter'}</span>
        </div>
        <div class="quick-actions-presets">
          ${getAllPresets().map(preset => `
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

  currentConfigModal = createModal({
    id: 'quick-actions-config-modal',
    title: t('quickActions.configure'),
    content,
    buttons: [
      {
        label: t('common.close'),
        action: 'close',
        onClick: (modal) => {
          closeModal(modal);
          renderQuickActionsBar(project);
        }
      }
    ],
    size: 'large',
    onClose: () => {
      renderQuickActionsBar(project);
    }
  });

  showModalElement(currentConfigModal);

  // Setup event handlers after modal is in DOM
  setTimeout(() => setupModalHandlers(project), 0);
}

/**
 * Render the list of actions for configuration
 * @param {Array} actions
 * @returns {string}
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
 * @param {Object|null} action - Existing action or null for new
 * @returns {string}
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

/**
 * Setup modal event handlers
 * @param {Object} project
 */
function setupModalHandlers(project) {
  const listContainer = document.getElementById('quick-actions-config-list');
  const addBtn = document.getElementById('btn-add-quick-action');

  // Preset buttons
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.onclick = () => {
      const preset = JSON.parse(btn.dataset.preset);
      addQuickAction(project.id, preset);
      refreshModalList(project);
    };
  });

  // Add button
  if (addBtn) {
    addBtn.onclick = () => showActionForm(project, null, listContainer);
  }

  // Add script button
  const addScriptBtn = document.getElementById('btn-add-script');
  if (addScriptBtn) {
    addScriptBtn.onclick = async () => {
      const filePath = await api.dialog.selectFile({
        filters: [{ name: 'Scripts', extensions: ['bat', 'cmd', 'ps1'] }]
      });
      if (!filePath) return;

      const fileName = filePath.replace(/\\/g, '/').split('/').pop();
      const name = fileName.replace(/\.(bat|cmd|ps1)$/i, '');
      const command = `& "${filePath}"`;

      addQuickAction(project.id, { name, command, icon: 'terminal' });
      refreshModalList(project);
    };
  }

  // Edit and delete buttons
  setupListButtonHandlers(project, listContainer);
}

/**
 * Setup button handlers for the actions list
 * @param {Object} project
 * @param {HTMLElement} listContainer
 */
function setupListButtonHandlers(project, listContainer) {
  listContainer.querySelectorAll('.btn-edit').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const actionId = btn.dataset.actionId;
      const actions = getQuickActions(project.id);
      const action = actions.find(a => a.id === actionId);
      if (action) {
        showActionForm(project, action, listContainer);
      }
    };
  });

  listContainer.querySelectorAll('.btn-delete').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const actionId = btn.dataset.actionId;
      deleteQuickAction(project.id, actionId);
      refreshModalList(project);
    };
  });
}

/**
 * Show the action edit form
 * @param {Object} project
 * @param {Object|null} action
 * @param {HTMLElement} listContainer
 */
function showActionForm(project, action, listContainer) {
  const addBtn = document.getElementById('btn-add-quick-action');
  if (addBtn) addBtn.style.display = 'none';

  // Insert or replace form
  const existingForm = listContainer.querySelector('.quick-action-form');
  if (existingForm) {
    existingForm.outerHTML = renderActionForm(action);
  } else {
    listContainer.insertAdjacentHTML('beforeend', renderActionForm(action));
  }

  // Setup form handlers
  const form = listContainer.querySelector('.quick-action-form');
  let selectedIcon = action?.icon || 'play';

  // Set input values programmatically to avoid HTML attribute escaping issues
  form.querySelector('#qa-form-name').value = action?.name || '';
  form.querySelector('#qa-form-command').value = action?.command || '';

  // Icon selection
  form.querySelectorAll('.quick-action-icon-option').forEach(iconBtn => {
    iconBtn.onclick = () => {
      form.querySelectorAll('.quick-action-icon-option').forEach(b => b.classList.remove('selected'));
      iconBtn.classList.add('selected');
      selectedIcon = iconBtn.dataset.icon;
    };
  });

  // Cancel button
  form.querySelector('#qa-form-cancel').onclick = () => {
    form.remove();
    if (addBtn) addBtn.style.display = '';
  };

  // Save button
  form.querySelector('#qa-form-save').onclick = () => {
    const name = form.querySelector('#qa-form-name').value.trim();
    const command = form.querySelector('#qa-form-command').value.trim();

    if (!name || !command) return;

    if (action) {
      updateQuickAction(project.id, action.id, { name, command, icon: selectedIcon });
    } else {
      addQuickAction(project.id, { name, command, icon: selectedIcon });
    }

    refreshModalList(project);
  };

  // Focus name input
  form.querySelector('#qa-form-name').focus();
}

/**
 * Refresh the modal list
 * @param {Object} project
 */
function refreshModalList(project) {
  const listContainer = document.getElementById('quick-actions-config-list');
  const addBtn = document.getElementById('btn-add-quick-action');

  if (listContainer) {
    const actions = getQuickActions(project.id);
    listContainer.innerHTML = renderActionsList(actions);
    setupListButtonHandlers(project, listContainer);
  }

  if (addBtn) addBtn.style.display = '';
}

module.exports = {
  renderQuickActionsBar,
  hideQuickActionsBar,
  setTerminalCallback,
  QUICK_ACTION_ICONS,
  QUICK_ACTION_PRESETS
};
