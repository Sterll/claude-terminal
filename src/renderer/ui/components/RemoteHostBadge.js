/**
 * RemoteHostBadge
 *
 * The host badge a remote (SSH) project carries in the project list and the
 * project bar: the host's label and a dot coloured by connection state, with a
 * tooltip that says what the state means and what clicking does.
 *
 * Rendered as an HTML string, like everything else in those two views, and
 * clicked through their delegated handlers, which hand the project id to
 * `onHostBadgeClick`. A local project gets an empty string, so the local
 * markup is byte-identical to what it was.
 */

const { escapeHtml } = require('../../utils/dom');
const { t } = require('../../i18n');
const {
  getProjectHost,
  connectHost,
} = require('../../state/remoteHosts.state');
const { getProject } = require('../../state/projects.state');

const SERVER_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 3h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm0 10h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zm3-7.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm0 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>';

/** Short state names, for the badge text and screen readers. */
function stateLabel(state) {
  switch (state) {
    case 'connecting': return t('ssh.status.connecting');
    case 'connected': return t('ssh.status.connected');
    case 'reconnecting': return t('ssh.status.reconnecting');
    case 'offline': return t('ssh.status.offline');
    case 'authFailed': return t('ssh.status.authFailed');
    case 'hostKeyUnknown': return t('ssh.status.hostKeyUnknown');
    case 'hostKeyChanged': return t('ssh.status.hostKeyChanged');
    case 'unsupported': return t('ssh.status.unsupported');
    case 'unconfigured': return t('ssh.status.unconfigured');
    default: return t('ssh.status.idle');
  }
}

/** Why a host is `unsupported`, from the detail code SshHostService sets. */
function unsupportedReason(detail) {
  switch (detail && detail.code) {
    case 'ssh-not-found': return t('ssh.unsupportedReason.sshNotFound');
    case 'spawn-failed': return t('ssh.unsupportedReason.spawnFailed');
    case 'remote-tmp': return t('ssh.unsupportedReason.remoteTmp');
    case 'no-posix-shell': return t('ssh.unsupportedReason.noPosixShell');
    case 'login-shell': return t('ssh.unsupportedReason.loginShell');
    case 'handshake-failed': return t('ssh.unsupportedReason.handshakeFailed');
    case 'invalid-profile': return t('ssh.unsupportedReason.invalidProfile');
    case 'profile-missing': return t('ssh.unsupportedReason.profileMissing');
    case 'store-unreadable': return t('ssh.unsupportedReason.storeUnreadable');
    default: return t('ssh.unsupportedReason.unknown');
  }
}

function formatTime(ms) {
  try { return new Date(ms).toLocaleTimeString(); } catch (_) { return ''; }
}

/**
 * The tooltip for a host state: what it means, and what a click does.
 * @param {{state: string, hostLabel: string, status: Object}} host
 */
function stateTooltip(host) {
  const label = host.hostLabel || t('ssh.unknownHost');
  const status = host.status || {};
  switch (host.state) {
    case 'connecting': return t('ssh.tooltip.connecting', { host: label });
    case 'connected': return t('ssh.tooltip.connected', { host: label });
    case 'reconnecting': {
      const attempt = status.detail && status.detail.attempt;
      return status.retryAt
        ? t('ssh.tooltip.reconnecting', { host: label, attempt: attempt || 1, time: formatTime(status.retryAt) })
        : t('ssh.tooltip.reconnectingNow', { host: label });
    }
    case 'offline': return t('ssh.tooltip.offline', { host: label });
    case 'authFailed': return t('ssh.tooltip.authFailed', { host: label });
    case 'hostKeyUnknown': return t('ssh.tooltip.hostKeyUnknown', { host: label });
    case 'hostKeyChanged': return t('ssh.tooltip.hostKeyChanged', { host: label });
    case 'unsupported': return t('ssh.tooltip.unsupported', { host: label, reason: unsupportedReason(status.detail) });
    case 'unconfigured': return t('ssh.tooltip.unconfigured', { host: label });
    default: return t('ssh.tooltip.idle', { host: label });
  }
}

/**
 * Badge markup for a project, or '' for a local one.
 * @param {Object} project
 * @param {{compact?: boolean}} [opts] - compact: dot only (project bar tabs)
 * @returns {string}
 */
function buildHostBadgeHtml(project, opts = {}) {
  const host = getProjectHost(project);
  if (!host) return '';
  const tooltip = `${stateLabel(host.state)} - ${stateTooltip(host)}`;
  const label = host.hostLabel || t('ssh.unknownHost');
  const text = opts.compact ? '' : `<span class="remote-host-label">${escapeHtml(label)}</span>`;
  return `<span class="remote-host-badge state-${escapeHtml(host.state)}${opts.compact ? ' compact' : ''}" role="button" tabindex="0" data-project-id="${escapeHtml(project.id)}" data-host-state="${escapeHtml(host.state)}" title="${escapeHtml(tooltip)}" aria-label="${escapeHtml(`${label}: ${tooltip}`)}">${SERVER_ICON}<span class="remote-host-dot"></span>${text}</span>`;
}

/**
 * One line describing where a project lives, for tooltips and the path row:
 * `user@host:/remote/path` for a remote project, its path otherwise.
 * @param {Object} project
 * @returns {string}
 */
function projectLocation(project) {
  const host = getProjectHost(project);
  if (!host) return project?.path || '';
  return `${host.hostLabel || t('ssh.unknownHost')}:${host.remotePath}`;
}

/**
 * What a click on the badge does, by state:
 * - unconfigured: create a profile with the project's id from its host label;
 * - hostKeyUnknown: open OpenSSH's own verification;
 * - hostKeyChanged: explain, and offer no shortcut;
 * - connected / connecting: nothing to do;
 * - anything else: connect now (an explicit user action, so stopped states
 *   like an auth failure are retried too).
 * @param {string} projectId
 * @returns {Promise<void>}
 */
async function onHostBadgeClick(projectId) {
  const project = getProject(projectId);
  const host = getProjectHost(project);
  if (!host) return;
  // Lazy: the dialog is only needed when a click asks for it.
  const RemoteProjectModal = require('./RemoteProjectModal');
  switch (host.state) {
    case 'connected':
    case 'connecting':
      return;
    case 'unconfigured':
      RemoteProjectModal.openHostEditor({ prefill: { id: host.profileId, hostLabel: host.hostLabel } });
      return;
    case 'hostKeyUnknown':
      RemoteProjectModal.openVerifyHost(host.profileId);
      return;
    case 'hostKeyChanged': {
      const Toast = require('./Toast');
      Toast.showToast({ type: 'error', title: stateLabel(host.state), message: stateTooltip(host), duration: 10000 });
      return;
    }
    default:
      await connectHost(host.profileId);
  }
}

/**
 * Refuse a feature a remote project cannot use, with its reason as a toast,
 * so a click never fails silently. Answers false (and shows nothing) for a
 * local project, which callers then handle exactly as before.
 * @param {Object|string} projectOrPath - a project, or a path that may be an ssh-remote:// URI
 * @param {string} feature - a row of src/shared/remote-capabilities.js
 * @param {{editor?: string}} [context] - for 'openInEditor', the editor that
 *        would open it: the VS Code family can open a remote project over Remote-SSH
 * @returns {boolean} true when refused
 */
function refuseForRemote(projectOrPath, feature, context = {}) {
  const project = typeof projectOrPath === 'string' ? { path: projectOrPath } : projectOrPath;
  const caps = require('../../../shared/remote-capabilities');
  const cap = feature === 'openInEditor' && context.editor
    ? caps.canOpenInEditor(project, context.editor)
    : caps.can(project, feature);
  if (cap.ok) return false;
  require('./Toast').showToast({ type: 'info', message: t(cap.reasonKey) });
  return true;
}

module.exports = {
  refuseForRemote,
  buildHostBadgeHtml,
  projectLocation,
  onHostBadgeClick,
  stateLabel,
  stateTooltip,
  unsupportedReason,
};
