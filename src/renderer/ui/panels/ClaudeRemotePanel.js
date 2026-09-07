/**
 * ClaudeRemotePanel
 * Claude Code's Remote Control — mirror chat sessions to claude.ai and the
 * Claude mobile app, and optionally let them drive the session back.
 *
 * This panel does NOT share anything by itself. It holds the master switch
 * that says Remote Control may be used at all, plus the two preferences that
 * apply to whichever conversations are shared. The sharing decision is taken
 * per conversation, in the chat tab's own footer button or with
 * `/remote-control` — never here, and never for every session at once.
 *
 * Sibling of RemotePanel, which serves this app's own PWA over the local
 * network. Both live under Connectivity; they are different products that
 * unfortunately share a name, so the copy here always says "claude.ai".
 */

const { t } = require('../../i18n');

let _status = null;
let _statusPending = false;

/** Reuses RemotePanel's master-toggle and advanced-row styles (settings.css). */
function buildHtml(settings) {
  const enabled = settings.claudeRemoteControlEnabled === true;
  const driving = settings.claudeRemoteControlDrive !== false;
  const terminals = settings.claudeRemoteControlTerminals === true;

  return `
    <div class="rp-master-toggle">
      <div class="rp-master-toggle-content">
        <div class="rp-master-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="5" y="2" width="14" height="20" rx="2"/>
            <line x1="12" y1="18" x2="12.01" y2="18"/>
          </svg>
        </div>
        <div class="rp-master-text">
          <div class="rp-master-title">${t('claudeRemote.enable', 'Remote Control (claude.ai)')}</div>
          <div class="rp-master-desc">${t('claudeRemote.enableDesc', 'Allow chat tabs to be shared with claude.ai. Nothing is shared until you turn it on in a conversation.')}</div>
        </div>
      </div>
      <div class="rp-master-actions">
        <label class="settings-toggle">
          <input type="checkbox" id="claude-remote-toggle" ${enabled ? 'checked' : ''}>
          <span class="settings-toggle-slider"></span>
        </label>
      </div>
    </div>

    <div id="claude-remote-body" style="${enabled ? '' : 'display:none'}">
      <div class="rp-advanced-row">
        <div class="rp-advanced-label">${t('claudeRemote.allowDriving', 'Allow remote control')}</div>
        <label class="settings-toggle">
          <input type="checkbox" id="claude-remote-drive-toggle" ${driving ? 'checked' : ''}>
          <span class="settings-toggle-slider"></span>
        </label>
      </div>
      <div class="settings-hint" id="claude-remote-drive-hint">
        ${driving
    ? t('claudeRemote.drivingOn', 'claude.ai can send prompts, interrupt a turn and answer permission prompts. Sessions already open stay read-only until restarted.')
    : t('claudeRemote.drivingOff', 'Mirror only: claude.ai shows the transcript but cannot act on this machine.')}
      </div>

      <div class="rp-advanced-row">
        <div class="rp-advanced-label">${t('claudeRemote.terminals', 'Connect terminal tabs too')}</div>
        <label class="settings-toggle">
          <input type="checkbox" id="claude-remote-terminals-toggle" ${terminals ? 'checked' : ''}>
          <span class="settings-toggle-slider"></span>
        </label>
      </div>
      <div class="settings-hint">
        ${t('claudeRemote.terminalsDesc', 'Launches the Claude CLI with --rc in terminal tabs, so those sessions reach claude.ai as well.')}
      </div>

      <div class="settings-hint" id="claude-remote-status"></div>
    </div>

    <div class="settings-hint" style="margin-top:12px">
      ${t('claudeRemote.privacy', 'Mirrored sessions send their transcript — prompts, file contents and tool output — to claude.ai.')}
    </div>
  `;
}

/** Paint the status line from the main process. */
async function refreshStatus(api) {
  if (_statusPending) return;
  _statusPending = true;
  try {
    const res = await api?.remoteControl?.getStatus?.();
    _status = res?.success ? res.status : null;
  } catch (_) {
    _status = null;
  } finally {
    _statusPending = false;
  }

  const el = document.getElementById('claude-remote-status');
  if (!el) return;

  if (!_status) {
    el.textContent = t('claudeRemote.statusUnknown', 'Status unavailable.');
    return;
  }
  if (_status.blockedByPolicy) {
    el.textContent = t('claudeRemote.blocked', 'Remote Control is disabled by your organisation policy.');
    return;
  }
  if (!_status.supported) {
    el.textContent = _status.unavailableReason
      || t('claudeRemote.unsupported', 'This build cannot serve Remote Control.');
    return;
  }
  if (_status.lastError) {
    el.textContent = _status.lastError;
    return;
  }
  const n = _status.activeSessions || 0;
  el.textContent = n
    ? t('claudeRemote.mirroring', '{count} session(s) mirrored to claude.ai.').replace('{count}', n)
    : t('claudeRemote.idle', 'No conversation shared. Use the claude.ai button in a chat tab, or type /remote-control there.');
}

function setupHandlers(context) {
  const settingsState = context?.settingsState;
  const saveSettings = context?.saveSettings;
  const api = context?.api || window.electron_api;

  const toggle = document.getElementById('claude-remote-toggle');
  const body = document.getElementById('claude-remote-body');
  const driveToggle = document.getElementById('claude-remote-drive-toggle');
  const driveHint = document.getElementById('claude-remote-drive-hint');
  const terminalsToggle = document.getElementById('claude-remote-terminals-toggle');

  if (toggle) {
    toggle.addEventListener('change', async () => {
      const enabled = toggle.checked;
      settingsState?.setProp('claudeRemoteControlEnabled', enabled);
      saveSettings?.();
      if (body) body.style.display = enabled ? '' : 'none';
      if (!enabled) {
        // Drop live mirrors at once rather than letting them run to the end of
        // their sessions: the user just asked to stop sharing.
        try { await api?.remoteControl?.disable?.(); } catch (_) { /* best effort */ }
      }
      refreshStatus(api);
    });
  }

  if (driveToggle) {
    driveToggle.addEventListener('change', () => {
      const driving = driveToggle.checked;
      settingsState?.setProp('claudeRemoteControlDrive', driving);
      saveSettings?.();
      if (driveHint) {
        driveHint.textContent = driving
          ? t('claudeRemote.drivingOn', 'claude.ai can send prompts, interrupt a turn and answer permission prompts. Sessions already open stay read-only until restarted.')
          : t('claudeRemote.drivingOff', 'Mirror only: claude.ai shows the transcript but cannot act on this machine.');
      }
    });
  }

  if (terminalsToggle) {
    terminalsToggle.addEventListener('change', () => {
      // Only affects the next `claude` spawned in a terminal tab; a CLI already
      // running keeps whatever flags it started with.
      settingsState?.setProp('claudeRemoteControlTerminals', terminalsToggle.checked);
      saveSettings?.();
    });
  }

  refreshStatus(api);
}

module.exports = { buildHtml, setupHandlers, refreshStatus };
