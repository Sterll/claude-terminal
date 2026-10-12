'use strict';
/**
 * Issue tracker connections: which providers the user connected, to which
 * workspace, and a client for each.
 *
 * A connection is a provider (an adapter from `src/main/issue-trackers/`) plus
 * a credential. The credential lives in the OS credential store, under one
 * keychain account per connection; `~/.claude-terminal/issue-trackers.json`
 * holds the rest (workspace, user, date) and never a secret. Nothing here
 * returns a key to the renderer, only a masked form.
 *
 * Design note: `design/issue-trackers.md`.
 */

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const { dataDir } = require('../utils/paths');
const registry = require('../issue-trackers/_registry');
const { trackerError } = require('../issue-trackers/_contract');
const {
  PRIORITY_LEVELS,
  LIMITS,
  sanitizePerson,
  sanitizeComment,
  sanitizeIssue,
  sanitizeIssueDetail,
  sanitizeMetadata,
  normalizeQuery,
} = require('../../shared/issue-trackers');

const STORE_FILE = path.join(dataDir, 'issue-trackers.json');
const STORE_VERSION = 1;
const KEYCHAIN_SERVICE = 'claude-terminal';

/** Teams, states, people and labels change rarely; filters can live with ten minutes. */
const METADATA_TTL_MS = 10 * 60 * 1000;

const keychainAccount = (connectionId) => `issue-tracker:${connectionId}`;

/** Show enough of a key to recognise it, never the whole thing. */
function maskKey(key) {
  if (!key) return null;
  const str = String(key);
  if (str.length <= 12) return '••••';
  return `${str.slice(0, 8)}••••${str.slice(-4)}`;
}

/** The credential store, loaded lazily so nothing native loads until it is used. */
const keytarSecrets = {
  get: (account) => require('keytar').getPassword(KEYCHAIN_SERVICE, account),
  set: (account, value) => require('keytar').setPassword(KEYCHAIN_SERVICE, account, value),
  delete: (account) => require('keytar').deletePassword(KEYCHAIN_SERVICE, account),
};

function httpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function cleanWorkspace(raw) {
  const id = typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  const name = typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 200) : null;
  if (!id || !name) return null;
  return { id, name, url: httpsUrl(raw.url) };
}

/**
 * @param {object} deps
 * @param {string} deps.storePath
 * @param {{ get: Function, set: Function, delete: Function }} deps.secrets
 * @param {{ get: Function, describe: Function }} deps.registry
 * @param {typeof fetch} deps.fetch
 * @param {() => string} [deps.now]
 */
function createIssueTrackerService({
  storePath,
  secrets,
  registry: trackers,
  fetch,
  now = () => new Date().toISOString(),
  clock = () => Date.now(),
}) {
  const clients = new Map();
  const metadataCache = new Map();
  let queue = Promise.resolve();

  /** Store mutations run one after the other: each is a whole-file read-modify-write. */
  function exclusive(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  /**
   * Absent is a fresh install. Unreadable throws: answering it with an empty
   * list would make the next connect rewrite the file with that one entry,
   * and every other connection's key would be orphaned in the keychain.
   */
  async function readStore() {
    let raw;
    try {
      raw = await fsp.readFile(storePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { version: STORE_VERSION, connections: [] };
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Refusing to modify ${path.basename(storePath)}: it is not valid JSON (${err.message})`, { cause: err });
    }
    if (!parsed || !Array.isArray(parsed.connections)) {
      throw new Error(`Refusing to modify ${path.basename(storePath)}: it has no connections list`);
    }
    return parsed;
  }

  async function writeStore(store) {
    await fsp.mkdir(path.dirname(storePath), { recursive: true });
    const tmp = `${storePath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
    await fsp.rename(tmp, storePath);
  }

  function providerOf(id) {
    const def = trackers.get(id);
    if (!def) throw trackerError('PROVIDER', `Unknown issue tracker: ${id}`);
    return def;
  }

  async function publicConnection(entry) {
    // A credential store that cannot be read (or keytar failing to load) costs the mask, not the list.
    const maskedKey = await Promise.resolve().then(() => secrets.get(keychainAccount(entry.id))).then(maskKey, () => null);
    const def = trackers.get(entry.provider);
    return {
      id: entry.id,
      provider: entry.provider,
      providerName: def ? def.name : entry.provider,
      workspace: entry.workspace,
      user: entry.user,
      connectedAt: entry.connectedAt,
      maskedKey,
      available: !!def,
    };
  }

  /** Ask the provider who the key belongs to: the only proof that it works. */
  async function identify(def, secret) {
    const me = await def.createClient({ secret, fetch }).whoAmI();
    const user = sanitizePerson(me?.user);
    const workspace = cleanWorkspace(me?.workspace);
    if (!user || !workspace) throw trackerError('PROVIDER', `${def.name} did not say which account this key belongs to`);
    return { user, workspace };
  }

  function forget(connectionId) {
    clients.delete(connectionId);
    metadataCache.delete(connectionId);
  }

  /** The stored connection and its client, built once and reused. */
  async function resolve(connectionId) {
    const store = await readStore();
    const entry = store.connections.find((c) => c.id === connectionId);
    if (!entry) throw trackerError('NOT_FOUND', `No connection ${connectionId}`);
    if (!clients.has(connectionId)) {
      const secret = await secrets.get(keychainAccount(connectionId));
      if (!secret) throw trackerError('AUTH', 'No API key is stored for this connection');
      clients.set(connectionId, providerOf(entry.provider).createClient({ secret, fetch }));
    }
    return { entry, client: clients.get(connectionId) };
  }

  /** Adapter output that had to be fixed is logged once per call, never silently kept. */
  function report(connectionId, what, problems) {
    if (problems.length) {
      console.warn(`[IssueTrackers] ${connectionId} ${what}: ${problems.length} problem(s), first: ${problems[0]}`);
    }
  }

  return {
    listProviders() {
      return trackers.describe();
    },

    async listConnections() {
      const store = await readStore();
      return Promise.all(store.connections.map(publicConnection));
    },

    /**
     * Check a key with the provider, then store it. Connecting a workspace
     * that is already connected replaces its key instead of adding a twin.
     */
    connect(providerId, secret) {
      return exclusive(async () => {
        const def = providerOf(providerId);
        const key = String(secret || '').trim();
        if (!key) throw trackerError('AUTH', 'The API key is empty');
        const { user, workspace } = await identify(def, key);

        const store = await readStore();
        const existing = store.connections.find((c) => c.provider === def.id && c.workspace?.id === workspace.id);
        const entry = {
          id: existing ? existing.id : `${def.id}-${crypto.randomBytes(6).toString('hex')}`,
          provider: def.id,
          workspace,
          user,
          connectedAt: existing ? existing.connectedAt : now(),
        };

        await secrets.set(keychainAccount(entry.id), key);
        store.version = STORE_VERSION;
        store.connections = existing
          ? store.connections.map((c) => (c.id === entry.id ? entry : c))
          : [...store.connections, entry];
        try {
          await writeStore(store);
        } catch (err) {
          if (!existing) await secrets.delete(keychainAccount(entry.id)).catch(() => {});
          throw err;
        }
        forget(entry.id);
        return publicConnection(entry);
      });
    },

    disconnect(connectionId) {
      return exclusive(async () => {
        const store = await readStore();
        const remaining = store.connections.filter((c) => c.id !== connectionId);
        if (remaining.length !== store.connections.length) {
          store.connections = remaining;
          await writeStore(store);
        }
        forget(connectionId);
        await secrets.delete(keychainAccount(connectionId)).catch(() => {});
      });
    },

    /** Re-check a stored key and refresh the names it reports. */
    test(connectionId) {
      return exclusive(async () => {
        const store = await readStore();
        const entry = store.connections.find((c) => c.id === connectionId);
        if (!entry) throw trackerError('NOT_FOUND', `No connection ${connectionId}`);
        const secret = await secrets.get(keychainAccount(connectionId));
        if (!secret) throw trackerError('AUTH', 'No API key is stored for this connection');
        const { user, workspace } = await identify(providerOf(entry.provider), secret);
        if (workspace.id !== entry.workspace.id) {
          throw trackerError('AUTH', `This key now belongs to ${workspace.name}, not ${entry.workspace.name}`);
        }
        Object.assign(entry, { user, workspace });
        await writeStore(store);
        return publicConnection(entry);
      });
    },

    /** The adapter client for a connection, created once and reused. */
    async client(connectionId) {
      return (await resolve(connectionId)).client;
    },

    /** What the filter bar and the board need, cached per connection. */
    async metadata(connectionId, { refresh = false } = {}) {
      const hit = metadataCache.get(connectionId);
      if (hit && !refresh && clock() - hit.at < METADATA_TTL_MS) return hit.value;
      const { client } = await resolve(connectionId);
      const { metadata, problems } = sanitizeMetadata(await client.metadata());
      report(connectionId, 'metadata', problems);
      metadataCache.set(connectionId, { at: clock(), value: metadata });
      return metadata;
    },

    /** One page of issues. An issue the sanitiser cannot use is dropped, not shown half-empty. */
    async listIssues(connectionId, rawQuery, cursor = null) {
      const { entry, client } = await resolve(connectionId);
      const page = await client.listIssues(normalizeQuery(rawQuery), typeof cursor === 'string' ? cursor : null);
      const issues = [];
      const problems = [];
      for (const raw of Array.isArray(page?.issues) ? page.issues : []) {
        const res = sanitizeIssue(raw, entry.provider);
        if (res.issue) issues.push(res.issue);
        problems.push(...res.problems);
      }
      report(connectionId, 'issues', problems);
      return { issues, next: typeof page?.next === 'string' ? page.next : null };
    },

    async getIssue(connectionId, key) {
      const { entry, client } = await resolve(connectionId);
      const { issue, problems } = sanitizeIssueDetail(await client.getIssue(String(key || '')), entry.provider);
      report(connectionId, `issue ${key}`, problems);
      if (!issue) throw trackerError('PROVIDER', `${entry.provider} returned an unusable issue for ${key}`);
      return issue;
    },

    /**
     * Change a ticket's state, assignee or priority. Only what the adapter
     * declares writable gets through, and it is refused before any request:
     * a read-only tracker must not be asked to write.
     */
    async updateIssue(connectionId, key, patch) {
      const { entry, client } = await resolve(connectionId);
      const write = providerOf(entry.provider).capabilities.write;
      const input = patch && typeof patch === 'object' ? patch : {};
      const clean = {};
      const refuse = (field) => trackerError('PROVIDER', `${entry.provider} does not allow changing ${field}`);
      if ('stateId' in input) {
        if (!write.includes('state')) throw refuse('the state');
        if (typeof input.stateId !== 'string' || !input.stateId) throw trackerError('PROVIDER', 'A state id is required');
        clean.stateId = input.stateId;
      }
      if ('assigneeId' in input) {
        if (!write.includes('assignee')) throw refuse('the assignee');
        if (input.assigneeId !== null && (typeof input.assigneeId !== 'string' || !input.assigneeId)) {
          throw trackerError('PROVIDER', 'An assignee id, or null to unassign, is required');
        }
        clean.assigneeId = input.assigneeId;
      }
      if ('priority' in input) {
        if (!write.includes('priority')) throw refuse('the priority');
        if (!PRIORITY_LEVELS.includes(input.priority)) throw trackerError('PROVIDER', `Priority must be one of ${PRIORITY_LEVELS.join(', ')}`);
        clean.priority = input.priority;
      }
      if (!Object.keys(clean).length) throw trackerError('PROVIDER', 'Nothing to update');
      const { issue, problems } = sanitizeIssue(await client.updateIssue(String(key || ''), clean), entry.provider);
      report(connectionId, `update ${key}`, problems);
      if (!issue) throw trackerError('PROVIDER', `${entry.provider} returned an unusable issue for ${key}`);
      return issue;
    },

    /** Post a markdown comment on a ticket. */
    async addComment(connectionId, key, body) {
      const { entry, client } = await resolve(connectionId);
      if (!providerOf(entry.provider).capabilities.write.includes('comment')) {
        throw trackerError('PROVIDER', `${entry.provider} does not allow comments`);
      }
      const text = typeof body === 'string' ? body.trim() : '';
      if (!text) throw trackerError('PROVIDER', 'The comment is empty');
      if (text.length > LIMITS.commentBody) throw trackerError('PROVIDER', 'The comment is too long');
      const { comment, problems } = sanitizeComment(await client.addComment(String(key || ''), text));
      report(connectionId, `comment on ${key}`, problems);
      if (!comment) throw trackerError('PROVIDER', `${entry.provider} returned an unusable comment`);
      return comment;
    },
  };
}

const service = createIssueTrackerService({
  storePath: STORE_FILE,
  secrets: keytarSecrets,
  registry,
  // Read at call time, so the global is whatever it is when the request goes out.
  fetch: (...args) => globalThis.fetch(...args),
});

module.exports = service;
module.exports.createIssueTrackerService = createIssueTrackerService;
module.exports.maskKey = maskKey;
