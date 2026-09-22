/**
 * External editor launch, with the failure made visible.
 *
 * Every "Open in editor" affordance in the app used to call
 * `api.dialog.openInEditor()` and drop the answer on the floor. That was fine
 * while the bridge was fire-and-forget and the main process could not tell
 * whether the spawn had worked either. It no longer is: a missing editor is
 * the single most common reason one of those buttons appears dead, and on
 * macOS it is the default state of a fresh VS Code install, whose `code` shim
 * only lands on PATH once the user runs "Shell Command: Install 'code' in
 * PATH" by hand.
 *
 * So there is one entry point, it awaits the result, and it says so when the
 * editor did not start. Callers that do not care can still ignore the promise.
 */

const { t } = require('../i18n');

/**
 * Open a file or folder in the user's external editor.
 *
 * @param {string} targetPath
 * @param {{ editor?: string, silent?: boolean }} [opts] - `editor` overrides
 *   the configured one; `silent` suppresses the failure toast.
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function openInEditor(targetPath, opts = {}) {
  const { getSetting } = require('../state/settings.state');
  const editor = opts.editor || getSetting('editor') || 'code';

  let res;
  try {
    res = await window.electron_api.dialog.openInEditor({ editor, path: targetPath });
  } catch (err) {
    res = { success: false, error: err?.message || String(err) };
  }

  // An older preload returns undefined (the bridge used to be `send`), which
  // says nothing about the outcome and must not be read as a failure.
  if (res && res.success === false && !opts.silent) {
    const Toast = require('../ui/components/Toast');
    Toast.showError(t('files.editorLaunchFailed', { editor }));
  }
  return res || { success: true };
}

module.exports = { openInEditor };
