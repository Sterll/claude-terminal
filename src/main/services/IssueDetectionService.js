'use strict';
/**
 * Automatic ticket detection. It never links anything: it *suggests*
 * (IssueLinkService.suggest), and the user says yes or no in the chat.
 *
 * What it reads:
 * - Claude's calls to a tracker's own MCP tools, in chat sessions (from
 *   ChatService's event stream) and terminal sessions (from the PostToolUse
 *   hook). Each adapter's `refs.fromToolCall` decides which tickets a call
 *   targets or creates; a list result never names one.
 * - What the user types: prompts of terminal sessions arrive through the
 *   UserPromptSubmit hook, prompts of chat sessions from the renderer, which
 *   is the only side that knows the typed text apart from the resolved
 *   mentions appended to it.
 * - The session's branch name and pull request title, from the renderer's
 *   Git tab, through `observeText`.
 *
 * Claude's own prose is never read: it names tickets it is not working on.
 *
 * A key is only suggested once the tracker confirms the ticket exists, which
 * also fetches the title the confirmation card shows.
 */

const { formatRef } = require('../../shared/issue-trackers');

const SOURCES = ['tool', 'prompt', 'branch', 'pr'];

/** An adapter's reference reader, which must never take detection down with it. */
function safely(read) {
  try {
    return read() || [];
  } catch {
    return [];
  }
}
const MAX_TEXT = 20_000;
const MAX_PENDING_TOOLS = 200;

/**
 * @param {object} deps
 * @param {object} deps.trackers IssueTrackerService
 * @param {object} deps.links IssueLinkService
 * @param {{ get: Function }} deps.registry adapter registry
 */
function createIssueDetectionService({ trackers, links, registry }) {
  async function connections() {
    try {
      return (await trackers.listConnections()).filter((c) => c.available);
    } catch {
      return [];
    }
  }

  /** Suggest one ticket, once it is known to exist; skipped when the session already has it. */
  async function suggestOne(sessionKey, conn, key, source, evidence) {
    const ref = formatRef(conn.provider, key);
    try {
      const known = await links.get(sessionKey);
      if (known.some((l) => l.ref === ref)) return false;
      const issue = await trackers.getIssue(conn.id, key);
      return await links.suggest(sessionKey, { ref, connectionId: conn.id, title: issue.title, source, evidence });
    } catch {
      return false; // unknown key, other workspace, tracker unreachable: nothing to suggest
    }
  }

  async function observeToolCall(sessionKey, { name, input, result } = {}) {
    if (!sessionKey || typeof name !== 'string' || !name.startsWith('mcp__')) return [];
    const suggested = [];
    for (const conn of await connections()) {
      const def = registry.get(conn.provider);
      if (!def?.refs?.fromToolCall) continue;
      const found = safely(() => def.refs.fromToolCall({ name, input, result }));
      const tool = name.split('__').pop();
      for (const { key, action } of found) {
        if (await suggestOne(sessionKey, conn, key, 'tool', `${tool} (${action})`)) suggested.push(formatRef(conn.provider, key));
      }
    }
    return suggested;
  }

  async function observeText(sessionKey, text, source, evidence = null) {
    if (!sessionKey || typeof text !== 'string' || !text.trim() || !SOURCES.includes(source)) return [];
    const scanned = text.slice(0, MAX_TEXT);
    const suggested = [];
    for (const conn of await connections()) {
      const def = registry.get(conn.provider);
      if (!def) continue;
      const metadata = await trackers.metadata(conn.id).catch(() => null);
      const keys = metadata ? safely(() => def.refs.fromText(scanned, metadata.keys)) : [];
      for (const key of keys) {
        if (await suggestOne(sessionKey, conn, key, source, evidence)) suggested.push(formatRef(conn.provider, key));
      }
    }
    return suggested;
  }

  /**
   * Follow ChatService's event stream. Tool calls are paired with their
   * results (a creation's key is only in the result), and keyed by the SDK
   * session id the messages carry.
   */
  function attachChat(chatService) {
    const pending = new Map(); // tool_use id → { name, input, sessionKey }
    return chatService.addEventListener((channel, data) => {
      if (channel !== 'chat-message') return;
      const msg = data?.message;
      const sessionKey = msg?.session_id;
      const content = msg?.message?.content;
      if (!sessionKey || !Array.isArray(content)) return;
      if (msg.type === 'assistant') {
        for (const block of content) {
          if (block?.type === 'tool_use' && typeof block.name === 'string' && block.name.startsWith('mcp__')) {
            pending.set(block.id, { name: block.name, input: block.input, sessionKey });
            if (pending.size > MAX_PENDING_TOOLS) pending.delete(pending.keys().next().value);
          }
        }
      } else if (msg.type === 'user') {
        for (const block of content) {
          if (block?.type !== 'tool_result' || !pending.has(block.tool_use_id)) continue;
          const call = pending.get(block.tool_use_id);
          pending.delete(block.tool_use_id);
          if (block.is_error) continue;
          observeToolCall(call.sessionKey, { name: call.name, input: call.input, result: block.content }).catch(() => {});
        }
      }
    });
  }

  /** A Claude hook event, from a terminal session. */
  function onHookEvent(event) {
    const stdin = event?.stdin;
    const sessionKey = typeof stdin?.session_id === 'string' ? stdin.session_id : null;
    if (!sessionKey) return;
    if (event.hook === 'PostToolUse') {
      observeToolCall(sessionKey, { name: stdin.tool_name, input: stdin.tool_input, result: stdin.tool_response }).catch(() => {});
    } else if (event.hook === 'UserPromptSubmit' && typeof stdin.prompt === 'string') {
      observeText(sessionKey, stdin.prompt, 'prompt').catch(() => {});
    }
  }

  return { observeToolCall, observeText, attachChat, onHookEvent };
}

let _service = null;

/** The app's instance, wired to the real services on first use. */
function service() {
  if (!_service) {
    _service = createIssueDetectionService({
      trackers: require('./IssueTrackerService'),
      links: require('./IssueLinkService'),
      registry: require('../issue-trackers/_registry'),
    });
  }
  return _service;
}

module.exports = {
  createIssueDetectionService,
  service,
  onHookEvent: (event) => service().onHookEvent(event),
};
