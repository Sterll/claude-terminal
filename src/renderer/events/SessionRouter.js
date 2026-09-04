/**
 * SessionRouter - maps a Claude session id onto the tab that owns it.
 *
 * A hook event carries a cwd and a session id, nothing else. Resolving it by cwd
 * alone lands every event of a project on one arbitrary tab, so an idle tab lights
 * up whenever anything else runs in the same folder: a chat tab (the Agent SDK
 * loads the same ~/.claude/settings.json hooks), a workflow node, a `claude`
 * started outside the app, a worktree checked out under the project.
 *
 * So routing goes through the session id instead:
 *
 *   1. a tab already carrying that id wins. Chat tabs get theirs from the SDK
 *      `init` message and resumed terminal tabs at creation, so this is a fact,
 *      not a guess - and it repairs a binding adopted earlier by mistake.
 *   2. otherwise the live binding, if its tab is still open.
 *   3. otherwise adopt, but only an unambiguous candidate, and only when the
 *      caller allows it.
 *
 * When none of the three answers, the event is dropped. A tab badge that lies
 * about what the app is doing is worse than a badge that misses one event.
 */

// sessionId -> terminal id. One entry per *live* session, released when that
// session ends. Deliberately not the same thing as `td.claudeSessionId`, which is
// a durable "resume this conversation" pointer and outlives the process that
// wrote it - a tab keeps it long after its Claude exited.
const bindings = new Map();

/**
 * @returns {Map<any, Object>} live terminal entries, keyed by tab id
 */
function terminals() {
  try {
    return require('../state/terminals.state').terminalsState.get().terminals;
  } catch (e) {
    return new Map();
  }
}

/**
 * The tab that already advertises this session id, if any.
 * @param {string} sessionId
 * @returns {any|null} terminal id
 */
function tabCarrying(sessionId) {
  for (const [id, td] of terminals()) {
    if (td && td.claudeSessionId === sessionId) return id;
  }
  return null;
}

/**
 * Claude terminal tabs of a project that no live session has claimed yet.
 *
 * Chat tabs are excluded on purpose: the SDK hands them their session id, so they
 * are always found by rule 1 and must never be adopted on a hunch. That exclusion
 * is also what used to misroute them - it is only safe now that failing to adopt
 * means "drop the event" rather than "fall back to a terminal tab".
 *
 * @param {string} projectId
 * @returns {any[]} terminal ids
 */
function adoptable(projectId) {
  const taken = new Set(bindings.values());
  const out = [];
  for (const [id, td] of terminals()) {
    if (!td || td.project?.id !== projectId) continue;
    if (td.mode !== 'terminal' || td.isBasic) continue;
    if (taken.has(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * Forget bindings whose tab has been closed.
 */
function pruneClosed() {
  const live = terminals();
  for (const [sessionId, terminalId] of bindings) {
    if (!live.has(terminalId)) bindings.delete(sessionId);
  }
}

/**
 * Resolve a session id to the tab that owns it.
 *
 * @param {string} sessionId - Claude session id from the hook payload
 * @param {Object} [opts]
 * @param {string} [opts.projectId] - required for adoption
 * @param {boolean} [opts.adopt=false] - allow claiming an unbound tab
 * @param {any} [opts.prefer] - tab to favour when several are adoptable
 *   (the last-focused one: the tab the user just launched `claude` in)
 * @returns {any|null} terminal id, or null when it cannot be known
 */
function resolve(sessionId, { projectId = null, adopt = false, prefer = null } = {}) {
  if (!sessionId) return null;

  const carrier = tabCarrying(sessionId);
  if (carrier !== null) {
    bindings.set(sessionId, carrier);
    return carrier;
  }

  if (bindings.has(sessionId)) {
    const bound = bindings.get(sessionId);
    if (terminals().has(bound)) return bound;
    bindings.delete(sessionId);
  }

  if (!adopt || !projectId) return null;

  pruneClosed();
  const candidates = adoptable(projectId);
  // Several candidates and no hint: refuse. Picking one is precisely the bug.
  const picked = (prefer !== null && candidates.includes(prefer))
    ? prefer
    : (candidates.length === 1 ? candidates[0] : null);
  if (picked === null) return null;

  bindings.set(sessionId, picked);
  return picked;
}

/**
 * Release a session that has ended, so its tab can host the next one.
 * @param {string} sessionId
 */
function release(sessionId) {
  if (sessionId) bindings.delete(sessionId);
}

/**
 * Drop all bindings (provider switch, tests).
 */
function reset() {
  bindings.clear();
}

module.exports = { resolve, release, reset };
