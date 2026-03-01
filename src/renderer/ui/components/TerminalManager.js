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
  getFivemErrors,
  clearFivemErrors,
  getFivemResources,
  setFivemResourcesLoading,
  setFivemResources,
  getResourceShortcut,
  setResourceShortcut,
  findResourceByShortcut,
  getSetting,
  setSetting,
  heartbeat,
  stopProject
} = require('../../state');
const { Marked } = require('marked');
const { escapeHtml, getFileIcon, highlight } = require('../../utils');
const { t, getCurrentLanguage } = require('../../i18n');
const {
  CLAUDE_TERMINAL_THEME,
  TERMINAL_FONTS,
  getTerminalTheme
} = require('../themes/terminal-themes');
const registry = require('../../../project-types/registry');
const { createChatView } = require('./ChatView');
const { showContextMenu } = require('./ContextMenu');
const PaneManager = require('./PaneManager');
const ContextPromptService = require('../../services/ContextPromptService');

// Lazy require to avoid circular dependency
let QuickActions = null;
function getQuickActions() {
  if (!QuickActions) {
    QuickActions = require('./QuickActions');
  }
  return QuickActions;
}

// ── Scraping event callback (set by ScrapingProvider) ──
let scrapingEventCallback = null;
function setScrapingCallback(cb) { scrapingEventCallback = cb; }

// Store FiveM console IDs by project index
const fivemConsoleIds = new Map();

// Store WebApp console IDs by project index
const webappConsoleIds = new Map();

// Store API console IDs by project index
const apiConsoleIds = new Map();

// Track error overlays by projectIndex
const errorOverlays = new Map();

// ── Generic type console tracking ──
// Key: "${typeId}-${projectIndex}" -> consoleId
const typeConsoleIds = new Map();

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
  if (scrapingEventCallback) scrapingEventCallback(id, 'done', {});
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
 * Returns true when an OSC title rename should be skipped because the tab was
 * renamed to a slash command by the user's setting.
 * Uses the module-level getSetting import to avoid any circular dependency issues.
 * @param {string|number} id - Terminal ID
 */
function shouldSkipOscRename(id) {
  if (!getSetting('tabRenameOnSlashCommand')) return false;
  const td = getTerminal(id);
  return !!(td && td.name && td.name.startsWith('/'));
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
      if (!shouldSkipOscRename(id) && getSetting('aiTabNaming') !== false) {
        updateTerminalTabName(id, parsed.taskName);
      }
    }

    updateTerminalStatus(id, 'working');
    if (scrapingEventCallback) scrapingEventCallback(id, 'working', { tool: parsed.tool || null });

  } else if (title.includes('\u2733')) {
    // ── Ready candidate: Claude may be done ──
    const parsed = parseClaudeTitle(title);
    if (parsed.taskName) {
      if (!terminalContext.has(id)) terminalContext.set(id, { taskName: null, lastTool: null, toolCount: 0, duration: null });
      terminalContext.get(id).taskName = parsed.taskName;
      if (!shouldSkipOscRename(id) && getSetting('aiTabNaming') !== false) {
        updateTerminalTabName(id, parsed.taskName);
      }
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


/**
 * Setup paste handler to prevent double-paste issue
 * xterm.js + Electron can trigger paste twice, so we handle it manually
 * @param {HTMLElement} wrapper - Terminal wrapper element
 * @param {string|number} terminalId - Terminal ID for IPC
 * @param {string} inputChannel - IPC channel for input
 */
/**
 * Setup DOM-level clipboard shortcuts (capture phase, before xterm intercepts)
 * xterm.js 6.x handles Ctrl+Shift+V internally but fails in Electron — we must intercept first.
 */
function setupClipboardShortcuts(wrapper, terminal, terminalId, inputChannel = 'terminal-input') {
  wrapper.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || !e.shiftKey) return;
    // Don't intercept if focus is on a textarea/input — let native paste work
    const tag = document.activeElement?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;

    if (e.key === 'V') {
      e.preventDefault();
      e.stopImmediatePropagation();
      performPaste(terminalId, inputChannel);
    } else if (e.key === 'C') {
      const selection = terminal.getSelection();
      if (selection) {
        e.preventDefault();
        e.stopImmediatePropagation();
        navigator.clipboard.writeText(selection).catch(() => api.app.clipboardWrite(selection));
        terminal.clearSelection();
      }
    }
  }, true); // capture phase — runs before xterm
}

function setupPasteHandler(wrapper, terminalId, inputChannel = 'terminal-input') {
  wrapper.addEventListener('paste', (e) => {
    e.preventDefault();
    e.stopPropagation();
    performPaste(terminalId, inputChannel);
  }, true);
}

/**
 * Add right-click handler to a terminal wrapper element.
 * Priority chain (settings-gated):
 *   1. rightClickCopyPaste (Windows Terminal style) — copy if selection, else paste
 *   2. rightClickPaste (legacy Phase 02) — instant paste when terminalContextMenu is off
 *   3. Context menu — when terminalContextMenu setting is true
 */
function setupRightClickHandler(wrapper, terminal, terminalId, inputChannel = 'terminal-input') {
  wrapper.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const ts = getSetting('terminalShortcuts') || {};

    // Priority 1: Windows Terminal copy-or-paste (disabled by default)
    if (ts.rightClickCopyPaste?.enabled) {
      const selection = terminal.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection)
          .catch(() => api.app.clipboardWrite(selection));
        terminal.clearSelection();
      } else {
        performPaste(terminalId, inputChannel);
      }
      return;
    }

    // Priority 2: Legacy instant paste (Phase 02 behavior, enabled by default)
    if (ts.rightClickPaste?.enabled !== false && !getSetting('terminalContextMenu')) {
      performPaste(terminalId, inputChannel);
      return;
    }

    // Priority 3: Context menu (when terminalContextMenu setting is true)
    if (getSetting('terminalContextMenu')) {
      const selection = terminal.getSelection();
      showContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: t('common.copy'),
            shortcut: 'Ctrl+C',
            icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>',
            disabled: !selection,
            onClick: () => {
              if (selection) {
                navigator.clipboard.writeText(selection)
                  .catch(() => api.app.clipboardWrite(selection));
                terminal.clearSelection();
              }
            }
          },
          {
            label: t('common.paste'),
            shortcut: 'Ctrl+V',
            icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
            onClick: () => performPaste(terminalId, inputChannel)
          },
          { separator: true },
          {
            label: t('common.selectAll'),
            shortcut: 'Ctrl+Shift+A',
            icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h18v18H3z"/><path d="M8 8h8v8H8z" fill="currentColor" opacity="0.3"/></svg>',
            onClick: () => terminal.selectAll()
          }
        ]
      });
    }
  });
}

/**
 * Create a custom key event handler for terminal shortcuts
 * @param {Terminal} terminal - The xterm.js terminal instance
 * @param {string|number} terminalId - Terminal ID for IPC
 * @param {string} inputChannel - IPC channel for input (default: 'terminal-input')
 * @returns {Function} Key event handler
 */
/**
 * Normalize a stored key string (e.g. "Ctrl+Shift+C") to lowercase+sorted form
 * for comparison with event-derived keys.
 */
function normalizeStoredKey(key) {
  if (!key) return '';
  return key
    .toLowerCase()
    .replace(/\s+/g, '')
    .split('+')
    .sort((a, b) => {
      const order = ['ctrl', 'alt', 'shift', 'meta'];
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return 0;
    })
    .join('+');
}

/**
 * Derive a normalized key string from a keyboard event (mirrors getKeyFromEvent + normalizeKey).
 */
function eventToNormalizedKey(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  if (e.metaKey) parts.push('meta');
  let key = e.key.toLowerCase();
  if (key === ' ') key = 'space';
  if (key === 'arrowup') key = 'up';
  if (key === 'arrowdown') key = 'down';
  if (key === 'arrowleft') key = 'left';
  if (key === 'arrowright') key = 'right';
  if (!['ctrl', 'alt', 'shift', 'meta', 'control'].includes(key)) {
    parts.push(key);
  }
  return parts.join('+');
}

function createTerminalKeyHandler(terminal, terminalId, inputChannel = 'terminal-input') {
  return (e) => {
    // Check rebound terminal shortcuts (ctrlC / ctrlV) at call-time — read from settings
    if (e.ctrlKey && e.type === 'keydown') {
      const ts = getSetting('terminalShortcuts') || {};
      const eventKey = eventToNormalizedKey(e);

      // Rebound ctrlC — fire copy on the custom key instead of Ctrl+C
      const ctrlCCustomKey = ts.ctrlC?.key;
      if (ctrlCCustomKey && ctrlCCustomKey !== 'Ctrl+C') {
        if (eventKey === normalizeStoredKey(ctrlCCustomKey) && ts.ctrlC?.enabled !== false) {
          const selection = terminal.getSelection();
          if (selection) {
            navigator.clipboard.writeText(selection)
              .catch(() => api.app.clipboardWrite(selection));
            terminal.clearSelection();
            return false;
          }
          return true;
        }
      }

      // Rebound ctrlV — fire paste on the custom key instead of Ctrl+V
      const ctrlVCustomKey = ts.ctrlV?.key;
      if (ctrlVCustomKey && ctrlVCustomKey !== 'Ctrl+V') {
        if (eventKey === normalizeStoredKey(ctrlVCustomKey) && ts.ctrlV?.enabled !== false) {
          performPaste(terminalId, inputChannel);
          return false;
        }
      }
    }

    // Shift+Enter — send newline for multiline input (e.g., Claude CLI)
    if (e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'Enter' && e.type === 'keydown') {
      if (inputChannel === 'fivem-input') {
        api.fivem.input({ projectIndex: terminalId, data: '\n' });
      } else if (inputChannel === 'webapp-input') {
        api.webapp.input({ projectIndex: terminalId, data: '\n' });
      } else {
        api.terminal.input({ id: terminalId, data: '\n' });
      }
      return false;
    }

    // Ctrl+Up/Down to switch projects - handle directly with debounce
    // xterm.js can trigger the handler multiple times, so we debounce
    // Note: Ctrl+Tab/Ctrl+Shift+Tab for terminal switching is handled via main process IPC
    // Note: Ctrl+Left/Right send word-jump escape sequences to PTY (TERM-03)
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.repeat && e.type === 'keydown') {
      const isArrowKey = ['ArrowUp', 'ArrowDown'].includes(e.key);
      if (isArrowKey) {
        const now = Date.now();
        if (now - lastArrowTime < ARROW_DEBOUNCE_MS) {
          return false;
        }
        lastArrowTime = now;

        if (e.key === 'ArrowUp' && callbacks.onSwitchProject) {
          callbacks.onSwitchProject('up');
          return false;
        }
        if (e.key === 'ArrowDown' && callbacks.onSwitchProject) {
          callbacks.onSwitchProject('down');
          return false;
        }
      }

      // Ctrl+Backspace — delete previous word (TERM-05)
      // Send ASCII ETB (0x17 = Ctrl+W) which is the standard word-rubout signal
      // recognized by readline, PowerShell PSReadLine, and most shell line editors.
      if (e.key === 'Backspace') {
        if (inputChannel === 'terminal-input') {
          api.terminal.input({ id: terminalId, data: '\x17' });
          return false;
        }
        return true; // FiveM/WebApp — fall through to default behavior
      }

      // Ctrl+C — selection-gated copy (TERM-01), settings-gated with rebound key support
      {
        const ts = getSetting('terminalShortcuts') || {};
        const ctrlCRebound = ts.ctrlC?.key && ts.ctrlC.key !== 'Ctrl+C';
        if (ctrlCRebound) {
          // When Ctrl+C is rebound, the original Ctrl+C always passes SIGINT
          if (e.key.toLowerCase() === 'c') {
            return true; // rebound — pass SIGINT through to PTY
          }
        } else if (e.key.toLowerCase() === 'c') {
          if (ts.ctrlC?.enabled === false) {
            return true; // disabled — pass SIGINT through to PTY
          }
          const selection = terminal.getSelection();
          if (selection) {
            navigator.clipboard.writeText(selection)
              .catch(() => api.app.clipboardWrite(selection));
            terminal.clearSelection();
            return false; // suppress xterm — we handled the copy
          }
          return true; // no selection → let xterm send SIGINT to PTY
        }
      }

      // Ctrl+V — paste with debounce and inputChannel routing (TERM-02), settings-gated with rebound key support
      {
        const ts = getSetting('terminalShortcuts') || {};
        const ctrlVRebound = ts.ctrlV?.key && ts.ctrlV.key !== 'Ctrl+V';
        if (!ctrlVRebound && e.key.toLowerCase() === 'v') {
          if (ts.ctrlV?.enabled !== false) {
            performPaste(terminalId, inputChannel);
          }
          return false;
        }
      }

      // Ctrl+Left / Ctrl+Right — word-jump (TERM-03), settings-gated
      // Only send VT escape sequences for real PTY terminals, not FiveM/WebApp consoles.
      if (e.key === 'ArrowLeft') {
        if (inputChannel === 'terminal-input') {
          const ts = getSetting('terminalShortcuts') || {};
          if (ts.ctrlArrow?.enabled === false) return true; // disabled — pass through to PTY
          api.terminal.input({ id: terminalId, data: '\x1b[1;5D' });
          return false;
        }
        return true; // FiveM/WebApp — fall through to default behavior
      }
      if (e.key === 'ArrowRight') {
        if (inputChannel === 'terminal-input') {
          const ts = getSetting('terminalShortcuts') || {};
          if (ts.ctrlArrow?.enabled === false) return true; // disabled — pass through to PTY
          api.terminal.input({ id: terminalId, data: '\x1b[1;5C' });
          return false;
        }
        return true; // FiveM/WebApp — fall through to default behavior
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
    // Ctrl+Shift+A: select all terminal content
    if (e.ctrlKey && e.shiftKey && e.key === 'A' && e.type === 'keydown') {
      terminal.selectAll();
      return false;
    }
    // Ctrl+Shift+C to copy selection
    if (e.ctrlKey && e.shiftKey && e.key === 'C' && e.type === 'keydown') {
      const selection = terminal.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection).catch(() => api.app.clipboardWrite(selection));
        terminal.clearSelection();
      }
      return false;
    }
    // Ctrl+Shift+V to paste (with anti-spam)
    if (e.ctrlKey && e.shiftKey && e.key === 'V' && e.type === 'keydown') {
      performPaste(terminalId, inputChannel);
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
    PaneManager.setDragTabId(tab.dataset.id);

    // Create placeholder
    dragPlaceholder = document.createElement('div');
    dragPlaceholder.className = 'terminal-tab-placeholder';
  });

  tab.addEventListener('dragend', () => {
    tab.classList.remove('dragging');
    draggedTab = null;
    PaneManager.clearDragTabId();
    PaneManager.hideAllDropOverlays();
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
    e.stopPropagation(); // prevent content-area handler
    tab.classList.remove('drag-over-left', 'drag-over-right');

    if (!draggedTab || draggedTab === tab) return;

    const targetTabsContainer = tab.closest('.pane-tabs');
    const sourceTabsContainer = draggedTab.closest('.pane-tabs');

    const rect = tab.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const insertBefore = e.clientX < midX;

    // Cross-pane tab-bar drop: move tab to target pane
    if (sourceTabsContainer !== targetTabsContainer) {
      const targetPaneEl = tab.closest('.split-pane');
      const targetPaneId = 'pane-' + targetPaneEl.dataset.paneId;
      const draggedId = draggedTab.dataset.id;

      // Move wrapper to target pane's content
      const wrapperEl = document.querySelector(`.terminal-wrapper[data-id="${draggedId}"]`);
      const targetContentEl = targetPaneEl.querySelector('.pane-content');
      if (wrapperEl && targetContentEl) targetContentEl.appendChild(wrapperEl);

      // Insert tab at correct position in target tab bar
      if (insertBefore) {
        targetTabsContainer.insertBefore(draggedTab, tab);
      } else {
        targetTabsContainer.insertBefore(draggedTab, tab.nextSibling);
      }

      // Update PaneManager state
      const sourcePaneEl = sourceTabsContainer.closest('.split-pane');
      const sourcePaneId = 'pane-' + sourcePaneEl.dataset.paneId;
      const sourcePane = PaneManager.getPanes().get(sourcePaneId);
      const targetPane = PaneManager.getPanes().get(targetPaneId);

      if (sourcePane) sourcePane.tabs.delete(draggedId);
      if (targetPane) targetPane.tabs.add(draggedId);

      // Activate the moved tab
      setActiveTerminal(draggedId);

      // Collapse source pane if empty
      if (sourcePane && sourcePane.tabs.size === 0 && PaneManager.getPaneCount() > 1) {
        PaneManager.collapsePane(sourcePaneId);
      }
    } else {
      // Same pane: reorder (existing behavior)
      if (insertBefore) {
        targetTabsContainer.insertBefore(draggedTab, tab);
      } else {
        targetTabsContainer.insertBefore(draggedTab, tab.nextSibling);
      }
    }

    PaneManager.clearDragTabId();
    PaneManager.hideAllDropOverlays();
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
 * Dismiss loading overlay with fade-out animation
 */
function dismissLoadingOverlay(id) {
  const wrapper = document.querySelector(`.terminal-wrapper[data-id="${id}"]`);
  const overlay = wrapper?.querySelector('.terminal-loading-overlay');
  if (overlay) {
    overlay.classList.add('fade-out');
    setTimeout(() => overlay.remove(), 300);
  }
}

// Safety timeout IDs for loading overlays
const loadingTimeouts = new Map();

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
      tab.classList.remove('status-working', 'status-ready', 'status-loading', 'substatus-thinking', 'substatus-tool', 'substatus-waiting');
      tab.classList.add(`status-${status}`);
      if (status === 'working') {
        const sub = terminalSubstatus.get(id);
        if (sub === 'tool_calling') tab.classList.add('substatus-tool');
        else if (sub === 'waiting') tab.classList.add('substatus-waiting');
        else tab.classList.add('substatus-thinking');
      }
    }
    // Dismiss loading overlay when Claude is ready
    if (previousStatus === 'loading' && (status === 'ready' || status === 'working')) {
      dismissLoadingOverlay(id);
      const safetyTimeout = loadingTimeouts.get(id);
      if (safetyTimeout) {
        clearTimeout(safetyTimeout);
        loadingTimeouts.delete(id);
      }
    }
    if (status === 'ready' && previousStatus === 'working') {
      // Skip scraping notifications when hooks are active (bus consumer handles it with richer data)
      const hooksActive = (() => { try { return require('../../events').getActiveProvider() === 'hooks'; } catch (e) { return false; } })();
      if (!hooksActive && callbacks.onNotification) {
        const projectName = termData.project?.name || termData.name;
        const richCtx = terminalContext.get(id);
        let notifTitle = projectName || 'Claude Terminal';
        let body;

        if (richCtx?.toolCount > 0) {
          body = t('terminals.notifToolsDone', { count: richCtx.toolCount });
        } else {
          body = t('terminals.notifDone');
        }

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
 * Update chat terminal status with substatus support.
 * Unlike regular terminals (scraping-based), chat terminals have precise
 * state info from the SDK, so we can update substatus independently.
 */
function updateChatTerminalStatus(id, status, substatus) {
  // Update substatus map
  if (substatus) {
    terminalSubstatus.set(id, substatus);
  } else {
    terminalSubstatus.delete(id);
  }

  const termData = getTerminal(id);
  if (!termData) return;

  const tab = document.querySelector(`.terminal-tab[data-id="${id}"]`);

  if (termData.status !== status) {
    // Main status changed — delegate to updateTerminalStatus (handles notifications, re-render, etc.)
    updateTerminalStatus(id, status);
  } else if (tab && status === 'working') {
    // Same status but substatus changed — update tab CSS directly
    tab.classList.remove('substatus-thinking', 'substatus-tool', 'substatus-waiting');
    if (substatus === 'tool_calling') {
      tab.classList.add('substatus-tool');
    } else if (substatus === 'waiting') {
      tab.classList.add('substatus-waiting');
    } else {
      tab.classList.add('substatus-thinking');
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
 * Show right-click context menu on a tab (Rename, Close, Close Others, Close to Right)
 */
function showTabContextMenu(e, id) {
  e.preventDefault();
  e.stopPropagation();

  const thisTab = document.querySelector(`.terminal-tab[data-id="${id}"]`);
  const tabsContainer = thisTab?.closest('.pane-tabs');
  const allTabs = tabsContainer ? Array.from(tabsContainer.querySelectorAll('.terminal-tab')) : [];
  const thisIndex = allTabs.indexOf(thisTab);
  const tabsToRight = allTabs.slice(thisIndex + 1);

  showContextMenu({
    x: e.clientX,
    y: e.clientY,
    items: [
      {
        label: t('tabs.rename'),
        shortcut: 'Double-click',
        icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
        onClick: () => startRenameTab(id)
      },
      { separator: true },
      {
        label: t('tabs.close'),
        icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
        onClick: () => closeTerminal(id)
      },
      {
        label: t('tabs.closeOthers'),
        icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
        disabled: allTabs.length <= 1,
        onClick: () => {
          allTabs.forEach(tab => {
            const tabId = tab.dataset.id;
            if (tabId != id) closeTerminal(tabId);
          });
        }
      },
      {
        label: t('tabs.closeToRight'),
        icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
        disabled: tabsToRight.length === 0,
        onClick: () => {
          tabsToRight.forEach(tab => closeTerminal(tab.dataset.id));
        }
      },
      { separator: true },
      {
        label: t('tabs.splitRight'),
        icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3 3h8v18H3V3zm10 0h8v18h-8V3z"/></svg>',
        disabled: PaneManager.getPaneCount() >= 3,
        onClick: () => {
          const currentPaneId = PaneManager.getPaneForTab(String(id));
          const newPaneId = PaneManager.createPane(currentPaneId);
          if (newPaneId) {
            const sourceEmpty = PaneManager.moveTabToPane(String(id), newPaneId);
            setActiveTerminal(id);
            if (sourceEmpty) PaneManager.collapsePane(currentPaneId);
          }
        }
      },
      // Move items — only when multiple panes exist
      ...(PaneManager.getPaneCount() > 1 ? (() => {
        const order = PaneManager.getPaneOrder();
        const currentPaneId = PaneManager.getPaneForTab(String(id));
        const currentIdx = order.indexOf(currentPaneId);

        if (order.length === 2) {
          // 2 panes: simple Move Right / Move Left
          return [
            {
              label: t('tabs.moveLeft'),
              icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/></svg>',
              disabled: currentIdx === 0,
              onClick: () => {
                if (currentIdx > 0) {
                  const targetPaneId = order[currentIdx - 1];
                  const sourceEmpty = PaneManager.moveTabToPane(String(id), targetPaneId);
                  setActiveTerminal(id);
                  if (sourceEmpty) PaneManager.collapsePane(currentPaneId);
                }
              }
            },
            {
              label: t('tabs.moveRight'),
              icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>',
              disabled: currentIdx === order.length - 1,
              onClick: () => {
                if (currentIdx < order.length - 1) {
                  const targetPaneId = order[currentIdx + 1];
                  const sourceEmpty = PaneManager.moveTabToPane(String(id), targetPaneId);
                  setActiveTerminal(id);
                  if (sourceEmpty) PaneManager.collapsePane(currentPaneId);
                }
              }
            }
          ];
        } else {
          // 3 panes: specific pane targets
          return order
            .filter(pId => pId !== currentPaneId)
            .map((pId) => {
              const paneNum = order.indexOf(pId) + 1;
              return {
                label: t('tabs.moveToPane').replace('{0}', paneNum),
                icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3 3h8v18H3V3zm10 0h8v18h-8V3z"/></svg>',
                onClick: () => {
                  const sourceEmpty = PaneManager.moveTabToPane(String(id), pId);
                  setActiveTerminal(id);
                  if (sourceEmpty) PaneManager.collapsePane(currentPaneId);
                }
              };
            });
        }
      })() : [])
    ]
  });
}

/**
 * Set active terminal
 */
function setActiveTerminal(id) {
  // Get previous terminal's project for time tracking
  const prevActiveId = getActiveTerminal();
  const prevTermData = prevActiveId ? getTerminal(prevActiveId) : null;
  const prevProjectId = prevTermData?.project?.id;

  // Blur previous terminal so its hidden xterm textarea doesn't capture cursor/input
  if (prevTermData && prevTermData.terminal && prevActiveId !== id) {
    try { prevTermData.terminal.blur(); } catch (e) {}
  }

  setActiveTerminalState(id);

  const paneId = PaneManager.getPaneForTab(String(id));
  if (paneId) {
    const pane = PaneManager.getPanes().get(paneId);
    if (pane) {
      // Toggle active only within THIS pane's tab bar
      pane.tabsEl.querySelectorAll('.terminal-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.id == id));
      // Toggle active only within THIS pane's content
      pane.contentEl.querySelectorAll('.terminal-wrapper').forEach(w => {
        w.classList.toggle('active', w.dataset.id == id);
        w.style.removeProperty('display');
      });
      // Update pane's tracked active tab
      PaneManager.setPaneActiveTab(paneId, String(id));
    }
    // Set this pane as the focused pane
    PaneManager.setActivePaneId(paneId);
  } else {
    // Fallback for tabs not yet registered (edge case during init)
    document.querySelectorAll('.terminal-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.id == id));
    document.querySelectorAll('.terminal-wrapper').forEach(w => {
      w.classList.toggle('active', w.dataset.id == id);
      w.style.removeProperty('display');
    });
  }
  const termData = getTerminal(id);
  if (termData) {
    if (termData.mode === 'chat') {
      // Focus chat input
      if (termData.chatView) {
        termData.chatView.focus();
      }
    } else if (termData.type !== 'file') {
      termData.fitAddon.fit();
      termData.terminal.focus();
    }

    // Handle project switch for time tracking
    const newProjectId = termData.project?.id;
    if (prevProjectId !== newProjectId) {
      if (newProjectId) heartbeat(newProjectId, 'terminal');
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

  // Delegate to type-specific close for console types
  if (termData && termData.type && typeConsoleIds.has(`${termData.type}-${closedProjectIndex}`)) {
    closeTypeConsole(id, closedProjectIndex, termData.type);
    return;
  }

  clearOutputSilenceTimer(id);
  cancelScheduledReady(id);
  postEnterExtended.delete(id);
  postSpinnerExtended.delete(id);
  // Clear loading safety timeout if still pending
  const safetyTimeout = loadingTimeouts.get(id);
  if (safetyTimeout) {
    clearTimeout(safetyTimeout);
    loadingTimeouts.delete(id);
  }
  terminalSubstatus.delete(id);
  lastTerminalData.delete(id);
  terminalContext.delete(id);
  errorOverlays.delete(closedProjectIndex);

  // Kill and cleanup
  if (termData && termData.mode === 'chat') {
    // Chat mode: destroy chat view and close SDK session
    if (termData.chatView) {
      termData.chatView.destroy();
    }
    removeTerminal(id);
  } else if (termData && termData.type === 'file') {
    // File tabs have no terminal process to kill; run markdown cleanup if set
    if (termData.mdCleanup) termData.mdCleanup();
    removeTerminal(id);
  } else {
    api.terminal.kill({ id });
    cleanupTerminalResources(termData);
    removeTerminal(id);
  }
  const emptyPaneId = PaneManager.unregisterTab(String(id));
  document.querySelector(`.terminal-tab[data-id="${id}"]`)?.remove();
  document.querySelector(`.terminal-wrapper[data-id="${id}"]`)?.remove();

  // Collapse pane if it's now empty (but not the last pane)
  if (emptyPaneId && PaneManager.getPaneCount() > 1) {
    PaneManager.collapsePane(emptyPaneId);
  }

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
    stopProject(closedProjectId);
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
  const { skipPermissions = false, runClaude = true, name: customName = null, mode: explicitMode = null, cwd: overrideCwd = null, initialPrompt = null, initialImages = null, initialModel = null, initialEffort = null, onSessionStart = null, resumeSessionId = null } = options;

  // Determine mode: explicit > setting > default
  const mode = explicitMode || (runClaude ? (getSetting('defaultTerminalMode') || 'terminal') : 'terminal');

  // Chat mode: skip PTY creation entirely
  if (mode === 'chat' && runClaude) {
    const chatProject = overrideCwd ? { ...project, path: overrideCwd } : project;
    return createChatTerminal(chatProject, { skipPermissions, name: customName, parentProjectId: overrideCwd ? project.id : null, initialPrompt, initialImages, initialModel, initialEffort, onSessionStart });
  }

  const result = await api.terminal.create({
    cwd: overrideCwd || project.path,
    runClaude,
    skipPermissions,
    ...(resumeSessionId ? { resumeSessionId } : {})
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
  const initialStatus = isBasicTerminal ? 'ready' : 'loading';
  const termData = {
    terminal,
    fitAddon,
    project,
    projectIndex,
    name: tabName,
    status: initialStatus,
    inputBuffer: '',
    isBasic: isBasicTerminal,
    mode: 'terminal',
    ...(initialPrompt ? { pendingPrompt: initialPrompt } : {}),
    ...(overrideCwd ? { parentProjectId: project.id } : {})
  };

  addTerminal(id, termData);

  // Start time tracking for this project
  heartbeat(project.id, 'terminal');

  // Create tab
  const tabsContainer = PaneManager.getTabsContainer();
  const tab = document.createElement('div');
  tab.className = `terminal-tab status-${initialStatus}${isBasicTerminal ? ' basic-terminal' : ''}`;
  tab.dataset.id = id;
  tab.tabIndex = 0;
  tab.setAttribute('role', 'tab');
  // Mode toggle button (only for Claude terminals, not basic)
  const modeToggleHtml = !isBasicTerminal ? `
    <button class="tab-mode-toggle" title="${escapeHtml(t('chat.switchToChat'))}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
    </button>` : '';

  tab.innerHTML = `
    <span class="status-dot"></span>
    <span class="tab-name">${escapeHtml(tabName)}</span>
    ${modeToggleHtml}
    <button class="tab-close"><svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></button>`;
  tabsContainer.appendChild(tab);

  // Create wrapper
  const container = PaneManager.getContentContainer();
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.dataset.id = id;
  container.appendChild(wrapper);
  PaneManager.registerTab(String(id), PaneManager.getDefaultPaneId());

  // Add loading overlay for Claude terminals
  if (!isBasicTerminal) {
    const overlay = document.createElement('div');
    overlay.className = 'terminal-loading-overlay';
    overlay.innerHTML = `
      <div class="terminal-loading-spinner"></div>
      <div class="terminal-loading-text">${escapeHtml(t('terminals.loading'))}</div>
      <div class="terminal-loading-hint">${escapeHtml(t('terminals.loadingHint'))}</div>`;
    wrapper.appendChild(overlay);
    // Safety timeout: dismiss after 30s even if ready detection fails
    loadingTimeouts.set(id, setTimeout(() => {
      loadingTimeouts.delete(id);
      dismissLoadingOverlay(id);
      const td = getTerminal(id);
      if (td && td.status === 'loading') {
        updateTerminalStatus(id, 'ready');
      }
    }, 30000));
  }

  document.getElementById('empty-terminals').style.display = 'none';

  terminal.open(wrapper);
  loadWebglAddon(terminal);
  setTimeout(() => fitAddon.fit(), 100);
  setActiveTerminal(id);

  // Prevent double-paste issue
  setupPasteHandler(wrapper, id, 'terminal-input');
  setupClipboardShortcuts(wrapper, terminal, id, 'terminal-input');

  // Custom key handler for global shortcuts and copy/paste
  terminal.attachCustomKeyEventHandler(createTerminalKeyHandler(terminal, id, 'terminal-input'));

  // Title change handling (adaptive debounce + tool/task detection + pending prompt)
  let lastTitle = '';
  let promptSent = false;
  terminal.onTitleChange(title => {
    if (title === lastTitle) return;
    lastTitle = title;
    handleClaudeTitleChange(id, title, initialPrompt ? {
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
    } : undefined);
  });

  // IPC data handling via centralized dispatcher
  registerTerminalHandler(id,
    (data) => {
      terminal.write(data.data);
      resetOutputSilenceTimer(id);
      const td = getTerminal(id);
      if (td?.project?.id) heartbeat(td.project.id, 'terminal');
    },
    () => closeTerminal(id)
  );

  // Store cleanup reference
  const storedTermData = getTerminal(id);
  if (storedTermData) {
    storedTermData.handlers = { unregister: () => unregisterTerminalHandler(id) };
  }

  // Resume failure watchdog — detects stale session IDs
  if (resumeSessionId) {
    const RESUME_WATCHDOG_MS = 20000;
    let resumeDataReceived = false;
    const checkDataInterval = setInterval(() => {
      const td = getTerminal(id);
      if (!td) { clearInterval(checkDataInterval); return; }
      if (td.terminal.buffer.active.length > 1) {
        resumeDataReceived = true;
        clearInterval(checkDataInterval);
      }
    }, 500);
    setTimeout(() => {
      clearInterval(checkDataInterval);
      const td = getTerminal(id);
      if (!td) return;
      if (resumeDataReceived) return;
      console.warn(`[TerminalManager] Resume watchdog fired for terminal ${id} (session ${resumeSessionId}) — starting fresh`);
      closeTerminal(id);
      createTerminal(project, {
        runClaude: true,
        cwd: overrideCwd || project.path,
        skipPermissions
      });
    }, RESUME_WATCHDOG_MS);
  }

  // Input handling
  terminal.onData(data => {
    api.terminal.input({ id, data });
    // Record activity for time tracking (resets idle timer)
    const td = getTerminal(id);
    if (td?.project?.id) heartbeat(td.project.id, 'terminal');
    if (data === '\r' || data === '\n') {
      cancelScheduledReady(id);
      updateTerminalStatus(id, 'working');
      if (scrapingEventCallback) scrapingEventCallback(id, 'input', {});
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
  tab.onclick = (e) => { if (!e.target.closest('.tab-close') && !e.target.closest('.tab-name-input') && !e.target.closest('.tab-mode-toggle')) setActiveTerminal(id); };
  tab.querySelector('.tab-name').ondblclick = (e) => { e.stopPropagation(); startRenameTab(id); };
  tab.querySelector('.tab-close').onclick = (e) => { e.stopPropagation(); closeTerminal(id); };
  tab.oncontextmenu = (e) => showTabContextMenu(e, id);

  // Mode toggle button
  const modeToggleBtn = tab.querySelector('.tab-mode-toggle');
  if (modeToggleBtn) {
    modeToggleBtn.onclick = (e) => { e.stopPropagation(); switchTerminalMode(id); };
  }

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
    createTerminal,
    setActiveTerminal,
    createTerminalWithPrompt,
    findChatTab: (projectPath, namePrefix) => {
      const terminals = terminalsState.get().terminals;
      for (const [id, td] of terminals) {
        if (td.mode === 'chat' && td.chatView && td.project?.path === projectPath && td.name?.startsWith(namePrefix)) {
          return { id, termData: td };
        }
      }
      return null;
    },
    buildDebugPrompt: (error) => {
      try {
        return require('../../../project-types/fivem/renderer/FivemConsoleManager').buildDebugPrompt(error, t);
      } catch (e) { return ''; }
    }
  };
}

// ════════════════════════════════════════════════════════════════════════════
// ── Generic Type Console API ──
// Replaces the 3 duplicated create/close/write/get functions
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get the console ID for a given type + projectIndex
 * @param {number} projectIndex
 * @param {string} typeId
 * @returns {string|undefined}
 */
function getTypeConsoleId(projectIndex, typeId) {
  return typeConsoleIds.get(`${typeId}-${projectIndex}`);
}

/**
 * Get the TmApi object passed to type modules to avoid circular deps.
 * @returns {Object}
 */
function getTmApi() {
  return {
    getTypeConsoleId,
    getTerminal,
    getTypePanelDeps,
    createTerminalWithPrompt,
    t,
    escapeHtml,
    projectsState,
    api
  };
}

/**
 * Create a type-specific console as a terminal tab (generic).
 * @param {Object} project
 * @param {number} projectIndex
 * @returns {string|null} Console ID
 */
function createTypeConsole(project, projectIndex) {
  const typeHandler = registry.get(project.type);
  const config = typeHandler.getConsoleConfig(project, projectIndex);
  if (!config) return null;

  const { typeId, tabIcon, tabClass, dotClass, wrapperClass, consoleViewSelector, ipcNamespace, scrollback, disableStdin } = config;

  // Check if console already exists
  const mapKey = `${typeId}-${projectIndex}`;
  const existingId = typeConsoleIds.get(mapKey);
  if (existingId && getTerminal(existingId)) {
    setActiveTerminal(existingId);
    return existingId;
  }

  const id = `${typeId}-${projectIndex}-${Date.now()}`;

  const themeId = getSetting('terminalTheme') || 'claude';
  const terminal = new Terminal({
    theme: getTerminalTheme(themeId),
    fontFamily: TERMINAL_FONTS[typeId]?.fontFamily || TERMINAL_FONTS.fivem.fontFamily,
    fontSize: TERMINAL_FONTS[typeId]?.fontSize || TERMINAL_FONTS.fivem.fontSize,
    cursorBlink: false,
    disableStdin: disableStdin === true,
    scrollback: scrollback || 10000
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const termData = {
    terminal,
    fitAddon,
    project,
    projectIndex,
    name: `${tabIcon} ${project.name}`,
    status: 'ready',
    type: typeId,
    inputBuffer: '',
    activeView: 'console'
  };

  addTerminal(id, termData);
  typeConsoleIds.set(mapKey, id);

  // Also sync to legacy Maps for backward compat during migration
  if (typeId === 'fivem') fivemConsoleIds.set(projectIndex, id);
  if (typeId === 'webapp') webappConsoleIds.set(projectIndex, id);
  if (typeId === 'api') apiConsoleIds.set(projectIndex, id);

  heartbeat(project.id, 'terminal');

  // Create tab
  const tabsContainer = PaneManager.getTabsContainer();
  const tab = document.createElement('div');
  tab.className = `terminal-tab ${tabClass} status-ready`;
  tab.dataset.id = id;
  tab.tabIndex = 0;
  tab.setAttribute('role', 'tab');
  tab.innerHTML = `
    <span class="status-dot ${dotClass}"></span>
    <span class="tab-name">${escapeHtml(`${tabIcon} ${project.name}`)}</span>
    <button class="tab-close"><svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></button>`;
  tabsContainer.appendChild(tab);

  // Create wrapper
  const container = PaneManager.getContentContainer();
  const wrapper = document.createElement('div');
  wrapper.className = `terminal-wrapper ${wrapperClass}`;
  wrapper.dataset.id = id;

  // Get panel HTML from type handler
  const panels = typeHandler.getTerminalPanels({ project, projectIndex });
  const panel = panels && panels.length > 0 ? panels[0] : null;
  if (panel) {
    wrapper.innerHTML = panel.getWrapperHtml();
  }

  container.appendChild(wrapper);
  PaneManager.registerTab(String(id), PaneManager.getDefaultPaneId());

  document.getElementById('empty-terminals').style.display = 'none';

  // Open terminal in console view container
  const consoleView = wrapper.querySelector(consoleViewSelector);
  terminal.open(consoleView);
  loadWebglAddon(terminal);
  setTimeout(() => fitAddon.fit(), 100);
  setActiveTerminal(id);

  // Prevent double-paste issue
  setupPasteHandler(consoleView, projectIndex, `${typeId}-input`);
  setupClipboardShortcuts(consoleView, terminal, projectIndex, `${typeId}-input`);

  // Write existing logs
  const existingLogs = config.getExistingLogs(projectIndex);
  if (existingLogs && existingLogs.length > 0) {
    terminal.write(existingLogs.join(''));
  }

  // Setup panel via type handler
  if (panel && panel.setupPanel) {
    const panelDeps = getTypePanelDeps(id, projectIndex);
    panel.setupPanel(wrapper, id, projectIndex, project, panelDeps);
  }

  // Custom key handler + input — only when stdin is enabled
  if (!disableStdin) {
    terminal.attachCustomKeyEventHandler(createTerminalKeyHandler(terminal, projectIndex, `${typeId}-input`));
    terminal.onData(data => {
      api[ipcNamespace].input({ projectIndex, data });
    });
  }

  // Resize handling
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    api[ipcNamespace].resize({
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
  api[ipcNamespace].resize({
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
  tab.querySelector('.tab-close').onclick = (e) => { e.stopPropagation(); closeTypeConsole(id, projectIndex, typeId); };
  tab.oncontextmenu = (e) => showTabContextMenu(e, id);

  setupTabDragDrop(tab);

  return id;
}

/**
 * Close a type-specific console (generic).
 * @param {string} id - Console terminal ID
 * @param {number} projectIndex
 * @param {string} typeId
 */
function closeTypeConsole(id, projectIndex, typeId) {
  const termData = getTerminal(id);
  const closedProjectPath = termData?.project?.path;

  // Type-specific cleanup
  const typeHandler = registry.get(typeId);
  const config = typeHandler.getConsoleConfig(null, projectIndex);
  if (config && config.onCleanup) {
    const wrapper = document.querySelector(`.terminal-wrapper[data-id="${id}"]`);
    if (wrapper) config.onCleanup(wrapper);
  }

  cleanupTerminalResources(termData);
  removeTerminal(id);
  typeConsoleIds.delete(`${typeId}-${projectIndex}`);

  // Also clean legacy Maps
  if (typeId === 'fivem') fivemConsoleIds.delete(projectIndex);
  if (typeId === 'webapp') webappConsoleIds.delete(projectIndex);
  if (typeId === 'api') apiConsoleIds.delete(projectIndex);

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
 * Get the xterm Terminal instance for a type console.
 * @param {number} projectIndex
 * @param {string} typeId
 * @returns {Terminal|null}
 */
function getTypeConsoleTerminal(projectIndex, typeId) {
  const id = typeConsoleIds.get(`${typeId}-${projectIndex}`);
  if (id) {
    const termData = getTerminal(id);
    if (termData) return termData.terminal;
  }
  return null;
}

/**
 * Write data to a type console.
 * @param {number} projectIndex
 * @param {string} typeId
 * @param {string} data
 */
function writeTypeConsole(projectIndex, typeId, data) {
  const terminal = getTypeConsoleTerminal(projectIndex, typeId);
  if (terminal) terminal.write(data);
}

/**
 * Handle a new console error for a project (delegates to type handler).
 * @param {number} projectIndex
 * @param {Object} error
 */
function handleTypeConsoleError(projectIndex, error) {
  const projects = projectsState.get().projects;
  const project = projects[projectIndex];
  if (!project) return;

  const typeHandler = registry.get(project.type);
  typeHandler.onConsoleError(projectIndex, error, getTmApi());
}

/**
 * Show type-specific error overlay (delegates to type handler).
 * @param {number} projectIndex
 * @param {Object} error
 */
function showTypeErrorOverlay(projectIndex, error) {
  const projects = projectsState.get().projects;
  const project = projects[projectIndex];
  if (!project) return;

  const typeHandler = registry.get(project.type);
  typeHandler.showErrorOverlay(projectIndex, error, getTmApi());
}

// ── Legacy wrappers (thin redirects to generic API) ──
function createFivemConsole(project, projectIndex) { return createTypeConsole(project, projectIndex); }
function createWebAppConsole(project, projectIndex) { return createTypeConsole(project, projectIndex); }
function createApiConsole(project, projectIndex) { return createTypeConsole(project, projectIndex); }

function closeFivemConsole(id, projectIndex) { return closeTypeConsole(id, projectIndex, 'fivem'); }
function closeWebAppConsole(id, projectIndex) { return closeTypeConsole(id, projectIndex, 'webapp'); }
function closeApiConsole(id, projectIndex) { return closeTypeConsole(id, projectIndex, 'api'); }

function getFivemConsoleTerminal(projectIndex) { return getTypeConsoleTerminal(projectIndex, 'fivem'); }
function getWebAppConsoleTerminal(projectIndex) { return getTypeConsoleTerminal(projectIndex, 'webapp'); }
function getApiConsoleTerminal(projectIndex) { return getTypeConsoleTerminal(projectIndex, 'api'); }

function writeFivemConsole(projectIndex, data) { return writeTypeConsole(projectIndex, 'fivem', data); }
function writeWebAppConsole(projectIndex, data) { return writeTypeConsole(projectIndex, 'webapp', data); }
function writeApiConsole(projectIndex, data) { return writeTypeConsole(projectIndex, 'api', data); }

function addFivemErrorToConsole(projectIndex, error) { return handleTypeConsoleError(projectIndex, error); }
function showFivemErrorOverlay(projectIndex, error) { return showTypeErrorOverlay(projectIndex, error); }
function hideErrorOverlay(projectIndex) {
  const projects = projectsState.get().projects;
  const project = projects[projectIndex];
  if (project) {
    const typeHandler = registry.get(project.type);
    typeHandler.hideErrorOverlay(projectIndex);
  }
}

// ── Prompt Templates Injection Bar ──

/**
 * Render prompts dropdown bar for a project
 */
function renderPromptsBar(project) {
  const wrapper = document.getElementById('prompts-dropdown-wrapper');
  const dropdown = document.getElementById('prompts-dropdown');
  const promptsBtn = document.getElementById('filter-btn-prompts');

  if (!wrapper || !dropdown) return;

  if (!project) {
    wrapper.style.display = 'none';
    return;
  }

  const templates = ContextPromptService.getPromptTemplates(project.id);

  if (templates.length === 0) {
    wrapper.style.display = 'none';
    return;
  }

  wrapper.style.display = 'flex';

  const itemsHtml = templates.map(tmpl => `
    <button class="prompts-dropdown-item" data-prompt-id="${tmpl.id}" title="${escapeHtml(tmpl.description || '')}">
      <span class="prompts-item-name">${escapeHtml(tmpl.name)}</span>
      ${tmpl.scope === 'project' ? '<span class="prompts-item-badge">project</span>' : ''}
    </button>
  `).join('');

  dropdown.innerHTML = itemsHtml + `
    <div class="prompts-dropdown-footer" id="prompts-dropdown-manage">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      <span>${t('prompts.manageTemplates')}</span>
    </div>
  `;

  // Click handlers for prompt items
  dropdown.querySelectorAll('.prompts-dropdown-item').forEach(btn => {
    btn.onclick = async () => {
      console.log('[PromptsBar] Click - promptId:', btn.dataset.promptId);
      dropdown.classList.remove('active');
      promptsBtn.classList.remove('open');

      const promptId = btn.dataset.promptId;
      const activeTerminalId = getActiveTerminal();
      console.log('[PromptsBar] activeTerminalId:', activeTerminalId);
      if (!activeTerminalId) {
        console.warn('[PromptsBar] No active terminal!');
        return;
      }

      try {
        const resolvedText = await ContextPromptService.resolvePromptTemplate(promptId, project);
        if (!resolvedText) return;

        const termData = getTerminal(activeTerminalId);
        if (termData && termData.mode === 'chat') {
          // Chat mode: inject into chat textarea
          const wrapper = document.querySelector(`.terminal-wrapper[data-id="${activeTerminalId}"]`);
          const chatInput = wrapper?.querySelector('.chat-input');
          if (chatInput) {
            chatInput.value += resolvedText;
            chatInput.style.height = 'auto';
            chatInput.style.height = chatInput.scrollHeight + 'px';
            chatInput.focus();
          }
        } else {
          // Terminal mode: inject into PTY (use ptyId if available, for switched terminals)
          const ptyTarget = termData?.ptyId || activeTerminalId;
          api.terminal.input({ id: ptyTarget, data: resolvedText });
        }
      } catch (err) {
        console.error('[PromptsBar] Error resolving template:', err);
      }
    };
  });

  // Manage footer handler
  const manageFooter = dropdown.querySelector('#prompts-dropdown-manage');
  if (manageFooter) {
    manageFooter.onclick = () => {
      dropdown.classList.remove('active');
      promptsBtn.classList.remove('open');
      // Open Settings > Library tab
      const settingsBtn = document.getElementById('btn-settings');
      if (settingsBtn) settingsBtn.click();
      setTimeout(() => {
        const libraryTab = document.querySelector('.settings-tab[data-tab="library"]');
        if (libraryTab) libraryTab.click();
      }, 100);
    };
  }

  // Toggle dropdown
  promptsBtn.onclick = (e) => {
    e.stopPropagation();
    const isOpen = dropdown.classList.contains('active');

    // Close other dropdowns
    const branchDropdown = document.getElementById('branch-dropdown');
    const filterBtnBranch = document.getElementById('filter-btn-branch');
    const actionsDropdown = document.getElementById('actions-dropdown');
    const filterBtnActions = document.getElementById('filter-btn-actions');
    const gitChangesPanel = document.getElementById('git-changes-panel');
    if (branchDropdown) branchDropdown.classList.remove('active');
    if (filterBtnBranch) filterBtnBranch.classList.remove('open');
    if (actionsDropdown) actionsDropdown.classList.remove('active');
    if (filterBtnActions) filterBtnActions.classList.remove('open');
    if (gitChangesPanel) gitChangesPanel.classList.remove('active');

    dropdown.classList.toggle('active', !isOpen);
    promptsBtn.classList.toggle('open', !isOpen);
  };

  // Close on outside click
  const closeHandler = (e) => {
    if (!wrapper.contains(e.target)) {
      dropdown.classList.remove('active');
      promptsBtn.classList.remove('open');
    }
  };
  document.removeEventListener('click', wrapper._closeHandler);
  wrapper._closeHandler = closeHandler;
  document.addEventListener('click', closeHandler);
}

/**
 * Hide prompts dropdown bar
 */
function hidePromptsBar() {
  const wrapper = document.getElementById('prompts-dropdown-wrapper');
  if (wrapper) wrapper.style.display = 'none';
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

    // Render Prompts bar for this project
    renderPromptsBar(projects[projectIndex]);
  } else {
    filterIndicator.style.display = 'none';

    // Hide Quick Actions bar when no project is filtered
    const qa = getQuickActions();
    if (qa) {
      qa.hideQuickActionsBar();
    }

    // Hide Prompts bar
    hidePromptsBar();
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
    const shouldShow = projectIndex === null || (project && termData.project && (
      termData.project.path === project.path ||
      (termData.parentProjectId && termData.parentProjectId === project.id)
    ));

    if (tab) tab.style.display = shouldShow ? '' : 'none';
    if (wrapper) {
      if (shouldShow) {
        // Remove inline display so CSS .terminal-wrapper/.active rules control visibility
        wrapper.style.removeProperty('display');
      } else {
        wrapper.style.display = 'none';
      }
    }
    if (shouldShow) {
      visibleCount++;
      if (!firstVisibleId) firstVisibleId = id;
    }
  });

  // Check each pane for visible tabs — hide panes with zero visible tabs during filtering
  const paneOrder = PaneManager.getPaneOrder();
  for (const pId of paneOrder) {
    const pane = PaneManager.getPanes().get(pId);
    if (!pane) continue;
    const visibleTabsInPane = Array.from(pane.tabsEl.querySelectorAll('.terminal-tab'))
      .filter(tab => tab.style.display !== 'none');

    if (visibleTabsInPane.length === 0) {
      // Hide this pane (but don't collapse — filter may change)
      pane.el.style.display = 'none';
      const prevSibling = pane.el.previousElementSibling;
      if (prevSibling && prevSibling.classList.contains('split-divider')) {
        prevSibling.style.display = 'none';
      }
    } else {
      pane.el.style.display = '';
      const prevSibling = pane.el.previousElementSibling;
      if (prevSibling && prevSibling.classList.contains('split-divider')) {
        prevSibling.style.display = '';
      }

      // If pane's active tab is hidden, switch to first visible tab in this pane
      const currentActive = PaneManager.getPaneActiveTab(pId);
      const activeTabEl = currentActive ? pane.tabsEl.querySelector(`.terminal-tab[data-id="${currentActive}"]`) : null;
      if (!activeTabEl || activeTabEl.style.display === 'none') {
        const firstVisible = visibleTabsInPane[0];
        if (firstVisible) {
          PaneManager.setPaneActiveTab(pId, firstVisible.dataset.id);
          pane.tabsEl.querySelectorAll('.terminal-tab').forEach(t =>
            t.classList.toggle('active', t.dataset.id === firstVisible.dataset.id));
          pane.contentEl.querySelectorAll('.terminal-wrapper').forEach(w => {
            w.classList.toggle('active', w.dataset.id === firstVisible.dataset.id);
            w.style.removeProperty('display');
          });
        }
      }
    }
  }

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
    if (termData.project && (termData.project.path === project.path || (termData.parentProjectId && termData.parentProjectId === project.id))) count++;
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
    if (termData.project && (termData.project.path === project.path || (termData.parentProjectId && termData.parentProjectId === project.id)) && termData.type !== 'fivem' && termData.type !== 'webapp' && termData.type !== 'file' && !termData.isBasic) {
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
    pinned: { key: 'pinned', label: t('sessions.pinned') || (getCurrentLanguage() === 'fr' ? 'Epinglées' : 'Pinned'), sessions: [] },
    today: { key: 'today', label: t('sessions.today') || t('common.today'), sessions: [] },
    yesterday: { key: 'yesterday', label: t('sessions.yesterday') || t('time.yesterday') || (getCurrentLanguage() === 'fr' ? 'Hier' : 'Yesterday'), sessions: [] },
    thisWeek: { key: 'thisWeek', label: t('sessions.thisWeek') || (getCurrentLanguage() === 'fr' ? 'Cette semaine' : 'This week'), sessions: [] },
    older: { key: 'older', label: t('sessions.older') || (getCurrentLanguage() === 'fr' ? 'Plus ancien' : 'Older'), sessions: [] }
  };

  sessions.forEach(session => {
    if (session.pinned) {
      groups.pinned.sessions.push(session);
    } else {
      const group = getSessionGroup(session.modified);
      groups[group].sessions.push(session);
    }
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
  <symbol id="s-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 11V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7"/><path d="M5 17h14"/><path d="M7 11l-2 6h14l-2-6"/></symbol>
  <symbol id="s-rename" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></symbol>
</svg>`;

/**
 * ── Session Pins ──
 * Persist pinned session IDs in ~/.claude-terminal/session-pins.json
 */
const _pinsFile = path.join(window.electron_nodeModules.os.homedir(), '.claude-terminal', 'session-pins.json');
let _pinsCache = null;

function loadPins() {
  if (_pinsCache) return _pinsCache;
  try {
    const raw = fs.readFileSync(_pinsFile, 'utf8');
    _pinsCache = JSON.parse(raw);
  } catch {
    _pinsCache = {};
  }
  return _pinsCache;
}

function savePins() {
  try {
    fs.writeFileSync(_pinsFile, JSON.stringify(_pinsCache || {}, null, 2), 'utf8');
  } catch { /* ignore write errors */ }
}

function isSessionPinned(sessionId) {
  return !!loadPins()[sessionId];
}

function toggleSessionPin(sessionId) {
  const pins = loadPins();
  if (pins[sessionId]) {
    delete pins[sessionId];
  } else {
    pins[sessionId] = true;
  }
  _pinsCache = pins;
  savePins();
  return !!pins[sessionId];
}

/**
 * ── Session Custom Names ──
 * Persist custom session names in ~/.claude-terminal/session-names.json
 */
const _namesFile = path.join(window.electron_nodeModules.os.homedir(), '.claude-terminal', 'session-names.json');
let _namesCache = null;

function loadSessionNames() {
  if (_namesCache) return _namesCache;
  try {
    const raw = fs.readFileSync(_namesFile, 'utf8');
    _namesCache = JSON.parse(raw);
  } catch {
    _namesCache = {};
  }
  return _namesCache;
}

function saveSessionNames() {
  try {
    fs.writeFileSync(_namesFile, JSON.stringify(_namesCache || {}, null, 2), 'utf8');
  } catch { /* ignore write errors */ }
}

function getSessionCustomName(sessionId) {
  return loadSessionNames()[sessionId] || '';
}

function setSessionCustomName(sessionId, name) {
  const names = loadSessionNames();
  if (name) {
    names[sessionId] = name;
  } else {
    delete names[sessionId];
  }
  _namesCache = names;
  saveSessionNames();
}

/**
 * Pre-process sessions: clean text once and cache display data
 */
function preprocessSessions(sessions) {
  const now = Date.now();
  return sessions.map(session => {
    const promptResult = cleanSessionText(session.firstPrompt);
    const summaryResult = cleanSessionText(session.summary);
    const skillName = promptResult.skillName || summaryResult.skillName;
    const customName = getSessionCustomName(session.sessionId);

    let displayTitle = '';
    let displaySubtitle = '';
    let isSkill = false;
    let isRenamed = false;

    // Custom name takes priority
    if (customName) {
      displayTitle = customName;
      displaySubtitle = summaryResult.text || promptResult.text;
      isRenamed = true;
    } else if (summaryResult.text) {
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
    const searchText = (displayTitle + ' ' + displaySubtitle + ' ' + (session.gitBranch || '') + ' ' + customName).toLowerCase();

    const pinned = isSessionPinned(session.sessionId);
    return { ...session, displayTitle, displaySubtitle, isSkill, isRenamed, freshness, searchText, pinned };
  });
}

/**
 * Start inline rename on a session card title element
 */
function startInlineRename(titleEl, sessionId, sessionData, onDone) {
  if (titleEl.querySelector('.session-rename-input')) return; // Already editing

  const currentName = sessionData?.displayTitle || '';
  const originalHtml = titleEl.innerHTML;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = currentName;
  input.placeholder = t('sessions.renamePlaceholder') || 'Session name...';

  titleEl.textContent = '';
  titleEl.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const newName = input.value.trim();
    cleanup();
    if (newName && newName !== currentName) {
      setSessionCustomName(sessionId, newName);
      if (sessionData) {
        sessionData.displayTitle = newName;
        sessionData.isRenamed = true;
      }
    } else if (!newName) {
      // Clearing name removes custom name
      setSessionCustomName(sessionId, '');
    }
    if (onDone) onDone();
  }

  function cancel() {
    cleanup();
    titleEl.innerHTML = originalHtml;
  }

  function cleanup() {
    input.removeEventListener('keydown', onKey);
    input.removeEventListener('blur', onBlur);
  }

  function onKey(e) {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  }

  function onBlur() {
    commit();
  }

  input.addEventListener('keydown', onKey);
  input.addEventListener('blur', onBlur);
  input.addEventListener('click', (e) => e.stopPropagation());
}

/**
 * Build HTML for a single session card (lightweight, uses SVG sprites)
 */
function buildSessionCardHtml(s, index) {
  const MAX_ANIMATED = 10;
  const animClass = index < MAX_ANIMATED ? ' session-card--anim' : ' session-card--instant';
  const freshClass = s.freshness ? ` session-card--${s.freshness}` : '';
  const pinnedClass = s.pinned ? ' session-card--pinned' : '';
  const renamedClass = s.isRenamed ? ' session-card--renamed' : '';
  const skillClass = s.isSkill ? ' session-card-icon--skill' : '';
  const titleSkillClass = s.isSkill ? ' session-card-title--skill' : '';
  const iconId = s.isSkill ? 's-bolt' : 's-chat';
  const pinTitle = s.pinned ? (t('sessions.unpin') || 'Unpin') : (t('sessions.pin') || 'Pin');
  const renameTitle = t('sessions.rename') || 'Rename';

  return `<div class="session-card${freshClass}${pinnedClass}${renamedClass}${animClass}" data-sid="${s.sessionId}" style="--ci:${index < MAX_ANIMATED ? index : 0}">
<div class="session-card-icon${skillClass}"><svg width="16" height="16"><use href="#${iconId}"/></svg></div>
<div class="session-card-body">
<span class="session-card-title${titleSkillClass}">${escapeHtml(truncateText(s.displayTitle, 80))}</span>
${s.displaySubtitle ? `<span class="session-card-subtitle">${escapeHtml(truncateText(s.displaySubtitle, 120))}</span>` : ''}
</div>
<div class="session-card-meta">
<span class="session-meta-item"><svg width="11" height="11"><use href="#s-msg"/></svg>${s.messageCount}</span>
<span class="session-meta-item"><svg width="11" height="11"><use href="#s-clock"/></svg>${formatRelativeTime(s.modified)}</span>
${s.gitBranch ? `<span class="session-meta-branch"><svg width="10" height="10"><use href="#s-branch"/></svg>${escapeHtml(s.gitBranch)}</span>` : ''}
</div>
<div class="session-card-actions">
<button class="session-card-rename" data-rename-sid="${s.sessionId}" title="${renameTitle}"><svg width="12" height="12"><use href="#s-rename"/></svg></button>
<button class="session-card-pin" data-pin-sid="${s.sessionId}" title="${pinTitle}"><svg width="13" height="13"><use href="#s-pin"/></svg></button>
</div>
<div class="session-card-arrow"><svg width="12" height="12"><use href="#s-arrow"/></svg></div>
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
            <svg width="28" height="28"><use href="#s-chat"/></svg>
          </div>
          <p class="sessions-empty-title">${t('terminals.noTerminals')}</p>
          <p class="sessions-empty-hint">${t('terminals.createHint')}</p>
          <button class="sessions-empty-btn" id="sessions-empty-create">
            <svg width="15" height="15"><use href="#s-plus"/></svg>
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
              <svg class="sessions-search-icon" width="13" height="13"><use href="#s-search"/></svg>
              <input type="text" class="sessions-search" placeholder="${t('common.search')}..." />
            </div>
            <button class="sessions-new-btn" title="${t('terminals.newConversation') || (getCurrentLanguage() === 'fr' ? 'Nouvelle conversation' : 'New conversation')}">
              <svg width="14" height="14"><use href="#s-plus"/></svg>
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
      // Pin button click
      const pinBtn = e.target.closest('.session-card-pin');
      if (pinBtn) {
        e.stopPropagation();
        const sid = pinBtn.dataset.pinSid;
        if (!sid) return;
        const nowPinned = toggleSessionPin(sid);
        const session = sessionMap.get(sid);
        if (session) session.pinned = nowPinned;
        renderSessionsPanel(project, emptyState);
        return;
      }

      // Rename button click
      const renameBtn = e.target.closest('.session-card-rename');
      if (renameBtn) {
        e.stopPropagation();
        const sid = renameBtn.dataset.renameSid;
        if (!sid) return;
        const card = renameBtn.closest('.session-card');
        const titleEl = card?.querySelector('.session-card-title');
        if (!titleEl) return;
        startInlineRename(titleEl, sid, sessionMap.get(sid), () => renderSessionsPanel(project, emptyState));
        return;
      }

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

  // If chat mode is active, resume via SDK
  const mode = getSetting('defaultTerminalMode') || 'terminal';
  if (mode === 'chat') {
    console.log(`[TerminalManager] Resuming in chat mode — sessionId: ${sessionId}`);
    return createChatTerminal(project, { skipPermissions, resumeSessionId: sessionId });
  }

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
  heartbeat(project.id, 'terminal');

  // Create tab
  const tabsContainer = PaneManager.getTabsContainer();
  const tab = document.createElement('div');
  tab.className = 'terminal-tab status-working';
  tab.dataset.id = id;
  tab.innerHTML = `
    <span class="status-dot"></span>
    <span class="tab-name">${escapeHtml(t('terminals.resuming'))}</span>
    <button class="tab-close"><svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></button>`;
  tabsContainer.appendChild(tab);

  // Create wrapper
  const container = PaneManager.getContentContainer();
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.dataset.id = id;
  container.appendChild(wrapper);
  PaneManager.registerTab(String(id), PaneManager.getDefaultPaneId());

  document.getElementById('empty-terminals').style.display = 'none';

  terminal.open(wrapper);
  loadWebglAddon(terminal);
  setTimeout(() => fitAddon.fit(), 100);
  setActiveTerminal(id);

  // Prevent double-paste issue
  setupPasteHandler(wrapper, id, 'terminal-input');
  setupClipboardShortcuts(wrapper, terminal, id, 'terminal-input');

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
      if (td?.project?.id) heartbeat(td.project.id, 'terminal');
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
    if (td?.project?.id) heartbeat(td.project.id, 'terminal');
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
  tab.oncontextmenu = (e) => showTabContextMenu(e, id);

  // Enable drag & drop reordering
  setupTabDragDrop(tab);

  return id;
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
  const tabsContainer = PaneManager.getTabsContainer();
  const tab = document.createElement('div');
  tab.className = 'terminal-tab status-working';
  tab.dataset.id = id;
  tab.innerHTML = `
    <span class="status-dot"></span>
    <span class="tab-name">${escapeHtml(`🐛 ${t('terminals.debug')}`)}</span>
    <button class="tab-close"><svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></button>`;
  tabsContainer.appendChild(tab);

  // Create wrapper
  const container = PaneManager.getContentContainer();
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.dataset.id = id;
  container.appendChild(wrapper);
  PaneManager.registerTab(String(id), PaneManager.getDefaultPaneId());

  document.getElementById('empty-terminals').style.display = 'none';

  terminal.open(wrapper);
  loadWebglAddon(terminal);
  setTimeout(() => fitAddon.fit(), 100);
  setActiveTerminal(id);

  // Prevent double-paste issue
  setupPasteHandler(wrapper, id, 'terminal-input');
  setupClipboardShortcuts(wrapper, terminal, id, 'terminal-input');

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
  tab.oncontextmenu = (e) => showTabContextMenu(e, id);

  // Enable drag & drop reordering
  setupTabDragDrop(tab);

  return id;
}

/**
 * Create a markdown renderer instance for a specific base path.
 * Uses a new Marked() instance to avoid global config conflict with ChatView.
 * @param {string} basePath - Directory of the markdown file for resolving relative images
 * @returns {Marked} Configured Marked instance
 */
function createMdRenderer(basePath) {
  const md = new Marked();
  md.use({
    renderer: {
      code({ text, lang }) {
        const decoded = (text || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
        const highlighted = lang ? highlight(decoded, lang) : escapeHtml(decoded);
        return `<div class="chat-code-block"><div class="chat-code-header"><span class="chat-code-lang">${escapeHtml(lang || 'text')}</span><button class="chat-code-copy" title="${t('common.copy')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button></div><pre><code>${highlighted}</code></pre></div>`;
      },
      codespan({ text }) {
        return `<code class="chat-inline-code">${escapeHtml(text)}</code>`;
      },
      table({ header, rows }) {
        const safeAlign = (a) => ['left', 'center', 'right'].includes(a) ? a : 'left';
        const headerHtml = header.map(h => `<th style="text-align:${safeAlign(h.align)}">${escapeHtml(typeof h.text === 'string' ? h.text : String(h.text || ''))}</th>`).join('');
        const rowsHtml = rows.map(row =>
          `<tr>${row.map(cell => `<td style="text-align:${safeAlign(cell.align)}">${escapeHtml(typeof cell.text === 'string' ? cell.text : String(cell.text || ''))}</td>`).join('')}</tr>`
        ).join('');
        return `<div class="chat-table-wrapper"><table class="chat-table"><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
      },
      link({ href, text }) {
        const safeHref = escapeHtml((href || '').trim());
        return `<a class="md-viewer-link" data-md-link="${safeHref}" title="${t('mdViewer.ctrlClickToOpen')}">${text || safeHref}</a>`;
      },
      image({ href, title, text }) {
        const src = (href || '').startsWith('http') ? href
          : `file:///${path.resolve(basePath, href || '').replace(/\\/g, '/')}`;
        return `<img src="${src}" alt="${escapeHtml(text || '')}" title="${escapeHtml(title || '')}" class="md-viewer-img" />`;
      },
      heading({ tokens, depth }) {
        const text = tokens.map(tok => tok.raw || tok.text || '').join('');
        const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return `<h${depth} id="md-h-${id}" class="md-viewer-heading">${this.parser.parseInline(tokens)}</h${depth}>`;
      },
      html() { return ''; }
    },
    tokenizer: {
      html() { return undefined; }
    },
    gfm: true,
    breaks: false
  });
  return md;
}

/**
 * Build a table of contents from markdown content.
 * @param {string} content - Raw markdown string
 * @returns {string} HTML string for the TOC nav, or empty string if no headings
 */
function buildMdToc(content) {
  const md = new Marked();
  const tokens = md.lexer(content);
  const headings = tokens
    .filter(tok => tok.type === 'heading')
    .map(tok => {
      const text = tok.text || '';
      const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return { depth: tok.depth, text, id: `md-h-${id}` };
    });
  if (headings.length === 0) return '';
  return `<nav class="md-toc-nav">
    <div class="md-toc-title">${t('mdViewer.tableOfContents')}</div>
    <ul class="md-toc-list">${headings.map(h =>
      `<li class="md-toc-item md-toc-depth-${h.depth}"><a href="#${h.id}" data-toc-link="${h.id}">${escapeHtml(h.text)}</a></li>`
    ).join('')}</ul>
  </nav>`;
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
  const isMarkdown = ext === 'md';

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
  const tabsContainer = PaneManager.getTabsContainer();
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
  const container = PaneManager.getContentContainer();
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
  } else if (isMarkdown) {
    const basePath = path.dirname(filePath);
    const mdRenderer = createMdRenderer(basePath);
    const renderedHtml = mdRenderer.parse(content);
    const tocHtml = buildMdToc(content);
    const tocExpanded = getSetting('mdViewerTocExpanded') !== false;
    const lineCount = content.split('\n').length;

    const sourceHighlighted = highlight(content, 'md');
    const sourceLines = content.split('\n');
    const sourceLineNums = sourceLines.map((_, i) => `<span class="line-num">${i + 1}</span>`).join('\n');

    viewerBody = `
      <div class="md-viewer-wrapper">
        <div class="md-viewer-toc${tocExpanded ? '' : ' collapsed'}" id="md-toc-${id}">
          <button class="md-toc-toggle" title="${t('mdViewer.toggleToc')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
          </button>
          ${tocHtml}
        </div>
        <div class="md-viewer-content">
          <div class="md-viewer-body" id="md-body-${id}">${renderedHtml}</div>
          <div class="md-viewer-source" id="md-source-${id}" style="display:none">
            <div class="file-viewer-content">
              <div class="file-viewer-lines">${sourceLineNums}</div>
              <pre class="file-viewer-code"><code>${sourceHighlighted}</code></pre>
            </div>
          </div>
        </div>
      </div>`;

    sizeStr += ` \u00B7 ${lineCount} lines`;

    // Store extra state on termData
    termData.isMarkdown = true;
    termData.mdViewMode = 'rendered';
    termData.mdRenderer = mdRenderer;
    termData.mdCleanup = null; // Will be set by Plan 21-02 for file watcher
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
  PaneManager.registerTab(String(id), PaneManager.getDefaultPaneId());
  document.getElementById('empty-terminals').style.display = 'none';

  // Markdown-specific: add toggle button and wire event handlers
  if (isMarkdown) {
    const header = wrapper.querySelector('.file-viewer-header');
    // Add toggle button (rendered/source)
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'md-viewer-toggle-btn';
    toggleBtn.title = t('mdViewer.toggleSource');
    toggleBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/></svg>`;
    header.appendChild(toggleBtn);

    // Toggle rendered/source
    toggleBtn.addEventListener('click', () => {
      const bodyEl = wrapper.querySelector('.md-viewer-body');
      const sourceEl = wrapper.querySelector('.md-viewer-source');
      if (termData.mdViewMode === 'rendered') {
        bodyEl.style.display = 'none';
        sourceEl.style.display = '';
        termData.mdViewMode = 'source';
        toggleBtn.classList.add('active');
        toggleBtn.title = t('mdViewer.toggleRendered');
      } else {
        bodyEl.style.display = '';
        sourceEl.style.display = 'none';
        termData.mdViewMode = 'rendered';
        toggleBtn.classList.remove('active');
        toggleBtn.title = t('mdViewer.toggleSource');
      }
    });

    // Delegated event handlers on the wrapper
    wrapper.addEventListener('click', (e) => {
      // Copy button handler (reuse ChatView pattern)
      const copyBtn = e.target.closest('.chat-code-copy');
      if (copyBtn) {
        const code = copyBtn.closest('.chat-code-block')?.querySelector('code')?.textContent;
        if (code) {
          navigator.clipboard.writeText(code);
          copyBtn.classList.add('copied');
          setTimeout(() => copyBtn.classList.remove('copied'), 1500);
        }
        return;
      }

      // Ctrl+click link gating
      const link = e.target.closest('[data-md-link]');
      if (link) {
        e.preventDefault();
        if (e.ctrlKey) {
          api.dialog.openExternal(link.dataset.mdLink);
        }
        return;
      }

      // TOC link smooth scroll
      const tocLink = e.target.closest('[data-toc-link]');
      if (tocLink) {
        e.preventDefault();
        const targetId = tocLink.dataset.tocLink;
        const targetEl = wrapper.querySelector(`#${targetId}`);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        return;
      }
    });

    // TOC collapse toggle
    const tocToggle = wrapper.querySelector('.md-toc-toggle');
    if (tocToggle) {
      tocToggle.addEventListener('click', () => {
        const tocEl = wrapper.querySelector('.md-viewer-toc');
        tocEl.classList.toggle('collapsed');
        setSetting('mdViewerTocExpanded', !tocEl.classList.contains('collapsed'));
      });
    }

    // === File watcher for live reload ===
    let reloadTimer = null;
    const unsubscribeWatch = api.dialog.onFileChanged((changedPath) => {
      if (changedPath !== filePath) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        try {
          const newContent = fs.readFileSync(filePath, 'utf-8');
          const bodyEl = document.getElementById(`md-body-${id}`);
          if (!bodyEl) return;
          const scroll = bodyEl.scrollTop;
          bodyEl.innerHTML = termData.mdRenderer.parse(newContent);
          bodyEl.scrollTop = scroll;
          // Update TOC
          const tocEl = document.getElementById(`md-toc-${id}`);
          if (tocEl) {
            const tocNav = tocEl.querySelector('.md-toc-nav');
            if (tocNav) {
              const newTocHtml = buildMdToc(newContent);
              if (newTocHtml) {
                tocNav.outerHTML = newTocHtml;
              }
            }
          }
          // Update source view
          const sourceEl = document.getElementById(`md-source-${id}`);
          if (sourceEl) {
            const sourceHighlighted = highlight(newContent, 'md');
            const sourceLines = newContent.split('\n');
            const lineNums = sourceLines.map((_, i) => `<span class="line-num">${i + 1}</span>`).join('\n');
            const linesEl = sourceEl.querySelector('.file-viewer-lines');
            const codeEl = sourceEl.querySelector('.file-viewer-code code');
            if (linesEl) linesEl.innerHTML = lineNums;
            if (codeEl) codeEl.innerHTML = sourceHighlighted;
          }
        } catch (e) { /* file temporarily unavailable during save */ }
      }, 300);
    });
    api.dialog.watchFile(filePath);

    // Store cleanup function on termData
    termData.mdCleanup = () => {
      unsubscribeWatch();
      api.dialog.unwatchFile(filePath);
      clearTimeout(reloadTimer);
    };

    // === Ctrl+F search bar ===
    const contentEl = wrapper.querySelector('.md-viewer-content');
    const searchBarHtml = `
      <div class="md-viewer-search" id="md-search-${id}">
        <input type="text" placeholder="${t('mdViewer.searchPlaceholder')}" />
        <span class="md-search-count"></span>
        <button class="md-search-close" title="Escape">
          <svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
        </button>
      </div>`;
    contentEl.insertAdjacentHTML('afterbegin', searchBarHtml);

    const searchBar = document.getElementById(`md-search-${id}`);
    const searchInput = searchBar.querySelector('input');
    const searchCount = searchBar.querySelector('.md-search-count');
    const searchClose = searchBar.querySelector('.md-search-close');
    let searchTimer = null;
    let currentMatchIdx = -1;

    // Make wrapper focusable so it can receive keydown
    wrapper.setAttribute('tabindex', '-1');

    function clearHighlights(bodyEl) {
      bodyEl.querySelectorAll('mark.md-search-hit').forEach(m => {
        const parent = m.parentNode;
        parent.replaceChild(document.createTextNode(m.textContent), m);
        parent.normalize();
      });
      currentMatchIdx = -1;
      searchCount.textContent = '';
    }

    function highlightMatches(bodyEl, query) {
      clearHighlights(bodyEl);
      if (!query) return;
      const lower = query.toLowerCase();
      const walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT);
      const hits = [];
      let node;
      while ((node = walker.nextNode())) {
        const idx = node.textContent.toLowerCase().indexOf(lower);
        if (idx !== -1) hits.push({ node, idx });
      }
      hits.forEach(({ node, idx }) => {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + query.length);
        const mark = document.createElement('mark');
        mark.className = 'md-search-hit';
        range.surroundContents(mark);
      });
      const allMarks = bodyEl.querySelectorAll('mark.md-search-hit');
      searchCount.textContent = allMarks.length > 0 ? `${allMarks.length}` : t('mdViewer.noResults');
      if (allMarks.length > 0) {
        currentMatchIdx = 0;
        allMarks[0].classList.add('md-search-current');
        allMarks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    function navigateMatch(forward) {
      const bodyEl = document.getElementById(`md-body-${id}`);
      if (!bodyEl) return;
      const marks = bodyEl.querySelectorAll('mark.md-search-hit');
      if (marks.length === 0) return;
      marks[currentMatchIdx]?.classList.remove('md-search-current');
      currentMatchIdx = forward
        ? (currentMatchIdx + 1) % marks.length
        : (currentMatchIdx - 1 + marks.length) % marks.length;
      marks[currentMatchIdx].classList.add('md-search-current');
      marks[currentMatchIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
      searchCount.textContent = `${currentMatchIdx + 1}/${marks.length}`;
    }

    // Ctrl+F handler on the wrapper
    wrapper.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        searchBar.classList.add('visible');
        searchInput.focus();
        searchInput.select();
      }
    });

    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const bodyEl = document.getElementById(`md-body-${id}`);
        if (bodyEl && termData.mdViewMode === 'rendered') {
          highlightMatches(bodyEl, searchInput.value);
        }
      }, 400);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        navigateMatch(!e.shiftKey);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        const bodyEl = document.getElementById(`md-body-${id}`);
        if (bodyEl) clearHighlights(bodyEl);
        searchBar.classList.remove('visible');
        searchInput.value = '';
        wrapper.focus();
      }
    });

    searchClose.addEventListener('click', () => {
      const bodyEl = document.getElementById(`md-body-${id}`);
      if (bodyEl) clearHighlights(bodyEl);
      searchBar.classList.remove('visible');
      searchInput.value = '';
      wrapper.focus();
    });
  }

  setActiveTerminal(id);

  // Tab events
  tab.onclick = (e) => { if (!e.target.closest('.tab-close') && !e.target.closest('.tab-name-input')) setActiveTerminal(id); };
  tab.querySelector('.tab-name').ondblclick = (e) => { e.stopPropagation(); startRenameTab(id); };
  tab.querySelector('.tab-close').onclick = (e) => { e.stopPropagation(); closeTerminal(id); };
  tab.oncontextmenu = (e) => showTabContextMenu(e, id);

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

/**
 * Create a chat-mode terminal (Claude Agent SDK UI)
 */
async function createChatTerminal(project, options = {}) {
  const { skipPermissions = false, name: customName = null, resumeSessionId = null, forkSession = false, resumeSessionAt = null, parentProjectId = null, initialPrompt = null, initialImages = null, initialModel = null, initialEffort = null, onSessionStart = null } = options;

  const id = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let _chatSessionId = null;
  const projectIndex = getProjectIndex(parentProjectId || project.id);
  const tabName = customName || project.name;

  const termData = {
    terminal: null,
    fitAddon: null,
    project,
    projectIndex,
    name: tabName,
    status: 'ready',
    inputBuffer: '',
    isBasic: false,
    mode: 'chat',
    chatView: null,
    ...(parentProjectId ? { parentProjectId } : {})
  };

  addTerminal(id, termData);
  heartbeat(parentProjectId || project.id, 'terminal');

  // Create tab
  const tabsContainer = PaneManager.getTabsContainer();
  const tab = document.createElement('div');
  tab.className = 'terminal-tab status-ready chat-mode';
  tab.dataset.id = id;
  tab.tabIndex = 0;
  tab.setAttribute('role', 'tab');
  tab.innerHTML = `
    <span class="status-dot"></span>
    <span class="tab-name">${escapeHtml(tabName)}</span>
    <button class="tab-mode-toggle" title="${escapeHtml(t('chat.switchToTerminal'))}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v12zm-2-1h-6v-2h6v2zM7.5 17l-1.41-1.41L8.67 13l-2.59-2.59L7.5 9l4 4-4 4z"/></svg>
    </button>
    <button class="tab-close"><svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></button>`;
  tabsContainer.appendChild(tab);

  // Create wrapper
  const container = PaneManager.getContentContainer();
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper chat-wrapper';
  wrapper.dataset.id = id;
  container.appendChild(wrapper);
  PaneManager.registerTab(String(id), PaneManager.getDefaultPaneId());

  document.getElementById('empty-terminals').style.display = 'none';

  // Create ChatView inside wrapper
  const chatView = createChatView(wrapper, project, {
    terminalId: id,
    skipPermissions,
    resumeSessionId,
    forkSession,
    resumeSessionAt,
    initialPrompt,
    initialImages,
    initialModel,
    initialEffort,
    onSessionStart: (sid) => {
      _chatSessionId = sid;
      if (onSessionStart) onSessionStart(sid);
    },
    onTabRename: (name) => {
      const nameEl = tab.querySelector('.tab-name');
      if (nameEl) nameEl.textContent = name;
      const data = getTerminal(id);
      if (data) data.name = name;
      // Notify remote PWA of tab rename
      if (_chatSessionId && api.remote?.notifyTabRenamed) {
        api.remote.notifyTabRenamed({ sessionId: _chatSessionId, tabName: name });
      }
    },
    onStatusChange: (status, substatus) => updateChatTerminalStatus(id, status, substatus),
    onSwitchTerminal: (dir) => callbacks.onSwitchTerminal?.(dir),
    onSwitchProject: (dir) => callbacks.onSwitchProject?.(dir),
    onForkSession: ({ resumeSessionId: forkSid, resumeSessionAt: forkAt, model: forkModel, effort: forkEffort, skipPermissions: forkSkipPerms }) => {
      createChatTerminal(project, {
        resumeSessionId: forkSid,
        forkSession: true,
        resumeSessionAt: forkAt,
        skipPermissions: forkSkipPerms || false,
        initialModel: forkModel || null,
        initialEffort: forkEffort || null,
        name: `Fork: ${tabName}`
      });
    },
  });
  const storedData = getTerminal(id);
  if (storedData) {
    storedData.chatView = chatView;
  }

  setActiveTerminal(id);

  // Filter and render
  const selectedFilter = projectsState.get().selectedProjectFilter;
  filterByProject(selectedFilter);
  if (callbacks.onRenderProjects) callbacks.onRenderProjects();

  // Tab events
  tab.onclick = (e) => { if (!e.target.closest('.tab-close') && !e.target.closest('.tab-name-input') && !e.target.closest('.tab-mode-toggle')) setActiveTerminal(id); };
  tab.querySelector('.tab-name').ondblclick = (e) => { e.stopPropagation(); startRenameTab(id); };
  tab.querySelector('.tab-close').onclick = (e) => { e.stopPropagation(); closeTerminal(id); };
  tab.oncontextmenu = (e) => showTabContextMenu(e, id);
  const modeToggleBtn = tab.querySelector('.tab-mode-toggle');
  if (modeToggleBtn) {
    modeToggleBtn.onclick = (e) => { e.stopPropagation(); switchTerminalMode(id); };
  }
  setupTabDragDrop(tab);

  return id;
}

/**
 * Switch a terminal between terminal and chat mode
 * Creates a fresh session in the new mode
 */
async function switchTerminalMode(id) {
  const termData = getTerminal(id);
  if (!termData || termData.isBasic) return;

  const project = termData.project;
  const currentMode = termData.mode || 'terminal';
  const newMode = currentMode === 'terminal' ? 'chat' : 'terminal';
  const wrapper = document.querySelector(`.terminal-wrapper[data-id="${id}"]`);
  const tab = document.querySelector(`.terminal-tab[data-id="${id}"]`);

  if (!wrapper || !tab) return;

  // Tear down current mode
  if (currentMode === 'terminal') {
    // Kill PTY
    api.terminal.kill({ id });
    cleanupTerminalResources(termData);
    clearOutputSilenceTimer(id);
    cancelScheduledReady(id);
  } else if (currentMode === 'chat') {
    // Destroy chat view
    if (termData.chatView) {
      termData.chatView.destroy();
    }
  }

  // Clear wrapper
  wrapper.innerHTML = '';

  // Setup new mode
  if (newMode === 'chat') {
    wrapper.classList.add('chat-wrapper');
    tab.classList.add('chat-mode');

    const chatView = createChatView(wrapper, project, {
      terminalId: id,
      skipPermissions: getSetting('skipPermissions') || false,
      onStatusChange: (status, substatus) => updateChatTerminalStatus(id, status, substatus),
      onSwitchTerminal: (dir) => callbacks.onSwitchTerminal?.(dir),
      onSwitchProject: (dir) => callbacks.onSwitchProject?.(dir),
    });

    updateTerminal(id, { mode: 'chat', chatView, terminal: null, fitAddon: null, status: 'ready' });

    // Update toggle icon (show terminal icon)
    const toggleBtn = tab.querySelector('.tab-mode-toggle');
    if (toggleBtn) {
      toggleBtn.title = t('chat.switchToTerminal');
      toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v12zm-2-1h-6v-2h6v2zM7.5 17l-1.41-1.41L8.67 13l-2.59-2.59L7.5 9l4 4-4 4z"/></svg>';
    }

    chatView.focus();
  } else {
    wrapper.classList.remove('chat-wrapper');
    tab.classList.remove('chat-mode');

    // Create new PTY terminal
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

    // Create new PTY process
    const result = await api.terminal.create({
      cwd: project.path,
      runClaude: true,
      skipPermissions: getSetting('skipPermissions') || false
    });

    // Handle creation failure
    if (result && typeof result === 'object' && result.success === false) {
      console.error('Failed to create terminal on mode switch:', result.error);
      terminal.dispose();
      wrapper.innerHTML = `<div class="terminal-error-state"><p>${escapeHtml(result.error || t('terminals.createError'))}</p></div>`;
      updateTerminal(id, { mode: 'terminal', chatView: null, terminal: null, fitAddon: null, status: 'error' });
      if (callbacks.onNotification) {
        callbacks.onNotification(`❌ ${t('common.error')}`, result.error || t('terminals.createError'), null);
      }
      return;
    }

    const ptyId = (result && typeof result === 'object') ? result.id : result;

    terminal.open(wrapper);
    loadWebglAddon(terminal);

    updateTerminal(id, {
      mode: 'terminal',
      chatView: null,
      terminal,
      fitAddon,
      ptyId,
      status: 'loading'
    });

    // Loading overlay
    const overlay = document.createElement('div');
    overlay.className = 'terminal-loading-overlay';
    overlay.innerHTML = `
      <div class="terminal-loading-spinner"></div>
      <div class="terminal-loading-text">${escapeHtml(t('terminals.loading'))}</div>
      <div class="terminal-loading-hint">${escapeHtml(t('terminals.loadingHint'))}</div>`;
    wrapper.appendChild(overlay);
    loadingTimeouts.set(id, setTimeout(() => {
      loadingTimeouts.delete(id);
      dismissLoadingOverlay(id);
      const td = getTerminal(id);
      if (td && td.status === 'loading') updateTerminalStatus(id, 'ready');
    }, 30000));

    setTimeout(() => fitAddon.fit(), 100);

    // Setup paste handler and key handler (use ptyId for PTY input routing)
    setupPasteHandler(wrapper, ptyId, 'terminal-input');
    setupClipboardShortcuts(wrapper, terminal, ptyId, 'terminal-input');
    terminal.attachCustomKeyEventHandler(createTerminalKeyHandler(terminal, ptyId, 'terminal-input'));

    // Title change
    let lastTitle = '';
    terminal.onTitleChange(title => {
      if (title === lastTitle) return;
      lastTitle = title;
      handleClaudeTitleChange(id, title);
    });

    // IPC data handling - use the ptyId for IPC but id for state
    registerTerminalHandler(ptyId,
      (data) => {
        terminal.write(data.data);
        resetOutputSilenceTimer(id);
        const td = getTerminal(id);
        if (td?.project?.id) heartbeat(td.project.id, 'terminal');
      },
      () => closeTerminal(id)
    );

    const storedTermData = getTerminal(id);
    if (storedTermData) {
      storedTermData.handlers = { unregister: () => unregisterTerminalHandler(ptyId) };
    }

    terminal.onData(data => {
      api.terminal.input({ id: ptyId, data });
      const td = getTerminal(id);
      if (td?.project?.id) heartbeat(td.project.id, 'terminal');
      if (data === '\r' || data === '\n') {
        cancelScheduledReady(id);
        updateTerminalStatus(id, 'working');
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      api.terminal.resize({ id: ptyId, cols: terminal.cols, rows: terminal.rows });
    });
    resizeObserver.observe(wrapper);

    if (storedTermData) {
      storedTermData.resizeObserver = resizeObserver;
    }

    // Update toggle icon (show chat icon)
    const toggleBtn = tab.querySelector('.tab-mode-toggle');
    if (toggleBtn) {
      toggleBtn.title = t('chat.switchToChat');
      toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>';
    }

    terminal.focus();
  }

  // Update tab status
  tab.className = tab.className.replace(/status-\w+/, `status-${getTerminal(id)?.status || 'ready'}`);
}

/**
 * Clean up all Maps entries for a given project index.
 * Should be called when a project is deleted to prevent memory leaks.
 * @param {number} projectIndex
 */
function cleanupProjectMaps(projectIndex) {
  fivemConsoleIds.delete(projectIndex);
  webappConsoleIds.delete(projectIndex);
  apiConsoleIds.delete(projectIndex);
  errorOverlays.delete(projectIndex);
  // Clean type console ids (keyed by "${typeId}-${projectIndex}")
  for (const key of typeConsoleIds.keys()) {
    if (key.endsWith(`-${projectIndex}`)) {
      typeConsoleIds.delete(key);
    }
  }
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
  // Generic type console API
  createTypeConsole,
  closeTypeConsole,
  getTypeConsoleTerminal,
  writeTypeConsole,
  handleTypeConsoleError,
  showTypeErrorOverlay,
  // Legacy wrappers (backward compat)
  createFivemConsole,
  closeFivemConsole,
  getFivemConsoleTerminal,
  writeFivemConsole,
  addFivemErrorToConsole,
  showFivemErrorOverlay,
  hideErrorOverlay,
  createWebAppConsole,
  closeWebAppConsole,
  getWebAppConsoleTerminal,
  writeWebAppConsole,
  createApiConsole,
  closeApiConsole,
  getApiConsoleTerminal,
  writeApiConsole,
  // Chat mode
  switchTerminalMode,
  // Scraping callback for EventBus
  setScrapingCallback,
  updateTerminalTabName,
  // Cleanup when a project is deleted
  cleanupProjectMaps
};
