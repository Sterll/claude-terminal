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
const VAULT_STATUS_MS = 30_000;

// Whether a notes vault is connected, shared by every tab's brief: the
// "Today's note" button only shows when there is somewhere to save to.
let vaultStatus = { at: 0, connected: false, pending: null };
function vaultConnected(api) {
  if (!api?.vault) return Promise.resolve(false);
  if (Date.now() - vaultStatus.at < VAULT_STATUS_MS) return Promise.resolve(vaultStatus.connected);
  if (!vaultStatus.pending) {
    vaultStatus.pending = api.vault.status()
      .then((res) => !!(res?.success && res.status?.connected && !res.status.missing))
      .catch(() => false)
      .then((connected) => { vaultStatus = { at: Date.now(), connected, pending: null }; return connected; });
  }
  return vaultStatus.pending;
}

/**
 * The brief as a daily-note entry: one collapsed Obsidian callout, so a day
 * of sessions stays a list of titles until one is opened.
 */
function briefAsDailyEntry(brief, { projectName, time }) {
  const quote = (line) => `> ${line}`;
  const lines = [quote(`[!abstract]- ${time} · ${projectName || 'Claude Terminal'}${brief.about ? ` · ${brief.about.split(/[.!?\n]/)[0].slice(0, 80)}` : ''}`)];
  const section = (title, body) => { lines.push(quote(''), quote(`**${title}**`), ...body.map(quote)); };
  if (brief.about) section(t('chat.brief.about'), [brief.about]);
  if (brief.status) section(t('chat.brief.status'), [brief.status]);
  if (brief.decisions?.length) section(t('chat.brief.decisions'), brief.decisions.map((d) => `- ${d}`));
  if (brief.notes?.length) section(t('chat.brief.notes'), brief.notes.map((n) => `- ${n}`));
  return lines.join('\n');
}

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
 * @param {() => string} [deps.getProjectName] - heads the entry saved to the daily note
 * @param {() => boolean} [deps.isOnScreen] - nothing is read while it is not. Always, when left out
 * @param {(state: {behind: boolean}) => void} [deps.onChange] - for the collapsed strip's dot
 */
function createSessionBrief({ api, bodyEl, getSessionId, getProjectPath, getProjectName = () => '', isOnScreen = () => true, onChange = () => {} }) {
  // idle | loading | empty | generating | ready | error
  let phase = 'idle';
  let data = null; // last answer from main, for `data.sessionId`
  let error = null;
  let seq = 0; // a late answer for a superseded request is dropped
  let stale = true; // something may have changed while nobody was looking
  let readAt = 0;
  let destroyed = false;

  function errorText(code) {
    if (code === 'empty') return t('chat.brief.errorEmpty');
    if (code === 'read') return t('chat.brief.errorRead');
    return t('chat.brief.errorFailed');
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
          ? `<span class="chat-brief-new">${escapeHtml(data.newMessages > 0 ? t('chat.brief.newMessages', { count: data.newMessagesAtLeast ? `${data.newMessages}+` : data.newMessages }) : '')}</span>`
          : `<span class="chat-brief-current">${escapeHtml(t('chat.brief.upToDate'))}</span>`}
        <button class="chat-brief-update" ${updating || !behind ? 'disabled' : ''}>${escapeHtml(updating ? t('chat.brief.updating') : t('chat.brief.update'))}</button>
        <button class="chat-brief-vault" hidden title="${escapeHtml(t('vault.briefSaveHint'))}">${escapeHtml(t('vault.briefSave'))}</button>
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
      vaultConnected(api).then((connected) => {
        const btn = bodyEl.querySelector('.chat-brief-vault');
        if (btn && connected) btn.hidden = false;
      });
    } else if (phase === 'generating' || phase === 'loading') {
      const label = phase === 'generating' ? t('chat.brief.generating') : '';
      bodyEl.innerHTML = `<div class="chat-brief-loading"><span class="chat-brief-spinner" aria-hidden="true"></span>${escapeHtml(label)}</div>`;
    } else if (phase === 'error') {
      bodyEl.innerHTML = `
        <div class="chat-brief-empty">
          <p class="chat-brief-error">${escapeHtml(errorText(error))}</p>
          <button class="${error === 'read' ? 'chat-brief-reload' : 'chat-brief-generate'}">${escapeHtml(t('chat.brief.retry'))}</button>
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
      // A read that failed (a remote host away, say) is retried as a read:
      // the retry button must not turn it into a model call nobody asked for.
      error = 'read';
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

  async function saveToDailyNote(btn) {
    if (!data?.brief) return;
    const Toast = require('../Toast');
    const time = new Date().toLocaleTimeString(getCurrentLanguage(), { hour: '2-digit', minute: '2-digit' });
    btn.disabled = true;
    try {
      const res = await api.vault.appendDaily(briefAsDailyEntry(data.brief, { projectName: getProjectName(), time }));
      if (!res?.success) throw new Error(res?.error || 'failed');
      Toast.showToast({
        type: 'success',
        title: t('vault.briefSaved'),
        message: res.path,
        action: t('vault.openNote'),
        onAction: () => require('../../../services/mention-sources/_navigate').openTab('notes').then(() => {
          window.dispatchEvent(new CustomEvent('ct-vault-open', { detail: { path: res.path } }));
        }),
      });
    } catch (err) {
      Toast.showToast({ type: 'error', title: t('vault.briefSaveFailed'), message: err.message });
    } finally {
      btn.disabled = false;
    }
  }

  const onClick = (e) => {
    const vaultBtn = e.target.closest('.chat-brief-vault');
    if (vaultBtn) { saveToDailyNote(vaultBtn); return; }
    if (e.target.closest('.chat-brief-reload')) refreshStatus();
    else if (e.target.closest('.chat-brief-generate, .chat-brief-update')) generate();
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

module.exports = { createSessionBrief, inlineHtml, briefAsDailyEntry, _resetVaultStatus: () => { vaultStatus = { at: 0, connected: false, pending: null }; } };
