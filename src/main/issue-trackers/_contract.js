/**
 * The issue tracker adapter contract.
 *
 * An adapter is one file, `src/main/issue-trackers/<id>.tracker.js`, found by
 * `_registry.js` the way `*.node.js` files are found by the workflow registry.
 * This module says what such a file must export and checks it when the
 * registry loads it. The full contract, with the reasons behind each rule, is
 * `design/issue-trackers.md`; the shapes an adapter returns are sanitised by
 * `src/shared/issue-trackers.js`.
 *
 * @typedef {object} TrackerDefinition
 * @property {string} id                 lower-case id, also the prefix of every ref (`linear:ENG-142`)
 * @property {string} name               display name, a proper noun, never translated
 * @property {{ type: 'apiKey', helpUrl?: string }} auth
 * @property {TrackerCapabilities} capabilities
 * @property {(ctx: ClientContext) => TrackerClient} createClient  must not do any I/O
 * @property {TrackerRefs} refs
 *
 * @typedef {object} TrackerCapabilities
 * @property {boolean} priority          false: every issue reports `priority: null`
 * @property {boolean} labels
 * @property {boolean} estimate
 * @property {boolean} comments          the detail view reads comments
 * @property {string[]} write            subset of WRITE_FIELDS; empty means read-only
 *
 * @typedef {object} ClientContext
 * @property {string} secret             the connection's credential, from the OS keychain
 * @property {typeof fetch} fetch        always use this one, never the global: tests inject it
 *
 * @typedef {object} TrackerClient       every method is async and rejects with `err.code` in ERROR_CODES
 * @property {() => Promise<{ user: object, workspace: { id: string, name: string, url?: string } }>} whoAmI
 * @property {() => Promise<object>} metadata                    keys, people, states, labels, facets
 * @property {(query: object, cursor: string|null) => Promise<{ issues: object[], next: string|null }>} listIssues
 * @property {(key: string) => Promise<object>} getIssue        issue + description, comments, children
 * @property {(key: string, patch: object) => Promise<object>} [updateIssue]  required when write has state/assignee/priority
 * @property {(key: string, body: string) => Promise<object>} [addComment]    required when write has comment
 *
 * @typedef {object} TrackerRefs         pure functions, no network
 * @property {(text: string, knownKeys: string[]) => string[]} fromText
 * @property {(call: { name: string, input: any, result: any }) => Array<{ key: string, action: 'read'|'write'|'create' }>} [fromToolCall]
 */

'use strict';

const { WRITE_FIELDS, ERROR_CODES, isProviderId } = require('../../shared/issue-trackers');

const AUTH_TYPES = ['apiKey'];
const CAPABILITY_FLAGS = ['priority', 'labels', 'estimate', 'comments'];
const BASE_CLIENT_METHODS = ['whoAmI', 'metadata', 'listIssues', 'getIssue'];

const isFn = (v) => typeof v === 'function';

/**
 * Everything wrong with an adapter module, as sentences. Empty means it may be
 * registered. Checked statically: nothing here calls into the adapter.
 *
 * @param {any} def
 * @returns {string[]}
 */
function validateTracker(def) {
  const problems = [];
  if (!def || typeof def !== 'object') return ['module does not export an object'];

  if (!isProviderId(def.id)) problems.push('id: expected lower-case letters, digits and dashes, 2 to 32 characters');
  if (typeof def.name !== 'string' || !def.name.trim()) problems.push('name: missing');

  if (!def.auth || !AUTH_TYPES.includes(def.auth.type)) {
    problems.push(`auth.type: expected one of ${AUTH_TYPES.join(', ')}`);
  } else if (def.auth.helpUrl != null && !/^https:\/\//.test(def.auth.helpUrl)) {
    problems.push('auth.helpUrl: must be an https URL');
  }

  const caps = def.capabilities;
  if (!caps || typeof caps !== 'object') {
    problems.push('capabilities: missing');
  } else {
    for (const flag of CAPABILITY_FLAGS) {
      if (typeof caps[flag] !== 'boolean') problems.push(`capabilities.${flag}: expected a boolean`);
    }
    if (!Array.isArray(caps.write)) {
      problems.push('capabilities.write: expected an array (empty for a read-only tracker)');
    } else {
      for (const field of caps.write) {
        if (!WRITE_FIELDS.includes(field)) problems.push(`capabilities.write: unknown field "${field}"`);
      }
      if (caps.write.includes('priority') && caps.priority !== true) {
        problems.push('capabilities.write: "priority" needs capabilities.priority');
      }
      if (caps.write.includes('comment') && caps.comments !== true) {
        problems.push('capabilities.write: "comment" needs capabilities.comments');
      }
    }
  }

  if (!isFn(def.createClient)) problems.push('createClient: expected a function');

  if (!def.refs || !isFn(def.refs.fromText)) problems.push('refs.fromText: expected a function');
  else if (def.refs.fromToolCall != null && !isFn(def.refs.fromToolCall)) {
    problems.push('refs.fromToolCall: expected a function when present');
  }

  return problems;
}

/**
 * The client methods an adapter has to implement, given what it declares
 * writable. A read-only tracker implements the four base methods only.
 *
 * @param {TrackerDefinition} def
 * @returns {string[]}
 */
function requiredClientMethods(def) {
  const write = def?.capabilities?.write || [];
  const methods = [...BASE_CLIENT_METHODS];
  if (write.some((f) => f !== 'comment')) methods.push('updateIssue');
  if (write.includes('comment')) methods.push('addComment');
  return methods;
}

/** @returns {string[]} */
function validateClient(def, client) {
  if (!client || typeof client !== 'object') return ['createClient() did not return an object'];
  return requiredClientMethods(def)
    .filter((m) => !isFn(client[m]))
    .map((m) => `client.${m}: expected a function`);
}

/**
 * The error an adapter rejects with. `code` is what the UI branches on, so an
 * adapter maps its provider's failures onto ERROR_CODES rather than leaking
 * HTTP statuses or GraphQL error shapes into the app.
 *
 * @param {string} code one of ERROR_CODES
 * @param {string} message English, like every main-process error
 * @param {{ retryAfterMs?: number, cause?: unknown }} [extra]
 */
function trackerError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = ERROR_CODES.includes(code) ? code : 'PROVIDER';
  if (Number.isFinite(extra.retryAfterMs)) err.retryAfterMs = extra.retryAfterMs;
  if (extra.cause !== undefined) err.cause = extra.cause;
  return err;
}

module.exports = {
  AUTH_TYPES,
  CAPABILITY_FLAGS,
  validateTracker,
  requiredClientMethods,
  validateClient,
  trackerError,
};
