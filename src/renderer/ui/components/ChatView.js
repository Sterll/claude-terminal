/**
 * ChatView Component
 * Professional developer-tool chat UI for Claude Agent SDK.
 * Handles streaming, permissions, questions, and tool calls.
 */

const { BaseComponent } = require('../../core/BaseComponent');
const { escapeHtml, highlight } = require('../../utils');
const { sanitizeColor } = require('../../utils/color');
const {
  getToolIcon,
  getToolDisplayInfo,
  formatToolName,
  renderToolCardHtml,
  renderToolResultHtml,
  renderBgTaskCard,
  bgTaskStore,
} = require('../../utils/toolRegistry');
const { t } = require('../../i18n');
const { formatDuration: fmtDur } = require('../../utils/toolRegistry');
const { heartbeat, skillsAgentsState } = require('../../state');

// ── Background task cards re-render on store update ─────────────────
// Cards for Monitor/TaskOutput/TaskStop read state from bgTaskStore.
// Any mutation refreshes every card currently showing that taskId.
let _bgTaskSubStarted = false;
function ensureBgTaskSubscription() {
  if (_bgTaskSubStarted) return;
  _bgTaskSubStarted = true;
  bgTaskStore.subscribe((taskId) => {
    if (!taskId) return;
    let nodes;
    try {
      nodes = document.querySelectorAll(`[data-bg-task-id="${CSS.escape(taskId)}"]`);
    } catch (_) { return; }
    nodes.forEach((el) => {
      const tool = el.dataset.bgTool || 'TaskOutput';
      const card = el.closest('.chat-tool-card');
      let input = {};
      try {
        input = card && card.dataset.toolInput ? JSON.parse(card.dataset.toolInput) : { task_id: taskId };
      } catch (_) { input = { task_id: taskId }; }
      el.outerHTML = renderBgTaskCard(tool, input);
    });
  });
}

// Parse a tool_result content block into plain text.
function extractResultText(block) {
  if (!block) return '';
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content.map((b) => (b && (b.text || '')) || '').join('\n');
  }
  return '';
}

// Try to extract structured data from a tool_result text (best-effort).
function parseResultJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try { return JSON.parse(trimmed); } catch (_) { return null; }
}

// ── Wakeup countdown ticker (module-level, single global interval) ──
let _wakeupTickerStarted = false;
function ensureWakeupTicker() {
  if (_wakeupTickerStarted) return;
  _wakeupTickerStarted = true;
  setInterval(() => {
    const nodes = document.querySelectorAll('[data-wakeup-at]');
    if (!nodes.length) return;
    const now = Date.now();
    nodes.forEach((el) => {
      const at = Number(el.dataset.wakeupAt) || 0;
      const cd = el.querySelector('[data-countdown]');
      if (!cd) return;
      const remaining = Math.max(0, Math.round((at - now) / 1000));
      if (remaining === 0) {
        cd.textContent = 'fired';
        cd.classList.add('is-fired');
      } else {
        cd.textContent = 'in ' + fmtDur(remaining);
      }
    });
  }, 1000);
}
const { getSetting, setSetting, isNotificationsEnabled } = require('../../state/settings.state');
const { updateTerminal } = require('../../state/terminals.state');
const { saveTerminalSessions } = require('../../services/TerminalSessionService');

const MODEL_OPTIONS = [
  { id: 'claude-opus-4-7', label: 'Opus 4.7', desc: 'Most capable for complex work' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', desc: 'Previous generation Opus' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', desc: 'Best for everyday tasks' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', desc: 'Fastest for quick answers' },
];

const EFFORT_OPTIONS = [
  { id: 'low', label: 'Low', desc: t('chat.effortLow') },
  { id: 'medium', label: 'Medium', desc: t('chat.effortMedium') },
  { id: 'high', label: 'High', desc: t('chat.effortHigh') },
  { id: 'xhigh', label: 'XHigh', desc: t('chat.effortXhigh') },
  { id: 'max', label: 'Max', desc: t('chat.effortMax') },
];

// ── Markdown Renderer (delegated to MarkdownRenderer service) ──

const MarkdownRenderer = require('../../services/MarkdownRenderer');

function renderMarkdown(text) {
  return MarkdownRenderer.render(text);
}

function unescapeHtml(html) {
  return html.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
}

const { parseDroppedPathsPayload } = require('../../utils/dropPaths');

// ── Context Suggestions ──

function createContextSuggestions(api, project, inputAdapter, getDefaultPlaceholder) {
  const CACHE_TTL = 30_000;
  const ROTATION_INTERVAL = 4_000;

  let suggestions = [];
  let currentIndex = 0;
  let rotationTimer = null;
  let cache = null; // { suggestions: string[], timestamp: number }
  let _refreshing = false;
  let _initTimer = null;
  let _postStreamTimer = null;

  function buildSuggestions(todos, gitStatus) {
    const result = [];
    const gitCount = gitStatus
      ? (gitStatus.modified?.length || 0) + (gitStatus.staged?.length || 0) + (gitStatus.untracked?.length || 0)
      : 0;
    if (gitCount > 0) result.push(t('chat.suggestGit', { count: gitCount }));
    return result;
  }

  async function refresh() {
    if (!project?.path || _refreshing) return;
    _refreshing = true;
    const now = Date.now();
    if (cache && now - cache.timestamp < CACHE_TTL) {
      suggestions = cache.suggestions;
      _refreshing = false;
      _start();
      return;
    }
    try {
      const [todos, gitStatus] = await Promise.all([
        api.project.scanTodos(project.path).catch(() => []),
        api.git.statusDetailed({ projectPath: project.path }).catch(() => null),
      ]);
      suggestions = buildSuggestions(todos, gitStatus);
      cache = { suggestions, timestamp: Date.now() };
    } catch {
      suggestions = [];
    } finally {
      _refreshing = false;
    }
    _start();
  }

  function _start() {
    stop();
    if (!suggestions.length) return;
    currentIndex = 0;
    _apply();
    if (suggestions.length > 1) {
      rotationTimer = setInterval(() => {
        if (!inputAdapter.isEmpty()) { stop(); return; }
        currentIndex = (currentIndex + 1) % suggestions.length;
        _apply();
      }, ROTATION_INTERVAL);
    }
  }

  function _apply() {
    // Don't overwrite if user has typed something
    if (!inputAdapter.isEmpty()) return;
    inputAdapter.setPlaceholder(suggestions[currentIndex] || getDefaultPlaceholder());
  }

  function stop() {
    if (rotationTimer) { clearInterval(rotationTimer); rotationTimer = null; }
  }

  function reset() {
    stop();
    if (_initTimer) { clearTimeout(_initTimer); _initTimer = null; }
    if (_postStreamTimer) { clearTimeout(_postStreamTimer); _postStreamTimer = null; }
    _refreshing = false;
    suggestions = [];
    inputAdapter.setPlaceholder(getDefaultPlaceholder());
  }

  function handleTab(event) {
    if (!inputAdapter.isEmpty() || !suggestions.length) return false;
    event.preventDefault();
    // Strip the " [Tab]" hint from the raw i18n string and insert clean text
    const raw = suggestions[currentIndex] || '';
    const clean = raw.replace(/\s*\[Tab\]\s*$/, '');
    inputAdapter.setText(clean);
    reset();
    return true;
  }

  return { refresh, stop, reset, handleTab, setInitTimer(t) { _initTimer = t; }, setPostStreamTimer(t) { _postStreamTimer = t; } };
}

// ── Follow-up Suggestion Chips ──

const SPARKLE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5z"/><path d="M19 15l.75 2.25L22 18l-2.25.75L19 21l-.75-2.25L16 18l2.25-.75z"/></svg>`;

function createFollowupChips(api, suggestionsContainerEl, inputAdapter, project) {
  let _pending = []; // SDK suggestions accumulated during a turn

  function _render(chips) {
    if (!chips || chips.length === 0) {
      suggestionsContainerEl.style.display = 'none';
      suggestionsContainerEl.innerHTML = '';
      return;
    }

    const label = document.createElement('span');
    label.className = 'chat-followup-label';
    label.textContent = t('chat.suggestionsLabel') || 'Suggestions';

    const chipsWrapper = document.createElement('div');
    chipsWrapper.className = 'chat-followup-chips';
    chipsWrapper.setAttribute('role', 'listbox');
    chipsWrapper.setAttribute('aria-label', t('chat.suggestionsLabel') || 'Suggestions');

    chips.forEach((text, chipIndex) => {
      const chip = document.createElement('button');
      chip.className = 'chat-followup-chip';
      chip.setAttribute('role', 'option');
      chip.setAttribute('aria-selected', 'false');
      chip.setAttribute('tabindex', chipIndex === 0 ? '0' : '-1');
      chip.innerHTML = `<span class="chat-followup-chip-icon">${SPARKLE_ICON}</span><span class="chat-followup-chip-text">${escapeHtml(text)}</span>`;
      chip.title = text;
      chip.addEventListener('click', () => {
        const existing = inputAdapter.getText().trim();
        if (existing) {
          inputAdapter.setText(existing + ' ' + text);
        } else {
          inputAdapter.setText(text);
        }
        inputAdapter.resize();
        inputAdapter.focus();
        clear();
      });
      chip.addEventListener('keydown', (e) => {
        const allChips = Array.from(chipsWrapper.querySelectorAll('.chat-followup-chip'));
        const idx = allChips.indexOf(chip);
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          const next = allChips[idx + 1];
          if (next) { chip.setAttribute('tabindex', '-1'); next.setAttribute('tabindex', '0'); next.focus(); }
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          const prev = allChips[idx - 1];
          if (prev) { chip.setAttribute('tabindex', '-1'); prev.setAttribute('tabindex', '0'); prev.focus(); }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          inputAdapter.focus();
        }
      });
      chipsWrapper.appendChild(chip);
    });

    suggestionsContainerEl.innerHTML = '';
    suggestionsContainerEl.appendChild(label);
    suggestionsContainerEl.appendChild(chipsWrapper);
    suggestionsContainerEl.style.display = 'flex';
  }

  /** Push a suggestion from the SDK stream (accumulated, rendered on flush) */
  function addSuggestion(text) {
    if (typeof text === 'string' && text.trim() && _pending.length < 5) {
      _pending.push(text.trim());
    }
  }

  /** Render accumulated suggestions + context chips (called when streaming ends) */
  async function flush() {
    const sdkChips = _pending.slice(0, 3);
    _pending = [];
    // Fetch context chips (TODOs) in parallel
    const contextChips = await _fetchContextChips();
    const allChips = [...sdkChips, ...contextChips];
    if (allChips.length > 0) {
      _render(allChips);
    }
  }

  async function _fetchContextChips() {
    if (!project?.path) return [];
    try {
      const todos = await api.project.scanTodos(project.path).catch(() => []);
      const todoCount = Array.isArray(todos) ? todos.length : 0;
      if (todoCount > 0) {
        return [t('chat.suggestTodos', { count: todoCount }).replace(/\s*\[Tab\]\s*$/, '')];
      }
    } catch { /* ignore */ }
    return [];
  }

  function clear() {
    _pending = [];
    suggestionsContainerEl.style.display = 'none';
    suggestionsContainerEl.innerHTML = '';
  }

  // Hide chips when user starts typing
  inputAdapter.onInput(() => {
    if (!inputAdapter.isEmpty() && suggestionsContainerEl.style.display !== 'none') {
      clear();
    }
  });

  return { addSuggestion, flush, clear };
}

// Tool icons, name formatter & detail extractor come from ../utils/toolRegistry

// ── ChatView Class ──

class ChatView extends BaseComponent {
  constructor() {
    super(null);
    this._api = window.electron_api;
  }

  createChatView(wrapperEl, project, options = {}) {
    const api = this._api;
  const { terminalId = null, resumeSessionId = null, forkSession = false, resumeSessionAt = null, skipPermissions = false, onTabRename = null, onStatusChange = null, onSwitchTerminal = null, onSwitchProject = null, onForkSession = null, initialPrompt = null, initialModel = null, initialEffort = null, initialImages = null, onSessionStart = null, systemPrompt = null, builtinSystemPrompt = null } = options;
  let sessionId = null;
  let isStreaming = false;
  let isAborting = false;
  let pendingResumeId = resumeSessionId || null;
  let pendingForkSession = forkSession || false;
  let pendingResumeAt = resumeSessionAt || null;
  let lastStartOpts = null; // cached so we can re-launch the SDK after an account switch
  let switchingAccount = false; // suppress error UI while we hot-swap credentials
  let tabNamePending = false; // avoid concurrent tab name requests
  let currentStreamEl = null;
  let currentStreamText = '';
  let currentThinkingEl = null;
  let currentThinkingText = '';
  let currentAssistantMsgEl = null; // tracks the current .chat-msg-assistant wrapper for UUID tagging
  let sdkSessionId = null; // real SDK session UUID (different from our internal sessionId)
  let model = '';
  let selectedModel = initialModel || getSetting('chatModel') || MODEL_OPTIONS[0].id;
  let selectedEffort = initialEffort || getSetting('effortLevel') || 'high';
  let totalCost = 0;
  let totalTokens = 0;
  let inputTokens = 0; // tracks context window usage
  const toolCards = new Map(); // content_block index -> element
  const toolInputBuffers = new Map(); // content_block index -> accumulated JSON string
  const todoToolIndices = new Set(); // block indices that are TodoWrite tools
  const taskToolIndices = new Map(); // block index -> { card, toolUseId } for Task (subagent) tools
  const parallelToolIndices = new Map(); // block index -> { toolUseId } for parallel_start_run
  const parallelRunWidgets = new Map(); // runId -> { el, cleanup, toolUseId }
  const parallelPendingWidgets = new Map(); // toolUseId -> widget (before runId is bound)
  let blockIndex = 0;
  let currentMsgHasToolUse = false;
  let turnHadAssistantContent = false; // tracks if current turn displayed any streamed/assistant content
  let todoWidgetEl = null; // persistent todo list widget
  let todoAllDone = false; // tracks if all todos are completed
  let slashCommands = []; // populated from system/init message
  let slashSelectedIndex = -1; // currently highlighted item in slash dropdown
  // Accumulates messages for CLAUDE.md analysis (role: 'user'|'assistant', content: string)
  const conversationHistory = [];
  const unsubscribers = [];

  // ── Session recap tracking (for chat-mode sessions) ──
  let recapToolCount = 0;
  const recapToolCounts = {}; // { toolName: count }
  const recapUserPrompts = []; // first 5 user prompts
  const recapSessionStartTime = Date.now();

  // ── Lightbox state ──
  let lightboxEl = null;
  let lightboxImages = [];
  let lightboxIndex = 0;

  // ── Build DOM ──

  wrapperEl.innerHTML = `
    <div class="chat-view">
      <div class="chat-messages">
        <div class="chat-welcome">
          <img class="chat-welcome-logo" src="assets/claude-mascot.svg" alt="" draggable="false" />
          <div class="chat-welcome-text">${escapeHtml(t('chat.welcomeMessage'))}</div>
        </div>
      </div>
      <div class="chat-input-area">
        <div class="chat-mention-dropdown" style="display:none"></div>
        <div class="chat-slash-dropdown" style="display:none"></div>
        <div class="chat-followup-suggestions" style="display:none"></div>
        <div class="chat-image-preview" style="display:none"></div>
        <div class="chat-input-wrapper">
          <button class="chat-attach-btn" title="${escapeHtml(t('chat.attachImage'))}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
          </button>
          <div class="chat-input" contenteditable="true" role="textbox" data-placeholder="${escapeHtml(t('chat.placeholder'))}" spellcheck="false"></div>
          <input type="file" class="chat-file-input" accept="image/png,image/jpeg,image/gif,image/webp" multiple style="display:none" />
          <div class="chat-input-actions">
            <button class="chat-stop-btn" title="${t('common.stop')}" style="display:none">
              <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
            </button>
            <button class="chat-send-btn" title="${escapeHtml(t('chat.sendMessage'))}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22,2 15,22 11,13 2,9"/></svg>
            </button>
          </div>
        </div>
        <div class="chat-input-footer">
          <div class="chat-footer-left">
            <span class="chat-status-dot"></span>
            ${project.isCloud ? `<span class="chat-status-cloud-badge">${escapeHtml(t('chat.cloudBadge') || 'Cloud')}</span>` : ''}
            <span class="chat-status-text">${escapeHtml(t('chat.ready'))}</span>
            <button class="chat-export-btn" title="${escapeHtml(t('chat.exportConversation') || 'Export conversation')}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
          </div>
          <div class="chat-footer-right">
            <div class="chat-effort-selector">
              <button class="chat-effort-btn"><span class="chat-effort-label">High</span> <span class="chat-effort-arrow">&#9662;</span></button>
              <div class="chat-effort-dropdown" style="display:none"></div>
            </div>
            <div class="chat-model-selector">
              <button class="chat-model-btn"><span class="chat-model-label">Sonnet</span> <span class="chat-model-arrow">&#9662;</span></button>
              <div class="chat-model-dropdown" style="display:none"></div>
            </div>
            <span class="chat-status-tokens"></span>
            <span class="chat-status-cost"></span>
          </div>
        </div>
      </div>
    </div>
  `;

  const chatView = wrapperEl.querySelector('.chat-view');
  const messagesEl = chatView.querySelector('.chat-messages');
  const inputEl = chatView.querySelector('.chat-input');
  const sendBtn = chatView.querySelector('.chat-send-btn');
  const stopBtn = chatView.querySelector('.chat-stop-btn');
  const statusDot = chatView.querySelector('.chat-status-dot');
  const statusTextEl = chatView.querySelector('.chat-status-text');
  const modelBtn = chatView.querySelector('.chat-model-btn');
  const modelLabel = chatView.querySelector('.chat-model-label');
  const modelDropdown = chatView.querySelector('.chat-model-dropdown');
  const effortBtn = chatView.querySelector('.chat-effort-btn');
  const effortLabel = chatView.querySelector('.chat-effort-label');
  const effortDropdown = chatView.querySelector('.chat-effort-dropdown');
  const statusTokens = chatView.querySelector('.chat-status-tokens');
  const statusCost = chatView.querySelector('.chat-status-cost');
  const slashDropdown = chatView.querySelector('.chat-slash-dropdown');
  const attachBtn = chatView.querySelector('.chat-attach-btn');
  const fileInput = chatView.querySelector('.chat-file-input');
  const imagePreview = chatView.querySelector('.chat-image-preview');
  const mentionDropdown = chatView.querySelector('.chat-mention-dropdown');
  const followupSuggestionsEl = chatView.querySelector('.chat-followup-suggestions');
  const exportBtn = chatView.querySelector('.chat-export-btn');

  // ── Export conversation ──

  function exportConversation(format) {
    if (!conversationHistory.length) return;
    let content, ext, mime;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `conversation-${timestamp}`;

    if (format === 'json') {
      content = JSON.stringify(conversationHistory, null, 2);
      ext = 'json';
      mime = 'application/json';
    } else if (format === 'html') {
      const msgs = conversationHistory.map(m => {
        const role = m.role === 'user' ? 'You' : 'Claude';
        const rendered = m.role === 'assistant' ? renderMarkdown(m.content) : escapeHtml(m.content);
        return `<div class="msg ${m.role}"><strong>${role}:</strong><div>${rendered}</div></div>`;
      }).join('\n');
      content = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Conversation</title><style>body{font-family:system-ui;max-width:800px;margin:0 auto;padding:20px;background:#1a1a1a;color:#e0e0e0}.msg{margin:16px 0;padding:12px;border-radius:8px}.user{background:#252525}.assistant{background:#1e2a1e}strong{color:#d97706}pre{background:#111;padding:8px;border-radius:4px;overflow-x:auto}code{font-size:0.9em}</style></head><body><h1>Conversation Export</h1>${msgs}</body></html>`;
      ext = 'html';
      mime = 'text/html';
    } else {
      // markdown
      content = conversationHistory.map(m => {
        const role = m.role === 'user' ? '## You' : '## Claude';
        return `${role}\n\n${m.content}\n`;
      }).join('\n---\n\n');
      ext = 'md';
      mime = 'text/markdown';
    }

    // Download via blob
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Show format dropdown
      const existing = chatView.querySelector('.chat-export-dropdown');
      if (existing) { existing.remove(); return; }
      const dd = document.createElement('div');
      dd.className = 'chat-export-dropdown';
      dd.innerHTML = ['markdown', 'html', 'json'].map(f =>
        `<button class="chat-export-option" data-format="${f}">${f.toUpperCase()}</button>`
      ).join('');
      dd.style.cssText = 'position:absolute;bottom:100%;left:0;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:var(--radius-sm);padding:4px;display:flex;gap:4px;z-index:100;margin-bottom:4px';
      exportBtn.style.position = 'relative';
      exportBtn.appendChild(dd);
      dd.addEventListener('click', (ev) => {
        const fmt = ev.target.dataset.format;
        if (fmt) { exportConversation(fmt); dd.remove(); }
      });
      setTimeout(() => {
        const close = () => { dd.remove(); document.removeEventListener('click', close); };
        document.addEventListener('click', close);
      }, 0);
    });
  }

  // ── Attach interactive markdown block handlers (sort, collapse, preview, etc.) ──
  MarkdownRenderer.attachInteractivity(messagesEl);

  // ── Mention state ──

  const pendingMentions = []; // Array of { type, label, icon, data }
  let mentionSelectedIndex = 0;
  let mentionMode = null; // null | 'types' | 'file' | 'projects' | 'tabs' | 'conversations'
  let mentionFileCache = null; // { files: [], timestamp, projectPath }
  const MENTION_FILE_CACHE_TTL = 5 * 60 * 1000;
  let conversationCache = null; // { sessions: [], timestamp, projectPath }
  const CONVERSATION_CACHE_TTL = 30 * 1000;

  // ── Image attachments ──

  const pendingImages = []; // Array of { base64, mediaType, name, dataUrl }
  const SUPPORTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB
  const MAX_PENDING_IMAGES = 5;

  // ── Contenteditable helpers ──

  function getInputText() {
    let text = '';
    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          // Skip zero-width spaces used for cursor positioning
          const t = node.textContent.replace(/\u200B/g, '');
          text += t;
        } else if (node.nodeName === 'BR') {
          text += '\n';
        } else if (node.classList && node.classList.contains('chat-inline-chip')) {
          // Skip chip nodes - they're tracked in pendingMentions
        } else if (node.nodeName === 'DIV') {
          // Contenteditable wraps lines in <div> on Enter
          if (text.length > 0 && !text.endsWith('\n')) text += '\n';
          walk(node.childNodes);
        }
      }
    };
    walk(inputEl.childNodes);
    return text;
  }

  function setInputText(text) {
    inputEl.innerHTML = '';
    if (text) {
      inputEl.appendChild(document.createTextNode(text));
    }
    updatePlaceholderVisibility();
    placeCaretAtEnd();
    autoResize();
  }

  function autoResize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
  }

  function placeCaretAtEnd() {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(inputEl);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function placeCaretAfterNode(node) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function getTextBeforeCaret() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return '';
    const range = sel.getRangeAt(0);
    if (!inputEl.contains(range.startContainer)) return '';

    let text = '';
    const node = range.startContainer;

    if (node.nodeType === Node.TEXT_NODE) {
      // Collect text from this node up to cursor
      text = node.textContent.substring(0, range.startOffset);
      // Walk backwards through preceding siblings
      let prev = node.previousSibling;
      while (prev) {
        if (prev.nodeType === Node.TEXT_NODE) {
          text = prev.textContent + text;
        } else if (prev.nodeName === 'BR') {
          text = '\n' + text;
        }
        // Skip chip spans
        prev = prev.previousSibling;
      }
    } else if (node === inputEl) {
      for (let i = 0; i < range.startOffset; i++) {
        const child = inputEl.childNodes[i];
        if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
        else if (child.nodeName === 'BR') text += '\n';
      }
    }

    return text;
  }

  function insertChipAtCaret(chipEl) {
    const sel = window.getSelection();
    if (!sel.rangeCount) {
      inputEl.appendChild(chipEl);
      const zwsp = document.createTextNode('\u200B');
      inputEl.appendChild(zwsp);
      placeCaretAfterNode(zwsp);
      return;
    }

    const range = sel.getRangeAt(0);
    range.collapse(true);

    // Insert chip then a zero-width space for cursor
    const zwsp = document.createTextNode('\u200B');
    range.insertNode(zwsp);
    range.insertNode(chipEl);

    // Place caret after the zero-width space
    const newRange = document.createRange();
    newRange.setStartAfter(zwsp);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
    autoResize();
    updatePlaceholderVisibility();
  }

  function createInlineChipElement(chip, index) {
    const span = document.createElement('span');
    span.className = 'chat-inline-chip';
    span.contentEditable = 'false';
    span.dataset.mentionIndex = index;
    span.dataset.mentionType = chip.type;

    const chipColorRaw = (chip.type === 'project' && chip.data?.color) ? chip.data.color : '';
    const chipColor = sanitizeColor(chipColorRaw);
    if (chipColor) {
      span.classList.add('has-project-color');
      span.style.setProperty('--chip-color', chipColor);
    }

    // Clean display: @name for all types
    const isProject = chip.type === 'project';
    const displayName = isProject && chip.data?.name ? chip.data.name : (chip.label || `@${chip.type}`);
    // Strip leading @ if present in label - we add our own
    const cleanName = displayName.replace(/^@(project:|context:|file:|tab:|diff:|symbol:|conversation:)?/, '');

    span.innerHTML = `<span class="chat-inline-chip-at">@</span><span class="chat-inline-chip-label">${escapeHtml(cleanName)}</span>`;

    return span;
  }

  function removeMentionInline(index) {
    pendingMentions.splice(index, 1);
    const chip = inputEl.querySelector(`.chat-inline-chip[data-mention-index="${index}"]`);
    if (chip) {
      const next = chip.nextSibling;
      if (next && next.nodeType === Node.TEXT_NODE && next.textContent === '\u200B') {
        next.remove();
      }
      chip.remove();
    }
    // Re-index remaining chips
    const chips = inputEl.querySelectorAll('.chat-inline-chip');
    chips.forEach((c, i) => {
      c.dataset.mentionIndex = i;
      const removeBtn = c.querySelector('.chat-inline-chip-remove');
      if (removeBtn) removeBtn.dataset.index = i;
    });
    autoResize();
    updatePlaceholderVisibility();
  }

  function clearInlineChips() {
    inputEl.querySelectorAll('.chat-inline-chip').forEach(chip => {
      const next = chip.nextSibling;
      if (next && next.nodeType === Node.TEXT_NODE && next.textContent === '\u200B') next.remove();
      chip.remove();
    });
  }

  function updatePlaceholderVisibility() {
    const hasText = getInputText().trim() !== '';
    const hasChips = inputEl.querySelectorAll('.chat-inline-chip').length > 0;
    inputEl.classList.toggle('has-content', hasText || hasChips);
  }

  function syncMentionsWithDOM() {
    const domChips = inputEl.querySelectorAll('.chat-inline-chip');
    const domIndices = new Set();
    domChips.forEach(c => domIndices.add(parseInt(c.dataset.mentionIndex)));
    // Remove pendingMentions entries whose chip was deleted from DOM
    if (domChips.length < pendingMentions.length) {
      // Rebuild: keep only mentions whose index still exists in DOM
      const kept = [];
      for (let i = 0; i < pendingMentions.length; i++) {
        if (domIndices.has(i)) kept.push(pendingMentions[i]);
      }
      pendingMentions.length = 0;
      kept.forEach(m => pendingMentions.push(m));
      // Re-index remaining chips
      domChips.forEach((c, i) => {
        c.dataset.mentionIndex = i;
      });
    }
  }

  // ── Input adapter for module-level helpers ──

  const inputAdapter = {
    getText: () => getInputText(),
    setText: (t) => setInputText(t),
    setPlaceholder: (p) => { inputEl.dataset.placeholder = p; },
    isEmpty: () => getInputText().trim() === '' && !inputEl.querySelector('.chat-inline-chip'),
    focus: () => inputEl.focus(),
    resize: () => autoResize(),
    onInput: (fn) => inputEl.addEventListener('input', fn),
  };

  // ── Model selector ──

  function initModelSelector() {
    const preferred = initialModel || getSetting('chatModel');
    const current = MODEL_OPTIONS.find(m => m.id === preferred) || MODEL_OPTIONS[0];
    modelLabel.textContent = current.label;
    selectedModel = current.id;
  }

  function buildModelDropdown() {
    modelDropdown.innerHTML = MODEL_OPTIONS.map(m => {
      const isActive = m.id === selectedModel;
      return `
      <div class="chat-model-option${isActive ? ' active' : ''}" data-model="${m.id}">
        <div class="chat-model-option-info">
          <span class="chat-model-option-label">${m.label}</span>
          <span class="chat-model-option-desc">${m.desc}</span>
        </div>
        ${isActive ? '<svg class="chat-model-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
      </div>`;
    }).join('');
  }

  function toggleModelDropdown() {
    if (modelBtn.disabled) return;
    const visible = modelDropdown.style.display !== 'none';
    if (visible) {
      modelDropdown.style.display = 'none';
    } else {
      buildModelDropdown();
      modelDropdown.style.display = '';
    }
  }

  function selectModel(modelId) {
    const option = MODEL_OPTIONS.find(m => m.id === modelId);
    if (!option) return;
    selectedModel = modelId;
    modelLabel.textContent = option.label;
    modelDropdown.style.display = 'none';
    setSetting('chatModel', modelId);

    // If session is active, change model mid-session via SDK
    if (sessionId) {
      api.chat.setModel({ sessionId, model: modelId }).catch(() => {});
    }
  }

  modelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleModelDropdown();
  });

  modelDropdown.addEventListener('click', (e) => {
    const opt = e.target.closest('.chat-model-option');
    if (opt) selectModel(opt.dataset.model);
  });

  // ── Effort selector ──

  function initEffortSelector() {
    const preferred = initialEffort || getSetting('effortLevel');
    const current = EFFORT_OPTIONS.find(e => e.id === preferred) || EFFORT_OPTIONS.find(e => e.id === 'high');
    effortLabel.textContent = current.label;
    selectedEffort = current.id;
  }

  function buildEffortDropdown() {
    effortDropdown.innerHTML = EFFORT_OPTIONS.map(e => {
      const isActive = e.id === selectedEffort;
      return `
      <div class="chat-effort-option${isActive ? ' active' : ''}" data-effort="${e.id}">
        <div class="chat-effort-option-info">
          <span class="chat-effort-option-label">${e.label}</span>
          <span class="chat-effort-option-desc">${e.desc}</span>
        </div>
        ${isActive ? '<svg class="chat-effort-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
      </div>`;
    }).join('');
  }

  function toggleEffortDropdown() {
    if (effortBtn.disabled) return;
    const visible = effortDropdown.style.display !== 'none';
    if (visible) {
      effortDropdown.style.display = 'none';
    } else {
      buildEffortDropdown();
      effortDropdown.style.display = '';
    }
  }

  function selectEffort(effortId) {
    const option = EFFORT_OPTIONS.find(e => e.id === effortId);
    if (!option) return;
    selectedEffort = effortId;
    effortLabel.textContent = option.label;
    effortDropdown.style.display = 'none';
    setSetting('effortLevel', effortId);

    // If session is active, change effort mid-session via SDK
    if (sessionId) {
      api.chat.setEffort({ sessionId, effort: effortId }).catch(err => {
        console.warn('[ChatView] setEffort failed:', err);
      });
    }
  }

  effortBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleEffortDropdown();
  });

  effortDropdown.addEventListener('click', (e) => {
    const opt = e.target.closest('.chat-effort-option');
    if (opt) selectEffort(opt.dataset.effort);
  });

  // Close dropdowns on outside click
  function _closeDropdowns() {
    modelDropdown.style.display = 'none';
    effortDropdown.style.display = 'none';
  }
  document.addEventListener('click', _closeDropdowns);

  initModelSelector();
  initEffortSelector();

  // ── Context suggestions (placeholder rotation before first message) ──
  const contextSuggestions = createContextSuggestions(api, project, inputAdapter, () => t('chat.placeholder'));
  // Defer initial scan to let the component finish mounting
  contextSuggestions.setInitTimer(setTimeout(() => { if (project?.path) contextSuggestions.refresh(); }, 500));

  // ── Follow-up suggestion chips (shown after Claude responds) ──
  const followupChips = createFollowupChips(api, followupSuggestionsEl, inputAdapter, project);

  attachBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) {
      addImageFiles(fileInput.files);
      fileInput.value = '';
    }
  });

  function addImageFiles(files) {
    for (const file of files) {
      if (pendingImages.length >= MAX_PENDING_IMAGES) break;
      if (!SUPPORTED_TYPES.includes(file.type)) continue;
      if (file.size > MAX_IMAGE_SIZE) continue;
      const reader = new FileReader();
      reader.onload = () => {
        if (pendingImages.length >= MAX_PENDING_IMAGES) return;
        const dataUrl = reader.result;
        const base64 = dataUrl.split(',')[1];
        pendingImages.push({ base64, mediaType: file.type, name: file.name, dataUrl });
        renderImagePreview();
      };
      reader.readAsDataURL(file);
    }
  }

  function removeImage(index) {
    pendingImages.splice(index, 1);
    renderImagePreview();
  }

  function renderImagePreview() {
    if (pendingImages.length === 0) {
      imagePreview.style.display = 'none';
      imagePreview.innerHTML = '';
      return;
    }
    imagePreview.style.display = 'flex';
    imagePreview.innerHTML = pendingImages.map((img, i) => `
      <div class="chat-image-thumb" data-index="${i}">
        <img src="${img.dataUrl}" alt="${escapeHtml(img.name)}" />
        <button class="chat-image-remove" data-index="${i}" title="${t('common.remove')}">&times;</button>
      </div>
    `).join('');
    imagePreview.querySelectorAll('.chat-image-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeImage(parseInt(btn.dataset.index));
      });
    });
  }

  // Drag & drop on chat area
  chatView.addEventListener('dragover', (e) => {
    e.preventDefault();
    chatView.classList.add('chat-dragover');
  });
  chatView.addEventListener('dragleave', (e) => {
    if (!chatView.contains(e.relatedTarget)) {
      chatView.classList.remove('chat-dragover');
    }
  });
  chatView.addEventListener('drop', (e) => {
    e.preventDefault();
    chatView.classList.remove('chat-dragover');
    handleChatDrop(e);
  });

  function handleChatDrop(e) {
    // Priority: image files dropped from OS/explorer
    const imageFiles = Array.from(e.dataTransfer.files || []).filter(f => SUPPORTED_TYPES.includes(f.type));
    if (imageFiles.length) {
      addImageFiles(imageFiles);
      inputEl.focus();
      return;
    }

    // Fallback: text/plain with file paths (from internal FileExplorer)
    const textData = e.dataTransfer.getData('text/plain') || '';
    const { fs, path } = window.electron_nodeModules;
    const parsed = parseDroppedPathsPayload(textData, { fs, path, projectRoot: project?.path || '' });
    if (!parsed) return;

    for (const missing of parsed.missing) {
      const Toast = require('./Toast');
      Toast.showToast({
        message: (t('chat.fileNotFound') || 'File not found') + ': ' + missing,
        type: 'error',
      });
    }

    for (const file of parsed.files) {
      addMentionChip('file', { path: file.path, fullPath: file.fullPath });
    }

    if (parsed.directories.length > 0) {
      const Toast = require('./Toast');
      Toast.showToast({
        message: t('chat.dropFolderNotSupported') || 'Folders cannot be attached, drop files instead',
        type: 'warning',
      });
    }

    if (parsed.files.length > 0) {
      inputEl.focus();
    }
  }

  // Paste: images from clipboard + strip HTML for text
  inputEl.addEventListener('paste', (e) => {
    const imageItems = Array.from(e.clipboardData.items).filter(i => i.type.startsWith('image/'));
    if (imageItems.length > 0) {
      e.preventDefault();
      const files = imageItems.map(i => i.getAsFile()).filter(Boolean);
      if (files.length) addImageFiles(files);
      return;
    }
    // Strip HTML formatting, insert as plain text
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (text) document.execCommand('insertText', false, text);
  });

  // ── Input handling ──

  inputEl.addEventListener('input', () => {
    // Normalize empty state (browsers insert <br> when clearing contenteditable)
    if (inputEl.innerHTML === '<br>' || (inputEl.textContent.trim() === '' && !inputEl.querySelector('.chat-inline-chip'))) {
      inputEl.innerHTML = '';
    }
    // Sync pendingMentions with DOM - if user deleted a chip via selection+delete, remove from array
    syncMentionsWithDOM();
    updatePlaceholderVisibility();
    autoResize();
    const text = getInputText();
    if (text !== '') contextSuggestions.stop();
    // Slash commands take precedence (/ at start of line)
    if (text.startsWith('/')) {
      hideMentionDropdown();
      updateSlashDropdown();
    } else {
      hideSlashDropdown();
      updateMentionDropdown();
    }
  });

  // Track Shift key state independently to avoid e.shiftKey race condition on fast Shift+Enter
  let shiftHeld = false;
  const _onShiftBlur = () => { shiftHeld = false; };
  wrapperEl.addEventListener('keyup', (e) => { if (e.key === 'Shift') shiftHeld = false; }, true);
  window.addEventListener('blur', _onShiftBlur);

  // Ctrl+Arrow to switch terminals/projects (capture phase to intercept before textarea)
  wrapperEl.addEventListener('keydown', (e) => {
    if (e.key === 'Shift') shiftHeld = true;
    if (e.ctrlKey && !e.shiftKey && !e.altKey) {
      if (e.key === 'ArrowLeft' && onSwitchTerminal) { e.preventDefault(); e.stopPropagation(); onSwitchTerminal('left'); return; }
      if (e.key === 'ArrowRight' && onSwitchTerminal) { e.preventDefault(); e.stopPropagation(); onSwitchTerminal('right'); return; }
      if (e.key === 'ArrowUp' && onSwitchProject) { e.preventDefault(); e.stopPropagation(); onSwitchProject('up'); return; }
      if (e.key === 'ArrowDown' && onSwitchProject) { e.preventDefault(); e.stopPropagation(); onSwitchProject('down'); return; }
    }
  }, true);

  inputEl.addEventListener('keydown', (e) => {
    // Mention dropdown navigation
    if (mentionDropdown.style.display !== 'none') {
      const items = mentionDropdown.querySelectorAll('.chat-mention-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionSelectedIndex = Math.min(mentionSelectedIndex + 1, items.length - 1);
        highlightMentionItem(items);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionSelectedIndex = Math.max(mentionSelectedIndex - 1, 0);
        highlightMentionItem(items);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && mentionSelectedIndex >= 0 && items[mentionSelectedIndex]) {
        e.preventDefault();
        const item = items[mentionSelectedIndex];
        if (mentionMode === 'file') {
          selectMentionFile(item.dataset.path, item.dataset.fullpath);
        } else if (mentionMode === 'projects') {
          selectMentionProject(item.dataset.projectid, item.dataset.projectname, item.dataset.projectpath);
        } else if (mentionMode === 'context') {
          selectContextPack(item.dataset.packid, item.dataset.packname);
        } else if (mentionMode === 'prompt') {
          selectPromptTemplate(item.dataset.promptid, item.dataset.promptname);
        } else {
          selectMentionType(item.dataset.type);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideMentionDropdown();
        return;
      }
    }

    // Slash dropdown navigation
    if (slashDropdown.style.display !== 'none') {
      const items = slashDropdown.querySelectorAll('.chat-slash-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashSelectedIndex = Math.min(slashSelectedIndex + 1, items.length - 1);
        highlightSlashItem(items);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashSelectedIndex = Math.max(slashSelectedIndex - 1, 0);
        highlightSlashItem(items);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && slashSelectedIndex >= 0 && items[slashSelectedIndex]) {
        e.preventDefault();
        selectSlashCommand(items[slashSelectedIndex].dataset.command);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideSlashDropdown();
        return;
      }
    }

    // Context suggestion — Tab to accept
    if (e.key === 'Tab' && mentionDropdown.style.display === 'none' && slashDropdown.style.display === 'none') {
      if (contextSuggestions.handleTab(e)) return;
      // Tab to focus follow-up suggestion chips (if visible and input empty or has text)
      if (followupSuggestionsEl.style.display !== 'none') {
        const firstChip = followupSuggestionsEl.querySelector('.chat-followup-chip');
        if (firstChip) {
          e.preventDefault();
          firstChip.focus();
          return;
        }
      }
    }

    // Backspace: delete inline chip if cursor is right after one
    if (e.key === 'Backspace') {
      const sel = window.getSelection();
      if (sel.rangeCount) {
        const range = sel.getRangeAt(0);
        if (range.collapsed) {
          const node = range.startContainer;
          const offset = range.startOffset;
          // Cursor at start of text node, previous sibling is a chip
          if (node.nodeType === Node.TEXT_NODE && offset === 0) {
            const prev = node.previousSibling;
            if (prev && prev.classList && prev.classList.contains('chat-inline-chip')) {
              e.preventDefault();
              removeMentionInline(parseInt(prev.dataset.mentionIndex));
              return;
            }
          }
          // Cursor is in inputEl (between children)
          if (node === inputEl && offset > 0) {
            let prev = inputEl.childNodes[offset - 1];
            // Skip zero-width space
            if (prev && prev.nodeType === Node.TEXT_NODE && prev.textContent === '\u200B') {
              prev.remove();
              prev = inputEl.childNodes[offset - 2];
            }
            if (prev && prev.classList && prev.classList.contains('chat-inline-chip')) {
              e.preventDefault();
              removeMentionInline(parseInt(prev.dataset.mentionIndex));
              return;
            }
          }
        }
      }
    }

    // Shift+Enter: insert line break
    if (e.key === 'Enter' && (shiftHeld || e.shiftKey || e.getModifierState('Shift'))) {
      e.preventDefault();
      document.execCommand('insertLineBreak');
      autoResize();
      return;
    }

    if (e.key === 'Enter' && !shiftHeld && !e.shiftKey && !e.getModifierState('Shift')) {
      e.preventDefault();
      handleSend();
    }
  });

  // ── Slash command autocomplete ──

  function updateSlashDropdown() {
    const text = getInputText();
    // Show only when text starts with / and cursor is still in the command part
    if (!text.startsWith('/') || text.includes(' ') || text.includes('\n')) {
      hideSlashDropdown();
      return;
    }
    const query = text.slice(1).toLowerCase();
    // Commands that work in Agent SDK environment
    const builtinDefaults = [
      // SDK built-in commands
      '/compact', '/clear', '/help', '/plan',
      // Bundled skills (sent as prompts to Claude)
      '/batch', '/simplify', '/debug', '/loop', '/claude-api',
      '/security-review', '/btw', '/review',
      // Claude Terminal own commands
      '/parallel-task', '/reload-plugins',
    ];
    // Add user-invocable skills as slash commands
    const skills = (skillsAgentsState.get().skills || []).filter(s => s.userInvocable !== false);
    const skillCommands = skills.map(s => '/' + s.name.replace(/\s+/g, '-').toLowerCase());
    // Normalize to '/name' lowercase so SDK-provided commands (sometimes without leading '/')
    // match our '/name' skill/builtin entries and don't show up twice.
    const normKey = (c) => ('/' + String(c).replace(/^\//, '')).toLowerCase();
    const dedupe = (list) => {
      const seen = new Set();
      const out = [];
      for (const c of list) {
        const k = normKey(c);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(c);
      }
      return out;
    };
    const allDefaults = dedupe([...builtinDefaults, ...skillCommands]);
    // When session provides slash_commands, merge with skills; otherwise use full defaults
    const available = slashCommands.length > 0
      ? dedupe([...slashCommands, ...skillCommands])
      : allDefaults;
    const filtered = available.filter(cmd => {
      const name = cmd.replace(/^\//, '').toLowerCase();
      return name.includes(query);
    });

    if (filtered.length === 0) {
      hideSlashDropdown();
      return;
    }

    slashDropdown.innerHTML = filtered.map((cmd, i) => {
      const name = cmd.startsWith('/') ? cmd : '/' + cmd;
      const desc = getSlashCommandDescription(name);
      return `<div class="chat-slash-item${i === slashSelectedIndex ? ' active' : ''}" data-command="${escapeHtml(name)}">
        <span class="chat-slash-name">${escapeHtml(name)}</span>
        <span class="chat-slash-desc">${escapeHtml(desc)}</span>
      </div>`;
    }).join('');

    slashDropdown.style.display = '';
    // Clamp selected index
    if (slashSelectedIndex >= filtered.length) slashSelectedIndex = filtered.length - 1;

    // Click handler for items
    slashDropdown.querySelectorAll('.chat-slash-item').forEach(item => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // prevent input blur
        selectSlashCommand(item.dataset.command);
      });
      item.addEventListener('mouseenter', () => {
        slashSelectedIndex = [...slashDropdown.querySelectorAll('.chat-slash-item')].indexOf(item);
        highlightSlashItem(slashDropdown.querySelectorAll('.chat-slash-item'));
      });
    });
  }

  function getSlashCommandDescription(cmd) {
    const descriptions = {
      // SDK built-in commands
      '/compact': t('chat.slashCompact'),
      '/clear': t('chat.slashClear'),
      '/help': t('chat.slashHelp'),
      '/plan': t('chat.slashPlan'),
      // Bundled skills (prompts sent to Claude)
      '/batch': t('chat.slashBatch'),
      '/simplify': t('chat.slashSimplify'),
      '/debug': t('chat.slashDebug'),
      '/loop': t('chat.slashLoop'),
      '/claude-api': t('chat.slashClaudeApi'),
      '/security-review': t('chat.slashSecurityReview'),
      '/btw': t('chat.slashBtw'),
      '/review': t('chat.slashReview'),
      // Claude Terminal commands
      '/parallel-task': t('chat.slashParallelTask'),
      '/reload-plugins': t('chat.slashReloadPlugins'),
    };
    if (descriptions[cmd]) return descriptions[cmd];
    // Check skills for description
    const cmdName = cmd.replace(/^\//, '').toLowerCase();
    const skills = skillsAgentsState.get().skills || [];
    const skill = skills.find(s => s.name.replace(/\s+/g, '-').toLowerCase() === cmdName);
    if (skill && skill.description) return skill.description;
    return '';
  }

  function highlightSlashItem(items) {
    items.forEach((item, i) => {
      item.classList.toggle('active', i === slashSelectedIndex);
    });
    // Scroll into view
    if (items[slashSelectedIndex]) {
      items[slashSelectedIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  function selectSlashCommand(command) {
    setInputText(command);
    inputEl.focus();
    hideSlashDropdown();
  }

  function hideSlashDropdown() {
    slashDropdown.style.display = 'none';
    slashDropdown.innerHTML = '';
    slashSelectedIndex = 0;
  }

  inputEl.addEventListener('blur', () => {
    // Small delay to allow click on dropdown items
    setTimeout(() => { hideSlashDropdown(); hideMentionDropdown(); }, 150);
  });

  // ── Mention autocomplete ──

  const MENTION_TYPES = [
    { type: 'file', label: '@file', desc: t('chat.mentionFile'), icon: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>' },
    { type: 'git', label: '@git', desc: t('chat.mentionGit'), icon: '<svg viewBox="0 0 24 24"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 012 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>' },
    { type: 'diff', label: '@diff', desc: t('chat.mentionDiff'), icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18"/><path d="M18 9l-6-6-6 6"/><path d="M6 15l6 6 6-6"/></svg>' },
    { type: 'terminal', label: '@terminal', desc: t('chat.mentionTerminal'), icon: '<svg viewBox="0 0 24 24"><polyline points="4,17 10,11 4,5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>' },
    { type: 'errors', label: '@errors', desc: t('chat.mentionErrors'), icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>' },
    { type: 'selection', label: '@selection', desc: t('chat.mentionSelection'), icon: '<svg viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>' },
    { type: 'todos', label: '@todos', desc: t('chat.mentionTodos'), icon: '<svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22,4 12,14.01 9,11.01"/></svg>' },
    { type: 'symbol', label: '@symbol', desc: t('chat.mentionSymbol'), icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h4v10H4z"/><path d="M16 7h4v10h-4z"/><path d="M8 12h8"/></svg>' },
    { type: 'project', label: '@project', desc: t('chat.mentionProject'), icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>' },
    { type: 'tab', label: '@tab', desc: t('chat.mentionTab'), icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 8h8l2-4h8"/><polyline points="7,13 10,16 7,19"/></svg>' },
    { type: 'conversation', label: '@conversation', desc: t('chat.mentionConversation'), icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/><path d="M8 9h8"/><path d="M8 13h5"/></svg>' },
    { type: 'context', label: '@context', desc: t('chat.mentionContext'), icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>' },
    { type: 'prompt', label: '@prompt', desc: t('chat.mentionPrompt'), icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' },
    { type: 'ParallelTask', label: '@ParallelTask', desc: t('chat.mentionParallelTask'), icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>' },
  ];

  // ── Mention picker infrastructure ──

  async function scanProjectFiles(projectPath) {
    const { fileExists, fsp } = require('../../utils/fs-async');
    const { path } = window.electron_nodeModules;
    const files = [];
    const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'vendor', '.cache', 'coverage', '.nuxt']);

    async function scan(dir, depth) {
      if (depth > 6 || files.length >= 500) return;
      try {
        const entries = await fsp.readdir(dir);
        for (const entry of entries) {
          if (files.length >= 500) break;
          if (entry.startsWith('.') && entry !== '.env') continue;
          if (ignoreDirs.has(entry)) continue;
          const fullPath = path.join(dir, entry);
          try {
            const stat = await fsp.stat(fullPath);
            if (stat.isDirectory()) {
              await scan(fullPath, depth + 1);
            } else if (stat.isFile()) {
              files.push({ path: path.relative(projectPath, fullPath).replace(/\\/g, '/'), fullPath, mtime: stat.mtimeMs });
            }
          } catch (e) { /* skip inaccessible */ }
        }
      } catch (e) { /* skip inaccessible */ }
    }

    await scan(projectPath, 0);
    files.sort((a, b) => b.mtime - a.mtime);
    return files;
  }

  async function getFileCache() {
    const projectPath = project?.path;
    if (!projectPath) return [];
    if (mentionFileCache && mentionFileCache.projectPath === projectPath && Date.now() - mentionFileCache.timestamp < MENTION_FILE_CACHE_TTL) {
      return mentionFileCache.files;
    }
    const files = await scanProjectFiles(projectPath);
    mentionFileCache = { files, timestamp: Date.now(), projectPath };
    return files;
  }

  // Picker configs — each defines how a picker mode loads, filters, renders and selects items
  const PICKER_CONFIGS = {
    file: {
      mode: 'file',
      keyword: '@file',
      maxItems: 40,
      emptyText: () => t('chat.mentionNoFiles'),
      getData: () => getFileCache(),
      filter: (items, q) => items.filter(f => f.path.toLowerCase().includes(q)),
      renderItem: (item) => `
        <span class="chat-mention-item-icon"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg></span>
        <span class="chat-mention-item-path">${escapeHtml(item.path)}</span>`,
      itemAttrs: (item) => `data-path="${escapeHtml(item.path)}" data-fullpath="${escapeHtml(item.fullPath)}"`,
      onSelect: (el) => {
        if (el.dataset.path) {
          removeAtTrigger();
          // Check if user typed a line range after the file path (e.g. @file src/app.ts:100-200)
          const beforeCursor = getTextBeforeCaret();
          const rangeMatch = beforeCursor.match(/:(\d+)(?:-(\d+))?\s*$/);
          const lineRange = rangeMatch ? { start: parseInt(rangeMatch[1]), end: rangeMatch[2] ? parseInt(rangeMatch[2]) : null } : null;
          addMentionChip('file', { path: el.dataset.path, fullPath: el.dataset.fullpath, lineRange });
          hideMentionDropdown();
          inputEl.focus();
        }
      },
    },
    projects: {
      mode: 'projects',
      keyword: '@project',
      maxItems: 40,
      emptyText: () => t('chat.mentionNoProjects'),
      getData: () => {
        const { projectsState } = require('../../state/projects.state');
        return projectsState.get().projects || [];
      },
      filter: (items, q) => items.filter(p => (p.name || '').toLowerCase().includes(q) || (p.path || '').toLowerCase().includes(q)),
      renderItem: (p) => {
        const pIcon = p.icon || null;
        const pColorRaw = p.color || null;
        const pColor = sanitizeColor(pColorRaw) || null;
        const iconHtml = pIcon
          ? `<span class="chat-mention-item-emoji"${pColor ? ` style="color:${pColor}"` : ''}>${escapeHtml(pIcon)}</span>`
          : `<span class="chat-mention-item-icon"${pColor ? ` style="color:${pColor}"` : ''}><svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg></span>`;
        return `${iconHtml}
        <div class="chat-mention-item-info">
          <span class="chat-mention-item-name">${escapeHtml(p.name || p.path || 'Unknown')}</span>
          <span class="chat-mention-item-desc">${escapeHtml(p.path || '')}</span>
        </div>`;
      },
      itemAttrs: (p) => `data-projectid="${escapeHtml(p.id)}" data-projectname="${escapeHtml(p.name || '')}" data-projectpath="${escapeHtml(p.path || '')}" data-projecticon="${escapeHtml(p.icon || '')}" data-projectcolor="${escapeHtml(p.color || '')}"`,
      onSelect: (el) => {
        if (el.dataset.projectid) {
          removeAtTrigger();
          addMentionChip('project', { id: el.dataset.projectid, name: el.dataset.projectname, path: el.dataset.projectpath, icon: el.dataset.projecticon || '', color: el.dataset.projectcolor || '' });
          hideMentionDropdown();
          inputEl.focus();
        }
      },
    },
    context: {
      mode: 'context',
      keyword: '@context',
      maxItems: 20,
      emptyText: () => t('chat.mentionNoContextPacks'),
      getData: () => {
        const ContextPromptService = require('../../services/ContextPromptService');
        return ContextPromptService.getContextPacks(project?.id);
      },
      filter: (items, q) => items.filter(p => (p.name || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q)),
      renderItem: (pack) => `
        <span class="chat-mention-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></span>
        <div class="chat-mention-item-info">
          <span class="chat-mention-item-name">${escapeHtml(pack.name)}</span>
          <span class="chat-mention-item-desc">${escapeHtml(pack.description || '')}${pack.scope === 'project' ? ' <span class="chat-mention-badge">project</span>' : ''}</span>
        </div>
        <button class="chat-mention-preview-btn" data-previewid="${escapeHtml(pack.id)}" title="${escapeHtml(t('chat.previewContextPack') || 'Preview')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>`,
      itemAttrs: (pack) => `data-packid="${escapeHtml(pack.id)}" data-packname="${escapeHtml(pack.name)}"`,
      onSelect: (el) => {
        // Ignore clicks on preview button
        if (el.dataset.previewid) return;
        if (el.dataset.packid) {
          removeAtTrigger();
          addMentionChip('context', { id: el.dataset.packid, name: el.dataset.packname });
          hideMentionDropdown();
          inputEl.focus();
        }
      },
    },
    prompt: {
      mode: 'prompt',
      keyword: '@prompt',
      maxItems: 20,
      emptyText: () => t('chat.mentionNoPrompts'),
      getData: () => {
        const ContextPromptService = require('../../services/ContextPromptService');
        return ContextPromptService.getPromptTemplates(project?.id);
      },
      filter: (items, q) => items.filter(p => (p.name || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q)),
      renderItem: (tmpl) => `
        <span class="chat-mention-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></span>
        <div class="chat-mention-item-info">
          <span class="chat-mention-item-name">${escapeHtml(tmpl.name)}</span>
          <span class="chat-mention-item-desc">${escapeHtml(tmpl.description || '')}${tmpl.scope === 'project' ? ' <span class="chat-mention-badge">project</span>' : ''}</span>
        </div>`,
      itemAttrs: (tmpl) => `data-promptid="${escapeHtml(tmpl.id)}" data-promptname="${escapeHtml(tmpl.name)}"`,
      onSelect: async (el) => {
        if (el.dataset.promptid) {
          const ContextPromptService = require('../../services/ContextPromptService');
          removeAtTrigger();
          hideMentionDropdown();
          const resolvedText = await ContextPromptService.resolvePromptTemplate(el.dataset.promptid, project);
          // Insert resolved text at cursor position
          document.execCommand('insertText', false, resolvedText);
          autoResize();
          inputEl.focus();
        }
      },
    },
    tabs: {
      mode: 'tabs',
      keyword: '@tab',
      maxItems: 20,
      emptyText: () => t('chat.mentionNoTabs'),
      getData: () => {
        const { getTerminals, getActiveTerminal } = require('../../state');
        const terminals = getTerminals();
        const activeId = getActiveTerminal();
        const items = [];
        terminals.forEach((term, id) => {
          if (id === activeId) return;
          const projName = term.project?.name || term.project?.path || '';
          items.push({ id, name: term.name || `Terminal ${id}`, projectName: projName, status: term.status || 'ready', mode: term.mode || 'terminal', isBasic: !!term.isBasic });
        });
        return items;
      },
      filter: (items, q) => items.filter(t => (t.name || '').toLowerCase().includes(q) || (t.projectName || '').toLowerCase().includes(q)),
      renderItem: (tab) => {
        const statusDot = tab.status === 'working' ? '🟢' : tab.status === 'loading' ? '🟡' : '⚪';
        const modeLabel = tab.mode === 'chat' ? 'Chat' : tab.isBasic ? 'Terminal' : 'Claude';
        return `
        <span class="chat-mention-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 8h8l2-4h8"/><polyline points="7,13 10,16 7,19"/></svg></span>
        <div class="chat-mention-item-info">
          <span class="chat-mention-item-name">${statusDot} ${escapeHtml(tab.name)}</span>
          <span class="chat-mention-item-desc">${escapeHtml(tab.projectName)} · ${modeLabel}</span>
        </div>`;
      },
      itemAttrs: (tab) => `data-terminalid="${tab.id}" data-terminalname="${escapeHtml(tab.name)}"`,
      onSelect: (el) => {
        if (el.dataset.terminalid) {
          removeAtTrigger();
          addMentionChip('tab', { terminalId: parseInt(el.dataset.terminalid) || el.dataset.terminalid, name: el.dataset.terminalname });
          hideMentionDropdown();
          inputEl.focus();
        }
      },
    },
    conversations: {
      mode: 'conversations',
      keyword: '@conversation',
      maxItems: 20,
      emptyText: () => conversationCache?._loading ? (t('chat.mentionConversationsLoading') || 'Loading...') : t('chat.mentionNoConversations'),
      getData: () => {
        if (conversationCache && conversationCache.projectPath === project?.path && !conversationCache._loading) {
          return conversationCache.sessions || [];
        }
        return [];
      },
      filter: (items, q) => items.filter(s => (s.firstPrompt || '').toLowerCase().includes(q) || (s.summary || '').toLowerCase().includes(q)),
      renderItem: (session) => {
        const date = session.modified ? new Date(session.modified) : null;
        const dateStr = date ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
        const prompt = session.firstPrompt || session.summary || session.sessionId?.slice(0, 8) || '?';
        const truncated = prompt.length > 80 ? prompt.slice(0, 80) + '…' : prompt;
        return `
        <span class="chat-mention-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/><path d="M8 9h8"/><path d="M8 13h5"/></svg></span>
        <div class="chat-mention-item-info">
          <span class="chat-mention-item-name">${escapeHtml(truncated)}</span>
          <span class="chat-mention-item-desc">${escapeHtml(dateStr)}${session.messageCount ? ` · ${session.messageCount} msgs` : ''}${session.gitBranch ? ` · ${escapeHtml(session.gitBranch)}` : ''}</span>
        </div>`;
      },
      itemAttrs: (session) => `data-sessionid="${escapeHtml(session.sessionId)}" data-sessionname="${escapeHtml((session.firstPrompt || session.summary || '').slice(0, 60))}"`,
      onSelect: (el) => {
        if (el.dataset.sessionid) {
          removeAtTrigger();
          addMentionChip('conversation', { sessionId: el.dataset.sessionid, firstPrompt: el.dataset.sessionname, projectPath: project?.path });
          hideMentionDropdown();
          inputEl.focus();
        }
      },
    },
    workspace: {
      mode: 'workspace',
      keyword: '@workspace',
      maxItems: 20,
      emptyText: () => t('workspace.noWorkspaces') || 'No workspaces',
      getData: () => {
        const wsState = require('../../state/workspace.state');
        return wsState.workspaceState.get().workspaces || [];
      },
      filter: (items, q) => items.filter(w => (w.name || '').toLowerCase().includes(q) || (w.description || '').toLowerCase().includes(q)),
      renderItem: (w) => {
        const projCount = w.projectIds?.length || 0;
        return `
        <span class="chat-mention-item-emoji"${w.color ? ` style="color:${w.color}"` : ''}>${w.icon || '📦'}</span>
        <div class="chat-mention-item-info">
          <span class="chat-mention-item-name">${escapeHtml(w.name)}</span>
          <span class="chat-mention-item-desc">${projCount} project(s)</span>
        </div>`;
      },
      itemAttrs: (w) => `data-workspaceid="${escapeHtml(w.id)}" data-workspacename="${escapeHtml(w.name)}"`,
      onSelect: (el) => {
        if (el.dataset.workspaceid) {
          removeAtTrigger();
          addMentionChip('workspace', { id: el.dataset.workspaceid, name: el.dataset.workspacename });
          hideMentionDropdown();
          inputEl.focus();
        }
      },
    },
  };

  // Map mention type names to their picker config key
  const PICKER_TYPE_MAP = { file: 'file', project: 'projects', context: 'context', prompt: 'prompt', tab: 'tabs', conversation: 'conversations', workspace: 'workspace' };

  // ── Pluggable sources via MentionSourceRegistry ──
  // Sources registered elsewhere (kanban, workflow, parallel, session, skill, workspaceDoc, ...)
  // are injected into MENTION_TYPES and PICKER_CONFIGS so the rest of the dropdown
  // logic treats them exactly like the built-in ones.
  (() => {
    try {
      const registry = require('../../services/MentionSourceRegistry');
      const _sourceItemCache = new Map(); // source.id -> last getData() array, keyed for onSelect lookup

      for (const source of registry.forSurface('mention')) {
        // Skip if already hardcoded (prevents double-injection for pre-existing mentions)
        if (MENTION_TYPES.some(m => m.type === source.id)) continue;

        MENTION_TYPES.push({
          type: source.id,
          label: source.keyword,
          desc: source.label(),
          icon: source.icon,
        });

        PICKER_CONFIGS[source.id] = {
          mode: source.id,
          keyword: source.keyword,
          maxItems: 40,
          emptyText: () => t('chat.mentionNoResults') || 'No results',
          getData: async () => {
            const data = await Promise.resolve(source.getData({ project, query: '' })).catch(() => []);
            _sourceItemCache.set(source.id, data);
            return data;
          },
          filter: (items, q) => {
            const decorated = items.map(i => ({ ...i, render: () => source.render(i) }));
            return registry.defaultFilter(decorated, q);
          },
          renderItem: (item) => {
            const v = source.render(item);
            const iconHtml = v.emoji
              ? `<span class="chat-mention-item-emoji"${v.color ? ` style="color:${v.color}"` : ''}>${escapeHtml(v.emoji)}</span>`
              : `<span class="chat-mention-item-icon"${v.color ? ` style="color:${v.color}"` : ''}>${v.icon || source.icon}</span>`;
            const badge = v.badge ? ` <span class="chat-mention-badge">${escapeHtml(v.badge)}</span>` : '';
            return `${iconHtml}
              <div class="chat-mention-item-info">
                <span class="chat-mention-item-name">${escapeHtml(v.label)}${badge}</span>
                <span class="chat-mention-item-desc">${escapeHtml(v.sublabel || '')}</span>
              </div>`;
          },
          itemAttrs: (item) => `data-sourceid="${escapeHtml(source.id)}" data-itemid="${escapeHtml(String(item.id))}"`,
          onSelect: (el) => {
            const cache = _sourceItemCache.get(source.id) || [];
            const item = cache.find(i => String(i.id) === el.dataset.itemid);
            if (!item) return;
            removeAtTrigger();
            source.onSelect(item, 'mention', {
              addMentionChip,
              closeDropdown: hideMentionDropdown,
              insertText: (text) => document.execCommand('insertText', false, text),
            });
            inputEl.focus();
          },
        };

        // Mention type -> picker config key (self-mapping for source-based entries)
        PICKER_TYPE_MAP[source.id] = source.id;
      }
    } catch (err) {
      console.warn('[ChatView] MentionSourceRegistry injection failed:', err);
    }
  })();

  /**
   * Generic picker dropdown renderer — used by all picker modes
   */
  async function renderPickerDropdown(cfg, query) {
    const items = await cfg.getData();
    const q = query.trim().toLowerCase();
    const filtered = q ? cfg.filter(items, q) : items;
    const shown = filtered.slice(0, cfg.maxItems);

    if (shown.length === 0) {
      mentionDropdown.innerHTML = `<div class="chat-mention-item chat-mention-empty"><span class="chat-mention-item-desc">${escapeHtml(cfg.emptyText())}</span></div>`;
      mentionDropdown.style.display = '';
      return;
    }

    mentionMode = cfg.mode;
    if (mentionSelectedIndex >= shown.length) mentionSelectedIndex = shown.length - 1;

    mentionDropdown.innerHTML = shown.map((item, i) =>
      `<div class="chat-mention-item${i === mentionSelectedIndex ? ' active' : ''}" ${cfg.itemAttrs(item)}>${cfg.renderItem(item)}</div>`
    ).join('');

    mentionDropdown.style.display = '';

    mentionDropdown.querySelectorAll('.chat-mention-item').forEach((el, idx) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        cfg.onSelect(el);
      });
      el.addEventListener('mouseenter', () => {
        mentionSelectedIndex = idx;
        highlightMentionItem(mentionDropdown.querySelectorAll('.chat-mention-item'));
      });
    });
    // Context pack preview buttons
    mentionDropdown.querySelectorAll('.chat-mention-preview-btn').forEach(btn => {
      btn.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const packId = btn.dataset.previewid;
        if (!packId) return;
        try {
          const ContextPromptService = require('../../services/ContextPromptService');
          const { content, stats } = await ContextPromptService.previewContextPack(packId, project?.path);
          const { showModal } = require('./Modal');
          showModal({
            title: `${t('chat.previewContextPack') || 'Context Pack Preview'} (${stats.files} files, ${stats.lines} lines, ${Math.round(stats.chars / 1024)}KB)`,
            content: `<pre style="max-height:400px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-all;background:var(--bg-primary);padding:12px;border-radius:var(--radius-sm)">${escapeHtml(content)}</pre>`,
            size: 'large'
          });
        } catch (err) {
          console.error('[ChatView] Preview failed:', err);
        }
      });
    });
  }

  // ── Mention dropdown logic ──

  function updateMentionDropdown() {
    const beforeCursor = getTextBeforeCaret();
    const text = getInputText();

    // Check if we're in a picker mode
    for (const cfg of Object.values(PICKER_CONFIGS)) {
      if (mentionMode === cfg.mode) {
        const re = new RegExp(cfg.keyword.replace('$', '\\$') + '\\s+(.*)$', 'i');
        const match = beforeCursor.match(re);
        if (match) {
          renderPickerDropdown(cfg, match[1]);
        } else if (!beforeCursor.match(new RegExp(cfg.keyword.replace('$', '\\$'), 'i'))) {
          hideMentionDropdown();
        }
        return;
      }
    }

    // Detect @ trigger to show type menu
    const atMatch = beforeCursor.match(/@(\w*)$/);
    if (!atMatch) {
      hideMentionDropdown();
      return;
    }

    const query = atMatch[1].toLowerCase();
    const LOCAL_ONLY_MENTIONS = ['file', 'git', 'diff', 'errors', 'selection', 'todos', 'symbol'];
    const availableMentions = project.isCloud ? MENTION_TYPES.filter(m => !LOCAL_ONLY_MENTIONS.includes(m.type)) : MENTION_TYPES;
    const filtered = availableMentions.filter(m => m.type.includes(query));
    if (filtered.length === 0) {
      hideMentionDropdown();
      return;
    }

    mentionMode = 'types';
    if (mentionSelectedIndex >= filtered.length) mentionSelectedIndex = filtered.length - 1;

    mentionDropdown.innerHTML = filtered.map((item, i) => `
      <div class="chat-mention-item${i === mentionSelectedIndex ? ' active' : ''}" data-type="${item.type}">
        <span class="chat-mention-item-icon">${item.icon}</span>
        <div class="chat-mention-item-info">
          <span class="chat-mention-item-name">${escapeHtml(item.label)}</span>
          <span class="chat-mention-item-desc">${escapeHtml(item.desc)}</span>
        </div>
      </div>
    `).join('');

    mentionDropdown.style.display = '';

    mentionDropdown.querySelectorAll('.chat-mention-item').forEach((el, idx) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectMentionType(el.dataset.type);
      });
      el.addEventListener('mouseenter', () => {
        mentionSelectedIndex = idx;
        highlightMentionItem(mentionDropdown.querySelectorAll('.chat-mention-item'));
      });
    });
  }

  function highlightMentionItem(items) {
    items.forEach((item, i) => item.classList.toggle('active', i === mentionSelectedIndex));
    if (items[mentionSelectedIndex]) items[mentionSelectedIndex].scrollIntoView({ block: 'nearest' });
  }

  function hideMentionDropdown() {
    mentionDropdown.style.display = 'none';
    mentionDropdown.innerHTML = '';
    mentionSelectedIndex = 0;
    mentionMode = null;
  }

  function removeAtTrigger() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;

    const offset = range.startOffset;
    const text = node.textContent;
    const before = text.substring(0, offset);
    const after = text.substring(offset);
    const cleaned = before.replace(/@\w*(?:\s+\S*)?$/, '');
    node.textContent = cleaned + after;

    const newRange = document.createRange();
    newRange.setStart(node, cleaned.length);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }

  function selectMentionType(type) {
    // @ParallelTask — navigate to Parallel Task Manager tab
    if (type === 'ParallelTask') {
      removeAtTrigger();
      hideMentionDropdown();
      inputEl.focus();
      const parallelTab = document.querySelector('.nav-tab[data-tab="tasks"]');
      if (parallelTab) parallelTab.click();
      return;
    }

    // If this type has a picker, switch to picker mode
    const pickerKey = PICKER_TYPE_MAP[type];
    if (pickerKey) {
      const cfg = PICKER_CONFIGS[pickerKey];
      removeAtTrigger();
      document.execCommand('insertText', false, cfg.keyword + ' ');
      mentionMode = cfg.mode;
      renderPickerDropdown(cfg, '');
      inputEl.focus();
      // Async data loading for conversation picker
      if (type === 'conversation' && project?.path) {
        const projectPath = project.path;
        const isFresh = conversationCache && conversationCache.projectPath === projectPath && !conversationCache._loading && Date.now() - conversationCache.timestamp < CONVERSATION_CACHE_TTL;
        if (!isFresh) {
          conversationCache = { sessions: [], timestamp: 0, projectPath, _loading: true };
          renderPickerDropdown(cfg, '');
          api.claude.sessions(projectPath).then(sessions => {
            conversationCache = { sessions: sessions || [], timestamp: Date.now(), projectPath, _loading: false };
            if (mentionMode === 'conversations') renderPickerDropdown(cfg, '');
          }).catch(() => {
            conversationCache = { sessions: [], timestamp: Date.now(), projectPath, _loading: false };
            if (mentionMode === 'conversations') renderPickerDropdown(cfg, '');
          });
        }
      }
      return;
    }

    // @diff — prompt for ref (default HEAD~1)
    if (type === 'diff') {
      removeAtTrigger();
      hideMentionDropdown();
      const ref = prompt(t('chat.diffRefPrompt') || 'Git ref to diff against (e.g. HEAD~3, main, abc1234):', 'HEAD~1');
      if (ref && ref.trim()) {
        addMentionChip('diff', { ref: ref.trim() });
      }
      inputEl.focus();
      return;
    }

    // @symbol — prompt for symbol name
    if (type === 'symbol') {
      removeAtTrigger();
      hideMentionDropdown();
      const name = prompt(t('chat.symbolNamePrompt') || 'Symbol name (function, class, variable):');
      if (name && name.trim()) {
        addMentionChip('symbol', { name: name.trim() });
      }
      inputEl.focus();
      return;
    }

    // Direct mention types — add chip immediately
    removeAtTrigger();
    addMentionChip(type);
    hideMentionDropdown();
    inputEl.focus();
  }

  // ── Mention chips ──

  function getMentionIcon(type) {
    const found = MENTION_TYPES.find(m => m.type === type);
    return found ? found.icon : '';
  }

  function addMentionChip(type, data = null) {
    let label;
    if (type === 'file') {
      label = `@${data.path}`;
      if (data.lineRange) {
        label += `:${data.lineRange.start}${data.lineRange.end ? '-' + data.lineRange.end : ''}`;
      }
    }
    else if (type === 'diff' && data?.ref) label = `@diff:${data.ref}`;
    else if (type === 'symbol' && data?.name) label = `@symbol:${data.name}`;
    else if (type === 'project' && data?.name) label = `@project:${data.name}`;
    else if (type === 'context' && data?.name) label = `@context:${data.name}`;
    else if (type === 'tab' && data?.name) label = `@tab:${data.name}`;
    else if (type === 'conversation' && data?.firstPrompt) label = `@conversation:${data.firstPrompt.slice(0, 40)}${data.firstPrompt.length > 40 ? '…' : ''}`;
    else label = `@${type}`;
    let icon = getMentionIcon(type);
    // Use project emoji if available
    if (type === 'project' && data?.icon) {
      icon = data.icon;
    }
    const index = pendingMentions.length;
    pendingMentions.push({ type, label, icon, data });
    // Insert inline chip at cursor position
    const chipEl = createInlineChipElement(pendingMentions[index], index);
    insertChipAtCaret(chipEl);
  }

  function renderMentionChips() {
    // Legacy: clear all inline chips (used during send)
    clearInlineChips();
    updatePlaceholderVisibility();
  }

  // ── Resolve mentions to text content ──

  async function resolveMentions(mentions) {
    const { fs } = window.electron_nodeModules;
    const resolved = [];

    for (const mention of mentions) {
      let content = '';

      switch (mention.type) {
        case 'file': {
          try {
            const raw = await fs.promises.readFile(mention.data.fullPath, 'utf8');
            const lines = raw.split('\n');
            const range = mention.data.lineRange;
            if (range) {
              const start = Math.max(1, range.start);
              const end = range.end ? Math.min(lines.length, range.end) : Math.min(lines.length, start + 499);
              const slice = lines.slice(start - 1, end);
              content = `File: ${mention.data.path} (lines ${start}-${end} of ${lines.length})\n\n${slice.map((l, i) => `${start + i}: ${l}`).join('\n')}`;
            } else if (lines.length > 500) {
              content = `File: ${mention.data.path} (showing first 500 of ${lines.length} lines)\n\n${lines.slice(0, 500).join('\n')}`;
            } else {
              content = `File: ${mention.data.path}\n\n${raw}`;
            }
          } catch (e) {
            content = `[Error reading file: ${mention.data.path}]`;
          }
          break;
        }

        case 'git': {
          try {
            const status = await api.git.statusDetailed({ projectPath: project.path });
            if (!status?.success || !status.files?.length) {
              content = '[No git changes detected]';
              break;
            }
            const diffs = [];
            for (const file of status.files.slice(0, 20)) {
              try {
                const d = await api.git.fileDiff({ projectPath: project.path, filePath: file.path });
                if (d?.diff) diffs.push(`--- ${file.path} ---\n${d.diff}`);
              } catch (e) { /* skip */ }
            }
            content = diffs.length > 0 ? `Git Changes (${status.files.length} files):\n\n${diffs.join('\n\n')}` : '[No diff content available]';
          } catch (e) {
            content = '[Error fetching git diff]';
          }
          break;
        }

        case 'terminal': {
          const lines = extractTerminalLines(200);
          content = lines.length > 0 ? `Terminal Output (last ${lines.length} lines):\n\n${lines.join('\n')}` : '[No active terminal or empty output]';
          break;
        }

        case 'errors': {
          const allLines = extractTerminalLines(500);
          const errorPattern = /error|exception|failed|ERR!|panic|FATAL|Traceback|at\s+\S+\s+\(/i;
          const errorLines = allLines.filter(l => errorPattern.test(l));
          content = errorLines.length > 0 ? `Error Lines (${errorLines.length} found):\n\n${errorLines.slice(0, 100).join('\n')}` : '[No errors detected in terminal output]';
          break;
        }

        case 'selection': {
          const sel = window.getSelection()?.toString();
          if (sel && sel.trim()) {
            const truncated = sel.length > 10000 ? sel.slice(0, 10000) + '\n\n(Truncated to 10,000 characters)' : sel;
            content = `Selected Text:\n\n${truncated}`;
          } else {
            content = '[No text currently selected]';
          }
          break;
        }

        case 'todos': {
          try {
            const todos = await api.project.scanTodos(project.path);
            if (todos?.length > 0) {
              content = `TODO Items (${todos.length} found):\n\n${todos.slice(0, 50).map(t => `${t.type} [${t.file}:${t.line}]: ${t.text}`).join('\n')}`;
            } else {
              content = '[No TODOs found in project]';
            }
          } catch (e) {
            content = '[Error scanning TODOs]';
          }
          break;
        }

        case 'context': {
          try {
            const ContextPromptService = require('../../services/ContextPromptService');
            content = await ContextPromptService.resolveContextPack(mention.data.id, project?.path);
          } catch (e) {
            content = `[Error resolving context pack: ${mention.data.name}]`;
          }
          break;
        }

        case 'diff': {
          try {
            const ref = mention.data?.ref || 'HEAD';
            const { execSync } = window.electron_nodeModules.child_process;
            const diff = execSync(`git diff ${ref}`, { cwd: project.path, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 15000 });
            if (diff.trim()) {
              content = `Git Diff (${ref}):\n\n${diff.length > 30000 ? diff.slice(0, 30000) + '\n\n[Diff truncated at 30,000 chars]' : diff}`;
            } else {
              content = `[No diff found for ${ref}]`;
            }
          } catch (e) {
            content = `[Error running git diff: ${e.message}]`;
          }
          break;
        }

        case 'symbol': {
          try {
            const symbolName = mention.data?.name || '';
            if (!symbolName) { content = '[No symbol name provided]'; break; }
            const { execSync } = window.electron_nodeModules.child_process;
            // Use git grep for fast symbol search across the project
            const grepResult = execSync(
              `git grep -n -E "(function|class|const|let|var|def |interface |type |enum |export )\\s*${symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b"`,
              { cwd: project.path, encoding: 'utf8', maxBuffer: 512 * 1024, timeout: 10000 }
            ).trim();
            if (grepResult) {
              const matches = grepResult.split('\n').slice(0, 10);
              const parts = [`Symbol: ${symbolName} (${matches.length} definition(s) found)\n`];
              for (const match of matches) {
                const [fileLine, ...rest] = match.split(':');
                const sepIdx = fileLine.lastIndexOf(':');
                // git grep format: file:line:content
                parts.push(match);
              }
              // Read the first match's surrounding context
              const firstMatch = matches[0];
              const firstColon = firstMatch.indexOf(':');
              const secondColon = firstMatch.indexOf(':', firstColon + 1);
              if (firstColon > 0 && secondColon > 0) {
                const filePath = firstMatch.substring(0, firstColon);
                const lineNum = parseInt(firstMatch.substring(firstColon + 1, secondColon));
                if (!isNaN(lineNum)) {
                  const fullPath = window.electron_nodeModules.path.join(project.path, filePath);
                  try {
                    const fileContent = await fs.promises.readFile(fullPath, 'utf8');
                    const allLines = fileContent.split('\n');
                    const start = Math.max(0, lineNum - 3);
                    const end = Math.min(allLines.length, lineNum + 30);
                    parts.push(`\n--- ${filePath}:${start + 1}-${end} ---`);
                    parts.push(allLines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n'));
                  } catch (_) { /* file read error */ }
                }
              }
              content = parts.join('\n');
            } else {
              content = `[Symbol "${symbolName}" not found in project]`;
            }
          } catch (e) {
            if (e.status === 1) {
              content = `[Symbol "${mention.data?.name}" not found in project]`;
            } else {
              content = `[Error searching for symbol: ${e.message}]`;
            }
          }
          break;
        }

        case 'project': {
          // Use selected project data if available, otherwise fall back to current project
          const targetName = mention.data?.name || project.name || 'Unknown';
          const targetPath = mention.data?.path || project.path;
          try {
            const parts = [`Project: ${targetName}`, `Path: ${targetPath}`];
            // Git info
            const [branch, status, stats] = await Promise.all([
              api.git.currentBranch({ projectPath: targetPath }).catch(() => null),
              api.git.statusDetailed({ projectPath: targetPath }).catch(() => null),
              api.project.stats(targetPath).catch(() => null),
            ]);
            if (branch) parts.push(`Git Branch: ${branch}`);
            if (status?.success && status.files?.length > 0) {
              parts.push(`Git Status: ${status.files.length} changed files`);
              const summary = status.files.slice(0, 15).map(f => `  ${f.status} ${f.path}`).join('\n');
              parts.push(summary);
            } else {
              parts.push('Git Status: clean');
            }
            if (stats) {
              parts.push(`Stats: ${stats.files} files, ${stats.lines.toLocaleString()} lines of code`);
              if (stats.byExtension) {
                const top = Object.entries(stats.byExtension)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 8)
                  .map(([ext, lines]) => `  ${ext}: ${lines.toLocaleString()} lines`);
                parts.push('Top Languages:\n' + top.join('\n'));
              }
            }
            const { fs, path: pathModule } = window.electron_nodeModules;

            // Try to read CLAUDE.md from the target project
            const claudeMdPath = pathModule.join(targetPath, 'CLAUDE.md');
            try {
              const claudeMd = await fs.promises.readFile(claudeMdPath, 'utf8');
              if (claudeMd.trim()) {
                const truncated = claudeMd.length > 3000 ? claudeMd.slice(0, 3000) + '\n\n(Truncated)' : claudeMd;
                parts.push(`\nCLAUDE.md:\n${truncated}`);
              }
            } catch (_) { /* no CLAUDE.md */ }

            // Try to read README.md
            const readmePath = pathModule.join(targetPath, 'README.md');
            try {
              const readme = await fs.promises.readFile(readmePath, 'utf8');
              if (readme.trim()) {
                const truncated = readme.length > 3000 ? readme.slice(0, 3000) + '\n\n(Truncated)' : readme;
                parts.push(`\nREADME.md:\n${truncated}`);
              }
            } catch (_) { /* no README.md */ }

            // Build file tree (depth 3, ignoring common non-essential dirs)
            const IGNORED_DIRS = new Set([
              'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
              'vendor', '.cache', 'coverage', '.nuxt', '.output', '.turbo',
              'target', '.svelte-kit', '.parcel-cache', 'out', '.vscode',
            ]);
            async function buildTree(dir, prefix, depth) {
              if (depth <= 0) return '';
              let entries;
              try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true });
              } catch (_) { return ''; }
              // Sort: directories first, then files, alphabetical
              const dirs = [];
              const files = [];
              for (const e of entries) {
                if (e.name.startsWith('.') && depth === 3) continue; // skip dotfiles at root level only for cleanliness
                if (e.isDirectory()) {
                  if (!IGNORED_DIRS.has(e.name)) dirs.push(e);
                } else {
                  files.push(e);
                }
              }
              dirs.sort((a, b) => a.name.localeCompare(b.name));
              files.sort((a, b) => a.name.localeCompare(b.name));
              const all = [...dirs, ...files];
              if (all.length === 0) return '';
              const lines = [];
              for (let i = 0; i < all.length; i++) {
                const entry = all[i];
                const isLast = i === all.length - 1;
                const connector = isLast ? '└── ' : '├── ';
                const childPrefix = isLast ? '    ' : '│   ';
                if (entry.isDirectory()) {
                  lines.push(`${prefix}${connector}${entry.name}/`);
                  const subtree = await buildTree(pathModule.join(dir, entry.name), prefix + childPrefix, depth - 1);
                  if (subtree) lines.push(subtree);
                } else {
                  lines.push(`${prefix}${connector}${entry.name}`);
                }
              }
              return lines.join('\n');
            }
            try {
              const tree = await buildTree(targetPath, '', 3);
              if (tree) {
                parts.push(`\nFile Tree:\n${tree}`);
              }
            } catch (_) { /* tree build error */ }

            content = parts.join('\n');
          } catch (e) {
            content = `Project: ${targetName}\nPath: ${targetPath}\n[Error fetching details: ${e.message}]`;
          }
          break;
        }

        case 'tab': {
          const tabName = mention.data?.name || 'Unknown';
          const termId = mention.data?.terminalId;
          if (termId == null) {
            content = `[Tab "${tabName}" not found]`;
            break;
          }
          const lines = extractTerminalLines(300, termId);
          content = lines.length > 0
            ? `Tab "${tabName}" Output (last ${lines.length} lines):\n\n${lines.join('\n')}`
            : `[Tab "${tabName}" has no output]`;
          break;
        }

        case 'conversation': {
          const sessionId = mention.data?.sessionId;
          const sessionName = mention.data?.firstPrompt || 'Unknown';
          const sessionProjectPath = mention.data?.projectPath || project?.path;
          if (!sessionId || !sessionProjectPath) {
            content = `[Conversation not found]`;
            break;
          }
          try {
            const replay = await api.claude.sessionReplay({ projectPath: sessionProjectPath, sessionId, max_steps: 100 });
            if (!replay?.steps?.length) {
              content = `[Conversation "${sessionName}" is empty]`;
              break;
            }
            const parts = [`Conversation: "${sessionName}"`];
            if (replay.summary) {
              parts.push(`Steps: ${replay.summary.totalSteps || 0}, Est. tokens: ${(replay.summary.totalEstimatedTokens || 0).toLocaleString()}`);
              if (replay.summary.toolBreakdown) {
                const tools = Object.entries(replay.summary.toolBreakdown).map(([k, v]) => `${k}(${v})`).join(', ');
                parts.push(`Tools used: ${tools}`);
              }
            }
            parts.push('');
            for (const step of replay.steps) {
              if (step.type === 'prompt') {
                const txt = step.text?.length > 500 ? step.text.slice(0, 500) + '…' : step.text;
                parts.push(`[User] ${txt}`);
              } else if (step.type === 'response') {
                const txt = step.text?.length > 1000 ? step.text.slice(0, 1000) + '…' : step.text;
                parts.push(`[Claude] ${txt}`);
              } else if (step.type === 'tool') {
                parts.push(`[Tool: ${step.toolName}]${step.filePath ? ` ${step.filePath}` : ''}`);
              }
            }
            content = parts.join('\n');
            if (content.length > 30000) content = content.slice(0, 30000) + '\n\n[Truncated at 30,000 chars]';
          } catch (e) {
            content = `[Error loading conversation "${sessionName}": ${e.message}]`;
          }
          break;
        }

        case 'workspace': {
          try {
            const { path: wsPath } = window.electron_nodeModules;
            const wsState = require('../../state/workspace.state');
            const ws = wsState.getWorkspace(mention.data.id);
            if (!ws) { content = `[Workspace "${mention.data.name}" not found]`; break; }

            const parts = [`# Workspace: ${ws.name}`];
            if (ws.description) parts.push(ws.description);
            parts.push('');

            // List projects
            const { projectsState: pState } = require('../../state/projects.state');
            const allProjects = pState.get().projects;
            const wsProjects = (ws.projectIds || []).map(id => allProjects.find(p => p.id === id)).filter(Boolean);
            parts.push(`## Projects (${wsProjects.length})`);
            for (const p of wsProjects) {
              parts.push(`- ${p.name || wsPath.basename(p.path)} (${p.path})`);
            }
            parts.push('');

            // Load and include docs
            const { workspacesDir } = require('../../utils/paths');
            const docsIndexPath = wsPath.join(workspacesDir, ws.id, 'docs-index.json');
            try {
              const indexRaw = await fs.promises.readFile(docsIndexPath, 'utf8');
              const docsIndex = JSON.parse(indexRaw);
              if (docsIndex.docs?.length > 0) {
                parts.push(`## Knowledge Base (${docsIndex.docs.length} documents)`);
                for (const doc of docsIndex.docs) {
                  const docPath = wsPath.join(workspacesDir, ws.id, 'docs', doc.filename);
                  try {
                    const docContent = await fs.promises.readFile(docPath, 'utf8');
                    const truncated = docContent.length > 5000 ? docContent.slice(0, 5000) + '\n\n[Truncated]' : docContent;
                    parts.push(`### ${doc.title}\n${truncated}\n`);
                  } catch { parts.push(`### ${doc.title}\n[Error reading document]\n`); }
                }
              }
            } catch { /* no docs index */ }

            // Include links
            const linksPath = wsPath.join(workspacesDir, ws.id, 'links.json');
            try {
              const linksRaw = await fs.promises.readFile(linksPath, 'utf8');
              const linksData = JSON.parse(linksRaw);
              if (linksData.links?.length > 0) {
                parts.push(`## Concept Links`);
                for (const link of linksData.links) {
                  parts.push(`- ${link.sourceId} --[${link.label}]--> ${link.targetId}${link.description ? ': ' + link.description : ''}`);
                }
              }
            } catch { /* no links */ }

            content = parts.join('\n');
            if (content.length > 50000) content = content.slice(0, 50000) + '\n\n[Content truncated at 50,000 characters]';
          } catch (e) {
            content = `[Error resolving workspace: ${e.message}]`;
          }
          break;
        }
      }

      resolved.push({ label: mention.label, content });
    }

    return resolved;
  }

  function extractTerminalLinesFrom(termData, maxLines) {
    try {
      if (!termData?.terminal?.buffer?.active) return [];
      const buf = termData.terminal.buffer.active;
      const totalLines = buf.baseY + buf.cursorY;
      const startLine = Math.max(0, totalLines - maxLines);
      const lines = [];
      for (let i = startLine; i <= totalLines; i++) {
        const row = buf.getLine(i);
        if (row) {
          const text = row.translateToString(true).trim();
          if (text) lines.push(text);
        }
      }
      return lines;
    } catch (e) {
      return [];
    }
  }

  function extractTerminalLines(maxLines, targetTerminalId) {
    try {
      const { getActiveTerminal, getTerminal, getTerminalsForProject } = require('../../state');
      const { getProjectIndex } = require('../../state');

      let termData = null;
      if (targetTerminalId != null) {
        termData = getTerminal(targetTerminalId);
      } else {
        const activeId = getActiveTerminal();
        if (activeId != null) {
          const t = getTerminal(activeId);
          if (t?.projectIndex === getProjectIndex(project?.id)) termData = t;
        }
        if (!termData) {
          const projectTerminals = getTerminalsForProject(getProjectIndex(project?.id));
          if (projectTerminals.length > 0) termData = getTerminal(projectTerminals[0].id);
        }
      }

      return extractTerminalLinesFrom(termData, maxLines);
    } catch (e) {
      return [];
    }
  }

  sendBtn.addEventListener('click', handleSend);
  stopBtn.addEventListener('click', () => {
    if (sessionId) {
      isAborting = true;
      api.chat.interrupt({ sessionId });
    }
  });

  // ── Image Lightbox ──

  function ensureLightbox() {
    if (lightboxEl) return;
    lightboxEl = document.createElement('div');
    lightboxEl.className = 'chat-lightbox';
    lightboxEl.innerHTML = `
      <div class="chat-lightbox-backdrop"></div>
      <button class="chat-lightbox-close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
      <button class="chat-lightbox-prev" aria-label="Previous">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
      </button>
      <button class="chat-lightbox-next" aria-label="Next">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
      </button>
      <img class="chat-lightbox-img" alt="" />
      <div class="chat-lightbox-counter"></div>
    `;
    document.body.appendChild(lightboxEl);

    lightboxEl.querySelector('.chat-lightbox-backdrop').addEventListener('click', closeLightbox);
    lightboxEl.querySelector('.chat-lightbox-close').addEventListener('click', closeLightbox);
    lightboxEl.querySelector('.chat-lightbox-prev').addEventListener('click', () => navigateLightbox(-1));
    lightboxEl.querySelector('.chat-lightbox-next').addEventListener('click', () => navigateLightbox(1));
  }

  function openLightbox(images, startIndex) {
    ensureLightbox();
    lightboxImages = images;
    lightboxIndex = startIndex;
    updateLightboxImage();
    requestAnimationFrame(() => lightboxEl.classList.add('active'));
    document.addEventListener('keydown', lightboxKeyHandler);
  }

  function closeLightbox() {
    if (!lightboxEl) return;
    lightboxEl.classList.remove('active');
    document.removeEventListener('keydown', lightboxKeyHandler);
  }

  function navigateLightbox(delta) {
    lightboxIndex = (lightboxIndex + delta + lightboxImages.length) % lightboxImages.length;
    updateLightboxImage();
  }

  function updateLightboxImage() {
    const img = lightboxEl.querySelector('.chat-lightbox-img');
    const counter = lightboxEl.querySelector('.chat-lightbox-counter');
    const prevBtn = lightboxEl.querySelector('.chat-lightbox-prev');
    const nextBtn = lightboxEl.querySelector('.chat-lightbox-next');

    img.src = lightboxImages[lightboxIndex];

    if (lightboxImages.length > 1) {
      counter.textContent = `${lightboxIndex + 1} / ${lightboxImages.length}`;
      counter.style.display = '';
      prevBtn.style.display = '';
      nextBtn.style.display = '';
    } else {
      counter.style.display = 'none';
      prevBtn.style.display = 'none';
      nextBtn.style.display = 'none';
    }
  }

  function lightboxKeyHandler(e) {
    if (e.key === 'Escape') {
      closeLightbox();
    } else if (e.key === 'ArrowLeft') {
      navigateLightbox(-1);
    } else if (e.key === 'ArrowRight') {
      navigateLightbox(1);
    }
  }

  // ── Delegated click handlers ──

  messagesEl.addEventListener('click', (e) => {
    // Note: copy, collapse, line-toggle, sort, preview buttons are handled by MarkdownRenderer.attachInteractivity()

    // Copy buttons inside specialized tool cards
    const copyBtn = e.target.closest('.chat-copy-btn');
    if (copyBtn) {
      e.stopPropagation();
      const b64 = copyBtn.dataset.copyB64 || '';
      let text = '';
      try { text = b64 ? decodeURIComponent(escape(window.atob(b64))) : ''; } catch (_) { text = ''; }
      if (text) {
        navigator.clipboard.writeText(text).then(() => {
          copyBtn.classList.add('copied');
          setTimeout(() => copyBtn.classList.remove('copied'), 1200);
        }).catch(() => {});
      }
      return;
    }

    const thinkingHeader = e.target.closest('.chat-thinking-header');
    if (thinkingHeader) {
      thinkingHeader.parentElement.classList.toggle('expanded');
      return;
    }

    // Question card handlers MUST be checked before .chat-perm-btn
    const optionBtn = e.target.closest('.chat-question-option');
    if (optionBtn) {
      const card = optionBtn.closest('.chat-question-card');
      const isMulti = card?.dataset.multiSelect === 'true';
      if (isMulti) {
        optionBtn.classList.toggle('selected');
      } else {
        card.querySelectorAll('.chat-question-option').forEach(b => b.classList.remove('selected'));
        optionBtn.classList.add('selected');
      }
      // Update markdown preview if present
      const group = optionBtn.closest('.chat-question-group');
      const preview = group?.querySelector('.chat-question-preview');
      if (preview && optionBtn.dataset.markdown) {
        preview.innerHTML = renderMarkdown(optionBtn.dataset.markdown);
      }
      return;
    }

    const submitBtn = e.target.closest('.chat-question-submit');
    if (submitBtn) {
      const card = submitBtn.closest('.chat-question-card');
      if (submitBtn.dataset.action === 'next') {
        handleQuestionNext(card);
      } else {
        handleQuestionSubmit(card);
      }
      return;
    }

    // Parallel suggest card: accept / decline buttons
    const parallelActionBtn = e.target.closest('[data-parallel-action]');
    if (parallelActionBtn) {
      const action = parallelActionBtn.dataset.parallelAction;
      const goal = parallelActionBtn.dataset.parallelGoal || '';
      const card = parallelActionBtn.closest('.cps-card');
      if (card) card.classList.add('cps-acted');
      if (action === 'accept' && goal) {
        setInputText('/parallel-task ' + goal);
        handleSend();
      } else if (action === 'decline' && goal) {
        setInputText(goal);
        handleSend();
      }
      return;
    }

    const planBtn = e.target.closest('.chat-plan-btn');
    if (planBtn) {
      handlePlanClick(planBtn);
      return;
    }

    const permBtn = e.target.closest('.chat-perm-btn');
    if (permBtn) {
      handlePermissionClick(permBtn);
      return;
    }

    // Open file in built-in viewer
    const openFileBtn = e.target.closest('.chat-open-file-btn');
    if (openFileBtn) {
      e.stopPropagation();
      const filePath = openFileBtn.dataset.filePath;
      if (filePath) {
        const { openFileTab } = require('./TerminalManager');
        openFileTab(filePath);
      }
      return;
    }

    // Tool group toggle
    const groupHeader = e.target.closest('.chat-tool-group-header');
    if (groupHeader && !e.target.closest('.chat-tool-card')) {
      const group = groupHeader.closest('.chat-tool-group');
      if (group) {
        group.classList.toggle('open');
        const chevron = groupHeader.querySelector('.chat-tool-group-chevron');
        if (chevron) chevron.textContent = group.classList.contains('open') ? '▾' : '▸';
      }
      return;
    }

    // Expandable tool cards
    const toolCard = e.target.closest('.chat-tool-card.expandable');
    if (toolCard) {
      toggleToolCard(toolCard);
      return;
    }

    // Image lightbox
    const clickedImage = e.target.closest('.chat-msg-image');
    if (clickedImage) {
      const container = clickedImage.closest('.chat-msg-images');
      if (container) {
        const allImages = Array.from(container.querySelectorAll('.chat-msg-image'));
        const srcs = allImages.map(img => img.src);
        const index = allImages.indexOf(clickedImage);
        openLightbox(srcs, Math.max(0, index));
      }
      return;
    }

    // Inline image lightbox
    const inlineImg = e.target.closest('.chat-inline-img');
    if (inlineImg) {
      const container = inlineImg.closest('.chat-inline-images');
      const allImgs = container ? Array.from(container.querySelectorAll('.chat-inline-img')) : [inlineImg];
      const srcs = allImgs.map(i => i.src);
      const index = allImgs.indexOf(inlineImg);
      openLightbox(srcs, Math.max(0, index));
      return;
    }
  });


  // ── Send message ──

  let sendLock = false;

  let _forceParallelTask = false;

  async function handleSend() {
    const text = getInputText().trim();
    const hasImages = pendingImages.length > 0;
    const hasMentions = pendingMentions.length > 0;
    if ((!text && !hasImages && !hasMentions) || sendLock) return;

    // /parallel-task interception: strip prefix, set force flag
    if (text === '/parallel-task' || text.startsWith('/parallel-task ')) {
      const taskDesc = text.replace(/^\/parallel-task\s*/, '').trim();
      if (!taskDesc) {
        appendSystemNotice(t('parallel.chatWidget.noTaskDescription') || 'Please provide a task description: /parallel-task <description>');
        setInputText('');
        return;
      }
      setInputText(taskDesc);
      _forceParallelTask = true;
    }

    sendLock = true;
    // Track user prompt for session recap (first 5 prompts)
    if (text && recapUserPrompts.length < 5) recapUserPrompts.push(text);
    if (project?.id) heartbeat(project.id, 'chat');
    api.telemetry?.sendFeature?.({ feature: 'chat:message', metadata: {} });

    // Reset scroll detection when user sends a message
    resetScrollDetection();

    // Snapshot images and mentions, then clear pending
    const images = hasImages ? pendingImages.splice(0) : [];
    const mentions = hasMentions ? pendingMentions.splice(0) : [];
    renderImagePreview();
    renderMentionChips();
    hideMentionDropdown();

    // Remove completed todo widget on new prompt
    if (todoWidgetEl && todoAllDone) {
      todoWidgetEl.classList.add('collapsing');
      const el = todoWidgetEl;
      todoWidgetEl = null;
      todoAllDone = false;
      setTimeout(() => el.remove(), 300);
    }

    // Clear follow-up chips when user sends a new message
    followupChips.clear();

    // Prompt enhancement via Haiku (opt-in)
    let enhancedText = text;
    let wasEnhanced = false;
    if (text && getSetting('enhancePrompts') && !text.startsWith('/')) {
      try {
        const enhanceNotice = appendSystemNotice(t('settings.enhancingPrompt') || 'Enhancing prompt...', 'command');
        const res = await api.chat.enhancePrompt({ text });
        // Remove the notice
        const noticeEl = messagesEl.querySelector('.chat-system-notice:last-of-type');
        if (noticeEl) noticeEl.remove();
        if (res?.success && res.enhanced && res.enhanced !== text) {
          enhancedText = res.enhanced;
          wasEnhanced = true;
        }
      } catch (_) { /* fallback to original */ }
    }

    const isQueued = isStreaming && sessionId;
    const userMsgUuid = crypto.randomUUID();
    appendUserMessage(enhancedText, images, mentions, isQueued, wasEnhanced ? text : null, userMsgUuid);
    if (enhancedText) conversationHistory.push({ role: 'user', content: enhancedText });
    inputEl.innerHTML = '';
    updatePlaceholderVisibility();
    inputEl.style.height = 'auto';

    if (!isStreaming) {
      turnHadAssistantContent = false;
      setStreaming(true);
      appendThinkingIndicator();
    }

    // Resolve mentions to text content
    const resolvedMentions = mentions.length > 0 ? await resolveMentions(mentions) : [];

    // Prepare images payload (without dataUrl to reduce IPC size)
    const imagesPayload = images.map(({ base64, mediaType }) => ({ base64, mediaType }));

    try {
      if (!sessionId) {
        // Assign sessionId BEFORE await to prevent race condition:
        // _processStream fires events immediately, but await returns later.
        sessionId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        if (onSessionStart) onSessionStart(sessionId);
        // Model and effort selectors stay interactive during the session
        // Changes are applied mid-session via SDK setModel/setMaxThinkingTokens
        const startOpts = {
          cwd: project.path,
          projectId: project.id,
          prompt: enhancedText || '',
          permissionMode: skipPermissions ? 'bypassPermissions' : 'default',
          sessionId,
          images: imagesPayload,
          mentions: resolvedMentions,
          model: selectedModel,
          effort: selectedEffort,
          enable1MContext: getSetting('enable1MContext') || false,
          maxTurns: getSetting('maxTurns') || null,
          userMessageUuid: userMsgUuid,
          ...(project.isCloud ? { cloud: true, cloudProjectName: project.cloudProjectName } : {}),
        };
        // Persona: optional name + custom instructions appended to claude_code preset
        const personaName = getSetting('personaName');
        const personaInstructions = getSetting('personaInstructions');
        if (personaName || personaInstructions) {
          const parts = [];
          if (personaName) parts.push(`The user's name is ${personaName}.`);
          if (personaInstructions) parts.push(personaInstructions);
          startOpts.systemPrompt = { type: 'preset', preset: 'claude_code', append: parts.join('\n\n') };
        }
        // Built-in prompt (global/project-type): appends to claude_code preset, keeps CLAUDE.md
        if (builtinSystemPrompt) {
          const existingAppend = startOpts.systemPrompt?.append || '';
          startOpts.systemPrompt = {
            ...builtinSystemPrompt,
            append: existingAppend ? existingAppend + '\n\n' + (builtinSystemPrompt.append || '') : (builtinSystemPrompt.append || '')
          };
        }
        // User-defined system prompt: merged into append, skips project/local CLAUDE.md
        if (systemPrompt) {
          const userText = typeof systemPrompt === 'string' ? systemPrompt : (systemPrompt.text || '');
          if (startOpts.systemPrompt) {
            startOpts.systemPrompt = {
              ...startOpts.systemPrompt,
              append: (startOpts.systemPrompt.append ? startOpts.systemPrompt.append + '\n\n' : '') + userText
            };
          } else {
            startOpts.systemPrompt = systemPrompt;
          }
          // Keep 'user' to load ~/.claude.json MCP config, but skip project/local CLAUDE.md
          startOpts.settingSources = ['user'];
        }

        if (pendingResumeId) {
          startOpts.resumeSessionId = pendingResumeId;
          if (pendingForkSession) {
            startOpts.forkSession = true;
          }
          if (pendingResumeAt) {
            startOpts.resumeSessionAt = pendingResumeAt;
          }
          pendingResumeId = null;
          pendingForkSession = false;
          pendingResumeAt = null;
        }
        // Force parallel task: prepend instruction to prompt
        if (_forceParallelTask) {
          const forceInstr = 'IMPORTANT: You MUST use the parallel_start_run MCP tool to decompose and execute the following task in parallel sub-tasks. Do NOT execute it sequentially. Analyze the task, identify independent sub-tasks, and start a parallel run immediately.\n\n';
          startOpts.prompt = forceInstr + (startOpts.prompt || '');
          _forceParallelTask = false;
        }
        // Stash for potential account-switch restart (preserve cwd/model/effort/etc.)
        lastStartOpts = { ...startOpts };
        const result = await api.chat.start(startOpts);
        if (!result.success) {
          sessionId = null;
          appendError(result.error || t('chat.errorOccurred'));
          setStreaming(false);
        }
      } else {
        // Force parallel task: prepend instruction to message in existing session
        let sendText = enhancedText;
        if (_forceParallelTask) {
          const forceInstr = 'IMPORTANT: You MUST use the parallel_start_run MCP tool to decompose and execute the following task in parallel sub-tasks. Do NOT execute it sequentially.\n\n';
          sendText = forceInstr + sendText;
          _forceParallelTask = false;
        }
        const result = await api.chat.send({ sessionId, text: sendText, images: imagesPayload, mentions: resolvedMentions, userMessageUuid: userMsgUuid });
        if (!result.success) {
          appendError(result.error || t('chat.errorOccurred'));
          if (!isStreaming) setStreaming(false);
        }
      }
    } catch (err) {
      appendError(err.message);
      if (!isStreaming) setStreaming(false);
    } finally {
      sendLock = false;
    }

    // Tab rename: instant truncation + async haiku polish
    if (onTabRename && !text.startsWith('/') && getSetting('aiTabNaming') !== false) {
      // Immediate: smart truncation
      const words = text.split(/\s+/).slice(0, 5).join(' ');
      onTabRename(words.length > 30 ? words.slice(0, 28) + '...' : words);
      // Async: haiku generates a proper short title
      if (!tabNamePending) {
        tabNamePending = true;
        api.chat.generateTabName({ userMessage: text }).then(res => {
          if (res?.success && res.name) onTabRename(res.name);
        }).catch(() => {}).finally(() => { tabNamePending = false; });
      }
    }
  }

  // ── Permission handling ──

  // Centralized respond helper: forwards to the SDK and clears the
  // `pendingPermission` marker on the terminal entry so MCP `tab_status`
  // and `tab_wait` reflect the resolution.
  function _respondPermission(payload) {
    try { api.chat.respondPermission(payload); } catch (_) {}
    if (terminalId) {
      try { updateTerminal(terminalId, { pendingPermission: null }); } catch (_) {}
    }
  }

  function handlePermissionClick(btn) {
    const card = btn.closest('.chat-perm-card');
    if (!card) return;
    const requestId = card.dataset.requestId;
    const action = btn.dataset.action;

    // Clear permission reminder timers
    _clearPermTimers(requestId);

    // Deny → show feedback input first
    if (action === 'deny') {
      const feedbackRow = card.querySelector('.chat-perm-feedback');
      if (feedbackRow && feedbackRow.style.display === 'none') {
        btn.classList.add('chosen');
        card.querySelectorAll('.chat-perm-btn:not(.deny)').forEach(b => {
          b.disabled = true;
          b.classList.add('disabled');
        });
        feedbackRow.style.display = '';
        feedbackRow.querySelector('.chat-perm-feedback-input')?.focus();
        return;
      }
    }

    card.querySelectorAll('.chat-perm-btn').forEach(b => {
      b.disabled = true;
      b.classList.add('disabled');
    });

    if (action === 'allow' || action === 'always-allow') {
      btn.classList.add('chosen');
      card.classList.add('resolved', 'allowed');
      const inputData = JSON.parse(card.dataset.toolInput || '{}');
      const result = { behavior: 'allow', updatedInput: inputData };
      if (action === 'always-allow') {
        // Use SDK suggestions for granular permissions (e.g. acceptEdits)
        // Fallback to bypassPermissions only if no suggestions available
        const suggestions = JSON.parse(card.dataset.suggestions || '[]');
        if (suggestions.length > 0) {
          result.updatedPermissions = suggestions;
        } else {
          result.updatedPermissions = [{
            type: 'setMode',
            mode: 'bypassPermissions',
            destination: 'session'
          }];
        }
      }
      _respondPermission({ requestId, result });
    } else {
      // deny or deny-send: include feedback message if provided
      const feedbackInput = card.querySelector('.chat-perm-feedback-input');
      const message = feedbackInput?.value?.trim() || 'User denied this action';
      card.querySelector('.chat-perm-btn.deny')?.classList.add('chosen');
      card.classList.add('resolved', 'denied');
      _respondPermission({
        requestId,
        result: { behavior: 'deny', message }
      });
    }

    // Reset status — SDK will continue processing
    setStatus('thinking', t('chat.thinking'));

    // Collapse card after resolution
    setTimeout(() => {
      card.style.maxHeight = card.scrollHeight + 'px';
      requestAnimationFrame(() => {
        card.classList.add('collapsing');
        card.style.maxHeight = '0';
      });
    }, 400);
  }

  // ── Plan handling ──

  function handlePlanClick(btn) {
    const card = btn.closest('.chat-plan-card');
    if (!card) return;
    const requestId = card.dataset.requestId;
    const action = btn.dataset.action;

    // Clear permission reminder timers
    _clearPermTimers(requestId);

    // Deny → show feedback input first
    if (action === 'deny') {
      const feedbackRow = card.querySelector('.chat-plan-feedback');
      if (feedbackRow && feedbackRow.style.display === 'none') {
        btn.classList.add('chosen');
        card.querySelectorAll('.chat-plan-btn:not(.reject)').forEach(b => {
          b.disabled = true;
          b.classList.add('disabled');
        });
        feedbackRow.style.display = '';
        feedbackRow.querySelector('.chat-plan-feedback-input')?.focus();
        return;
      }
    }

    card.querySelectorAll('.chat-plan-btn').forEach(b => {
      b.disabled = true;
      b.classList.add('disabled');
    });

    if (action === 'allow') {
      btn.classList.add('chosen');
      card.classList.add('resolved', 'approved');
      const inputData = JSON.parse(card.dataset.toolInput || '{}');
      _respondPermission({
        requestId,
        result: { behavior: 'allow', updatedInput: inputData }
      });
    } else {
      // deny or deny-send: include feedback if provided
      const feedbackInput = card.querySelector('.chat-plan-feedback-input');
      const message = feedbackInput?.value?.trim() || 'User rejected the plan';
      card.querySelector('.chat-plan-btn.reject')?.classList.add('chosen');
      card.classList.add('resolved', 'rejected');
      _respondPermission({
        requestId,
        result: { behavior: 'deny', message }
      });
    }

    // Reset status - SDK will continue processing
    setStatus('thinking', t('chat.thinking'));

    // Collapse: if ExitPlanMode with plan content, keep plan visible, only hide buttons
    const isExitPlan = card.dataset.toolName === 'ExitPlanMode' && card.querySelector('.chat-plan-content');
    if (isExitPlan) {
      setTimeout(() => {
        const actions = card.querySelector('.chat-plan-actions');
        const feedback = card.querySelector('.chat-plan-feedback');
        for (const row of [actions, feedback]) {
          if (!row) continue;
          row.style.maxHeight = row.scrollHeight + 'px';
          row.style.overflow = 'hidden';
          row.style.transition = 'max-height 0.35s ease, opacity 0.3s, padding 0.35s';
          requestAnimationFrame(() => {
            row.style.maxHeight = '0';
            row.style.opacity = '0';
            row.style.padding = '0 16px';
          });
        }
      }, 600);
    } else {
      setTimeout(() => {
        card.style.maxHeight = card.scrollHeight + 'px';
        requestAnimationFrame(() => {
          card.classList.add('collapsing');
          card.style.maxHeight = '0';
        });
      }, 600);
    }
  }

  // ── Tool card expansion ──

  async function toggleToolCard(card) {
    const existing = card.querySelector('.chat-tool-content');
    if (existing) {
      card.classList.toggle('expanded');
      return;
    }

    const inputStr = card.dataset.toolInput;
    if (!inputStr) return;

    try {
      const toolInput = JSON.parse(inputStr);
      const toolName = card.dataset.toolName || card.querySelector('.chat-tool-name')?.textContent || '';
      const output = card.dataset.toolOutput || '';
      const contentEl = document.createElement('div');
      contentEl.className = 'chat-tool-content';
      contentEl.innerHTML = await formatToolContent(toolName, toolInput, output);
      card.appendChild(contentEl);
      card.classList.add('expanded');
      scrollToBottom();
    } catch (e) { /* ignore */ }
  }

  /**
   * Find the real line number of a string in a file
   */
  async function getLineOffset(filePath, searchStr) {
    try {
      const { fs } = window.electron_nodeModules;
      const content = await fs.promises.readFile(filePath, 'utf8');
      const idx = content.indexOf(searchStr);
      if (idx === -1) return 1;
      return content.substring(0, idx).split('\n').length;
    } catch {
      return 1;
    }
  }

  function renderDiffLines(oldStr, newStr, startLine) {
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    const start = startLine || 1;
    let html = '';

    for (let i = 0; i < oldLines.length; i++) {
      html += `<div class="diff-line diff-del"><span class="diff-ln">${start + i}</span><span class="diff-sign">-</span><span class="diff-text">${escapeHtml(oldLines[i])}</span></div>`;
    }
    for (let i = 0; i < newLines.length; i++) {
      html += `<div class="diff-line diff-add"><span class="diff-ln">${start + i}</span><span class="diff-sign">+</span><span class="diff-text">${escapeHtml(newLines[i])}</span></div>`;
    }
    return html;
  }

  function renderFileLines(content, prefix, startLine) {
    const lines = content.split('\n');
    const start = startLine || 1;
    return lines.map((line, i) =>
      `<div class="diff-line${prefix === '+' ? ' diff-add' : ''}"><span class="diff-ln">${start + i}</span><span class="diff-sign">${prefix || ' '}</span><span class="diff-text">${escapeHtml(line)}</span></div>`
    ).join('');
  }

  function _openFileBtn(filePath) {
    if (!filePath) return '';
    const escaped = escapeHtml(filePath).replace(/"/g, '&quot;');
    return `<button class="chat-open-file-btn" data-file-path="${escaped}" title="${t('chat.openFile') || 'Open file'}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>`;
  }

  async function formatToolContent(toolName, input, output) {
    const name = (toolName || '').toLowerCase();

    if (name === 'write') {
      const path = input.file_path || '';
      const content = input.content || '';
      return `<div class="chat-tool-content-path">${escapeHtml(path)}</div>
        <div class="chat-diff-viewer">${renderFileLines(content, '+', 1)}</div>`;
    }

    if (name === 'edit') {
      const path = input.file_path || '';
      const oldStr = input.old_string || '';
      const newStr = input.new_string || '';
      const startLine = path ? await getLineOffset(path, oldStr) : 1;
      return `<div class="chat-tool-content-path">${escapeHtml(path)}</div>
        <div class="chat-diff-viewer">${renderDiffLines(oldStr, newStr, startLine)}</div>`;
    }

    if (name === 'bash') {
      if (output) {
        const lines = output.split('\n');
        const maxLines = 30;
        const truncated = lines.length > maxLines;
        const displayLines = truncated ? lines.slice(0, maxLines) : lines;
        return `<div class="chat-tool-output"><pre>${escapeHtml(displayLines.join('\n'))}${truncated ? `\n… (${lines.length - maxLines} more lines)` : ''}</pre></div>`;
      }
      return `<div class="chat-tool-output"><pre class="chat-tool-output-empty">${escapeHtml('(no output)')}</pre></div>`;
    }

    if (name === 'read') {
      const path = input.file_path || '';
      const offset = input.offset || 1;
      const limit = input.limit || '';
      const rangeInfo = limit ? `lines ${offset}–${offset + parseInt(limit, 10) - 1}` : (offset > 1 ? `from line ${offset}` : '');

      const ext = path.split('.').pop().toLowerCase();
      const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
      const BINARY_EXTS = new Set(['pdf', 'zip', 'gz', 'tar', 'rar', '7z', 'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'db', 'sqlite', 'wasm', 'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'ogg', 'ttf', 'otf', 'woff', 'woff2']);

      if (IMAGE_EXTS.has(ext) && path) {
        const fileUrl = 'file:///' + path.replace(/\\/g, '/');
        return `<div class="chat-tool-content-path">${escapeHtml(path)} ${_openFileBtn(path)}</div>
          <div class="chat-inline-images"><div class="chat-inline-img-wrap"><img src="${fileUrl}" class="chat-inline-img" alt="${escapeHtml(path)}" loading="lazy"></div></div>`;
      }

      if (BINARY_EXTS.has(ext)) {
        return `<div class="chat-tool-content-path">${escapeHtml(path)} <span class="chat-tool-content-meta">(fichier binaire)</span> ${_openFileBtn(path)}</div>`;
      }

      let effectiveOutput = output;
      // If no output stored (live streaming), read file directly
      if (!effectiveOutput && path) {
        try {
          const { fs } = window.electron_nodeModules;
          const raw = await fs.promises.readFile(path, 'utf8');
          const allLines = raw.split('\n');
          const start = Math.max(0, (parseInt(offset, 10) || 1) - 1);
          const end = limit ? start + parseInt(limit, 10) : allLines.length;
          effectiveOutput = allLines.slice(start, end)
            .map((l, i) => `${String(start + i + 1).padStart(6)}→${l}`)
            .join('\n');
        } catch { /* file not readable, ignore */ }
      }

      if (effectiveOutput) {
        const catFormat = /^\s*(\d+)→(.*)$/;
        const parsed = effectiveOutput.split('\n').map((line, i) => {
          const m = line.match(catFormat);
          return m ? { num: parseInt(m[1], 10), content: m[2] } : { num: (parseInt(offset, 10) || 1) + i, content: line };
        });
        const maxLines = 80;
        const truncated = parsed.length > maxLines;
        const display = parsed.slice(0, maxLines);
        const plainText = display.map(l => l.content).join('\n');
        const highlightedText = highlight(plainText, ext);
        const highlightedLines = highlightedText.split('\n');
        const linesHtml = display.map((l, i) =>
          `<div class="diff-line"><span class="diff-ln">${l.num}</span><span class="diff-sign"> </span><span class="diff-text">${highlightedLines[i] ?? ''}</span></div>`
        ).join('');
        return `<div class="chat-tool-content-path">${escapeHtml(path)}${rangeInfo ? ` <span class="chat-tool-content-meta">(${rangeInfo})</span>` : ''} <span class="chat-tool-content-meta">${parsed.length} lines</span> ${_openFileBtn(path)}</div>
          <div class="chat-diff-viewer">${linesHtml}${truncated ? `<div class="diff-line diff-truncated"><span class="diff-ln"></span><span class="diff-sign"> </span><span class="diff-text">… (${parsed.length - maxLines} more lines)</span></div>` : ''}</div>`;
      }
      return `<div class="chat-tool-content-path">${escapeHtml(path)}${rangeInfo ? ` <span class="chat-tool-content-meta">(${rangeInfo})</span>` : ''} ${_openFileBtn(path)}</div>`;
    }

    if (name === 'glob' || name === 'grep') {
      if (output) {
        const lines = output.split('\n');
        const maxLines = 30;
        const truncated = lines.length > maxLines;
        const displayLines = truncated ? lines.slice(0, maxLines) : lines;
        return `<div class="chat-tool-output"><pre>${escapeHtml(displayLines.join('\n'))}${truncated ? `\n… (${lines.length - maxLines} more lines)` : ''}</pre></div>`;
      }
      return `<div class="chat-tool-content-path">${escapeHtml(input.file_path || input.pattern || input.path || '')}</div>`;
    }

    // Generic: show output if available, otherwise show input JSON
    if (output) {
      return `<div class="chat-tool-output"><pre>${escapeHtml(output)}</pre></div>`;
    }
    return `<div class="chat-diff-viewer">${renderFileLines(JSON.stringify(input, null, 2), '', 1)}</div>`;
  }

  /**
   * Collect the answer from the currently visible question group
   */
  function collectCurrentAnswer(card) {
    const questions = JSON.parse(card.dataset.questions || '[]');
    const step = parseInt(card.dataset.currentStep, 10);
    const group = card.querySelector(`.chat-question-group[data-step="${step}"]`);
    if (!group || !questions[step]) return null;

    const q = questions[step];
    const selected = group.querySelectorAll('.chat-question-option.selected');
    const customInput = group.querySelector('.chat-question-custom-input');

    if (customInput && customInput.value.trim()) {
      return { question: q.question, answer: customInput.value.trim() };
    } else if (selected.length > 0) {
      return { question: q.question, answer: Array.from(selected).map(s => s.dataset.label).join(', ') };
    }
    return { question: q.question, answer: q.options[0]?.label || '' };
  }

  /**
   * Advance to the next question in a multi-step question card
   */
  function handleQuestionNext(card) {
    if (!card) return;
    const questions = JSON.parse(card.dataset.questions || '[]');
    const currentStep = parseInt(card.dataset.currentStep, 10);
    const totalSteps = questions.length;
    const collected = JSON.parse(card.dataset.collectedAnswers || '{}');

    // Save current answer
    const result = collectCurrentAnswer(card);
    if (result) collected[result.question] = result.answer;
    card.dataset.collectedAnswers = JSON.stringify(collected);

    // Transition: hide current, show next
    const currentGroup = card.querySelector(`.chat-question-group[data-step="${currentStep}"]`);
    const nextStep = currentStep + 1;
    const nextGroup = card.querySelector(`.chat-question-group[data-step="${nextStep}"]`);

    if (currentGroup) currentGroup.classList.remove('active');
    if (nextGroup) nextGroup.classList.add('active');

    card.dataset.currentStep = String(nextStep);

    // Update step counter
    const stepEl = card.querySelector('.chat-question-step');
    if (stepEl) stepEl.textContent = `${nextStep + 1} / ${totalSteps}`;

    // Update button for last step
    const btn = card.querySelector('.chat-question-submit');
    if (nextStep >= totalSteps - 1) {
      btn.dataset.action = 'submit';
      btn.textContent = t('chat.submit') || 'Submit';
    }

    scrollToBottom();
  }

  function handleQuestionSubmit(card) {
    if (!card) return;
    const requestId = card.dataset.requestId;
    const questionsData = JSON.parse(card.dataset.questions || '[]');
    const answers = JSON.parse(card.dataset.collectedAnswers || '{}');

    // Collect the current (last) question's answer
    const result = collectCurrentAnswer(card);
    if (result) answers[result.question] = result.answer;

    // Collapse card into compact answered summary showing each Q&A pair
    const answerEntries = Object.entries(answers);

    const pairsHtml = answerEntries.map(([question, answer]) =>
      `<div class="chat-qa-pair">
        <span class="chat-qa-question">${escapeHtml(question)}</span>
        <span class="chat-qa-answer">${escapeHtml(answer)}</span>
      </div>`
    ).join('');

    card.classList.add('resolved');
    card.innerHTML = `
      <div class="chat-question-header resolved">
        <div class="chat-perm-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        </div>
        <span>${escapeHtml(t('chat.questionAnswered') || 'Answered')}</span>
      </div>
      <div class="chat-qa-summary">${pairsHtml}</div>
    `;

    _respondPermission({
      requestId,
      result: {
        behavior: 'allow',
        updatedInput: { questions: questionsData, answers }
      }
    });

    // Reset status — SDK will continue processing
    setStatus('thinking', t('chat.thinking'));
  }

  // ── DOM helpers ──

  function appendUserMessage(text, images = [], mentions = [], queued = false, originalText = null, uuid = null) {
    const welcome = messagesEl.querySelector('.chat-welcome');
    if (welcome) welcome.remove();
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-user';
    if (queued) el.classList.add('queued');
    if (uuid) el.dataset.userMessageUuid = uuid;
    let html = '';
    if (queued) {
      html += `<span class="chat-msg-queued-badge">${escapeHtml(t('chat.queued') || 'Queued')}</span>`;
    }
    if (originalText) {
      html += `<span class="chat-msg-enhanced-badge" title="${escapeHtml(originalText)}">${escapeHtml(t('settings.promptEnhanced') || 'Enhanced')}</span>`;
    }
    if (mentions.length > 0) {
      html += `<div class="chat-msg-mentions">${mentions.map(m => {
        const tagColorRaw = (m.type === 'project' && m.data?.color) ? m.data.color : '';
        const tagColor = sanitizeColor(tagColorRaw);
        const tagStyle = tagColor ? ` style="--chip-color: ${tagColor}"` : '';
        return `<span class="chat-msg-mention-tag${tagColor ? ' has-project-color' : ''}"${tagStyle}>${m.icon}<span>${escapeHtml(m.label)}</span></span>`;
      }).join('')}</div>`;
    }
    if (images.length > 0) {
      html += `<div class="chat-msg-images">${images.map(img =>
        `<img src="${img.dataUrl}" alt="${escapeHtml(img.name || 'image')}" class="chat-msg-image" />`
      ).join('')}</div>`;
    }
    if (originalText) {
      html += `<div class="chat-msg-original" style="display:none"><div class="chat-msg-original-label">${escapeHtml(t('settings.originalPrompt') || 'Original prompt')}</div><div class="chat-msg-content">${renderMarkdown(originalText)}</div></div>`;
    }
    if (text) {
      html += `<div class="chat-msg-content">${renderMarkdown(text)}</div>`;
    }
    el.innerHTML = html;
    // Toggle original prompt visibility on badge click
    const badge = el.querySelector('.chat-msg-enhanced-badge');
    const originalBlock = el.querySelector('.chat-msg-original');
    if (badge && originalBlock) {
      badge.style.cursor = 'pointer';
      badge.addEventListener('click', () => {
        originalBlock.style.display = originalBlock.style.display === 'none' ? '' : 'none';
      });
    }
    // Add rewind button for live sessions (undo file changes from this point)
    if (uuid && sessionId && !queued) {
      const rewindBtn = document.createElement('button');
      rewindBtn.className = 'chat-msg-rewind-btn';
      rewindBtn.title = t('chat.rewindFiles') || 'Rewind files to here';
      rewindBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
      rewindBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleRewindFiles(uuid, rewindBtn);
      });
      el.appendChild(rewindBtn);
    }
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function appendError(text) {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-error';
    el.innerHTML = `<div class="chat-error-content">${escapeHtml(text)}</div>`;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function appendSystemNotice(text, icon = 'info') {
    const icons = {
      info: '&#8505;',      // ℹ
      compact: '&#9879;',   // ⚗
      clear: '&#10227;',    // ↻
      command: '&#9889;',   // ⚡
    };
    const el = document.createElement('div');
    el.className = 'chat-system-notice';
    el.innerHTML = `<span class="chat-system-notice-icon">${icons[icon] || icons.info}</span><span class="chat-system-notice-text">${escapeHtml(text)}</span>`;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function appendThinkingIndicator() {
    removeThinkingIndicator();
    const el = document.createElement('div');
    el.className = 'chat-thinking-indicator';
    el.innerHTML = `
      <img class="chat-thinking-logo" src="assets/claude-mascot.svg" alt="" draggable="false" />
      <span class="chat-thinking-label">${escapeHtml(t('chat.thinking'))}</span>
    `;
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function removeThinkingIndicator() {
    const indicator = messagesEl.querySelector('.chat-thinking-indicator');
    if (indicator) indicator.remove();
  }

  function appendCompactingIndicator() {
    removeCompactingIndicator();
    removeThinkingIndicator();
    const el = document.createElement('div');
    el.className = 'chat-compacting-indicator';
    el.innerHTML = `
      <span class="chat-compacting-icon">&#9879;</span>
      <span class="chat-compacting-label">${escapeHtml(t('chat.compacting') || 'Compacting conversation...')}</span>
    `;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function removeCompactingIndicator() {
    const indicator = messagesEl.querySelector('.chat-compacting-indicator');
    if (indicator) indicator.remove();
  }

  let _streamCache = null;

  function startStreamBlock() {
    removeThinkingIndicator();
    // Cancel any pending RAF from a previous block to avoid stale renders
    if (_streamRafId) { cancelAnimationFrame(_streamRafId); _streamRafId = null; }
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-assistant';
    el.innerHTML = `<div class="chat-msg-content"><span class="chat-cursor"></span></div>`;
    messagesEl.appendChild(el);
    scrollToBottom();
    currentStreamEl = el.querySelector('.chat-msg-content');
    currentStreamText = '';
    _streamCache = MarkdownRenderer.createStreamCache();
    currentAssistantMsgEl = el;
    return el;
  }

  let _streamRafId = null;
  function appendStreamDelta(text) {
    currentStreamText += text;
    if (currentStreamEl && !_streamRafId) {
      _streamRafId = requestAnimationFrame(() => {
        _streamRafId = null;
        if (currentStreamEl) {
          // Use incremental rendering: only re-render the last block
          MarkdownRenderer.renderIncremental(currentStreamText, currentStreamEl, _streamCache);
          scrollToBottom();
        }
      });
    }
  }

  const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);
  const IMG_PATH_RE = /([A-Za-z]:[\\\/][^\s"'<>|?*\x00-\x1f\n\r]+|\/[^\s"'<>|?*\x00-\x1f\n\r]+)\.([a-zA-Z]{2,5})(?=[\s,;:!?)"'\]]|$)/g;

  function injectInlineImages(container) {
    const text = container.textContent;
    const paths = [];
    const seen = new Set();
    IMG_PATH_RE.lastIndex = 0;
    let m;
    while ((m = IMG_PATH_RE.exec(text)) !== null) {
      const ext = m[2].toLowerCase();
      if (IMG_EXTS.has(ext)) {
        const fullPath = m[0].replace(/[.,;:!?]$/, '');
        if (!seen.has(fullPath)) { seen.add(fullPath); paths.push(fullPath); }
      }
    }
    if (paths.length === 0) return;
    const wrap = document.createElement('div');
    wrap.className = 'chat-inline-images';
    paths.forEach(p => {
      const fileUrl = 'file:///' + p.replace(/\\/g, '/').replace(/^\/\//, '/');
      const imgWrap = document.createElement('div');
      imgWrap.className = 'chat-inline-img-wrap';
      imgWrap.innerHTML = `<img src="${fileUrl}" class="chat-inline-img" alt="${escapeHtml(p)}" loading="lazy">`;
      imgWrap.querySelector('img').onerror = () => imgWrap.remove();
      wrap.appendChild(imgWrap);
    });
    container.appendChild(wrap);
  }

  function finalizeStreamBlock() {
    // Cancel any pending incremental render RAF
    if (_streamRafId) { cancelAnimationFrame(_streamRafId); _streamRafId = null; }
    if (currentStreamEl && currentStreamText) {
      // Full re-render on finalization for consistency (no stable/active split)
      try {
        const rendered = renderMarkdown(currentStreamText);
        currentStreamEl.innerHTML = rendered;
      } catch (err) {
        console.error('[ChatView] Markdown render failed on finalize:', err.message);
        currentStreamEl.innerHTML = `<pre style="white-space:pre-wrap;word-break:break-word">${escapeHtml(currentStreamText)}</pre>`;
      }
      injectInlineImages(currentStreamEl);
      MarkdownRenderer.postProcess(currentStreamEl);
    }
    if (currentStreamText) conversationHistory.push({ role: 'assistant', content: currentStreamText });
    currentStreamEl = null;
    currentStreamText = '';
    _streamCache = null;
  }

  function applyToolColor(el, toolName) {
    const colors = getSetting('agentColors') || {};
    let color = colors[toolName];
    // For MCP tools like "mcp__server__tool", match by server name prefix
    if (!color && toolName.startsWith('mcp__')) {
      const serverName = toolName.split('__')[1];
      color = colors[serverName];
    }
    if (color) {
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      el.style.setProperty('--accent-color', color);
      el.style.setProperty('--accent-color-rgb', `${r}, ${g}, ${b}`);
    }
  }

  // ── Tool group helpers ──

  function _makeToolCard(toolName, truncated) {
    const el = document.createElement('div');
    el.className = 'chat-tool-card';
    el.dataset.toolName = toolName;
    el.title = toolName;
    el.innerHTML = `
      <div class="chat-tool-icon">${getToolIcon(toolName)}</div>
      <div class="chat-tool-info">
        <span class="chat-tool-name">${formatToolName(toolName)}</span>
        <span class="chat-tool-detail">${truncated ? escapeHtml(truncated) : ''}</span>
      </div>
      <div class="chat-tool-status running"><div class="chat-tool-spinner"></div></div>
    `;
    applyToolColor(el, toolName);
    return el;
  }

  function _makeToolGroup(toolName) {
    const group = document.createElement('div');
    group.className = 'chat-tool-group';
    group.dataset.toolName = toolName;
    group.title = toolName;
    group.innerHTML = `
      <div class="chat-tool-group-header">
        <div class="chat-tool-icon">${getToolIcon(toolName)}</div>
        <div class="chat-tool-info">
          <span class="chat-tool-name">${formatToolName(toolName)}</span>
          <span class="chat-tool-group-badge">×2</span>
        </div>
        <div class="chat-tool-group-status running"><div class="chat-tool-spinner"></div></div>
        <div class="chat-tool-group-chevron">▸</div>
      </div>
      <div class="chat-tool-group-items"></div>
    `;
    applyToolColor(group, toolName);
    return group;
  }

  function _updateGroupBadge(group) {
    const count = group.querySelector('.chat-tool-group-items').childElementCount;
    const badge = group.querySelector('.chat-tool-group-badge');
    if (badge) badge.textContent = `×${count}`;
  }

  function appendToolCard(toolName, detail) {
    const truncated = detail && detail.length > 80 ? '...' + detail.slice(-77) : (detail || '');
    const last = messagesEl.lastElementChild;

    // Add to existing group for same tool
    if (last?.classList.contains('chat-tool-group') && last.dataset.toolName === toolName) {
      const card = _makeToolCard(toolName, truncated);
      last.querySelector('.chat-tool-group-items').appendChild(card);
      _updateGroupBadge(last);
      scrollToBottom();
      return card;
    }

    // Convert previous lone card + new card into a group
    if (last?.classList.contains('chat-tool-card') &&
        !last.classList.contains('history') &&
        last.dataset.toolName === toolName) {
      const group = _makeToolGroup(toolName);
      const items = group.querySelector('.chat-tool-group-items');
      last.replaceWith(group);
      items.appendChild(last);
      const card = _makeToolCard(toolName, truncated);
      items.appendChild(card);
      _updateGroupBadge(group);
      scrollToBottom();
      return card;
    }

    // Normal lone card
    const el = _makeToolCard(toolName, truncated);
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function completeToolCard(el) {
    if (!el) return;
    const status = el.querySelector('.chat-tool-status');
    if (status) {
      status.classList.remove('running');
      status.classList.add('complete');
      status.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
    }
    // If inside a group, check if all items are done → mark group complete
    const group = el.closest('.chat-tool-group');
    if (group) {
      const cards = group.querySelectorAll('.chat-tool-group-items > .chat-tool-card');
      const allComplete = [...cards].every(c => c.querySelector('.chat-tool-status.complete'));
      if (allComplete) {
        const gs = group.querySelector('.chat-tool-group-status');
        if (gs) {
          gs.classList.remove('running');
          gs.classList.add('complete');
          gs.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
        }
      }
    }
  }

  // ── Subagent (Task tool) card ──

  function appendSubagentCard() {
    const el = document.createElement('div');
    el.className = 'chat-subagent-card';
    el.innerHTML = `
      <div class="chat-subagent-header">
        <div class="chat-subagent-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/>
            <path d="M6 21V9a9 9 0 0 0 9 9"/>
          </svg>
        </div>
        <div class="chat-subagent-info">
          <span class="chat-subagent-type">${escapeHtml(t('chat.subagentLaunching') || 'Launching agent...')}</span>
          <span class="chat-subagent-desc"></span>
        </div>
        <span class="chat-subagent-activity"></span>
        <div class="chat-subagent-status running"><div class="chat-tool-spinner"></div></div>
        <svg class="chat-subagent-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </div>
      <div class="chat-subagent-body"></div>
    `;

    // Click header to expand/collapse body
    el.querySelector('.chat-subagent-header').addEventListener('click', () => {
      el.classList.toggle('expanded');
    });

    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function updateSubagentCard(el, input) {
    if (!el || !input) return;
    const typeEl = el.querySelector('.chat-subagent-type');
    const name = input.name || input.subagent_type || 'agent';
    const desc = input.description || '';
    if (typeEl) typeEl.textContent = name;
    const descEl = el.querySelector('.chat-subagent-desc');
    if (descEl && desc) descEl.textContent = desc;
  }

  function completeSubagentCard(el, stats = null) {
    if (!el) return;
    const status = el.querySelector('.chat-subagent-status');
    if (status) {
      status.classList.remove('running');
      status.classList.add('complete');
      status.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
    }
    el.classList.add('done');
    // Mark all remaining mini-tools as complete
    el.querySelectorAll('.sa-tool-status:not(.complete)').forEach(s => {
      s.classList.add('complete');
      s.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
    });
    // Clear live activity text
    const activityEl = el.querySelector('.chat-subagent-activity');
    if (activityEl) activityEl.textContent = '';
    // Render stats footer (Agent tool result: totalToolUseCount, totalDurationMs, totalTokens)
    if (stats && !el.querySelector('.chat-subagent-stats')) {
      const parts = [];
      if (typeof stats.totalToolUseCount === 'number') {
        parts.push(`<span class="sa-stat"><span class="sa-stat-num">${stats.totalToolUseCount}</span> tool${stats.totalToolUseCount === 1 ? '' : 's'}</span>`);
      }
      if (typeof stats.totalDurationMs === 'number') {
        const secs = Math.round(stats.totalDurationMs / 1000);
        parts.push(`<span class="sa-stat"><span class="sa-stat-num">${escapeHtml(fmtDur(secs))}</span></span>`);
      }
      if (typeof stats.totalTokens === 'number') {
        const k = stats.totalTokens >= 1000 ? (stats.totalTokens / 1000).toFixed(1) + 'k' : String(stats.totalTokens);
        parts.push(`<span class="sa-stat"><span class="sa-stat-num">${escapeHtml(k)}</span> tokens</span>`);
      }
      if (parts.length) {
        const footer = document.createElement('div');
        footer.className = 'chat-subagent-stats';
        footer.innerHTML = parts.join('');
        el.appendChild(footer);
      }
    }
  }

  /**
   * Find the subagent info by parent_tool_use_id
   */
  function findSubagentByParentId(parentToolUseId) {
    for (const [, info] of taskToolIndices) {
      if (info.toolUseId === parentToolUseId) return info;
    }
    return null;
  }

  // ── Parallel Run Widget (inline live status) ──────────────────────────────

  function _createParallelWidget(goal, toolUseId) {
    const { parallelTaskState, getRunById, initParallelListeners } = require('../../state/parallelTask.state');
    initParallelListeners();

    const el = document.createElement('div');
    el.className = 'chat-parallel-widget';
    el.dataset.phase = 'waiting';

    let _runId = null;
    let _unsubscribe = null;
    let _destroyed = false;

    // SVG icons
    const PHASE_ICONS = {
      decomposing: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
      reviewing: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
      'creating-worktrees': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
      running: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
      done: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>',
      merged: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 009 9"/></svg>',
      failed: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
      cancelled: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
    };

    const TASK_STATUS_ICONS = {
      pending: '<span class="cpw-task-dot pending"></span>',
      creating: '<span class="cpw-task-dot creating"></span>',
      running: '<div class="chat-tool-spinner" style="width:12px;height:12px"></div>',
      done: '<svg width="12" height="12" viewBox="0 0 24 24" fill="var(--success)" stroke="none"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
      failed: '<svg width="12" height="12" viewBox="0 0 24 24" fill="var(--danger)" stroke="none"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
      cancelled: '<svg width="12" height="12" viewBox="0 0 24 24" fill="var(--text-muted)" stroke="none"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>',
    };

    function _phaseLabel(phase) {
      const labels = {
        decomposing: t('parallel.chatWidget.phaseDecomposing') || 'Analyzing...',
        reviewing: t('parallel.chatWidget.phaseReviewing') || 'Waiting for review',
        'creating-worktrees': t('parallel.chatWidget.phaseCreating') || 'Setting up...',
        running: t('parallel.chatWidget.phaseRunning') || 'Running',
        done: t('parallel.chatWidget.phaseDone') || 'Completed',
        merged: t('parallel.chatWidget.phaseMerged') || 'Merged',
        failed: t('parallel.chatWidget.phaseFailed') || 'Failed',
        cancelled: t('parallel.chatWidget.phaseCancelled') || 'Cancelled',
        merging: t('parallel.chatWidget.phaseMerging') || 'Merging...',
      };
      return labels[phase] || phase;
    }

    // Initial waiting state
    el.innerHTML = `
      <div class="cpw-header">
        <div class="cpw-icon">${PHASE_ICONS.decomposing}</div>
        <div class="cpw-title">
          <span class="cpw-goal">${escapeHtml(goal)}</span>
          <span class="cpw-phase">${escapeHtml(t('parallel.chatWidget.starting') || 'Starting parallel run...')}</span>
        </div>
        <div class="cpw-status"><div class="chat-tool-spinner"></div></div>
      </div>
      <div class="cpw-progress-wrap" style="display:none"><div class="cpw-progress-bar"></div></div>
      <div class="cpw-body"></div>
      <div class="cpw-actions"></div>
    `;

    function _bindToRun() {
      _unsubscribe = parallelTaskState.subscribe(() => {
        if (_destroyed) return;
        if (!_runId) {
          const runs = parallelTaskState.get().runs;
          const match = runs.find(r => r.goal === goal && !parallelRunWidgets.has(r.id));
          if (match) {
            _runId = match.id;
            el.dataset.runId = match.id;
            parallelRunWidgets.set(match.id, { el, cleanup: _destroy, toolUseId });
            parallelPendingWidgets.delete(toolUseId);
            _updateFromRun(match);
          }
        } else {
          const run = getRunById(_runId);
          if (run) _updateFromRun(run);
        }
      });

      // Check existing runs immediately (handles race: IPC before widget)
      const runs = parallelTaskState.get().runs;
      const existing = runs.find(r => r.goal === goal && !parallelRunWidgets.has(r.id));
      if (existing) {
        _runId = existing.id;
        el.dataset.runId = existing.id;
        parallelRunWidgets.set(existing.id, { el, cleanup: _destroy, toolUseId });
        parallelPendingWidgets.delete(toolUseId);
        _updateFromRun(existing);
      }
    }

    function _setError(message) {
      if (_destroyed) return;
      el.dataset.phase = 'failed';
      const iconEl = el.querySelector('.cpw-icon');
      const phaseEl = el.querySelector('.cpw-phase');
      const statusEl = el.querySelector('.cpw-status');
      const bodyEl = el.querySelector('.cpw-body');
      const actionsEl = el.querySelector('.cpw-actions');
      if (iconEl) iconEl.innerHTML = PHASE_ICONS.failed;
      if (phaseEl) phaseEl.textContent = t('parallel.chatWidget.phaseFailed') || 'Failed';
      if (statusEl) statusEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="var(--danger)"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
      if (bodyEl && message) {
        bodyEl.innerHTML = `<div class="cpw-error">${escapeHtml(message)}</div>`;
      }
      if (actionsEl) actionsEl.innerHTML = '';
      if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
      parallelPendingWidgets.delete(toolUseId);
    }

    function _updateFromRun(run) {
      el.dataset.phase = run.phase || 'waiting';

      const iconEl = el.querySelector('.cpw-icon');
      const phaseEl = el.querySelector('.cpw-phase');
      const statusEl = el.querySelector('.cpw-status');
      if (iconEl) iconEl.innerHTML = PHASE_ICONS[run.phase] || PHASE_ICONS.decomposing;
      if (phaseEl) phaseEl.textContent = _phaseLabel(run.phase);

      const isActive = ['decomposing', 'reviewing', 'creating-worktrees', 'running', 'merging'].includes(run.phase);
      if (statusEl) {
        if (isActive) {
          statusEl.innerHTML = '<div class="chat-tool-spinner"></div>';
        } else if (run.phase === 'done' || run.phase === 'merged') {
          statusEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="var(--success)"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
        } else {
          statusEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="var(--danger)"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
        }
      }

      if (run.featureName) {
        const goalEl = el.querySelector('.cpw-goal');
        if (goalEl && !goalEl.dataset.updated) {
          goalEl.dataset.updated = '1';
          goalEl.textContent = run.featureName + ' - ' + goal;
        }
      }

      _updateProgress(run);
      _updateTaskList(run);
      _updateActions(run);
    }

    function _updateProgress(run) {
      const wrap = el.querySelector('.cpw-progress-wrap');
      const bar = el.querySelector('.cpw-progress-bar');
      if (!wrap || !bar) return;

      const tasks = run.tasks || [];
      if (tasks.length === 0 || ['decomposing', 'reviewing'].includes(run.phase)) {
        wrap.style.display = 'none';
        return;
      }
      wrap.style.display = '';
      const done = tasks.filter(tk => tk.status === 'done').length;
      const failed = tasks.filter(tk => tk.status === 'failed').length;
      const pct = tasks.length > 0 ? ((done + failed) / tasks.length) * 100 : 0;
      bar.style.width = pct + '%';
      bar.className = 'cpw-progress-bar' + (failed > 0 ? ' has-failures' : '');
    }

    function _updateTaskList(run) {
      const body = el.querySelector('.cpw-body');
      if (!body) return;

      const tasks = run.tasks || [];
      if (tasks.length === 0) { body.innerHTML = ''; return; }

      for (const task of tasks) {
        let taskEl = body.querySelector(`[data-task-id="${task.id}"]`);
        if (!taskEl) {
          taskEl = document.createElement('div');
          taskEl.className = 'cpw-task';
          taskEl.dataset.taskId = task.id;
          taskEl.innerHTML = '<span class="cpw-task-status"></span><span class="cpw-task-title"></span><span class="cpw-task-branch"></span><pre class="cpw-task-output"></pre>';
          body.appendChild(taskEl);
        }

        const statusSpan = taskEl.querySelector('.cpw-task-status');
        if (statusSpan) statusSpan.innerHTML = TASK_STATUS_ICONS[task.status] || TASK_STATUS_ICONS.pending;

        const titleSpan = taskEl.querySelector('.cpw-task-title');
        if (titleSpan && titleSpan.textContent !== (task.title || task.id)) titleSpan.textContent = task.title || task.id;

        const branchSpan = taskEl.querySelector('.cpw-task-branch');
        if (branchSpan) {
          if (task.branch) {
            branchSpan.textContent = task.branch.replace(/^parallel\/[^/]+\//, '');
            branchSpan.style.display = '';
          } else {
            branchSpan.style.display = 'none';
          }
        }

        const outputPre = taskEl.querySelector('.cpw-task-output');
        if (outputPre) {
          if (task.status === 'running' && task.output) {
            const lines = task.output.trim().split('\n');
            outputPre.textContent = lines.slice(-3).join('\n');
            outputPre.style.display = '';
          } else {
            outputPre.style.display = 'none';
          }
        }

        taskEl.className = 'cpw-task' + (task.status ? ` status-${task.status}` : '');
      }
    }

    function _updateActions(run) {
      const actionsEl = el.querySelector('.cpw-actions');
      if (!actionsEl) return;

      const btns = [];
      btns.push(`<button class="cpw-btn cpw-btn-view" data-action="view">${escapeHtml(t('parallel.chatWidget.viewInPanel') || 'View in Tasks')}</button>`);

      if (['decomposing', 'reviewing', 'creating-worktrees', 'running'].includes(run.phase)) {
        btns.push(`<button class="cpw-btn cpw-btn-cancel" data-action="cancel">${escapeHtml(t('parallel.chatWidget.cancelRun') || 'Cancel')}</button>`);
      }
      if (run.phase === 'done') {
        const doneTasks = (run.tasks || []).filter(tk => tk.status === 'done');
        if (doneTasks.length > 0) {
          btns.push(`<button class="cpw-btn cpw-btn-merge" data-action="merge">${escapeHtml(t('parallel.chatWidget.mergeRun') || 'Merge')}</button>`);
        }
      }

      const newHtml = btns.join('');
      if (actionsEl.innerHTML !== newHtml) actionsEl.innerHTML = newHtml;
    }

    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || !_runId) return;
      const action = btn.dataset.action;
      if (action === 'view') {
        const tab = document.querySelector('.nav-tab[data-tab="tasks"]');
        if (tab) tab.click();
      } else if (action === 'cancel') {
        window.electron_api?.parallel?.cancelRun({ runId: _runId });
      } else if (action === 'merge') {
        window.electron_api?.parallel?.mergeRun({ runId: _runId });
      }
    });

    function _destroy() {
      _destroyed = true;
      if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
      if (_runId) parallelRunWidgets.delete(_runId);
      parallelPendingWidgets.delete(toolUseId);
    }

    _bindToRun();
    return { el, cleanup: _destroy, toolUseId, setError: _setError };
  }

  /**
   * Route a message from a subagent to the appropriate handler
   */
  function handleSubagentMessage(info, message) {
    // Ignore late messages for already-completed subagents
    if (info.completed) return;

    if (message.type === 'stream_event' && message.event) {
      handleSubagentStreamEvent(info, message.event);
      return;
    }
    if (message.type === 'assistant') {
      handleSubagentAssistant(info, message);
      return;
    }
    // User messages inside a subagent carry tool_result blocks for the
    // subagent's own sub-tools — mark the matching mini-tool complete.
    if (message.type === 'user') {
      handleSubagentAssistant(info, message);
      return;
    }
    // Subagent finished — mark card as done individually
    if (message.type === 'result') {
      completeSubagentCard(info.card);
      // Mark as completed but keep in taskToolIndices so late-arriving
      // messages with the same parent_tool_use_id are still routed here
      // (silently ignored) instead of leaking into the main chat.
      // Cleanup happens on chat-done / chat-error.
      info.completed = true;
      return;
    }
  }

  /**
   * Handle stream events from a subagent (tool calls, text deltas)
   */
  function handleSubagentStreamEvent(info, event) {
    switch (event.type) {
      case 'message_start':
        info.subBlockIndex = 0;
        break;

      case 'content_block_start': {
        const block = event.content_block;
        if (!block) break;
        const blockIdx = event.index ?? info.subBlockIndex;

        if (block.type === 'tool_use' && block.name !== 'TodoWrite') {
          // Add mini tool entry in the subagent body
          const mini = document.createElement('div');
          mini.className = 'sa-tool';
          mini.dataset.toolName = block.name;
          mini.title = block.name;
          if (block.id) mini.dataset.toolUseId = block.id;
          mini.innerHTML = `
            <div class="sa-tool-icon">${getToolIcon(block.name)}</div>
            <span class="sa-tool-name">${formatToolName(block.name)}</span>
            <span class="sa-tool-detail"></span>
            <div class="sa-tool-status"><div class="chat-tool-spinner"></div></div>
          `;
          info.bodyEl.appendChild(mini);
          info.subTools.set(blockIdx, mini);
          info.subBuffers.set(blockIdx, '');

          // Update live activity in header
          info.activityEl.textContent = `${block.name}...`;

          // Auto-expand on first tool
          if (info.subTools.size === 1) {
            info.card.classList.add('expanded');
          }
        }
        info.subBlockIndex++;
        break;
      }

      case 'content_block_delta': {
        const delta = event.delta;
        if (!delta) break;

        if (delta.type === 'input_json_delta') {
          const idx = event.index ?? (info.subBlockIndex - 1);
          const buf = info.subBuffers.get(idx);
          if (buf !== undefined) {
            info.subBuffers.set(idx, buf + (delta.partial_json || ''));
          }
        }
        break;
      }

      case 'content_block_stop': {
        const stopIdx = event.index ?? (info.subBlockIndex - 1);
        const jsonStr = info.subBuffers.get(stopIdx);
        const mini = info.subTools.get(stopIdx);

        if (mini) {
          if (jsonStr) {
            info.subBuffers.delete(stopIdx);
            try {
              const toolInput = JSON.parse(jsonStr);
              const name = mini.dataset.toolName || mini.querySelector('.sa-tool-name')?.textContent || '';
              const detail = getToolDisplayInfo(name, toolInput);
              const detailEl = mini.querySelector('.sa-tool-detail');
              if (detailEl && detail) {
                detailEl.textContent = detail.length > 60 ? '...' + detail.slice(-57) : detail;
              }
            } catch (e) { /* partial JSON */ }
          }

          // Mark mini tool as complete
          const statusEl = mini.querySelector('.sa-tool-status');
          if (statusEl) {
            statusEl.classList.add('complete');
            statusEl.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
          }
        }
        break;
      }
    }
    scrollToBottom();
  }

  /**
   * Handle full assistant message from a subagent
   */
  function handleSubagentAssistant(info, msg) {
    const content = msg.message?.content;
    if (!content) return;

    for (const block of content) {
      if (block.type === 'tool_use' && block.name !== 'TodoWrite') {
        const detail = getToolDisplayInfo(block.name, block.input);
        info.activityEl.textContent = `${block.name}...`;

        // Check if we already have a mini card for this tool_use_id
        let found = false;
        if (block.id) {
          for (const [, mini] of info.subTools) {
            if (mini.dataset.toolUseId === block.id) {
              found = true;
              break;
            }
          }
        }

        if (!found) {
          const mini = document.createElement('div');
          mini.className = 'sa-tool has-detail';
          mini.dataset.toolName = block.name;
          mini.title = block.name;
          if (block.id) mini.dataset.toolUseId = block.id;
          const truncated = detail && detail.length > 60 ? '...' + detail.slice(-57) : (detail || '');
          mini.innerHTML = `
            <div class="sa-tool-icon">${getToolIcon(block.name)}</div>
            <span class="sa-tool-name">${formatToolName(block.name)}</span>
            <span class="sa-tool-detail">${escapeHtml(truncated)}</span>
            <div class="sa-tool-status"><div class="chat-tool-spinner"></div></div>
          `;
          info.bodyEl.appendChild(mini);
          // Track by a unique key
          const key = block.id || `assistant-${info.subTools.size}`;
          info.subTools.set(key, mini);
        }
      }

      // tool_result → mark the matching mini-tool as complete
      if (block.type === 'tool_result' && block.tool_use_id) {
        let matchedMini = null;
        for (const [, mini] of info.subTools) {
          if (mini.dataset.toolUseId === block.tool_use_id) {
            matchedMini = mini;
            break;
          }
        }
        // Fallback: find in DOM
        if (!matchedMini) {
          matchedMini = info.bodyEl.querySelector(`.sa-tool[data-tool-use-id="${CSS.escape(block.tool_use_id)}"]`);
        }
        if (matchedMini) {
          const statusEl = matchedMini.querySelector('.sa-tool-status');
          if (statusEl && !statusEl.classList.contains('complete')) {
            statusEl.classList.add('complete');
            statusEl.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
          }
        }
      }
    }
    scrollToBottom();
  }

  // ── Todo list widget (anchored above input bar) ──

  let todoExpanded = false;

  function todoText(todo) {
    return todo.content || todo.subject || todo.text || todo.title || todo.description || todo.activeForm || '';
  }

  function updateTodoWidget(todos) {
    if (!todos || !todos.length) return;

    const completed = todos.filter(td => td.status === 'completed').length;
    const active = todos.find(td => td.status === 'in_progress');
    const total = todos.length;
    const pct = Math.round((completed / total) * 100);
    const allDone = completed === total;
    todoAllDone = allDone;

    // Debug log pour vérifier les valeurs
    console.log(`Todo progress: ${completed}/${total} = ${pct}%`);

    // Build items HTML
    const itemsHtml = todos.map((todo, i) => {
      const s = todo.status;
      const checkIcon = s === 'completed'
        ? `<svg class="td-icon td-done" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
        : s === 'in_progress'
          ? `<div class="td-icon td-active"><div class="td-spin"></div></div>`
          : `<div class="td-icon td-pending"></div>`;
      const text = s === 'in_progress' && todo.activeForm ? todo.activeForm : todoText(todo);
      return `<div class="td-row td-${s}" style="--d:${i}">${checkIcon}<span class="td-label">${escapeHtml(text)}</span></div>`;
    }).join('');

    // Active task text for collapsed bar
    const activeText = active
      ? (active.activeForm || todoText(active))
      : allDone ? (t('chat.todoAllDone') || 'All done') : '';

    const html = `
      <button class="td-bar" aria-expanded="${todoExpanded}">
        <span class="td-count">${completed}<span class="td-count-sep">/</span>${total}</span>
        <div class="td-track"><div class="td-fill${allDone ? ' td-fill-done' : ''}" style="width:${pct}%" data-pct="${pct}"></div></div>
        <span class="td-bar-text">${escapeHtml(activeText)}</span>
        <svg class="td-chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="td-body">${itemsHtml}</div>
    `;

    if (!todoWidgetEl) {
      todoWidgetEl = document.createElement('div');
      todoWidgetEl.className = 'chat-todo';
      if (todoExpanded) todoWidgetEl.classList.add('open');
      // Insert before the input area (anchored above it)
      const inputArea = chatView.querySelector('.chat-input-area');
      chatView.insertBefore(todoWidgetEl, inputArea);

      todoWidgetEl.addEventListener('click', (e) => {
        if (e.target.closest('.td-bar')) {
          todoExpanded = !todoExpanded;
          todoWidgetEl.classList.toggle('open', todoExpanded);
          todoWidgetEl.querySelector('.td-bar')?.setAttribute('aria-expanded', String(todoExpanded));
        }
      });
    }
    todoWidgetEl.innerHTML = html;
    // Preserve expanded state
    if (todoExpanded) todoWidgetEl.classList.add('open');
  }

  function appendThinkingBlock(text) {
    const el = document.createElement('div');
    el.className = 'chat-thinking';
    el.innerHTML = `
      <div class="chat-thinking-header">
        <svg viewBox="0 0 24 24" fill="currentColor" class="chat-thinking-chevron"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
        <span>${escapeHtml(t('chat.thinking'))}</span>
      </div>
      <div class="chat-thinking-content">${renderMarkdown(text)}</div>
    `;
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  async function appendPermissionCard(data) {
    const { requestId, toolName, input, decisionReason, suggestions } = data;

    // Check if it's AskUserQuestion
    if (toolName === 'AskUserQuestion') {
      appendQuestionCard(data);
      return;
    }

    // Plan mode handling
    if (toolName === 'ExitPlanMode' || toolName === 'EnterPlanMode') {
      appendPlanCard(data);
      return;
    }

    const detail = getToolDisplayInfo(toolName, input);
    const el = document.createElement('div');
    el.className = 'chat-perm-card';
    el.dataset.requestId = requestId;
    el.dataset.toolName = toolName;
    el.dataset.toolInput = JSON.stringify(input || {});
    el.dataset.suggestions = JSON.stringify(suggestions || []);

    const allowText = t('chat.allow') || 'Allow';
    const alwaysAllowText = t('chat.alwaysAllow') || 'Always Allow';
    const denyText = t('chat.deny') || 'Deny';
    el.innerHTML = `
      <div class="chat-perm-header">
        <div class="chat-perm-icon">${getToolIcon(toolName)}</div>
        <span class="chat-perm-title">${escapeHtml(t('chat.permissionRequired') || 'Permission Required')}</span>
      </div>
      <div class="chat-perm-body">
        <div class="chat-perm-tool-row">
          <span class="chat-perm-tool-name" title="${escapeHtml(toolName)}">${formatToolName(toolName)}</span>
          ${detail ? `<code class="chat-perm-tool-detail">${escapeHtml(detail.length > 100 ? '...' + detail.slice(-97) : detail)}</code>` : ''}
        </div>
        ${decisionReason ? `<p class="chat-perm-reason">${escapeHtml(decisionReason)}</p>` : ''}
      </div>
      <div class="chat-perm-actions">
        <button class="chat-perm-btn allow" data-action="allow">${escapeHtml(allowText)}</button>
        <button class="chat-perm-btn always-allow" data-action="always-allow">${escapeHtml(alwaysAllowText)}</button>
        <button class="chat-perm-btn deny" data-action="deny">${escapeHtml(denyText)}</button>
      </div>
      <div class="chat-perm-feedback" style="display:none">
        <input type="text" class="chat-perm-feedback-input" placeholder="${escapeHtml(t('chat.denyFeedbackPlaceholder') || 'Explain why (optional)...')}" />
        <button class="chat-perm-btn deny-send" data-action="deny-send">${escapeHtml(t('chat.sendFeedback') || 'Deny with feedback')}</button>
      </div>
    `;
    messagesEl.appendChild(el);
    el.querySelector('.chat-perm-feedback-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handlePermissionClick(el.querySelector('[data-action="deny-send"]'));
      }
    });
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }

  function appendQuestionCard(data) {
    const { requestId, input } = data;
    const questions = input?.questions || [];
    const totalSteps = questions.length;

    const el = document.createElement('div');
    el.className = 'chat-question-card';
    el.dataset.requestId = requestId;
    el.dataset.questions = JSON.stringify(questions);
    el.dataset.multiSelect = String(questions.some(q => q.multiSelect));
    el.dataset.currentStep = '0';
    el.dataset.collectedAnswers = '{}';

    let questionsHtml = '';
    questions.forEach((q, i) => {
      const hasMarkdown = (q.options || []).some(opt => opt.markdown);
      const optionsHtml = (q.options || []).map(opt =>
        `<button class="chat-question-option" data-label="${escapeHtml(opt.label)}"${opt.markdown ? ` data-markdown="${escapeHtml(opt.markdown)}"` : ''}>
          <span class="chat-qo-label">${escapeHtml(opt.label)}</span>
          <span class="chat-qo-desc">${escapeHtml(opt.description || '')}</span>
        </button>`
      ).join('');

      const firstMarkdown = q.options?.find(o => o.markdown)?.markdown || '';
      const previewHtml = hasMarkdown
        ? `<div class="chat-question-preview">${renderMarkdown(firstMarkdown)}</div>`
        : '';

      questionsHtml += `
        <div class="chat-question-group${i === 0 ? ' active' : ''}${hasMarkdown ? ' has-preview' : ''}" data-step="${i}">
          <p class="chat-question-text">${escapeHtml(q.question)}</p>
          <div class="chat-question-split">
            <div class="chat-question-options">${optionsHtml}</div>
            ${previewHtml}
          </div>
          <div class="chat-question-custom">
            <input type="text" class="chat-question-custom-input" placeholder="${escapeHtml(t('chat.otherPlaceholder') || 'Or type your own answer...')}" />
          </div>
        </div>
      `;
    });

    const isOnlyOne = totalSteps <= 1;
    const btnText = isOnlyOne
      ? escapeHtml(t('chat.submit') || 'Submit')
      : escapeHtml(t('chat.next') || 'Next');

    el.innerHTML = `
      <div class="chat-question-header">
        <div class="chat-perm-icon">${getToolIcon('AskUserQuestion')}</div>
        <span>${escapeHtml(t('chat.questionFromClaude') || 'Claude has a question')}</span>
        ${totalSteps > 1 ? `<span class="chat-question-step">1 / ${totalSteps}</span>` : ''}
      </div>
      <div class="chat-question-body">
        ${questionsHtml}
      </div>
      <div class="chat-question-actions">
        <button class="chat-question-submit" data-action="${isOnlyOne ? 'submit' : 'next'}">${btnText}</button>
      </div>
    `;
    messagesEl.appendChild(el);
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });

    // Enter key on custom inputs advances or submits
    el.querySelectorAll('.chat-question-custom-input').forEach(inp => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const btn = el.querySelector('.chat-question-submit');
          if (btn.dataset.action === 'next') {
            handleQuestionNext(el);
          } else {
            handleQuestionSubmit(el);
          }
        }
      });
    });
  }

  function appendPlanCard(data) {
    const { requestId, toolName, input } = data;
    const isExit = toolName === 'ExitPlanMode';
    const el = document.createElement('div');
    el.className = 'chat-plan-card';
    el.dataset.requestId = requestId;
    el.dataset.toolName = toolName;
    el.dataset.toolInput = JSON.stringify(input || {});

    const icon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13zM9 13h6v2H9v-2zm6 4H9v2h6v-2zm-2-8h2v2h-2V9z"/></svg>';

    if (isExit) {
      // The SDK injects plan content into input.plan (read from ~/.claude/plans/<slug>.md)
      const planMarkdown = input?.plan || '';
      const planContent = planMarkdown ? renderMarkdown(planMarkdown) : '';

      const planPreview = planContent
        ? `<div class="chat-plan-content"><div class="chat-plan-content-inner">${planContent}</div></div>`
        : '';

      if (planContent) el.classList.add('has-plan-content');

      el.innerHTML = `
        <div class="chat-plan-header">
          <div class="chat-plan-icon">${icon}</div>
          <span>${escapeHtml(t('chat.planReady') || 'Plan ready for review')}</span>
        </div>
        ${planPreview}
        <div class="chat-plan-actions">
          <button class="chat-plan-btn approve" data-action="allow">${escapeHtml(t('chat.approvePlan') || 'Approve plan')}</button>
          <button class="chat-plan-btn reject" data-action="deny">${escapeHtml(t('chat.rejectPlan') || 'Reject plan')}</button>
        </div>
        <div class="chat-plan-feedback" style="display:none">
          <input type="text" class="chat-plan-feedback-input" placeholder="${escapeHtml(t('chat.denyFeedbackPlaceholder') || 'Explain why (optional)...')}" />
          <button class="chat-plan-btn deny-send" data-action="deny-send">${escapeHtml(t('chat.sendFeedback') || 'Reject with feedback')}</button>
        </div>
      `;
    } else {
      el.innerHTML = `
        <div class="chat-plan-header">
          <div class="chat-plan-icon">${icon}</div>
          <span>${escapeHtml(t('chat.enteringPlanMode') || 'Claude wants to plan before implementing')}</span>
        </div>
        <div class="chat-plan-actions">
          <button class="chat-plan-btn approve" data-action="allow">${escapeHtml(t('chat.allow') || 'Allow')}</button>
          <button class="chat-plan-btn reject" data-action="deny">${escapeHtml(t('chat.deny') || 'Deny')}</button>
        </div>
        <div class="chat-plan-feedback" style="display:none">
          <input type="text" class="chat-plan-feedback-input" placeholder="${escapeHtml(t('chat.denyFeedbackPlaceholder') || 'Explain why (optional)...')}" />
          <button class="chat-plan-btn deny-send" data-action="deny-send">${escapeHtml(t('chat.sendFeedback') || 'Reject with feedback')}</button>
        </div>
      `;
    }

    messagesEl.appendChild(el);
    // Feedback input: Enter to send
    el.querySelector('.chat-plan-feedback-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handlePlanClick(el.querySelector('[data-action="deny-send"]'));
      }
    });
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }

  // ── State management ──

  function setStreaming(streaming) {
    isStreaming = streaming;
    stopBtn.style.display = streaming ? '' : 'none';
    chatView.classList.toggle('streaming', streaming);

    // Fix #7: Disable model/effort dropdowns during streaming
    modelBtn.disabled = streaming;
    effortBtn.disabled = streaming;
    modelBtn.classList.toggle('disabled', streaming);
    effortBtn.classList.toggle('disabled', streaming);
    if (streaming) {
      modelDropdown.style.display = 'none';
      effortDropdown.style.display = 'none';
    }

    if (streaming) {
      inputEl.dataset.placeholder = t('chat.queuePlaceholder') || 'Queue a follow-up message...';
      setStatus('thinking', t('chat.thinking'));
    } else {
      // Refresh contextual suggestions (placeholder rotation) after streaming ends
      contextSuggestions.setPostStreamTimer(setTimeout(() => contextSuggestions.refresh(), 300));
      // Flush SDK prompt suggestions accumulated during the turn
      if (getSetting('enableFollowupSuggestions') !== false) {
        followupChips.flush();
      }
      setStatus('idle', t('chat.ready') || 'Ready');
      inputEl.focus();
    }
  }

  function setStatus(state, text) {
    statusDot.className = `chat-status-dot ${state}`;
    statusTextEl.textContent = text || '';

    // Propagate to terminal tab status (blip, project list counter)
    if (onStatusChange) {
      switch (state) {
        case 'idle':
          onStatusChange('ready');
          break;
        case 'waiting':
          onStatusChange('working', 'waiting');
          break;
        case 'working':
          onStatusChange('working', 'tool_calling');
          break;
        default: // thinking, responding
          onStatusChange('working', 'thinking');
          break;
      }
    }
  }

  function updateStatusInfo() {
    // Update model selector label from stream-detected model
    if (model) {
      const match = MODEL_OPTIONS.find(m => model.includes(m.label.toLowerCase()) || model.includes(m.id));
      if (match) modelLabel.textContent = match.label;
      else modelLabel.textContent = model.split('-').slice(1, 3).join('-');
    }
    if (inputTokens > 0) {
      const contextLimit = getSetting('enable1MContext') ? 1000000 : 200000;
      const pct = Math.round((inputTokens / contextLimit) * 100);
      const formatK = (n) => n >= 1000 ? Math.round(n / 1000) + 'K' : n;
      statusTokens.textContent = `${formatK(inputTokens)} / ${formatK(contextLimit)} (${pct}%)`;
      statusTokens.title = `${t('chat.contextWindowUsage') || 'Context window'}: ${inputTokens.toLocaleString()} / ${contextLimit.toLocaleString()} tokens`;
    } else if (totalTokens > 0) {
      statusTokens.textContent = `${totalTokens.toLocaleString()} tokens`;
    }
    if (totalCost > 0) statusCost.textContent = `$${totalCost.toFixed(4)}`;
  }

  let userHasScrolled = false;
  let hasNewMessages = false;

  // Create scroll-to-bottom button
  const scrollButton = document.createElement('button');
  scrollButton.className = 'chat-scroll-to-bottom';
  scrollButton.style.display = 'none';
  scrollButton.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  `;
  scrollButton.title = 'New messages below';
  chatView.appendChild(scrollButton);

  scrollButton.addEventListener('click', () => {
    userHasScrolled = false;
    hasNewMessages = false;
    scrollButton.classList.remove('has-new-messages');
    scrollButton.style.display = 'none';
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  // Detect when user manually scrolls
  messagesEl.addEventListener('scroll', () => {
    const isAtBottom = messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 50;
    userHasScrolled = !isAtBottom && messagesEl.scrollHeight > messagesEl.clientHeight;

    if (isAtBottom) {
      userHasScrolled = false;
      hasNewMessages = false;
      scrollButton.classList.remove('has-new-messages');
      scrollButton.style.display = 'none';
    }
  });

  let _scrollRafId = null;
  function scrollToBottom() {
    if (!userHasScrolled) {
      if (!_scrollRafId) {
        _scrollRafId = requestAnimationFrame(() => {
          _scrollRafId = null;
          messagesEl.scrollTop = messagesEl.scrollHeight;
        });
      }
    } else {
      hasNewMessages = true;
      scrollButton.classList.add('has-new-messages');
      scrollButton.style.display = '';
    }
  }

  // Reset scroll detection when user sends a new message
  function resetScrollDetection() {
    userHasScrolled = false;
    scrollToBottom();
  }

  // ── IPC: SDK Messages ──

  const unsubMessage = api.chat.onMessage(({ sessionId: sid, message }) => {
    if (sid !== sessionId) return;

    // Route subagent messages to their card (messages with parent_tool_use_id)
    const parentId = message.parent_tool_use_id;
    if (parentId) {
      const subInfo = findSubagentByParentId(parentId);
      if (subInfo) {
        handleSubagentMessage(subInfo, message);
        return;
      }
    }

    // Stream events (partial messages)
    if (message.type === 'stream_event' && message.event) {
      handleStreamEvent(message.event);
      return;
    }

    // System messages
    if (message.type === 'system') {
      if (message.subtype === 'init') {
        // Clear initializing indicator (runtime resolved, SDK ready)
        if (_initSecondaryTimer) { clearTimeout(_initSecondaryTimer); _initSecondaryTimer = null; }
        const initIndicator = messagesEl.querySelector('.chat-initializing-indicator');
        if (initIndicator) initIndicator.remove();
        model = message.model || '';
        updateStatusInfo();
        // Capture available slash commands for autocomplete
        if (message.slash_commands && Array.isArray(message.slash_commands)) {
          slashCommands = message.slash_commands;
        }
      } else if (message.subtype === 'status' && message.status === 'compacting') {
        removeThinkingIndicator();
        appendCompactingIndicator();
        setStatus('thinking', t('chat.compacting') || 'Compacting...');
      } else if (message.subtype === 'compact_boundary') {
        removeCompactingIndicator();
        removeThinkingIndicator();
        const preTokens = message.compact_metadata?.pre_tokens;
        const notice = preTokens
          ? t('chat.compacted', { tokens: preTokens.toLocaleString() }) || `Conversation compacted (${preTokens.toLocaleString()} tokens before)`
          : t('chat.compactedSimple') || 'Conversation compacted';
        appendSystemNotice(notice, 'compact');
        setStreaming(false);
      } else if (message.subtype === 'task_started') {
        const taskId = message.task_id;
        if (taskId) {
          bgTaskStore.update(taskId, {
            status: 'running',
            description: message.description || '',
            taskType: message.task_type || '',
            workflowName: message.workflow_name || '',
            prompt: message.prompt || '',
            toolUseId: message.tool_use_id || '',
            startedAt: Date.now(),
          });
        }
      } else if (message.subtype === 'task_progress') {
        const taskId = message.task_id;
        if (taskId) {
          const patch = { status: 'running' };
          if (message.description) patch.description = message.description;
          if (message.last_tool_name) patch.lastToolName = message.last_tool_name;
          if (message.summary) patch.summary = message.summary;
          if (message.usage) patch.usage = message.usage;
          if (message.tool_use_id) patch.toolUseId = message.tool_use_id;
          bgTaskStore.update(taskId, patch);
        }
      } else if (message.subtype === 'task_notification') {
        const taskId = message.task_id;
        if (taskId) {
          bgTaskStore.update(taskId, {
            status: message.status || 'completed',
            summary: message.summary || '',
            outputFile: message.output_file || '',
            usage: message.usage || undefined,
            toolUseId: message.tool_use_id || undefined,
            endedAt: Date.now(),
          });
        }
      } else if (message.subtype === 'task_updated') {
        const taskId = message.task_id;
        const patch = message.patch || {};
        if (taskId) {
          const mapped = {};
          if (patch.status) mapped.status = patch.status;
          if (patch.description) mapped.description = patch.description;
          if (patch.end_time) mapped.endedAt = patch.end_time;
          if (patch.error) mapped.error = patch.error;
          if (typeof patch.is_backgrounded === 'boolean') mapped.isBackgrounded = patch.is_backgrounded;
          if (Object.keys(mapped).length) bgTaskStore.update(taskId, mapped);
        }
      }
      return;
    }

    // Tool progress ticks — update elapsed time for background tasks.
    if (message.type === 'tool_progress') {
      const taskId = message.task_id;
      if (taskId) {
        const patch = { elapsedSeconds: message.elapsed_time_seconds };
        if (message.tool_name) patch.lastToolName = message.tool_name;
        bgTaskStore.update(taskId, patch);
      }
      return;
    }

    // Full assistant message (backup for non-streaming or tool use detection)
    if (message.type === 'assistant') {
      handleAssistantMessage(message);
      return;
    }

    // User messages carry tool_result blocks after a tool runs — reuse the
    // same block walker (handleAssistantMessage inspects msg.message.content).
    if (message.type === 'user') {
      handleAssistantMessage(message);
      return;
    }

    // Result — update stats. Also detect SDK errors.
    if (message.type === 'result') {
      if (message.total_cost_usd != null) totalCost = message.total_cost_usd;
      if (message.usage) {
        totalTokens = (message.usage.input_tokens || 0) + (message.usage.output_tokens || 0);
        inputTokens = message.usage.input_tokens || 0;
      }
      if (message.model) model = message.model;
      updateStatusInfo();

      // Handle SDK errors (error_during_execution, error_max_turns, etc.)
      if (message.is_error || (message.subtype && message.subtype !== 'success')) {
        removeThinkingIndicator();
        finalizeStreamBlock();
        if (!isAborting) {
          let errorMsg;
          if (message.subtype === 'error_max_turns') {
            errorMsg = t('chat.errorMaxTurns', { count: getSetting('maxTurns') || 100 });
          } else if (message.subtype === 'error_max_budget_usd') {
            errorMsg = t('chat.errorMaxBudget', { cost: message.total_cost_usd?.toFixed(2) || '?' });
          } else if (message.subtype === 'error_during_execution') {
            const errors = message.errors || [];
            errorMsg = errors.length ? errors.join('\n') : t('chat.errorExecution');
          } else {
            const errors = message.errors || [];
            errorMsg = errors.length ? errors.join('\n') : (message.subtype || t('chat.errorOccurred'));
          }
          appendError(errorMsg);
        }
        isAborting = false;
        setStreaming(false);
      } else {
        // Successful result (e.g. slash commands like /usage, /compact, /clear)
        // Finalize any pending UI state
        removeThinkingIndicator();
        finalizeStreamBlock();
        // Display result text only for slash commands (no streamed content was shown)
        if (message.result && typeof message.result === 'string' && !turnHadAssistantContent) {
          appendSystemNotice(message.result, 'command');
        }
        setStreaming(false);
      }
      return;
    }
  });
  unsubscribers.push(unsubMessage);

  // IPC: Native SDK prompt suggestions (piggybacked on the stream, nearly free)
  const unsubPromptSuggestion = api.chat.onPromptSuggestion(({ sessionId: sid, suggestion }) => {
    if (sid !== sessionId) return;
    followupChips.addSuggestion(suggestion);
  });
  unsubscribers.push(unsubPromptSuggestion);

  // Throttled output activity tracker (max 1 call/sec)
  function trackOutputActivity() {
    if (!project?.id) return;
    heartbeat(project.id, 'chat');
  }

  function handleStreamEvent(event) {
    switch (event.type) {
      case 'message_start':
        if (!isStreaming) setStreaming(true);
        setStatus('thinking', t('chat.thinking'));
        blockIndex = 0;
        currentMsgHasToolUse = false;
        turnHadAssistantContent = false;
        // Update model from stream (reflects mid-session model changes)
        if (event.message?.model) {
          model = event.message.model;
          updateStatusInfo();
        }
        // Clear queued badges — this message is now being processed
        for (const qEl of messagesEl.querySelectorAll('.chat-msg-user.queued')) {
          qEl.classList.remove('queued');
          const badge = qEl.querySelector('.chat-msg-queued-badge');
          if (badge) badge.remove();
        }
        break;

      case 'content_block_start': {
        const block = event.content_block;
        if (!block) break;
        if (block.type === 'text') {
          startStreamBlock();
          setStatus('responding', t('chat.streaming') || 'Writing...');
        } else if (block.type === 'tool_use') {
          finalizeStreamBlock();
          currentMsgHasToolUse = true;
          // Track for session recap
          recapToolCount++;
          recapToolCounts[block.name] = (recapToolCounts[block.name] || 0) + 1;
          const blockIdx = event.index ?? blockIndex;
          // TodoWrite, Task, parallel_start_run & AskUserQuestion get special UI — no generic tool card
          if (block.name === 'TodoWrite') {
            todoToolIndices.add(blockIdx);
          } else if (block.name === 'Task' || block.name === 'Agent') {
            const card = appendSubagentCard();
            const bodyEl = card.querySelector('.chat-subagent-body');
            const activityEl = card.querySelector('.chat-subagent-activity');
            taskToolIndices.set(blockIdx, {
              card, toolUseId: block.id, bodyEl, activityEl,
              subTools: new Map(), subBuffers: new Map(), subBlockIndex: 0
            });
            setStatus('working', t('chat.subagentRunning') || 'Agent running...');
          } else if (block.name === 'mcp__claude-terminal__parallel_start_run') {
            parallelToolIndices.set(blockIdx, { toolUseId: block.id });
            setStatus('working', t('parallel.chatWidget.starting') || 'Starting parallel run...');
          } else if (block.name !== 'AskUserQuestion') {
            const card = appendToolCard(block.name, '');
            card.dataset.toolUseId = block.id || `fallback-${blockIdx}`;
            toolCards.set(blockIdx, card);
          }
          toolInputBuffers.set(blockIdx, '');
          if (block.name !== 'Task' && block.name !== 'Agent') setStatus('working', `${block.name}...`);
        } else if (block.type === 'thinking') {
          currentThinkingText = '';
          currentThinkingEl = null;
        }
        blockIndex++;
        break;
      }

      case 'content_block_delta': {
        const delta = event.delta;
        if (!delta) break;
        if (delta.type === 'text_delta') {
          removeThinkingIndicator();
          if (!currentStreamEl) startStreamBlock();
          appendStreamDelta(delta.text);
          turnHadAssistantContent = true;
          trackOutputActivity();
        } else if (delta.type === 'thinking_delta') {
          currentThinkingText += delta.thinking;
        } else if (delta.type === 'input_json_delta') {
          const idx = event.index ?? (blockIndex - 1);
          const buf = toolInputBuffers.get(idx);
          if (buf !== undefined) {
            toolInputBuffers.set(idx, buf + (delta.partial_json || ''));
          }
        }
        break;
      }

      case 'content_block_stop': {
        // Finalize text block
        if (currentStreamEl) {
          finalizeStreamBlock();
        }
        // Finalize thinking block
        if (currentThinkingText) {
          appendThinkingBlock(currentThinkingText);
          currentThinkingText = '';
        }
        // Finalize tool input — parse accumulated JSON and store on card
        const stopIdx = event.index ?? (blockIndex - 1);
        const jsonStr = toolInputBuffers.get(stopIdx);
        if (jsonStr) {
          toolInputBuffers.delete(stopIdx);
          try {
            const toolInput = JSON.parse(jsonStr);

            // TodoWrite → update the persistent todo widget
            if (todoToolIndices.has(stopIdx)) {
              todoToolIndices.delete(stopIdx);
              if (toolInput.todos) updateTodoWidget(toolInput.todos);
              break;
            }

            // Task (subagent) → update subagent card with name/description
            const taskInfo = taskToolIndices.get(stopIdx);
            if (taskInfo) {
              updateSubagentCard(taskInfo.card, toolInput);
              setStatus('working', `${toolInput.name || toolInput.subagent_type || 'Agent'}...`);
              break;
            }

            // parallel_start_run → render live widget inline
            const parallelInfo = parallelToolIndices.get(stopIdx);
            if (parallelInfo) {
              parallelToolIndices.delete(stopIdx);
              const goal = toolInput.goal || '';
              const { initParallelListeners } = require('../../state/parallelTask.state');
              initParallelListeners();
              const widget = _createParallelWidget(goal, parallelInfo.toolUseId);
              parallelPendingWidgets.set(parallelInfo.toolUseId, widget);
              messagesEl.appendChild(widget.el);
              scrollToBottom();
              break;
            }

            const card = toolCards.get(stopIdx);
            if (card) {
              card.dataset.toolInput = JSON.stringify(toolInput);
              const name = card.dataset.toolName || card.querySelector('.chat-tool-name')?.textContent || '';
              // Custom card renderer (ScheduleWakeup, CronCreate, Worktree, Notification)
              const customHtml = renderToolCardHtml(name, toolInput);
              if (customHtml) {
                card.classList.add('chat-tool-card--custom');
                card.classList.remove('expandable');
                card.innerHTML = customHtml;
                if (name === 'ScheduleWakeup') ensureWakeupTicker();
                if (name === 'Monitor' || name === 'TaskOutput' || name === 'TaskStop') {
                  ensureBgTaskSubscription();
                  // Seed the store so the card shows "running" even before first result.
                  const taskId = toolInput && (toolInput.task_id || toolInput.shell_id);
                  if (taskId && !bgTaskStore.get(taskId)) bgTaskStore.update(taskId, {});
                }
              } else {
                card.classList.add('expandable');
                const info = getToolDisplayInfo(name, toolInput);
                const detailEl = card.querySelector('.chat-tool-detail');
                if (detailEl && info) {
                  detailEl.textContent = info.length > 80 ? '...' + info.slice(-77) : info;
                }
              }
            }
          } catch (e) { /* partial JSON, ignore */ }
        }
        break;
      }

      case 'message_delta':
        // Contains stop_reason, usage
        if (event.usage) {
          totalTokens = (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0);
          updateStatusInfo();
        }
        break;

      case 'message_stop':
        removeThinkingIndicator();
        finalizeStreamBlock();
        // Always complete any remaining tool cards — if a tool_result was missed
        // or matching failed, this prevents spinners from staying stuck forever
        for (const [, card] of toolCards) {
          completeToolCard(card);
        }
        toolCards.clear();
        if (!currentMsgHasToolUse) {
          // Turn is complete (no tool use) — reset streaming
          setStreaming(false);
          // Don't complete subagent cards here — they have their own lifecycle
          // via parent_tool_use_id messages and will be completed when their
          // individual 'result' message arrives or on chat-done/chat-error
        }
        break;
    }
  }

  function forkFromMessage(messageUuid) {
    // Use the real SDK session UUID, not our internal sessionId
    const realSid = sdkSessionId || pendingResumeId;
    if (!realSid || !onForkSession) return;
    onForkSession({
      resumeSessionId: realSid,
      resumeSessionAt: messageUuid,
      model: selectedModel,
      effort: selectedEffort,
      skipPermissions,
    });
  }

  async function handleRewindFiles(userMessageUuid, btnEl) {
    if (!sessionId) return;
    btnEl.disabled = true;
    btnEl.classList.add('loading');
    try {
      const result = await api.chat.rewindFiles({ sessionId, userMessageId: userMessageUuid });
      if (result.success && result.canRewind) {
        const filesCount = result.filesChanged?.length || 0;
        const details = [];
        if (filesCount > 0) details.push(t('chat.rewindFilesCount', { count: filesCount }) || `${filesCount} file(s)`);
        if (result.insertions) details.push(`+${result.insertions}`);
        if (result.deletions) details.push(`-${result.deletions}`);
        const detailText = details.length > 0 ? ` (${details.join(', ')})` : '';
        const Toast = require('./Toast');
        Toast.showToast({
          message: (t('chat.rewindSuccess') || 'Files rewound successfully') + detailText,
          type: 'success',
          duration: 5000
        });
        appendSystemNotice(
          (t('chat.rewindNotice') || 'Files rewound to this point') + detailText,
          'command'
        );
      } else if (result.success && !result.canRewind) {
        const Toast = require('./Toast');
        Toast.showToast({
          message: result.error || t('chat.rewindNotAvailable') || 'Cannot rewind to this point',
          type: 'warning'
        });
      } else {
        const Toast = require('./Toast');
        Toast.showToast({
          message: result.error || t('chat.rewindError') || 'Failed to rewind files',
          type: 'error'
        });
      }
    } catch (err) {
      const Toast = require('./Toast');
      Toast.showToast({
        message: err.message || t('chat.rewindError') || 'Failed to rewind files',
        type: 'error'
      });
    } finally {
      btnEl.disabled = false;
      btnEl.classList.remove('loading');
    }
  }

  // Walk a content array and process each tool_result block. Shared between
  // assistant messages (rare) and user messages (standard — SDK emits tool
  // results as user messages with content containing tool_result blocks).
  function handleToolResultBlocks(content) {
    for (const block of content) {
      if (block && block.type === 'tool_result') {
        processToolResultBlock(block);
      }
    }
  }

  function processToolResultBlock(block) {
    // Parallel run widget — skip tool_result (widget handles display via state)
    for (const [, w] of parallelRunWidgets) {
      if (w.toolUseId === block.tool_use_id) return;
    }

    // Pending parallel widget (no run bound yet) — surface MCP errors so
    // the widget doesn't stay stuck on "Starting parallel run..."
    const pending = block.tool_use_id ? parallelPendingWidgets.get(block.tool_use_id) : null;
    if (pending) {
      const rawText = typeof block.content === 'string' ? block.content
        : Array.isArray(block.content) ? block.content.map(b => b.text || '').join('\n') : '';
      const isError = block.is_error === true
        || (Array.isArray(block.content) && block.content.some(b => b && b.is_error))
        || /^(error|missing required|no project path)/i.test(rawText.trim());
      if (isError) {
        pending.setError?.(rawText.trim() || 'Failed to start parallel run');
        return;
      }
      // Successful result without a state update yet — let state subscription handle it
      return;
    }

    // Subagent cards — mark completed but keep for late message routing
    for (const [, info] of taskToolIndices) {
      if (info.toolUseId === block.tool_use_id) {
        const raw = typeof block.content === 'string' ? block.content
          : Array.isArray(block.content) ? block.content.map(b => b.text || '').join('\n') : '';
        const stats = parseResultJson(raw);
        completeSubagentCard(info.card, stats);
        info.completed = true;
        break;
      }
    }

    // Regular tool cards — find via in-memory map or DOM query
    let matchedCard = null;
    let matchedIdx = null;
    for (const [idx, card] of toolCards) {
      if (card.dataset.toolUseId === block.tool_use_id) { matchedCard = card; matchedIdx = idx; break; }
    }
    if (!matchedCard && block.tool_use_id) {
      try {
        matchedCard = messagesEl.querySelector(`.chat-tool-card[data-tool-use-id="${CSS.escape(block.tool_use_id)}"]`);
      } catch (e) {
        console.warn('[ChatView] CSS.escape selector failed:', e);
      }
    }
    if (!matchedCard) {
      console.warn('[ChatView] tool_result unmatched, tool_use_id:', block.tool_use_id, 'toolCards size:', toolCards.size);
      return;
    }

    const output = typeof block.content === 'string' ? block.content
      : Array.isArray(block.content) ? block.content.map(b => b.text || '').join('\n') : '';
    if (output) matchedCard.dataset.toolOutput = output;

    const bgName = matchedCard.dataset.toolName;

    // Bash with run_in_background: seed bgTaskStore with command + backgroundTaskId
    if (bgName === 'Bash') {
      let bashInput = {};
      try { bashInput = JSON.parse(matchedCard.dataset.toolInput || '{}'); } catch (_) { /* ignore */ }
      if (bashInput.run_in_background) {
        const parsed = parseResultJson(output);
        const bgTaskId = parsed && (parsed.backgroundTaskId || parsed.background_task_id || parsed.taskId);
        if (bgTaskId) {
          bgTaskStore.update(bgTaskId, {
            command: bashInput.command || '',
            status: 'running',
          });
          ensureBgTaskSubscription();
        }
      }
    }

    // Result-enriched renderers (CronList etc.)
    if (bgName) {
      let inputForResult = {};
      try { inputForResult = JSON.parse(matchedCard.dataset.toolInput || '{}'); } catch (_) { /* ignore */ }
      const parsedForResult = parseResultJson(output);
      const resultHtml = renderToolResultHtml(bgName, parsedForResult || output, inputForResult);
      if (resultHtml) {
        matchedCard.classList.add('chat-tool-card--custom');
        matchedCard.classList.remove('expandable');
        matchedCard.innerHTML = resultHtml;
      }
    }

    if (bgName === 'Monitor' || bgName === 'TaskOutput' || bgName === 'TaskStop') {
      let toolInput = {};
      try { toolInput = JSON.parse(matchedCard.dataset.toolInput || '{}'); } catch (_) { /* ignore */ }
      const taskId = toolInput.task_id || toolInput.shell_id;
      if (taskId) {
        const parsed = parseResultJson(output);
        const patch = {};
        if (bgName === 'TaskStop') {
          patch.status = 'stopped';
          patch.stoppedAt = Date.now();
          if (parsed && parsed.command) patch.command = parsed.command;
          if (parsed && parsed.task_type) patch.taskType = parsed.task_type;
        } else if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
          // Monitor / TaskOutput — structured object, pull known fields
          if (typeof parsed.stdout === 'string' && parsed.stdout) patch.output = parsed.stdout;
          else if (typeof parsed.output === 'string' && parsed.output) patch.output = parsed.output;
          else if (typeof parsed.text === 'string' && parsed.text) patch.output = parsed.text;
          else if (typeof parsed.stderr === 'string' && parsed.stderr) patch.output = parsed.stderr;
          else if (output) patch.output = output; // fallback: raw text
          if (parsed.command && !bgTaskStore.get(taskId)?.command) patch.command = parsed.command;
          if (parsed.completed === true || parsed.done === true || parsed.status === 'completed') {
            patch.status = 'done';
          }
          if (parsed.status === 'stopped' || parsed.stopped === true) {
            patch.status = 'stopped';
            patch.stoppedAt = patch.stoppedAt || Date.now();
          }
        } else if (output) {
          patch.output = output;
        }
        bgTaskStore.update(taskId, patch);
      }
    }

    completeToolCard(matchedCard);
    if (matchedIdx !== null) toolCards.delete(matchedIdx);
  }

  function handleAssistantMessage(msg) {
    // User messages carry tool_result blocks only — skip assistant-specific
    // logic (fork button, text fallback) and jump straight to the block walker.
    if (msg.type === 'user') {
      const content = msg.message?.content;
      if (!Array.isArray(content)) return;
      handleToolResultBlocks(content);
      return;
    }

    // SDK-level errors on the assistant message (rate_limit, billing_error, etc.)
    if (msg.error) {
      const errorMessages = {
        rate_limit: t('chat.errorRateLimit'),
        billing_error: t('chat.errorBilling'),
        authentication_failed: t('chat.errorAuth'),
        invalid_request: t('chat.errorInvalidRequest'),
        max_output_tokens: t('chat.errorMaxTokens'),
        server_error: t('chat.errorServer'),
      };
      const text = errorMessages[msg.error] || t('chat.errorOccurred');
      removeThinkingIndicator();
      appendError(text);
      setStreaming(false);
      return;
    }

    const content = msg.message?.content;
    if (!content) return;

    // Capture real SDK session UUID (needed for fork/resume)
    if (msg.session_id && msg.session_id !== sdkSessionId) {
      sdkSessionId = msg.session_id;
      // Propagate new session ID to termData for persistence (fixes /clear not saving new ID)
      if (terminalId) {
        updateTerminal(terminalId, { claudeSessionId: msg.session_id });
        saveTerminalSessions();
      }
    }

    // Store message UUID on the assistant DOM element (used for fork)
    if (msg.uuid) {
      const target = currentAssistantMsgEl
        || messagesEl.querySelector('.chat-msg-assistant:last-child');
      if (target) {
        target.dataset.messageUuid = msg.uuid;
        // Add fork button if not already present
        if (!target.querySelector('.chat-msg-fork-btn')) {
          const forkBtn = document.createElement('button');
          forkBtn.className = 'chat-msg-fork-btn';
          forkBtn.title = t('chat.forkSession') || 'Fork from here';
          forkBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/><path d="M6 9a9 9 0 0 0 9 9"/></svg>';
          forkBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            forkFromMessage(msg.uuid);
          });
          target.appendChild(forkBtn);
        }
      }
    }

    // If assistant sends text, collapse any question cards answered externally (e.g. from CT)
    if (content.some(b => b.type === 'text')) {
      collapseExternallyAnsweredQuestionCards();
    }

    // Fallback: render text blocks that weren't displayed by streaming.
    // Normally text is rendered via stream events, but if streaming missed them
    // (e.g., timing issues, non-streaming SDK mode), render here as safety net.
    for (const block of content) {
      if (block.type === 'text' && block.text && !currentStreamEl) {
        // Check if this text was already rendered (by checking last assistant msg content)
        const lastAssistant = messagesEl.querySelector('.chat-msg-assistant:last-child .chat-msg-content');
        const lastText = lastAssistant?.textContent?.trim() || '';
        const blockText = block.text.trim().slice(0, 100);
        if (!lastText || !lastText.startsWith(blockText.slice(0, 50))) {
          const el = document.createElement('div');
          el.className = 'chat-msg chat-msg-assistant';
          el.innerHTML = `<div class="chat-msg-content">${renderMarkdown(block.text)}</div>`;
          injectInlineImages(el.querySelector('.chat-msg-content'));
          MarkdownRenderer.postProcess(el.querySelector('.chat-msg-content'));
          messagesEl.appendChild(el);
          conversationHistory.push({ role: 'assistant', content: block.text });
          turnHadAssistantContent = true;
          scrollToBottom();
        }
      }
    }

    let hasToolUse = false;
    for (const block of content) {
      if (block.type === 'tool_use') {
        // TodoWrite — update widget instead of tool card
        if (block.name === 'TodoWrite' && block.input?.todos) {
          updateTodoWidget(block.input.todos);
          continue;
        }
        // Task (subagent) — update subagent card from assistant message
        if ((block.name === 'Task' || block.name === 'Agent') && block.input) {
          for (const [, info] of taskToolIndices) {
            if (info.toolUseId === block.id) {
              updateSubagentCard(info.card, block.input);
              break;
            }
          }
          hasToolUse = true;
          continue;
        }
        hasToolUse = true;
      }
      // tool_result → delegate to shared helper (also used for msg.type === 'user')
      if (block.type === 'tool_result') {
        processToolResultBlock(block);
      }
    }

    if (hasToolUse) {
      setStatus('working', t('chat.toolRunning') || 'Running tools...');
    }

    if (msg.message?.model) {
      model = msg.message.model;
      updateStatusInfo();
    }
  }

  /**
   * Collapse question cards that were answered externally (e.g. from Control Tower).
   * Called when a new assistant text message arrives — meaning the SDK already
   * received the answer and continued, so we just need to update the UI.
   */
  function collapseExternallyAnsweredQuestionCards() {
    // Fallback: if a question card was answered from CT (ct-question-answered event already
    // collapsed it with the real answer), this handles any remaining unresolved cards
    // e.g. from a race condition or non-CT source.
    messagesEl.querySelectorAll('.chat-question-card:not(.resolved)').forEach(card => {
      card.classList.add('resolved');
      card.innerHTML = `
        <div class="chat-question-header resolved">
          <div class="chat-perm-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
          </div>
          <span>${escapeHtml(t('chat.questionAnswered') || 'Answered')}</span>
        </div>
      `;
    });
  }

  /**
   * Mark all unresolved permission/question cards as failed
   */
  function resolveAllPendingCards() {
    messagesEl.querySelectorAll('.chat-perm-card:not(.resolved), .chat-question-card:not(.resolved), .chat-plan-card:not(.resolved)').forEach(card => {
      card.classList.add('resolved');
      card.querySelectorAll('button').forEach(b => b.disabled = true);
      // Clear permission timers for resolved cards
      if (card.dataset.requestId) _clearPermTimers(card.dataset.requestId);
    });
  }

  // ── IPC: Error ──

  const unsubError = api.chat.onError(({ sessionId: sid, error, errorType }) => {
    if (sid !== sessionId) return;
    removeThinkingIndicator();
    finalizeStreamBlock();
    resolveAllPendingCards();
    // Complete all pending tool/subagent cards so spinners don't stay stuck
    for (const [, card] of toolCards) completeToolCard(card);
    toolCards.clear();
    for (const [idx, info] of taskToolIndices) {
      completeSubagentCard(info.card);
      taskToolIndices.delete(idx);
    }
    // The dedicated chat-account-limit handler will surface the switch modal
    // and replay the turn — suppress the generic error banner in that case.
    if (!isAborting && !switchingAccount && errorType !== 'usage_limit') {
      appendError(error);
    }
    isAborting = false;
    setStreaming(false);
  });
  unsubscribers.push(unsubError);

  // ── IPC: Usage / rate limit reached → propose account switch ──

  const unsubAccountLimit = api.chat.onAccountLimit(async ({ sessionId: sid, error, activeAccountId }) => {
    if (sid !== sessionId) return;
    if (switchingAccount) return;
    switchingAccount = true;
    try {
      const { showAccountSwitchModal } = require('./AccountSwitchModal');
      const newId = await showAccountSwitchModal({
        reason: error || t('accounts.limitReached') || 'Usage limit reached on the active account.',
        activeAccountId
      });
      if (!newId) {
        appendError(error || t('chat.errorOccurred'));
        return;
      }
      // Tell main to close the SDK process so the new credentials take effect
      const prep = await api.chat.prepareSwitchAccount({ sessionId });
      if (!prep.success) {
        appendError(prep.error || 'Failed to prepare session for account switch.');
        return;
      }
      // Re-launch the same session with the new account
      if (!lastStartOpts) {
        appendSystemNotice(t('accounts.switched') || 'Account switched. Send a new message to continue.', 'info');
        sessionId = null;
        return;
      }
      const restartOpts = { ...lastStartOpts, prompt: '', resumeSessionId: sessionId };
      appendSystemNotice(t('accounts.switched') || 'Account switched. Resuming…', 'info');
      setStreaming(true);
      appendThinkingIndicator();
      const res = await api.chat.start(restartOpts);
      if (!res.success) {
        appendError(res.error || t('chat.errorOccurred'));
        setStreaming(false);
      }
    } finally {
      switchingAccount = false;
    }
  });
  unsubscribers.push(unsubAccountLimit);

  // ── IPC: Done ──

  const unsubDone = api.chat.onDone(({ sessionId: sid, interrupted }) => {
    if (sid !== sessionId) return;
    const wasInterrupted = interrupted || isAborting;
    isAborting = false;
    removeThinkingIndicator();
    finalizeStreamBlock();
    resolveAllPendingCards();

    // Fix #4: Show interrupted marker if stream was interrupted
    if (wasInterrupted) {
      const marker = document.createElement('div');
      marker.className = 'chat-interrupted-marker';
      marker.innerHTML = `<span class="chat-interrupted-label">[${escapeHtml(t('chat.interrupted'))}]</span>`;
      messagesEl.appendChild(marker);
      scrollToBottom();
    }

    setStreaming(false);
    // Complete all tool cards
    for (const [, card] of toolCards) {
      completeToolCard(card);
    }
    toolCards.clear();
    // Complete all subagent cards
    for (const [idx, info] of taskToolIndices) {
      completeSubagentCard(info.card);
      taskToolIndices.delete(idx);
    }
  });
  unsubscribers.push(unsubDone);

  // ── IPC: Idle (SDK ready for next message) ──

  // onIdle fires when SDK reads next message from queue (pullCount > 1).
  // In practice this fires BEFORE the response is rendered because the SDK's
  // input reader runs independently from the output stream. So we do NOT
  // reset streaming here — message_stop handles that.
  const unsubIdle = api.chat.onIdle(({ sessionId: sid }) => {
    if (sid !== sessionId) return;
    // Intentionally empty — streaming state managed by message_stop/done/error
  });
  unsubscribers.push(unsubIdle);

  // ── IPC: Remote user message (sent from mobile PWA) ──

  const unsubRemoteMsg = api.remote.onUserMessage(({ sessionId: sid, text, images }) => {
    if (sid !== sessionId) return;
    appendUserMessage(text, images || [], [], isStreaming);
    // Trigger tab rename for remote messages (same logic as _send)
    if (onTabRename && text && !text.startsWith('/') && getSetting('aiTabNaming') !== false) {
      const words = text.split(/\s+/).slice(0, 5).join(' ');
      onTabRename(words.length > 30 ? words.slice(0, 28) + '...' : words);
      if (!tabNamePending) {
        tabNamePending = true;
        api.chat.generateTabName({ userMessage: text }).then(res => {
          if (res?.success && res.name) onTabRename(res.name);
        }).catch(() => {}).finally(() => { tabNamePending = false; });
      }
    }
  });
  unsubscribers.push(unsubRemoteMsg);

  // ── IPC: Initializing (runtime resolution in progress) ──

  let _initSecondaryTimer = null;
  const unsubInitializing = api.chat.onInitializing(({ sessionId: sid }) => {
    if (sid !== sessionId) return;
    // Show initializing indicator in place of thinking indicator
    removeThinkingIndicator();
    const el = document.createElement('div');
    el.className = 'chat-thinking-indicator chat-initializing-indicator';
    el.innerHTML = `
      <img class="chat-thinking-logo" src="assets/claude-mascot.svg" alt="" draggable="false" />
      <span class="chat-thinking-label">${escapeHtml(t('chat.initializing'))}</span>
    `;
    messagesEl.appendChild(el);
    scrollToBottom();
    setStatus('thinking', t('chat.initializing'));
    // After 3s, show secondary message if still initializing
    _initSecondaryTimer = setTimeout(() => {
      const indicator = messagesEl.querySelector('.chat-initializing-indicator');
      if (indicator) {
        const label = indicator.querySelector('.chat-thinking-label');
        if (label) label.textContent = t('chat.initializingRuntime');
      }
    }, 3000);
  });
  unsubscribers.push(unsubInitializing);

  // ── IPC: Permission request ──

  let _permTimers = new Map(); // requestId -> { pulseTimer, notifTimer, counterId }
  const unsubPerm = api.chat.onPermissionRequest((data) => {
    if (data.sessionId !== sessionId) return;
    if (project.isCloud) return; // Cloud sessions bypass permissions
    removeThinkingIndicator();
    appendPermissionCard(data);
    setStatus('waiting', t('chat.waitingForInput') || 'Waiting for input...');

    // Track pending permission on the terminal entry so MCP `tab_status`
    // exposes it and `tab_wait` can resolve on `awaiting_permission`.
    if (terminalId) {
      try {
        let summary = '';
        try {
          const snippet = JSON.stringify(data.input || {});
          summary = snippet.length > 120 ? snippet.slice(0, 117) + '...' : snippet;
        } catch (_) {}
        updateTerminal(terminalId, {
          pendingPermission: {
            requestId: data.requestId,
            tool: data.toolName,
            summary,
            since: Date.now(),
          },
        });
      } catch (_) {}
    }

    // Fix #2: Permission timeout reminders
    const requestId = data.requestId;
    const startTime = Date.now();

    // Counter update interval
    const _findPendingCard = (rid) =>
      messagesEl.querySelector(`.chat-perm-card[data-request-id="${CSS.escape(rid)}"]:not(.resolved)`)
      || messagesEl.querySelector(`.chat-plan-card[data-request-id="${CSS.escape(rid)}"]:not(.resolved)`);

    const counterId = setInterval(() => {
      const card = _findPendingCard(requestId);
      if (!card) { _clearPermTimers(requestId); return; }
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      let counter = card.querySelector('.chat-perm-timer');
      if (!counter) {
        counter = document.createElement('span');
        counter.className = 'chat-perm-timer';
        const header = card.querySelector('.chat-perm-header, .chat-plan-header');
        if (header) header.appendChild(counter);
      }
      counter.textContent = t('chat.permissionWaitingSince', { seconds: elapsed });
    }, 1000);

    // After 30s, pulse the action buttons
    const pulseTimer = setTimeout(() => {
      const card = _findPendingCard(requestId);
      if (card) card.classList.add('perm-attention');
    }, 30000);

    // After 60s, send a system notification (respects user preference)
    const notifTimer = setTimeout(() => {
      if (!isNotificationsEnabled()) return;
      const card = _findPendingCard(requestId);
      if (card) {
        api.notification?.show?.({
          title: t('chat.permissionRequired'),
          body: t('chat.permissionNotification', { tool: data.toolName }),
        });
      }
    }, 60000);

    _permTimers.set(requestId, { pulseTimer, notifTimer, counterId });
  });
  unsubscribers.push(unsubPerm);

  function _clearPermTimers(requestId) {
    const timers = _permTimers.get(requestId);
    if (timers) {
      clearTimeout(timers.pulseTimer);
      clearTimeout(timers.notifTimer);
      clearInterval(timers.counterId);
      _permTimers.delete(requestId);
    }
  }

  // ── Control Tower: question answered externally ──
  // When CT answers an AskUserQuestion, it dispatches this event so we can
  // collapse the card immediately with the real answer instead of a generic fallback.

  function _onCtQuestionAnswered({ detail }) {
    const { requestId, questions, answers } = detail || {};
    if (!requestId) return;
    let card;
    try {
      card = messagesEl.querySelector(`.chat-question-card[data-request-id="${CSS.escape(requestId)}"]`);
    } catch (e) {
      card = Array.from(messagesEl.querySelectorAll('.chat-question-card'))
        .find(c => c.dataset.requestId === requestId);
    }
    if (!card || card.classList.contains('resolved')) return;

    const pairsHtml = Object.entries(answers || {}).map(([q, a]) =>
      `<div class="chat-qa-pair">
        <span class="chat-qa-question">${escapeHtml(q)}</span>
        <span class="chat-qa-answer">${escapeHtml(a)}</span>
      </div>`
    ).join('') || (Array.isArray(questions) ? questions.map(q =>
      `<div class="chat-qa-pair">
        <span class="chat-qa-question">${escapeHtml(q.question || '')}</span>
      </div>`
    ).join('') : '');

    card.classList.add('resolved');
    card.innerHTML = `
      <div class="chat-question-header resolved">
        <div class="chat-perm-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        </div>
        <span>${escapeHtml(t('chat.questionAnswered') || 'Answered')}</span>
      </div>
      <div class="chat-qa-summary">${pairsHtml}</div>
    `;
  }
  document.addEventListener('ct-question-answered', _onCtQuestionAnswered);
  unsubscribers.push(() => document.removeEventListener('ct-question-answered', _onCtQuestionAnswered));

  // If resuming, load and display conversation history
  if (pendingResumeId) {
    const welcomeEl = wrapperEl.querySelector('.chat-welcome');
    if (welcomeEl) {
      welcomeEl.querySelector('.chat-welcome-text').textContent = t('chat.loadingHistory') || 'Loading conversation...';
      welcomeEl.querySelector('.chat-welcome-logo').classList.add('loading-pulse');
    }

    // Load history async then render
    api.chat.loadHistory({ projectPath: project.path, sessionId: pendingResumeId }).then(result => {
      if (welcomeEl) welcomeEl.remove();

      if (result?.success && result.messages?.length > 0) {
        // When forking at a specific message, only show history up to that point
        let msgs = result.messages;
        if (pendingResumeAt) {
          const cutIdx = msgs.findIndex(m => m.uuid === pendingResumeAt);
          if (cutIdx >= 0) msgs = msgs.slice(0, cutIdx + 1);
        }
        renderHistoryMessages(msgs);
      }

      // Show resume/fork divider
      const dividerText = pendingForkSession
        ? (t('chat.forkedFrom') || 'Forked conversation')
        : (t('chat.conversationResumed') || 'Conversation resumed');
      const divider = document.createElement('div');
      divider.className = 'chat-history-divider';
      divider.innerHTML = `<span>${escapeHtml(dividerText)}</span>`;
      messagesEl.appendChild(divider);
      userHasScrolled = false;
      scrollToBottom();
    }).catch(() => {
      if (welcomeEl) {
        welcomeEl.querySelector('.chat-welcome-text').textContent = t('chat.conversationResumed') || 'Conversation resumed — type a message to continue.';
        welcomeEl.querySelector('.chat-welcome-logo').classList.remove('loading-pulse');
      }
    });
  }

  /**
   * Render history messages from JSONL data into the chat UI.
   * Creates static (non-interactive) message elements.
   */
  function renderHistoryMessages(messages) {
    // Build a map of tool_use_id -> tool_result output for enriching tool cards
    const toolResults = new Map();
    for (const msg of messages) {
      if (msg.role === 'tool_result' && msg.toolUseId) {
        toolResults.set(msg.toolUseId, msg.output || '');
      }
    }

    // Batch rendering: build DOM in a fragment, process in chunks to avoid blocking UI
    const BATCH_SIZE = 20;
    let idx = 0;

    function renderBatch() {
      const fragment = document.createDocumentFragment();
      const end = Math.min(idx + BATCH_SIZE, messages.length);

      for (; idx < end; idx++) {
        const msg = messages[idx];
        if (msg.role === 'user') {
          const el = document.createElement('div');
          el.className = 'chat-msg chat-msg-user history';
          let userHtml = '';
          if (msg.images && msg.images.length > 0) {
            userHtml += `<div class="chat-msg-images">${msg.images.map(img => {
              const dataUrl = `data:${img.mediaType || 'image/png'};base64,${img.base64}`;
              return `<img src="${dataUrl}" alt="image" class="chat-msg-image" />`;
            }).join('')}</div>`;
          }
          if (msg.text) {
            userHtml += `<div class="chat-msg-content">${renderMarkdown(msg.text)}</div>`;
          }
          el.innerHTML = userHtml;
          fragment.appendChild(el);

        } else if (msg.role === 'assistant' && msg.type === 'text') {
          const el = document.createElement('div');
          el.className = 'chat-msg chat-msg-assistant history';
          el.innerHTML = `<div class="chat-msg-content">${renderMarkdown(msg.text)}</div>`;
          injectInlineImages(el);
          // Add fork button if message has a UUID (from session JSONL)
          if (msg.uuid && onForkSession) {
            el.dataset.messageUuid = msg.uuid;
            const forkBtn = document.createElement('button');
            forkBtn.className = 'chat-msg-fork-btn';
            forkBtn.title = t('chat.forkSession') || 'Fork from here';
            forkBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/><path d="M6 9a9 9 0 0 0 9 9"/></svg>';
            forkBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              forkFromMessage(msg.uuid);
            });
            el.appendChild(forkBtn);
          }
          fragment.appendChild(el);

        } else if (msg.role === 'assistant' && msg.type === 'thinking') {
          const el = document.createElement('div');
          el.className = 'chat-thinking history';
          el.innerHTML = `
            <div class="chat-thinking-header">
              <svg viewBox="0 0 24 24" fill="currentColor" class="chat-thinking-chevron"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
              <span>${escapeHtml(t('chat.thinking'))}</span>
            </div>
            <div class="chat-thinking-content">${renderMarkdown(msg.text)}</div>
          `;
          fragment.appendChild(el);

        } else if (msg.role === 'assistant' && msg.type === 'tool_use') {
          if (msg.toolName === 'TodoWrite') continue;

          if (msg.toolName === 'Task' || msg.toolName === 'Agent') {
            const input = msg.toolInput || {};
            const name = input.name || input.subagent_type || 'agent';
            const desc = input.description || '';
            const el = document.createElement('div');
            el.className = 'chat-subagent-card completed history';
            el.innerHTML = `
              <div class="chat-subagent-header">
                <div class="chat-subagent-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/>
                    <path d="M6 21V9a9 9 0 0 0 9 9"/>
                  </svg>
                </div>
                <div class="chat-subagent-info">
                  <span class="chat-subagent-type">${escapeHtml(name)}</span>
                  <span class="chat-subagent-desc">${escapeHtml(desc)}</span>
                </div>
                <div class="chat-subagent-status complete">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                </div>
                <svg class="chat-subagent-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
              </div>
              <div class="chat-subagent-body"></div>
            `;
            el.querySelector('.chat-subagent-header').addEventListener('click', () => {
              el.classList.toggle('expanded');
            });
            fragment.appendChild(el);
            continue;
          }

          const detail = getToolDisplayInfo(msg.toolName, msg.toolInput || {});
          const el = document.createElement('div');
          el.className = 'chat-tool-card history';
          el.dataset.toolName = msg.toolName;
          el.title = msg.toolName;
          const truncated = detail && detail.length > 80 ? '...' + detail.slice(-77) : (detail || '');
          el.innerHTML = `
            <div class="chat-tool-icon">${getToolIcon(msg.toolName)}</div>
            <div class="chat-tool-info">
              <span class="chat-tool-name">${formatToolName(msg.toolName)}</span>
              <span class="chat-tool-detail">${truncated ? escapeHtml(truncated) : ''}</span>
            </div>
            <div class="chat-tool-status complete">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
            </div>
          `;

          applyToolColor(el, msg.toolName);
          if (msg.toolUseId) el.dataset.toolUseId = msg.toolUseId;
          if (msg.toolInput) {
            el.dataset.toolInput = JSON.stringify(msg.toolInput);
            el.classList.add('expandable');
          }
          if (msg.toolUseId && toolResults.has(msg.toolUseId)) {
            el.dataset.toolOutput = toolResults.get(msg.toolUseId);
          }

          // Group consecutive same-tool cards in history
          const fragLast = fragment.lastElementChild;
          if (fragLast?.classList.contains('chat-tool-group') && fragLast.dataset.toolName === msg.toolName) {
            fragLast.querySelector('.chat-tool-group-items').appendChild(el);
            _updateGroupBadge(fragLast);
          } else if (fragLast?.classList.contains('chat-tool-card') &&
              fragLast.dataset.toolName === msg.toolName) {
            const group = _makeToolGroup(msg.toolName);
            const gs = group.querySelector('.chat-tool-group-status');
            gs.classList.remove('running'); gs.classList.add('complete');
            gs.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
            fragLast.replaceWith(group);
            group.querySelector('.chat-tool-group-items').appendChild(fragLast);
            group.querySelector('.chat-tool-group-items').appendChild(el);
            _updateGroupBadge(group);
          } else {
            fragment.appendChild(el);
          }
        }
      }

      messagesEl.appendChild(fragment);
      MarkdownRenderer.postProcess(messagesEl);

      if (idx < messages.length) {
        // Schedule next batch during idle time
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(() => renderBatch(), { timeout: 100 });
        } else {
          setTimeout(renderBatch, 0);
        }
      } else {
        userHasScrolled = false;
        scrollToBottom();
      }
    }

    renderBatch();
  }

  // Focus input
  setTimeout(() => {
    inputEl.focus();
    // Auto-submit si un prompt initial est fourni (ex: depuis Remote Control)
    if (initialPrompt) {
      // Inject initial images if provided (from Remote Control camera)
      if (initialImages && initialImages.length) {
        for (const img of initialImages) {
          pendingImages.push({ base64: img.base64, mediaType: img.mediaType, name: 'remote-image', dataUrl: '' });
        }
      }
      setInputText(initialPrompt);
      handleSend();
    }
  }, 100);

  // ── Public API ──

  return {
    destroy() {
      // Emit session recap event before closing (chat-mode sessions only)
      if (recapToolCount >= 2 && project?.id) {
        try {
          const { getEventBus, EVENT_TYPES: ET } = require('../../events');
          getEventBus().emit(ET.SESSION_END, {
            reason: 'chat_close',
            toolCount: recapToolCount,
            toolCounts: recapToolCounts,
            prompts: recapUserPrompts,
            durationMs: Date.now() - recapSessionStartTime
          }, { projectId: project.id, projectPath: project.path || '', source: 'chat' });
        } catch (e) { /* events not ready */ }
      }
      if (sessionId) api.chat.close({ sessionId });
      contextSuggestions.reset();
      followupChips.clear();
      // Clear permission reminder timers
      for (const [id] of _permTimers) _clearPermTimers(id);
      if (_initSecondaryTimer) { clearTimeout(_initSecondaryTimer); _initSecondaryTimer = null; }
      // Trigger CLAUDE.md analysis if enabled and session had exchanges
      if (getSetting('autoClaudeMdUpdate') !== false && conversationHistory.length >= 2 && project?.path) {
        const { showClaudeMdSuggestionModal } = require('./ClaudeMdSuggestionModal');
        api.chat.analyzeSession({ messages: conversationHistory, projectPath: project.path })
          .then(({ suggestions, claudeMdExists }) => {
            if (suggestions && suggestions.length > 0) {
              showClaudeMdSuggestionModal(suggestions, claudeMdExists, project.path);
            }
          })
          .catch(err => console.warn('[ChatView] CLAUDE.md analysis error:', err.message));
      }
      // Trigger workspace KB auto-enrichment if project belongs to a workspace
      if (conversationHistory.length >= 4 && project?.id) {
        try {
          const { getWorkspacesForProject } = require('../../state/workspace.state');
          const Toast = require('./Toast');
          const projectWorkspaces = getWorkspacesForProject(project.id);
          if (projectWorkspaces.length > 0) {
            const ws = projectWorkspaces[0]; // use first workspace
            Toast.showToast({
              message: t('workspace.enrichToast', { name: ws.name }),
              type: 'info',
              duration: 8000,
              action: t('workspace.enrichAction'),
              onAction: () => {
                // Get existing docs summaries
                api.workspace.overview(ws.id).then(ov => {
                  const existingDocs = (ov.docs || []).map(d => ({ title: d.title, summary: d.summary || '' }));
                  return api.chat.analyzeSessionForWorkspace({
                    messages: conversationHistory,
                    workspace: { id: ws.id, name: ws.name, description: ws.description || '' },
                    existingDocs
                  });
                }).then(({ suggestions }) => {
                  if (!suggestions || suggestions.length === 0) {
                    Toast.showToast({ message: t('workspace.enrichNoSuggestions'), type: 'info' });
                    return;
                  }
                  // Apply each suggestion
                  const writes = suggestions.map(s =>
                    api.workspace.writeDoc({ workspaceId: ws.id, title: s.title, content: s.content })
                  );
                  return Promise.all(writes).then(() => {
                    const docTitles = suggestions.map(s => `${s.isUpdate ? '~' : '+'}${s.title}`).join(', ');
                    Toast.showToast({
                      message: t('workspace.enrichDone', { count: suggestions.length, name: ws.name, docs: docTitles }),
                      type: 'success',
                      duration: 8000,
                      action: t('workspace.enrichView'),
                      onAction: () => {
                        // Navigate to workspace panel
                        const wsTab = document.querySelector('[data-tab="workspaces"]');
                        if (wsTab) wsTab.click();
                      }
                    });
                  });
                }).catch(err => {
                  console.warn('[ChatView] Workspace enrichment error:', err.message);
                  Toast.showToast({ message: t('workspace.enrichError'), type: 'error' });
                });
              }
            });
          }
        } catch (e) {
          console.warn('[ChatView] Workspace enrichment check error:', e.message);
        }
      }
      for (const unsub of unsubscribers) {
        if (typeof unsub === 'function') unsub();
      }
      // Cancel pending RAF timers
      if (_streamRafId) { cancelAnimationFrame(_streamRafId); _streamRafId = null; }
      if (_scrollRafId) { cancelAnimationFrame(_scrollRafId); _scrollRafId = null; }
      // Clean up Maps and Sets to free memory
      toolCards.clear();
      toolInputBuffers.clear();
      todoToolIndices.clear();
      taskToolIndices.clear();
      // Clean up parallel run widgets
      for (const [, w] of parallelRunWidgets) {
        if (typeof w.cleanup === 'function') w.cleanup();
      }
      parallelRunWidgets.clear();
      for (const [, w] of parallelPendingWidgets) {
        if (typeof w.cleanup === 'function') w.cleanup();
      }
      parallelPendingWidgets.clear();
      parallelToolIndices.clear();
      // Clean up image data
      pendingImages.length = 0;
      lightboxImages.length = 0;
      // Remove global listeners
      window.removeEventListener('blur', _onShiftBlur);
      document.removeEventListener('click', _closeDropdowns);
      document.removeEventListener('keydown', lightboxKeyHandler);
      if (lightboxEl?.parentNode) lightboxEl.parentNode.removeChild(lightboxEl);
      lightboxEl = null;
      wrapperEl.innerHTML = '';
    },
    getSessionId() {
      return sessionId;
    },
    focus() {
      inputEl?.focus();
    },
    sendMessage(text, images = [], mentions = []) {
      for (const img of images) {
        pendingImages.push({ base64: img.base64, mediaType: img.mediaType, name: img.name || 'visual', dataUrl: '' });
      }
      for (const m of mentions) {
        pendingMentions.push(m);
      }
      setInputText(text);
      handleSend();
    },
    addMentionChip(type, data) {
      addMentionChip(type, data);
      inputEl?.focus();
    }
  };
  }

  destroy() {
    super.destroy();
  }
}

// ── Singleton legacy bridge ──

let _instance = null;
function _getInstance() { if (!_instance) _instance = new ChatView(); return _instance; }

function createChatView(wrapperEl, project, options = {}) {
  return _getInstance().createChatView(wrapperEl, project, options);
}

module.exports = { ChatView, createChatView };
