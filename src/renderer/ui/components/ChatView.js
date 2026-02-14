/**
 * ChatView Component
 * Professional developer-tool chat UI for Claude Agent SDK.
 * Handles streaming, permissions, questions, and tool calls.
 */

const api = window.electron_api;
const { escapeHtml, highlight } = require('../../utils');
const { t } = require('../../i18n');

// ── Markdown Renderer ──

function renderMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);

  // Code blocks with syntax highlighting
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const decoded = unescapeHtml(code.trim());
    const highlighted = lang ? highlight(decoded, lang) : escapeHtml(decoded);
    return `<div class="chat-code-block"><div class="chat-code-header"><span class="chat-code-lang">${lang || 'text'}</span><button class="chat-code-copy" title="Copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button></div><pre><code>${highlighted}</code></pre></div>`;
  });

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
  const { resumeSessionId = null } = options;
  let sessionId = null;
  let isStreaming = false;
  let pendingResumeId = resumeSessionId || null;
  let currentStreamEl = null;
  let currentStreamText = '';
  let currentThinkingEl = null;
  let currentThinkingText = '';
  let model = '';
  let totalCost = 0;
  let totalTokens = 0;
  const toolCards = new Map(); // content_block index -> element
  const toolInputBuffers = new Map(); // content_block index -> accumulated JSON string
  const todoToolIndices = new Set(); // block indices that are TodoWrite tools
  const taskToolIndices = new Map(); // block index -> { card, toolUseId } for Task (subagent) tools
  let blockIndex = 0;
  let currentMsgHasToolUse = false;
  let todoWidgetEl = null; // persistent todo list widget
  const unsubscribers = [];

  // ── Build DOM ──

  wrapperEl.innerHTML = `
    <div class="chat-view">
      <div class="chat-messages">
        <div class="chat-welcome">
          <div class="chat-welcome-sparkle">&#10022;</div>
          <div class="chat-welcome-text">${escapeHtml(t('chat.welcomeMessage') || 'How can I help?')}</div>
        </div>
      </div>
      <div class="chat-input-area">
        <div class="chat-input-wrapper">
          <textarea class="chat-input" placeholder="${escapeHtml(t('chat.placeholder'))}" rows="1"></textarea>
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
            <span class="chat-status-model"></span>
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
  const statusModel = chatView.querySelector('.chat-status-model');
  const statusTokens = chatView.querySelector('.chat-status-tokens');
  const statusCost = chatView.querySelector('.chat-status-cost');

  // ── Input handling ──

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  sendBtn.addEventListener('click', handleSend);
  stopBtn.addEventListener('click', () => {
    if (sessionId) api.chat.interrupt({ sessionId });
  });

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
  });

  // ── Send message ──

  let sendLock = false;

  async function handleSend() {
    const text = inputEl.value.trim();
    if (!text || isStreaming || sendLock) return;

    sendLock = true;
    appendUserMessage(text);
    inputEl.value = '';
    inputEl.style.height = 'auto';
    setStreaming(true);
    appendThinkingIndicator();

    try {
      if (!sessionId) {
        // Assign sessionId BEFORE await to prevent race condition:
        // _processStream fires events immediately, but await returns later.
        sessionId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const startOpts = {
          cwd: project.path,
          prompt: text,
          permissionMode: options.permissionMode || 'default',
          sessionId
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
        const result = await api.chat.send({ sessionId, text });
        if (!result.success) {
          appendError(result.error || t('chat.errorOccurred'));
          setStreaming(false);
        }
      }
    } catch (err) {
      appendError(err.message);
      setStreaming(false);
    } finally {
      sendLock = false;
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

    if (action === 'allow') {
      btn.classList.add('chosen');
      card.classList.add('resolved', 'allowed');
      const inputData = JSON.parse(card.dataset.toolInput || '{}');
      api.chat.respondPermission({
        requestId,
        result: { behavior: 'allow', updatedInput: inputData }
      });
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

    // Collapse after resolution
    setTimeout(() => {
      card.style.maxHeight = card.scrollHeight + 'px';
      requestAnimationFrame(() => {
        card.classList.add('collapsing');
        card.style.maxHeight = '0';
      });
    }, 600);
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
      const contentEl = document.createElement('div');
      contentEl.className = 'chat-tool-content';
      contentEl.innerHTML = formatToolContent(toolName, toolInput);
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

  function formatToolContent(toolName, input) {
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
      return `<div class="chat-diff-viewer">${renderFileLines(input.command || '', '', 1)}</div>`;
    }

    if (name === 'read') {
      const path = input.file_path || '';
      const offset = input.offset || 1;
      const limit = input.limit || '';
      const info = limit ? `lines ${offset}–${offset + parseInt(limit, 10) - 1}` : (offset > 1 ? `from line ${offset}` : '');
      return `<div class="chat-tool-content-path">${escapeHtml(path)}${info ? ` <span class="chat-tool-content-meta">(${info})</span>` : ''}</div>`;
    }

    if (name === 'glob' || name === 'grep') {
      return `<div class="chat-tool-content-path">${escapeHtml(input.file_path || input.pattern || input.path || '')}</div>`;
    }

    // Generic: show JSON
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

  function appendUserMessage(text) {
    const welcome = messagesEl.querySelector('.chat-welcome');
    if (welcome) welcome.remove();
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-user';
    el.innerHTML = `<div class="chat-msg-content">${renderMarkdown(text)}</div>`;
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

  function appendThinkingIndicator() {
    removeThinkingIndicator();
    const el = document.createElement('div');
    el.className = 'chat-thinking-indicator';
    el.innerHTML = `
      <span class="chat-sparkle">&#10022;</span>
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
        ${truncated ? `<span class="chat-tool-detail">${escapeHtml(truncated)}</span>` : ''}
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
      el.innerHTML = `
        <div class="chat-plan-header">
          <div class="chat-plan-icon">${icon}</div>
          <span>${escapeHtml(t('chat.planReady') || 'Plan ready for review')}</span>
        </div>
        <div class="chat-plan-body">
          <p>${escapeHtml(t('chat.planReviewPrompt') || 'Review the plan above and approve or request changes.')}</p>
        </div>
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
    inputEl.disabled = streaming;
    sendBtn.style.display = streaming ? 'none' : '';
    stopBtn.style.display = streaming ? '' : 'none';
    chatView.classList.toggle('streaming', streaming);

    if (streaming) {
      setStatus('thinking', t('chat.thinking'));
    } else {
      setStatus('idle', t('chat.ready') || 'Ready');
    }
  }

  function setStatus(state, text) {
    statusDot.className = `chat-status-dot ${state}`;
    statusTextEl.textContent = text || '';
  }

  function updateStatusInfo() {
    if (model) statusModel.textContent = model;
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

    // System init
    if (message.type === 'system' && message.subtype === 'init') {
      model = message.model || '';
      updateStatusInfo();
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
        const errors = message.errors || [];
        appendError(errors.length ? errors.join('\n') : (message.subtype || 'Unknown error'));
        setStreaming(false);
      }
      return;
    }
  });
  unsubscribers.push(unsubMessage);

  function handleStreamEvent(event) {
    switch (event.type) {
      case 'message_start':
        if (!isStreaming) setStreaming(true);
        setStatus('thinking', t('chat.thinking'));
        blockIndex = 0;
        currentMsgHasToolUse = false;
        toolCards.clear();
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
      // tool_result for a subagent → mark it complete
      if (block.type === 'tool_result') {
        for (const [idx, info] of taskToolIndices) {
          if (info.toolUseId === block.tool_use_id) {
            completeSubagentCard(info.card);
            taskToolIndices.delete(idx);
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
    appendError(error);
    setStreaming(false);
  });
  unsubscribers.push(unsubError);

  // ── IPC: Done ──

  const unsubDone = api.chat.onDone(({ sessionId: sid }) => {
    if (sid !== sessionId) return;
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
