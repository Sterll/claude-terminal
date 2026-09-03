/**
 * Session list filtering.
 *
 * Shared by the "Resume a conversation" modal (renderer.js) and the Sessions
 * panel (TerminalManager), which each keep their own copy of the card-building
 * logic but must agree on what a query matches.
 */

// A session id is 32 hex characters. Folding it into the free-text haystack made
// short hex queries ("db", "42", "fe") collide with roughly one card in ten by
// chance, so ids are matched separately, as a prefix, from this length up.
// Below it a query is far more likely to be a word than a pasted id.
const SESSION_ID_MIN_QUERY = 4;

/**
 * Does a session card match the search query?
 * @param {{searchText: string, sessionId?: string}} session - Preprocessed session
 * @param {string} query - Already lowercased and trimmed
 * @returns {boolean}
 */
function matchesSessionQuery(session, query) {
  if (!query) return true;
  if (!session) return false;
  if (session.searchText && session.searchText.includes(query)) return true;
  // Pasting an id, or the front of one, still finds the card it belongs to
  return query.length >= SESSION_ID_MIN_QUERY
    && (session.sessionId || '').toLowerCase().startsWith(query);
}

module.exports = { matchesSessionQuery, SESSION_ID_MIN_QUERY };
