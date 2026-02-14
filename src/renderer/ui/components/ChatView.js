/**
 * ChatView Component
 * Professional developer-tool chat UI for Claude Agent SDK.
 * Handles streaming, permissions, questions, and tool calls.
 */

const api = window.electron_api;
const { escapeHtml, highlight } = require('../../utils');
const { t } = require('../../i18n');
const { recordActivity, recordOutputActivity } = require('../../state');
const { getSetting, setSetting } = require('../../state/settings.state');

const MODEL_OPTIONS = [
  { id: 'claude-opus-4-20250514', label: 'Opus', desc: 'Most capable' },
  { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet', desc: 'Balanced' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku', desc: 'Fast & cheap' },
];

// ── Markdown Renderer ──

function renderMarkdown(text) {
  if (!text) return '';

  // Extract code blocks first to protect them from other transformations
  const codeBlocks = [];
  let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const decoded = code.trim();
    const highlighted = lang ? highlight(decoded, lang) : escapeHtml(decoded);
    const placeholder = `%%CODEBLOCK_${codeBlocks.length}%%`;
    codeBlocks.push(`<div class="chat-code-block"><div class="chat-code-header"><span class="chat-code-lang">${lang || 'text'}</span><button class="chat-code-copy" title="Copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button></div><pre><code>${highlighted}</code></pre></div>`);
    return placeholder;
  });

  // Extract tables before escaping
  const tables = [];
  processed = processed.replace(/((?:^\|.+\|$\n?)+)/gm, (tableBlock) => {
    const rows = tableBlock.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return tableBlock;

    // Check if second row is a separator (|---|---|)
    const sepRow = rows[1].trim();
    if (!/^\|[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)*\|$/.test(sepRow)) return tableBlock;

    const parseRow = (row) => row.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const headers = parseRow(rows[0]);
    // Parse alignment from separator row
    const sepCells = parseRow(rows[1]);
    const aligns = sepCells.map(c => {
      if (c.startsWith(':') && c.endsWith(':')) return 'center';
      if (c.endsWith(':')) return 'right';
      return 'left';
    });
    const bodyRows = rows.slice(2).map(parseRow);

    let tableHtml = '<div class="chat-table-wrapper"><table class="chat-table"><thead><tr>';
    headers.forEach((h, i) => {
      tableHtml += `<th style="text-align:${aligns[i] || 'left'}">${escapeHtml(h)}</th>`;
    });
    tableHtml += '</tr></thead><tbody>';
    bodyRows.forEach(row => {
      tableHtml += '<tr>';
      headers.forEach((_, i) => {
        const cell = row[i] || '';
        tableHtml += `<td style="text-align:${aligns[i] || 'left'}">${escapeHtml(cell)}</td>`;
      });
      tableHtml += '</tr>';
    });
    tableHtml += '</tbody></table></div>';

    const placeholder = `%%TABLE_${tables.length}%%`;
    tables.push(tableHtml);
    return placeholder;
  });

  // Now escape HTML for the rest
  let html = escapeHtml(processed);

  // Inline formatting
  html = html.replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="chat-link" target="_blank">$1</a>');
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');

  // Restore code blocks and tables
  codeBlocks.forEach((block, i) => {
    html = html.replace(`%%CODEBLOCK_${i}%%`, block);
  });
  tables.forEach((table, i) => {
    html = html.replace(`%%TABLE_${i}%%`, table);
  });

  return `<p>${html}</p>`;
}

function unescapeHtml(html) {
  return html.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
}

// ── Tool Icons ──

function getToolIcon(toolName) {
  const name = (toolName || '').toLowerCase();
  if (name.includes('read') || name.includes('file'))
    return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>';
  if (name.includes('write') || name.includes('edit'))
    return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
  if (name.includes('bash') || name.includes('command') || name.includes('exec'))
    return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v12zm-2-1h-6v-2h6v2zM7.5 17l-1.41-1.41L8.67 13l-2.59-2.59L7.5 9l4 4-4 4z"/></svg>';
  if (name.includes('search') || name.includes('grep') || name.includes('glob'))
    return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>';
  if (name === 'askuserquestion')
    return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg>';
  return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/></svg>';
}

// ── Extract display info from tool input ──

function getToolDisplayInfo(toolName, input) {
  if (!input) return '';
  const name = (toolName || '').toLowerCase();
  if (name === 'bash') return input.command || '';
  if (name === 'read' || name === 'write' || name === 'edit') return input.file_path || '';
  if (name === 'grep') return input.pattern || '';
  if (name === 'glob') return input.pattern || '';
  return input.file_path || input.path || input.command || input.query || '';
}

// ── Create Chat View ──

function createChatView(wrapperEl, project, options = {}) {
  const { terminalId = null, resumeSessionId = null, skipPermissions = false, onTabRename = null, onStatusChange = null, onSwitchTerminal = null, onSwitchProject = null } = options;
  let sessionId = null;
  let isStreaming = false;
  let isAborting = false;
  let pendingResumeId = resumeSessionId || null;
  let tabNamePending = false; // avoid concurrent tab name requests
  let currentStreamEl = null;
  let currentStreamText = '';
  let currentThinkingEl = null;
  let currentThinkingText = '';
  let model = '';
  let selectedModel = getSetting('chatModel') || MODEL_OPTIONS[0].id;
  let totalCost = 0;
  let totalTokens = 0;
  const toolCards = new Map(); // content_block index -> element
  const toolInputBuffers = new Map(); // content_block index -> accumulated JSON string
  const todoToolIndices = new Set(); // block indices that are TodoWrite tools
  const taskToolIndices = new Map(); // block index -> { card, toolUseId } for Task (subagent) tools
  let blockIndex = 0;
  let currentMsgHasToolUse = false;
  let turnHadAssistantContent = false; // tracks if current turn displayed any streamed/assistant content
  let todoWidgetEl = null; // persistent todo list widget
  let todoAllDone = false; // tracks if all todos are completed
  let slashCommands = []; // populated from system/init message
  let slashSelectedIndex = -1; // currently highlighted item in slash dropdown
  const unsubscribers = [];

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
          <div class="chat-welcome-text">${escapeHtml(t('chat.welcomeMessage') || 'How can I help?')}</div>
        </div>
      </div>
      <div class="chat-input-area">
        <div class="chat-mention-dropdown" style="display:none"></div>
        <div class="chat-slash-dropdown" style="display:none"></div>
        <div class="chat-mention-chips" style="display:none"></div>
        <div class="chat-image-preview" style="display:none"></div>
        <div class="chat-input-wrapper">
          <button class="chat-attach-btn" title="${escapeHtml(t('chat.attachImage') || 'Attach image')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
          </button>
          <textarea class="chat-input" placeholder="${escapeHtml(t('chat.placeholder'))}" rows="1"></textarea>
          <input type="file" class="chat-file-input" accept="image/png,image/jpeg,image/gif,image/webp" multiple style="display:none" />
          <div class="chat-input-actions">
            <button class="chat-stop-btn" title="Stop" style="display:none">
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
            <span class="chat-status-text">${escapeHtml(t('chat.ready') || 'Ready')}</span>
          </div>
          <div class="chat-footer-right">
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
  const statusTokens = chatView.querySelector('.chat-status-tokens');
  const statusCost = chatView.querySelector('.chat-status-cost');
  const slashDropdown = chatView.querySelector('.chat-slash-dropdown');
  const attachBtn = chatView.querySelector('.chat-attach-btn');
  const fileInput = chatView.querySelector('.chat-file-input');
  const imagePreview = chatView.querySelector('.chat-image-preview');
  const mentionDropdown = chatView.querySelector('.chat-mention-dropdown');
  const mentionChipsEl = chatView.querySelector('.chat-mention-chips');

  // ── Mention state ──

  const pendingMentions = []; // Array of { type, label, icon, data }
  let mentionSelectedIndex = 0;
  let mentionMode = null; // null | 'types' | 'file'
  let mentionFileCache = null; // { files: [], timestamp, projectPath }
  const MENTION_FILE_CACHE_TTL = 5 * 60 * 1000;

  // ── Image attachments ──

  const pendingImages = []; // Array of { base64, mediaType, name, dataUrl }
  const SUPPORTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB

  // ── Model selector ──

  function initModelSelector() {
    const saved = getSetting('chatModel');
    const current = MODEL_OPTIONS.find(m => m.id === saved) || MODEL_OPTIONS[0];
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
  }

  function lockModelSelector() {
    modelBtn.classList.add('locked');
    modelBtn.disabled = true;
  }

  modelBtn.addEventListener('click', (e) => {
    if (sessionId) return; // Locked once session starts
    e.stopPropagation();
    toggleModelDropdown();
  });

  modelDropdown.addEventListener('click', (e) => {
    const opt = e.target.closest('.chat-model-option');
    if (opt) selectModel(opt.dataset.model);
  });

  // Close dropdown on outside click
  document.addEventListener('click', () => {
    modelDropdown.style.display = 'none';
  });

  initModelSelector();

  attachBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) {
      addImageFiles(fileInput.files);
      fileInput.value = '';
    }
  });

  function addImageFiles(files) {
    for (const file of files) {
      if (!SUPPORTED_TYPES.includes(file.type)) continue;
      if (file.size > MAX_IMAGE_SIZE) continue;
      const reader = new FileReader();
      reader.onload = () => {
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
        <button class="chat-image-remove" data-index="${i}" title="Remove">&times;</button>
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
    const files = Array.from(e.dataTransfer.files).filter(f => SUPPORTED_TYPES.includes(f.type));
    if (files.length) addImageFiles(files);
  });

  // Paste images from clipboard
  inputEl.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData.items).filter(i => i.type.startsWith('image/'));
    if (items.length === 0) return;
    e.preventDefault();
    const files = items.map(i => i.getAsFile()).filter(Boolean);
    if (files.length) addImageFiles(files);
  });

  // ── Input handling ──

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
    // Slash commands take precedence (/ at start of line)
    if (inputEl.value.startsWith('/')) {
      hideMentionDropdown();
      updateSlashDropdown();
    } else {
      hideSlashDropdown();
      updateMentionDropdown();
    }
  });

  // Ctrl+Arrow to switch terminals/projects (capture phase to intercept before textarea)
  wrapperEl.addEventListener('keydown', (e) => {
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

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // ── Slash command autocomplete ──

  function updateSlashDropdown() {
    const text = inputEl.value;
    // Show only when text starts with / and cursor is still in the command part
    if (!text.startsWith('/') || text.includes(' ') || text.includes('\n')) {
      hideSlashDropdown();
      return;
    }
    const query = text.slice(1).toLowerCase();
    // Default commands available even before session init
    const builtinDefaults = ['/compact', '/clear', '/help'];
    const available = slashCommands.length > 0 ? slashCommands : builtinDefaults;
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
      '/compact': t('chat.slashCompact') || 'Compact conversation history',
      '/clear': t('chat.slashClear') || 'Clear conversation',
      '/help': t('chat.slashHelp') || 'Show help',
    };
    return descriptions[cmd] || '';
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
    inputEl.value = command;
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
    { type: 'file', label: '@file', desc: t('chat.mentionFile') || 'Attach a file from your project', icon: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>' },
    { type: 'git', label: '@git', desc: t('chat.mentionGit') || 'Attach current git diff', icon: '<svg viewBox="0 0 24 24"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 012 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>' },
    { type: 'terminal', label: '@terminal', desc: t('chat.mentionTerminal') || 'Attach terminal output', icon: '<svg viewBox="0 0 24 24"><polyline points="4,17 10,11 4,5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>' },
    { type: 'errors', label: '@errors', desc: t('chat.mentionErrors') || 'Attach error lines from terminal', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>' },
    { type: 'selection', label: '@selection', desc: t('chat.mentionSelection') || 'Attach selected text', icon: '<svg viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>' },
    { type: 'todos', label: '@todos', desc: t('chat.mentionTodos') || 'Attach TODO items from project', icon: '<svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22,4 12,14.01 9,11.01"/></svg>' },
    { type: 'project', label: '@project', desc: t('chat.mentionProject') || 'Attach current project info', icon: '<svg viewBox="0 0 24 24"><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/></svg>' },
  ];

  function updateMentionDropdown() {
    const text = inputEl.value;
    const cursorPos = inputEl.selectionStart;
    const beforeCursor = text.substring(0, cursorPos);

    // File picker mode: filter files by query after @file
    if (mentionMode === 'file') {
      const fileMatch = beforeCursor.match(/@file\s+(.*)$/i);
      if (fileMatch) {
        renderFileDropdown(fileMatch[1]);
      } else if (!beforeCursor.match(/@file/i)) {
        hideMentionDropdown();
      }
      return;
    }

    // Detect @ trigger
    const atMatch = beforeCursor.match(/@(\w*)$/);
    if (!atMatch) {
      hideMentionDropdown();
      return;
    }

    const query = atMatch[1].toLowerCase();
    const filtered = MENTION_TYPES.filter(m => m.type.includes(query));
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
    const text = inputEl.value;
    const cursorPos = inputEl.selectionStart;
    const beforeCursor = text.substring(0, cursorPos);
    const afterCursor = text.substring(cursorPos);
    // Remove @word (or @file query) before cursor
    const cleaned = beforeCursor.replace(/@\w*\s*$/, '');
    inputEl.value = cleaned + afterCursor;
    inputEl.selectionStart = inputEl.selectionEnd = cleaned.length;
  }

  function selectMentionType(type) {
    if (type === 'file') {
      // Switch to file picker mode — replace @partial with @file and wait for query
      const text = inputEl.value;
      const cursorPos = inputEl.selectionStart;
      const beforeCursor = text.substring(0, cursorPos);
      const afterCursor = text.substring(cursorPos);
      const cleaned = beforeCursor.replace(/@\w*$/, '@file ');
      inputEl.value = cleaned + afterCursor;
      inputEl.selectionStart = inputEl.selectionEnd = cleaned.length;
      mentionMode = 'file';
      renderFileDropdown('');
      inputEl.focus();
      return;
    }

    // Direct mention types — add chip immediately
    removeAtTrigger();
    addMentionChip(type);
    hideMentionDropdown();
    inputEl.focus();
  }

  // ── File picker ──

  function scanProjectFiles(projectPath) {
    const { fs, path } = window.electron_nodeModules;
    const files = [];
    const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'vendor', '.cache', 'coverage', '.nuxt']);

    function scan(dir, depth) {
      if (depth > 6 || files.length >= 500) return;
      try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          if (files.length >= 500) break;
          if (entry.startsWith('.') && entry !== '.env') continue;
          if (ignoreDirs.has(entry)) continue;
          const fullPath = path.join(dir, entry);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              scan(fullPath, depth + 1);
            } else if (stat.isFile()) {
              files.push({ path: path.relative(projectPath, fullPath).replace(/\\/g, '/'), fullPath, mtime: stat.mtimeMs });
            }
          } catch (e) { /* skip inaccessible */ }
        }
      } catch (e) { /* skip inaccessible */ }
    }

    scan(projectPath, 0);
    files.sort((a, b) => b.mtime - a.mtime);
    return files;
  }

  function getFileCache() {
    const projectPath = project?.path;
    if (!projectPath) return [];
    if (mentionFileCache && mentionFileCache.projectPath === projectPath && Date.now() - mentionFileCache.timestamp < MENTION_FILE_CACHE_TTL) {
      return mentionFileCache.files;
    }
    const files = scanProjectFiles(projectPath);
    mentionFileCache = { files, timestamp: Date.now(), projectPath };
    return files;
  }

  function renderFileDropdown(query) {
    const files = getFileCache();
    const q = query.trim().toLowerCase();
    const filtered = q ? files.filter(f => f.path.toLowerCase().includes(q)) : files;
    const shown = filtered.slice(0, 40);

    if (shown.length === 0) {
      mentionDropdown.innerHTML = `<div class="chat-mention-item" style="opacity:0.5;cursor:default"><span class="chat-mention-item-desc">${escapeHtml(t('chat.mentionNoFiles') || 'No files found')}</span></div>`;
      mentionDropdown.style.display = '';
      return;
    }

    mentionMode = 'file';
    if (mentionSelectedIndex >= shown.length) mentionSelectedIndex = shown.length - 1;

    const { path: pathModule } = window.electron_nodeModules;
    mentionDropdown.innerHTML = shown.map((file, i) => `
      <div class="chat-mention-item${i === mentionSelectedIndex ? ' active' : ''}" data-path="${escapeHtml(file.path)}" data-fullpath="${escapeHtml(file.fullPath)}">
        <span class="chat-mention-item-icon"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg></span>
        <span class="chat-mention-item-path">${escapeHtml(file.path)}</span>
      </div>
    `).join('');

    mentionDropdown.style.display = '';

    mentionDropdown.querySelectorAll('.chat-mention-item').forEach((el, idx) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (el.dataset.path) selectMentionFile(el.dataset.path, el.dataset.fullpath);
      });
      el.addEventListener('mouseenter', () => {
        mentionSelectedIndex = idx;
        highlightMentionItem(mentionDropdown.querySelectorAll('.chat-mention-item'));
      });
    });
  }

  function selectMentionFile(relativePath, fullPath) {
    removeAtTrigger();
    addMentionChip('file', { path: relativePath, fullPath });
    hideMentionDropdown();
    inputEl.focus();
  }

  // ── Mention chips ──

  function getMentionIcon(type) {
    const found = MENTION_TYPES.find(m => m.type === type);
    return found ? found.icon : '';
  }

  function addMentionChip(type, data = null) {
    const label = type === 'file' ? `@${data.path}` : `@${type}`;
    pendingMentions.push({ type, label, icon: getMentionIcon(type), data });
    renderMentionChips();
  }

  function removeMention(index) {
    pendingMentions.splice(index, 1);
    renderMentionChips();
  }

  function renderMentionChips() {
    if (pendingMentions.length === 0) {
      mentionChipsEl.style.display = 'none';
      mentionChipsEl.innerHTML = '';
      return;
    }
    mentionChipsEl.style.display = 'flex';
    mentionChipsEl.innerHTML = pendingMentions.map((chip, i) => `
      <div class="chat-mention-chip" data-index="${i}">
        <span class="chat-mention-chip-icon">${chip.icon}</span>
        <span class="chat-mention-chip-label">${escapeHtml(chip.label)}</span>
        <button class="chat-mention-chip-remove" data-index="${i}" title="Remove">&times;</button>
      </div>
    `).join('');
    mentionChipsEl.querySelectorAll('.chat-mention-chip-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeMention(parseInt(btn.dataset.index));
      });
    });
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
            const raw = fs.readFileSync(mention.data.fullPath, 'utf8');
            const lines = raw.split('\n');
            if (lines.length > 500) {
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

        case 'project': {
          try {
            const parts = [`Project: ${project.name || 'Unknown'}`, `Path: ${project.path}`];
            // Git info
            const [branch, status, stats] = await Promise.all([
              api.git.currentBranch({ projectPath: project.path }).catch(() => null),
              api.git.statusDetailed({ projectPath: project.path }).catch(() => null),
              api.project.stats(project.path).catch(() => null),
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
            content = parts.join('\n');
          } catch (e) {
            content = `Project: ${project.name || 'Unknown'}\nPath: ${project.path}\n[Error fetching details: ${e.message}]`;
          }
          break;
        }
      }

      resolved.push({ label: mention.label, content });
    }

    return resolved;
  }

  function extractTerminalLines(maxLines) {
    // Access active terminal's xterm.js buffer via state
    try {
      const { getActiveTerminal, getTerminal, getTerminalsForProject } = require('../../state');
      const { getProjectIndex } = require('../../state');

      // Try active terminal first, then find one for this project
      let termData = null;
      const activeId = getActiveTerminal();
      if (activeId != null) {
        const t = getTerminal(activeId);
        if (t?.projectIndex === getProjectIndex(project?.id)) termData = t;
      }
      if (!termData) {
        const projectTerminals = getTerminalsForProject(getProjectIndex(project?.id));
        if (projectTerminals.length > 0) termData = getTerminal(projectTerminals[0].id);
      }

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
  });

  // ── Send message ──

  let sendLock = false;

  async function handleSend() {
    const text = inputEl.value.trim();
    const hasImages = pendingImages.length > 0;
    const hasMentions = pendingMentions.length > 0;
    if ((!text && !hasImages && !hasMentions) || sendLock) return;

    sendLock = true;
    if (project?.id) recordActivity(project.id);

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

    const isQueued = isStreaming && sessionId;
    appendUserMessage(text, images, mentions, isQueued);
    inputEl.value = '';
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
        lockModelSelector();
        const startOpts = {
          cwd: project.path,
          prompt: text || '',
          permissionMode: skipPermissions ? 'bypassPermissions' : 'default',
          sessionId,
          images: imagesPayload,
          mentions: resolvedMentions,
          model: selectedModel
        };
        if (pendingResumeId) {
          startOpts.resumeSessionId = pendingResumeId;
          pendingResumeId = null;
        }
        const result = await api.chat.start(startOpts);
        if (!result.success) {
          sessionId = null;
          appendError(result.error || t('chat.errorOccurred'));
          setStreaming(false);
        }
      } else {
        const result = await api.chat.send({ sessionId, text, images: imagesPayload, mentions: resolvedMentions });
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
    if (onTabRename && !text.startsWith('/')) {
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

  function handlePermissionClick(btn) {
    const card = btn.closest('.chat-perm-card');
    if (!card) return;
    const requestId = card.dataset.requestId;
    const action = btn.dataset.action;

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
        // Tell SDK to switch session to bypassPermissions mode
        result.updatedPermissions = [{
          type: 'setMode',
          mode: 'bypassPermissions',
          destination: 'session'
        }];
        // Also set alwaysAllow flag on ChatService as fallback
        api.chat.alwaysAllow({ sessionId });
      }
      api.chat.respondPermission({ requestId, result });
    } else {
      btn.classList.add('chosen');
      card.classList.add('resolved', 'denied');
      api.chat.respondPermission({
        requestId,
        result: { behavior: 'deny', message: 'User denied this action' }
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

    card.querySelectorAll('.chat-plan-btn').forEach(b => {
      b.disabled = true;
      b.classList.add('disabled');
    });

    if (action === 'allow') {
      btn.classList.add('chosen');
      card.classList.add('resolved', 'approved');
      const inputData = JSON.parse(card.dataset.toolInput || '{}');
      api.chat.respondPermission({
        requestId,
        result: { behavior: 'allow', updatedInput: inputData }
      });
    } else {
      btn.classList.add('chosen');
      card.classList.add('resolved', 'rejected');
      api.chat.respondPermission({
        requestId,
        result: { behavior: 'deny', message: 'User rejected the plan' }
      });
    }

    // Reset status — SDK will continue processing
    setStatus('thinking', t('chat.thinking'));

    // Collapse: if ExitPlanMode with plan content, keep the plan visible and only hide buttons
    const isExitPlan = card.dataset.toolName === 'ExitPlanMode' && card.querySelector('.chat-plan-content');
    if (isExitPlan) {
      setTimeout(() => {
        const actions = card.querySelector('.chat-plan-actions');
        if (actions) {
          actions.style.maxHeight = actions.scrollHeight + 'px';
          actions.style.overflow = 'hidden';
          actions.style.transition = 'max-height 0.35s ease, opacity 0.3s, padding 0.35s';
          requestAnimationFrame(() => {
            actions.style.maxHeight = '0';
            actions.style.opacity = '0';
            actions.style.padding = '0 16px';
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

  function toggleToolCard(card) {
    const existing = card.querySelector('.chat-tool-content');
    if (existing) {
      card.classList.toggle('expanded');
      return;
    }

    const inputStr = card.dataset.toolInput;
    if (!inputStr) return;

    try {
      const toolInput = JSON.parse(inputStr);
      const toolName = card.querySelector('.chat-tool-name')?.textContent || '';
      const output = card.dataset.toolOutput || '';
      const contentEl = document.createElement('div');
      contentEl.className = 'chat-tool-content';
      contentEl.innerHTML = formatToolContent(toolName, toolInput, output);
      card.appendChild(contentEl);
      card.classList.add('expanded');
      scrollToBottom();
    } catch (e) { /* ignore */ }
  }

  /**
   * Find the real line number of a string in a file
   */
  function getLineOffset(filePath, searchStr) {
    try {
      // Use window.require to access Node fs at runtime (Electron nodeIntegration)
      const fs = window.require('fs');
      const content = fs.readFileSync(filePath, 'utf8');
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

  function formatToolContent(toolName, input, output) {
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
      const startLine = path ? getLineOffset(path, oldStr) : 1;
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
      if (output) {
        const lines = output.split('\n');
        const maxLines = 30;
        const truncated = lines.length > maxLines;
        const displayLines = truncated ? lines.slice(0, maxLines) : lines;
        return `<div class="chat-tool-output"><pre>${escapeHtml(displayLines.join('\n'))}${truncated ? `\n… (${lines.length - maxLines} more lines)` : ''}</pre></div>`;
      }
      const path = input.file_path || '';
      const offset = input.offset || 1;
      const limit = input.limit || '';
      const info = limit ? `lines ${offset}–${offset + parseInt(limit, 10) - 1}` : (offset > 1 ? `from line ${offset}` : '');
      return `<div class="chat-tool-content-path">${escapeHtml(path)}${info ? ` <span class="chat-tool-content-meta">(${info})</span>` : ''}</div>`;
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

    card.classList.add('resolved');
    card.querySelectorAll('.chat-question-option, .chat-question-submit').forEach(b => b.disabled = true);

    api.chat.respondPermission({
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

  function appendUserMessage(text, images = [], mentions = [], queued = false) {
    const welcome = messagesEl.querySelector('.chat-welcome');
    if (welcome) welcome.remove();
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-user';
    if (queued) el.classList.add('queued');
    let html = '';
    if (queued) {
      html += `<span class="chat-msg-queued-badge">${escapeHtml(t('chat.queued') || 'Queued')}</span>`;
    }
    if (mentions.length > 0) {
      html += `<div class="chat-msg-mentions">${mentions.map(m =>
        `<span class="chat-msg-mention-tag">${m.icon}<span>${escapeHtml(m.label)}</span></span>`
      ).join('')}</div>`;
    }
    if (images.length > 0) {
      html += `<div class="chat-msg-images">${images.map(img =>
        `<img src="${img.dataUrl}" alt="${escapeHtml(img.name || 'image')}" class="chat-msg-image" />`
      ).join('')}</div>`;
    }
    if (text) {
      html += `<div class="chat-msg-content">${renderMarkdown(text)}</div>`;
    }
    el.innerHTML = html;
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

  function startStreamBlock() {
    removeThinkingIndicator();
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-assistant';
    el.innerHTML = `<div class="chat-msg-content"><span class="chat-cursor"></span></div>`;
    messagesEl.appendChild(el);
    scrollToBottom();
    currentStreamEl = el.querySelector('.chat-msg-content');
    currentStreamText = '';
    return el;
  }

  function appendStreamDelta(text) {
    currentStreamText += text;
    if (currentStreamEl) {
      currentStreamEl.innerHTML = renderMarkdown(currentStreamText) + '<span class="chat-cursor"></span>';
      scrollToBottom();
    }
  }

  function finalizeStreamBlock() {
    if (currentStreamEl && currentStreamText) {
      currentStreamEl.innerHTML = renderMarkdown(currentStreamText);
    }
    currentStreamEl = null;
    currentStreamText = '';
  }

  function appendToolCard(toolName, detail) {
    const el = document.createElement('div');
    el.className = 'chat-tool-card';
    const truncated = detail && detail.length > 80 ? '...' + detail.slice(-77) : (detail || '');
    el.innerHTML = `
      <div class="chat-tool-icon">${getToolIcon(toolName)}</div>
      <div class="chat-tool-info">
        <span class="chat-tool-name">${escapeHtml(toolName)}</span>
        <span class="chat-tool-detail">${truncated ? escapeHtml(truncated) : ''}</span>
      </div>
      <div class="chat-tool-status running"><div class="chat-tool-spinner"></div></div>
    `;
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

  function completeSubagentCard(el) {
    if (!el) return;
    const status = el.querySelector('.chat-subagent-status');
    if (status) {
      status.classList.remove('running');
      status.classList.add('complete');
      status.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
    }
    el.classList.add('done');
    // Clear live activity text
    const activityEl = el.querySelector('.chat-subagent-activity');
    if (activityEl) activityEl.textContent = '';
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

  /**
   * Route a message from a subagent to the appropriate handler
   */
  function handleSubagentMessage(info, message) {
    if (message.type === 'stream_event' && message.event) {
      handleSubagentStreamEvent(info, message.event);
      return;
    }
    if (message.type === 'assistant') {
      handleSubagentAssistant(info, message);
      return;
    }
    // Subagent finished — mark card as done individually
    if (message.type === 'result') {
      completeSubagentCard(info.card);
      // Remove from tracking
      for (const [idx, tracked] of taskToolIndices) {
        if (tracked === info) { taskToolIndices.delete(idx); break; }
      }
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
          mini.innerHTML = `
            <div class="sa-tool-icon">${getToolIcon(block.name)}</div>
            <span class="sa-tool-name">${escapeHtml(block.name)}</span>
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

        if (jsonStr && mini) {
          info.subBuffers.delete(stopIdx);
          try {
            const toolInput = JSON.parse(jsonStr);
            const name = mini.querySelector('.sa-tool-name')?.textContent || '';
            const detail = getToolDisplayInfo(name, toolInput);
            const detailEl = mini.querySelector('.sa-tool-detail');
            if (detailEl && detail) {
              detailEl.textContent = detail.length > 60 ? '...' + detail.slice(-57) : detail;
            }
          } catch (e) { /* partial JSON */ }

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
        // Update the mini tool card with complete input info if not already done
        const detail = getToolDisplayInfo(block.name, block.input);
        // Update activity
        info.activityEl.textContent = `${block.name}...`;

        // Check if we already have a mini card for this — if not, add one
        let found = false;
        for (const [, mini] of info.subTools) {
          const nameEl = mini.querySelector('.sa-tool-name');
          if (nameEl && nameEl.textContent === block.name && !mini.classList.contains('has-detail')) {
            const detailEl = mini.querySelector('.sa-tool-detail');
            if (detailEl && detail) {
              detailEl.textContent = detail.length > 60 ? '...' + detail.slice(-57) : detail;
            }
            mini.classList.add('has-detail');
            found = true;
            break;
          }
        }

        if (!found) {
          // Subagent tool not yet in body — add it
          const mini = document.createElement('div');
          mini.className = 'sa-tool has-detail';
          const truncated = detail && detail.length > 60 ? '...' + detail.slice(-57) : (detail || '');
          mini.innerHTML = `
            <div class="sa-tool-icon">${getToolIcon(block.name)}</div>
            <span class="sa-tool-name">${escapeHtml(block.name)}</span>
            <span class="sa-tool-detail">${escapeHtml(truncated)}</span>
            <div class="sa-tool-status"><div class="chat-tool-spinner"></div></div>
          `;
          info.bodyEl.appendChild(mini);
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
        <div class="td-track"><div class="td-fill${allDone ? ' td-fill-done' : ''}" style="width:${pct}%"></div></div>
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

  function appendPermissionCard(data) {
    const { requestId, toolName, input, decisionReason } = data;

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
          <span class="chat-perm-tool-name">${escapeHtml(toolName)}</span>
          ${detail ? `<code class="chat-perm-tool-detail">${escapeHtml(detail.length > 100 ? '...' + detail.slice(-97) : detail)}</code>` : ''}
        </div>
        ${decisionReason ? `<p class="chat-perm-reason">${escapeHtml(decisionReason)}</p>` : ''}
      </div>
      <div class="chat-perm-actions">
        <button class="chat-perm-btn allow" data-action="allow">${escapeHtml(allowText)}</button>
        <button class="chat-perm-btn always-allow" data-action="always-allow">${escapeHtml(alwaysAllowText)}</button>
        <button class="chat-perm-btn deny" data-action="deny">${escapeHtml(denyText)}</button>
      </div>
    `;
    messagesEl.appendChild(el);
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
      const optionsHtml = (q.options || []).map(opt =>
        `<button class="chat-question-option" data-label="${escapeHtml(opt.label)}">
          <span class="chat-qo-label">${escapeHtml(opt.label)}</span>
          <span class="chat-qo-desc">${escapeHtml(opt.description || '')}</span>
        </button>`
      ).join('');

      questionsHtml += `
        <div class="chat-question-group${i === 0 ? ' active' : ''}" data-step="${i}">
          <p class="chat-question-text">${escapeHtml(q.question)}</p>
          <div class="chat-question-options">${optionsHtml}</div>
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
      // Grab the last assistant message content and move it into the plan card
      let planContent = '';
      const allMessages = messagesEl.querySelectorAll('.chat-msg-assistant');
      if (allMessages.length > 0) {
        const lastMsg = allMessages[allMessages.length - 1];
        const contentEl = lastMsg.querySelector('.chat-msg-content');
        if (contentEl) {
          planContent = contentEl.innerHTML;
          lastMsg.style.display = 'none';
        }
      }

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
      `;
    }

    messagesEl.appendChild(el);
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }

  // ── State management ──

  function setStreaming(streaming) {
    isStreaming = streaming;
    stopBtn.style.display = streaming ? '' : 'none';
    chatView.classList.toggle('streaming', streaming);

    if (streaming) {
      inputEl.placeholder = t('chat.queuePlaceholder') || 'Queue a follow-up message...';
      setStatus('thinking', t('chat.thinking'));
    } else {
      inputEl.placeholder = t('chat.placeholder');
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
    if (totalTokens > 0) statusTokens.textContent = `${totalTokens.toLocaleString()} tokens`;
    if (totalCost > 0) statusCost.textContent = `$${totalCost.toFixed(4)}`;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    });
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
        model = message.model || '';
        updateStatusInfo();
        // Capture available slash commands for autocomplete
        if (message.slash_commands && Array.isArray(message.slash_commands)) {
          slashCommands = message.slash_commands;
        }
      } else if (message.subtype === 'compact_boundary') {
        removeThinkingIndicator();
        const preTokens = message.compact_metadata?.pre_tokens;
        const notice = preTokens
          ? t('chat.compacted', { tokens: preTokens.toLocaleString() }) || `Conversation compacted (${preTokens.toLocaleString()} tokens before)`
          : t('chat.compactedSimple') || 'Conversation compacted';
        appendSystemNotice(notice, 'compact');
        setStreaming(false);
      }
      return;
    }

    // Full assistant message (backup for non-streaming or tool use detection)
    if (message.type === 'assistant') {
      handleAssistantMessage(message);
      return;
    }

    // Result — update stats. Also detect SDK errors.
    if (message.type === 'result') {
      if (message.total_cost_usd != null) totalCost = message.total_cost_usd;
      if (message.usage) {
        totalTokens = (message.usage.input_tokens || 0) + (message.usage.output_tokens || 0);
      }
      if (message.model) model = message.model;
      updateStatusInfo();

      // Handle SDK errors (error_during_execution, error_max_turns, etc.)
      if (message.is_error || (message.subtype && message.subtype !== 'success')) {
        removeThinkingIndicator();
        finalizeStreamBlock();
        if (!isAborting) {
          const errors = message.errors || [];
          appendError(errors.length ? errors.join('\n') : (message.subtype || 'Unknown error'));
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

  // Throttled output activity tracker (max 1 call/sec)
  let outputActivityThrottled = false;
  function trackOutputActivity() {
    if (!project?.id || outputActivityThrottled) return;
    recordOutputActivity(project.id);
    outputActivityThrottled = true;
    setTimeout(() => { outputActivityThrottled = false; }, 1000);
  }

  function handleStreamEvent(event) {
    switch (event.type) {
      case 'message_start':
        if (!isStreaming) setStreaming(true);
        setStatus('thinking', t('chat.thinking'));
        blockIndex = 0;
        currentMsgHasToolUse = false;
        turnHadAssistantContent = false;
        toolCards.clear();
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
          const blockIdx = event.index ?? blockIndex;
          // TodoWrite, Task & AskUserQuestion get special UI — no generic tool card
          if (block.name === 'TodoWrite') {
            todoToolIndices.add(blockIdx);
          } else if (block.name === 'Task') {
            const card = appendSubagentCard();
            const bodyEl = card.querySelector('.chat-subagent-body');
            const activityEl = card.querySelector('.chat-subagent-activity');
            taskToolIndices.set(blockIdx, {
              card, toolUseId: block.id, bodyEl, activityEl,
              subTools: new Map(), subBuffers: new Map(), subBlockIndex: 0
            });
            setStatus('working', t('chat.subagentRunning') || 'Agent running...');
          } else if (block.name !== 'AskUserQuestion') {
            const card = appendToolCard(block.name, '');
            if (block.id) card.dataset.toolUseId = block.id;
            toolCards.set(blockIdx, card);
          }
          toolInputBuffers.set(blockIdx, '');
          if (block.name !== 'Task') setStatus('working', `${block.name}...`);
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

            const card = toolCards.get(stopIdx);
            if (card) {
              card.dataset.toolInput = JSON.stringify(toolInput);
              card.classList.add('expandable');
              // Update detail text with parsed info
              const name = card.querySelector('.chat-tool-name')?.textContent || '';
              const info = getToolDisplayInfo(name, toolInput);
              const detailEl = card.querySelector('.chat-tool-detail');
              if (detailEl && info) {
                detailEl.textContent = info.length > 80 ? '...' + info.slice(-77) : info;
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
        if (!currentMsgHasToolUse) {
          // Turn is complete (no tool use) — reset streaming
          setStreaming(false);
          for (const [, card] of toolCards) {
            completeToolCard(card);
          }
          // Complete any remaining subagent cards
          for (const [idx, info] of taskToolIndices) {
            completeSubagentCard(info.card);
            taskToolIndices.delete(idx);
          }
        }
        break;
    }
  }

  function handleAssistantMessage(msg) {
    const content = msg.message?.content;
    if (!content) return;

    let hasToolUse = false;
    for (const block of content) {
      if (block.type === 'tool_use') {
        // TodoWrite — update widget instead of tool card
        if (block.name === 'TodoWrite' && block.input?.todos) {
          updateTodoWidget(block.input.todos);
          continue;
        }
        // Task (subagent) — update subagent card from assistant message
        if (block.name === 'Task' && block.input) {
          for (const [, info] of taskToolIndices) {
            updateSubagentCard(info.card, block.input);
          }
          hasToolUse = true;
          continue;
        }
        hasToolUse = true;
        // Mark tool cards as complete
        for (const [, card] of toolCards) {
          completeToolCard(card);
        }
      }
      // tool_result → store output on matching tool card, or mark subagent complete
      if (block.type === 'tool_result') {
        // Subagent cards
        for (const [idx, info] of taskToolIndices) {
          if (info.toolUseId === block.tool_use_id) {
            completeSubagentCard(info.card);
            taskToolIndices.delete(idx);
            break;
          }
        }
        // Regular tool cards — store output for expand view
        for (const [, card] of toolCards) {
          if (card.dataset.toolUseId === block.tool_use_id) {
            const output = typeof block.content === 'string' ? block.content
              : Array.isArray(block.content) ? block.content.map(b => b.text || '').join('\n') : '';
            if (output) card.dataset.toolOutput = output;
            break;
          }
        }
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
   * Mark all unresolved permission/question cards as failed
   */
  function resolveAllPendingCards() {
    messagesEl.querySelectorAll('.chat-perm-card:not(.resolved), .chat-question-card:not(.resolved), .chat-plan-card:not(.resolved)').forEach(card => {
      card.classList.add('resolved');
      card.querySelectorAll('button').forEach(b => b.disabled = true);
    });
  }

  // ── IPC: Error ──

  const unsubError = api.chat.onError(({ sessionId: sid, error }) => {
    if (sid !== sessionId) return;
    removeThinkingIndicator();
    finalizeStreamBlock();
    resolveAllPendingCards();
    if (!isAborting) {
      appendError(error);
    }
    isAborting = false;
    setStreaming(false);
  });
  unsubscribers.push(unsubError);

  // ── IPC: Done ──

  const unsubDone = api.chat.onDone(({ sessionId: sid }) => {
    if (sid !== sessionId) return;
    isAborting = false;
    removeThinkingIndicator();
    finalizeStreamBlock();
    setStreaming(false);
    // Complete all tool cards
    for (const [, card] of toolCards) {
      completeToolCard(card);
    }
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

  // ── IPC: Permission request ──

  const unsubPerm = api.chat.onPermissionRequest((data) => {
    if (data.sessionId !== sessionId) return;
    removeThinkingIndicator();
    appendPermissionCard(data);
    setStatus('waiting', t('chat.waitingForInput') || 'Waiting for input...');
  });
  unsubscribers.push(unsubPerm);

  // If resuming, show a notice instead of welcome message
  if (pendingResumeId) {
    const welcomeEl = wrapperEl.querySelector('.chat-welcome');
    if (welcomeEl) {
      welcomeEl.querySelector('.chat-welcome-text').textContent = t('chat.conversationResumed') || 'Conversation resumed — type a message to continue.';
    }
  }

  // Focus input
  setTimeout(() => inputEl.focus(), 100);

  // ── Public API ──

  return {
    destroy() {
      if (sessionId) api.chat.close({ sessionId });
      for (const unsub of unsubscribers) {
        if (typeof unsub === 'function') unsub();
      }
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
    }
  };
}

module.exports = { createChatView };
