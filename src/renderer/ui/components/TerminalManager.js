/**
 * TerminalManager Component
 * Handles terminal creation, rendering and management
 */

const { ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const {
  terminalsState,
  addTerminal,
  updateTerminal,
  removeTerminal,
  setActiveTerminal: setActiveTerminalState,
  getTerminal,
  getActiveTerminal,
  projectsState,
  getProjectIndex,
  getFivemServer,
  addFivemLog,
  dismissLastError,
  getFivemErrors,
  clearFivemErrors,
  getSetting
} = require('../../state');
const { escapeHtml } = require('../../utils');
const {
  CLAUDE_TERMINAL_THEME,
  FIVEM_TERMINAL_THEME,
  TERMINAL_FONTS
} = require('../themes/terminal-themes');

// Store FiveM console IDs by project index
const fivemConsoleIds = new Map();

// Track error overlays by projectIndex
const errorOverlays = new Map();

// Anti-spam for paste (Ctrl+Shift+V)
let lastPasteTime = 0;
const PASTE_DEBOUNCE_MS = 500;

// Anti-spam for Ctrl+Arrow navigation
let lastArrowTime = 0;
const ARROW_DEBOUNCE_MS = 100;

// Drag & drop state for tab reordering
let draggedTab = null;
let dragPlaceholder = null;

/**
 * Create a custom key event handler for terminal shortcuts
 * @param {Terminal} terminal - The xterm.js terminal instance
 * @param {string|number} terminalId - Terminal ID for IPC
 * @param {string} inputChannel - IPC channel for input (default: 'terminal-input')
 * @returns {Function} Key event handler
 */
function createTerminalKeyHandler(terminal, terminalId, inputChannel = 'terminal-input') {
  return (e) => {
    // Ctrl+Arrow to switch terminals/projects - handle directly with debounce
    // xterm.js can trigger the handler multiple times, so we debounce
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.repeat && e.type === 'keydown') {
      const isArrowKey = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key);
      if (isArrowKey) {
        const now = Date.now();
        if (now - lastArrowTime < ARROW_DEBOUNCE_MS) {
          return false;
        }
        lastArrowTime = now;

        if (e.key === 'ArrowLeft' && callbacks.onSwitchTerminal) {
          callbacks.onSwitchTerminal('left');
          return false;
        }
        if (e.key === 'ArrowRight' && callbacks.onSwitchTerminal) {
          callbacks.onSwitchTerminal('right');
          return false;
        }
        if (e.key === 'ArrowUp' && callbacks.onSwitchProject) {
          callbacks.onSwitchProject('up');
          return false;
        }
        if (e.key === 'ArrowDown' && callbacks.onSwitchProject) {
          callbacks.onSwitchProject('down');
          return false;
        }
      }
    }
    // Ctrl+W to close terminal - let it bubble to global handler
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'w' && e.type === 'keydown') {
      return false;
    }
    // Ctrl+, to open settings - let it bubble to global handler
    if (e.ctrlKey && !e.shiftKey && e.key === ',' && e.type === 'keydown') {
      return false;
    }
    // Ctrl+Shift+T: New terminal - let it bubble to global handler
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't' && e.type === 'keydown') {
      return false;
    }
    // Ctrl+Shift+E: Sessions panel - let it bubble to global handler
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'e' && e.type === 'keydown') {
      return false;
    }
    // Ctrl+Shift+P: Quick picker - let it bubble to global handler
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p' && e.type === 'keydown') {
      return false;
    }
    // Ctrl+Shift+C to copy selection
    if (e.ctrlKey && e.shiftKey && e.key === 'C' && e.type === 'keydown') {
      const selection = terminal.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection);
      }
      return false;
    }
    // Ctrl+Shift+V to paste (with anti-spam)
    if (e.ctrlKey && e.shiftKey && e.key === 'V' && e.type === 'keydown') {
      const now = Date.now();
      if (now - lastPasteTime < PASTE_DEBOUNCE_MS) {
        return false;
      }
      lastPasteTime = now;
      navigator.clipboard.readText().then(text => {
        if (text) {
          ipcRenderer.send(inputChannel, { id: terminalId, data: text });
        }
      });
      return false;
    }
    // Let xterm handle other keys
    return true;
  };
}

// Callbacks
let callbacks = {
  onNotification: null,
  onRenderProjects: null,
  onCreateTerminal: null,
  onSwitchTerminal: null,  // (direction: 'left'|'right') => void
  onSwitchProject: null    // (direction: 'up'|'down') => void
};

// Title extraction
const TITLE_STOP_WORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'a', 'a', 'en', 'dans', 'sur', 'pour', 'par', 'avec',
  'the', 'a', 'an', 'and', 'or', 'in', 'on', 'for', 'with', 'to', 'of', 'is', 'are', 'it', 'this', 'that',
  'me', 'moi', 'mon', 'ma', 'mes', 'ce', 'cette', 'ces', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles',
  'can', 'you', 'please', 'help', 'want', 'need', 'like', 'would', 'could', 'should',
  'peux', 'veux', 'fais', 'fait', 'faire', 'est', 'sont', 'ai', 'as', 'avez', 'ont'
]);

/**
 * Set callbacks
 */
function setCallbacks(cbs) {
  Object.assign(callbacks, cbs);
}

/**
 * Setup drag & drop handlers for a terminal tab
 * @param {HTMLElement} tab - The tab element
 */
function setupTabDragDrop(tab) {
  tab.draggable = true;

  tab.addEventListener('dragstart', (e) => {
    draggedTab = tab;
    tab.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tab.dataset.id);

    // Create placeholder
    dragPlaceholder = document.createElement('div');
    dragPlaceholder.className = 'terminal-tab-placeholder';
  });

  tab.addEventListener('dragend', () => {
    tab.classList.remove('dragging');
    draggedTab = null;
    if (dragPlaceholder && dragPlaceholder.parentNode) {
      dragPlaceholder.remove();
    }
    dragPlaceholder = null;
    // Remove all drag-over states
    document.querySelectorAll('.terminal-tab.drag-over-left, .terminal-tab.drag-over-right').forEach(t => {
      t.classList.remove('drag-over-left', 'drag-over-right');
    });
  });

  tab.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (!draggedTab || draggedTab === tab) return;

    const rect = tab.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const isLeft = e.clientX < midX;

    // Clear previous states
    tab.classList.remove('drag-over-left', 'drag-over-right');
    tab.classList.add(isLeft ? 'drag-over-left' : 'drag-over-right');
  });

  tab.addEventListener('dragleave', () => {
    tab.classList.remove('drag-over-left', 'drag-over-right');
  });

  tab.addEventListener('drop', (e) => {
    e.preventDefault();
    tab.classList.remove('drag-over-left', 'drag-over-right');

    if (!draggedTab || draggedTab === tab) return;

    const tabsContainer = document.getElementById('terminals-tabs');
    const rect = tab.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const insertBefore = e.clientX < midX;

    if (insertBefore) {
      tabsContainer.insertBefore(draggedTab, tab);
    } else {
      tabsContainer.insertBefore(draggedTab, tab.nextSibling);
    }
  });
}

/**
 * Extract title from user input - takes significant words to create a meaningful tab name
 */
function extractTitleFromInput(input) {
  let text = input.trim();
  if (text.startsWith('/') || text.length < 5) return null;
  const words = text.toLowerCase().replace(/[^\w\sàâäéèêëïîôùûüç-]/g, ' ').split(/\s+/)
    .filter(word => word.length > 2 && !TITLE_STOP_WORDS.has(word));
  if (words.length === 0) return null;
  // Take up to 4 significant words for a more descriptive title
  const titleWords = words.slice(0, 4).map(w => w.charAt(0).toUpperCase() + w.slice(1));
  return titleWords.join(' ');
}

/**
 * Update terminal tab name
 */
function updateTerminalTabName(id, name) {
  const termData = getTerminal(id);
  if (!termData) return;

  // Update state
  updateTerminal(id, { name });

  // Update DOM
  const tab = document.querySelector(`.terminal-tab[data-id="${id}"]`);
  if (tab) {
    const nameSpan = tab.querySelector('.tab-name');
    if (nameSpan) {
      nameSpan.textContent = name;
    }
  }
}

/**
 * Update terminal status
 */
function updateTerminalStatus(id, status) {
  const termData = getTerminal(id);
  if (termData && termData.status !== status) {
    const previousStatus = termData.status;
    updateTerminal(id, { status });
    const tab = document.querySelector(`.terminal-tab[data-id="${id}"]`);
    if (tab) {
      tab.classList.remove('status-working', 'status-ready');
      tab.classList.add(`status-${status}`);
    }
    if (status === 'ready' && previousStatus === 'working') {
      if (callbacks.onNotification) {
        callbacks.onNotification(`✅ ${termData.name}`, 'Claude attend votre reponse', id);
      }
    }
  }
}

/**
 * Start renaming a tab
 */
function startRenameTab(id) {
  const tab = document.querySelector(`.terminal-tab[data-id="${id}"]`);
  const nameSpan = tab.querySelector('.tab-name');
  const termData = getTerminal(id);
  const currentName = termData.name;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tab-name-input';
  input.value = currentName;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  const finishRename = () => {
    const newName = input.value.trim() || currentName;
    updateTerminal(id, { name: newName });
    const newSpan = document.createElement('span');
    newSpan.className = 'tab-name';
    newSpan.textContent = newName;
    newSpan.ondblclick = (e) => { e.stopPropagation(); startRenameTab(id); };
    input.replaceWith(newSpan);
  };

  input.onblur = finishRename;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = currentName; input.blur(); }
  };
}

/**
 * Set active terminal
 */
function setActiveTerminal(id) {
  setActiveTerminalState(id);
  document.querySelectorAll('.terminal-tab').forEach(t => t.classList.toggle('active', t.dataset.id == id));
  document.querySelectorAll('.terminal-wrapper').forEach(w => w.classList.toggle('active', w.dataset.id == id));
  const termData = getTerminal(id);
  if (termData) {
    termData.fitAddon.fit();
    termData.terminal.focus();
  }
}

/**
 * Clean up terminal resources (IPC handlers, observers)
 * @param {Object} termData - Terminal data object
 */
function cleanupTerminalResources(termData) {
  if (!termData) return;

  // Remove IPC listeners
  if (termData.handlers) {
    if (termData.handlers.dataHandler) {
      ipcRenderer.removeListener('terminal-data', termData.handlers.dataHandler);
    }
    if (termData.handlers.exitHandler) {
      ipcRenderer.removeListener('terminal-exit', termData.handlers.exitHandler);
    }
  }

  // Disconnect ResizeObserver
  if (termData.resizeObserver) {
    termData.resizeObserver.disconnect();
  }

  // Dispose terminal
  if (termData.terminal) {
    termData.terminal.dispose();
  }
}

/**
 * Close terminal
 */
function closeTerminal(id) {
  // Get terminal info before closing
  const termData = getTerminal(id);
  const closedProjectIndex = termData?.projectIndex;
  const closedProjectPath = termData?.project?.path;

  // Kill and cleanup
  ipcRenderer.send('terminal-kill', { id });
  cleanupTerminalResources(termData);
  removeTerminal(id);
  document.querySelector(`.terminal-tab[data-id="${id}"]`)?.remove();
  document.querySelector(`.terminal-wrapper[data-id="${id}"]`)?.remove();

  // Find another terminal from the same project
  let sameProjectTerminalId = null;
  if (closedProjectPath) {
    const terminals = terminalsState.get().terminals;
    terminals.forEach((td, termId) => {
      if (!sameProjectTerminalId && td.project?.path === closedProjectPath) {
        sameProjectTerminalId = termId;
      }
    });
  }

  if (sameProjectTerminalId) {
    // Switch to another terminal of the same project
    setActiveTerminal(sameProjectTerminalId);
    const selectedFilter = projectsState.get().selectedProjectFilter;
    filterByProject(selectedFilter);
  } else if (closedProjectIndex !== null && closedProjectIndex !== undefined) {
    // No more terminals for this project - stay on project filter to show sessions panel
    projectsState.setProp('selectedProjectFilter', closedProjectIndex);
    filterByProject(closedProjectIndex);
  } else {
    // Fallback
    const selectedFilter = projectsState.get().selectedProjectFilter;
    filterByProject(selectedFilter);
  }

  if (callbacks.onRenderProjects) callbacks.onRenderProjects();
}

/**
 * Create a new terminal for a project
 */
async function createTerminal(project, options = {}) {
  const { skipPermissions = false, runClaude = true } = options;

  const result = await ipcRenderer.invoke('terminal-create', {
    cwd: project.path,
    runClaude,
    skipPermissions
  });

  // Handle new response format { success, id, error }
  if (result && typeof result === 'object' && 'success' in result) {
    if (!result.success) {
      console.error('Failed to create terminal:', result.error);
      if (callbacks.onNotification) {
        callbacks.onNotification('❌ Erreur', result.error || 'Impossible de créer le terminal', null);
      }
      return null;
    }
    var id = result.id;
  } else {
    // Backwards compatibility with old format (just id)
    var id = result;
  }

  const terminal = new Terminal({
    theme: CLAUDE_TERMINAL_THEME,
    fontFamily: TERMINAL_FONTS.claude.fontFamily,
    fontSize: TERMINAL_FONTS.claude.fontSize,
    cursorBlink: true
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const projectIndex = getProjectIndex(project.id);
  const isBasicTerminal = !runClaude;
  const termData = {
    terminal,
    fitAddon,
    project,
    projectIndex,
    name: project.name,
    status: 'ready',
    inputBuffer: '',
    isBasic: isBasicTerminal
  };

  addTerminal(id, termData);

  // Create tab
  const tabsContainer = document.getElementById('terminals-tabs');
  const tab = document.createElement('div');
  tab.className = `terminal-tab status-ready${isBasicTerminal ? ' basic-terminal' : ''}`;
  tab.dataset.id = id;
  tab.innerHTML = `
    <span class="status-dot"></span>
    <span class="tab-name">${escapeHtml(project.name)}</span>
    <button class="tab-close"><svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></button>`;
  tabsContainer.appendChild(tab);

  // Create wrapper
  const container = document.getElementById('terminals-container');
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.dataset.id = id;
  container.appendChild(wrapper);

  document.getElementById('empty-terminals').style.display = 'none';

  terminal.open(wrapper);
  setTimeout(() => fitAddon.fit(), 100);
  setActiveTerminal(id);

  // Custom key handler for global shortcuts and copy/paste
  terminal.attachCustomKeyEventHandler(createTerminalKeyHandler(terminal, id, 'terminal-input'));

  // Title change handling
  let lastTitle = '';
  terminal.onTitleChange(title => {
    if (title === lastTitle) return;
    lastTitle = title;
    const spinnerChars = /[⠂⠄⠆⠇⠋⠙⠹⠸⠼⠴⠦⠧⠏]/;
    if (title.includes('✳')) updateTerminalStatus(id, 'ready');
    else if (spinnerChars.test(title)) updateTerminalStatus(id, 'working');
  });

  // IPC data handling
  const dataHandler = (event, data) => {
    if (data.id === id) terminal.write(data.data);
  };
  const exitHandler = (event, data) => {
    if (data.id === id) closeTerminal(id);
  };
  ipcRenderer.on('terminal-data', dataHandler);
  ipcRenderer.on('terminal-exit', exitHandler);

  // Store handlers for cleanup
  const storedTermData = getTerminal(id);
  if (storedTermData) {
    storedTermData.handlers = { dataHandler, exitHandler };
  }

  // Input handling
  terminal.onData(data => {
    ipcRenderer.send('terminal-input', { id, data });
    const td = getTerminal(id);
    if (data === '\r' || data === '\n') {
      updateTerminalStatus(id, 'working');
      if (td && td.inputBuffer.trim().length > 0) {
        const title = extractTitleFromInput(td.inputBuffer);
        if (title) {
          // Update terminal tab name instead of window title
          updateTerminalTabName(id, title);
        }
        updateTerminal(id, { inputBuffer: '' });
      }
    } else if (data === '\x7f' || data === '\b') {
      if (td) updateTerminal(id, { inputBuffer: td.inputBuffer.slice(0, -1) });
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      if (td) updateTerminal(id, { inputBuffer: td.inputBuffer + data });
    }
  });

  // Resize handling
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    ipcRenderer.send('terminal-resize', { id, cols: terminal.cols, rows: terminal.rows });
  });
  resizeObserver.observe(wrapper);

  // Store ResizeObserver for cleanup
  if (storedTermData) {
    storedTermData.resizeObserver = resizeObserver;
  }

  // Filter and render
  const selectedFilter = projectsState.get().selectedProjectFilter;
  filterByProject(selectedFilter);
  if (callbacks.onRenderProjects) callbacks.onRenderProjects();

  // Tab events
  tab.onclick = (e) => { if (!e.target.closest('.tab-close') && !e.target.closest('.tab-name-input')) setActiveTerminal(id); };
  tab.querySelector('.tab-name').ondblclick = (e) => { e.stopPropagation(); startRenameTab(id); };
  tab.querySelector('.tab-close').onclick = (e) => { e.stopPropagation(); closeTerminal(id); };

  // Enable drag & drop reordering
  setupTabDragDrop(tab);

  return id;
}

/**
 * Create a FiveM console as a terminal tab
 */
function createFivemConsole(project, projectIndex, options = {}) {
  // Check if console already exists for this project
  const existingId = fivemConsoleIds.get(projectIndex);
  if (existingId && getTerminal(existingId)) {
    setActiveTerminal(existingId);
    return existingId;
  }

  const id = `fivem-${projectIndex}-${Date.now()}`;

  const terminal = new Terminal({
    theme: FIVEM_TERMINAL_THEME,
    fontFamily: TERMINAL_FONTS.fivem.fontFamily,
    fontSize: TERMINAL_FONTS.fivem.fontSize,
    cursorBlink: false,
    disableStdin: false,
    scrollback: 10000
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const termData = {
    terminal,
    fitAddon,
    project,
    projectIndex,
    name: `🖥️ ${project.name}`,
    status: 'ready',
    type: 'fivem',
    inputBuffer: '',
    activeView: 'console' // 'console' or 'errors'
  };

  addTerminal(id, termData);
  fivemConsoleIds.set(projectIndex, id);

  // Create tab
  const tabsContainer = document.getElementById('terminals-tabs');
  const tab = document.createElement('div');
  tab.className = 'terminal-tab fivem-tab status-ready';
  tab.dataset.id = id;
  tab.innerHTML = `
    <span class="status-dot fivem-dot"></span>
    <span class="tab-name">${escapeHtml(`🖥️ ${project.name}`)}</span>
    <button class="tab-close"><svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></button>`;
  tabsContainer.appendChild(tab);

  // Create wrapper with internal tabs
  const container = document.getElementById('terminals-container');
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper fivem-wrapper';
  wrapper.dataset.id = id;

  // Add internal view switcher
  wrapper.innerHTML = `
    <div class="fivem-view-switcher">
      <button class="fivem-view-tab active" data-view="console">
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
        Console
      </button>
      <button class="fivem-view-tab" data-view="errors">
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        Erreurs
        <span class="fivem-error-badge" style="display: none;">0</span>
      </button>
    </div>
    <div class="fivem-view-content">
      <div class="fivem-console-view"></div>
      <div class="fivem-errors-view" style="display: none;">
        <div class="fivem-errors-header">
          <span>Erreurs detectees</span>
          <button class="fivem-clear-errors" title="Effacer les erreurs">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
        <div class="fivem-errors-list"></div>
        <div class="fivem-errors-empty">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
          <span>Aucune erreur detectee</span>
        </div>
      </div>
    </div>
  `;

  container.appendChild(wrapper);

  document.getElementById('empty-terminals').style.display = 'none';

  // Open terminal in console view container
  const consoleView = wrapper.querySelector('.fivem-console-view');
  terminal.open(consoleView);
  setTimeout(() => fitAddon.fit(), 100);
  setActiveTerminal(id);

  // Write existing logs
  const server = getFivemServer(projectIndex);
  if (server && server.logs && server.logs.length > 0) {
    terminal.write(server.logs.join(''));
  }

  // Setup view switcher
  setupFivemViewSwitcher(wrapper, id, projectIndex, project);

  // Update error badge with existing errors
  updateFivemErrorBadge(wrapper, projectIndex);

  // Custom key handler for global shortcuts and copy/paste
  terminal.attachCustomKeyEventHandler(createTerminalKeyHandler(terminal, projectIndex, 'fivem-input'));

  // Handle input to FiveM console
  terminal.onData(data => {
    ipcRenderer.send('fivem-input', { projectIndex, data });
  });

  // Resize handling
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    ipcRenderer.send('fivem-resize', {
      projectIndex,
      cols: terminal.cols,
      rows: terminal.rows
    });
  });
  resizeObserver.observe(consoleView);

  // Store ResizeObserver for cleanup
  const storedFivemTermData = getTerminal(id);
  if (storedFivemTermData) {
    storedFivemTermData.resizeObserver = resizeObserver;
  }

  // Send initial size
  ipcRenderer.send('fivem-resize', {
    projectIndex,
    cols: terminal.cols,
    rows: terminal.rows
  });

  // Filter and render
  const selectedFilter = projectsState.get().selectedProjectFilter;
  filterByProject(selectedFilter);
  if (callbacks.onRenderProjects) callbacks.onRenderProjects();

  // Tab events
  tab.onclick = (e) => { if (!e.target.closest('.tab-close') && !e.target.closest('.tab-name-input')) setActiveTerminal(id); };
  tab.querySelector('.tab-name').ondblclick = (e) => { e.stopPropagation(); startRenameTab(id); };
  tab.querySelector('.tab-close').onclick = (e) => { e.stopPropagation(); closeFivemConsole(id, projectIndex); };

  // Enable drag & drop reordering
  setupTabDragDrop(tab);

  return id;
}

/**
 * Setup FiveM view switcher (Console / Errors)
 */
function setupFivemViewSwitcher(wrapper, terminalId, projectIndex, project) {
  const viewTabs = wrapper.querySelectorAll('.fivem-view-tab');
  const consoleView = wrapper.querySelector('.fivem-console-view');
  const errorsView = wrapper.querySelector('.fivem-errors-view');
  const clearBtn = wrapper.querySelector('.fivem-clear-errors');

  viewTabs.forEach(tab => {
    tab.onclick = () => {
      const view = tab.dataset.view;
      viewTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      if (view === 'console') {
        consoleView.style.display = '';
        errorsView.style.display = 'none';
        // Refit terminal
        const termData = getTerminal(terminalId);
        if (termData) {
          setTimeout(() => termData.fitAddon.fit(), 50);
        }
      } else {
        consoleView.style.display = 'none';
        errorsView.style.display = '';
        renderFivemErrorsList(wrapper, projectIndex, project);
      }

      // Update state
      const termData = getTerminal(terminalId);
      if (termData) {
        termData.activeView = view;
      }
    };
  });

  // Clear errors button
  clearBtn.onclick = () => {
    clearFivemErrors(projectIndex);
    updateFivemErrorBadge(wrapper, projectIndex);
    renderFivemErrorsList(wrapper, projectIndex, project);
  };
}

/**
 * Update FiveM error badge count
 */
function updateFivemErrorBadge(wrapper, projectIndex) {
  const badge = wrapper.querySelector('.fivem-error-badge');
  if (!badge) return;

  const { errors } = getFivemErrors(projectIndex);
  const count = errors.length;

  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

/**
 * Render FiveM errors list
 */
function renderFivemErrorsList(wrapper, projectIndex, project) {
  const list = wrapper.querySelector('.fivem-errors-list');
  const empty = wrapper.querySelector('.fivem-errors-empty');
  const { errors } = getFivemErrors(projectIndex);

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
          <button class="fivem-error-debug-btn" data-index="${index}" title="Debugger avec Claude">
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
  }).reverse().join(''); // Most recent first

  // Add click handlers
  list.querySelectorAll('.fivem-error-item').forEach(item => {
    const detail = item.querySelector('.fivem-error-detail');
    const preview = item.querySelector('.fivem-error-preview');

    // Toggle detail on click
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
      if (error && project) {
        const prompt = buildDebugPrompt(error);
        await createTerminalWithPrompt(project, prompt);
      }
    };
  });
}

/**
 * Add error to FiveM console and update UI
 */
function addFivemErrorToConsole(projectIndex, error) {
  const consoleId = fivemConsoleIds.get(projectIndex);
  if (!consoleId) return;

  const wrapper = document.querySelector(`.terminal-wrapper[data-id="${consoleId}"]`);
  if (!wrapper) return;

  // Update badge
  updateFivemErrorBadge(wrapper, projectIndex);

  // If errors view is active, refresh the list
  const termData = getTerminal(consoleId);
  if (termData && termData.activeView === 'errors') {
    renderFivemErrorsList(wrapper, projectIndex, termData.project);
  }

  // Flash the errors tab to indicate new error
  const errorsTab = wrapper.querySelector('.fivem-view-tab[data-view="errors"]');
  if (errorsTab && termData?.activeView !== 'errors') {
    errorsTab.classList.add('has-new-error');
    setTimeout(() => errorsTab.classList.remove('has-new-error'), 2000);
  }
}

/**
 * Close FiveM console
 */
function closeFivemConsole(id, projectIndex) {
  const termData = getTerminal(id);
  const closedProjectPath = termData?.project?.path;

  // Cleanup resources (ResizeObserver, terminal)
  cleanupTerminalResources(termData);
  removeTerminal(id);
  fivemConsoleIds.delete(projectIndex);
  document.querySelector(`.terminal-tab[data-id="${id}"]`)?.remove();
  document.querySelector(`.terminal-wrapper[data-id="${id}"]`)?.remove();

  // Find another terminal from the same project
  let sameProjectTerminalId = null;
  if (closedProjectPath) {
    const terminals = terminalsState.get().terminals;
    terminals.forEach((td, termId) => {
      if (!sameProjectTerminalId && td.project?.path === closedProjectPath) {
        sameProjectTerminalId = termId;
      }
    });
  }

  if (sameProjectTerminalId) {
    // Switch to another terminal of the same project
    setActiveTerminal(sameProjectTerminalId);
    const selectedFilter = projectsState.get().selectedProjectFilter;
    filterByProject(selectedFilter);
  } else if (projectIndex !== null && projectIndex !== undefined) {
    // No more terminals for this project - stay on project filter to show sessions panel
    projectsState.setProp('selectedProjectFilter', projectIndex);
    filterByProject(projectIndex);
  } else {
    const selectedFilter = projectsState.get().selectedProjectFilter;
    filterByProject(selectedFilter);
  }

  if (callbacks.onRenderProjects) callbacks.onRenderProjects();
}

/**
 * Get FiveM console terminal for a project
 */
function getFivemConsoleTerminal(projectIndex) {
  const id = fivemConsoleIds.get(projectIndex);
  if (id) {
    const termData = getTerminal(id);
    if (termData) {
      return termData.terminal;
    }
  }
  return null;
}

/**
 * Write data to FiveM console
 */
function writeFivemConsole(projectIndex, data) {
  const terminal = getFivemConsoleTerminal(projectIndex);
  if (terminal) {
    terminal.write(data);
  }
}

/**
 * Filter terminals by project
 */
function filterByProject(projectIndex) {
  const emptyState = document.getElementById('empty-terminals');
  const filterIndicator = document.getElementById('terminals-filter');
  const filterProjectName = document.getElementById('filter-project-name');
  const projects = projectsState.get().projects;

  if (projectIndex !== null && projects[projectIndex]) {
    filterIndicator.style.display = 'flex';
    filterProjectName.textContent = projects[projectIndex].name;
  } else {
    filterIndicator.style.display = 'none';
  }

  // Pre-index DOM elements once - O(n) instead of O(n²)
  const tabsById = new Map();
  const wrappersById = new Map();
  document.querySelectorAll('.terminal-tab').forEach(tab => {
    tabsById.set(tab.dataset.id, tab);
  });
  document.querySelectorAll('.terminal-wrapper').forEach(wrapper => {
    wrappersById.set(wrapper.dataset.id, wrapper);
  });

  let visibleCount = 0;
  let firstVisibleId = null;
  const project = projects[projectIndex];

  const terminals = terminalsState.get().terminals;
  terminals.forEach((termData, id) => {
    // O(1) lookup instead of O(n) querySelector
    const tab = tabsById.get(String(id));
    const wrapper = wrappersById.get(String(id));
    const shouldShow = projectIndex === null || (project && termData.project && termData.project.path === project.path);

    if (tab) tab.style.display = shouldShow ? '' : 'none';
    if (wrapper) wrapper.style.display = shouldShow ? '' : 'none';
    if (shouldShow) {
      visibleCount++;
      if (!firstVisibleId) firstVisibleId = id;
    }
  });

  if (visibleCount === 0) {
    emptyState.style.display = 'flex';
    if (projectIndex !== null) {
      const project = projects[projectIndex];
      if (project) {
        // Show sessions panel for the project
        renderSessionsPanel(project, emptyState);
      } else {
        emptyState.innerHTML = `
          <div class="sessions-empty-state">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
            <p>Aucun terminal pour ce projet</p>
            <p class="hint">Cliquez sur "Claude" pour en creer un</p>
          </div>`;
      }
    } else {
      emptyState.innerHTML = `
        <div class="sessions-empty-state">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
          <p>Selectionnez un projet et cliquez sur "Claude"</p>
          <p class="hint">Le terminal s'ouvrira ici</p>
        </div>`;
    }
    setActiveTerminalState(null);
  } else {
    emptyState.style.display = 'none';
    const activeTab = document.querySelector(`.terminal-tab[data-id="${getActiveTerminal()}"]`);
    if (!activeTab || activeTab.style.display === 'none') {
      if (firstVisibleId) setActiveTerminal(firstVisibleId);
    }
  }
}

/**
 * Count terminals for a project
 */
function countTerminalsForProject(projectIndex) {
  if (projectIndex === null || projectIndex === undefined) return 0;
  const projects = projectsState.get().projects;
  const project = projects[projectIndex];
  if (!project) return 0;
  let count = 0;
  const terminals = terminalsState.get().terminals;
  terminals.forEach(termData => {
    if (termData.project && termData.project.path === project.path) count++;
  });
  return count;
}

/**
 * Show all terminals (remove filter)
 */
function showAll() {
  filterByProject(null);
}

/**
 * Format relative time
 */
function formatRelativeTime(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "a l'instant";
  if (diffMins < 60) return `il y a ${diffMins}min`;
  if (diffHours < 24) return `il y a ${diffHours}h`;
  if (diffDays < 7) return `il y a ${diffDays}j`;
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

/**
 * Truncate text with ellipsis
 */
function truncateText(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

/**
 * Render sessions panel in empty state
 */
async function renderSessionsPanel(project, emptyState) {
  try {
    const sessions = await ipcRenderer.invoke('claude-sessions', project.path);

    if (!sessions || sessions.length === 0) {
      emptyState.innerHTML = `
        <div class="sessions-empty-state">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
          <p>Aucun terminal pour "${escapeHtml(project.name)}"</p>
          <p class="hint">Cliquez sur "Claude" pour en creer un</p>
        </div>`;
      return;
    }

    const sessionsHtml = sessions.map(session => `
      <div class="session-card" data-session-id="${session.sessionId}">
        <div class="session-header">
          <span class="session-icon">💬</span>
          <span class="session-title">${escapeHtml(truncateText(session.summary, 50))}</span>
        </div>
        <div class="session-prompt">${escapeHtml(truncateText(session.firstPrompt, 80))}</div>
        <div class="session-meta">
          <span class="session-messages">${session.messageCount} msgs</span>
          <span class="session-time">${formatRelativeTime(session.modified)}</span>
          ${session.gitBranch ? `<span class="session-branch">${escapeHtml(session.gitBranch)}</span>` : ''}
        </div>
      </div>
    `).join('');

    emptyState.innerHTML = `
      <div class="sessions-panel">
        <div class="sessions-header">
          <span class="sessions-title">Reprendre une conversation</span>
          <button class="sessions-new-btn" title="Nouvelle conversation">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            Nouveau
          </button>
        </div>
        <div class="sessions-list">
          ${sessionsHtml}
        </div>
      </div>`;

    // Add click handlers
    emptyState.querySelectorAll('.session-card').forEach(card => {
      card.onclick = () => {
        const sessionId = card.dataset.sessionId;
        const skipPermissions = getSetting('skipPermissions') || false;
        resumeSession(project, sessionId, { skipPermissions });
      };
    });

    // New conversation button
    emptyState.querySelector('.sessions-new-btn').onclick = () => {
      if (callbacks.onCreateTerminal) {
        callbacks.onCreateTerminal(project);
      }
    };

  } catch (error) {
    console.error('Error rendering sessions:', error);
    emptyState.innerHTML = `
      <div class="sessions-empty-state">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
        <p>Aucun terminal pour "${escapeHtml(project.name)}"</p>
        <p class="hint">Cliquez sur "Claude" pour en creer un</p>
      </div>`;
  }
}

/**
 * Resume a Claude session
 */
async function resumeSession(project, sessionId, options = {}) {
  const { skipPermissions = false } = options;
  const result = await ipcRenderer.invoke('terminal-create', {
    cwd: project.path,
    runClaude: true,
    resumeSessionId: sessionId,
    skipPermissions
  });

  // Handle new response format { success, id, error }
  if (result && typeof result === 'object' && 'success' in result) {
    if (!result.success) {
      console.error('Failed to resume session:', result.error);
      if (callbacks.onNotification) {
        callbacks.onNotification('❌ Erreur', result.error || 'Impossible de reprendre la session', null);
      }
      return null;
    }
    var id = result.id;
  } else {
    // Backwards compatibility with old format (just id)
    var id = result;
  }

  const terminal = new Terminal({
    theme: CLAUDE_TERMINAL_THEME,
    fontFamily: TERMINAL_FONTS.claude.fontFamily,
    fontSize: TERMINAL_FONTS.claude.fontSize,
    cursorBlink: true
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const projectIndex = getProjectIndex(project.id);
  const termData = {
    terminal,
    fitAddon,
    project,
    projectIndex,
    name: 'Reprise...',
    status: 'working',
    inputBuffer: '',
    isBasic: false
  };

  addTerminal(id, termData);

  // Create tab
  const tabsContainer = document.getElementById('terminals-tabs');
  const tab = document.createElement('div');
  tab.className = 'terminal-tab status-working';
  tab.dataset.id = id;
  tab.innerHTML = `
    <span class="status-dot"></span>
    <span class="tab-name">${escapeHtml('Reprise...')}</span>
    <button class="tab-close"><svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></button>`;
  tabsContainer.appendChild(tab);

  // Create wrapper
  const container = document.getElementById('terminals-container');
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.dataset.id = id;
  container.appendChild(wrapper);

  document.getElementById('empty-terminals').style.display = 'none';

  terminal.open(wrapper);
  setTimeout(() => fitAddon.fit(), 100);
  setActiveTerminal(id);

  // Custom key handler for global shortcuts and copy/paste
  terminal.attachCustomKeyEventHandler(createTerminalKeyHandler(terminal, id, 'terminal-input'));

  // Title change handling
  let lastTitle = '';
  terminal.onTitleChange(title => {
    if (title === lastTitle) return;
    lastTitle = title;
    const spinnerChars = /[⠂⠄⠆⠇⠋⠙⠹⠸⠼⠴⠦⠧⠏]/;
    if (title.includes('✳')) updateTerminalStatus(id, 'ready');
    else if (spinnerChars.test(title)) updateTerminalStatus(id, 'working');
  });

  // IPC handlers
  const dataHandler = (event, data) => {
    if (data.id === id) terminal.write(data.data);
  };
  const exitHandler = (event, data) => {
    if (data.id === id) closeTerminal(id);
  };
  ipcRenderer.on('terminal-data', dataHandler);
  ipcRenderer.on('terminal-exit', exitHandler);

  // Store handlers for cleanup
  const storedResumeTermData = getTerminal(id);
  if (storedResumeTermData) {
    storedResumeTermData.handlers = { dataHandler, exitHandler };
  }

  // Input handling
  terminal.onData(data => {
    ipcRenderer.send('terminal-input', { id, data });
    const td = getTerminal(id);
    if (data === '\r' || data === '\n') {
      updateTerminalStatus(id, 'working');
      if (td && td.inputBuffer.trim().length > 0) {
        const title = extractTitleFromInput(td.inputBuffer);
        if (title) updateTerminalTabName(id, title);
        updateTerminal(id, { inputBuffer: '' });
      }
    } else if (data === '\x7f' || data === '\b') {
      if (td) updateTerminal(id, { inputBuffer: td.inputBuffer.slice(0, -1) });
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      if (td) updateTerminal(id, { inputBuffer: td.inputBuffer + data });
    }
  });

  // Resize handling
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    ipcRenderer.send('terminal-resize', { id, cols: terminal.cols, rows: terminal.rows });
  });
  resizeObserver.observe(wrapper);

  // Store ResizeObserver for cleanup
  if (storedResumeTermData) {
    storedResumeTermData.resizeObserver = resizeObserver;
  }

  // Filter and render
  const selectedFilter = projectsState.get().selectedProjectFilter;
  filterByProject(selectedFilter);
  if (callbacks.onRenderProjects) callbacks.onRenderProjects();

  // Tab events
  tab.onclick = (e) => { if (!e.target.closest('.tab-close') && !e.target.closest('.tab-name-input')) setActiveTerminal(id); };
  tab.querySelector('.tab-name').ondblclick = (e) => { e.stopPropagation(); startRenameTab(id); };
  tab.querySelector('.tab-close').onclick = (e) => { e.stopPropagation(); closeTerminal(id); };

  // Enable drag & drop reordering
  setupTabDragDrop(tab);

  return id;
}

/**
 * Show FiveM error overlay with debug button
 * @param {number} projectIndex
 * @param {Object} error - Error object { timestamp, message, context }
 */
function showFivemErrorOverlay(projectIndex, error) {
  const consoleId = fivemConsoleIds.get(projectIndex);
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
      <span class="fivem-error-text">Erreur detectee</span>
      <button class="fivem-debug-btn" title="Debugger avec Claude">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        Debug avec Claude
      </button>
      <button class="fivem-error-dismiss" title="Fermer">
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

    // Create the debug prompt
    const prompt = buildDebugPrompt(error);

    // Create a new Claude terminal
    const terminalId = await createTerminalWithPrompt(project, prompt);

    // Hide the overlay after opening
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
 * Build debug prompt from error
 * @param {Object} error
 * @returns {string}
 */
function buildDebugPrompt(error) {
  let prompt = `J'ai cette erreur FiveM/Lua, aide-moi a la resoudre :\n\n`;
  prompt += '```\n';
  prompt += error.message;
  prompt += '\n```\n';

  if (error.context && error.context !== error.message) {
    prompt += `\nContexte (logs precedents) :\n`;
    prompt += '```\n';
    prompt += error.context;
    prompt += '\n```';
  }

  return prompt;
}

/**
 * Hide error overlay for a project
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
 * Create a terminal with a pre-filled prompt
 * @param {Object} project
 * @param {string} prompt - The prompt to send after terminal is ready
 * @returns {Promise<string>} Terminal ID
 */
async function createTerminalWithPrompt(project, prompt) {
  const result = await ipcRenderer.invoke('terminal-create', {
    cwd: project.path,
    runClaude: true,
    skipPermissions: false
  });

  if (result && typeof result === 'object' && 'success' in result) {
    if (!result.success) {
      console.error('Failed to create terminal:', result.error);
      return null;
    }
    var id = result.id;
  } else {
    var id = result;
  }

  const terminal = new Terminal({
    theme: CLAUDE_TERMINAL_THEME,
    fontFamily: TERMINAL_FONTS.claude.fontFamily,
    fontSize: TERMINAL_FONTS.claude.fontSize,
    cursorBlink: true
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const projectIndex = getProjectIndex(project.id);
  const termData = {
    terminal,
    fitAddon,
    project,
    projectIndex,
    name: '🐛 Debug',
    status: 'working',
    inputBuffer: '',
    isBasic: false,
    pendingPrompt: prompt // Store the prompt to send when ready
  };

  addTerminal(id, termData);

  // Create tab
  const tabsContainer = document.getElementById('terminals-tabs');
  const tab = document.createElement('div');
  tab.className = 'terminal-tab status-working';
  tab.dataset.id = id;
  tab.innerHTML = `
    <span class="status-dot"></span>
    <span class="tab-name">${escapeHtml('🐛 Debug')}</span>
    <button class="tab-close"><svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></button>`;
  tabsContainer.appendChild(tab);

  // Create wrapper
  const container = document.getElementById('terminals-container');
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.dataset.id = id;
  container.appendChild(wrapper);

  document.getElementById('empty-terminals').style.display = 'none';

  terminal.open(wrapper);
  setTimeout(() => fitAddon.fit(), 100);
  setActiveTerminal(id);

  // Custom key handler
  terminal.attachCustomKeyEventHandler(createTerminalKeyHandler(terminal, id, 'terminal-input'));

  // Title change handling - detect when Claude is ready
  let lastTitle = '';
  let promptSent = false;
  terminal.onTitleChange(title => {
    if (title === lastTitle) return;
    lastTitle = title;
    const spinnerChars = /[⠂⠄⠆⠇⠋⠙⠹⠸⠼⠴⠦⠧⠏]/;
    if (title.includes('✳')) {
      updateTerminalStatus(id, 'ready');
      // Send the pending prompt when Claude is ready
      const td = getTerminal(id);
      if (td && td.pendingPrompt && !promptSent) {
        promptSent = true;
        setTimeout(() => {
          ipcRenderer.send('terminal-input', { id, data: td.pendingPrompt + '\r' });
          updateTerminal(id, { pendingPrompt: null });
          updateTerminalStatus(id, 'working');
        }, 500);
      }
    } else if (spinnerChars.test(title)) {
      updateTerminalStatus(id, 'working');
    }
  });

  // IPC handlers
  const dataHandler = (event, data) => {
    if (data.id === id) terminal.write(data.data);
  };
  const exitHandler = (event, data) => {
    if (data.id === id) closeTerminal(id);
  };
  ipcRenderer.on('terminal-data', dataHandler);
  ipcRenderer.on('terminal-exit', exitHandler);

  // Store handlers for cleanup
  const storedTermData = getTerminal(id);
  if (storedTermData) {
    storedTermData.handlers = { dataHandler, exitHandler };
  }

  // Input handling
  terminal.onData(data => {
    ipcRenderer.send('terminal-input', { id, data });
    const td = getTerminal(id);
    if (data === '\r' || data === '\n') {
      updateTerminalStatus(id, 'working');
      if (td && td.inputBuffer.trim().length > 0) {
        const title = extractTitleFromInput(td.inputBuffer);
        if (title) updateTerminalTabName(id, title);
        updateTerminal(id, { inputBuffer: '' });
      }
    } else if (data === '\x7f' || data === '\b') {
      if (td) updateTerminal(id, { inputBuffer: td.inputBuffer.slice(0, -1) });
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      if (td) updateTerminal(id, { inputBuffer: td.inputBuffer + data });
    }
  });

  // Resize handling
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    ipcRenderer.send('terminal-resize', { id, cols: terminal.cols, rows: terminal.rows });
  });
  resizeObserver.observe(wrapper);

  if (storedTermData) {
    storedTermData.resizeObserver = resizeObserver;
  }

  // Filter and render
  const selectedFilter = projectsState.get().selectedProjectFilter;
  filterByProject(selectedFilter);
  if (callbacks.onRenderProjects) callbacks.onRenderProjects();

  // Tab events
  tab.onclick = (e) => { if (!e.target.closest('.tab-close') && !e.target.closest('.tab-name-input')) setActiveTerminal(id); };
  tab.querySelector('.tab-name').ondblclick = (e) => { e.stopPropagation(); startRenameTab(id); };
  tab.querySelector('.tab-close').onclick = (e) => { e.stopPropagation(); closeTerminal(id); };

  // Enable drag & drop reordering
  setupTabDragDrop(tab);

  return id;
}

module.exports = {
  createTerminal,
  closeTerminal,
  setActiveTerminal,
  filterByProject,
  countTerminalsForProject,
  showAll,
  setCallbacks,
  updateTerminalStatus,
  resumeSession,
  // FiveM console functions
  createFivemConsole,
  closeFivemConsole,
  getFivemConsoleTerminal,
  writeFivemConsole,
  // FiveM error handling
  addFivemErrorToConsole,
  showFivemErrorOverlay,
  hideErrorOverlay
};
