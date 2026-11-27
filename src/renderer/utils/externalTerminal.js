/**
 * "Open in external terminal", with the failure made visible (issue #255).
 *
 * The terminal application is the one chosen in Settings, General; main reads
 * it from settings.json, so all this sends is the folder. A remote (SSH)
 * project has no local folder and is refused here with the capability's
 * reason, before any IPC. Main refuses a URI as well.
 */

'use strict';

const { t } = require('../i18n');

/** The sentence for a failure, from the code main kept for us. */
function failureMessage(res) {
  switch (res?.code) {
    case 'NOT_A_FOLDER': return t('settings.shell.errors.notAFolder');
    case 'NO_CUSTOM_COMMAND': return t('settings.shell.errors.noCustomCommand');
    case 'NOT_FOUND': return t('settings.shell.errors.notFound', { name: res.name || '' });
    case 'NONE_FOUND': return t('settings.shell.errors.noneFound');
    case 'UNSAFE_PATH': return t('settings.shell.errors.unsafePath');
    case 'LAUNCH_FAILED': return t('settings.shell.errors.launchFailed', { name: res.name || '' });
    case 'REMOTE_UNSUPPORTED': return t(res.reasonKey || 'ssh.disabled.openExternalTerminal');
    default: return t('settings.shell.testFailed');
  }
}

/**
 * @param {string} folderPath
 * @param {{ silent?: boolean }} [opts] - `silent` suppresses the failure toast
 * @returns {Promise<{ success: boolean, code?: string, error?: string }>}
 */
async function openExternalTerminal(folderPath, opts = {}) {
  if (require('../../shared/remote-path').isRemotePath(folderPath)) {
    if (!opts.silent) require('../ui/components/Toast').showToast({ type: 'info', message: t('ssh.disabled.openExternalTerminal') });
    return { success: false, code: 'REMOTE_UNSUPPORTED' };
  }
  let res;
  try {
    res = await window.electron_api.terminal.openExternal({ path: folderPath });
  } catch (err) {
    res = { success: false, error: err?.message || String(err) };
  }
  if (res && res.success === false && !opts.silent) {
    require('../ui/components/Toast').showError(failureMessage(res));
  }
  return res || { success: true };
}

module.exports = { openExternalTerminal, failureMessage };
