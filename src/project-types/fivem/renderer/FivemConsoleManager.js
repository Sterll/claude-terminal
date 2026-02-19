/**
 * FiveM Console Manager
 * Handles FiveM-specific console features: error overlay, debug prompt, console config.
 * Extracted from TerminalManager to keep type-specific logic in project-types.
 */

const { getFivemServer, getFivemErrors, dismissLastError } = require('./FivemState');

// Track error overlays by projectIndex
const errorOverlays = new Map();

/**
 * Get console configuration for FiveM projects.
 * Used by TerminalManager's generic createTypeConsole().
 */
function getConsoleConfig(project, projectIndex) {
  return {
    typeId: 'fivem',
    tabIcon: '🖥️',
    tabClass: 'fivem-tab',
    dotClass: 'fivem-dot',
    wrapperClass: 'fivem-wrapper',
    consoleViewSelector: '.fivem-console-output',
    ipcNamespace: 'fivem',
    scrollback: 10000,
    disableStdin: true,
    getExistingLogs: () => [],
    onCleanup: () => {}
  };
}

/**
 * Build debug prompt from error for Claude terminal.
 * @param {Object} error - { message, context }
 * @param {Function} t - i18n function
 * @returns {string}
 */
function buildDebugPrompt(error, t) {
  let prompt = t('fivem.debugPrompt');
  prompt += '```\n';
  prompt += error.message;
  prompt += '\n```\n';

  if (error.context && error.context !== error.message) {
    prompt += t('fivem.debugContext');
    prompt += '```\n';
    prompt += error.context;
    prompt += '\n```';
  }

  return prompt;
}

/**
 * Show FiveM error overlay with debug button.
 * @param {number} projectIndex
 * @param {Object} error - { timestamp, message, context }
 * @param {Object} tmApi - TerminalManager API { getTypeConsoleId, getTerminal, createTerminalWithPrompt, t, escapeHtml, projectsState }
 */
function showErrorOverlay(projectIndex, error, tmApi) {
  const { getTypeConsoleId, t, projectsState, createTerminalWithPrompt } = tmApi;

  const consoleId = getTypeConsoleId(projectIndex, 'fivem');
  if (!consoleId) return;

  const wrapper = document.querySelector(`.terminal-wrapper[data-id="${consoleId}"]`);
  if (!wrapper) return;

  // Remove existing overlay if any
  const existing = wrapper.querySelector('.fivem-error-overlay');
  if (existing) existing.remove();

  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'fivem-error-overlay';
  overlay.innerHTML = `
    <div class="fivem-error-content">
      <span class="fivem-error-icon">⚠️</span>
      <span class="fivem-error-text">${t('fivem.errorDetected')}</span>
      <button class="fivem-debug-btn" title="${t('fivem.debugWithClaude')}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        ${t('fivem.debugWithClaude')}
      </button>
      <button class="fivem-error-dismiss" title="${t('common.close')}">
        <svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
      </button>
    </div>
  `;

  wrapper.appendChild(overlay);
  errorOverlays.set(projectIndex, overlay);

  // Get project info
  const projects = projectsState.get().projects;
  const project = projects[projectIndex];

  // Debug button click - open Claude terminal with error
  overlay.querySelector('.fivem-debug-btn').onclick = async () => {
    if (!project) return;
    const prompt = buildDebugPrompt(error, t);
    await createTerminalWithPrompt(project, prompt);
    hideErrorOverlay(projectIndex);
  };

  // Dismiss button
  overlay.querySelector('.fivem-error-dismiss').onclick = () => {
    hideErrorOverlay(projectIndex);
  };

  // Auto-hide after 30 seconds
  setTimeout(() => {
    hideErrorOverlay(projectIndex);
  }, 30000);
}

/**
 * Hide error overlay for a project.
 * @param {number} projectIndex
 */
function hideErrorOverlay(projectIndex) {
  const overlay = errorOverlays.get(projectIndex);
  if (overlay) {
    overlay.classList.add('hiding');
    setTimeout(() => {
      overlay.remove();
      errorOverlays.delete(projectIndex);
    }, 300);
  }
  dismissLastError(projectIndex);
}

/**
 * Handle new console error (update panel UI).
 * @param {number} projectIndex
 * @param {Object} error
 * @param {Object} tmApi - TerminalManager API
 */
function onConsoleError(projectIndex, error, tmApi) {
  const { getTypeConsoleId, getTerminal } = tmApi;
  const registry = require('../../registry');

  const consoleId = getTypeConsoleId(projectIndex, 'fivem');
  if (!consoleId) return;

  const wrapper = document.querySelector(`.terminal-wrapper[data-id="${consoleId}"]`);
  if (!wrapper) return;

  const termData = getTerminal(consoleId);
  if (!termData) return;

  // Delegate to type handler panel
  const typeHandler = registry.get(termData.project?.type || 'standalone');
  const panels = typeHandler.getTerminalPanels({ project: termData.project, projectIndex });
  const panel = panels && panels.length > 0 ? panels[0] : null;
  if (panel && panel.onNewError) {
    const { getTypePanelDeps } = tmApi;
    const panelDeps = getTypePanelDeps(consoleId, projectIndex);
    panel.onNewError(wrapper, projectIndex, panelDeps);
  }
}

module.exports = {
  getConsoleConfig,
  showErrorOverlay,
  hideErrorOverlay,
  onConsoleError,
  buildDebugPrompt
};
