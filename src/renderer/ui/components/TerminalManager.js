/**
 * TerminalManager Component
 * Handles terminal creation, rendering and management
 * Migrated to OOP (BaseComponent)
 */

const { BaseComponent } = require('../../core/BaseComponent');

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
  stopProject,
  getProjectSettings: getProjectSettingsState,
  generateTabId,
  getTerminalByTabId,
  updateTerminalByTabId,
  touchTerminalActivity,
  appendTerminalOutput,
  appendChatMessage,
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
const ContextPromptService = require('../../services/ContextPromptService');
const { getBuiltinSystemPrompt } = require('../../services/BuiltinSystemPrompts');

// Lazy require to avoid circular dependency
let QuickActions = null;
function getQuickActions() {
  if (!QuickActions) {
    QuickActions = require('./QuickActions');
  }
  return QuickActions;
}

// ── Constants ──
const PASTE_DEBOUNCE_MS = 500;
const ARROW_DEBOUNCE_MS = 100;
const READY_DEBOUNCE_MS = 2500;
const POST_ENTER_DEBOUNCE_MS = 5000;
const POST_TOOL_DEBOUNCE_MS = 4000;
const POST_THINKING_DEBOUNCE_MS = 1500;
const SILENCE_THRESHOLD_MS = 1000;
const RECHECK_DELAY_MS = 1000;
const BRAILLE_SPINNER_RE = /[\u2801-\u28FF]/;

const CLAUDE_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task',
  'WebFetch', 'WebSearch', 'TodoRead', 'TodoWrite', 'Notebook', 'MultiEdit'
]);

const TITLE_STOP_WORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'a', 'a', 'en', 'dans', 'sur', 'pour', 'par', 'avec',
  'the', 'a', 'an', 'and', 'or', 'in', 'on', 'for', 'with', 'to', 'of', 'is', 'are', 'it', 'this', 'that',
  'me', 'moi', 'mon', 'ma', 'mes', 'ce', 'cette', 'ces', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles',
  'can', 'you', 'please', 'help', 'want', 'need', 'like', 'would', 'could', 'should',
  'peux', 'veux', 'fais', 'fait', 'faire', 'est', 'sont', 'ai', 'as', 'avez', 'ont'
]);

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

// ── Pure helper functions (module-level, no mutable state) ──

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

function resetOutputSilenceTimer(_id) { /* no-op */ }
function clearOutputSilenceTimer(_id) { /* no-op */ }

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

  const doneMatch = block.match(/✳\s+\S+\s+for\s+((?:\d+h\s+)?(?:\d+m\s+)?\d+s)/);
  if (doneMatch) return { signal: 'done', duration: doneMatch[1] };

  if (/·\s+\S+…/.test(block)) return { signal: 'working' };

  if (/\b(Allow|Approve|yes\/no|y\/n)\b/i.test(block)) return { signal: 'permission' };

  if (lines[0].includes('⎿')) return { signal: 'tool_result' };

  return null;
}

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

function extractTitleFromInput(input) {
  let text = input.trim();
  if (text.startsWith('/') || text.length < 5) return null;
  const words = text.toLowerCase().replace(/[^\w\sàâäéèêëïîôùûüç-]/g, ' ').split(/\s+/)
    .filter(word => word.length > 2 && !TITLE_STOP_WORDS.has(word));
  if (words.length === 0) return null;
  const titleWords = words.slice(0, 4).map(w => w.charAt(0).toUpperCase() + w.slice(1));
  return titleWords.join(' ');
}

function extractTerminalContext(terminal) {
  if (!terminal?.buffer?.active) return null;
  const buf = terminal.buffer.active;
  const totalLines = buf.baseY + buf.cursorY;
  const scanLimit = Math.max(0, totalLines - 30);

  const lines = [];
  for (let i = totalLines; i >= scanLimit; i--) {
    const row = buf.getLine(i);
    if (!row) continue;
    const text = row.translateToString(true).trim();
    if (!text) continue;
    if (BRAILLE_SPINNER_RE.test(text)) continue;
    if (/^[✳❯>\$%#\s]*$/.test(text)) continue;
    lines.unshift(text);
    if (lines.length >= 6) break;
  }

  if (lines.length === 0) return null;

  const block = lines.join('\n');
  const lastLine = lines[lines.length - 1];

  const questionMatch = block.match(/^(.+\?)\s*$/m);
  if (questionMatch) {
    const q = questionMatch[1].trim();
    if (q.length > 10 && q.length <= 200) return { type: 'question', text: q };
  }

  if (/\b(allow|approve|permit|yes\/no|y\/n)\b/i.test(block) ||
      /\b(Run|Execute|Edit|Write|Read|Delete|Bash)\b.*\?/.test(block)) {
    return { type: 'permission', text: lastLine.length <= 120 ? lastLine : null };
  }

  return { type: 'done', text: null };
}

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

function truncateText(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

function cleanSessionText(text) {
  if (!text) return { text: '', skillName: '' };

  let skillName = '';

  const cmdNameMatch = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
  if (cmdNameMatch) {
    skillName = cmdNameMatch[1].trim().replace(/^\//, '');
  }

  const argsMatch = text.match(/<command-args>([^<]+)<\/command-args>/);
  const argsText = argsMatch ? argsMatch[1].trim() : '';

  let cleaned = text.replace(/<[^>]+>[^<]*<\/[^>]+>/g, '');
  cleaned = cleaned.replace(/<[^>]+>/g, '');
  cleaned = cleaned.replace(/\[Request interrupted[^\]]*\]/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (!cleaned && argsText) {
    cleaned = argsText;
  }

  return { text: cleaned, skillName };
}

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

function createMdRenderer(basePath) {
  const path = window.electron_nodeModules.path;
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

// ════════════════════════════════════════════════════════════════════════════
// ── TerminalManager Class ──
// ════════════════════════════════════════════════════════════════════════════

class TerminalManager extends BaseComponent {
  constructor() {
    super(null);

    this._api = window.electron_api;
    this._path = window.electron_nodeModules.path;
    this._fs = window.electron_nodeModules.fs;

    // Global callback for opening cloud chat from CloudPanel
    window._openCloudChat = (cloudProject) => {
      this._createChatTerminal(cloudProject, { skipPermissions: true, tabTag: { label: 'Cloud', color: '#3b82f6' } });
    };

    // ── Mutable state ──
    this._scrapingEventCallback = null;
    this._fivemConsoleIds = new Map();
    this._webappConsoleIds = new Map();
    this._apiConsoleIds = new Map();
    this._errorOverlays = new Map();
    this._typeConsoleIds = new Map();
    this._lastPasteTime = 0;
    this._lastArrowTime = 0;
    this._draggedTab = null;
    this._dragPlaceholder = null;
    this._terminalDataHandlers = new Map();
    this._terminalExitHandlers = new Map();
    this._ipcDispatcherInitialized = false;
    this._readyDebounceTimers = new Map();
    this._postEnterExtended = new Set();
    this._postSpinnerExtended = new Set();
    this._terminalSubstatus = new Map();
    this._lastTerminalData = new Map();
    this._terminalContext = new Map();
    this._tabActivationHistory = new Map();
    this._loadingTimeouts = new Map();
    this._callbacks = {
      onNotification: null,
      onRenderProjects: null,
      onCreateTerminal: null,
      onSwitchTerminal: null,
      onSwitchProject: null
    };

    // Session pins
    const { fileExists, fsp } = require('../../utils/fs-async');
    this._fsp = fsp;
    this._pinsFile = this._path.join(window.electron_nodeModules.os.homedir(), '.claude-terminal', 'session-pins.json');
    this._pinsCache = null;

    // Session custom names
    this._namesFile = this._path.join(window.electron_nodeModules.os.homedir(), '.claude-terminal', 'session-names.json');
    this._namesCache = null;
  }

  setCallbacks(cbs) {
    Object.assign(this._callbacks, cbs);
  }

  setScrapingCallback(cb) {
    this._scrapingEventCallback = cb;
  }

  // ── IPC Dispatcher ──

  _initIpcDispatcher() {
    if (this._ipcDispatcherInitialized) return;
    this._ipcDispatcherInitialized = true;
    const self = this;
    this._api.terminal.onData((data) => {
      self._lastTerminalData.set(data.id, Date.now());
      const handler = self._terminalDataHandlers.get(data.id);
      if (handler) handler(data);
    });
    this._api.terminal.onExit((data) => {
      const handler = self._terminalExitHandlers.get(data.id);
      if (handler) handler(data);
    });
  }

  _registerTerminalHandler(id, onData, onExit) {
    this._initIpcDispatcher();
    const wrappedOnData = (data) => {
      const td = getTerminal(id);
      if (td) {
        const chunk = (data && typeof data.data === 'string') ? data.data : '';
        if (chunk) appendTerminalOutput(td, chunk);
        td.lastActivityAt = new Date().toISOString();
      }
      if (onData) onData(data);
    };
    this._terminalDataHandlers.set(id, wrappedOnData);
    this._terminalExitHandlers.set(id, onExit);
  }

  _unregisterTerminalHandler(id) {
    this._terminalDataHandlers.delete(id);
    this._terminalExitHandlers.delete(id);
  }

  // ── Ready state debounce ──

  _shouldSkipOscRename(id) {
    if (!getSetting('tabRenameOnSlashCommand')) return false;
    const td = getTerminal(id);
    return !!(td && td.name && td.name.startsWith('/'));
  }

  _scheduleReady(id) {
    if (this._readyDebounceTimers.has(id)) return;
    let delay = READY_DEBOUNCE_MS;
    if (this._postEnterExtended.has(id)) {
      delay = POST_ENTER_DEBOUNCE_MS;
      this._postEnterExtended.delete(id);
    } else if (this._postSpinnerExtended.has(id)) {
      const sub = this._terminalSubstatus.get(id);
      delay = sub === 'tool_calling' ? POST_TOOL_DEBOUNCE_MS : POST_THINKING_DEBOUNCE_MS;
    }
    const self = this;
    this._readyDebounceTimers.set(id, setTimeout(() => {
      self._readyDebounceTimers.delete(id);
      self._finalizeReady(id);
    }, delay));
  }

  _finalizeReady(id) {
    const termData = getTerminal(id);
    const lastData = this._lastTerminalData.get(id);
    const isSilent = !lastData || Date.now() - lastData >= SILENCE_THRESHOLD_MS;
    const self = this;

    if (termData?.terminal) {
      const completion = detectCompletionSignal(termData.terminal);

      if (completion?.signal === 'done') {
        if (completion.duration) {
          const ctx = this._terminalContext.get(id);
          if (ctx) ctx.duration = completion.duration;
        }
        this._declareReady(id);
        return;
      }

      if (completion?.signal === 'working') {
        this._readyDebounceTimers.set(id, setTimeout(() => {
          self._readyDebounceTimers.delete(id);
          self._finalizeReady(id);
        }, RECHECK_DELAY_MS));
        return;
      }

      if (completion?.signal === 'permission') {
        this._declareReady(id);
        return;
      }

      if (completion?.signal === 'tool_result' && !isSilent) {
        this._readyDebounceTimers.set(id, setTimeout(() => {
          self._readyDebounceTimers.delete(id);
          self._finalizeReady(id);
        }, RECHECK_DELAY_MS));
        return;
      }
    }

    if (!isSilent) {
      this._readyDebounceTimers.set(id, setTimeout(() => {
        self._readyDebounceTimers.delete(id);
        self._finalizeReady(id);
      }, RECHECK_DELAY_MS));
      return;
    }

    this._declareReady(id);
  }

  _declareReady(id) {
    this._postSpinnerExtended.delete(id);
    this._postEnterExtended.delete(id);
    this._terminalSubstatus.delete(id);
    this.updateTerminalStatus(id, 'ready');
    if (this._scrapingEventCallback) this._scrapingEventCallback(id, 'done', {});
    const ctx = this._terminalContext.get(id);
    if (ctx) {
      ctx.toolCount = 0;
      ctx.lastTool = null;
    }
  }

  _cancelScheduledReady(id) {
    const timer = this._readyDebounceTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this._readyDebounceTimers.delete(id);
    }
  }

  // ── Claude title change handling ──

  _handleClaudeTitleChange(id, title, options = {}) {
    const { onPendingPrompt } = options;

    if (BRAILLE_SPINNER_RE.test(title)) {
      this._postEnterExtended.delete(id);
      this._postSpinnerExtended.add(id);
      this._cancelScheduledReady(id);

      const parsed = parseClaudeTitle(title);
      this._terminalSubstatus.set(id, parsed.tool ? 'tool_calling' : 'thinking');

      if (!this._terminalContext.has(id)) this._terminalContext.set(id, { taskName: null, lastTool: null, toolCount: 0, duration: null });
      const ctx = this._terminalContext.get(id);
      if (parsed.taskName) ctx.taskName = parsed.taskName;
      if (parsed.tool) {
        ctx.lastTool = parsed.tool;
        ctx.toolCount++;
      }

      if (parsed.taskName) {
        if (!this._shouldSkipOscRename(id) && getSetting('aiTabNaming') !== false) {
          this.updateTerminalTabName(id, parsed.taskName);
        }
      }

      this.updateTerminalStatus(id, 'working');
      if (this._scrapingEventCallback) this._scrapingEventCallback(id, 'working', { tool: parsed.tool || null });

    } else if (title.includes('\u2733')) {
      const parsed = parseClaudeTitle(title);
      if (parsed.taskName) {
        if (!this._terminalContext.has(id)) this._terminalContext.set(id, { taskName: null, lastTool: null, toolCount: 0, duration: null });
        this._terminalContext.get(id).taskName = parsed.taskName;
        if (!this._shouldSkipOscRename(id) && getSetting('aiTabNaming') !== false) {
          this.updateTerminalTabName(id, parsed.taskName);
        }
      }

      if (onPendingPrompt && onPendingPrompt()) return;

      this._scheduleReady(id);

      const self = this;
      setTimeout(() => {
        if (!self._readyDebounceTimers.has(id)) return;
        const termData = getTerminal(id);
        if (termData?.terminal) {
          const completion = detectCompletionSignal(termData.terminal);
          if (completion?.signal === 'done' || completion?.signal === 'permission') {
            self._cancelScheduledReady(id);
            self._declareReady(id);
          }
        }
      }, 500);
    }
  }

  // ── Paste helpers ──

  _performPaste(terminalId, inputChannel = 'terminal-input') {
    const now = Date.now();
    if (now - this._lastPasteTime < PASTE_DEBOUNCE_MS) return;
    this._lastPasteTime = now;
    const api = this._api;
    const sendPaste = (text) => {
      if (!text) return;
      text = text.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
      if (inputChannel === 'fivem-input') {
        api.fivem.input({ projectIndex: terminalId, data: text });
      } else if (inputChannel === 'webapp-input') {
        api.webapp.input({ projectIndex: terminalId, data: text });
      } else {
        api.terminal.input({ id: terminalId, data: text });
      }
    };
    navigator.clipboard.readText()
      .then(sendPaste)
      .catch(() => api.app.clipboardRead().then(sendPaste));
  }

  _setupClipboardShortcuts(wrapper, terminal, terminalId, inputChannel = 'terminal-input') {
    const self = this;
    wrapper.addEventListener('keydown', (e) => {
      if (!e.ctrlKey || !e.shiftKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;

      if (e.key === 'V') {
        e.preventDefault();
        e.stopImmediatePropagation();
        self._performPaste(terminalId, inputChannel);
      } else if (e.key === 'C') {
        const selection = terminal.getSelection();
        if (selection) {
          e.preventDefault();
          e.stopImmediatePropagation();
          navigator.clipboard.writeText(selection).catch(() => self._api.app.clipboardWrite(selection));
          terminal.clearSelection();
        }
      }
    }, true);
  }

  _setupPasteHandler(wrapper, terminalId, inputChannel = 'terminal-input') {
    const self = this;
    wrapper.addEventListener('paste', (e) => {
      e.preventDefault();
      e.stopPropagation();
      self._performPaste(terminalId, inputChannel);
    }, true);
  }

  _setupRightClickHandler(wrapper, terminal, terminalId, inputChannel = 'terminal-input') {
    const self = this;
    wrapper.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const ts = getSetting('terminalShortcuts') || {};

      if (ts.rightClickCopyPaste?.enabled) {
        const selection = terminal.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection)
            .catch(() => self._api.app.clipboardWrite(selection));
          terminal.clearSelection();
        } else {
          self._performPaste(terminalId, inputChannel);
        }
        return;
      }

      if (ts.rightClickPaste?.enabled !== false && !getSetting('terminalContextMenu')) {
        self._performPaste(terminalId, inputChannel);
        return;
      }

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
                    .catch(() => self._api.app.clipboardWrite(selection));
                  terminal.clearSelection();
                }
              }
            },
            {
              label: t('common.paste'),
              shortcut: 'Ctrl+V',
              icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
              onClick: () => self._performPaste(terminalId, inputChannel)
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

  // ── Key handler ──

  _createTerminalKeyHandler(terminal, terminalId, inputChannel = 'terminal-input') {
    const self = this;
    let shiftHeld = false;
    const _onBlur = () => { shiftHeld = false; };
    window.addEventListener('blur', _onBlur);
    terminal._blurListener = _onBlur;
    return (e) => {
      if (e.ctrlKey && e.type === 'keydown') {
        const ts = getSetting('terminalShortcuts') || {};
        const eventKey = eventToNormalizedKey(e);

        const ctrlCCustomKey = ts.ctrlC?.key;
        if (ctrlCCustomKey && ctrlCCustomKey !== 'Ctrl+C') {
          if (eventKey === normalizeStoredKey(ctrlCCustomKey) && ts.ctrlC?.enabled !== false) {
            const selection = terminal.getSelection();
            if (selection) {
              navigator.clipboard.writeText(selection)
                .catch(() => self._api.app.clipboardWrite(selection));
              terminal.clearSelection();
              return false;
            }
            return true;
          }
        }

        const ctrlVCustomKey = ts.ctrlV?.key;
        if (ctrlVCustomKey && ctrlVCustomKey !== 'Ctrl+V') {
          if (eventKey === normalizeStoredKey(ctrlVCustomKey) && ts.ctrlV?.enabled !== false) {
            self._performPaste(terminalId, inputChannel);
            return false;
          }
        }
      }

      if (e.key === 'Shift' && e.type === 'keydown') shiftHeld = true;
      if (e.key === 'Shift' && e.type === 'keyup') shiftHeld = false;

      if ((shiftHeld || e.shiftKey || e.getModifierState('Shift')) && !e.ctrlKey && !e.altKey && e.key === 'Enter') {
        if (e.type === 'keydown') {
          if (inputChannel === 'fivem-input') {
            self._api.fivem.input({ projectIndex: terminalId, data: '\n' });
          } else if (inputChannel === 'webapp-input') {
            self._api.webapp.input({ projectIndex: terminalId, data: '\n' });
          } else {
            self._api.terminal.input({ id: terminalId, data: '\n' });
          }
        }
        return false;
      }

      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.repeat && e.type === 'keydown') {
        const isArrowKey = ['ArrowUp', 'ArrowDown'].includes(e.key);
        if (isArrowKey) {
          const now = Date.now();
          if (now - self._lastArrowTime < ARROW_DEBOUNCE_MS) {
            return false;
          }
          self._lastArrowTime = now;

          if (e.key === 'ArrowUp' && self._callbacks.onSwitchProject) {
            self._callbacks.onSwitchProject('up');
            return false;
          }
          if (e.key === 'ArrowDown' && self._callbacks.onSwitchProject) {
            self._callbacks.onSwitchProject('down');
            return false;
          }
        }

        if (e.key === 'Backspace') {
          if (inputChannel === 'terminal-input') {
            self._api.terminal.input({ id: terminalId, data: '\x17' });
            return false;
          }
          return true;
        }

        {
          const ts = getSetting('terminalShortcuts') || {};
          const ctrlCRebound = ts.ctrlC?.key && ts.ctrlC.key !== 'Ctrl+C';
          if (ctrlCRebound) {
            if (e.key.toLowerCase() === 'c') {
              return true;
            }
          } else if (e.key.toLowerCase() === 'c') {
            if (ts.ctrlC?.enabled === false) {
              return true;
            }
            const selection = terminal.getSelection();
            if (selection) {
              navigator.clipboard.writeText(selection)
                .catch(() => self._api.app.clipboardWrite(selection));
              terminal.clearSelection();
              return false;
            }
            return true;
          }
        }

        {
          const ts = getSetting('terminalShortcuts') || {};
          const ctrlVRebound = ts.ctrlV?.key && ts.ctrlV.key !== 'Ctrl+V';
          if (!ctrlVRebound && e.key.toLowerCase() === 'v') {
            if (ts.ctrlV?.enabled !== false) {
              self._performPaste(terminalId, inputChannel);
            }
            return false;
          }
        }

        if (e.key === 'ArrowLeft') {
          if (inputChannel === 'terminal-input') {
            const ts = getSetting('terminalShortcuts') || {};
            if (ts.ctrlArrow?.enabled === false) return true;
            self._api.terminal.input({ id: terminalId, data: '\x1b[1;5D' });
            return false;
          }
          return true;
        }
        if (e.key === 'ArrowRight') {
          if (inputChannel === 'terminal-input') {
            const ts = getSetting('terminalShortcuts') || {};
            if (ts.ctrlArrow?.enabled === false) return true;
            self._api.terminal.input({ id: terminalId, data: '\x1b[1;5C' });
            return false;
          }
          return true;
        }
      }
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'w' && e.type === 'keydown') {
        return false;
      }
      if (e.ctrlKey && !e.shiftKey && e.key === ',' && e.type === 'keydown') {
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't' && e.type === 'keydown') {
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'e' && e.type === 'keydown') {
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p' && e.type === 'keydown') {
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'A' && e.type === 'keydown') {
        terminal.selectAll();
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'C' && e.type === 'keydown') {
        const selection = terminal.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => self._api.app.clipboardWrite(selection));
          terminal.clearSelection();
        }
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'V' && e.type === 'keydown') {
        self._performPaste(terminalId, inputChannel);
        return false;
      }

      if (inputChannel === 'fivem-input' && e.type === 'keydown') {
        const projectIndex = terminalId;
        const fivemId = self._fivemConsoleIds.get(projectIndex);
        const wrapper = fivemId ? document.querySelector(`.terminal-wrapper[data-id="${fivemId}"]`) : null;

        if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
          if (wrapper) {
            const resourcesTab = wrapper.querySelector('.fivem-view-tab[data-view="resources"]');
            const consoleTab = wrapper.querySelector('.fivem-view-tab[data-view="console"]');
            const resourcesView = wrapper.querySelector('.fivem-resources-view');

            if (resourcesView && resourcesView.style.display !== 'none') {
              consoleTab?.click();
            } else {
              resourcesTab?.click();
            }
          }
          return false;
        }

        if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
          let shortcut = '';
          if (e.ctrlKey) shortcut += 'Ctrl+';
          if (e.altKey) shortcut += 'Alt+';
          if (e.shiftKey) shortcut += 'Shift+';

          let keyName = e.key;
          if (keyName === ' ') keyName = 'Space';
          else if (keyName.length === 1) keyName = keyName.toUpperCase();

          shortcut += keyName;

          const resourceName = findResourceByShortcut(projectIndex, shortcut);
          if (resourceName) {
            self._api.fivem.resourceCommand({ projectIndex, command: `ensure ${resourceName}` })
              .catch(err => console.error('Shortcut ensure failed:', err));

            const resourceItem = wrapper?.querySelector(`.fivem-resource-item[data-name="${resourceName}"]`);
            if (resourceItem) {
              resourceItem.classList.add('shortcut-triggered');
              setTimeout(() => resourceItem.classList.remove('shortcut-triggered'), 300);
            }
            return false;
          }
        }
      }

      return true;
    };
  }

  // ── Tab drag & drop ──

  _setupTabDragDrop(tab) {
    const self = this;
    tab.draggable = true;

    tab.addEventListener('dragstart', (e) => {
      self._draggedTab = tab;
      tab.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tab.dataset.id);

      self._dragPlaceholder = document.createElement('div');
      self._dragPlaceholder.className = 'terminal-tab-placeholder';
    });

    tab.addEventListener('dragend', () => {
      tab.classList.remove('dragging');
      self._draggedTab = null;
      if (self._dragPlaceholder && self._dragPlaceholder.parentNode) {
        self._dragPlaceholder.remove();
      }
      self._dragPlaceholder = null;
      document.querySelectorAll('.terminal-tab.drag-over-left, .terminal-tab.drag-over-right').forEach(t => {
        t.classList.remove('drag-over-left', 'drag-over-right');
      });
    });

    tab.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      if (!self._draggedTab || self._draggedTab === tab) return;

      const rect = tab.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const isLeft = e.clientX < midX;

      tab.classList.remove('drag-over-left', 'drag-over-right');
      tab.classList.add(isLeft ? 'drag-over-left' : 'drag-over-right');
    });

    tab.addEventListener('dragleave', () => {
      tab.classList.remove('drag-over-left', 'drag-over-right');
    });

    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      tab.classList.remove('drag-over-left', 'drag-over-right');

      if (!self._draggedTab || self._draggedTab === tab) return;

      const tabsContainer = document.getElementById('terminals-tabs');
      const rect = tab.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const insertBefore = e.clientX < midX;

      if (insertBefore) {
        tabsContainer.insertBefore(self._draggedTab, tab);
      } else {
        tabsContainer.insertBefore(self._draggedTab, tab.nextSibling);
      }
    });
  }

  // ── Terminal tab name & status ──

  async updateTerminalTabName(id, name) {
    const termData = getTerminal(id);
    if (!termData) return;

    updateTerminal(id, { name });

    if (termData.claudeSessionId && name) {
      await this._setSessionCustomName(termData.claudeSessionId, name);
    }

    const tab = document.querySelector(`.terminal-tab[data-id="${id}"]`);
    if (tab) {
      const nameSpan = tab.querySelector('.tab-name');
      if (nameSpan) {
        nameSpan.textContent = name;
      }
    }
    const TerminalSessionService = require('../../services/TerminalSessionService');
    TerminalSessionService.saveTerminalSessions();
  }

  _dismissLoadingOverlay(id) {
    const wrapper = document.querySelector(`.terminal-wrapper[data-id="${id}"]`);
    const overlay = wrapper?.querySelector('.terminal-loading-overlay');
    if (overlay) {
      overlay.classList.add('fade-out');
      setTimeout(() => overlay.remove(), 300);
    }
  }

  updateTerminalStatus(id, status) {
    const termData = getTerminal(id);
    if (termData && termData.status !== status) {
      const previousStatus = termData.status;
      updateTerminal(id, { status });
      const tab = document.querySelector(`.terminal-tab[data-id="${id}"]`);
      if (tab) {
        tab.classList.remove('status-working', 'status-ready', 'status-loading', 'substatus-thinking', 'substatus-tool', 'substatus-waiting');
        tab.classList.add(`status-${status}`);
        if (status === 'working') {
          const sub = this._terminalSubstatus.get(id);
          if (sub === 'tool_calling') tab.classList.add('substatus-tool');
          else if (sub === 'waiting') tab.classList.add('substatus-waiting');
          else tab.classList.add('substatus-thinking');
        }
      }
      if (previousStatus === 'loading' && (status === 'ready' || status === 'working')) {
        this._dismissLoadingOverlay(id);
        const safetyTimeout = this._loadingTimeouts.get(id);
        if (safetyTimeout) {
          clearTimeout(safetyTimeout);
          this._loadingTimeouts.delete(id);
        }
        this.scheduleScrollAfterRestore(id);
      }
      if (status === 'ready' && previousStatus === 'working') {
        const hooksActive = (() => { try { return require('../../events').getActiveProvider() === 'hooks'; } catch (e) { return false; } })();
        if (!hooksActive && this._callbacks.onNotification) {
          const projectName = termData.project?.name || termData.name;
          const richCtx = this._terminalContext.get(id);
          let notifTitle = projectName || 'Claude Terminal';
          let body;

          if (richCtx?.toolCount > 0) {
            body = t('terminals.notifToolsDone', { count: richCtx.toolCount });
          } else {
            body = t('terminals.notifDone');
          }

          this._callbacks.onNotification('done', notifTitle, body, id);
        }
      }
      if (this._callbacks.onRenderProjects) {
        this._callbacks.onRenderProjects();
      }
    }
  }

  _updateChatTerminalStatus(id, status, substatus) {
    if (substatus) {
      this._terminalSubstatus.set(id, substatus);
    } else {
      this._terminalSubstatus.delete(id);
    }

    const termData = getTerminal(id);
    if (!termData) return;

    const tab = document.querySelector(`.terminal-tab[data-id="${id}"]`);

    if (termData.status !== status) {
      this.updateTerminalStatus(id, status);
    } else if (tab && status === 'working') {
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

  // ── Tab rename ──

  _startRenameTab(id) {
    const self = this;
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
      newSpan.ondblclick = (e) => { e.stopPropagation(); self._startRenameTab(id); };
      input.replaceWith(newSpan);
    };

    input.onblur = finishRename;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = currentName; input.blur(); }
    };
  }

  _showTabContextMenu(e, id) {
    const self = this;
    e.preventDefault();
    e.stopPropagation();

    const tabsContainer = document.getElementById('terminals-tabs');
    const allTabs = Array.from(tabsContainer.querySelectorAll('.terminal-tab'));
    const thisTab = tabsContainer.querySelector(`.terminal-tab[data-id="${id}"]`);
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
          onClick: () => self._startRenameTab(id)
        },
        { separator: true },
        {
          label: t('tabs.close'),
          icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
          onClick: () => self.closeTerminal(id)
        },
        {
          label: t('tabs.closeOthers'),
          icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
          disabled: allTabs.length <= 1,
          onClick: () => {
            allTabs.forEach(tab => {
              const tabId = tab.dataset.id;
              if (tabId !== id) self.closeTerminal(tabId);
            });
          }
        },
        {
          label: t('tabs.closeToRight'),
          icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
          disabled: tabsToRight.length === 0,
          onClick: () => {
            tabsToRight.forEach(tab => self.closeTerminal(tab.dataset.id));
          }
        }
      ]
    });
  }

  // ── Active terminal ──

  setActiveTerminal(id) {
    const prevActiveId = getActiveTerminal();
    const prevTermData = prevActiveId ? getTerminal(prevActiveId) : null;
    const prevProjectId = prevTermData?.project?.id;

    if (prevTermData && prevTermData.terminal && prevActiveId !== id) {
      try { prevTermData.terminal.blur(); } catch (e) {}
    }

    setActiveTerminalState(id);
    document.querySelectorAll('.terminal-tab').forEach(t => t.classList.toggle('active', t.dataset.id == id));
    document.querySelectorAll('.terminal-wrapper').forEach(w => {
      const isActive = w.dataset.id == id;
      w.classList.toggle('active', isActive);
      w.style.removeProperty('display');
    });
    const termData = getTerminal(id);
    if (termData) {
      if (termData.mode === 'chat') {
        if (termData.chatView) {
          termData.chatView.focus();
        }
      } else if (termData.type !== 'file') {
        termData.fitAddon.fit();
        termData.terminal.focus();
      }

      const newProjectId = termData.project?.id;
      if (prevProjectId !== newProjectId) {
        if (newProjectId) heartbeat(newProjectId, 'terminal');
      }

      if (newProjectId) {
        if (!this._tabActivationHistory.has(newProjectId)) {
          this._tabActivationHistory.set(newProjectId, []);
        }
        const history = this._tabActivationHistory.get(newProjectId);
        if (history[history.length - 1] !== id) {
          history.push(id);
          if (history.length > 50) history.shift();
        }
      }

      if (this._callbacks.onActiveTerminalChange) {
        this._callbacks.onActiveTerminalChange(id, termData);
      }
    }
  }

  // ── Terminal cleanup ──

  _cleanupTerminalResources(termData) {
    if (!termData) return;

    if (termData.handlers) {
      if (termData.handlers.unregister) {
        termData.handlers.unregister();
      }
      if (termData.handlers.unsubscribeData) {
        termData.handlers.unsubscribeData();
      }
      if (termData.handlers.unsubscribeExit) {
        termData.handlers.unsubscribeExit();
      }
    }

    if (termData.resizeObserver) {
      termData.resizeObserver.disconnect();
    }

    if (termData.terminal && termData.terminal._blurListener) {
      window.removeEventListener('blur', termData.terminal._blurListener);
      termData.terminal._blurListener = null;
    }

    if (termData.terminal) {
      termData.terminal.dispose();
    }
  }

  // ── Close terminal ──

  closeTerminal(id) {
    const termData = getTerminal(id);
    const closedProjectIndex = termData?.projectIndex;
    const closedProjectPath = termData?.project?.path;
    const closedProjectId = termData?.project?.id;

    if (termData && termData.type && this._typeConsoleIds.has(`${termData.type}-${closedProjectIndex}`)) {
      this._closeTypeConsole(id, closedProjectIndex, termData.type);
      return;
    }

    clearOutputSilenceTimer(id);
    this._cancelScheduledReady(id);
    this._postEnterExtended.delete(id);
    this._postSpinnerExtended.delete(id);
    const safetyTimeout = this._loadingTimeouts.get(id);
    if (safetyTimeout) {
      clearTimeout(safetyTimeout);
      this._loadingTimeouts.delete(id);
    }
    this._terminalSubstatus.delete(id);
    this._lastTerminalData.delete(id);
    this._terminalContext.delete(id);
    this._errorOverlays.delete(closedProjectIndex);

    if (termData && termData.mode === 'chat') {
      if (termData.chatView) {
        termData.chatView.destroy();
      }
      removeTerminal(id);
    } else if (termData && termData.type === 'file') {
      if (termData.mdCleanup) termData.mdCleanup();
      if (termData.viewerCleanup) termData.viewerCleanup();
      removeTerminal(id);
    } else {
      this._api.terminal.kill({ id });
      this._cleanupTerminalResources(termData);
      removeTerminal(id);
    }
    document.querySelector(`.terminal-tab[data-id="${id}"]`)?.remove();
    document.querySelector(`.terminal-wrapper[data-id="${id}"]`)?.remove();

    let sameProjectTerminalId = null;
    if (closedProjectId) {
      const history = this._tabActivationHistory.get(closedProjectId);
      if (history) {
        for (let i = history.length - 1; i >= 0; i--) {
          const candidateId = history[i];
          if (candidateId === id) continue;
          if (!getTerminal(candidateId)) continue;
          sameProjectTerminalId = candidateId;
          break;
        }

        const pruned = history.filter(hId => hId !== id);
        if (pruned.length === 0) {
          this._tabActivationHistory.delete(closedProjectId);
        } else {
          this._tabActivationHistory.set(closedProjectId, pruned);
        }
      }
    }

    if (!sameProjectTerminalId && closedProjectPath) {
      const terminals = terminalsState.get().terminals;
      terminals.forEach((td, termId) => {
        if (!sameProjectTerminalId && td.project?.path === closedProjectPath) {
          sameProjectTerminalId = termId;
        }
      });
    }

    if (!sameProjectTerminalId && closedProjectId) {
      stopProject(closedProjectId);
    }

    if (sameProjectTerminalId) {
      this.setActiveTerminal(sameProjectTerminalId);
      const selectedFilter = projectsState.get().selectedProjectFilter;
      this.filterByProject(selectedFilter);
    } else if (closedProjectIndex !== null && closedProjectIndex !== undefined) {
      projectsState.setProp('selectedProjectFilter', closedProjectIndex);
      this.filterByProject(closedProjectIndex);
    } else {
      const selectedFilter = projectsState.get().selectedProjectFilter;
      this.filterByProject(selectedFilter);
    }

    if (this._callbacks.onRenderProjects) this._callbacks.onRenderProjects();
  }

  // ── Create terminal ──

  async createTerminal(project, options = {}) {
    const { skipPermissions = false, runClaude = true, name: customName = null, mode: explicitMode = null, cwd: overrideCwd = null, initialPrompt = null, initialImages = null, initialModel = null, initialEffort = null, onSessionStart = null, resumeSessionId = null, systemPrompt = null, tabTag = null } = options;

    const mode = explicitMode || (runClaude ? (getSetting('defaultTerminalMode') || 'terminal') : 'terminal');

    if (mode === 'chat' && runClaude) {
      const chatProject = overrideCwd ? { ...project, path: overrideCwd } : project;
      return this._createChatTerminal(chatProject, { skipPermissions, name: customName, parentProjectId: overrideCwd ? project.id : null, resumeSessionId, initialPrompt, initialImages, initialModel, initialEffort, onSessionStart, systemPrompt, tabTag });
    }

    const result = await this._api.terminal.create({
      cwd: overrideCwd || project.path,
      runClaude,
      skipPermissions,
      ...(resumeSessionId ? { resumeSessionId } : {})
    });

    if (result && typeof result === 'object' && 'success' in result) {
      if (!result.success) {
        console.error('Failed to create terminal:', result.error);
        if (this._callbacks.onNotification) {
          this._callbacks.onNotification('info', result.error || t('terminals.createError'), null);
        }
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
    const isBasicTerminal = !runClaude;
    const tabName = customName || project.name;
    const initialStatus = isBasicTerminal ? 'ready' : 'loading';
    const nowIso = new Date().toISOString();
    const tabId = generateTabId(project.id);
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
      cwd: overrideCwd || project.path,
      tabId,
      createdAt: nowIso,
      lastActivityAt: nowIso,
      ...(resumeSessionId ? { claudeSessionId: resumeSessionId } : {}),
      ...(initialPrompt ? { pendingPrompt: initialPrompt } : {}),
      ...(overrideCwd ? { parentProjectId: project.id } : {})
    };

    addTerminal(id, termData);

    heartbeat(project.id, 'terminal');

    const tabsContainer = document.getElementById('terminals-tabs');
    const tab = document.createElement('div');
    const isWorktreeTab = !!(overrideCwd && overrideCwd !== project.path);
    tab.className = `terminal-tab status-${initialStatus}${isBasicTerminal ? ' basic-terminal' : ''}${isWorktreeTab ? ' worktree-tab' : ''}`;
    tab.dataset.id = id;
    tab.tabIndex = 0;
    tab.setAttribute('role', 'tab');
    const modeToggleHtml = !isBasicTerminal ? `
    <button class="tab-mode-toggle" title="${escapeHtml(t('chat.switchToChat'))}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
    </button>` : '';
    const worktreeIconHtml = isWorktreeTab ? `<span class="tab-worktree-icon" title="Worktree"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4" cy="4" r="1.5"/><circle cx="12" cy="4" r="1.5"/><circle cx="4" cy="12" r="1.5"/><path d="M4 5.5v5M5.5 4h5M12 5.5v2.5a2 2 0 01-2 2H7"/></svg></span>` : '';

    tab.innerHTML = `
    <span class="status-dot"></span>
    ${worktreeIconHtml}
    <span class="tab-name">${escapeHtml(tabName)}</span>
    ${modeToggleHtml}
    <button class="tab-close"><svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></button>`;
    tabsContainer.appendChild(tab);

    const container = document.getElementById('terminals-container');
    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper';
    wrapper.dataset.id = id;
    container.appendChild(wrapper);

    if (!isBasicTerminal) {
      const overlay = document.createElement('div');
      overlay.className = 'terminal-loading-overlay';
      overlay.innerHTML = `
      <div class="terminal-loading-spinner"></div>
      <div class="terminal-loading-text">${escapeHtml(t('terminals.loading'))}</div>
      <div class="terminal-loading-hint">${escapeHtml(t('terminals.loadingHint'))}</div>`;
      wrapper.appendChild(overlay);
      const self = this;
      this._loadingTimeouts.set(id, setTimeout(() => {
        self._loadingTimeouts.delete(id);
        self._dismissLoadingOverlay(id);
        const td = getTerminal(id);
        if (td && td.status === 'loading') {
          self.updateTerminalStatus(id, 'ready');
        }
      }, 30000));
    }

    document.getElementById('empty-terminals').style.display = 'none';

    terminal.open(wrapper);
    loadWebglAddon(terminal);
    setTimeout(() => {
      const fitContainer = wrapper.closest('.terminal-wrapper') || wrapper;
      if (fitContainer.offsetWidth > 0 && fitContainer.offsetHeight > 0) {
        fitAddon.fit();
      } else {
        requestAnimationFrame(() => fitAddon.fit());
      }
    }, 100);
    this.setActiveTerminal(id);

    this._setupPasteHandler(wrapper, id, 'terminal-input');
    this._setupClipboardShortcuts(wrapper, terminal, id, 'terminal-input');
    this._setupRightClickHandler(wrapper, terminal, id, 'terminal-input');

    terminal.attachCustomKeyEventHandler(this._createTerminalKeyHandler(terminal, id, 'terminal-input'));

    let lastTitle = '';
    let promptSent = false;
    const self = this;
    terminal.onTitleChange(title => {
      if (title === lastTitle) return;
      lastTitle = title;
      self._handleClaudeTitleChange(id, title, initialPrompt ? {
        onPendingPrompt: () => {
          const td = getTerminal(id);
          if (td && td.pendingPrompt && !promptSent) {
            promptSent = true;
            setTimeout(() => {
              self._api.terminal.input({ id, data: td.pendingPrompt + '\r' });
              updateTerminal(id, { pendingPrompt: null });
              self._postEnterExtended.add(id);
              self._cancelScheduledReady(id);
              self.updateTerminalStatus(id, 'working');
            }, 500);
            return true;
          }
          return false;
        }
      } : undefined);
    });

    this._registerTerminalHandler(id,
      (data) => {
        terminal.write(data.data);
        resetOutputSilenceTimer(id);
        const td = getTerminal(id);
        if (td?.project?.id) heartbeat(td.project.id, 'terminal');
      },
      () => self.closeTerminal(id)
    );

    const storedTermData = getTerminal(id);
    if (storedTermData) {
      storedTermData.handlers = { unregister: () => self._unregisterTerminalHandler(id) };
    }

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
        self.closeTerminal(id);
        self.createTerminal(project, {
          runClaude,
          cwd: overrideCwd || project.path,
          skipPermissions,
          name: customName,
          mode: explicitMode,
          initialPrompt,
          initialImages,
          initialModel,
          initialEffort,
          onSessionStart
        });
      }, RESUME_WATCHDOG_MS);
    }

    terminal.onData(data => {
      self._api.terminal.input({ id, data });
      const td = getTerminal(id);
      if (td?.project?.id) heartbeat(td.project.id, 'terminal');
      if (data === '\r' || data === '\n') {
        self._cancelScheduledReady(id);
        self.updateTerminalStatus(id, 'working');
        if (self._scrapingEventCallback) self._scrapingEventCallback(id, 'input', {});
        if (td && td.inputBuffer.trim().length > 0) {
          self._postEnterExtended.add(id);
          const title = extractTitleFromInput(td.inputBuffer);
          if (title) {
            self.updateTerminalTabName(id, title);
          }
          updateTerminal(id, { inputBuffer: '' });
        }
      } else if (data === '\x7f' || data === '\b') {
        if (td) updateTerminal(id, { inputBuffer: td.inputBuffer.slice(0, -1) });
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        if (td) updateTerminal(id, { inputBuffer: td.inputBuffer + data });
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      self._api.terminal.resize({ id, cols: terminal.cols, rows: terminal.rows });
    });
    resizeObserver.observe(wrapper);

    if (storedTermData) {
      storedTermData.resizeObserver = resizeObserver;
    }

    const selectedFilter = projectsState.get().selectedProjectFilter;
    this.filterByProject(selectedFilter);
    if (this._callbacks.onRenderProjects) this._callbacks.onRenderProjects();

    tab.onclick = (e) => { if (!e.target.closest('.tab-close') && !e.target.closest('.tab-name-input') && !e.target.closest('.tab-mode-toggle')) self.setActiveTerminal(id); };
    tab.querySelector('.tab-name').ondblclick = (e) => { e.stopPropagation(); self._startRenameTab(id); };
    tab.querySelector('.tab-close').onclick = (e) => { e.stopPropagation(); self.closeTerminal(id); };
    tab.oncontextmenu = (e) => self._showTabContextMenu(e, id);

    const modeToggleBtn = tab.querySelector('.tab-mode-toggle');
    if (modeToggleBtn) {
      modeToggleBtn.onclick = (e) => { e.stopPropagation(); self.switchTerminalMode(id); };
    }

    this._setupTabDragDrop(tab);

    return id;
  }

  // ── Type panel deps ──

  _getTypePanelDeps(consoleId, projectIndex) {
    const self = this;
    return {
      getTerminal,
      getFivemErrors,
      clearFivemErrors,
      getFivemResources,
      setFivemResourcesLoading,
      setFivemResources,
      getResourceShortcut,
      setResourceShortcut,
      api: this._api,
      t,
      consoleId,
      createTerminal: (project, opts) => self.createTerminal(project, opts),
      setActiveTerminal: (id) => self.setActiveTerminal(id),
      createTerminalWithPrompt: (project, prompt) => self._createTerminalWithPrompt(project, prompt),
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

  // ── Generic Type Console API ──

  getTypeConsoleId(projectIndex, typeId) {
    return this._typeConsoleIds.get(`${typeId}-${projectIndex}`);
  }

  _getTmApi() {
    const self = this;
    return {
      getTypeConsoleId: (pi, ti) => self.getTypeConsoleId(pi, ti),
      getTerminal,
      getTypePanelDeps: (cid, pi) => self._getTypePanelDeps(cid, pi),
      createTerminalWithPrompt: (project, prompt) => self._createTerminalWithPrompt(project, prompt),
      t,
      escapeHtml,
      projectsState,
      api: this._api
    };
  }

  createTypeConsole(project, projectIndex) {
    const typeHandler = registry.get(project.type);
    const config = typeHandler.getConsoleConfig(project, projectIndex);
    if (!config) return null;

    const { typeId, tabIcon, tabClass, dotClass, wrapperClass, consoleViewSelector, ipcNamespace, scrollback, disableStdin } = config;

    const mapKey = `${typeId}-${projectIndex}`;
    const existingId = this._typeConsoleIds.get(mapKey);
    if (existingId && getTerminal(existingId)) {
      this.setActiveTerminal(existingId);
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
    this._typeConsoleIds.set(mapKey, id);

    if (typeId === 'fivem') this._fivemConsoleIds.set(projectIndex, id);
    if (typeId === 'webapp') this._webappConsoleIds.set(projectIndex, id);
    if (typeId === 'api') this._apiConsoleIds.set(projectIndex, id);

    heartbeat(project.id, 'terminal');

    const tabsContainer = document.getElementById('terminals-tabs');
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

    const container = document.getElementById('terminals-container');
    const wrapper = document.createElement('div');
    wrapper.className = `terminal-wrapper ${wrapperClass}`;
    wrapper.dataset.id = id;

    const panels = typeHandler.getTerminalPanels({ project, projectIndex });
    const panel = panels && panels.length > 0 ? panels[0] : null;
    if (panel) {
      wrapper.innerHTML = panel.getWrapperHtml();
    }

    container.appendChild(wrapper);

    document.getElementById('empty-terminals').style.display = 'none';

    const consoleView = wrapper.querySelector(consoleViewSelector);
    terminal.open(consoleView);
    loadWebglAddon(terminal);
    setTimeout(() => {
      const fitContainer = wrapper.closest('.terminal-wrapper') || wrapper;
      if (fitContainer.offsetWidth > 0 && fitContainer.offsetHeight > 0) {
        fitAddon.fit();
      } else {
        requestAnimationFrame(() => fitAddon.fit());
      }
    }, 100);
    this.setActiveTerminal(id);

    this._setupPasteHandler(consoleView, projectIndex, `${typeId}-input`);
    this._setupClipboardShortcuts(consoleView, terminal, projectIndex, `${typeId}-input`);
    this._setupRightClickHandler(consoleView, terminal, projectIndex, `${typeId}-input`);
    terminal.attachCustomKeyEventHandler(this._createTerminalKeyHandler(terminal, projectIndex, `${typeId}-input`));

    if (disableStdin) {
      const self = this;
      wrapper.addEventListener('keydown', (e) => {
        if (!e.ctrlKey || e.shiftKey || e.altKey) return;
        if (e.key === 'c' || e.key === 'C') {
          const selection = terminal.getSelection();
          if (selection) {
            e.preventDefault();
            e.stopImmediatePropagation();
            navigator.clipboard.writeText(selection).catch(() => self._api.app.clipboardWrite(selection));
            terminal.clearSelection();
          }
        } else if (e.key === 'v' || e.key === 'V') {
          e.preventDefault();
          e.stopImmediatePropagation();
          self._performPaste(projectIndex, `${typeId}-input`);
        }
      }, true);
    }

    const existingLogs = config.getExistingLogs(projectIndex);
    if (existingLogs && existingLogs.length > 0) {
      terminal.write(existingLogs.join(''));
    }

    if (panel && panel.setupPanel) {
      const panelDeps = this._getTypePanelDeps(id, projectIndex);
      panel.setupPanel(wrapper, id, projectIndex, project, panelDeps);
    }

    if (!disableStdin) {
      terminal.attachCustomKeyEventHandler(this._createTerminalKeyHandler(terminal, projectIndex, `${typeId}-input`));
      terminal.onData(data => {
        this._api[ipcNamespace].input({ projectIndex, data });
      });
    }

    const self = this;
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      self._api[ipcNamespace].resize({
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

    this._api[ipcNamespace].resize({
      projectIndex,
      cols: terminal.cols,
      rows: terminal.rows
    });

    const selectedFilter = projectsState.get().selectedProjectFilter;
    this.filterByProject(selectedFilter);
    if (this._callbacks.onRenderProjects) this._callbacks.onRenderProjects();

    tab.onclick = (e) => { if (!e.target.closest('.tab-close') && !e.target.closest('.tab-name-input')) self.setActiveTerminal(id); };
    tab.querySelector('.tab-name').ondblclick = (e) => { e.stopPropagation(); self._startRenameTab(id); };
    tab.querySelector('.tab-close').onclick = (e) => { e.stopPropagation(); self._closeTypeConsole(id, projectIndex, typeId); };
    tab.oncontextmenu = (e) => self._showTabContextMenu(e, id);

    this._setupTabDragDrop(tab);

    return id;
  }

  _closeTypeConsole(id, projectIndex, typeId) {
    const termData = getTerminal(id);
    const closedProjectPath = termData?.project?.path;

    const typeHandler = registry.get(typeId);
    const config = typeHandler.getConsoleConfig(null, projectIndex);
    if (config && config.onCleanup) {
      const wrapper = document.querySelector(`.terminal-wrapper[data-id="${id}"]`);
      if (wrapper) config.onCleanup(wrapper);
    }

    this._cleanupTerminalResources(termData);
    removeTerminal(id);
    this._typeConsoleIds.delete(`${typeId}-${projectIndex}`);

    if (typeId === 'fivem') this._fivemConsoleIds.delete(projectIndex);
    if (typeId === 'webapp') this._webappConsoleIds.delete(projectIndex);
    if (typeId === 'api') this._apiConsoleIds.delete(projectIndex);

    document.querySelector(`.terminal-tab[data-id="${id}"]`)?.remove();
    document.querySelector(`.terminal-wrapper[data-id="${id}"]`)?.remove();

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
      this.setActiveTerminal(sameProjectTerminalId);
      const selectedFilter = projectsState.get().selectedProjectFilter;
      this.filterByProject(selectedFilter);
    } else if (projectIndex !== null && projectIndex !== undefined) {
      projectsState.setProp('selectedProjectFilter', projectIndex);
      this.filterByProject(projectIndex);
    } else {
      const selectedFilter = projectsState.get().selectedProjectFilter;
      this.filterByProject(selectedFilter);
    }

    if (this._callbacks.onRenderProjects) this._callbacks.onRenderProjects();
  }

  getTypeConsoleTerminal(projectIndex, typeId) {
    const id = this._typeConsoleIds.get(`${typeId}-${projectIndex}`);
    if (id) {
      const termData = getTerminal(id);
      if (termData) return termData.terminal;
    }
    return null;
  }

  writeTypeConsole(projectIndex, typeId, data) {
    const terminal = this.getTypeConsoleTerminal(projectIndex, typeId);
    if (terminal) terminal.write(data);
  }

  handleTypeConsoleError(projectIndex, error) {
    const projects = projectsState.get().projects;
    const project = projects[projectIndex];
    if (!project) return;

    const typeHandler = registry.get(project.type);
    typeHandler.onConsoleError(projectIndex, error, this._getTmApi());
  }

  showTypeErrorOverlay(projectIndex, error) {
    const projects = projectsState.get().projects;
    const project = projects[projectIndex];
    if (!project) return;

    const typeHandler = registry.get(project.type);
    typeHandler.showErrorOverlay(projectIndex, error, this._getTmApi());
  }

  // ── Legacy wrappers ──
  createFivemConsole(project, projectIndex) { return this.createTypeConsole(project, projectIndex); }
  createWebAppConsole(project, projectIndex) { return this.createTypeConsole(project, projectIndex); }
  createApiConsole(project, projectIndex) { return this.createTypeConsole(project, projectIndex); }

  closeFivemConsole(id, projectIndex) { return this._closeTypeConsole(id, projectIndex, 'fivem'); }
  closeWebAppConsole(id, projectIndex) { return this._closeTypeConsole(id, projectIndex, 'webapp'); }
  closeApiConsole(id, projectIndex) { return this._closeTypeConsole(id, projectIndex, 'api'); }

  getFivemConsoleTerminal(projectIndex) { return this.getTypeConsoleTerminal(projectIndex, 'fivem'); }
  getWebAppConsoleTerminal(projectIndex) { return this.getTypeConsoleTerminal(projectIndex, 'webapp'); }
  getApiConsoleTerminal(projectIndex) { return this.getTypeConsoleTerminal(projectIndex, 'api'); }

  writeFivemConsole(projectIndex, data) { return this.writeTypeConsole(projectIndex, 'fivem', data); }
  writeWebAppConsole(projectIndex, data) { return this.writeTypeConsole(projectIndex, 'webapp', data); }
  writeApiConsole(projectIndex, data) { return this.writeTypeConsole(projectIndex, 'api', data); }

  addFivemErrorToConsole(projectIndex, error) { return this.handleTypeConsoleError(projectIndex, error); }
  showFivemErrorOverlay(projectIndex, error) { return this.showTypeErrorOverlay(projectIndex, error); }
  hideErrorOverlay(projectIndex) {
    const projects = projectsState.get().projects;
    const project = projects[projectIndex];
    if (project) {
      const typeHandler = registry.get(project.type);
      typeHandler.hideErrorOverlay(projectIndex);
    }
  }

  // ── Prompts bar ──

  _renderPromptsBar(project) {
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

    const self = this;
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
            const wrapper = document.querySelector(`.terminal-wrapper[data-id="${activeTerminalId}"]`);
            const chatInput = wrapper?.querySelector('.chat-input');
            if (chatInput) {
              chatInput.value += resolvedText;
              chatInput.style.height = 'auto';
              chatInput.style.height = chatInput.scrollHeight + 'px';
              chatInput.focus();
            }
          } else {
            const ptyTarget = termData?.ptyId || activeTerminalId;
            self._api.terminal.input({ id: ptyTarget, data: resolvedText });
          }
        } catch (err) {
          console.error('[PromptsBar] Error resolving template:', err);
        }
      };
    });

    const manageFooter = dropdown.querySelector('#prompts-dropdown-manage');
    if (manageFooter) {
      manageFooter.onclick = () => {
        dropdown.classList.remove('active');
        promptsBtn.classList.remove('open');
        const settingsBtn = document.getElementById('btn-settings');
        if (settingsBtn) settingsBtn.click();
        setTimeout(() => {
          const libraryTab = document.querySelector('.settings-tab[data-tab="library"]');
          if (libraryTab) libraryTab.click();
        }, 100);
      };
    }

    promptsBtn.onclick = (e) => {
      e.stopPropagation();
      const isOpen = dropdown.classList.contains('active');

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

  _hidePromptsBar() {
    const wrapper = document.getElementById('prompts-dropdown-wrapper');
    if (wrapper) wrapper.style.display = 'none';
  }

  // ── Filter by project ──

  filterByProject(projectIndex) {
    const emptyState = document.getElementById('empty-terminals');
    const filterIndicator = document.getElementById('terminals-filter');
    const filterProjectName = document.getElementById('filter-project-name');
    const projects = projectsState.get().projects;

    if (projectIndex !== null && projects[projectIndex]) {
      filterIndicator.style.display = 'flex';
      filterProjectName.textContent = projects[projectIndex].name;

      const qa = getQuickActions();
      if (qa) {
        qa.setTerminalCallback((project, opts) => this.createTerminal(project, opts));
        qa.renderQuickActionsBar(projects[projectIndex]);
      }

      this._renderPromptsBar(projects[projectIndex]);
    } else {
      filterIndicator.style.display = 'none';

      const qa = getQuickActions();
      if (qa) {
        qa.hideQuickActionsBar();
      }

      this._hidePromptsBar();
    }

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
      const tab = tabsById.get(String(id));
      const wrapper = wrappersById.get(String(id));
      const shouldShow = projectIndex === null || (project && termData.project && (
        termData.project.path === project.path ||
        (termData.parentProjectId && termData.parentProjectId === project.id)
      ));

      if (tab) tab.style.display = shouldShow ? '' : 'none';
      if (wrapper) {
        if (shouldShow) {
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

    if (visibleCount === 0) {
      emptyState.style.display = 'flex';
      if (projectIndex !== null) {
        const project = projects[projectIndex];
        if (project) {
          this._renderSessionsPanel(project, emptyState);
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
        if (firstVisibleId) this.setActiveTerminal(firstVisibleId);
      }
    }
  }

  countTerminalsForProject(projectIndex) {
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

  getTerminalStatsForProject(projectIndex) {
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

  showAll() {
    this.filterByProject(null);
  }

  // ── Session Pins ──

  async _loadPins() {
    if (this._pinsCache) return this._pinsCache;
    try {
      const raw = await this._fsp.readFile(this._pinsFile, 'utf8');
      this._pinsCache = JSON.parse(raw);
    } catch {
      this._pinsCache = {};
    }
    return this._pinsCache;
  }

  async _savePins() {
    try {
      await this._fsp.writeFile(this._pinsFile, JSON.stringify(this._pinsCache || {}, null, 2), 'utf8');
    } catch { /* ignore write errors */ }
  }

  async _isSessionPinned(sessionId) {
    return !!(await this._loadPins())[sessionId];
  }

  async _toggleSessionPin(sessionId) {
    const pins = await this._loadPins();
    if (pins[sessionId]) {
      delete pins[sessionId];
    } else {
      pins[sessionId] = true;
    }
    this._pinsCache = pins;
    await this._savePins();
    return !!pins[sessionId];
  }

  // ── Session Custom Names ──

  async _loadSessionNames() {
    if (this._namesCache) return this._namesCache;
    try {
      const raw = await this._fsp.readFile(this._namesFile, 'utf8');
      this._namesCache = JSON.parse(raw);
    } catch {
      this._namesCache = {};
    }
    return this._namesCache;
  }

  async _saveSessionNames() {
    try {
      await this._fsp.writeFile(this._namesFile, JSON.stringify(this._namesCache || {}, null, 2), 'utf8');
    } catch { /* ignore write errors */ }
  }

  async _getSessionCustomName(sessionId) {
    return (await this._loadSessionNames())[sessionId] || '';
  }

  async _setSessionCustomName(sessionId, name) {
    const names = await this._loadSessionNames();
    if (name) {
      names[sessionId] = name;
    } else {
      delete names[sessionId];
    }
    this._namesCache = names;
    await this._saveSessionNames();
  }

  async _preprocessSessions(sessions) {
    const now = Date.now();
    const results = [];
    for (const session of sessions) {
      const promptResult = cleanSessionText(session.firstPrompt);
      const summaryResult = cleanSessionText(session.summary);
      const skillName = promptResult.skillName || summaryResult.skillName;
      const customName = await this._getSessionCustomName(session.sessionId);

      let displayTitle = '';
      let displaySubtitle = '';
      let isSkill = false;
      let isRenamed = false;

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

      const searchText = (displayTitle + ' ' + displaySubtitle + ' ' + (session.gitBranch || '') + ' ' + customName).toLowerCase();

      const pinned = await this._isSessionPinned(session.sessionId);
      results.push({ ...session, displayTitle, displaySubtitle, isSkill, isRenamed, freshness, searchText, pinned });
    }
    return results;
  }

  _startInlineRename(titleEl, sessionId, sessionData, onDone) {
    if (titleEl.querySelector('.session-rename-input')) return;
    const self = this;

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

    async function commit() {
      const newName = input.value.trim();
      cleanup();
      if (newName && newName !== currentName) {
        await self._setSessionCustomName(sessionId, newName);
        if (sessionData) {
          sessionData.displayTitle = newName;
          sessionData.isRenamed = true;
        }
      } else if (!newName) {
        await self._setSessionCustomName(sessionId, '');
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

  // ── Sessions panel ──

  async _renderSessionsPanel(project, emptyState) {
    const self = this;
    try {
      const sessions = await this._api.claude.sessions(project.path);

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
            if (self._callbacks.onCreateTerminal) self._callbacks.onCreateTerminal(project);
          };
        }
        return;
      }

      const processed = await this._preprocessSessions(sessions);
      const groups = groupSessionsByTime(processed);

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

      const flatSessions = [];
      groups.forEach(g => g.sessions.forEach(s => flatSessions.push(s)));
      const sessionMap = new Map(flatSessions.map(s => [s.sessionId, s]));

      const listEl = emptyState.querySelector('.sessions-list');

      function materializePlaceholder(el) {
        const idx = parseInt(el.dataset.lazyIndex);
        const session = flatSessions[idx];
        if (!session) return;
        const html = buildSessionCardHtml(session, idx);
        el.insertAdjacentHTML('afterend', html);
        el.remove();
      }

      let allMaterialized = false;
      function materializeAll() {
        if (allMaterialized) return;
        if (observer) observer.disconnect();
        const remaining = listEl.querySelectorAll('.session-card-placeholder');
        remaining.forEach(materializePlaceholder);
        allMaterialized = true;
      }

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

      listEl.addEventListener('click', async (e) => {
        const pinBtn = e.target.closest('.session-card-pin');
        if (pinBtn) {
          e.stopPropagation();
          const sid = pinBtn.dataset.pinSid;
          if (!sid) return;
          const nowPinned = await self._toggleSessionPin(sid);
          const session = sessionMap.get(sid);
          if (session) session.pinned = nowPinned;
          self._renderSessionsPanel(project, emptyState);
          return;
        }

        const renameBtn = e.target.closest('.session-card-rename');
        if (renameBtn) {
          e.stopPropagation();
          const sid = renameBtn.dataset.renameSid;
          if (!sid) return;
          const card = renameBtn.closest('.session-card');
          const titleEl = card?.querySelector('.session-card-title');
          if (!titleEl) return;
          self._startInlineRename(titleEl, sid, sessionMap.get(sid), () => self._renderSessionsPanel(project, emptyState));
          return;
        }

        const card = e.target.closest('.session-card');
        if (!card) return;
        const sessionId = card.dataset.sid;
        if (!sessionId) return;
        const skipPermissions = getSetting('skipPermissions') || false;
        self.resumeSession(project, sessionId, { skipPermissions });
      });

      emptyState.querySelector('.sessions-new-btn').onclick = () => {
        if (self._callbacks.onCreateTerminal) {
          self._callbacks.onCreateTerminal(project);
        }
      };

      const searchInput = emptyState.querySelector('.sessions-search');
      if (searchInput) {
        let searchTimer = null;
        searchInput.addEventListener('input', () => {
          clearTimeout(searchTimer);
          searchTimer = setTimeout(() => {
            const query = searchInput.value.toLowerCase().trim();

            if (query) materializeAll();

            const cards = listEl.querySelectorAll('.session-card');
            const groupEls = listEl.querySelectorAll('.session-group');

            const visibility = [];
            cards.forEach(card => {
              const sid = card.dataset.sid;
              const session = sessionMap.get(sid);
              const match = !query || (session && session.searchText.includes(query));
              visibility.push({ card, match });
            });

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

  // ── Resume session ──

  async resumeSession(project, sessionId, options = {}) {
    const { skipPermissions = false, name: sessionName = null } = options;

    const mode = getSetting('defaultTerminalMode') || 'terminal';
    if (mode === 'chat') {
      console.log(`[TerminalManager] Resuming in chat mode — sessionId: ${sessionId}`);
      return this._createChatTerminal(project, { skipPermissions, resumeSessionId: sessionId, name: sessionName });
    }

    const result = await this._api.terminal.create({
      cwd: project.path,
      runClaude: true,
      resumeSessionId: sessionId,
      skipPermissions
    });

    if (result && typeof result === 'object' && 'success' in result) {
      if (!result.success) {
        console.error('Failed to resume session:', result.error);
        if (this._callbacks.onNotification) {
          this._callbacks.onNotification('info', result.error || t('terminals.resumeError'), null);
        }
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
    const nowIsoResume = new Date().toISOString();
    const termData = {
      terminal,
      fitAddon,
      project,
      projectIndex,
      name: sessionName || t('terminals.resuming'),
      status: 'working',
      inputBuffer: '',
      isBasic: false,
      mode: 'terminal',
      claudeSessionId: sessionId,
      tabId: generateTabId(project.id),
      createdAt: nowIsoResume,
      lastActivityAt: nowIsoResume,
    };

    addTerminal(id, termData);

    if (sessionName) {
      await this._setSessionCustomName(sessionId, sessionName);
    }

    heartbeat(project.id, 'terminal');

    const tabsContainer = document.getElementById('terminals-tabs');
    const tab = document.createElement('div');
    tab.className = 'terminal-tab status-working';
    tab.dataset.id = id;
    tab.innerHTML = `
    <span class="status-dot"></span>
    <span class="tab-name">${escapeHtml(sessionName || t('terminals.resuming'))}</span>
    <button class="tab-close"><svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></button>`;
    tabsContainer.appendChild(tab);

    const container = document.getElementById('terminals-container');
    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper';
    wrapper.dataset.id = id;
    container.appendChild(wrapper);

    document.getElementById('empty-terminals').style.display = 'none';

    terminal.open(wrapper);
    loadWebglAddon(terminal);
    setTimeout(() => {
      const fitContainer = wrapper.closest('.terminal-wrapper') || wrapper;
      if (fitContainer.offsetWidth > 0 && fitContainer.offsetHeight > 0) {
        fitAddon.fit();
      } else {
        requestAnimationFrame(() => fitAddon.fit());
      }
    }, 100);
    this.setActiveTerminal(id);

    this._setupPasteHandler(wrapper, id, 'terminal-input');
    this._setupClipboardShortcuts(wrapper, terminal, id, 'terminal-input');
    this._setupRightClickHandler(wrapper, terminal, id, 'terminal-input');

    terminal.attachCustomKeyEventHandler(this._createTerminalKeyHandler(terminal, id, 'terminal-input'));

    let lastTitle = '';
    const self = this;
    terminal.onTitleChange(title => {
      if (title === lastTitle) return;
      lastTitle = title;
      self._handleClaudeTitleChange(id, title);
    });

    this._registerTerminalHandler(id,
      (data) => {
        terminal.write(data.data);
        resetOutputSilenceTimer(id);
        const td = getTerminal(id);
        if (td?.project?.id) heartbeat(td.project.id, 'terminal');
      },
      () => self.closeTerminal(id)
    );

    const storedResumeTermData = getTerminal(id);
    if (storedResumeTermData) {
      storedResumeTermData.handlers = { unregister: () => self._unregisterTerminalHandler(id) };
    }

    terminal.onData(data => {
      self._api.terminal.input({ id, data });
      const td = getTerminal(id);
      if (td?.project?.id) heartbeat(td.project.id, 'terminal');
      if (data === '\r' || data === '\n') {
        self._cancelScheduledReady(id);
        self.updateTerminalStatus(id, 'working');
        if (td && td.inputBuffer.trim().length > 0) {
          self._postEnterExtended.add(id);
          const title = extractTitleFromInput(td.inputBuffer);
          if (title) self.updateTerminalTabName(id, title);
          updateTerminal(id, { inputBuffer: '' });
        }
      } else if (data === '\x7f' || data === '\b') {
        if (td) updateTerminal(id, { inputBuffer: td.inputBuffer.slice(0, -1) });
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        if (td) updateTerminal(id, { inputBuffer: td.inputBuffer + data });
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      self._api.terminal.resize({ id, cols: terminal.cols, rows: terminal.rows });
    });
    resizeObserver.observe(wrapper);

    if (storedResumeTermData) {
      storedResumeTermData.resizeObserver = resizeObserver;
    }

    const selectedFilter = projectsState.get().selectedProjectFilter;
    this.filterByProject(selectedFilter);
    if (this._callbacks.onRenderProjects) this._callbacks.onRenderProjects();

    tab.onclick = (e) => { if (!e.target.closest('.tab-close') && !e.target.closest('.tab-name-input')) self.setActiveTerminal(id); };
    tab.querySelector('.tab-name').ondblclick = (e) => { e.stopPropagation(); self._startRenameTab(id); };
    tab.querySelector('.tab-close').onclick = (e) => { e.stopPropagation(); self.closeTerminal(id); };
    tab.oncontextmenu = (e) => self._showTabContextMenu(e, id);

    this._setupTabDragDrop(tab);

    return id;
  }

  // ── Create terminal with prompt ──

  async _createTerminalWithPrompt(project, prompt) {
    const result = await this._api.terminal.create({
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
    const nowIsoDebug = new Date().toISOString();
    const termData = {
      terminal,
      fitAddon,
      project,
      projectIndex,
      name: `🐛 ${t('terminals.debug')}`,
      status: 'working',
      inputBuffer: '',
      isBasic: false,
      mode: 'terminal',
      pendingPrompt: prompt,
      tabId: generateTabId(project.id),
      createdAt: nowIsoDebug,
      lastActivityAt: nowIsoDebug,
    };

    addTerminal(id, termData);

    const tabsContainer = document.getElementById('terminals-tabs');
    const tab = document.createElement('div');
    tab.className = 'terminal-tab status-working';
    tab.dataset.id = id;
    tab.innerHTML = `
    <span class="status-dot"></span>
    <span class="tab-name">${escapeHtml(`🐛 ${t('terminals.debug')}`)}</span>
    <button class="tab-close"><svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></button>`;
    tabsContainer.appendChild(tab);

    const container = document.getElementById('terminals-container');
    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper';
    wrapper.dataset.id = id;
    container.appendChild(wrapper);

    document.getElementById('empty-terminals').style.display = 'none';

    terminal.open(wrapper);
    loadWebglAddon(terminal);
    setTimeout(() => {
      const fitContainer = wrapper.closest('.terminal-wrapper') || wrapper;
      if (fitContainer.offsetWidth > 0 && fitContainer.offsetHeight > 0) {
        fitAddon.fit();
      } else {
        requestAnimationFrame(() => fitAddon.fit());
      }
    }, 100);
    this.setActiveTerminal(id);

    this._setupPasteHandler(wrapper, id, 'terminal-input');
    this._setupClipboardShortcuts(wrapper, terminal, id, 'terminal-input');
    this._setupRightClickHandler(wrapper, terminal, id, 'terminal-input');

    terminal.attachCustomKeyEventHandler(this._createTerminalKeyHandler(terminal, id, 'terminal-input'));

    let lastTitle = '';
    let promptSent = false;
    const self = this;
    terminal.onTitleChange(title => {
      if (title === lastTitle) return;
      lastTitle = title;
      self._handleClaudeTitleChange(id, title, {
        onPendingPrompt: () => {
          const td = getTerminal(id);
          if (td && td.pendingPrompt && !promptSent) {
            promptSent = true;
            setTimeout(() => {
              self._api.terminal.input({ id, data: td.pendingPrompt + '\r' });
              updateTerminal(id, { pendingPrompt: null });
              self._postEnterExtended.add(id);
              self._cancelScheduledReady(id);
              self.updateTerminalStatus(id, 'working');
            }, 500);
            return true;
          }
          return false;
        }
      });
    });

    this._registerTerminalHandler(id,
      (data) => {
        terminal.write(data.data);
        resetOutputSilenceTimer(id);
      },
      () => self.closeTerminal(id)
    );

    const storedTermData = getTerminal(id);
    if (storedTermData) {
      storedTermData.handlers = { unregister: () => self._unregisterTerminalHandler(id) };
    }

    terminal.onData(data => {
      self._api.terminal.input({ id, data });
      const td = getTerminal(id);
      if (data === '\r' || data === '\n') {
        self._cancelScheduledReady(id);
        self.updateTerminalStatus(id, 'working');
        if (td && td.inputBuffer.trim().length > 0) {
          self._postEnterExtended.add(id);
          const title = extractTitleFromInput(td.inputBuffer);
          if (title) self.updateTerminalTabName(id, title);
          updateTerminal(id, { inputBuffer: '' });
        }
      } else if (data === '\x7f' || data === '\b') {
        if (td) updateTerminal(id, { inputBuffer: td.inputBuffer.slice(0, -1) });
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        if (td) updateTerminal(id, { inputBuffer: td.inputBuffer + data });
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      self._api.terminal.resize({ id, cols: terminal.cols, rows: terminal.rows });
    });
    resizeObserver.observe(wrapper);

    if (storedTermData) {
      storedTermData.resizeObserver = resizeObserver;
    }

    const selectedFilter = projectsState.get().selectedProjectFilter;
    this.filterByProject(selectedFilter);
    if (this._callbacks.onRenderProjects) this._callbacks.onRenderProjects();

    tab.onclick = (e) => { if (!e.target.closest('.tab-close') && !e.target.closest('.tab-name-input')) self.setActiveTerminal(id); };
    tab.querySelector('.tab-name').ondblclick = (e) => { e.stopPropagation(); self._startRenameTab(id); };
    tab.querySelector('.tab-close').onclick = (e) => { e.stopPropagation(); self.closeTerminal(id); };
    tab.oncontextmenu = (e) => self._showTabContextMenu(e, id);

    this._setupTabDragDrop(tab);

    return id;
  }

  // ── Open file tab ──

  async openFileTab(filePath, project) {
    const terminals = terminalsState.get().terminals;
    let existingId = null;
    terminals.forEach((td, id) => {
      if (td.type === 'file' && td.filePath === filePath) {
        existingId = id;
      }
    });
    if (existingId) {
      this.setActiveTerminal(existingId);
      return existingId;
    }

    const id = `file-${Date.now()}`;
    const fileName = this._path.basename(filePath);
    const ext = fileName.lastIndexOf('.') !== -1 ? fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase() : '';
    const projectIndex = project ? getProjectIndex(project.id) : null;

    const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'avif']);
    const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogg', 'mov']);
    const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'wma']);
    const PDF_EXTENSIONS = new Set(['pdf']);
    const MODEL_3D_EXTENSIONS = new Set(['obj', 'stl', 'gltf', 'glb']);
    const isImage = IMAGE_EXTENSIONS.has(ext);
    const isVideo = VIDEO_EXTENSIONS.has(ext);
    const isAudio = AUDIO_EXTENSIONS.has(ext);
    const isPdf = PDF_EXTENSIONS.has(ext);
    const is3D = MODEL_3D_EXTENSIONS.has(ext);
    const isMedia = isImage || isVideo || isAudio || isPdf || is3D;
    const isMarkdown = ext === 'md';

    let content = '';
    let fileSize = 0;
    try {
      const stat = await this._fsp.stat(filePath);
      fileSize = stat.size;
      if (!isMedia) {
        content = await this._fsp.readFile(filePath, 'utf-8');
      }
    } catch (e) {
      content = `Error reading file: ${e.message}`;
    }

    let sizeStr;
    if (fileSize < 1024) sizeStr = `${fileSize} B`;
    else if (fileSize < 1024 * 1024) sizeStr = `${(fileSize / 1024).toFixed(1)} KB`;
    else sizeStr = `${(fileSize / (1024 * 1024)).toFixed(1)} MB`;

    const termData = {
      type: 'file',
      filePath,
      project,
      projectIndex,
      name: fileName,
      status: 'ready'
    };
    addTerminal(id, termData);

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

    const container = document.getElementById('terminals-container');
    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper file-wrapper';
    wrapper.dataset.id = id;

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
    } else if (isPdf) {
      viewerBody = `
    <div class="file-viewer-pdf" id="pdf-viewer-${id}">
      <div class="file-viewer-pdf-toolbar"></div>
      <div class="file-viewer-pdf-pages"></div>
    </div>`;
      termData.isPdf = true;
    } else if (is3D) {
      viewerBody = `
    <div class="file-viewer-3d" id="three-viewer-${id}"></div>`;
      termData.is3D = true;
      termData.modelExt = ext;
    } else if (isMarkdown) {
      const basePath = this._path.dirname(filePath);
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

      termData.isMarkdown = true;
      termData.mdViewMode = 'rendered';
      termData.mdRenderer = mdRenderer;
      termData.mdCleanup = null;
    } else {
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

    if (termData.isPdf) {
      const pdfContainer = wrapper.querySelector('.file-viewer-pdf');
      import('./dist/pdf-viewer.bundle.js').then(m => {
        const viewer = m.renderPdf(pdfContainer, fileUrl);
        termData.viewerCleanup = () => viewer.destroy();
      }).catch(err => {
        pdfContainer.querySelector('.file-viewer-pdf-pages').innerHTML =
          `<div class="pdf-loading pdf-error">Failed to load PDF viewer: ${err.message}</div>`;
      });
    }

    if (termData.is3D) {
      const threeContainer = wrapper.querySelector('.file-viewer-3d');
      import('./dist/three-viewer.bundle.js').then(m => {
        const viewer = m.render3D(threeContainer, fileUrl, termData.modelExt);
        termData.viewerCleanup = () => viewer.destroy();
      }).catch(err => {
        threeContainer.innerHTML =
          `<div class="file-viewer-3d-error">Failed to load 3D viewer: ${err.message}</div>`;
      });
    }

    if (isMarkdown) {
      const header = wrapper.querySelector('.file-viewer-header');
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'md-viewer-toggle-btn';
      toggleBtn.title = t('mdViewer.toggleSource');
      toggleBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/></svg>`;
      header.appendChild(toggleBtn);

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

      wrapper.addEventListener('click', (e) => {
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

        const link = e.target.closest('[data-md-link]');
        if (link) {
          e.preventDefault();
          if (e.ctrlKey) {
            this._api.dialog.openExternal(link.dataset.mdLink);
          }
          return;
        }

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

      const tocToggle = wrapper.querySelector('.md-toc-toggle');
      if (tocToggle) {
        tocToggle.addEventListener('click', () => {
          const tocEl = wrapper.querySelector('.md-viewer-toc');
          tocEl.classList.toggle('collapsed');
          setSetting('mdViewerTocExpanded', !tocEl.classList.contains('collapsed'));
        });
      }

      let reloadTimer = null;
      const self = this;
      const unsubscribeWatch = this._api.dialog.onFileChanged((changedPath) => {
        if (changedPath !== filePath) return;
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(async () => {
          try {
            const newContent = await self._fsp.readFile(filePath, 'utf-8');
            const bodyEl = document.getElementById(`md-body-${id}`);
            if (!bodyEl) return;
            const scroll = bodyEl.scrollTop;
            bodyEl.innerHTML = termData.mdRenderer.parse(newContent);
            bodyEl.scrollTop = scroll;
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
      this._api.dialog.watchFile(filePath);

      termData.mdCleanup = () => {
        unsubscribeWatch();
        self._api.dialog.unwatchFile(filePath);
        clearTimeout(reloadTimer);
      };

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

    this.setActiveTerminal(id);

    const self = this;
    tab.onclick = (e) => { if (!e.target.closest('.tab-close') && !e.target.closest('.tab-name-input')) self.setActiveTerminal(id); };
    tab.querySelector('.tab-name').ondblclick = (e) => { e.stopPropagation(); self._startRenameTab(id); };
    tab.querySelector('.tab-close').onclick = (e) => { e.stopPropagation(); self.closeTerminal(id); };
    tab.oncontextmenu = (e) => self._showTabContextMenu(e, id);

    this._setupTabDragDrop(tab);

    const selectedFilter = projectsState.get().selectedProjectFilter;
    this.filterByProject(selectedFilter);
    if (this._callbacks.onRenderProjects) this._callbacks.onRenderProjects();

    return id;
  }

  // ── Theme ──

  updateAllTerminalsTheme(themeId) {
    const theme = getTerminalTheme(themeId);
    const terminals = terminalsState.get().terminals;

    terminals.forEach((termData, id) => {
      if (termData.terminal && termData.terminal.options) {
        termData.terminal.options.theme = theme;
      }
    });
  }

  // ── Navigation ──

  _getVisibleTerminalIds() {
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

  focusNextTerminal() {
    const visibleTerminals = this._getVisibleTerminalIds();
    if (visibleTerminals.length === 0) return;

    const currentId = terminalsState.get().activeTerminal;
    const currentIndex = visibleTerminals.indexOf(currentId);

    let targetIndex;
    if (currentIndex === -1) {
      targetIndex = 0;
    } else {
      targetIndex = (currentIndex + 1) % visibleTerminals.length;
    }

    this.setActiveTerminal(visibleTerminals[targetIndex]);
  }

  focusPrevTerminal() {
    const visibleTerminals = this._getVisibleTerminalIds();
    if (visibleTerminals.length === 0) return;

    const currentId = terminalsState.get().activeTerminal;
    const currentIndex = visibleTerminals.indexOf(currentId);

    let targetIndex;
    if (currentIndex === -1) {
      targetIndex = 0;
    } else {
      targetIndex = (currentIndex - 1 + visibleTerminals.length) % visibleTerminals.length;
    }

    this.setActiveTerminal(visibleTerminals[targetIndex]);
  }

  // ── Chat terminal ──

  async _createChatTerminal(project, options = {}) {
    const { skipPermissions = false, name: customName = null, resumeSessionId = null, forkSession = false, resumeSessionAt = null, parentProjectId = null, initialPrompt = null, initialImages = null, initialModel = null, initialEffort = null, onSessionStart = null, systemPrompt = null, tabTag = null } = options;

    const id = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let _chatSessionId = null;
    const isCloud = !!project.isCloud;
    const projectIndex = isCloud ? -1 : getProjectIndex(parentProjectId || project.id);
    const tabName = customName || project.name;
    const nowIsoChat = new Date().toISOString();

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
      tabId: generateTabId(parentProjectId || project.id || 'cloud'),
      createdAt: nowIsoChat,
      lastActivityAt: nowIsoChat,
      ...(parentProjectId ? { parentProjectId } : {}),
      ...(resumeSessionId ? { claudeSessionId: resumeSessionId } : {})
    };

    addTerminal(id, termData);
    if (!isCloud) heartbeat(parentProjectId || project.id, 'terminal');

    const tabsContainer = document.getElementById('terminals-tabs');
    const tab = document.createElement('div');
    const mainProjectPath = parentProjectId ? projectsState.get().projects.find(p => p.id === parentProjectId)?.path : null;
    const isWorktreeChatTab = !!(mainProjectPath && project.path !== mainProjectPath);
    tab.className = `terminal-tab status-ready chat-mode${isWorktreeChatTab ? ' worktree-tab' : ''}`;
    tab.dataset.id = id;
    tab.tabIndex = 0;
    tab.setAttribute('role', 'tab');
    const worktreeIconHtmlChat = isWorktreeChatTab ? `<span class="tab-worktree-icon" title="Worktree"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4" cy="4" r="1.5"/><circle cx="12" cy="4" r="1.5"/><circle cx="4" cy="12" r="1.5"/><path d="M4 5.5v5M5.5 4h5M12 5.5v2.5a2 2 0 01-2 2H7"/></svg></span>` : '';
    const tabTagHtml = tabTag ? `<span class="tab-tag" style="background:${tabTag.color || 'var(--accent)'}20;color:${tabTag.color || 'var(--accent)'};border:1px solid ${tabTag.color || 'var(--accent)'}40">${escapeHtml(tabTag.label)}</span>` : '';
    tab.innerHTML = `
    <span class="status-dot"></span>
    ${worktreeIconHtmlChat}
    <span class="tab-name">${escapeHtml(tabName)}</span>
    ${tabTagHtml}
    ${isCloud ? '' : `<button class="tab-mode-toggle" title="${escapeHtml(t('chat.switchToTerminal'))}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v12zm-2-1h-6v-2h6v2zM7.5 17l-1.41-1.41L8.67 13l-2.59-2.59L7.5 9l4 4-4 4z"/></svg>
    </button>`}
    <button class="tab-close"><svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></button>`;
    tabsContainer.appendChild(tab);

    const container = document.getElementById('terminals-container');
    const wrapper = document.createElement('div');
    wrapper.className = 'terminal-wrapper chat-wrapper';
    wrapper.dataset.id = id;
    container.appendChild(wrapper);

    document.getElementById('empty-terminals').style.display = 'none';

    const projSettings = isCloud ? {} : getProjectSettingsState(parentProjectId || project.id);
    const effectiveSkipPermissions = isCloud || skipPermissions || (projSettings.skipPermissions === true);
    const effectiveModel = initialModel || projSettings.chatModel || null;
    const effectiveEffort = initialEffort || projSettings.effortLevel || null;

    const self = this;
    const chatView = createChatView(wrapper, project, {
      terminalId: id,
      skipPermissions: effectiveSkipPermissions,
      resumeSessionId,
      forkSession,
      resumeSessionAt,
      initialPrompt,
      initialImages,
      initialModel: effectiveModel,
      initialEffort: effectiveEffort,
      builtinSystemPrompt: getBuiltinSystemPrompt(project.type),
      ...(systemPrompt ? { systemPrompt } : {}),
      onSessionStart: (sid) => {
        _chatSessionId = sid;
        updateTerminal(id, { claudeSessionId: sid });
        if (onSessionStart) onSessionStart(sid);
      },
      onTabRename: async (name) => {
        const nameEl = tab.querySelector('.tab-name');
        if (nameEl) nameEl.textContent = name;
        const data = getTerminal(id);
        if (data) data.name = name;
        if (_chatSessionId && name) {
          await self._setSessionCustomName(_chatSessionId, name);
        }
        if (_chatSessionId && self._api.remote?.notifyTabRenamed) {
          self._api.remote.notifyTabRenamed({ sessionId: _chatSessionId, tabName: name });
        }
      },
      onStatusChange: (status, substatus) => self._updateChatTerminalStatus(id, status, substatus),
      onSwitchTerminal: (dir) => self._callbacks.onSwitchTerminal?.(dir),
      onSwitchProject: (dir) => self._callbacks.onSwitchProject?.(dir),
      onForkSession: ({ resumeSessionId: forkSid, resumeSessionAt: forkAt, model: forkModel, effort: forkEffort, skipPermissions: forkSkipPerms }) => {
        self._createChatTerminal(project, {
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

    this.setActiveTerminal(id);

    const selectedFilter = projectsState.get().selectedProjectFilter;
    this.filterByProject(selectedFilter);
    if (this._callbacks.onRenderProjects) this._callbacks.onRenderProjects();

    tab.onclick = (e) => { if (!e.target.closest('.tab-close') && !e.target.closest('.tab-name-input') && !e.target.closest('.tab-mode-toggle')) self.setActiveTerminal(id); };
    tab.querySelector('.tab-name').ondblclick = (e) => { e.stopPropagation(); self._startRenameTab(id); };
    tab.querySelector('.tab-close').onclick = (e) => { e.stopPropagation(); self.closeTerminal(id); };
    tab.oncontextmenu = (e) => self._showTabContextMenu(e, id);
    const modeToggleBtn = tab.querySelector('.tab-mode-toggle');
    if (modeToggleBtn) {
      modeToggleBtn.onclick = (e) => { e.stopPropagation(); self.switchTerminalMode(id); };
    }
    this._setupTabDragDrop(tab);

    return id;
  }

  // ── Switch terminal mode ──

  async switchTerminalMode(id) {
    const termData = getTerminal(id);
    if (!termData || termData.isBasic) return;

    const project = termData.project;
    const currentMode = termData.mode || 'terminal';
    const newMode = currentMode === 'terminal' ? 'chat' : 'terminal';
    const wrapper = document.querySelector(`.terminal-wrapper[data-id="${id}"]`);
    const tab = document.querySelector(`.terminal-tab[data-id="${id}"]`);

    if (!wrapper || !tab) return;

    if (currentMode === 'terminal') {
      this._api.terminal.kill({ id });
      this._cleanupTerminalResources(termData);
      clearOutputSilenceTimer(id);
      this._cancelScheduledReady(id);
    } else if (currentMode === 'chat') {
      if (termData.chatView) {
        termData.chatView.destroy();
      }
    }

    wrapper.innerHTML = '';

    const self = this;

    if (newMode === 'chat') {
      wrapper.classList.add('chat-wrapper');
      tab.classList.add('chat-mode');

      const chatView = createChatView(wrapper, project, {
        terminalId: id,
        skipPermissions: getSetting('skipPermissions') || false,
        builtinSystemPrompt: getBuiltinSystemPrompt(project.type),
        onStatusChange: (status, substatus) => self._updateChatTerminalStatus(id, status, substatus),
        onSwitchTerminal: (dir) => self._callbacks.onSwitchTerminal?.(dir),
        onSwitchProject: (dir) => self._callbacks.onSwitchProject?.(dir),
      });

      updateTerminal(id, { mode: 'chat', chatView, terminal: null, fitAddon: null, status: 'ready' });

      const toggleBtn = tab.querySelector('.tab-mode-toggle');
      if (toggleBtn) {
        toggleBtn.title = t('chat.switchToTerminal');
        toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v12zm-2-1h-6v-2h6v2zM7.5 17l-1.41-1.41L8.67 13l-2.59-2.59L7.5 9l4 4-4 4z"/></svg>';
      }

      chatView.focus();
    } else {
      wrapper.classList.remove('chat-wrapper');
      tab.classList.remove('chat-mode');

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

      const result = await this._api.terminal.create({
        cwd: project.path,
        runClaude: true,
        skipPermissions: getSetting('skipPermissions') || false
      });

      if (result && typeof result === 'object' && result.success === false) {
        console.error('Failed to create terminal on mode switch:', result.error);
        terminal.dispose();
        wrapper.innerHTML = `<div class="terminal-error-state"><p>${escapeHtml(result.error || t('terminals.createError'))}</p></div>`;
        updateTerminal(id, { mode: 'terminal', chatView: null, terminal: null, fitAddon: null, status: 'error' });
        if (this._callbacks.onNotification) {
          this._callbacks.onNotification('info', result.error || t('terminals.createError'), null);
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

      const overlay = document.createElement('div');
      overlay.className = 'terminal-loading-overlay';
      overlay.innerHTML = `
      <div class="terminal-loading-spinner"></div>
      <div class="terminal-loading-text">${escapeHtml(t('terminals.loading'))}</div>
      <div class="terminal-loading-hint">${escapeHtml(t('terminals.loadingHint'))}</div>`;
      wrapper.appendChild(overlay);
      this._loadingTimeouts.set(id, setTimeout(() => {
        self._loadingTimeouts.delete(id);
        self._dismissLoadingOverlay(id);
        const td = getTerminal(id);
        if (td && td.status === 'loading') self.updateTerminalStatus(id, 'ready');
      }, 30000));

      setTimeout(() => {
        const fitContainer = wrapper.closest('.terminal-wrapper') || wrapper;
        if (fitContainer.offsetWidth > 0 && fitContainer.offsetHeight > 0) {
          fitAddon.fit();
        } else {
          requestAnimationFrame(() => fitAddon.fit());
        }
      }, 100);

      this._setupPasteHandler(wrapper, ptyId, 'terminal-input');
      this._setupClipboardShortcuts(wrapper, terminal, ptyId, 'terminal-input');
      this._setupRightClickHandler(wrapper, terminal, ptyId, 'terminal-input');
      terminal.attachCustomKeyEventHandler(this._createTerminalKeyHandler(terminal, ptyId, 'terminal-input'));

      let lastTitle = '';
      terminal.onTitleChange(title => {
        if (title === lastTitle) return;
        lastTitle = title;
        self._handleClaudeTitleChange(id, title);
      });

      this._registerTerminalHandler(ptyId,
        (data) => {
          terminal.write(data.data);
          resetOutputSilenceTimer(id);
          const td = getTerminal(id);
          if (td?.project?.id) heartbeat(td.project.id, 'terminal');
        },
        () => self.closeTerminal(id)
      );

      const storedTermData = getTerminal(id);
      if (storedTermData) {
        storedTermData.handlers = { unregister: () => self._unregisterTerminalHandler(ptyId) };
      }

      terminal.onData(data => {
        self._api.terminal.input({ id: ptyId, data });
        const td = getTerminal(id);
        if (td?.project?.id) heartbeat(td.project.id, 'terminal');
        if (data === '\r' || data === '\n') {
          self._cancelScheduledReady(id);
          self.updateTerminalStatus(id, 'working');
        }
      });

      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        self._api.terminal.resize({ id: ptyId, cols: terminal.cols, rows: terminal.rows });
      });
      resizeObserver.observe(wrapper);

      if (storedTermData) {
        storedTermData.resizeObserver = resizeObserver;
      }

      const toggleBtn = tab.querySelector('.tab-mode-toggle');
      if (toggleBtn) {
        toggleBtn.title = t('chat.switchToChat');
        toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>';
      }

      terminal.focus();
    }

    tab.className = tab.className.replace(/status-\w+/, `status-${getTerminal(id)?.status || 'ready'}`);
  }

  // ── Cleanup ──

  cleanupProjectMaps(projectIndex) {
    this._fivemConsoleIds.delete(projectIndex);
    this._webappConsoleIds.delete(projectIndex);
    this._apiConsoleIds.delete(projectIndex);
    this._errorOverlays.delete(projectIndex);
    for (const key of this._typeConsoleIds.keys()) {
      if (key.endsWith(`-${projectIndex}`)) {
        this._typeConsoleIds.delete(key);
      }
    }
  }

  scheduleScrollAfterRestore(id) {
    const SILENCE_MS = 300;
    const MAX_WAIT_MS = 8000;
    const POLL_MS = 50;
    const self = this;

    const startTime = Date.now();

    const poll = setInterval(() => {
      const td = getTerminal(id);
      if (!td || !td.terminal || typeof td.terminal.scrollToBottom !== 'function') {
        clearInterval(poll);
        return;
      }

      const lastData = self._lastTerminalData.get(id);
      const silentFor = lastData ? Date.now() - lastData : Date.now() - startTime;
      const timedOut  = Date.now() - startTime >= MAX_WAIT_MS;

      if (silentFor >= SILENCE_MS || timedOut) {
        clearInterval(poll);
        td.terminal.scrollToBottom();
      }
    }, POLL_MS);
  }

  // ── MCP orchestration helpers ──
  // Consumed by the `tabs.js` MCP tool module via IPC triggers.

  getTabByTabId(tabId) {
    return getTerminalByTabId(tabId);
  }

  sendToTab(tabId, content) {
    const found = getTerminalByTabId(tabId);
    if (!found) return { ok: false, error: `Tab not found: ${tabId}` };
    const { id, data } = found;
    const text = String(content ?? '');

    if (data.mode === 'chat') {
      if (!data.chatView) return { ok: false, error: 'Chat view not ready yet' };
      try {
        if (typeof data.chatView.sendMessage === 'function') {
          data.chatView.sendMessage(text);
        } else if (typeof data.chatView.submit === 'function') {
          data.chatView.submit(text);
        } else if (typeof data.chatView.send === 'function') {
          data.chatView.send(text);
        } else if (typeof data.chatView.setInputValue === 'function' && typeof data.chatView.submitCurrent === 'function') {
          data.chatView.setInputValue(text);
          data.chatView.submitCurrent();
        } else {
          return { ok: false, error: 'Chat view exposes no send API' };
        }
      } catch (e) {
        return { ok: false, error: e.message };
      }
      data.lastActivityAt = new Date().toISOString();
      return { ok: true, tabId, mode: 'chat' };
    }

    if (data.isBasic || data.mode === 'terminal') {
      try {
        this._api.terminal.input({ id, data: text + (text.endsWith('\r') || text.endsWith('\n') ? '' : '\r') });
      } catch (e) {
        return { ok: false, error: e.message };
      }
      data.lastCommand = text;
      data.lastActivityAt = new Date().toISOString();
      return { ok: true, tabId, mode: 'terminal' };
    }

    return { ok: false, error: `Unsupported tab mode: ${data.mode}` };
  }

  getStatusForTab(tabId) {
    const { deriveTabStatus } = require('../../state/terminals.state');
    const found = getTerminalByTabId(tabId);
    if (!found) return null;
    const { id, data } = found;
    const status = deriveTabStatus(data);
    const base = {
      tabId,
      ptyId: typeof id === 'number' ? id : null,
      projectId: data.project?.id || null,
      projectName: data.project?.name || data.name || null,
      mode: data.mode || 'terminal',
      title: data.name || null,
      status,
      createdAt: data.createdAt || null,
      lastActivityAt: data.lastActivityAt || null,
    };

    if (data.mode === 'chat') {
      base.details = {
        claudeSessionId: data.claudeSessionId || null,
        lastMessageRole: data.lastMessageRole || null,
        tokensUsed: typeof data.tokensUsed === 'number' ? data.tokensUsed : null,
        contextWindow: typeof data.contextWindow === 'number' ? data.contextWindow : null,
        pendingPermission: data.pendingPermission
          ? { requestId: data.pendingPermission.requestId || null, tool: data.pendingPermission.tool || null, summary: data.pendingPermission.summary || null }
          : null,
      };
    } else {
      base.details = {
        lastCommand: data.lastCommand || null,
        isPromptReady: data.status === 'ready',
        exitCode: typeof data.exitCode === 'number' ? data.exitCode : null,
        claudeSessionId: data.claudeSessionId || null,
      };
    }
    return base;
  }

  closeTabByTabId(tabId) {
    const found = getTerminalByTabId(tabId);
    if (!found) return { ok: false, error: `Tab not found: ${tabId}` };
    try {
      this.closeTerminal(found.id);
      return { ok: true, tabId };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  listTabsSummary() {
    const { deriveTabStatus } = require('../../state/terminals.state');
    const terminals = terminalsState.get().terminals;
    const out = [];
    terminals.forEach((data, id) => {
      if (data.type === 'file' || data.type === 'fivem' || data.type === 'webapp' || data.type === 'api') return;
      if (!data.tabId) return;
      out.push({
        tabId: data.tabId,
        ptyId: typeof id === 'number' ? id : null,
        projectId: data.project?.id || null,
        projectName: data.project?.name || data.name || null,
        mode: data.mode || 'terminal',
        title: data.name || null,
        status: deriveTabStatus(data),
        createdAt: data.createdAt || null,
        lastActivityAt: data.lastActivityAt || null,
      });
    });
    return out;
  }

  // Wait for a tab to reach any of the target statuses (subscribe-based, no polling).
  // Resolves with the final status snapshot (or { ok: false } on timeout / missing tab).
  waitForTab(tabId, { targetStatuses = ['idle', 'awaiting_permission', 'error'], timeoutMs = 60000 } = {}) {
    const { deriveTabStatus } = require('../../state/terminals.state');
    return new Promise((resolve) => {
      const found = getTerminalByTabId(tabId);
      if (!found) return resolve({ ok: false, error: `Tab not found: ${tabId}`, tabId });

      const matches = (data) => {
        const s = deriveTabStatus(data);
        return Array.isArray(targetStatuses) && targetStatuses.includes(s);
      };

      // Fast path: already matches
      if (matches(found.data)) {
        return resolve({ ok: true, tabId, status: deriveTabStatus(found.data), timedOut: false });
      }

      let done = false;
      let timer = null;
      const unsubscribe = terminalsState.subscribe(() => {
        if (done) return;
        const current = getTerminalByTabId(tabId);
        if (!current) {
          done = true; clearTimeout(timer); unsubscribe();
          return resolve({ ok: false, error: `Tab closed while waiting: ${tabId}`, tabId });
        }
        if (matches(current.data)) {
          done = true; clearTimeout(timer); unsubscribe();
          resolve({ ok: true, tabId, status: deriveTabStatus(current.data), timedOut: false });
        }
      });

      timer = setTimeout(() => {
        if (done) return;
        done = true; unsubscribe();
        const current = getTerminalByTabId(tabId);
        resolve({
          ok: true,
          tabId,
          status: current ? deriveTabStatus(current.data) : 'done',
          timedOut: true,
        });
      }, Math.max(500, Math.min(Number(timeoutMs) || 60000, 10 * 60 * 1000)));
    });
  }

  // Wait for any of the given tabs to reach a target status.
  // Resolves with { ok, tabId, status, timedOut }.
  waitForAny(tabIds, { targetStatuses = ['idle', 'awaiting_permission', 'error'], timeoutMs = 60000 } = {}) {
    const { deriveTabStatus } = require('../../state/terminals.state');
    const ids = Array.isArray(tabIds) ? tabIds.filter(Boolean) : [];
    return new Promise((resolve) => {
      if (!ids.length) return resolve({ ok: false, error: 'No tabIds provided' });

      const matches = (data) => Array.isArray(targetStatuses) && targetStatuses.includes(deriveTabStatus(data));

      // Fast path
      for (const tid of ids) {
        const f = getTerminalByTabId(tid);
        if (f && matches(f.data)) {
          return resolve({ ok: true, tabId: tid, status: deriveTabStatus(f.data), timedOut: false });
        }
      }

      let done = false;
      let timer = null;
      const unsubscribe = terminalsState.subscribe(() => {
        if (done) return;
        for (const tid of ids) {
          const f = getTerminalByTabId(tid);
          if (f && matches(f.data)) {
            done = true; clearTimeout(timer); unsubscribe();
            return resolve({ ok: true, tabId: tid, status: deriveTabStatus(f.data), timedOut: false });
          }
        }
      });

      timer = setTimeout(() => {
        if (done) return;
        done = true; unsubscribe();
        resolve({ ok: true, timedOut: true, status: null, tabId: null });
      }, Math.max(500, Math.min(Number(timeoutMs) || 60000, 10 * 60 * 1000)));
    });
  }

  // Read the buffered output (or chat message log) for a tab.
  // `afterCursor` returns only entries strictly greater; `maxEntries` caps size.
  readOutputForTab(tabId, { afterCursor = 0, maxEntries = 200 } = {}) {
    const found = getTerminalByTabId(tabId);
    if (!found) return { ok: false, error: `Tab not found: ${tabId}` };
    const { data } = found;
    const cap = Math.max(1, Math.min(Number(maxEntries) || 200, 1000));
    const after = Number(afterCursor) || 0;

    if (data.mode === 'chat') {
      const all = Array.isArray(data.chatMessages) ? data.chatMessages : [];
      const filtered = all.filter(m => (m.cursor || 0) > after);
      const tail = filtered.slice(-cap);
      const lastCursor = tail.length ? tail[tail.length - 1].cursor : (all.length ? all[all.length - 1].cursor : after);
      return {
        ok: true, tabId, mode: 'chat',
        messages: tail,
        lastCursor,
        truncated: filtered.length > tail.length,
      };
    }

    const all = Array.isArray(data.outputBuffer) ? data.outputBuffer : [];
    const filtered = all.filter(e => (e.cursor || 0) > after);
    const tail = filtered.slice(-cap);
    const lastCursor = tail.length ? tail[tail.length - 1].cursor : (all.length ? all[all.length - 1].cursor : after);
    return {
      ok: true, tabId, mode: 'terminal',
      entries: tail,
      lastCursor,
      truncated: filtered.length > tail.length,
    };
  }

  // Respond to a pending permission on a chat tab programmatically.
  // action: 'allow' | 'deny' | 'always-allow'; message optional (used for deny).
  respondPermissionForTab(tabId, { action = 'allow', message = '', requestId = null } = {}) {
    const found = getTerminalByTabId(tabId);
    if (!found) return { ok: false, error: `Tab not found: ${tabId}` };
    const { data } = found;
    if (data.mode !== 'chat') return { ok: false, error: 'Permission response only applies to chat tabs' };

    const pending = data.pendingPermission;
    if (!pending) return { ok: false, error: 'No pending permission on this tab' };
    const targetRequestId = requestId || pending.requestId;
    if (!targetRequestId) return { ok: false, error: 'Pending permission has no requestId' };

    // Find the matching DOM card and click the right button so the existing
    // ChatView flow runs (collapses the card, clears timers, updates status).
    const containerEl = data.chatView?.containerEl || data.element || document;
    const selector = `.chat-perm-card[data-request-id="${(window.CSS && CSS.escape) ? CSS.escape(targetRequestId) : targetRequestId}"]:not(.resolved), `
                   + `.chat-plan-card[data-request-id="${(window.CSS && CSS.escape) ? CSS.escape(targetRequestId) : targetRequestId}"]:not(.resolved)`;
    let card = null;
    try { card = containerEl.querySelector(selector); } catch (_) {}
    if (!card) {
      try { card = document.querySelector(selector); } catch (_) {}
    }
    if (!card) return { ok: false, error: 'Permission card not found in DOM' };

    const btnSelector = (() => {
      if (action === 'allow') return '.chat-perm-btn[data-action="allow"], .chat-plan-btn[data-action="allow"]';
      if (action === 'always-allow') return '.chat-perm-btn[data-action="always-allow"]';
      if (action === 'deny') return '.chat-perm-btn[data-action="deny"], .chat-plan-btn[data-action="deny"]';
      return null;
    })();
    if (!btnSelector) return { ok: false, error: `Unsupported action: ${action}` };
    const btn = card.querySelector(btnSelector);
    if (!btn) return { ok: false, error: `Button for action "${action}" not found` };

    // For deny: prefill the feedback input then click twice (first shows input, second sends).
    if (action === 'deny' && message) {
      try { btn.click(); } catch (_) {}
      const feedbackInput = card.querySelector('.chat-perm-feedback-input, .chat-plan-feedback-input');
      if (feedbackInput) feedbackInput.value = String(message);
      try { btn.click(); } catch (_) {}
    } else {
      try { btn.click(); } catch (e) { return { ok: false, error: e.message }; }
    }

    return { ok: true, tabId, requestId: targetRequestId, action };
  }

  // ── Destroy ──

  destroy() {
    for (const [id, timer] of this._readyDebounceTimers) {
      clearTimeout(timer);
    }
    this._readyDebounceTimers.clear();

    for (const [id, timer] of this._loadingTimeouts) {
      clearTimeout(timer);
    }
    this._loadingTimeouts.clear();

    this._terminalDataHandlers.clear();
    this._terminalExitHandlers.clear();
    this._postEnterExtended.clear();
    this._postSpinnerExtended.clear();
    this._terminalSubstatus.clear();
    this._lastTerminalData.clear();
    this._terminalContext.clear();
    this._tabActivationHistory.clear();

    super.destroy();
  }
}

// ========== SINGLETON LEGACY BRIDGE ==========
let _instance = null;
function _getInstance() { if (!_instance) _instance = new TerminalManager(); return _instance; }

module.exports = {
  TerminalManager,
  createTerminal: (project, options) => _getInstance().createTerminal(project, options),
  closeTerminal: (id) => _getInstance().closeTerminal(id),
  setActiveTerminal: (id) => _getInstance().setActiveTerminal(id),
  filterByProject: (projectIndex) => _getInstance().filterByProject(projectIndex),
  countTerminalsForProject: (projectIndex) => _getInstance().countTerminalsForProject(projectIndex),
  getTerminalStatsForProject: (projectIndex) => _getInstance().getTerminalStatsForProject(projectIndex),
  showAll: () => _getInstance().showAll(),
  setCallbacks: (cbs) => _getInstance().setCallbacks(cbs),
  updateTerminalStatus: (id, status) => _getInstance().updateTerminalStatus(id, status),
  resumeSession: (project, sessionId, options) => _getInstance().resumeSession(project, sessionId, options),
  updateAllTerminalsTheme: (themeId) => _getInstance().updateAllTerminalsTheme(themeId),
  focusNextTerminal: () => _getInstance().focusNextTerminal(),
  focusPrevTerminal: () => _getInstance().focusPrevTerminal(),
  openFileTab: (filePath, project) => _getInstance().openFileTab(filePath, project),
  createTypeConsole: (project, projectIndex) => _getInstance().createTypeConsole(project, projectIndex),
  closeTypeConsole: (id, projectIndex, typeId) => _getInstance()._closeTypeConsole(id, projectIndex, typeId),
  getTypeConsoleTerminal: (projectIndex, typeId) => _getInstance().getTypeConsoleTerminal(projectIndex, typeId),
  writeTypeConsole: (projectIndex, typeId, data) => _getInstance().writeTypeConsole(projectIndex, typeId, data),
  handleTypeConsoleError: (projectIndex, error) => _getInstance().handleTypeConsoleError(projectIndex, error),
  showTypeErrorOverlay: (projectIndex, error) => _getInstance().showTypeErrorOverlay(projectIndex, error),
  createFivemConsole: (project, projectIndex) => _getInstance().createFivemConsole(project, projectIndex),
  closeFivemConsole: (id, projectIndex) => _getInstance().closeFivemConsole(id, projectIndex),
  getFivemConsoleTerminal: (projectIndex) => _getInstance().getFivemConsoleTerminal(projectIndex),
  writeFivemConsole: (projectIndex, data) => _getInstance().writeFivemConsole(projectIndex, data),
  addFivemErrorToConsole: (projectIndex, error) => _getInstance().addFivemErrorToConsole(projectIndex, error),
  showFivemErrorOverlay: (projectIndex, error) => _getInstance().showFivemErrorOverlay(projectIndex, error),
  hideErrorOverlay: (projectIndex) => _getInstance().hideErrorOverlay(projectIndex),
  createWebAppConsole: (project, projectIndex) => _getInstance().createWebAppConsole(project, projectIndex),
  closeWebAppConsole: (id, projectIndex) => _getInstance().closeWebAppConsole(id, projectIndex),
  getWebAppConsoleTerminal: (projectIndex) => _getInstance().getWebAppConsoleTerminal(projectIndex),
  writeWebAppConsole: (projectIndex, data) => _getInstance().writeWebAppConsole(projectIndex, data),
  createApiConsole: (project, projectIndex) => _getInstance().createApiConsole(project, projectIndex),
  closeApiConsole: (id, projectIndex) => _getInstance().closeApiConsole(id, projectIndex),
  getApiConsoleTerminal: (projectIndex) => _getInstance().getApiConsoleTerminal(projectIndex),
  writeApiConsole: (projectIndex, data) => _getInstance().writeApiConsole(projectIndex, data),
  switchTerminalMode: (id) => _getInstance().switchTerminalMode(id),
  setScrapingCallback: (cb) => _getInstance().setScrapingCallback(cb),
  updateTerminalTabName: (id, name) => _getInstance().updateTerminalTabName(id, name),
  cleanupProjectMaps: (projectIndex) => _getInstance().cleanupProjectMaps(projectIndex),
  scheduleScrollAfterRestore: (id) => _getInstance().scheduleScrollAfterRestore(id),
  // MCP orchestration
  getTabByTabId: (tabId) => _getInstance().getTabByTabId(tabId),
  sendToTab: (tabId, content) => _getInstance().sendToTab(tabId, content),
  getStatusForTab: (tabId) => _getInstance().getStatusForTab(tabId),
  closeTabByTabId: (tabId) => _getInstance().closeTabByTabId(tabId),
  listTabsSummary: () => _getInstance().listTabsSummary(),
  waitForTab: (tabId, opts) => _getInstance().waitForTab(tabId, opts),
  waitForAny: (tabIds, opts) => _getInstance().waitForAny(tabIds, opts),
  readOutputForTab: (tabId, opts) => _getInstance().readOutputForTab(tabId, opts),
  respondPermissionForTab: (tabId, opts) => _getInstance().respondPermissionForTab(tabId, opts),
};
