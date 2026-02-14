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
  let sessionId = null;
  let isStreaming = false;
  let currentStreamEl = null;
  let currentStreamText = '';
  let currentThinkingEl = null;
  let currentThinkingText = '';
  let model = '';
  let totalCost = 0;
  let totalTokens = 0;
  const toolCards = new Map(); // content_block index -> element
  let blockIndex = 0;
  let currentMsgHasToolUse = false;
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

    const permBtn = e.target.closest('.chat-perm-btn');
    if (permBtn) {
      handlePermissionClick(permBtn);
      return;
    }
  });

  // ── Send message ──

  async function handleSend() {
    const text = inputEl.value.trim();
    if (!text || isStreaming) return;

    appendUserMessage(text);
    inputEl.value = '';
    inputEl.style.height = 'auto';
    setStreaming(true);
    appendThinkingIndicator();

    try {
      if (!sessionId) {
        const result = await api.chat.start({
          cwd: project.path,
          prompt: text,
          permissionMode: options.permissionMode || 'default'
        });
        if (result.success) {
          sessionId = result.sessionId;
        } else {
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
    }
  }

  // ── Permission handling ──

  function handlePermissionClick(btn) {
    const card = btn.closest('.chat-perm-card');
    if (!card) return;
    const requestId = card.dataset.requestId;
    const toolName = card.dataset.toolName;
    const action = btn.dataset.action;

    // Disable buttons
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

    const detail = getToolDisplayInfo(toolName, input);
    const el = document.createElement('div');
    el.className = 'chat-perm-card';
    el.dataset.requestId = requestId;
    el.dataset.toolName = toolName;
    el.dataset.toolInput = JSON.stringify(input || {});

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
        <button class="chat-perm-btn allow" data-action="allow">${escapeHtml(t('chat.allow') || 'Allow')}</button>
        <button class="chat-perm-btn deny" data-action="deny">${escapeHtml(t('chat.deny') || 'Deny')}</button>
      </div>
    `;
    messagesEl.appendChild(el);
    scrollToBottom();
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
    scrollToBottom();

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
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  // ── IPC: SDK Messages ──

  const unsubMessage = api.chat.onMessage(({ sessionId: sid, message }) => {
    if (sid !== sessionId) return;

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

    // Result - marks end of a turn
    if (message.type === 'result') {
      if (message.total_cost_usd != null) totalCost = message.total_cost_usd;
      if (message.usage) {
        totalTokens = (message.usage.input_tokens || 0) + (message.usage.output_tokens || 0);
      }
      if (message.model) model = message.model;
      updateStatusInfo();
      removeThinkingIndicator();
      finalizeStreamBlock();
      setStreaming(false);
      for (const [, card] of toolCards) {
        completeToolCard(card);
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
          // Don't show tool card for AskUserQuestion - the question card handles it
          if (block.name !== 'AskUserQuestion') {
            const card = appendToolCard(block.name, '');
            toolCards.set(event.index ?? blockIndex, card);
          }
          setStatus('working', `${block.name}...`);
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
          // Accumulate tool input JSON - update tool card detail
          const idx = event.index ?? (blockIndex - 1);
          const card = toolCards.get(idx);
          if (card) {
            // We could parse partial JSON here, but it's complex. Skip.
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
        // If no tool_use in this message, the turn is done
        if (!currentMsgHasToolUse) {
          setStreaming(false);
          for (const [, card] of toolCards) {
            completeToolCard(card);
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
        hasToolUse = true;
        // Mark tool cards as complete
        for (const [, card] of toolCards) {
          completeToolCard(card);
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

  // ── IPC: Error ──

  const unsubError = api.chat.onError(({ sessionId: sid, error }) => {
    if (sid !== sessionId) return;
    removeThinkingIndicator();
    finalizeStreamBlock();
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
  });
  unsubscribers.push(unsubDone);

  // ── IPC: Idle (SDK ready for next message) ──

  const unsubIdle = api.chat.onIdle(({ sessionId: sid }) => {
    if (sid !== sessionId) return;
    removeThinkingIndicator();
    finalizeStreamBlock();
    setStreaming(false);
    // Complete all tool cards
    for (const [, card] of toolCards) {
      completeToolCard(card);
    }
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
