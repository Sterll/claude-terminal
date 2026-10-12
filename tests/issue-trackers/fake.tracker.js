/**
 * A fake issue tracker, kept deliberately unlike Linear.
 *
 * It looks like GitHub Issues: keys are `#12` rather than `ENG-12`, there are
 * no priorities and no estimates, a ticket is either open or closed, and only
 * the state and comments are writable. If the core ever assumes something only
 * Linear has, the contract suite run against this adapter is what says so.
 *
 * It lives under tests/ so the registry never ships it, and keeps everything in
 * memory: `createClient` gets a `fetch` it never calls.
 */

'use strict';

const { trackerError } = require('../../src/main/issue-trackers/_contract');

const SECRET = 'fake-secret';
const ME = { id: 'u1', name: 'Ada Lovelace', avatarUrl: 'https://example.com/ada.png' };
const PEOPLE = [ME, { id: 'u2', name: 'Alan Turing', avatarUrl: null }];
const STATES = [
  { id: 'open', name: 'Open', category: 'todo', color: '#22c55e', position: 0 },
  { id: 'closed', name: 'Closed', category: 'done', color: '#a855f7', position: 1 },
];
const LABELS = [{ id: 'bug', name: 'bug', color: '#ef4444' }, { id: 'docs', name: 'docs', color: '#3b82f6' }];
const REPOS = [{ value: 'app', label: 'acme/app' }, { value: 'site', label: 'acme/site' }];

function seed() {
  const issue = (n, title, state, repo, extra = {}) => ({
    number: n, title, state, repo, labels: [], assignee: null, author: 'u2',
    body: `Body of #${n}`, comments: [], updatedAt: `2026-10-0${n}T10:00:00.000Z`, ...extra,
  });
  return [
    issue(1, 'Crash when the tab closes', 'open', 'app', { labels: ['bug'], assignee: 'u1' }),
    issue(2, 'Document the adapter contract', 'open', 'site', { labels: ['docs'], author: 'u1' }),
    issue(3, 'Old flaky test', 'closed', 'app', { comments: [{ id: 'c1', author: 'u2', body: 'Fixed by a retry.' }] }),
    issue(4, 'Sub-task of #1', 'open', 'app', { parent: 1 }),
  ];
}

const state = (id) => STATES.find((s) => s.id === id);
const person = (id) => PEOPLE.find((p) => p.id === id) || null;

function toIssue(row) {
  return {
    key: `#${row.number}`,
    id: String(row.number),
    title: row.title,
    url: `https://example.com/acme/${row.repo}/issues/${row.number}`,
    state: state(row.state),
    priority: null,
    assignee: person(row.assignee),
    labels: row.labels.map((id) => LABELS.find((l) => l.id === id)),
    container: { id: row.repo, name: REPOS.find((r) => r.value === row.repo).label },
    facets: { repository: REPOS.find((r) => r.value === row.repo).label },
    estimate: null,
    dueDate: null,
    branchName: null,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: row.updatedAt,
  };
}

function createClient({ secret }) {
  const rows = seed();
  const find = (key) => {
    const row = rows.find((r) => `#${r.number}` === key);
    if (!row) throw trackerError('NOT_FOUND', `No issue ${key}`);
    return row;
  };
  const authed = () => {
    if (secret !== SECRET) throw trackerError('AUTH', 'Bad credentials');
  };

  return {
    async whoAmI() {
      authed();
      return { user: ME, workspace: { id: 'acme', name: 'acme', url: 'https://example.com/acme' } };
    },

    async metadata() {
      authed();
      return {
        keys: [],
        people: PEOPLE,
        states: STATES,
        labels: LABELS,
        facets: [{ id: 'repository', label: 'Repository', multi: true, options: REPOS }],
      };
    },

    async listIssues(query, cursor) {
      authed();
      let list = rows.slice();
      if (query.text) {
        const needle = query.text.toLowerCase();
        list = list.filter((r) => r.title.toLowerCase().includes(needle) || `#${r.number}` === query.text);
      }
      if (query.mine === 'assigned') list = list.filter((r) => r.assignee === ME.id);
      if (query.mine === 'created') list = list.filter((r) => r.author === ME.id);
      if (query.stateCategories.length || query.stateIds.length) {
        list = list.filter((r) => query.stateCategories.includes(state(r.state).category) || query.stateIds.includes(r.state));
      }
      if (query.assigneeIds.length) {
        list = list.filter((r) => query.assigneeIds.some((a) =>
          (a === 'me' && r.assignee === ME.id) || (a === 'none' && !r.assignee) || a === r.assignee));
      }
      if (query.labelIds.length) list = list.filter((r) => r.labels.some((l) => query.labelIds.includes(l)));
      if (query.facets.repository) list = list.filter((r) => query.facets.repository.includes(r.repo));
      list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const start = cursor ? Number(cursor) : 0;
      const page = list.slice(start, start + query.limit);
      const next = start + query.limit < list.length ? String(start + query.limit) : null;
      return { issues: page.map(toIssue), next };
    },

    async getIssue(key) {
      authed();
      const row = find(key);
      return {
        ...toIssue(row),
        description: row.body,
        comments: row.comments.map((c) => ({ ...c, author: person(c.author), createdAt: '2026-10-03T12:00:00.000Z' })),
        children: rows.filter((r) => r.parent === row.number).map(toIssue),
      };
    },

    async updateIssue(key, patch) {
      authed();
      const row = find(key);
      const fields = Object.keys(patch);
      if (fields.some((f) => f !== 'stateId')) throw trackerError('PROVIDER', `Only the state is writable here, got ${fields.join(', ')}`);
      if (!state(patch.stateId)) throw trackerError('PROVIDER', `Unknown state ${patch.stateId}`);
      row.state = patch.stateId;
      row.updatedAt = new Date().toISOString();
      return toIssue(row);
    },

    async addComment(key, body) {
      authed();
      const row = find(key);
      const comment = { id: `c${Date.now()}`, author: ME.id, body };
      row.comments.push(comment);
      return { ...comment, author: ME, createdAt: new Date().toISOString() };
    },
  };
}

/** `#12`, not inside a URL fragment, a path or a hex colour. */
const HASH_REF = /(?<![\w/#&])#(\d{1,6})(?![\w])/g;

module.exports = {
  id: 'fake',
  name: 'Fake Tracker',
  auth: { type: 'apiKey', helpUrl: 'https://example.com/settings/tokens' },
  capabilities: { priority: false, labels: true, estimate: false, comments: true, write: ['state', 'comment'] },
  createClient,
  refs: {
    // knownKeys is empty for this tracker: its references carry no prefix.
    fromText(text) {
      if (typeof text !== 'string') return [];
      const out = [];
      for (const m of text.matchAll(HASH_REF)) {
        const key = `#${m[1]}`;
        if (!out.includes(key)) out.push(key);
      }
      return out;
    },
    fromToolCall({ name, input, result }) {
      const m = /^mcp__fake__(get_issue|update_issue|create_issue)$/.exec(name || '');
      if (!m) return [];
      if (m[1] === 'create_issue') {
        const number = result && typeof result === 'object' ? result.number : null;
        return Number.isInteger(number) ? [{ key: `#${number}`, action: 'create' }] : [];
      }
      const number = input && Number.isInteger(input.number) ? input.number : null;
      if (number == null) return [];
      return [{ key: `#${number}`, action: m[1] === 'get_issue' ? 'read' : 'write' }];
    },
  },
};
