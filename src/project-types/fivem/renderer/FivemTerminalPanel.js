/**
 * FiveM Terminal Panel Module
 * Provides the FiveM console panel with errors and resources views.
 * This is used by TerminalManager to create type-specific terminal panels.
 */

const { t } = require('../../../renderer/i18n');
const { escapeHtml } = require('../../../renderer/utils');
const { createModal, showModal, closeModal } = require('../../../renderer/ui/components/Modal');
const { showSuccess, showError } = require('../../../renderer/ui/components/Toast');

/**
 * Get the view switcher HTML for the FiveM console wrapper
 * @returns {string} HTML
 */
function getViewSwitcherHtml() {
  return `
    <div class="fivem-view-switcher">
      <button class="fivem-view-tab active" data-view="console">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
        ${t('fivem.console')}
      </button>
      <button class="fivem-view-tab" data-view="errors">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        ${t('fivem.errors')}
        <span class="fivem-error-badge" style="display: none;">0</span>
      </button>
      <button class="fivem-view-tab" data-view="resources">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
        ${t('fivem.resources')}
        <span class="fivem-resource-badge" style="display: none;">0</span>
      </button>
    </div>
    <div class="fivem-view-content">
      <div class="fivem-console-view fivem-view fivem-view-active">
        <div class="fivem-console-output"></div>
        <div class="fivem-console-inputbar">
          <span class="fivem-console-prompt">&gt;</span>
          <input type="text" class="fivem-console-input" placeholder="${t('fivem.commandPlaceholder')}" autocomplete="off" spellcheck="false">
          <button class="fivem-console-send" title="${t('fivem.sendCommand')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </div>
      </div>
      <div class="fivem-errors-view fivem-view">
        <div class="fivem-errors-header">
          <span>${t('fivem.errors')}</span>
          <button class="fivem-clear-errors" title="${t('fivem.clearErrors')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
        <div class="fivem-errors-list"></div>
        <div class="fivem-errors-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          <span>${t('fivem.noErrors')}</span>
        </div>
      </div>
      <div class="fivem-resources-view fivem-view">
        <div class="fivem-resources-header">
          <div class="fivem-resources-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input type="text" class="fivem-resources-search-input" placeholder="${t('fivem.searchResources')}">
          </div>
          <button class="fivem-refresh-resources" title="${t('fivem.refreshResources')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          </button>
          <button class="fivem-create-resource-btn" title="${t('fivem.createResource')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </div>
        <div class="fivem-resources-list"></div>
        <div class="fivem-resources-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
          <span>${t('fivem.noResources')}</span>
        </div>
        <div class="fivem-resources-loading" style="display: none;">
          <div class="spinner"></div>
          <span>${t('fivem.scanning')}</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Setup view switcher events
 * @param {HTMLElement} wrapper - The terminal wrapper element
 * @param {string} terminalId - The terminal ID
 * @param {number} projectIndex - Project index
 * @param {Object} project - Project data
 * @param {Object} deps - Dependencies { getTerminal, getFivemErrors, clearFivemErrors, getFivemResources, setFivemResourcesLoading, setFivemResources, getResourceShortcut, setResourceShortcut, api, createTerminalWithPrompt, buildDebugPrompt }
 */
function setupViewSwitcher(wrapper, terminalId, projectIndex, project, deps) {
  const {
    getTerminal,
    getFivemErrors,
    clearFivemErrors,
    getFivemResources,
    setFivemResourcesLoading,
    setFivemResources,
    getResourceShortcut,
    setResourceShortcut,
    api
  } = deps;

  const viewTabs = wrapper.querySelectorAll('.fivem-view-tab');
  const consoleView = wrapper.querySelector('.fivem-console-view');
  const errorsView = wrapper.querySelector('.fivem-errors-view');
  const resourcesView = wrapper.querySelector('.fivem-resources-view');
  const clearBtn = wrapper.querySelector('.fivem-clear-errors');
  const refreshBtn = wrapper.querySelector('.fivem-refresh-resources');
  const searchInput = wrapper.querySelector('.fivem-resources-search-input');

  viewTabs.forEach(tab => {
    tab.onclick = () => {
      const view = tab.dataset.view;
      viewTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      [consoleView, errorsView, resourcesView].forEach(v => v.classList.remove('fivem-view-active'));

      if (view === 'console') {
        consoleView.classList.add('fivem-view-active');
        const termData = getTerminal(terminalId);
        if (termData) {
          setTimeout(() => termData.fitAddon.fit(), 50);
        }
      } else if (view === 'errors') {
        errorsView.classList.add('fivem-view-active');
        renderErrorsList(wrapper, projectIndex, project, deps);
      } else if (view === 'resources') {
        resourcesView.classList.add('fivem-view-active');
        const { resources, lastScan } = getFivemResources(projectIndex);
        if (!lastScan || resources.length === 0) {
          scanAndRenderResources(wrapper, projectIndex, project, deps);
        } else {
          renderResourcesList(wrapper, projectIndex, project, '', deps);
        }
      }

      const termData = getTerminal(terminalId);
      if (termData) {
        termData.activeView = view;
      }
    };
  });

  clearBtn.onclick = () => {
    clearFivemErrors(projectIndex);
    updateErrorBadge(wrapper, projectIndex, deps);
    renderErrorsList(wrapper, projectIndex, project, deps);
  };

  refreshBtn.onclick = () => {
    scanAndRenderResources(wrapper, projectIndex, project, deps);
  };

  const createResourceBtn = wrapper.querySelector('.fivem-create-resource-btn');
  if (createResourceBtn) {
    createResourceBtn.onclick = () => {
      showCreateResourceModal(wrapper, projectIndex, project, deps);
    };
  }

  searchInput.oninput = () => {
    renderResourcesList(wrapper, projectIndex, project, searchInput.value, deps);
  };

  // ── Console output click → focus input ──
  const consoleOutput = wrapper.querySelector('.fivem-console-output');
  consoleOutput.addEventListener('click', () => {
    const input = wrapper.querySelector('.fivem-console-input');
    if (input) input.focus();
  });

  // ── Console input bar ──
  const consoleInput = wrapper.querySelector('.fivem-console-input');
  const consoleSend = wrapper.querySelector('.fivem-console-send');
  const cmdHistory = [];
  let historyIndex = -1;

  function sendCommand() {
    const cmd = consoleInput.value.trim();
    if (!cmd) return;
    api.fivem.input({ projectIndex, data: cmd + '\r' });
    if (cmdHistory[0] !== cmd) cmdHistory.unshift(cmd);
    if (cmdHistory.length > 50) cmdHistory.pop();
    consoleInput.value = '';
    historyIndex = -1;
  }

  consoleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendCommand();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (historyIndex < cmdHistory.length - 1) {
        historyIndex++;
        consoleInput.value = cmdHistory[historyIndex];
        // Move cursor to end
        setTimeout(() => consoleInput.setSelectionRange(consoleInput.value.length, consoleInput.value.length), 0);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        historyIndex--;
        consoleInput.value = cmdHistory[historyIndex];
      } else {
        historyIndex = -1;
        consoleInput.value = '';
      }
    } else if (e.key === 'Escape') {
      consoleInput.value = '';
      historyIndex = -1;
    }
  });

  consoleSend.onclick = sendCommand;
}

/**
 * Update error badge count
 */
function updateErrorBadge(wrapper, projectIndex, deps) {
  const badge = wrapper.querySelector('.fivem-error-badge');
  if (!badge) return;

  const { errors } = deps.getFivemErrors(projectIndex);
  const count = errors.length;

  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

/**
 * Update resource badge count
 */
function updateResourceBadge(wrapper, count) {
  const badge = wrapper.querySelector('.fivem-resource-badge');
  if (!badge) return;

  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

/**
 * Render errors list
 */
function renderErrorsList(wrapper, projectIndex, project, deps) {
  const list = wrapper.querySelector('.fivem-errors-list');
  const empty = wrapper.querySelector('.fivem-errors-empty');
  const { errors } = deps.getFivemErrors(projectIndex);

  if (errors.length === 0) {
    list.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }

  list.style.display = '';
  empty.style.display = 'none';

  list.innerHTML = errors.map((error, index) => {
    const time = new Date(error.timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const preview = escapeHtml(error.message.split('\n')[0].substring(0, 100));

    return `
      <div class="fivem-error-item" data-index="${index}">
        <div class="fivem-error-item-header">
          <span class="fivem-error-time">${time}</span>
          <button class="fivem-error-debug-btn" data-index="${index}" title="${t('fivem.debugWithClaude')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            Debug
          </button>
        </div>
        <div class="fivem-error-preview">${preview}</div>
        <pre class="fivem-error-detail" style="display: none;">${escapeHtml(error.message)}</pre>
      </div>
    `;
  }).reverse().join('');

  // Toggle detail on click
  list.querySelectorAll('.fivem-error-item').forEach(item => {
    const detail = item.querySelector('.fivem-error-detail');
    const preview = item.querySelector('.fivem-error-preview');
    item.onclick = (e) => {
      if (e.target.closest('.fivem-error-debug-btn')) return;
      const isExpanded = detail.style.display !== 'none';
      detail.style.display = isExpanded ? 'none' : 'block';
      preview.style.display = isExpanded ? '' : 'none';
      item.classList.toggle('expanded', !isExpanded);
    };
  });

  // Debug buttons
  list.querySelectorAll('.fivem-error-debug-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const index = parseInt(btn.dataset.index);
      const error = errors[index];
      if (error && project && deps.createTerminalWithPrompt) {
        const prompt = deps.buildDebugPrompt(error);
        await deps.createTerminalWithPrompt(project, prompt);
      }
    };
  });
}

/**
 * Scan and render resources
 */
async function scanAndRenderResources(wrapper, projectIndex, project, deps) {
  const list = wrapper.querySelector('.fivem-resources-list');
  const empty = wrapper.querySelector('.fivem-resources-empty');
  const loading = wrapper.querySelector('.fivem-resources-loading');
  const refreshBtn = wrapper.querySelector('.fivem-refresh-resources');

  list.style.display = 'none';
  empty.style.display = 'none';
  loading.style.display = 'flex';
  refreshBtn.classList.add('spinning');

  deps.setFivemResourcesLoading(projectIndex, true);

  try {
    const result = await deps.api.fivem.scanResources({ projectPath: project.path });

    if (result.success) {
      deps.setFivemResources(projectIndex, result.resources);
      updateResourceBadge(wrapper, result.resources.length);
      renderResourcesList(wrapper, projectIndex, project, '', deps);
    } else {
      empty.style.display = 'flex';
    }
  } catch (e) {
    console.error('Error scanning resources:', e);
    empty.style.display = 'flex';
  } finally {
    loading.style.display = 'none';
    refreshBtn.classList.remove('spinning');
    deps.setFivemResourcesLoading(projectIndex, false);
  }
}

/**
 * Render resources list
 */
function renderResourcesList(wrapper, projectIndex, project, searchFilter, deps) {
  const list = wrapper.querySelector('.fivem-resources-list');
  const empty = wrapper.querySelector('.fivem-resources-empty');
  const loading = wrapper.querySelector('.fivem-resources-loading');
  const { resources } = deps.getFivemResources(projectIndex);

  loading.style.display = 'none';

  const filteredResources = searchFilter
    ? resources.filter(r => r.name.toLowerCase().includes(searchFilter.toLowerCase()))
    : resources;

  if (filteredResources.length === 0) {
    list.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }

  list.style.display = '';
  empty.style.display = 'none';

  // Group by category
  const grouped = {};
  for (const resource of filteredResources) {
    const cat = resource.category || 'root';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(resource);
  }

  const sortedCategories = Object.keys(grouped).sort((a, b) => {
    if (a === 'root') return -1;
    if (b === 'root') return 1;
    return a.localeCompare(b);
  });

  list.innerHTML = sortedCategories.map(category => {
    const categoryResources = grouped[category];
    return `
      <div class="fivem-resource-category collapsed">
        <div class="fivem-resource-category-header">
          <svg class="category-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12"><path d="M4.5 2.5l3.5 3.5-3.5 3.5"/></svg>
          <span class="category-name">${escapeHtml(category === 'root' ? 'resources/' : category)}</span>
          <span class="category-count">${categoryResources.length}</span>
        </div>
        <div class="fivem-resource-items">
          ${categoryResources.map(resource => {
            const shortcut = deps.getResourceShortcut(projectIndex, resource.name);
            return `
            <div class="fivem-resource-item ${resource.ensured ? 'ensured' : ''}" data-name="${escapeHtml(resource.name)}" data-path="${escapeHtml(resource.path)}">
              <div class="fivem-resource-info">
                <span class="fivem-resource-name">${escapeHtml(resource.name)}</span>
                <span class="fivem-resource-status ${resource.ensured ? 'active' : 'inactive'}">
                  ${resource.ensured ? t('fivem.ensuredInCfg') : t('fivem.notEnsured')}
                </span>
              </div>
              <div class="fivem-resource-actions">
                <button class="fivem-resource-btn shortcut ${shortcut ? 'has-shortcut' : ''}" title="${shortcut ? shortcut + ' - ' + t('fivem.removeShortcut') : t('fivem.setShortcut')}" data-action="shortcut" data-resource="${escapeHtml(resource.name)}">
                  ${shortcut ? `<span class="shortcut-key">${escapeHtml(shortcut)}</span>` : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h8M6 16h.01M18 16h.01"/></svg>`}
                </button>
                <button class="fivem-resource-btn ensure" title="${t('fivem.ensure')}" data-action="ensure" data-resource="${escapeHtml(resource.name)}">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                </button>
                <button class="fivem-resource-btn restart" title="${t('fivem.restart')}" data-action="restart" data-resource="${escapeHtml(resource.name)}">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                </button>
                <button class="fivem-resource-btn stop" title="${t('fivem.stop')}" data-action="stop" data-resource="${escapeHtml(resource.name)}">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><rect x="6" y="6" width="12" height="12"/></svg>
                </button>
                <button class="fivem-resource-btn manifest" title="${t('fivem.editManifest')}" data-action="manifest" data-path="${escapeHtml(resource.path)}">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                </button>
                <button class="fivem-resource-btn folder" title="${t('fivem.openFolder')}" data-action="folder" data-path="${escapeHtml(resource.path)}">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                </button>
              </div>
            </div>
          `;}).join('')}
        </div>
      </div>
    `;
  }).join('');

  // Resource action handlers
  list.querySelectorAll('.fivem-resource-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const resourceName = btn.dataset.resource;
      const resourcePath = btn.dataset.path;

      if (action === 'folder') {
        deps.api.dialog.openInExplorer(resourcePath);
        return;
      }

      if (action === 'manifest') {
        showManifestEditorModal(resourcePath, deps.api);
        return;
      }

      if (action === 'shortcut') {
        const currentShortcut = deps.getResourceShortcut(projectIndex, resourceName);
        if (currentShortcut) {
          deps.setResourceShortcut(projectIndex, resourceName, null);
          renderResourcesList(wrapper, projectIndex, project, wrapper.querySelector('.fivem-resources-search-input')?.value || '', deps);
        } else {
          captureResourceShortcut(btn, projectIndex, resourceName, wrapper, project, deps);
        }
        return;
      }

      let command = '';
      if (action === 'ensure') command = `ensure ${resourceName}`;
      else if (action === 'restart') command = `restart ${resourceName}`;
      else if (action === 'stop') command = `stop ${resourceName}`;

      if (command) {
        btn.classList.add('executing');
        try {
          const result = await deps.api.fivem.resourceCommand({ projectIndex, command });
          if (result.success) {
            btn.classList.add('success');
            setTimeout(() => { btn.classList.remove('executing', 'success'); }, 500);
          } else {
            btn.classList.remove('executing');
            btn.classList.add('error');
            setTimeout(() => btn.classList.remove('error'), 500);
          }
        } catch (e) {
          console.error('Resource command error:', e);
          btn.classList.remove('executing');
          btn.classList.add('error');
          setTimeout(() => btn.classList.remove('error'), 500);
        }
      }
    };
  });

  // Category collapse/expand
  list.querySelectorAll('.fivem-resource-category-header').forEach(header => {
    header.onclick = () => {
      header.parentElement.classList.toggle('collapsed');
    };
  });

  // Right-click context menu on resource items
  list.querySelectorAll('.fivem-resource-item').forEach(item => {
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const resourcePath = item.dataset.path;
      const resourceName = item.dataset.name;
      showResourceContextMenu(e.clientX, e.clientY, resourcePath, resourceName, deps.api);
    });
  });
}

/**
 * Capture keyboard shortcut for a resource
 */
function captureResourceShortcut(btn, projectIndex, resourceName, wrapper, project, deps) {
  btn.innerHTML = `<span class="shortcut-capturing">${t('fivem.pressKey')}</span>`;
  btn.classList.add('capturing');

  const handleKeyDown = (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

    let shortcut = '';
    if (e.ctrlKey) shortcut += 'Ctrl+';
    if (e.altKey) shortcut += 'Alt+';
    if (e.shiftKey) shortcut += 'Shift+';

    if (e.key === 'Escape') {
      cleanup();
      renderResourcesList(wrapper, projectIndex, project, wrapper.querySelector('.fivem-resources-search-input')?.value || '', deps);
      return;
    }

    let keyName = e.key;
    if (keyName === ' ') keyName = 'Space';
    else if (keyName.length === 1) keyName = keyName.toUpperCase();
    shortcut += keyName;

    deps.setResourceShortcut(projectIndex, resourceName, shortcut);
    cleanup();
    renderResourcesList(wrapper, projectIndex, project, wrapper.querySelector('.fivem-resources-search-input')?.value || '', deps);
  };

  const cleanup = () => {
    document.removeEventListener('keydown', handleKeyDown, true);
    btn.classList.remove('capturing');
  };

  document.addEventListener('keydown', handleKeyDown, true);
}

/**
 * Show a context menu for a resource item
 */
function showResourceContextMenu(x, y, resourcePath, resourceName, api) {
  document.querySelectorAll('.fivem-resource-context-menu').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'fivem-resource-context-menu';
  menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:9999`;
  menu.innerHTML = `
    <button class="fivem-ctx-item" data-action="manifest">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
      ${t('fivem.editManifest')}
    </button>
    <button class="fivem-ctx-item" data-action="folder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      ${t('fivem.openFolder')}
    </button>
  `;

  menu.querySelector('[data-action="manifest"]').onclick = () => {
    menu.remove();
    showManifestEditorModal(resourcePath, api);
  };
  menu.querySelector('[data-action="folder"]').onclick = () => {
    menu.remove();
    api.dialog.openInExplorer(resourcePath);
  };

  document.body.appendChild(menu);

  // Clamp to viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;
  });

  const dismiss = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', dismiss, true);
    }
  };
  setTimeout(() => document.addEventListener('click', dismiss, true), 0);
}

/**
 * Show "Create Resource" modal
 */
function showCreateResourceModal(wrapper, projectIndex, project, deps) {
  const content = `
    <div class="fivem-resource-wizard">
      <div class="form-group">
        <label class="form-label">${t('fivem.resourceName')} *</label>
        <input type="text" id="fivem-res-name" class="form-input" placeholder="my_resource" autocomplete="off">
        <span class="form-hint">${t('fivem.resourceNameHint')}</span>
        <span class="form-error" id="fivem-res-name-error" style="display:none"></span>
      </div>
      <div class="form-group">
        <label class="form-label">${t('fivem.template')}</label>
        <select id="fivem-res-template" class="form-input">
          <option value="blank">${t('fivem.templateBlank')}</option>
          <option value="client_server" selected>${t('fivem.templateClientServer')}</option>
          <option value="client_only">${t('fivem.templateClientOnly')}</option>
          <option value="server_only">${t('fivem.templateServerOnly')}</option>
          <option value="esx">${t('fivem.templateEsx')}</option>
          <option value="qb">${t('fivem.templateQb')}</option>
        </select>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${t('fivem.version')}</label>
          <input type="text" id="fivem-res-version" class="form-input" value="1.0.0" autocomplete="off">
        </div>
        <div class="form-group">
          <label class="form-label">${t('fivem.author')}</label>
          <input type="text" id="fivem-res-author" class="form-input" placeholder="${t('fivem.authorPlaceholder')}" autocomplete="off">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${t('fivem.description')}</label>
        <input type="text" id="fivem-res-description" class="form-input" placeholder="${t('fivem.descriptionPlaceholder')}" autocomplete="off">
      </div>
      <div class="form-group">
        <label class="form-label">${t('fivem.dependencies')}</label>
        <input type="text" id="fivem-res-dependencies" class="form-input" placeholder="es_extended, oxmysql" autocomplete="off">
        <span class="form-hint">${t('fivem.dependenciesHint')}</span>
      </div>
    </div>
  `;

  const modal = createModal({
    id: 'fivem-create-resource-modal',
    title: t('fivem.createResource'),
    content,
    size: 'large',
    buttons: [
      {
        label: t('common.cancel') || 'Cancel',
        action: 'cancel',
        onClick: (m) => closeModal(m)
      },
      {
        label: t('fivem.createResourceBtn'),
        action: 'create',
        primary: true,
        onClick: async (m) => {
          const nameInput = m.querySelector('#fivem-res-name');
          const nameError = m.querySelector('#fivem-res-name-error');
          const name = nameInput.value.trim();

          nameError.style.display = 'none';

          if (!name) {
            nameError.textContent = t('fivem.nameRequired');
            nameError.style.display = '';
            return;
          }
          if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
            nameError.textContent = t('fivem.nameInvalid');
            nameError.style.display = '';
            return;
          }

          const createBtn = m.querySelector('[data-action="create"]');
          createBtn.disabled = true;
          const origLabel = createBtn.textContent;
          createBtn.textContent = t('fivem.creating');

          try {
            const result = await deps.api.fivem.createResource({
              projectPath: project.path,
              name,
              template: m.querySelector('#fivem-res-template').value,
              version: m.querySelector('#fivem-res-version').value.trim() || '1.0.0',
              author: m.querySelector('#fivem-res-author').value.trim(),
              description: m.querySelector('#fivem-res-description').value.trim(),
              dependencies: m.querySelector('#fivem-res-dependencies').value.trim()
            });

            if (result.success) {
              closeModal(m);
              showSuccess(t('fivem.resourceCreated', { name }));
              scanAndRenderResources(wrapper, projectIndex, project, deps);
            } else {
              nameError.textContent = result.error || t('fivem.errorCreatingResource');
              nameError.style.display = '';
              createBtn.disabled = false;
              createBtn.textContent = origLabel;
            }
          } catch (err) {
            console.error('Create resource error:', err);
            nameError.textContent = t('fivem.unexpectedError');
            nameError.style.display = '';
            createBtn.disabled = false;
            createBtn.textContent = origLabel;
          }
        }
      }
    ]
  });

  showModal(modal);
  setTimeout(() => modal.querySelector('#fivem-res-name')?.focus(), 100);
}

/**
 * Build raw fxmanifest.lua string from form fields
 */
function buildRawFromForm(modal) {
  const get = (id) => modal.querySelector(id)?.value || '';
  const lines = [];

  const fxVersion = get('#mf-fxversion').trim() || 'cerulean';
  const game = get('#mf-game') || 'gta5';
  lines.push(`fx_version '${fxVersion}'`);
  lines.push(`game '${game}'`);
  lines.push('');

  const name = get('#mf-name').trim();
  const description = get('#mf-description').trim();
  const version = get('#mf-version').trim();
  const author = get('#mf-author').trim();
  if (name) lines.push(`name '${name}'`);
  if (description) lines.push(`description '${description}'`);
  if (version) lines.push(`version '${version}'`);
  if (author) lines.push(`author '${author}'`);

  const formatScripts = (raw, key) => {
    const entries = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (!entries.length) return null;
    return `${key} { ${entries.map(e => `'${e}'`).join(', ')} }`;
  };
  const formatDeps = (raw) => {
    const entries = raw.split(/[\n,]/).map(l => l.trim()).filter(Boolean);
    if (!entries.length) return null;
    return `dependencies { ${entries.map(e => `'${e}'`).join(', ')} }`;
  };

  const clientLine = formatScripts(get('#mf-client'), 'client_scripts');
  const serverLine = formatScripts(get('#mf-server'), 'server_scripts');
  const sharedLine = formatScripts(get('#mf-shared'), 'shared_scripts');
  const depsLine = formatDeps(get('#mf-deps'));

  if (clientLine || serverLine || sharedLine || depsLine) lines.push('');
  if (clientLine) lines.push(clientLine);
  if (serverLine) lines.push(serverLine);
  if (sharedLine) lines.push(sharedLine);
  if (depsLine) lines.push(depsLine);

  return lines.join('\n') + '\n';
}

/**
 * Sync visual form fields from raw Lua content (best-effort)
 */
function syncFormFromRaw(modal, rawText) {
  const set = (id, value) => { const el = modal.querySelector(id); if (el) el.value = value; };

  const singleRe = /^(\w+)\s+'([^']+)'/gm;
  let m;
  while ((m = singleRe.exec(rawText)) !== null) {
    const [, key, value] = m;
    if (key === 'fx_version') set('#mf-fxversion', value);
    else if (key === 'game') set('#mf-game', value);
    else if (key === 'name') set('#mf-name', value);
    else if (key === 'description') set('#mf-description', value);
    else if (key === 'version') set('#mf-version', value);
    else if (key === 'author') set('#mf-author', value);
  }

  const arrayRe = /^(\w+)\s*\{([^}]+)\}/gm;
  while ((m = arrayRe.exec(rawText)) !== null) {
    const [, key, inner] = m;
    const entries = [...inner.matchAll(/'([^']+)'/g)].map(x => x[1]);
    if (key === 'client_scripts' || key === 'client_script') set('#mf-client', entries.join('\n'));
    else if (key === 'server_scripts' || key === 'server_script') set('#mf-server', entries.join('\n'));
    else if (key === 'shared_scripts' || key === 'shared_script') set('#mf-shared', entries.join('\n'));
    else if (key === 'dependencies' || key === 'dependency') set('#mf-deps', entries.join('\n'));
  }
}

/**
 * Show fxmanifest.lua editor modal
 */
async function showManifestEditorModal(resourcePath, api) {
  let manifestData;
  try {
    manifestData = await api.fivem.readManifest({ resourcePath });
  } catch (e) {
    showError(t('fivem.manifestReadError'));
    return;
  }

  if (!manifestData.success) {
    showError(manifestData.error || t('fivem.manifestReadError'));
    return;
  }

  const { raw, parsed } = manifestData;
  const resourceName = resourcePath.replace(/\\/g, '/').split('/').pop();

  const esc = (s) => escapeHtml(s || '');

  const content = `
    <div class="fivem-manifest-editor">
      <div class="manifest-tab-bar">
        <button class="manifest-tab active" data-tab="visual">${t('fivem.manifestVisual')}</button>
        <button class="manifest-tab" data-tab="raw">${t('fivem.manifestRaw')}</button>
      </div>
      <div class="manifest-tab-content" data-content="visual">
        <div class="manifest-form-grid">
          <div class="form-group">
            <label class="form-label">fx_version</label>
            <input type="text" id="mf-fxversion" class="form-input" value="${esc(parsed.fxVersion || 'cerulean')}">
          </div>
          <div class="form-group">
            <label class="form-label">game</label>
            <select id="mf-game" class="form-input">
              <option value="gta5" ${parsed.game === 'gta5' || !parsed.game ? 'selected' : ''}>gta5</option>
              <option value="rdr3" ${parsed.game === 'rdr3' ? 'selected' : ''}>rdr3</option>
              <option value="common" ${parsed.game === 'common' ? 'selected' : ''}>common</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">name</label>
            <input type="text" id="mf-name" class="form-input" value="${esc(parsed.name)}">
          </div>
          <div class="form-group">
            <label class="form-label">version</label>
            <input type="text" id="mf-version" class="form-input" value="${esc(parsed.version)}">
          </div>
          <div class="form-group form-group-full">
            <label class="form-label">description</label>
            <input type="text" id="mf-description" class="form-input" value="${esc(parsed.description)}">
          </div>
          <div class="form-group form-group-full">
            <label class="form-label">author</label>
            <input type="text" id="mf-author" class="form-input" value="${esc(parsed.author)}">
          </div>
          <div class="form-group form-group-full">
            <label class="form-label">client_scripts</label>
            <textarea id="mf-client" class="form-textarea form-code">${esc((parsed.clientScripts || []).join('\n'))}</textarea>
            <span class="form-hint">${t('fivem.scriptsHint')}</span>
          </div>
          <div class="form-group form-group-full">
            <label class="form-label">server_scripts</label>
            <textarea id="mf-server" class="form-textarea form-code">${esc((parsed.serverScripts || []).join('\n'))}</textarea>
          </div>
          <div class="form-group form-group-full">
            <label class="form-label">shared_scripts</label>
            <textarea id="mf-shared" class="form-textarea form-code">${esc((parsed.sharedScripts || []).join('\n'))}</textarea>
          </div>
          <div class="form-group form-group-full">
            <label class="form-label">dependencies</label>
            <textarea id="mf-deps" class="form-textarea">${esc((parsed.dependencies || []).join('\n'))}</textarea>
            <span class="form-hint">${t('fivem.dependenciesHint')}</span>
          </div>
        </div>
      </div>
      <div class="manifest-tab-content" data-content="raw" style="display:none">
        <textarea id="mf-raw" class="form-textarea form-code manifest-raw-editor" spellcheck="false">${esc(raw)}</textarea>
      </div>
    </div>
  `;

  const modal = createModal({
    id: 'fivem-manifest-editor-modal',
    title: `${t('fivem.editManifest')} — ${escapeHtml(resourceName)}`,
    content,
    size: 'large',
    buttons: [
      {
        label: t('common.cancel') || 'Cancel',
        action: 'cancel',
        onClick: (m) => closeModal(m)
      },
      {
        label: t('common.save') || 'Save',
        action: 'save',
        primary: true,
        onClick: async (m) => {
          const activeTab = m.querySelector('.manifest-tab.active')?.dataset.tab;
          let writeData;

          if (activeTab === 'raw') {
            writeData = { raw: m.querySelector('#mf-raw').value };
          } else {
            writeData = {
              fxVersion: m.querySelector('#mf-fxversion').value.trim(),
              game: m.querySelector('#mf-game').value,
              name: m.querySelector('#mf-name').value.trim(),
              version: m.querySelector('#mf-version').value.trim(),
              author: m.querySelector('#mf-author').value.trim(),
              description: m.querySelector('#mf-description').value.trim(),
              clientScriptsRaw: m.querySelector('#mf-client').value,
              serverScriptsRaw: m.querySelector('#mf-server').value,
              sharedScriptsRaw: m.querySelector('#mf-shared').value,
              dependenciesRaw: m.querySelector('#mf-deps').value
            };
          }

          const saveBtn = m.querySelector('[data-action="save"]');
          saveBtn.disabled = true;

          try {
            const result = await api.fivem.writeManifest({ resourcePath, data: writeData });
            if (result.success) {
              closeModal(m);
              showSuccess(t('fivem.manifestSaved'));
            } else {
              showError(result.error || t('fivem.errorSavingManifest'));
              saveBtn.disabled = false;
            }
          } catch (e) {
            console.error('Manifest write error:', e);
            showError(t('fivem.unexpectedError'));
            saveBtn.disabled = false;
          }
        }
      }
    ]
  });

  showModal(modal);

  // Tab switching with data sync
  const tabs = modal.querySelectorAll('.manifest-tab');
  const contents = modal.querySelectorAll('.manifest-tab-content');

  tabs.forEach(tab => {
    tab.onclick = () => {
      const targetTab = tab.dataset.tab;
      const leavingTab = modal.querySelector('.manifest-tab.active')?.dataset.tab;

      if (leavingTab === 'visual' && targetTab === 'raw') {
        modal.querySelector('#mf-raw').value = buildRawFromForm(modal);
      } else if (leavingTab === 'raw' && targetTab === 'visual') {
        syncFormFromRaw(modal, modal.querySelector('#mf-raw').value);
      }

      tabs.forEach(t2 => t2.classList.remove('active'));
      tab.classList.add('active');
      contents.forEach(c => {
        c.style.display = c.dataset.content === targetTab ? '' : 'none';
      });
    };
  });
}

/**
 * Handle new error - update badge and refresh if needed
 */
function onNewError(wrapper, projectIndex, deps) {
  updateErrorBadge(wrapper, projectIndex, deps);

  const termData = deps.getTerminal(deps.consoleId);
  if (termData && termData.activeView === 'errors') {
    renderErrorsList(wrapper, projectIndex, termData.project, deps);
  }

  // Flash errors tab
  const errorsTab = wrapper.querySelector('.fivem-view-tab[data-view="errors"]');
  if (errorsTab && termData?.activeView !== 'errors') {
    errorsTab.classList.add('has-new-error');
    setTimeout(() => errorsTab.classList.remove('has-new-error'), 2000);
  }
}

module.exports = {
  getViewSwitcherHtml,
  setupViewSwitcher,
  updateErrorBadge,
  updateResourceBadge,
  renderErrorsList,
  renderResourcesList,
  scanAndRenderResources,
  onNewError
};
