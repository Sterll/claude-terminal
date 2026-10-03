/**
 * What a chat tab of a remote (SSH) project needs on top of a local one
 * (design/remote-ssh.md section 5.2).
 *
 * - A bar at the top of the tab: the host badge (label, connection state,
 *   tooltip, click to connect or verify), and a note saying what a remote
 *   chat does without: this app's MCP tools and Claude in Chrome are local
 *   servers the remote CLI cannot reach.
 * - While the tab is open its host is held, so the idle disconnect in
 *   remoteHosts.state does not drop a host whose only user is a chat.
 * - When the session dies of a lost connection (`chat-error` with
 *   `errorType: 'connection_lost'`), a banner says so, and once the host is
 *   connected again the tab restarts its session with the CLI session id,
 *   through the same resume path an account switch uses. Automatic resumes
 *   stop after a few in a row (a host that reads connected while the network
 *   is gone would otherwise loop); the banner's Reconnect button always works.
 * - Warnings main returns with the session (an older remote CLI) are shown
 *   in the bar.
 *
 * A factory with explicit dependencies, like the other units lifted out of
 * ChatView. For a local project it returns an inert object and touches no DOM,
 * so a local tab is byte-identical to what it was.
 */

const { isRemoteProject, can } = require('../../../../shared/remote-capabilities');

/** Host states that will not become `connected` without the user. */
const STOPPED_STATES = new Set(['authFailed', 'hostKeyUnknown', 'hostKeyChanged', 'unsupported', 'unconfigured']);

/** Automatic resumes allowed within AUTO_RESUME_WINDOW_MS before the banner asks the user. */
const AUTO_RESUME_LIMIT = 3;
const AUTO_RESUME_WINDOW_MS = 60 * 1000;

/**
 * The session can drop while the host still reads `connected` (only the
 * chat's ssh was cut, or the channel has not noticed yet). Resume after this
 * pause rather than at once, and ask main to check the host meanwhile.
 */
const RESUME_DELAY_MS = 1500;

const INERT = Object.freeze({
  isRemote: false,
  isConnectionLost: () => false,
  onConnectionLost: () => {},
  showWarnings: () => {},
  hostLabel: () => '',
  destroy: () => {},
});

function defaultEscape(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

/**
 * @param {object} deps
 * @param {object} deps.project
 * @param {HTMLElement} deps.chatView       the `.chat-view` root
 * @param {object} deps.hosts               { getProjectHost, holdHost, connectHost, subscribe, nudge? }
 * @param {object} deps.badge               { buildHostBadgeHtml, onHostBadgeClick, stateLabel }
 * @param {Function} deps.t
 * @param {(ctx: {turnWasRunning: boolean}) => Promise<boolean>} deps.onResume
 *   restarts the session; resolves true when it is running again
 * @param {Function} [deps.escapeHtml]
 * @param {Function} [deps.now]
 * @param {Function} [deps.setTimer]
 * @param {Function} [deps.clearTimer]
 */
function createRemoteChat(deps) {
  const {
    project, chatView, hosts, badge, t, onResume,
    escapeHtml = defaultEscape,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h),
  } = deps;
  if (!isRemoteProject(project)) return INERT;

  const initial = hosts.getProjectHost(project) || {};
  const profileId = initial.profileId || null;
  const release = hosts.holdHost(profileId);
  let lost = null;        // { turnWasRunning } while the session is down
  let resuming = false;
  let destroyed = false;
  let timer = null;
  let attempts = [];
  let gaveUp = false;
  let warnings = [];

  const hostOf = () => hosts.getProjectHost(project) || { state: 'idle', hostLabel: '', profileId };
  const hostLabel = () => hostOf().hostLabel || t('ssh.unknownHost');

  // ── DOM ──

  const bar = document.createElement('div');
  bar.className = 'chat-remote-bar';
  bar.innerHTML = `
    <div class="chat-remote-head">
      <span class="chat-remote-host"></span>
      <span class="chat-remote-note"></span>
    </div>
    <div class="chat-remote-warnings" hidden></div>
    <div class="chat-remote-banner" role="alert" hidden>
      <span class="chat-remote-banner-text"></span>
      <button type="button" class="chat-remote-reconnect"></button>
    </div>`;
  chatView.insertBefore(bar, chatView.firstChild);
  chatView.classList.add('chat-remote');

  const hostSlot = bar.querySelector('.chat-remote-host');
  const noteEl = bar.querySelector('.chat-remote-note');
  const warningsEl = bar.querySelector('.chat-remote-warnings');
  const bannerEl = bar.querySelector('.chat-remote-banner');
  const bannerText = bar.querySelector('.chat-remote-banner-text');
  const reconnectBtn = bar.querySelector('.chat-remote-reconnect');

  noteEl.textContent = t('ssh.chat.localToolsNote');
  // The `localMcpTools` row: this app's MCP server and Claude in Chrome are
  // local programs the CLI on the host cannot start.
  noteEl.title = t(can(project, 'localMcpTools').reasonKey || 'ssh.chat.localToolsTooltip');

  hostSlot.addEventListener('click', (e) => {
    if (!e.target.closest('.remote-host-badge')) return;
    Promise.resolve(badge.onHostBadgeClick(project.id)).catch(() => {});
  });

  reconnectBtn.addEventListener('click', async () => {
    if (!lost || resuming) return;
    // The user asked: the automatic limit no longer applies
    attempts = [];
    gaveUp = false;
    clearTimer(timer);
    timer = null;
    if (hostOf().state !== 'connected') {
      reconnectBtn.disabled = true;
      try {
        await hosts.connectHost(profileId);
      } catch (_) { /* the state says what happened */ }
      reconnectBtn.disabled = false;
    }
    if (hostOf().state === 'connected') resume();
    else paint();
  });

  function paint() {
    if (destroyed) return;
    hostSlot.innerHTML = badge.buildHostBadgeHtml(project);
    warningsEl.hidden = warnings.length === 0;
    warningsEl.innerHTML = warnings.map((w) => `<div class="chat-remote-warning">${escapeHtml(w)}</div>`).join('');
    bannerEl.hidden = !lost;
    if (!lost) return;
    const host = hostOf();
    let text;
    if (resuming) text = t('ssh.chat.resuming', { host: hostLabel() });
    else if (gaveUp) text = t('ssh.chat.gaveUp', { host: hostLabel() });
    else if (STOPPED_STATES.has(host.state)) text = t('ssh.chat.lostManual', { host: hostLabel(), state: badge.stateLabel(host.state) });
    else text = t('ssh.chat.lost', { host: hostLabel(), state: badge.stateLabel(host.state) });
    bannerText.textContent = text;
    reconnectBtn.textContent = resuming ? t('ssh.terminal.reconnecting') : t('ssh.terminal.reconnect');
    reconnectBtn.disabled = resuming;
  }

  // ── Resume ──

  async function resume() {
    if (!lost || resuming || destroyed) return;
    clearTimer(timer);
    timer = null;
    resuming = true;
    paint();
    const ctx = lost;
    let ok = false;
    try {
      ok = await onResume({ turnWasRunning: Boolean(ctx.turnWasRunning) });
    } catch (e) {
      console.error('[remoteSession] resume failed:', e);
    }
    resuming = false;
    if (destroyed) return;
    // A resume that failed of the connection again has already reported a
    // new loss (onConnectionLost ran meanwhile); only a success clears it.
    if (ok && lost === ctx) lost = null;
    paint();
  }

  /** Resume on its own once the host reads connected, within the limit. */
  function review() {
    if (!lost || resuming || timer || destroyed) return;
    if (hostOf().state !== 'connected') return;
    const since = now() - AUTO_RESUME_WINDOW_MS;
    attempts = attempts.filter((at) => at > since);
    if (attempts.length >= AUTO_RESUME_LIMIT) {
      gaveUp = true;
      paint();
      return;
    }
    timer = setTimer(() => {
      timer = null;
      if (destroyed || !lost || hostOf().state !== 'connected') return;
      attempts.push(now());
      resume();
    }, RESUME_DELAY_MS);
  }

  function onHostsChanged() {
    if (destroyed) return;
    paint();
    review();
  }

  const unsubscribe = hosts.subscribe(onHostsChanged);
  paint();

  return {
    isRemote: true,
    isConnectionLost: () => Boolean(lost),

    /**
     * The session died with the connection. Resumes on its own once the host
     * is back; asks for the host when nothing else is bringing it back.
     * @param {{turnWasRunning?: boolean}} [ctx]
     */
    onConnectionLost(ctx = {}) {
      if (destroyed) return;
      lost = { turnWasRunning: Boolean(ctx.turnWasRunning) };
      const state = hostOf().state;
      if (state === 'idle' || state === 'offline') {
        Promise.resolve(hosts.connectHost(profileId)).catch(() => {});
      } else if (state === 'connected') {
        // Have main check the host now rather than at its next ping
        try { if (hosts.nudge) hosts.nudge(); } catch (_) { /* best effort */ }
      }
      paint();
      review();
    },

    /** Warnings main returned with the session start (an older remote CLI). */
    showWarnings(list) {
      warnings = Array.isArray(list) ? list.filter(Boolean).map(String) : [];
      paint();
    },

    hostLabel,

    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimer(timer);
      timer = null;
      try { unsubscribe(); } catch (_) { /* already gone */ }
      try { release(); } catch (_) { /* already released */ }
      bar.remove();
      chatView.classList.remove('chat-remote');
    },
  };
}

module.exports = { createRemoteChat, AUTO_RESUME_LIMIT, RESUME_DELAY_MS };
