/**
 * ClaudeRemotePanel
 * The conversations currently shared with claude.ai, and a way back to each.
 *
 * This is a screen, not a settings page: the master switch and the two
 * preferences live in Settings → Claude → Remote Control, because that is
 * where settings belong. What is worth a screen of its own is the live
 * answer to "what of mine is on claude.ai right now, and how do I get back
 * to it".
 *
 * Sharing is started from a chat tab (its footer button, or `/remote-control`),
 * never from here — so with nothing shared this panel explains where to go
 * rather than offering a switch that would share everything at once.
 *
 * Sibling of RemotePanel, which serves this app's own PWA over the local
 * network. Both live under Connectivity; they are different products that
 * unfortunately share a name, so the copy here always says "claude.ai".
 */

const { t } = require('../../i18n');
const { escapeHtml } = require('../../utils/dom');

const CLAUDE_CODE_URL = 'https://claude.ai/code';

let _sessions = [];
let _status = null;
let _unsubStatus = null;
let _ctx = null;

/** Human-readable "for 12 min", from the moment the mirror went live. */
function since(startedAt) {
  if (!startedAt) return '';
  const mins = Math.floor((Date.now() - startedAt) / 60000);
  if (mins < 1) return t('claudeRemote.justNow', 'just now');
  if (mins < 60) return t('claudeRemote.forMinutes', 'for {n} min').replace('{n}', mins);
  const hours = Math.floor(mins / 60);
  return t('claudeRemote.forHours', 'for {n} h').replace('{n}', hours);
}

/** The project a shared session belongs to, by id first and path second. */
function projectLabel(session) {
  try {
    const { projectsState } = require('../../state/projects.state');
    const projects = projectsState.get().projects || [];
    const byId = session.projectId && projects.find(p => p.id === session.projectId);
    if (byId?.name) return byId.name;
  } catch (_) { /* fall through to the path */ }
  if (!session.cwd) return t('claudeRemote.unknownProject', 'Unknown project');
  const parts = session.cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || session.cwd;
}

function stateLabel(state) {
  if (state === 'running') return t('claudeRemote.stateRunning', 'Working');
  if (state === 'requires_action') return t('claudeRemote.stateAction', 'Waiting for you');
  return t('claudeRemote.stateIdle', 'Idle');
}

function buildHtml() {
  return `
    <div class="crp-screen">
      <div class="crp-head">
        <div class="crp-head-text">
          <div class="crp-title">${escapeHtml(t('claudeRemote.screenTitle', 'Shared with claude.ai'))}</div>
          <div class="crp-subtitle" id="crp-subtitle"></div>
        </div>
        <a class="crp-open-link" id="crp-open-claude" href="#">
          ${escapeHtml(t('claudeRemote.openClaude', 'Open claude.ai/code'))}
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
        </a>
      </div>
      <div class="crp-list" id="crp-list"></div>
    </div>
  `;
}

/** The empty state doubles as the only documentation of how to share one. */
function emptyHtml() {
  if (_status && !_status.supported) {
    return `<div class="crp-empty">${escapeHtml(_status.unavailableReason || t('claudeRemote.unsupported'))}</div>`;
  }
  if (_status?.blockedByPolicy) {
    return `<div class="crp-empty">${escapeHtml(t('claudeRemote.blocked'))}</div>`;
  }
  if (_status && !_status.enabled) {
    return `<div class="crp-empty">
      <div>${escapeHtml(t('claudeRemote.notAllowed', 'Remote Control is turned off.'))}</div>
      <div class="crp-empty-hint">${escapeHtml(t('claudeRemote.notAllowedHint', 'Allow it in Settings → Claude → Remote Control.'))}</div>
    </div>`;
  }
  return `<div class="crp-empty">
    <div>${escapeHtml(t('claudeRemote.emptyTitle', 'No conversation is shared right now.'))}</div>
    <div class="crp-empty-hint">${escapeHtml(t('claudeRemote.emptyHint', 'Open a chat tab and use the claude.ai button in its footer, or type /remote-control.'))}</div>
  </div>`;
}

function rowHtml(s) {
  const stateClass = s.state === 'running' ? 'running' : s.state === 'requires_action' ? 'action' : 'idle';
  return `
    <div class="crp-row" data-session-id="${escapeHtml(s.sessionId)}">
      <span class="crp-dot ${stateClass}"></span>
      <div class="crp-row-text">
        <div class="crp-row-title">${escapeHtml(projectLabel(s))}</div>
        <div class="crp-row-meta">
          <span>${escapeHtml(stateLabel(s.state))}</span>
          ${s.branch ? `<span class="crp-sep">·</span><span>${escapeHtml(s.branch)}</span>` : ''}
          ${s.startedAt ? `<span class="crp-sep">·</span><span>${escapeHtml(since(s.startedAt))}</span>` : ''}
        </div>
      </div>
      <div class="crp-row-actions">
        <button class="crp-row-btn" data-action="goto" data-session-id="${escapeHtml(s.sessionId)}">${escapeHtml(t('claudeRemote.goToTab', 'Go to tab'))}</button>
        <button class="crp-row-btn danger" data-action="stop" data-session-id="${escapeHtml(s.sessionId)}">${escapeHtml(t('claudeRemote.stopSharing', 'Stop'))}</button>
      </div>
    </div>
  `;
}

function render() {
  const listEl = document.getElementById('crp-list');
  const subtitleEl = document.getElementById('crp-subtitle');
  if (!listEl) return;

  listEl.innerHTML = _sessions.length
    ? _sessions.map(rowHtml).join('')
    : emptyHtml();

  if (subtitleEl) {
    subtitleEl.textContent = _sessions.length
      ? t('claudeRemote.mirroring', '{count} session(s) mirrored to claude.ai.').replace('{count}', _sessions.length)
      : t('claudeRemote.screenSubtitle', 'Conversations you share appear here while they are live.');
  }
}

async function refresh() {
  const api = _ctx?.api || window.electron_api;
  try {
    const [list, status] = await Promise.all([
      api?.remoteControl?.listSessions?.(),
      api?.remoteControl?.getStatus?.(),
    ]);
    _sessions = list?.success ? list.sessions : [];
    _status = status?.success ? status.status : null;
  } catch (_) {
    _sessions = [];
    _status = null;
  }
  render();
}

/**
 * Bring the tab that owns a shared session to the front.
 *
 * A chat tab records its ChatService session id as `claudeSessionId`, which is
 * the only link between what this screen lists and what the tab bar shows.
 */
function goToTab(sessionId) {
  try {
    const terminalsState = require('../../state/terminals.state');
    const TerminalManager = require('../components/TerminalManager');
    let found = null;
    terminalsState.get().terminals.forEach((termData, id) => {
      if (termData.claudeSessionId === sessionId) found = id;
    });
    if (found !== null) TerminalManager.setActiveTerminal(found);
  } catch (err) {
    console.warn('[ClaudeRemotePanel] could not reach the tab:', err?.message);
  }
}

function setupHandlers(context) {
  _ctx = context;
  const api = context?.api || window.electron_api;

  const openLink = document.getElementById('crp-open-claude');
  if (openLink) {
    openLink.addEventListener('click', (e) => {
      e.preventDefault();
      api?.dialog?.openExternal?.(CLAUDE_CODE_URL);
    });
  }

  const listEl = document.getElementById('crp-list');
  if (listEl) {
    listEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('.crp-row-btn');
      if (!btn) return;
      const sessionId = btn.dataset.sessionId;
      if (btn.dataset.action === 'goto') {
        goToTab(sessionId);
      } else if (btn.dataset.action === 'stop') {
        btn.disabled = true;
        try {
          await api?.remoteControl?.disableSession?.(sessionId);
        } finally {
          refresh();
        }
      }
    });
  }

  // A mirror can start or end from anywhere — a chat tab's button, a dead
  // transport, an account switch — so the list follows the service.
  if (_unsubStatus) _unsubStatus();
  _unsubStatus = api?.remoteControl?.onSessionStatus?.(() => refresh()) || null;

  refresh();
}

function cleanup() {
  if (_unsubStatus) _unsubStatus();
  _unsubStatus = null;
}

module.exports = { buildHtml, setupHandlers, refresh, cleanup };
