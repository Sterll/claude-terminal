/**
 * Linear adapter.
 *
 * Talks to Linear's public GraphQL API with a personal API key, which Linear
 * expects as the bare `Authorization` header (no `Bearer`, that form is for
 * OAuth tokens). Every request carries an `operationName` so a fixture can
 * answer it without parsing GraphQL.
 *
 * Linear's `issues(sort:)` argument is marked internal in its schema, so only
 * `createdAt` and `updatedAt` are ordered by the server. The `priority` and
 * `due` sorts are applied to the page that came back.
 */

'use strict';

const { trackerError } = require('./_contract');
const { extractKeyedRefs } = require('../../shared/issue-trackers');

const ENDPOINT = 'https://api.linear.app/graphql';

/** Linear state types onto the shared categories. Triage is work not yet accepted. */
const CATEGORY_BY_TYPE = {
  triage: 'backlog',
  backlog: 'backlog',
  unstarted: 'todo',
  started: 'started',
  completed: 'done',
  canceled: 'canceled',
  duplicate: 'canceled',
};

const TYPES_BY_CATEGORY = {
  backlog: ['triage', 'backlog'],
  todo: ['unstarted'],
  started: ['started'],
  done: ['completed'],
  canceled: ['canceled', 'duplicate'],
};

/** Metadata lists are paged; this many pages of 250 is plenty for any workspace. */
const METADATA_PAGE = 250;
const METADATA_MAX_PAGES = 8;

/** Cycles that ended more than this long ago are not offered as a filter. */
const CYCLE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}$/;

const ISSUE_FIELDS = `
  fragment IssueFields on Issue {
    id identifier title url priority estimate dueDate branchName createdAt updatedAt
    state { id name color type }
    assignee { id name avatarUrl }
    labels(first: 20) { nodes { id name color } }
    team { id key name }
    project { id name }
    cycle { id number name }
  }`;

const USER_FIELDS = 'id name avatarUrl';

// ── Transport ────────────────────────────────────────────────────────────────

function retryAfterMs(headers) {
  const seconds = Number(headers?.get?.('retry-after'));
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const resetAt = Number(headers?.get?.('x-ratelimit-requests-reset'));
  if (Number.isFinite(resetAt) && resetAt > Date.now()) return resetAt - Date.now();
  return undefined;
}

/**
 * One GraphQL round trip, with Linear's failures mapped onto ERROR_CODES.
 * Linear reports most errors as HTTP 400 with `extensions.type`, the strings
 * its own SDK switches on ("authentication error", "ratelimited", ...).
 */
async function request(ctx, operationName, query, variables = {}) {
  let res;
  try {
    res = await ctx.fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: ctx.secret },
      body: JSON.stringify({ operationName, query, variables }),
    });
  } catch (err) {
    throw trackerError('NETWORK', `Linear is unreachable: ${err.message}`, { cause: err });
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    // An HTML error page or an empty body: handled by the status checks below.
  }

  const first = Array.isArray(body?.errors) ? body.errors[0] : null;
  const type = first?.extensions?.type || '';
  const code = first?.extensions?.code || '';
  const message = first?.extensions?.userPresentableMessage || first?.message || '';

  if (res.status === 401 || type === 'authentication error' || code === 'AUTHENTICATION_ERROR') {
    throw trackerError('AUTH', 'Linear rejected the API key');
  }
  if (res.status === 429 || type === 'ratelimited' || code === 'RATELIMITED') {
    throw trackerError('RATE_LIMITED', 'Linear rate limit reached', { retryAfterMs: retryAfterMs(res.headers) });
  }
  if (first) {
    if (/not found|could not find/i.test(`${message} ${first.message || ''}`)) {
      throw trackerError('NOT_FOUND', message || 'Not found in Linear');
    }
    throw trackerError('PROVIDER', `Linear: ${message || type || 'request failed'}`);
  }
  if (!res.ok || !body || typeof body.data !== 'object' || body.data === null) {
    throw trackerError('PROVIDER', `Linear answered HTTP ${res.status}`);
  }
  return body.data;
}

/** Every node of a paged collection, up to METADATA_MAX_PAGES pages. */
async function collect(ctx, operationName, field, nodeFields, filter) {
  // GraphQL rejects a declared variable that is never used, so $filter only
  // exists when there is one.
  const query = `query ${operationName}($first: Int!, $after: String${filter ? `, $filter: ${filter.type}` : ''}) {
    ${field}(first: $first, after: $after${filter ? ', filter: $filter' : ''}) {
      nodes { ${nodeFields} }
      pageInfo { hasNextPage endCursor }
    }
  }`;
  const nodes = [];
  let after = null;
  for (let page = 0; page < METADATA_MAX_PAGES; page++) {
    const variables = { first: METADATA_PAGE, after };
    if (filter) variables.filter = filter.value;
    const data = await request(ctx, operationName, query, variables);
    const conn = data[field] || {};
    nodes.push(...(conn.nodes || []));
    if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    after = conn.pageInfo.endCursor;
  }
  return nodes;
}

// ── Mapping ──────────────────────────────────────────────────────────────────

function toPerson(user) {
  return user ? { id: user.id, name: user.name, avatarUrl: user.avatarUrl || null } : null;
}

function cycleLabel(cycle) {
  return cycle.name || `Cycle ${cycle.number}`;
}

function toIssue(node) {
  const facets = {};
  if (node.project?.name) facets.project = node.project.name;
  if (node.cycle) facets.cycle = cycleLabel(node.cycle);
  const priority = Number.isFinite(node.priority) ? Math.round(node.priority) : null;
  return {
    key: node.identifier,
    id: node.id,
    title: node.title,
    url: node.url,
    state: {
      id: node.state?.id,
      name: node.state?.name,
      color: node.state?.color,
      category: CATEGORY_BY_TYPE[node.state?.type] || 'backlog',
    },
    priority: priority >= 0 && priority <= 4 ? priority : null,
    assignee: toPerson(node.assignee),
    labels: (node.labels?.nodes || []).map((l) => ({ id: l.id, name: l.name, color: l.color })),
    container: node.team ? { id: node.team.id, name: node.team.name } : null,
    facets,
    estimate: Number.isFinite(node.estimate) ? node.estimate : null,
    dueDate: node.dueDate || null,
    branchName: node.branchName || null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

/**
 * The provider-neutral query as a Linear `IssueFilter`. Each clause is pushed
 * into one `and`, so filters combine the way the filter bar shows them.
 *
 * @param {object} q a normalizeQuery() result
 * @returns {object|null}
 */
function buildIssueFilter(q) {
  const and = [];

  if (q.text) {
    const key = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,7})$/.exec(q.text);
    if (key) {
      and.push({ team: { key: { eqIgnoreCase: key[1] } }, number: { eq: Number(key[2]) } });
    } else {
      const text = [{ title: { containsIgnoreCase: q.text } }, { description: { containsIgnoreCase: q.text } }];
      // "4504" is how people say XCP-4504 out loud: the number, in any team.
      if (/^\d{1,7}$/.test(q.text)) text.unshift({ number: { eq: Number(q.text) } });
      and.push({ or: text });
    }
  }

  if (q.mine === 'assigned') and.push({ assignee: { isMe: { eq: true } } });
  if (q.mine === 'created') and.push({ creator: { isMe: { eq: true } } });
  if (q.mine === 'subscribed') and.push({ subscribers: { some: { isMe: { eq: true } } } });

  // Categories and states are one filter, "Status": a state matches either.
  const status = [];
  if (q.stateCategories.length) {
    status.push({ state: { type: { in: q.stateCategories.flatMap((c) => TYPES_BY_CATEGORY[c]) } } });
  }
  if (q.stateIds.length) status.push({ state: { id: { in: q.stateIds } } });
  if (status.length) and.push(status.length === 1 ? status[0] : { or: status });

  if (q.assigneeIds.length) {
    const ids = q.assigneeIds.filter((a) => a !== 'me' && a !== 'none');
    const any = [];
    if (q.assigneeIds.includes('me')) any.push({ assignee: { isMe: { eq: true } } });
    if (q.assigneeIds.includes('none')) any.push({ assignee: { null: true } });
    if (ids.length) any.push({ assignee: { id: { in: ids } } });
    and.push(any.length === 1 ? any[0] : { or: any });
  }

  if (q.priorities.length) and.push({ priority: { in: q.priorities } });
  if (q.labelIds.length) and.push({ labels: { some: { id: { in: q.labelIds } } } });
  if (q.facets.team) and.push({ team: { id: { in: q.facets.team } } });
  if (q.facets.project) and.push({ project: { id: { in: q.facets.project } } });
  if (q.facets.cycle) and.push({ cycle: { id: { in: q.facets.cycle } } });
  if (q.updatedSince) and.push({ updatedAt: { gt: q.updatedSince } });

  return and.length ? { and } : null;
}

/** Linear's "no priority" is 0 and sorts last, as it does in Linear itself. */
function sortPage(issues, sort) {
  if (sort === 'priority') {
    const rank = (p) => (p ? p : 5);
    return issues.slice().sort((a, b) => rank(a.priority) - rank(b.priority));
  }
  if (sort === 'due') {
    return issues.slice().sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  }
  return issues;
}

// ── Client ───────────────────────────────────────────────────────────────────

function createClient({ secret, fetch }) {
  const ctx = { secret, fetch };

  return {
    async whoAmI() {
      const data = await request(ctx, 'Viewer', `query Viewer {
        viewer { ${USER_FIELDS} }
        organization { id name urlKey }
      }`);
      return {
        user: toPerson(data.viewer),
        workspace: {
          id: data.organization.id,
          name: data.organization.name,
          url: `https://linear.app/${data.organization.urlKey}`,
        },
      };
    },

    async metadata() {
      const since = new Date(Date.now() - CYCLE_LOOKBACK_MS).toISOString();
      const [teams, states, users, labels, projects, cycles] = await Promise.all([
        collect(ctx, 'Teams', 'teams', 'id key name'),
        collect(ctx, 'States', 'workflowStates', 'id name color type position team { id }'),
        collect(ctx, 'Users', 'users', USER_FIELDS, { type: 'UserFilter', value: { active: { eq: true } } }),
        collect(ctx, 'Labels', 'issueLabels', 'id name color'),
        collect(ctx, 'Projects', 'projects', 'id name color', {
          type: 'ProjectFilter', value: { completedAt: { null: true }, canceledAt: { null: true } },
        }),
        collect(ctx, 'Cycles', 'cycles', 'id number name isActive startsAt team { key }', {
          type: 'CycleFilter', value: { endsAt: { gt: since } },
        }),
      ]);

      cycles.sort((a, b) => (b.isActive - a.isActive) || String(a.startsAt).localeCompare(String(b.startsAt)));

      return {
        keys: teams.map((t) => t.key),
        people: users.map(toPerson),
        states: states.map((s) => ({
          id: s.id,
          name: s.name,
          color: s.color,
          category: CATEGORY_BY_TYPE[s.type] || 'backlog',
          position: s.position,
          containerId: s.team?.id || null,
        })),
        labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
        facets: [
          { id: 'team', label: 'Team', multi: true, options: teams.map((t) => ({ value: t.id, label: `${t.name} (${t.key})` })) },
          { id: 'project', label: 'Project', multi: true, options: projects.map((p) => ({ value: p.id, label: p.name, color: p.color })) },
          {
            id: 'cycle',
            label: 'Cycle',
            multi: true,
            options: cycles.map((c) => ({ value: c.id, label: `${c.team?.key ? `${c.team.key} ` : ''}${cycleLabel(c)}` })),
          },
        ],
      };
    },

    async listIssues(query, cursor) {
      const data = await request(ctx, 'Issues', `query Issues($first: Int!, $after: String, $filter: IssueFilter, $orderBy: PaginationOrderBy) {
        issues(first: $first, after: $after, filter: $filter, orderBy: $orderBy) {
          nodes { ...IssueFields }
          pageInfo { hasNextPage endCursor }
        }
      }
      ${ISSUE_FIELDS}`, {
        first: query.limit,
        after: cursor || null,
        filter: buildIssueFilter(query),
        orderBy: query.sort === 'created' ? 'createdAt' : 'updatedAt',
      });
      const conn = data.issues || {};
      return {
        issues: sortPage((conn.nodes || []).map(toIssue), query.sort),
        next: conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor || null : null,
      };
    },

    async getIssue(key) {
      const data = await request(ctx, 'Issue', `query Issue($id: String!) {
        issue(id: $id) {
          ...IssueFields
          description
          comments(first: 100) { nodes { id body createdAt user { ${USER_FIELDS} } } }
          children(first: 100) { nodes { ...IssueFields } }
        }
      }
      ${ISSUE_FIELDS}`, { id: key });
      const node = data.issue;
      if (!node) throw trackerError('NOT_FOUND', `No Linear issue ${key}`);
      const comments = (node.comments?.nodes || [])
        .map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, author: toPerson(c.user) }))
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      return {
        ...toIssue(node),
        description: node.description || null,
        comments,
        children: (node.children?.nodes || []).map(toIssue),
      };
    },

    async updateIssue(key, patch) {
      const input = {};
      if (patch.stateId !== undefined) input.stateId = patch.stateId;
      if (patch.assigneeId !== undefined) input.assigneeId = patch.assigneeId;
      if (patch.priority !== undefined) input.priority = patch.priority;
      if (!Object.keys(input).length) throw trackerError('PROVIDER', 'Nothing to update');
      const data = await request(ctx, 'IssueUpdate', `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success issue { ...IssueFields } }
      }
      ${ISSUE_FIELDS}`, { id: key, input });
      if (!data.issueUpdate?.success || !data.issueUpdate.issue) throw trackerError('PROVIDER', `Linear did not update ${key}`);
      return toIssue(data.issueUpdate.issue);
    },

    async addComment(key, body) {
      const data = await request(ctx, 'CommentCreate', `mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id body createdAt user { ${USER_FIELDS} } } }
      }`, { input: { issueId: key, body } });
      const comment = data.commentCreate?.comment;
      if (!data.commentCreate?.success || !comment) throw trackerError('PROVIDER', `Linear did not add the comment to ${key}`);
      return { id: comment.id, body: comment.body, createdAt: comment.createdAt, author: toPerson(comment.user) };
    },
  };
}

// ── References ───────────────────────────────────────────────────────────────

function identifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value.trim()) ? value.trim().toUpperCase() : null;
}

/** Whatever a tool result looks like (string, content blocks, object), as text. */
function resultText(result) {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return result.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('\n');
  if (result && Array.isArray(result.content)) return resultText(result.content);
  try {
    return JSON.stringify(result) || '';
  } catch {
    return '';
  }
}

/** The key of an issue a tool just created: its `identifier` field, or its Linear URL. */
function createdKey(result) {
  const text = resultText(result).slice(0, 200_000);
  const field = /"identifier"\s*:\s*"([A-Za-z][A-Za-z0-9]{0,9}-\d{1,7})"/.exec(text);
  if (field) return field[1].toUpperCase();
  const url = /linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]{0,9}-\d{1,7})\b/.exec(text);
  return url ? url[1].toUpperCase() : null;
}

/**
 * Linear MCP tools, whatever the server was named when it was added: the
 * claude.ai connector (`mcp__claude_ai_Linear__save_issue`), the official
 * server (`mcp__linear__...`, `mcp__linear-server__...`) or a plugin.
 * Only tickets a call targets or creates count; list results never do.
 */
function fromToolCall({ name, input, result } = {}) {
  const parts = typeof name === 'string' ? name.split('__') : [];
  if (parts.length !== 3 || parts[0] !== 'mcp' || !/linear/i.test(parts[1])) return [];
  const args = input && typeof input === 'object' ? input : {};
  const one = (key, action) => (key ? [{ key, action }] : []);

  switch (parts[2]) {
    case 'get_issue':
      return one(identifier(args.id), 'read');
    case 'list_comments':
      return one(identifier(args.issueId), 'read');
    case 'save_comment':
    case 'create_comment':
      return one(identifier(args.issueId), 'write');
    case 'save_issue':
    case 'update_issue':
    case 'create_issue':
      if (args.id) return one(identifier(args.id), 'write');
      return one(createdKey(result), 'create');
    default:
      return [];
  }
}

module.exports = {
  id: 'linear',
  name: 'Linear',
  auth: { type: 'apiKey', helpUrl: 'https://linear.app/settings/account/security' },
  capabilities: {
    priority: true,
    labels: true,
    estimate: true,
    comments: true,
    write: ['state', 'assignee', 'priority', 'comment'],
  },
  createClient,
  refs: {
    fromText: (text, knownKeys) => extractKeyedRefs(text, knownKeys),
    fromToolCall,
  },
  // Exposed for the adapter's own tests, not part of the contract.
  _internals: { buildIssueFilter, toIssue, sortPage, CATEGORY_BY_TYPE },
};
