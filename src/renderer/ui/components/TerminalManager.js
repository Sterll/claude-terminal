/**
 * TerminalManager Component
 * Handles terminal creation, rendering and management
 */

// Use preload API instead of direct ipcRenderer
const api = window.electron_api;
const { path, fs } = window.electron_nodeModules;
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebglAddon } = require('@xterm/addon-webgl');
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
  getFivemResources,
  setFivemResourcesLoading,
  setFivemResources,
  getResourceShortcut,
  setResourceShortcut,
  findResourceByShortcut,
  loadResourceShortcuts,
  getSetting,
  startTracking,
  stopTracking,
  recordActivity,
  recordOutputActivity,
  switchProject,
  hasTerminalsForProject
} = require('../../state');
const { escapeHtml, getFileIcon, highlight } = require('../../utils');
const { t, getCurrentLanguage } = require('../../i18n');
const {
  CLAUDE_TERMINAL_THEME,
  FIVEM_TERMINAL_THEME,
  TERMINAL_FONTS,
  getTerminalTheme
} = require('../themes/terminal-themes');
const registry = require('../../../project-types/registry');

// Lazy require to avoid circular dependency
let QuickActions = null;
function getQuickActions() {
  if (!QuickActions) {
    QuickActions = require('./QuickActions');
  }
  return QuickActions;
}

// Store FiveM console IDs by project index
const fivemConsoleIds = new Map();

// Store WebApp console IDs by project index
const webappConsoleIds = new Map();

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

// ── Centralized IPC dispatcher (one listener for all terminals) ──
const terminalDataHandlers = new Map();
const terminalExitHandlers = new Map();
let ipcDispatcherInitialized = false;

function initIpcDispatcher() {
  if (ipcDispatcherInitialized) return;
  ipcDispatcherInitialized = true;
  api.terminal.onData((data) => {
    lastTerminalData.set(data.id, Date.now());
    const handler = terminalDataHandlers.get(data.id);
    if (handler) handler(data);
  });
  api.terminal.onExit((data) => {
    const handler = terminalExitHandlers.get(data.id);
    if (handler) handler(data);
  });
}

function registerTerminalHandler(id, onData, onExit) {
  initIpcDispatcher();
  terminalDataHandlers.set(id, onData);
  terminalExitHandlers.set(id, onExit);
}

function unregisterTerminalHandler(id) {
  terminalDataHandlers.delete(id);
  terminalExitHandlers.delete(id);
}

// ── WebGL addon loader (GPU-accelerated rendering, falls back to DOM) ──
function loadWebglAddon(terminal) {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
    });
    terminal.loadAddon(webgl);
  } catch (e) {
    console.warn('WebGL addon failed to load, using DOM renderer:', e.message);
  }
}

// ── Output silence detection disabled ──
// Silence-based detection caused false "ready" during Claude's thinking phases
function resetOutputSilenceTimer(_id) { /* no-op */ }
function clearOutputSilenceTimer(_id) { /* no-op */ }

// ── Ready state debounce (adaptive + content-verified) ──
// Between tool calls, Claude briefly shows ✳ before starting next action.
// Debounce prevents false "ready" transitions (and notification spam).
//
// There is NO definitive "done" marker in Claude CLI's terminal output.
// The ✳ title is the only signal, and it looks the same whether transient or final.
// So we combine multiple heuristics:
//   1. Adaptive initial delay based on what Claude was doing (thinking vs tool call)
//   2. At expiry, scan terminal buffer for contextual clues
//   3. Verify terminal silence (no PTY data flowing)
//   4. If Braille reappears at ANY point → cancel everything (handled elsewhere)
const READY_DEBOUNCE_MS = 2500;
const POST_ENTER_DEBOUNCE_MS = 5000;    // After Enter keypress (echo ✳)
const POST_TOOL_DEBOUNCE_MS = 4000;     // After tool call (tools often chain)
const POST_THINKING_DEBOUNCE_MS = 1500; // After pure thinking (response likely done)
const SILENCE_THRESHOLD_MS = 1000;       // No PTY data for this long = silent
const RECHECK_DELAY_MS = 1000;           // Re-check interval when not yet sure
const readyDebounceTimers = new Map();   // terminalId -> timerId
const postEnterExtended = new Set();     // ids where Enter was pressed
const postSpinnerExtended = new Set();   // ids where spinner was seen
const terminalSubstatus = new Map();     // id -> 'thinking' | 'tool_calling'
const lastTerminalData = new Map();      // id -> timestamp of last PTY data
const terminalContext = new Map();        // id -> { taskName, lastTool, toolCount, duration }

/**
 * Scan terminal buffer for definitive completion signals.
 *
 * Claude CLI shows two distinct patterns:
 *   Working: "· Hatching… (1m 46s · ↓ 6.2k tokens)"  →  · + word + … (ellipsis)
 *   Done:    "✳ Churned for 1m 51s"                   →  ✳ + word + "for" + duration
 *
 * The "for" keyword after the random word is the 100% definitive "done" signal.
 * The "·" prefix with "…" ellipsis is the 100% definitive "still working" signal.
 *
 * @returns {{ signal: string, duration?: string } | null}
 */
function detectCompletionSignal(terminal) {
  if (!terminal?.buffer?.active) return null;
  const buf = terminal.buffer.active;
  const totalLines = buf.baseY + buf.cursorY;
  const scanLimit = Math.max(0, totalLines - 10);
  const lines = [];

  for (let i = totalLines; i >= scanLimit; i--) {
    const row = buf.getLine(i);
    if (!row) continue;
    const text = row.translateToString(true).trim();
    if (!text || BRAILLE_SPINNER_RE.test(text) || /^[✳❯>$%#\s]*$/.test(text)) continue;
    lines.push(text);
    if (lines.length >= 5) break;
  }

  if (lines.length === 0) return null;
  const block = lines.join('\n');

  // 100% DONE: "✳ Churned for 1m 51s" — only appears when response is complete
  const doneMatch = block.match(/✳\s+\S+\s+for\s+((?:\d+h\s+)?(?:\d+m\s+)?\d+s)/);
  if (doneMatch) return { signal: 'done', duration: doneMatch[1] };

  // 100% WORKING: "· Hatching… (1m 46s · ↓ 6.2k tokens)" — spinner with ellipsis
  if (/·\s+\S+…/.test(block)) return { signal: 'working' };

  // Permission prompt = Claude needs user attention now
  if (/\b(Allow|Approve|yes\/no|y\/n)\b/i.test(block)) return { signal: 'permission' };

  // Tool result marker (⎿) as most recent content = Claude likely continues
  if (lines[0].includes('⎿')) return { signal: 'tool_result' };

  return null;
}

function scheduleReady(id) {
  if (readyDebounceTimers.has(id)) return;
  let delay = READY_DEBOUNCE_MS;
  if (postEnterExtended.has(id)) {
    delay = POST_ENTER_DEBOUNCE_MS;
    postEnterExtended.delete(id);
  } else if (postSpinnerExtended.has(id)) {
    const sub = terminalSubstatus.get(id);
    delay = sub === 'tool_calling' ? POST_TOOL_DEBOUNCE_MS : POST_THINKING_DEBOUNCE_MS;
  }
  readyDebounceTimers.set(id, setTimeout(() => {
    readyDebounceTimers.delete(id);
    finalizeReady(id);
  }, delay));
}

/**
 * Verify completion before declaring ready.
 * Priority order:
 *   1. "✳ Word for Xm Xs" in content → 100% done (definitive)
 *   2. "· Word…" in content → 100% still working → recheck
 *   3. Permission prompt → immediate ready (user must act)
 *   4. Tool result (⎿) + data flowing → recheck (Claude between tools)
 *   5. Data still flowing → recheck
 *   6. Silent terminal → ready (fallback)
 */
function finalizeReady(id) {
  const termData = getTerminal(id);
  const lastData = lastTerminalData.get(id);
  const isSilent = !lastData || Date.now() - lastData >= SILENCE_THRESHOLD_MS;

  if (termData?.terminal) {
    const completion = detectCompletionSignal(termData.terminal);

    // "✳ Churned for 1m 51s" → 100% done, no doubt
    if (completion?.signal === 'done') {
      if (completion.duration) {
        const ctx = terminalContext.get(id);
        if (ctx) ctx.duration = completion.duration;
      }
      declareReady(id);
      return;
    }

    // "· Hatching…" → 100% still working, recheck
    if (completion?.signal === 'working') {
      readyDebounceTimers.set(id, setTimeout(() => {
        readyDebounceTimers.delete(id);
        finalizeReady(id);
      }, RECHECK_DELAY_MS));
      return;
    }

    // Permission prompt → needs user attention now
    if (completion?.signal === 'permission') {
      declareReady(id);
      return;
    }

    // Tool result + data still flowing → Claude is between tools
    if (completion?.signal === 'tool_result' && !isSilent) {
      readyDebounceTimers.set(id, setTimeout(() => {
        readyDebounceTimers.delete(id);
        finalizeReady(id);
      }, RECHECK_DELAY_MS));
      return;
    }
  }

  // Data still flowing (no definitive signal) → recheck
  if (!isSilent) {
    readyDebounceTimers.set(id, setTimeout(() => {
      readyDebounceTimers.delete(id);
      finalizeReady(id);
    }, RECHECK_DELAY_MS));
    return;
  }

  // Silent + no blocking signals = ready (fallback)
  declareReady(id);
}

function declareReady(id) {
  postSpinnerExtended.delete(id);
  postEnterExtended.delete(id);
  terminalSubstatus.delete(id);
  updateTerminalStatus(id, 'ready');
  // Reset tool tracking after notification (taskName kept for next cycle)
  const ctx = terminalContext.get(id);
  if (ctx) {
    ctx.toolCount = 0;
    ctx.lastTool = null;
  }
}

function cancelScheduledReady(id) {
  const timer = readyDebounceTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    readyDebounceTimers.delete(id);
  }
}

// Broader Braille spinner detection: any non-blank Braille Pattern character (U+2801-U+28FF)
const BRAILLE_SPINNER_RE = /[\u2801-\u28FF]/;

// Known Claude CLI tools (detected in OSC title during tool execution)
const CLAUDE_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task',
  'WebFetch', 'WebSearch', 'TodoRead', 'TodoWrite', 'Notebook', 'MultiEdit'
]);

/**
 * Parse Claude OSC title to extract state, tool name, and task name.
 * Title format: "[✳|⠐|⠂] [TaskName|ToolName args]"
 */
function parseClaudeTitle(title) {
  const brailleMatch = title.match(/[\u2801-\u28FF]\s+(.*)/);
  const readyMatch = title.match(/\u2733\s+(.*)/);
  const content = (brailleMatch || readyMatch)?.[1]?.trim();
  const state = brailleMatch ? 'working' : readyMatch ? 'ready' : 'unknown';
  if (!content || content === 'Claude Code') return { state };
  const firstWord = content.split(/\s/)[0];
  if (CLAUDE_TOOLS.has(firstWord)) {
    return { state, tool: firstWord, toolArgs: content.substring(firstWord.length).trim() };
  }
  return { state, taskName: content };
}

/**
 * Shared title change handler for all Claude terminal types.
 * Parses OSC title for state, tool calls, and task names.
 * @param {string|number} id - Terminal ID
 * @param {string} title - New OSC title
 * @param {Object} [options]
 * @param {Function} [options.onPendingPrompt] - Called on first ✳ for quick-action terminals. Return true to suppress ready scheduling.
 */
function handleClaudeTitleChange(id, title, options = {}) {
  const { onPendingPrompt } = options;

  if (BRAILLE_SPINNER_RE.test(title)) {
    // ── Working: Claude is active ──
    postEnterExtended.delete(id);
    postSpinnerExtended.add(id);
    cancelScheduledReady(id);

    const parsed = parseClaudeTitle(title);
    terminalSubstatus.set(id, parsed.tool ? 'tool_calling' : 'thinking');

    // Track rich context
    if (!terminalContext.has(id)) terminalContext.set(id, { taskName: null, lastTool: null, toolCount: 0, duration: null });
    const ctx = terminalContext.get(id);
    if (parsed.taskName) ctx.taskName = parsed.taskName;
    if (parsed.tool) {
      ctx.lastTool = parsed.tool;
      ctx.toolCount++;
    }

    // Auto-name tab from Claude's task name (not tool names)
    if (parsed.taskName) {
      updateTerminalTabName(id, parsed.taskName);
    }

    updateTerminalStatus(id, 'working');

  } else if (title.includes('\u2733')) {
    // ── Ready candidate: Claude may be done ──
    const parsed = parseClaudeTitle(title);
    if (parsed.taskName) {
      if (!terminalContext.has(id)) terminalContext.set(id, { taskName: null, lastTool: null, toolCount: 0, duration: null });
      terminalContext.get(id).taskName = parsed.taskName;
      updateTerminalTabName(id, parsed.taskName);
    }

    // Handle pending prompt (quick-action terminals)
    if (onPendingPrompt && onPendingPrompt()) return;

    scheduleReady(id);

    // Fast-track: detect definitive done/permission → skip debounce entirely
    setTimeout(() => {
      if (!readyDebounceTimers.has(id)) return;
      const termData = getTerminal(id);
      if (termData?.terminal) {
        const completion = detectCompletionSignal(termData.terminal);
        if (completion?.signal === 'done' || completion?.signal === 'permission') {
          cancelScheduledReady(id);
          declareReady(id);
        }
      }
    }, 500);
  }
}

/**
 * Extract the last meaningful lines from xterm buffer for notification context.
 * Reads rendered text (ANSI-free) from the bottom up, skipping noise.
 */
function extractTerminalContext(terminal) {
  if (!terminal?.buffer?.active) return null;
  const buf = terminal.buffer.active;
  const totalLines = buf.baseY + buf.cursorY;
  const scanLimit = Math.max(0, totalLines - 30);

  // Collect non-empty lines from bottom up
  const lines = [];
  for (let i = totalLines; i >= scanLimit; i--) {
    const row = buf.getLine(i);
    if (!row) continue;
    const text = row.translateToString(true).trim();
    if (!text) continue;
    // Skip spinners / prompt markers / pure symbols
    if (BRAILLE_SPINNER_RE.test(text)) continue;
    if (/^[✳❯>\$%#\s]*$/.test(text)) continue;
    lines.unshift(text);
    if (lines.length >= 6) break;
  }

  if (lines.length === 0) return null;

  // Join and analyze the last chunk
  const block = lines.join('\n');
  const lastLine = lines[lines.length - 1];

  // Detect question (ends with ?)
  const questionMatch = block.match(/^(.+\?)\s*$/m);
  if (questionMatch) {
    const q = questionMatch[1].trim();
    if (q.length > 10 && q.length <= 200) return { type: 'question', text: q };
  }

  // Detect permission / tool approval patterns
  if (/\b(allow|approve|permit|yes\/no|y\/n)\b/i.test(block) ||
      /\b(Run|Execute|Edit|Write|Read|Delete|Bash)\b.*\?/.test(block)) {
    return { type: 'permission', text: lastLine.length <= 120 ? lastLine : null };
  }

  return { type: 'done', text: null };
}

// ── Throttled recordActivity (max 1 call/sec per project) ──
const activityThrottles = new Map();
function throttledRecordActivity(projectId) {
  if (!projectId || activityThrottles.has(projectId)) return;
  recordActivity(projectId);
  activityThrottles.set(projectId, true);
  setTimeout(() => activityThrottles.delete(projectId), 1000);
}

// ── Throttled recordOutputActivity (max 1 call/5sec per project) ──
const outputActivityThrottles = new Map();
function throttledRecordOutputActivity(projectId) {
  if (!projectId || outputActivityThrottles.has(projectId)) return;
  recordOutputActivity(projectId);
  outputActivityThrottles.set(projectId, true);
  setTimeout(() => outputActivityThrottles.delete(projectId), 5000);
}

/**
 * Setup paste handler to prevent double-paste issue
 * xterm.js + Electron can trigger paste twice, so we handle it manually
 * @param {HTMLElement} wrapper - Terminal wrapper element
 * @param {string|number} terminalId - Terminal ID for IPC
 * @param {string} inputChannel - IPC channel for input
 */
function setupPasteHandler(wrapper, terminalId, inputChannel = 'terminal-input') {
  wrapper.addEventListener('paste', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - lastPasteTime < PASTE_DEBOUNCE_MS) {
      return;
    }
    lastPasteTime = now;
    navigator.clipboard.readText().then(text => {
      if (text) {
        if (inputChannel === 'fivem-input') {
          api.fivem.input({ projectIndex: terminalId, data: text });
        } else if (inputChannel === 'webapp-input') {
          api.webapp.input({ projectIndex: terminalId, data: text });
        } else {
          api.terminal.input({ id: terminalId, data: text });
        }
      }
    });
  }, true);
}

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
          if (inputChannel === 'fivem-input') {
            api.fivem.input({ projectIndex: terminalId, data: text });
          } else if (inputChannel === 'webapp-input') {
            api.webapp.input({ projectIndex: terminalId, data: text });
          } else {
            api.terminal.input({ id: terminalId, data: text });
          }
        }
      });
      return false;
    }

    // FiveM-specific shortcuts
    if (inputChannel === 'fivem-input' && e.type === 'keydown') {
      const projectIndex = terminalId;
      const fivemId = fivemConsoleIds.get(projectIndex);
      const wrapper = fivemId ? document.querySelector(`.terminal-wrapper[data-id="${fivemId}"]`) : null;

      // Ctrl+E: Toggle resources view
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
        if (wrapper) {
          const resourcesTab = wrapper.querySelector('.fivem-view-tab[data-view="resources"]');
          const consoleTab = wrapper.querySelector('.fivem-view-tab[data-view="console"]');
          const resourcesView = wrapper.querySelector('.fivem-resources-view');

          if (resourcesView && resourcesView.style.display !== 'none') {
            // Already on resources, switch back to console
            consoleTab?.click();
          } else {
            // Switch to resources
            resourcesTab?.click();
          }
        }
        return false;
      }

      // Resource shortcuts (F keys, Ctrl+number, etc.)
      if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
        let shortcut = '';
        if (e.ctrlKey) shortcut += 'Ctrl+';
        if (e.altKey) shortcut += 'Alt+';
        if (e.shiftKey) shortcut += 'Shift+';

        let keyName = e.key;
        if (keyName === ' ') keyName = 'Space';
        else if (keyName.length === 1) keyName = keyName.toUpperCase();

        shortcut += keyName;

        // Check if this matches a resource shortcut
        const resourceName = findResourceByShortcut(projectIndex, shortcut);
        if (resourceName) {
          // Execute ensure command
          api.fivem.resourceCommand({ projectIndex, command: `ensure ${resourceName}` })
            .catch(err => console.error('Shortcut ensure failed:', err));

          // Flash visual feedback
          const resourceItem = wrapper?.querySelector(`.fivem-resource-item[data-name="${resourceName}"]`);
          if (resourceItem) {
            resourceItem.classList.add('shortcut-triggered');
            setTimeout(() => resourceItem.classList.remove('shortcut-triggered'), 300);
          }
          return false;
        }
      }
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
      tab.classList.remove('status-working', 'status-ready', 'substatus-thinking', 'substatus-tool');
      tab.classList.add(`status-${status}`);
      if (status === 'working') {
        const sub = terminalSubstatus.get(id);
        tab.classList.add(sub === 'tool_calling' ? 'substatus-tool' : 'substatus-thinking');
      }
    }
    if (status === 'ready' && previousStatus === 'working') {
      if (callbacks.onNotification) {
        const projectName = termData.project?.name || termData.name;
        const bufCtx = termData.terminal ? extractTerminalContext(termData.terminal) : null;
        const richCtx = terminalContext.get(id);
        const label = richCtx?.taskName || projectName;
        let notifTitle = 'Claude Terminal';
        let body;

        if (richCtx?.toolCount > 0) {
          body = t('terminals.notifToolsDone', { count: richCtx.toolCount });
        } else {
          body = t('terminals.notifDone');
        }

        if (richCtx?.taskName) notifTitle = projectName;

        callbacks.onNotification('done', notifTitle, body, id);
      }
    }
    // Re-render project list to update terminal stats
    if (callbacks.onRenderProjects) {
      callbacks.onRenderProjects();
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
  // Get previous terminal's project for time tracking
  const prevActiveId = getActiveTerminal();
  const prevTermData = prevActiveId ? getTerminal(prevActiveId) : null;
  const prevProjectId = prevTermData?.project?.id;

  setActiveTerminalState(id);
  document.querySelectorAll('.terminal-tab').forEach(t => t.classList.toggle('active', t.dataset.id == id));
  document.querySelectorAll('.terminal-wrapper').forEach(w => w.classList.toggle('active', w.dataset.id == id));
  const termData = getTerminal(id);
  if (termData) {
    if (termData.type !== 'file') {
      termData.fitAddon.fit();
      termData.terminal.focus();
    }

    // Handle project switch for time tracking
    const newProjectId = termData.project?.id;
    if (prevProjectId !== newProjectId) {
      switchProject(prevProjectId, newProjectId);
    }
  }
}

/**
 * Clean up terminal resources (IPC handlers, observers)
 * @param {Object} termData - Terminal data object
 */
function cleanupTerminalResources(termData) {
  if (!termData) return;

  // Remove IPC handlers from centralized dispatcher
  if (termData.handlers) {
    if (termData.handlers.unregister) {
      termData.handlers.unregister();
    }
    // Legacy cleanup (unsubscribe functions)
    if (termData.handlers.unsubscribeData) {
      termData.handlers.unsubscribeData();
    }
    if (termData.handlers.unsubscribeExit) {
      termData.handlers.unsubscribeExit();
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
  const closedProjectId = termData?.project?.id;

  // Delegate to type-specific close functions
  if (termData && termData.type === 'fivem') {
    closeFivemConsole(id, closedProjectIndex);
    return;
  }
  if (termData && termData.type === 'webapp') {
    closeWebAppConsole(id, closedProjectIndex);
    return;
  }

  clearOutputSilenceTimer(id);
  cancelScheduledReady(id);
  postEnterExtended.delete(id);
  postSpinnerExtended.delete(id);
  terminalSubstatus.delete(id);
  lastTerminalData.delete(id);
  terminalContext.delete(id);

  // Kill and cleanup
  if (termData && termData.type === 'file') {
    // File tabs have no terminal process to kill
    removeTerminal(id);
  } else {
    api.terminal.kill({ id });
    cleanupTerminalResources(termData);
    removeTerminal(id);
  }
  document.querySelector(`.terminal-tab[data-id="${id}"]`)?.remove();
  document.querySelector(`.terminal-wrapper[data-id="${id}"]`)?.remove();

  // Find another terminal from the same project
  let sameProjectTerminalId = null;
  const terminals = terminalsState.get().terminals;
  if (closedProjectPath) {
    terminals.forEach((td, termId) => {
      if (!sameProjectTerminalId && td.project?.path === closedProjectPath) {
        sameProjectTerminalId = termId;
      }
    });
  }

  // Stop time tracking if no more terminals for this project
  if (!sameProjectTerminalId && closedProjectId) {
    stopTracking(closedProjectId);
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
  const { skipPermissions = false, runClaude = true, name: customName = null } = options;

  const result = await api.terminal.create({
    cwd: project.path,
    runClaude,
    skipPermissions
  });

  // Handle new response format { success, id, error }
  if (result && typeof result === 'object' && 'success' in result) {
    if (!result.success) {
      console.error('Failed to create terminal:', result.error);
      if (callbacks.onNotification) {
        callbacks.onNotification(`❌ ${t('common.error')}`, result.error || t('terminals.createError'), null);
      }
      return null;
    }
    var id = result.id;
  } else {
    // Backwards compatibility with old format (just id)
    var id = result;
  }

  const terminalThemeId = getSetting('terminalTheme') || 'claude';
  const terminal = new Terminal({
    theme: getTerminalTheme(terminalThemeId),
    fontFamily: TERMINAL_FONTS.claude.fontFamily,
    fontSize: TERMINAL_FONTS.claude.fontSize,
    cursorBlink: true,
    scrollback: 5000
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const projectIndex = getProjectIndex(project.id);
  const isBasicTerminal = !runClaude;
  const tabName = customName || project.name;
  const termData = {
    terminal,
    fitAddon,
    project,
    projectIndex,
    name: tabName,
    status: 'ready',
    inputBuffer: '',
    isBasic: isBasicTerminal
  };

  addTerminal(id, termData);

  // Start time tracking for this project
  startTracking(project.id);

  // Create tab
  const tabsContainer = document.getElementById('terminals-tabs');
  const tab = document.createElement('div');
  tab.className = `terminal-tab status-ready${isBasicTerminal ? ' basic-terminal' : ''}`;
  tab.dataset.id = id;
  tab.tabIndex = 0;
  tab.setAttribute('role', 'tab');
  tab.innerHTML = `
    <span class="status-dot"></span>
    <span class="tab-name">${escapeHtml(tabName)}</span>
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
  loadWebglAddon(terminal);
  setTimeout(() => fitAddon.fit(), 100);
  setActiveTerminal(id);

  // Prevent double-paste issue
  setupPasteHandler(wrapper, id, 'terminal-input');

  // Custom key handler for global shortcuts and copy/paste
  terminal.attachCustomKeyEventHandler(createTerminalKeyHandler(terminal, id, 'terminal-input'));

  // Title change handling (adaptive debounce + tool/task detection)
  let lastTitle = '';
  terminal.onTitleChange(title => {
    if (title === lastTitle) return;
    lastTitle = title;
    handleClaudeTitleChange(id, title);
  });

  // IPC data handling via centralized dispatcher
  registerTerminalHandler(id,
    (data) => {
      terminal.write(data.data);
      resetOutputSilenceTimer(id);
      const td = getTerminal(id);
      if (td?.project?.id) throttledRecordOutputActivity(td.project.id);
    },
    () => closeTerminal(id)
  );

  // Store cleanup reference
  const storedTermData = getTerminal(id);
  if (storedTermData) {
    storedTermData.handlers = { unregister: () => unregisterTerminalHandler(id) };
  }

  // Input handling
  terminal.onData(data => {
    api.terminal.input({ id, data });
    // Record activity for time tracking (resets idle timer)
    const td = getTerminal(id);
    if (td?.project?.id) throttledRecordActivity(td.project.id);
    if (data === '\r' || data === '\n') {
      cancelScheduledReady(id);
      updateTerminalStatus(id, 'working');
      if (td && td.inputBuffer.trim().length > 0) {
        postEnterExtended.add(id);
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
    api.terminal.resize({ id, cols: terminal.cols, rows: terminal.rows });
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
 * Build dependencies object for type panel modules
 * @param {string} consoleId - The FiveM console terminal ID
 * @param {number} projectIndex - The project index
 * @returns {Object} Dependencies for panel setup
 */
function getTypePanelDeps(consoleId, projectIndex) {
  return {
    getTerminal,
    getFivemErrors,
    clearFivemErrors,
    getFivemResources,
    setFivemResourcesLoading,
    setFivemResources,
    getResourceShortcut,
    setResourceShortcut,
    api,
    t,
    consoleId,
    createTerminalWithPrompt,
    buildDebugPrompt
  };
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

  const fivemThemeId = getSetting('terminalTheme') || 'claude';
  const terminal = new Terminal({
    theme: getTerminalTheme(fivemThemeId),
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

  // Start time tracking for this project
  startTracking(project.id);

  // Create tab
  const tabsContainer = document.getElementById('terminals-tabs');
  const tab = document.createElement('div');
  tab.className = 'terminal-tab fivem-tab status-ready';
  tab.dataset.id = id;
  tab.tabIndex = 0;
  tab.setAttribute('role', 'tab');
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

  // Get panel HTML from type handler
  const typeHandler = registry.get(project.type);
  const panels = typeHandler.getTerminalPanels({ project, projectIndex });
  const panel = panels && panels.length > 0 ? panels[0] : null;
  if (panel) {
    wrapper.innerHTML = panel.getWrapperHtml();
  }

  container.appendChild(wrapper);

  document.getElementById('empty-terminals').style.display = 'none';

  // Open terminal in console view container
  const consoleView = wrapper.querySelector('.fivem-console-view');
  terminal.open(consoleView);
  loadWebglAddon(terminal);
  setTimeout(() => fitAddon.fit(), 100);
  setActiveTerminal(id);

  // Prevent double-paste issue
  setupPasteHandler(consoleView, projectIndex, 'fivem-input');

  // Write existing logs
  const server = getFivemServer(projectIndex);
  if (server && server.logs && server.logs.length > 0) {
    terminal.write(server.logs.join(''));
  }

  // Setup panel via type handler
  if (panel && panel.setupPanel) {
    const panelDeps = getTypePanelDeps(id, projectIndex);
    panel.setupPanel(wrapper, id, projectIndex, project, panelDeps);
  }

  // Custom key handler for global shortcuts, copy/paste, and resource shortcuts
  terminal.attachCustomKeyEventHandler(createTerminalKeyHandler(terminal, projectIndex, 'fivem-input'));

  // Handle input to FiveM console
  terminal.onData(data => {
    api.fivem.input({ projectIndex, data });
  });

  // Resize handling
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    api.fivem.resize({
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
  api.fivem.resize({
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
 * Setup FiveM view switcher (Console / Errors / Resources)
 */
function setupFivemViewSwitcher(wrapper, terminalId, projectIndex, project) {
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

      // Hide all views
      consoleView.style.display = 'none';
      errorsView.style.display = 'none';
      resourcesView.style.display = 'none';

      if (view === 'console') {
        consoleView.style.display = '';
        // Refit terminal
        const termData = getTerminal(terminalId);
        if (termData) {
          setTimeout(() => termData.fitAddon.fit(), 50);
        }
      } else if (view === 'errors') {
        errorsView.style.display = '';
        renderFivemErrorsList(wrapper, projectIndex, project);
      } else if (view === 'resources') {
        resourcesView.style.display = '';
        // Load resources if not already loaded
        const { resources, lastScan } = getFivemResources(projectIndex);
        if (!lastScan || resources.length === 0) {
          scanAndRenderResources(wrapper, projectIndex, project);
        } else {
          renderFivemResourcesList(wrapper, projectIndex, project);
        }
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

  // Refresh resources button
  refreshBtn.onclick = () => {
    scanAndRenderResources(wrapper, projectIndex, project);
  };

  // Search resources
  searchInput.oninput = () => {
    renderFivemResourcesList(wrapper, projectIndex, project, searchInput.value);
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

  const termData = getTerminal(consoleId);
  if (!termData) return;

  // Delegate to type handler panel
  const typeHandler = registry.get(termData.project?.type || 'standalone');
  const panels = typeHandler.getTerminalPanels({ project: termData.project, projectIndex });
  const panel = panels && panels.length > 0 ? panels[0] : null;
  if (panel && panel.onNewError) {
    const panelDeps = getTypePanelDeps(consoleId, projectIndex);
    panel.onNewError(wrapper, projectIndex, panelDeps);
  }
}

/**
 * Scan and render FiveM resources
 */
async function scanAndRenderResources(wrapper, projectIndex, project) {
  const list = wrapper.querySelector('.fivem-resources-list');
  const empty = wrapper.querySelector('.fivem-resources-empty');
  const loading = wrapper.querySelector('.fivem-resources-loading');
  const refreshBtn = wrapper.querySelector('.fivem-refresh-resources');

  // Show loading state
  list.style.display = 'none';
  empty.style.display = 'none';
  loading.style.display = 'flex';
  refreshBtn.classList.add('spinning');

  setFivemResourcesLoading(projectIndex, true);

  try {
    const result = await api.fivem.scanResources({ projectPath: project.path });

    if (result.success) {
      setFivemResources(projectIndex, result.resources);
      updateFivemResourceBadge(wrapper, result.resources.length);
      renderFivemResourcesList(wrapper, projectIndex, project);
    } else {
      empty.style.display = 'flex';
    }
  } catch (e) {
    console.error('Error scanning resources:', e);
    empty.style.display = 'flex';
  } finally {
    loading.style.display = 'none';
    refreshBtn.classList.remove('spinning');
    setFivemResourcesLoading(projectIndex, false);
  }
}

/**
 * Update FiveM resource badge count
 */
function updateFivemResourceBadge(wrapper, count) {
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
 * Render FiveM resources list
 */
function renderFivemResourcesList(wrapper, projectIndex, project, searchFilter = '') {
  const list = wrapper.querySelector('.fivem-resources-list');
  const empty = wrapper.querySelector('.fivem-resources-empty');
  const loading = wrapper.querySelector('.fivem-resources-loading');
  const { resources } = getFivemResources(projectIndex);

  loading.style.display = 'none';

  // Filter resources by search
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

  // Sort categories
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
            const shortcut = getResourceShortcut(projectIndex, resource.name);
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

  // Add click handlers for resource actions
  list.querySelectorAll('.fivem-resource-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const resourceName = btn.dataset.resource;
      const resourcePath = btn.dataset.path;

      if (action === 'folder') {
        api.dialog.openInExplorer(resourcePath);
        return;
      }

      if (action === 'shortcut') {
        const currentShortcut = getResourceShortcut(projectIndex, resourceName);
        if (currentShortcut) {
          // Remove shortcut
          setResourceShortcut(projectIndex, resourceName, null);
          renderFivemResourcesList(wrapper, projectIndex, project, wrapper.querySelector('.fivem-resources-search-input')?.value || '');
        } else {
          // Capture new shortcut
          captureResourceShortcut(btn, projectIndex, resourceName, wrapper, project);
        }
        return;
      }

      let command = '';
      if (action === 'ensure') {
        command = `ensure ${resourceName}`;
      } else if (action === 'restart') {
        command = `restart ${resourceName}`;
      } else if (action === 'stop') {
        command = `stop ${resourceName}`;
      }

      if (command) {
        btn.classList.add('executing');
        try {
          // Let main process check if server is running
          const result = await api.fivem.resourceCommand({ projectIndex, command });
          if (result.success) {
            btn.classList.add('success');
            setTimeout(() => {
              btn.classList.remove('executing');
              btn.classList.remove('success');
            }, 500);
          } else {
            // Server not running or command failed
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
 * Capture a keyboard shortcut for a resource
 */
function captureResourceShortcut(btn, projectIndex, resourceName, wrapper, project) {
  // Change button to capture mode
  btn.innerHTML = `<span class="shortcut-capturing">${t('fivem.pressKey')}</span>`;
  btn.classList.add('capturing');

  const handleKeyDown = (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Ignore modifier-only keys
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
      return;
    }

    // Build shortcut string
    let shortcut = '';
    if (e.ctrlKey) shortcut += 'Ctrl+';
    if (e.altKey) shortcut += 'Alt+';
    if (e.shiftKey) shortcut += 'Shift+';

    // Handle special keys
    if (e.key === 'Escape') {
      // Cancel capture
      cleanup();
      renderFivemResourcesList(wrapper, projectIndex, project, wrapper.querySelector('.fivem-resources-search-input')?.value || '');
      return;
    }

    // Get key name
    let keyName = e.key;
    if (keyName === ' ') keyName = 'Space';
    else if (keyName.length === 1) keyName = keyName.toUpperCase();

    shortcut += keyName;

    // Save shortcut
    setResourceShortcut(projectIndex, resourceName, shortcut);
    cleanup();
    renderFivemResourcesList(wrapper, projectIndex, project, wrapper.querySelector('.fivem-resources-search-input')?.value || '');
  };

  const cleanup = () => {
    document.removeEventListener('keydown', handleKeyDown, true);
    btn.classList.remove('capturing');
  };

  document.addEventListener('keydown', handleKeyDown, true);
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

// ── WebApp Console Functions ──

/**
 * Create a WebApp console as a terminal tab
 */
function createWebAppConsole(project, projectIndex, options = {}) {
  const existingId = webappConsoleIds.get(projectIndex);
  if (existingId && getTerminal(existingId)) {
    setActiveTerminal(existingId);
    return existingId;
  }

  const id = `webapp-${projectIndex}-${Date.now()}`;

  const themeId = getSetting('terminalTheme') || 'claude';
  const terminal = new Terminal({
    theme: getTerminalTheme(themeId),
    fontFamily: 'Consolas, "Courier New", monospace',
    fontSize: 13,
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
    name: `🌐 ${project.name}`,
    status: 'ready',
    type: 'webapp',
    inputBuffer: '',
    activeView: 'console'
  };

  addTerminal(id, termData);
  webappConsoleIds.set(projectIndex, id);

  startTracking(project.id);

  // Create tab
  const tabsContainer = document.getElementById('terminals-tabs');
  const tab = document.createElement('div');
  tab.className = 'terminal-tab webapp-tab status-ready';
  tab.dataset.id = id;
  tab.innerHTML = `
    <span class="status-dot webapp-dot"></span>
    <span class="tab-name">${escapeHtml(`🌐 ${project.name}`)}</span>
    <button class="tab-close"><svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></button>`;
  tabsContainer.appendChild(tab);

  // Create wrapper with internal tabs
  const container = document.getElementById('terminals-container');
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper webapp-wrapper';
  wrapper.dataset.id = id;

  // Get panel HTML from type handler
  const typeHandler = registry.get(project.type);
  const panels = typeHandler.getTerminalPanels({ project, projectIndex });
  const panel = panels && panels.length > 0 ? panels[0] : null;
  if (panel) {
    wrapper.innerHTML = panel.getWrapperHtml();
  }

  container.appendChild(wrapper);

  document.getElementById('empty-terminals').style.display = 'none';

  // Open terminal in console view container
  const consoleView = wrapper.querySelector('.webapp-console-view');
  terminal.open(consoleView);
  loadWebglAddon(terminal);
  setTimeout(() => fitAddon.fit(), 100);
  setActiveTerminal(id);

  // Prevent double-paste issue
  setupPasteHandler(consoleView, projectIndex, 'webapp-input');

  // Write existing logs from WebAppState
  try {
    const { getWebAppServer } = require('../../../project-types/webapp/renderer/WebAppState');
    const server = getWebAppServer(projectIndex);
    if (server && server.logs && server.logs.length > 0) {
      terminal.write(server.logs.join(''));
    }
  } catch (e) { /* WebApp module not available */ }

  // Setup panel via type handler
  if (panel && panel.setupPanel) {
    const panelDeps = getTypePanelDeps(id, projectIndex);
    panel.setupPanel(wrapper, id, projectIndex, project, panelDeps);
  }

  // Custom key handler
  terminal.attachCustomKeyEventHandler(createTerminalKeyHandler(terminal, projectIndex, 'webapp-input'));

  // Handle input to WebApp console
  terminal.onData(data => {
    api.webapp.input({ projectIndex, data });
  });

  // Resize handling
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    api.webapp.resize({
      projectIndex,
      cols: terminal.cols,
      rows: terminal.rows
    });
  });
  resizeObserver.observe(consoleView);

  const storedTermData = getTerminal(id);
  if (storedTermData) {
    storedTermData.resizeObserver = resizeObserver;
  }

  // Send initial size
  api.webapp.resize({
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
  tab.querySelector('.tab-close').onclick = (e) => { e.stopPropagation(); closeWebAppConsole(id, projectIndex); };

  setupTabDragDrop(tab);

  return id;
}

/**
 * Close WebApp console
 */
function closeWebAppConsole(id, projectIndex) {
  const termData = getTerminal(id);
  const closedProjectPath = termData?.project?.path;

  // Cleanup preview iframe and poll timers
  const wrapper = document.querySelector(`.terminal-wrapper[data-id="${id}"]`);
  if (wrapper) {
    try { require('../../../project-types/webapp/renderer/WebAppTerminalPanel').cleanup(wrapper); } catch (e) {}
  }

  cleanupTerminalResources(termData);
  removeTerminal(id);
  webappConsoleIds.delete(projectIndex);
  document.querySelector(`.terminal-tab[data-id="${id}"]`)?.remove();
  wrapper?.remove();

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
    setActiveTerminal(sameProjectTerminalId);
    const selectedFilter = projectsState.get().selectedProjectFilter;
    filterByProject(selectedFilter);
  } else if (projectIndex !== null && projectIndex !== undefined) {
    projectsState.setProp('selectedProjectFilter', projectIndex);
    filterByProject(projectIndex);
  } else {
    const selectedFilter = projectsState.get().selectedProjectFilter;
    filterByProject(selectedFilter);
  }

  if (callbacks.onRenderProjects) callbacks.onRenderProjects();
}

/**
 * Get WebApp console terminal for a project
 */
function getWebAppConsoleTerminal(projectIndex) {
  const id = webappConsoleIds.get(projectIndex);
  if (id) {
    const termData = getTerminal(id);
    if (termData) {
      return termData.terminal;
    }
  }
  return null;
}

/**
 * Write data to WebApp console
 */
function writeWebAppConsole(projectIndex, data) {
  const terminal = getWebAppConsoleTerminal(projectIndex);
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

    // Render Quick Actions bar for this project
    const qa = getQuickActions();
    if (qa) {
      qa.setTerminalCallback(createTerminal);
      qa.renderQuickActionsBar(projects[projectIndex]);
    }
  } else {
    filterIndicator.style.display = 'none';

    // Hide Quick Actions bar when no project is filtered
    const qa = getQuickActions();
    if (qa) {
      qa.hideQuickActionsBar();
    }
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
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.89 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
            <p>${t('terminals.noTerminals')}</p>
            <p class="hint">${t('terminals.createHint')}</p>
          </div>`;
      }
    } else {
      emptyState.innerHTML = `
        <div class="sessions-empty-state">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
          <p>${t('terminals.selectProject')}</p>
          <p class="hint">${t('terminals.terminalOpensHere')}</p>
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
 * Get terminal stats for a project (total and working count)
 */
function getTerminalStatsForProject(projectIndex) {
  if (projectIndex === null || projectIndex === undefined) return { total: 0, working: 0 };
  const projects = projectsState.get().projects;
  const project = projects[projectIndex];
  if (!project) return { total: 0, working: 0 };
  let total = 0;
  let working = 0;
  const terminals = terminalsState.get().terminals;
  terminals.forEach(termData => {
    if (termData.project && termData.project.path === project.path && termData.type !== 'fivem' && termData.type !== 'file' && !termData.isBasic) {
      total++;
      if (termData.status === 'working') working++;
    }
  });
  return { total, working };
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

  if (diffMins < 1) return t('time.justNow');
  if (diffMins < 60) return t('time.minutesAgo', { count: diffMins });
  if (diffHours < 24) return t('time.hoursAgo', { count: diffHours });
  if (diffDays < 7) return t('time.daysAgo', { count: diffDays });
  const locale = getCurrentLanguage() === 'fr' ? 'fr-FR' : 'en-US';
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
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
 * Clean raw text from session prompts (remove XML tags, command markers, etc.)
 * Returns { text, skillName } where skillName is extracted if the prompt was a skill invocation
 */
function cleanSessionText(text) {
  if (!text) return { text: '', skillName: '' };

  let skillName = '';

  // Extract skill/command name from <command-name>/skill-name</command-name>
  const cmdNameMatch = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
  if (cmdNameMatch) {
    skillName = cmdNameMatch[1].trim().replace(/^\//, '');
  }

  // Extract content between tags that might be useful (e.g. <command-args>actual text</command-args>)
  const argsMatch = text.match(/<command-args>([^<]+)<\/command-args>/);
  const argsText = argsMatch ? argsMatch[1].trim() : '';

  // Remove all XML-like tags and their content
  let cleaned = text.replace(/<[^>]+>[^<]*<\/[^>]+>/g, '');
  // Remove self-closing / orphan tags
  cleaned = cleaned.replace(/<[^>]+>/g, '');
  // Remove [Request interrupted...] markers
  cleaned = cleaned.replace(/\[Request interrupted[^\]]*\]/g, '');
  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // If cleaned text is empty but we extracted args, use those
  if (!cleaned && argsText) {
    cleaned = argsText;
  }

  return { text: cleaned, skillName };
}

/**
 * Get temporal group key for a session date
 */
function getSessionGroup(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  if (date >= today) return 'today';
  if (date >= yesterday) return 'yesterday';
  if (date >= weekAgo) return 'thisWeek';
  return 'older';
}

/**
 * Group sessions by temporal proximity
 */
function groupSessionsByTime(sessions) {
  const groups = {
    today: { key: 'today', label: t('sessions.today') || t('common.today'), sessions: [] },
    yesterday: { key: 'yesterday', label: t('sessions.yesterday') || t('time.yesterday') || (getCurrentLanguage() === 'fr' ? 'Hier' : 'Yesterday'), sessions: [] },
    thisWeek: { key: 'thisWeek', label: t('sessions.thisWeek') || (getCurrentLanguage() === 'fr' ? 'Cette semaine' : 'This week'), sessions: [] },
    older: { key: 'older', label: t('sessions.older') || (getCurrentLanguage() === 'fr' ? 'Plus ancien' : 'Older'), sessions: [] }
  };

  sessions.forEach(session => {
    const group = getSessionGroup(session.modified);
    groups[group].sessions.push(session);
  });

  return Object.values(groups).filter(g => g.sessions.length > 0);
}

/**
 * SVG sprite definitions (rendered once, referenced via <use>)
 */
const SESSION_SVG_DEFS = `<svg style="display:none" xmlns="http://www.w3.org/2000/svg">
  <symbol id="s-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></symbol>
  <symbol id="s-bolt" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></symbol>
  <symbol id="s-msg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></symbol>
  <symbol id="s-clock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></symbol>
  <symbol id="s-branch" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></symbol>
  <symbol id="s-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></symbol>
  <symbol id="s-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="s-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></symbol>
</svg>`;

/**
 * Pre-process sessions: clean text once and cache display data
 */
function preprocessSessions(sessions) {
  const now = Date.now();
  return sessions.map(session => {
    const promptResult = cleanSessionText(session.firstPrompt);
    const summaryResult = cleanSessionText(session.summary);
    const skillName = promptResult.skillName || summaryResult.skillName;

    let displayTitle = '';
    let displaySubtitle = '';
    let isSkill = false;

    if (summaryResult.text) {
      displayTitle = summaryResult.text;
      displaySubtitle = promptResult.text;
    } else if (promptResult.text) {
      displayTitle = promptResult.text;
    } else if (skillName) {
      displayTitle = '/' + skillName;
      isSkill = true;
    } else {
      displayTitle = getCurrentLanguage() === 'fr' ? 'Conversation sans titre' : 'Untitled conversation';
    }

    const hoursAgo = (now - new Date(session.modified).getTime()) / 3600000;
    const freshness = hoursAgo < 1 ? 'hot' : hoursAgo < 24 ? 'warm' : '';

    // Pre-build searchable text (lowercase, computed once)
    const searchText = (displayTitle + ' ' + displaySubtitle + ' ' + (session.gitBranch || '')).toLowerCase();

    return { ...session, displayTitle, displaySubtitle, isSkill, freshness, searchText };
  });
}

/**
 * Build HTML for a single session card (lightweight, uses SVG sprites)
 */
function buildSessionCardHtml(s, index) {
  const MAX_ANIMATED = 10;
  const animClass = index < MAX_ANIMATED ? ' session-card--anim' : ' session-card--instant';
  const freshClass = s.freshness ? ` session-card--${s.freshness}` : '';
  const skillClass = s.isSkill ? ' session-card-icon--skill' : '';
  const titleSkillClass = s.isSkill ? ' session-card-title--skill' : '';
  const iconId = s.isSkill ? 's-bolt' : 's-chat';

  return `<div class="session-card${freshClass}${animClass}" data-sid="${s.sessionId}" style="--ci:${index < MAX_ANIMATED ? index : 0}">
<div class="session-card-accent"></div>
<div class="session-card-body">
<div class="session-card-top">
<div class="session-card-icon${skillClass}"><svg><use href="#${iconId}"/></svg></div>
<div class="session-card-content">
<span class="session-card-title${titleSkillClass}">${escapeHtml(truncateText(s.displayTitle, 80))}</span>
${s.displaySubtitle ? `<span class="session-card-subtitle">${escapeHtml(truncateText(s.displaySubtitle, 120))}</span>` : ''}
</div>
<div class="session-card-arrow"><svg><use href="#s-arrow"/></svg></div>
</div>
<div class="session-card-meta">
<span class="session-meta-item"><svg><use href="#s-msg"/></svg>${s.messageCount}</span>
<span class="session-meta-item"><svg><use href="#s-clock"/></svg>${formatRelativeTime(s.modified)}</span>
${s.gitBranch ? `<span class="session-meta-branch"><svg><use href="#s-branch"/></svg>${escapeHtml(s.gitBranch)}</span>` : ''}
</div>
</div>
</div>`;
}

/**
 * Render sessions panel in empty state
 */
async function renderSessionsPanel(project, emptyState) {
  try {
    const sessions = await api.claude.sessions(project.path);

    if (!sessions || sessions.length === 0) {
      emptyState.innerHTML = `
        <div class="sessions-empty-state">
          <div class="sessions-empty-icon">
            ${SESSION_SVG_DEFS}
            <svg><use href="#s-chat"/></svg>
          </div>
          <p class="sessions-empty-title">${t('terminals.noTerminals')}</p>
          <p class="sessions-empty-hint">${t('terminals.createHint')}</p>
          <button class="sessions-empty-btn" id="sessions-empty-create">
            <svg><use href="#s-plus"/></svg>
            ${t('terminals.newConversation') || (getCurrentLanguage() === 'fr' ? 'Nouvelle conversation' : 'New conversation')}
          </button>
        </div>`;
      const emptyBtn = emptyState.querySelector('#sessions-empty-create');
      if (emptyBtn) {
        emptyBtn.onclick = () => {
          if (callbacks.onCreateTerminal) callbacks.onCreateTerminal(project);
        };
      }
      return;
    }

    // Pre-process all sessions once (clean text, compute display data)
    const processed = preprocessSessions(sessions);

    // Group by time
    const groups = groupSessionsByTime(processed);

    // Batch render: first batch inline, rest lazy via IntersectionObserver
    const INITIAL_BATCH = 12;
    let cardIndex = 0;

    const groupsHtml = groups.map(group => {
      const cardsHtml = group.sessions.map(session => {
        const html = cardIndex < INITIAL_BATCH
          ? buildSessionCardHtml(session, cardIndex)
          : `<div class="session-card-placeholder" data-lazy-index="${cardIndex}" data-group-key="${group.key}"></div>`;
        cardIndex++;
        return html;
      }).join('');

      return `<div class="session-group" data-group-key="${group.key}">
        <div class="session-group-label">
          <span class="session-group-text">${group.label}</span>
          <span class="session-group-count">${group.sessions.length}</span>
          <span class="session-group-line"></span>
        </div>
        ${cardsHtml}
      </div>`;
    }).join('');

    emptyState.innerHTML = `
      ${SESSION_SVG_DEFS}
      <div class="sessions-panel">
        <div class="sessions-header">
          <div class="sessions-header-left">
            <span class="sessions-title">${t('terminals.resumeConversation')}</span>
            <span class="sessions-count">${sessions.length}</span>
          </div>
          <div class="sessions-header-right">
            <div class="sessions-search-wrapper">
              <svg class="sessions-search-icon"><use href="#s-search"/></svg>
              <input type="text" class="sessions-search" placeholder="${t('common.search')}..." />
            </div>
            <button class="sessions-new-btn" title="${t('terminals.newConversation') || (getCurrentLanguage() === 'fr' ? 'Nouvelle conversation' : 'New conversation')}">
              <svg><use href="#s-plus"/></svg>
              ${t('common.new')}
            </button>
          </div>
        </div>
        <div class="sessions-list">
          ${groupsHtml}
        </div>
      </div>`;

    // Build flat index and O(1) lookup map for all processed sessions
    const flatSessions = [];
    groups.forEach(g => g.sessions.forEach(s => flatSessions.push(s)));
    const sessionMap = new Map(flatSessions.map(s => [s.sessionId, s]));

    const listEl = emptyState.querySelector('.sessions-list');

    // Materialize a single placeholder into a real card
    function materializePlaceholder(el) {
      const idx = parseInt(el.dataset.lazyIndex);
      const session = flatSessions[idx];
      if (!session) return;
      const html = buildSessionCardHtml(session, idx);
      el.insertAdjacentHTML('afterend', html);
      el.remove();
    }

    // Materialize ALL remaining placeholders (used when search is active)
    let allMaterialized = false;
    function materializeAll() {
      if (allMaterialized) return;
      if (observer) observer.disconnect();
      const remaining = listEl.querySelectorAll('.session-card-placeholder');
      remaining.forEach(materializePlaceholder);
      allMaterialized = true;
    }

    // Lazy render remaining cards via IntersectionObserver
    let observer = null;
    const placeholders = emptyState.querySelectorAll('.session-card-placeholder');
    if (placeholders.length > 0) {
      observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          const el = entry.target;
          observer.unobserve(el);
          materializePlaceholder(el);
        });
      }, { root: listEl, rootMargin: '200px' });

      placeholders.forEach(p => observer.observe(p));
    } else {
      allMaterialized = true;
    }

    // Event delegation for card clicks (single listener on list)
    listEl.addEventListener('click', (e) => {
      const card = e.target.closest('.session-card');
      if (!card) return;
      const sessionId = card.dataset.sid;
      if (!sessionId) return;
      const skipPermissions = getSetting('skipPermissions') || false;
      resumeSession(project, sessionId, { skipPermissions });
    });

    // New conversation button
    emptyState.querySelector('.sessions-new-btn').onclick = () => {
      if (callbacks.onCreateTerminal) {
        callbacks.onCreateTerminal(project);
      }
    };

    // Debounced search using cached searchText and sessionMap
    const searchInput = emptyState.querySelector('.sessions-search');
    if (searchInput) {
      let searchTimer = null;
      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          const query = searchInput.value.toLowerCase().trim();

          // Materialize all lazy cards on first search so they're all searchable
          if (query) materializeAll();

          const cards = listEl.querySelectorAll('.session-card');
          const groupEls = listEl.querySelectorAll('.session-group');

          // Batch DOM reads then writes to avoid layout thrashing
          const visibility = [];
          cards.forEach(card => {
            const sid = card.dataset.sid;
            const session = sessionMap.get(sid);
            const match = !query || (session && session.searchText.includes(query));
            visibility.push({ card, match });
          });

          // Single write pass
          visibility.forEach(({ card, match }) => {
            card.style.display = match ? '' : 'none';
          });

          groupEls.forEach(group => {
            const hasVisible = group.querySelector('.session-card:not([style*="display: none"])');
            group.style.display = hasVisible ? '' : 'none';
          });
        }, 150);
      });
    }

  } catch (error) {
    console.error('Error rendering sessions:', error);
    emptyState.innerHTML = `
      <div class="sessions-empty-state">
        <div class="sessions-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
          </svg>
        </div>
        <p class="sessions-empty-title">${t('terminals.noTerminals')}</p>
        <p class="sessions-empty-hint">${t('terminals.createHint')}</p>
      </div>`;
  }
}

/**
 * Resume a Claude session
 */
async function resumeSession(project, sessionId, options = {}) {
  const { skipPermissions = false } = options;
  const result = await api.terminal.create({
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
        callbacks.onNotification(`❌ ${t('common.error')}`, result.error || t('terminals.resumeError'), null);
      }
      return null;
    }
    var id = result.id;
  } else {
    // Backwards compatibility with old format (just id)
    var id = result;
  }

  const terminalThemeId = getSetting('terminalTheme') || 'claude';
  const terminal = new Terminal({
    theme: getTerminalTheme(terminalThemeId),
    fontFamily: TERMINAL_FONTS.claude.fontFamily,
    fontSize: TERMINAL_FONTS.claude.fontSize,
    cursorBlink: true,
    scrollback: 5000
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const projectIndex = getProjectIndex(project.id);
  const termData = {
    terminal,
    fitAddon,
    project,
    projectIndex,
    name: t('terminals.resuming'),
    status: 'working',
    inputBuffer: '',
    isBasic: false
  };

  addTerminal(id, termData);

  // Start time tracking for this project
  startTracking(project.id);

  // Create tab
  const tabsContainer = document.getElementById('terminals-tabs');
  const tab = document.createElement('div');
  tab.className = 'terminal-tab status-working';
  tab.dataset.id = id;
  tab.innerHTML = `
    <span class="status-dot"></span>
    <span class="tab-name">${escapeHtml(t('terminals.resuming'))}</span>
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
  loadWebglAddon(terminal);
  setTimeout(() => fitAddon.fit(), 100);
  setActiveTerminal(id);

  // Prevent double-paste issue
  setupPasteHandler(wrapper, id, 'terminal-input');

  // Custom key handler for global shortcuts and copy/paste
  terminal.attachCustomKeyEventHandler(createTerminalKeyHandler(terminal, id, 'terminal-input'));

  // Title change handling (adaptive debounce + tool/task detection)
  let lastTitle = '';
  terminal.onTitleChange(title => {
    if (title === lastTitle) return;
    lastTitle = title;
    handleClaudeTitleChange(id, title);
  });

  // IPC handlers via centralized dispatcher
  registerTerminalHandler(id,
    (data) => {
      terminal.write(data.data);
      resetOutputSilenceTimer(id);
      const td = getTerminal(id);
      if (td?.project?.id) throttledRecordOutputActivity(td.project.id);
    },
    () => closeTerminal(id)
  );

  // Store handlers for cleanup
  const storedResumeTermData = getTerminal(id);
  if (storedResumeTermData) {
    storedResumeTermData.handlers = { unregister: () => unregisterTerminalHandler(id) };
  }

  // Input handling
  terminal.onData(data => {
    api.terminal.input({ id, data });
    // Record activity for time tracking (resets idle timer)
    const td = getTerminal(id);
    if (td?.project?.id) throttledRecordActivity(td.project.id);
    if (data === '\r' || data === '\n') {
      cancelScheduledReady(id);
      updateTerminalStatus(id, 'working');
      if (td && td.inputBuffer.trim().length > 0) {
        postEnterExtended.add(id);
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
    api.terminal.resize({ id, cols: terminal.cols, rows: terminal.rows });
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
  const result = await api.terminal.create({
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

  const terminalThemeId = getSetting('terminalTheme') || 'claude';
  const terminal = new Terminal({
    theme: getTerminalTheme(terminalThemeId),
    fontFamily: TERMINAL_FONTS.claude.fontFamily,
    fontSize: TERMINAL_FONTS.claude.fontSize,
    cursorBlink: true,
    scrollback: 5000
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const projectIndex = getProjectIndex(project.id);
  const termData = {
    terminal,
    fitAddon,
    project,
    projectIndex,
    name: `🐛 ${t('terminals.debug')}`,
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
    <span class="tab-name">${escapeHtml(`🐛 ${t('terminals.debug')}`)}</span>
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
  loadWebglAddon(terminal);
  setTimeout(() => fitAddon.fit(), 100);
  setActiveTerminal(id);

  // Prevent double-paste issue
  setupPasteHandler(wrapper, id, 'terminal-input');

  // Custom key handler
  terminal.attachCustomKeyEventHandler(createTerminalKeyHandler(terminal, id, 'terminal-input'));

  // Title change handling (adaptive debounce + pending prompt for quick actions)
  let lastTitle = '';
  let promptSent = false;
  terminal.onTitleChange(title => {
    if (title === lastTitle) return;
    lastTitle = title;
    handleClaudeTitleChange(id, title, {
      onPendingPrompt: () => {
        const td = getTerminal(id);
        if (td && td.pendingPrompt && !promptSent) {
          promptSent = true;
          setTimeout(() => {
            api.terminal.input({ id, data: td.pendingPrompt + '\r' });
            updateTerminal(id, { pendingPrompt: null });
            postEnterExtended.add(id);
            cancelScheduledReady(id);
            updateTerminalStatus(id, 'working');
          }, 500);
          return true;
        }
        return false;
      }
    });
  });

  // IPC handlers via centralized dispatcher
  registerTerminalHandler(id,
    (data) => {
      terminal.write(data.data);
      resetOutputSilenceTimer(id);
    },
    () => closeTerminal(id)
  );

  // Store handlers for cleanup
  const storedTermData = getTerminal(id);
  if (storedTermData) {
    storedTermData.handlers = { unregister: () => unregisterTerminalHandler(id) };
  }

  // Input handling
  terminal.onData(data => {
    api.terminal.input({ id, data });
    const td = getTerminal(id);
    if (data === '\r' || data === '\n') {
      cancelScheduledReady(id);
      updateTerminalStatus(id, 'working');
      if (td && td.inputBuffer.trim().length > 0) {
        postEnterExtended.add(id);
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
    api.terminal.resize({ id, cols: terminal.cols, rows: terminal.rows });
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

/**
 * Open a file as a tab in the terminal area
 * @param {string} filePath - Absolute path to the file
 * @param {Object} project - Project object
 */
function openFileTab(filePath, project) {
  // Check if file is already open → switch to existing tab
  const terminals = terminalsState.get().terminals;
  let existingId = null;
  terminals.forEach((td, id) => {
    if (td.type === 'file' && td.filePath === filePath) {
      existingId = id;
    }
  });
  if (existingId) {
    setActiveTerminal(existingId);
    return existingId;
  }

  const id = `file-${Date.now()}`;
  const fileName = path.basename(filePath);
  const ext = fileName.lastIndexOf('.') !== -1 ? fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase() : '';
  const projectIndex = project ? getProjectIndex(project.id) : null;

  // Detect file type
  const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'avif']);
  const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogg', 'mov']);
  const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'wma']);
  const isImage = IMAGE_EXTENSIONS.has(ext);
  const isVideo = VIDEO_EXTENSIONS.has(ext);
  const isAudio = AUDIO_EXTENSIONS.has(ext);
  const isMedia = isImage || isVideo || isAudio;

  // Read file content (skip for binary/media files)
  let content = '';
  let fileSize = 0;
  try {
    const stat = fs.statSync(filePath);
    fileSize = stat.size;
    if (!isMedia) {
      content = fs.readFileSync(filePath, 'utf-8');
    }
  } catch (e) {
    content = `Error reading file: ${e.message}`;
  }

  // Format file size
  let sizeStr;
  if (fileSize < 1024) sizeStr = `${fileSize} B`;
  else if (fileSize < 1024 * 1024) sizeStr = `${(fileSize / 1024).toFixed(1)} KB`;
  else sizeStr = `${(fileSize / (1024 * 1024)).toFixed(1)} MB`;

  // Store in terminals Map
  const termData = {
    type: 'file',
    filePath,
    project,
    projectIndex,
    name: fileName,
    status: 'ready'
  };
  addTerminal(id, termData);

  // Create tab
  const tabsContainer = document.getElementById('terminals-tabs');
  const tab = document.createElement('div');
  tab.className = 'terminal-tab file-tab status-ready';
  tab.dataset.id = id;
  const fileIcon = getFileIcon(fileName, false, false);
  tab.innerHTML = `
    <span class="file-tab-icon">${fileIcon}</span>
    <span class="tab-name">${escapeHtml(fileName)}</span>
    <button class="tab-close"><svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></button>`;
  tabsContainer.appendChild(tab);

  // Create wrapper
  const container = document.getElementById('terminals-container');
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper file-wrapper';
  wrapper.dataset.id = id;

  // Build content based on file type
  let viewerBody;
  const fileUrl = `file:///${filePath.replace(/\\/g, '/').replace(/^\//, '')}`;

  if (isImage) {
    viewerBody = `
    <div class="file-viewer-media">
      <img src="${fileUrl}" alt="${escapeHtml(fileName)}" draggable="false" />
    </div>`;
  } else if (isVideo) {
    viewerBody = `
    <div class="file-viewer-media">
      <video controls src="${fileUrl}"></video>
    </div>`;
  } else if (isAudio) {
    viewerBody = `
    <div class="file-viewer-media file-viewer-media-audio">
      <svg viewBox="0 0 24 24" fill="currentColor" width="64" height="64" style="opacity:0.3"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
      <audio controls src="${fileUrl}"></audio>
    </div>`;
  } else {
    // Text file: syntax highlight
    const highlightedContent = highlight(content, ext);
    const lineCount = content.split('\n').length;
    const lines = content.split('\n');
    const lineNums = lines.map((_, i) => `<span class="line-num">${i + 1}</span>`).join('\n');

    viewerBody = `
    <div class="file-viewer-content">
      <div class="file-viewer-lines">${lineNums}</div>
      <pre class="file-viewer-code"><code>${highlightedContent}</code></pre>
    </div>`;

    sizeStr += ` &middot; ${lineCount} lines`;
  }

  wrapper.innerHTML = `
    <div class="file-viewer-header">
      <span class="file-viewer-icon">${fileIcon}</span>
      <span class="file-viewer-name">${escapeHtml(fileName)}</span>
      <span class="file-viewer-meta">${sizeStr}</span>
      <span class="file-viewer-path" title="${escapeHtml(filePath)}">${escapeHtml(filePath)}</span>
    </div>
    ${viewerBody}
  `;

  container.appendChild(wrapper);
  document.getElementById('empty-terminals').style.display = 'none';

  setActiveTerminal(id);

  // Tab events
  tab.onclick = (e) => { if (!e.target.closest('.tab-close') && !e.target.closest('.tab-name-input')) setActiveTerminal(id); };
  tab.querySelector('.tab-name').ondblclick = (e) => { e.stopPropagation(); startRenameTab(id); };
  tab.querySelector('.tab-close').onclick = (e) => { e.stopPropagation(); closeTerminal(id); };

  // Enable drag & drop reordering
  setupTabDragDrop(tab);

  // Filter and render
  const selectedFilter = projectsState.get().selectedProjectFilter;
  filterByProject(selectedFilter);
  if (callbacks.onRenderProjects) callbacks.onRenderProjects();

  return id;
}

/**
 * Update theme for all existing terminals
 * @param {string} themeId - Theme identifier
 */
function updateAllTerminalsTheme(themeId) {
  const theme = getTerminalTheme(themeId);
  const terminals = terminalsState.get().terminals;

  terminals.forEach((termData, id) => {
    if (termData.terminal && termData.terminal.options) {
      termData.terminal.options.theme = theme;
    }
  });
}

/**
 * Get list of visible terminal IDs based on current project filter
 * @returns {Array} Array of terminal IDs
 */
function getVisibleTerminalIds() {
  const allTerminals = terminalsState.get().terminals;
  const currentFilter = projectsState.get().selectedProjectFilter;
  const projects = projectsState.get().projects;
  const filterProject = projects[currentFilter];

  const visibleTerminals = [];
  allTerminals.forEach((termData, id) => {
    const isVisible = currentFilter === null ||
      (filterProject && termData.project && termData.project.path === filterProject.path);
    if (isVisible) {
      visibleTerminals.push(id);
    }
  });

  return visibleTerminals;
}

/**
 * Focus the next terminal in the list
 */
function focusNextTerminal() {
  const visibleTerminals = getVisibleTerminalIds();
  if (visibleTerminals.length === 0) return;

  const currentId = terminalsState.get().activeTerminal;
  const currentIndex = visibleTerminals.indexOf(currentId);

  let targetIndex;
  if (currentIndex === -1) {
    targetIndex = 0;
  } else {
    targetIndex = (currentIndex + 1) % visibleTerminals.length;
  }

  setActiveTerminal(visibleTerminals[targetIndex]);
}

/**
 * Focus the previous terminal in the list
 */
function focusPrevTerminal() {
  const visibleTerminals = getVisibleTerminalIds();
  if (visibleTerminals.length === 0) return;

  const currentId = terminalsState.get().activeTerminal;
  const currentIndex = visibleTerminals.indexOf(currentId);

  let targetIndex;
  if (currentIndex === -1) {
    targetIndex = 0;
  } else {
    targetIndex = (currentIndex - 1 + visibleTerminals.length) % visibleTerminals.length;
  }

  setActiveTerminal(visibleTerminals[targetIndex]);
}

module.exports = {
  createTerminal,
  closeTerminal,
  setActiveTerminal,
  filterByProject,
  countTerminalsForProject,
  getTerminalStatsForProject,
  showAll,
  setCallbacks,
  updateTerminalStatus,
  resumeSession,
  updateAllTerminalsTheme,
  // Terminal navigation
  focusNextTerminal,
  focusPrevTerminal,
  // File tab functions
  openFileTab,
  // FiveM console functions
  createFivemConsole,
  closeFivemConsole,
  getFivemConsoleTerminal,
  writeFivemConsole,
  // FiveM error handling
  addFivemErrorToConsole,
  showFivemErrorOverlay,
  hideErrorOverlay,
  // WebApp console functions
  createWebAppConsole,
  closeWebAppConsole,
  getWebAppConsoleTerminal,
  writeWebAppConsole
};
