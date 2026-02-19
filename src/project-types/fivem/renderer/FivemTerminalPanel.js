/**
 * FiveM Terminal Panel Module
 * Provides the FiveM console panel with errors and resources views.
 * This is used by TerminalManager to create type-specific terminal panels.
 */

const { t } = require('../../../renderer/i18n');
const { escapeHtml } = require('../../../renderer/utils');

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
      <div class="fivem-console-view">
        <div class="fivem-console-output"></div>
        <div class="fivem-console-inputbar">
          <span class="fivem-console-prompt">&gt;</span>
          <input type="text" class="fivem-console-input" placeholder="${t('fivem.commandPlaceholder')}" autocomplete="off" spellcheck="false">
          <button class="fivem-console-send" title="${t('fivem.sendCommand')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </div>
      </div>
      <div class="fivem-errors-view" style="display: none;">
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
      <div class="fivem-resources-view" style="display: none;">
        <div class="fivem-resources-header">
          <div class="fivem-resources-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input type="text" class="fivem-resources-search-input" placeholder="${t('fivem.searchResources')}">
          </div>
          <button class="fivem-refresh-resources" title="${t('fivem.refreshResources')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
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

      consoleView.style.display = 'none';
      errorsView.style.display = 'none';
      resourcesView.style.display = 'none';

      if (view === 'console') {
        consoleView.style.display = '';
        const termData = getTerminal(terminalId);
        if (termData) {
          setTimeout(() => termData.fitAddon.fit(), 50);
        }
      } else if (view === 'errors') {
        errorsView.style.display = '';
        renderErrorsList(wrapper, projectIndex, project, deps);
      } else if (view === 'resources') {
        resourcesView.style.display = '';
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

  searchInput.oninput = () => {
    renderResourcesList(wrapper, projectIndex, project, searchInput.value, deps);
  };

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
