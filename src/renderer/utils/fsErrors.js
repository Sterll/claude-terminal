/**
 * The code of a filesystem error that came through the preload bridge.
 *
 * contextBridge copies a thrown Error with its message and stack only, so
 * `err.code` is always undefined on an error from `window.electron_nodeModules.fs`.
 * The preload writes the code at the head of the message instead ("ENOENT: ...",
 * which is how Node words its own fs errors), and this reads it back. An error
 * that kept its `code` (raised in this world, or by the remote fs adapter)
 * answers with that.
 *
 * Without this, every "absent file" branch in the renderer was dead: a missing
 * discovery.json switched the feature suggestions off as "unreadable".
 *
 * @param {unknown} err
 * @returns {string|undefined}
 */
function errorCode(err) {
  if (!err || typeof err !== 'object') return undefined;
  if (typeof err.code === 'string' && err.code) return err.code;
  const match = /^([A-Z][A-Z0-9_]*): /.exec(typeof err.message === 'string' ? err.message : '');
  return match ? match[1] : undefined;
}

/** @param {unknown} err */
function isMissingFile(err) {
  return errorCode(err) === 'ENOENT';
}

module.exports = { errorCode, isMissingFile };
