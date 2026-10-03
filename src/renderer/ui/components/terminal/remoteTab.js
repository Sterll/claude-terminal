/**
 * Remote (SSH) terminal tabs: what a tab of a remote project needs on top of
 * a local one (design/remote-ssh.md section 5.1).
 *
 * - The tab carries its host badge (label, connection state, tooltip), kept
 *   current from the host status mirror.
 * - While the tab is open its host is held, so the idle disconnect in
 *   remoteHosts.state does not drop a host whose only user is a terminal.
 * - When the tab's ssh exits 255 because the connection dropped (main tells
 *   that apart from a remote command's own `exit 255`, which closes the tab
 *   like any exit) main reports `terminal-disconnected`. The tab stays, a "connection
 *   lost" overlay says why, and the tab is respawned under the same PTY id as
 *   soon as the host is connected again: a Claude tab with `--resume`, a shell
 *   in the same directory, or reattached to its tmux session.
 * - Automatic respawns stop after a few in a row, and never start after an
 *   authentication or host key failure: retrying those is how an account gets
 *   locked, and a host key needs a human. The Reconnect button always works.
 * - The resume watchdog of a Claude tab counts from the moment the host is
 *   connected, not from the spawn: a ProxyJump handshake can take most of the
 *   watchdog's budget by itself.
 *
 * A factory with explicit dependencies, like the other units lifted out of
 * TerminalManager, so it can be driven from a test without the 4,600 lines
 * around it. A local project is never attached: every entry point answers as
 * if the tab were not there.
 */

const { isRemoteProject } = require('../../../../shared/remote-capabilities');

/** Automatic respawns allowed within AUTO_RESPAWN_WINDOW_MS before asking the user. */
const AUTO_RESPAWN_LIMIT = 3;
const AUTO_RESPAWN_WINDOW_MS = 60 * 1000;

/**
 * A tab can drop while its host still reads `connected` (the channel has not
 * noticed yet, or only this session was cut). Respawn after this pause rather
 * than waiting for a state change that may never come.
 */
const RESPAWN_WHILE_CONNECTED_MS = 1500;

/** ssh failure kinds after which nothing respawns on its own. */
const NEEDS_USER = new Set(['auth', 'hostkey-unknown', 'hostkey-changed']);

/** Host states that will not become `connected` without the user. */
const STOPPED_STATES = new Set(['authFailed', 'hostKeyUnknown', 'hostKeyChanged', 'unsupported', 'unconfigured']);

const KIND_STATE = { auth: 'authFailed', 'hostkey-unknown': 'hostKeyUnknown', 'hostkey-changed': 'hostKeyChanged' };

/**
 * @param {object} deps
 * @param {object} deps.api                  window.electron_api (terminal.respawn, terminal.resize)
 * @param {Function} deps.getTerminal        (tabId) => termData
 * @param {Function} deps.ptyIdOf            (termData, tabId) => PTY id
 * @param {object} deps.hosts                { getProjectHost, holdHost, connectHost, subscribe, nudge }
 * @param {object} deps.badge                { buildHostBadgeHtml, onHostBadgeClick, stateLabel }
 * @param {Function} deps.t
 * @param {Function} [deps.toast]            ({ type, message }) => void
 * @param {Function} [deps.onCloseTab]       (tabId) => void
 * @param {Function} [deps.now]
 * @param {Function} [deps.setTimer]
 * @param {Function} [deps.clearTimer]
 */
function createRemoteTabs(deps) {
  const {
    api,
    getTerminal,
    ptyIdOf,
    hosts,
    badge,
    t,
    toast = () => {},
    onCloseTab = () => {},
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h),
  } = deps;

  /** tabId -> record */
  const records = new Map();
  let unsubscribeHosts = null;

  function hostOf(rec) {
    return hosts.getProjectHost(rec.project) || { state: 'idle', hostLabel: '', profileId: rec.profileId };
  }

  function hostLabel(rec) {
    return hostOf(rec).hostLabel || t('ssh.unknownHost');
  }

  // ── Badge ──

  function paintBadge(rec) {
    const tabEl = rec.tabEl;
    if (!tabEl) return;
    let slot = tabEl.querySelector('.tab-remote-host');
    if (!slot) {
      slot = document.createElement('span');
      slot.className = 'tab-remote-host';
      // A click on the badge is about the host, not the tab.
      slot.addEventListener('click', (e) => {
        e.stopPropagation();
        Promise.resolve(badge.onHostBadgeClick(rec.project.id)).catch(() => {});
      });
      const name = tabEl.querySelector('.tab-name');
      if (name) tabEl.insertBefore(slot, name);
      else tabEl.appendChild(slot);
    }
    slot.innerHTML = badge.buildHostBadgeHtml(rec.project, { compact: true });
  }

  // ── Overlay ──

  function detailText(rec) {
    const host = hostOf(rec);
    const label = hostLabel(rec);
    const kind = rec.disconnected && rec.disconnected.kind;
    if (NEEDS_USER.has(kind)) return t('ssh.terminal.needsUser', { reason: badge.stateLabel(KIND_STATE[kind]) });
    if (rec.gaveUp) return t('ssh.terminal.gaveUp');
    if (STOPPED_STATES.has(host.state)) return t('ssh.terminal.manual', { state: badge.stateLabel(host.state) });
    return t('ssh.terminal.waiting', { host: label, state: badge.stateLabel(host.state) });
  }

  function paintOverlay(rec) {
    if (!rec.wrapperEl || !rec.disconnected) return;
    let overlay = rec.overlay;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'terminal-remote-overlay';
      overlay.setAttribute('role', 'alert');
      overlay.innerHTML = `
      <div class="terminal-remote-card">
        <div class="terminal-remote-title"></div>
        <div class="terminal-remote-detail"></div>
        <div class="terminal-remote-error"></div>
        <div class="terminal-remote-actions">
          <button type="button" class="terminal-remote-btn primary" data-action="reconnect"></button>
          <button type="button" class="terminal-remote-btn" data-action="close"></button>
        </div>
      </div>`;
      overlay.querySelector('[data-action="reconnect"]').addEventListener('click', () => {
        respawn(rec, { manual: true });
      });
      overlay.querySelector('[data-action="close"]').addEventListener('click', () => onCloseTab(rec.tabId));
      rec.wrapperEl.appendChild(overlay);
      rec.overlay = overlay;
    }
    overlay.querySelector('.terminal-remote-title').textContent = t('ssh.terminal.lost', { host: hostLabel(rec) });
    overlay.querySelector('.terminal-remote-detail').textContent = detailText(rec);
    const error = overlay.querySelector('.terminal-remote-error');
    error.textContent = rec.lastError ? t('ssh.terminal.respawnFailed', { error: rec.lastError }) : '';
    error.hidden = !rec.lastError;
    const button = overlay.querySelector('[data-action="reconnect"]');
    button.textContent = rec.respawning ? t('ssh.terminal.reconnecting') : t('ssh.terminal.reconnect');
    button.disabled = rec.respawning;
    overlay.querySelector('[data-action="close"]').textContent = t('ssh.terminal.closeTab');
  }

  function removeOverlay(rec) {
    if (rec.overlay) {
      rec.overlay.remove();
      rec.overlay = null;
    }
  }

  // ── Respawn ──

  function autoAllowed(rec) {
    if (!rec.disconnected || NEEDS_USER.has(rec.disconnected.kind)) return false;
    const since = now() - AUTO_RESPAWN_WINDOW_MS;
    rec.attempts = rec.attempts.filter((at) => at > since);
    rec.gaveUp = rec.attempts.length >= AUTO_RESPAWN_LIMIT;
    return !rec.gaveUp;
  }

  /**
   * Reopen the tab's PTY under the same id.
   * @param {object} rec
   * @param {{manual?: boolean}} [opts] - a manual attempt ignores the limits
   * @returns {Promise<boolean>}
   */
  async function respawn(rec, { manual = false } = {}) {
    if (rec.respawning || !rec.disconnected) return false;
    clearTimer(rec.respawnTimer);
    rec.respawnTimer = null;
    rec.respawning = true;
    if (manual) {
      rec.attempts = [];
      rec.gaveUp = false;
    } else {
      rec.attempts.push(now());
    }
    paintOverlay(rec);
    const td = getTerminal(rec.tabId);
    const ptyId = ptyIdOf(td, rec.tabId);
    const dropsBefore = rec.drops;
    let res;
    try {
      res = await api.terminal.respawn({
        id: ptyId,
        // A Claude tab picks its conversation up again; a shell has none.
        resumeSessionId: rec.isClaude && td && td.claudeSessionId ? td.claudeSessionId : null,
      });
    } catch (e) {
      res = { success: false, error: e && e.message ? e.message : String(e) };
    }
    rec.respawning = false;
    if (!records.has(rec.tabId)) return false;
    if (res && res.success && rec.drops !== dropsBefore) {
      // The new ssh failed before this answer came back: still disconnected.
      paintOverlay(rec);
      review(rec);
      return false;
    }
    if (res && res.success) {
      rec.disconnected = null;
      rec.lastError = null;
      rec.gaveUp = false;
      if (rec.tabEl) rec.tabEl.classList.remove('remote-disconnected');
      removeOverlay(rec);
      const live = getTerminal(rec.tabId);
      const term = live && live.terminal;
      if (term) {
        try {
          term.write(`\r\n\x1b[2m${t('ssh.terminal.reconnected', { host: hostLabel(rec) })}\x1b[0m\r\n`);
        } catch (_) { /* emulator gone */ }
        // The new PTY starts at the size main last knew; the emulator may
        // have been resized while the tab was disconnected.
        if (term.cols && term.rows) api.terminal.resize({ id: ptyId, cols: term.cols, rows: term.rows });
      }
      return true;
    }
    rec.lastError = (res && res.error) || t('ssh.unknownError');
    paintOverlay(rec);
    return false;
  }

  /** Decide whether, and when, a disconnected tab respawns on its own. */
  function review(rec) {
    if (!rec.disconnected || rec.respawning || rec.respawnTimer) return;
    if (!autoAllowed(rec)) { paintOverlay(rec); return; }
    const state = hostOf(rec).state;
    if (state === 'connected') {
      rec.respawnTimer = setTimer(() => {
        rec.respawnTimer = null;
        if (records.get(rec.tabId) === rec && hostOf(rec).state === 'connected') respawn(rec);
      }, RESPAWN_WHILE_CONNECTED_MS);
    } else if (state === 'idle' || state === 'offline') {
      // Nothing is bringing the host back: ask for it, since a tab of it is open.
      Promise.resolve(hosts.connectHost(rec.profileId)).catch(() => {});
    }
    // connecting / reconnecting: the status change to `connected` lands in onHostsChanged.
    paintOverlay(rec);
  }

  // ── Host status ──

  function onHostsChanged() {
    for (const rec of [...records.values()]) {
      paintBadge(rec);
      const state = hostOf(rec).state;
      if (state === 'connected' && rec.waiters.size) {
        const waiters = [...rec.waiters];
        rec.waiters.clear();
        for (const run of waiters) {
          try { run(); } catch (e) { console.error('[remoteTab] waiter failed:', e); }
        }
      }
      if (rec.disconnected) {
        if (state === 'connected') review(rec);
        else paintOverlay(rec);
      }
    }
  }

  function ensureSubscribed() {
    if (!unsubscribeHosts) unsubscribeHosts = hosts.subscribe(onHostsChanged);
  }

  // ── Public ──

  /**
   * Make a freshly created tab a remote one. Does nothing (and answers false)
   * for a local project.
   * @param {string|number} tabId
   * @param {{project: object, tabEl?: HTMLElement, wrapperEl?: HTMLElement, isClaude?: boolean}} opts
   */
  function attach(tabId, { project, tabEl = null, wrapperEl = null, isClaude = false }) {
    if (!isRemoteProject(project)) return false;
    detach(tabId);
    const host = hosts.getProjectHost(project);
    const profileId = (host && host.profileId) || null;
    const rec = {
      tabId,
      project,
      profileId,
      isClaude: Boolean(isClaude),
      release: hosts.holdHost(profileId),
      tabEl,
      wrapperEl,
      disconnected: null,
      drops: 0,
      respawning: false,
      respawnTimer: null,
      attempts: [],
      gaveUp: false,
      lastError: null,
      waiters: new Set(),
      overlay: null,
    };
    records.set(tabId, rec);
    if (tabEl) {
      tabEl.classList.add('remote-tab');
      if (profileId) tabEl.dataset.remoteProfile = profileId;
    }
    paintBadge(rec);
    ensureSubscribed();
    return true;
  }

  /** The tab is closing: release the host, drop timers and the overlay. */
  function detach(tabId) {
    const rec = records.get(tabId);
    if (!rec) return;
    records.delete(tabId);
    clearTimer(rec.respawnTimer);
    rec.respawnTimer = null;
    rec.waiters.clear();
    for (const timer of rec.timers || []) clearTimer(timer);
    removeOverlay(rec);
    try { rec.release(); } catch (_) { /* already released */ }
    if (!records.size && unsubscribeHosts) {
      try { unsubscribeHosts(); } catch (_) { /* already gone */ }
      unsubscribeHosts = null;
    }
  }

  function isRemoteTab(tabId) {
    return records.has(tabId);
  }

  function isDisconnected(tabId) {
    const rec = records.get(tabId);
    return Boolean(rec && rec.disconnected);
  }

  /**
   * Run `fn` once the tab's host is connected: now, when it already is.
   * A tab that is not remote runs it now too, so callers need no branch.
   */
  function whenConnected(tabId, fn) {
    const rec = records.get(tabId);
    if (!rec || hostOf(rec).state === 'connected') {
      fn();
      return;
    }
    rec.waiters.add(fn);
  }

  /**
   * The resume watchdog of a remote Claude tab: `onStale` runs when the tab
   * printed nothing within `delayMs` of its host being connected.
   */
  function armResumeWatchdog(tabId, { delayMs, hasOutput, onStale }) {
    whenConnected(tabId, () => {
      const rec = records.get(tabId);
      if (!rec) return;
      rec.timers = rec.timers || new Set();
      const timer = setTimer(() => {
        rec.timers.delete(timer);
        if (records.get(tabId) !== rec || rec.disconnected) return;
        if (!hasOutput()) onStale();
      }, delayMs);
      rec.timers.add(timer);
    });
  }

  /** Main said the tab's ssh lost its connection. */
  function onDisconnected(tabId, data = {}) {
    const rec = records.get(tabId);
    if (!rec) return false;
    rec.disconnected = { kind: data.kind || 'network', at: now() };
    rec.drops += 1;
    rec.lastError = null;
    if (rec.tabEl) rec.tabEl.classList.add('remote-disconnected');
    // Ask main to check the host now: if this was the network going, the
    // channel's own ping would otherwise take up to half a minute to notice.
    try { hosts.nudge && hosts.nudge(); } catch (_) { /* best effort */ }
    paintOverlay(rec);
    review(rec);
    return true;
  }

  /** The tab's process ended for real. Explains a missing remote `claude`. */
  function onExit(tabId, data = {}) {
    const rec = records.get(tabId);
    if (!rec) return;
    if (rec.isClaude && data && data.exitCode === 127) {
      toast({ type: 'error', message: t('ssh.terminal.claudeMissing', { host: hostLabel(rec) }) });
    }
  }

  function destroy() {
    for (const tabId of [...records.keys()]) detach(tabId);
  }

  return {
    attach,
    detach,
    isRemoteTab,
    isDisconnected,
    whenConnected,
    armResumeWatchdog,
    onDisconnected,
    onExit,
    respawn: (tabId, opts) => {
      const rec = records.get(tabId);
      return rec ? respawn(rec, opts) : Promise.resolve(false);
    },
    destroy,
  };
}

module.exports = {
  createRemoteTabs,
  AUTO_RESPAWN_LIMIT,
  AUTO_RESPAWN_WINDOW_MS,
  RESPAWN_WHILE_CONNECTED_MS,
};
