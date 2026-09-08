/**
 * Is this message the CLI reporting an API failure rather than answering — a
 * spend cap, a refusal, an overloaded upstream?
 *
 * The CLI carries the flag as `isApiErrorMessage` internally, which is the
 * spelling written to the ~/.claude/projects transcript, and serialises it to
 * stream-json as `is_api_error_message`. Which of the two a caller sees depends
 * on where it reads from — the live stream or the transcript — so both count.
 *
 * @param {object} message
 * @returns {boolean}
 */
function isApiErrorMessage(message) {
  return message?.isApiErrorMessage === true || message?.is_api_error_message === true;
}

module.exports = { isApiErrorMessage };
