/**
 * Signatures of a CLI failure that the SDK hands back as ordinary assistant
 * text instead of as a stream error.
 *
 * The short haiku helpers (tab naming, prompt enhancement, commit messages)
 * read the first text block and use it verbatim, so an expired login turns a
 * tab into "Not logged in · Please run /login" — persisted to
 * session-names.json and broadcast to the remote UI. Text matching any of these
 * is refused so each caller falls back to what it already had.
 *
 * Deliberately anchored on the CLI's own phrasing: a title *about* login
 * ("Fix /login redirect") has to keep going through.
 *
 * Shared, because two sides need the same answer: the main process refuses the
 * text before it becomes a name, and the renderer drops the names written
 * before that guard existed.
 */
const CLI_FAILURE_TEXT = [
  /^api error:/i,
  /^not logged in\b/i,
  /^invalid api key\b/i,
  /\bplease run \/login\b/i,
  /\bplease run `?claude (login|auth)\b/i,
  /\bsession (has )?expired\b/i,
  /\bcredit balance (is )?too low\b/i,
  /\busage limit reached\b/i,
  // Spend caps: "You've hit your individual spend limit · run /usage-credits
  // to ask your admin for a higher limit · your session limit resets 5:20pm".
  // Anchored like the rest — prose *about* a spend limit, up to and including
  // quoting that sentence back, has to keep going through.
  /^you\b.{0,6}\bhit your\b[^.]*\blimit\b/i,
  /\brun \/usage-credits\b/i,
];

/**
 * Does this text look like the CLI reporting a failure rather than doing the
 * job it was asked?
 *
 * @param {string} text  an assistant text block, or a name persisted from one
 * @returns {boolean}
 */
function isCliFailureText(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return false;
  return CLI_FAILURE_TEXT.some(re => re.test(trimmed));
}

module.exports = { CLI_FAILURE_TEXT, isCliFailureText };
