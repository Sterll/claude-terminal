/**
 * The chat's session brief: "what am I looking at" for a conversation the user
 * comes back to. What it is for, where it stands, what was decided, what to
 * know. It heads the chat's side column (chat/sidePanel.js), so the brief is
 * read next to the conversation it describes rather than instead of it.
 *
 * Nothing is written unless the user asks: a brief is a Haiku call
 * (SessionBriefService in main). What is read on its own is the cached brief,
 * which is free, and how many messages came after it. Updating sends the
 * previous brief plus those messages only.
 *
 * Even that free read only happens on screen. A tab in the background whose
 * turn ends is marked stale and reads once it is looked at again; so does one
 * whose last read is older than FRESH_MS, since the session may also have moved
 * outside this tab (resumed in a terminal, driven from claude.ai).
 */

'use strict';

const { t, getCurrentLanguage } = require('../../../i18n');
const { escapeHtml } = require('../../../utils');
const { formatRelativeTimeIntl } = require('../../../utils/format');

const FRESH_MS = 10_000;

/** Escaped text, with the model's `code` spans drawn like the transcript's. */
function inlineHtml(text) {
  return escapeHtml(text).replace(/`([^`\n]+)`/g, '<code class="chat-inline-code">$1</code>');
}

function sectionHtml(title, body) {
  return `<section class="chat-brief-section"><h4>${escapeHtml(title)}</h4>${body}</section>`;
}

function listHtml(items) {
  return `<ul>${items.map(item => `<li>${inlineHtml(item)}</li>`).join('')}</ul>`;
}

/**
 * @param {object} deps
 * @param {object} deps.api - window.electron_api
 * @param {HTMLElement} deps.bodyEl - where the brief is drawn
 * @param {() => string|null} deps.getSessionId - the CLI session id, null before the first turn
 * @param {() => string} deps.getProjectPath
 * @param {() => boolean} [deps.isOnScreen] - nothing is read while it is not. Always, when left out
 * @param {(state: {behind: boolean}) => void} [deps.onChange] - for the collapsed strip's dot
 */
function createSessionBrief({ api, bodyEl, getSessionId, getProjectPath, isOnScreen = () => true, onChange = () => {} }) {
  // idle | loading | empty | generating | ready | error
  let phase = 'idle';
  let data = null; // last answer from main, for `data.sessionId`
  let error = null;
  let seq = 0; // a late answer for a superseded request is dropped
  let stale = true; // something may have changed while nobody was looking
  let readAt = 0;
  let destroyed = false;

  function errorText(code) {
    return code === 'empty' ? t('chat.brief.errorEmpty') : t('chat.brief.errorFailed');
  }

  /** Behind the conversation: new messages, or written in a language the UI has left since. */
  function isBehind() {
    if (!data?.brief) return false;
    return data.newMessages > 0 || !!(data.language && data.language !== getCurrentLanguage());
  }

  function briefHtml() {
    const { brief } = data;
    const parts = [];
    if (brief.about) parts.push(sectionHtml(t('chat.brief.about'), `<p>${inlineHtml(brief.about)}</p>`));
    if (brief.status) parts.push(sectionHtml(t('chat.brief.status'), `<p>${inlineHtml(brief.status)}</p>`));
    if (brief.decisions?.length) parts.push(sectionHtml(t('chat.brief.decisions'), listHtml(brief.decisions)));
    if (brief.notes?.length) parts.push(sectionHtml(t('chat.brief.notes'), listHtml(brief.notes)));

    const written = data.generatedAt
      ? t('chat.brief.writtenAt', { time: formatRelativeTimeIntl(data.generatedAt, { language: getCurrentLanguage() }) })
      : '';
    const behind = isBehind();
    const updating = phase === 'generating';
    // The update button is always there, so it is found before it is needed,
    // and greyed while there is nothing to update.
    parts.push(`
      <div class="chat-brief-meta">
        <span>${escapeHtml(written)}</span>
        ${error ? `<span class="chat-brief-error">${escapeHtml(errorText(error))}</span>` : ''}
        ${behind
          ? `<span class="chat-brief-new">${escapeHtml(data.newMessages > 0 ? t('chat.brief.newMessages', { count: data.newMessages }) : '')}</span>`
          : `<span class="chat-brief-current">${escapeHtml(t('chat.brief.upToDate'))}</span>`}
        <button class="chat-brief-update" ${updating || !behind ? 'disabled' : ''}>${escapeHtml(updating ? t('chat.brief.updating') : t('chat.brief.update'))}</button>
      </div>`);
    return parts.join('');
  }

  function render() {
    if (destroyed) return;
    onChange({ behind: isBehind() });
    if (!getSessionId()) {
      // A new conversation: say what will be here, without a button that cannot work yet.
      bodyEl.innerHTML = `
        <div class="chat-brief-empty">
          <p>${escapeHtml(t('chat.brief.intro'))}</p>
          <p class="chat-brief-hint">${escapeHtml(t('chat.brief.afterFirstTurn'))}</p>
        </div>`;
    } else if (data?.brief && (phase === 'ready' || phase === 'generating' || phase === 'error')) {
      bodyEl.innerHTML = briefHtml();
    } else if (phase === 'generating' || phase === 'loading') {
      const label = phase === 'generating' ? t('chat.brief.generating') : '';
      bodyEl.innerHTML = `<div class="chat-brief-loading"><span class="chat-brief-spinner" aria-hidden="true"></span>${escapeHtml(label)}</div>`;
    } else if (phase === 'error') {
      bodyEl.innerHTML = `
        <div class="chat-brief-empty">
          <p class="chat-brief-error">${escapeHtml(errorText(error))}</p>
          <button class="chat-brief-generate">${escapeHtml(t('chat.brief.retry'))}</button>
        </div>`;
    } else {
      bodyEl.innerHTML = `
        <div class="chat-brief-empty">
          <p>${escapeHtml(t('chat.brief.intro'))}</p>
          <button class="chat-brief-generate">${escapeHtml(t('chat.brief.generate'))}</button>
          <p class="chat-brief-hint">${escapeHtml(t('chat.brief.cost'))}</p>
        </div>`;
    }
  }

  /** Read the cached brief and how far the session has moved. No model call. */
  async function refreshStatus() {
    const sessionId = getSessionId();
    if (!sessionId || phase === 'generating') return;
    if (!isOnScreen()) {
      stale = true;
      return;
    }
    stale = false;
    readAt = Date.now();
    const mine = ++seq;
    if (data?.sessionId !== sessionId) {
      data = null;
      phase = 'loading';
      render();
    }
    const res = await api.claude.sessionBrief({ projectPath: getProjectPath(), sessionId }).catch(() => null);
    if (destroyed || mine !== seq) return;
    error = null;
    if (res?.success) {
      data = { ...res, sessionId };
      phase = res.brief ? 'ready' : 'empty';
    } else {
      error = res?.error || 'failed';
      phase = 'error';
    }
    render();
  }

  async function generate() {
    const sessionId = getSessionId();
    if (!sessionId || phase === 'generating') return;
    const mine = ++seq;
    phase = 'generating';
    error = null;
    render();
    const res = await api.claude.generateSessionBrief({
      projectPath: getProjectPath(),
      sessionId,
      language: getCurrentLanguage(),
    }).catch(() => null);
    if (destroyed || mine !== seq) return;
    if (res?.success) {
      data = { ...res, sessionId };
      phase = 'ready';
    } else {
      error = res?.error || 'failed';
      phase = 'error';
    }
    render();
    // A new brief is read from the top, not from wherever the old one was left.
    if (res?.success) bodyEl.scrollTop = 0;
  }

  const onClick = (e) => {
    if (e.target.closest('.chat-brief-generate, .chat-brief-update')) generate();
  };
  bodyEl.addEventListener('click', onClick);
  render();

  return {
    /** The tab has (or has lost) a session to summarize. */
    sync() {
      render();
      refreshStatus();
    },
    /** A turn ended: the count of new messages moved. */
    onTurnEnd() {
      stale = true;
      refreshStatus();
    },
    /** The column came back on screen: catch up on what a hidden one skipped. */
    onShown() {
      if (stale || Date.now() - readAt > FRESH_MS) refreshStatus();
    },
    destroy() {
      destroyed = true;
      bodyEl.removeEventListener('click', onClick);
    },
  };
}

module.exports = { createSessionBrief, inlineHtml };
