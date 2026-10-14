/**
 * Linear adapter.
 *
 * Talks to Linear's public GraphQL API with a personal API key, which Linear
 * expects as the bare `Authorization` header (no `Bearer`, that form is for
 * OAuth tokens). Every request carries an `operationName` so a fixture can
 * answer it without parsing GraphQL.
 *
 * Linear's `issues(sort:)` argument is marked internal in its schema, so only
 * `createdAt` and `updatedAt` are ordered by the server (`orderBy`). The
 * `priority` and `due` sorts are still exact across pages, never a reordered
 * page: priority walks one priority at a time, each newest first, and due
 * ranks every dated issue from a light scan before fetching a page of them.
 * Those two carry their own cursor, a small JSON object.
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

/** Linear's "no priority" is 0 and sorts last, as it does in Linear itself. */
const PRIORITY_ORDER = [1, 2, 3, 4, 0];

/**
 * The due sort ranks every matching issue that has a due date, this many
 * pages of METADATA_PAGE at most. Past that it refuses rather than rank a
 * sample of them.
 */
const DUE_SCAN_MAX_PAGES = 8;

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
    parent { id identifier title url state { id name color type } }
  }`;

/**
 * Sub-issue counts come METADATA_PAGE to a request, for at most this many
 * requests: past 1000 children on one page of issues, the counts are left out.
 */
const PROGRESS_MAX_PAGES = 4;

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
 * A key that can travel as a header value: printable ASCII, no whitespace.
 * Anything else makes `fetch` throw an error that quotes the whole value, so
 * a key pasted with a stray newline would end up in the log and the toast.
 */
const WELL_FORMED_KEY = /^[\x21-\x7E]+$/;

/** A system error code such as ENOTFOUND, never free text that could quote the request. */
function networkCode(err) {
  const code = err?.cause?.code ?? err?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(code) ? code : null;
}

/** A "not found" about `entity`: Linear words it "Entity not found: Issue". */
function isNotFound(text, entity) {
  if (!/not found|could not find/i.test(text)) return false;
  const named = [...text.matchAll(/(?:entity not found:|could not find referenced)\s+([A-Za-z]+)/gi)].map((m) => m[1].toLowerCase());
  return named.every((n) => n === entity.toLowerCase());
}

/**
 * One GraphQL round trip, with Linear's failures mapped onto ERROR_CODES.
 * Linear reports most errors as HTTP 400 with `extensions.type`, the strings
 * its own SDK switches on ("authentication error", "ratelimited", ...).
 *
 * `notFound` names the one entity the request is about ("Issue"). Only then
 * is a "not found" error NOT_FOUND, and only when it does not name another
 * entity: a list that fails, or an update whose state no longer exists, is
 * not a missing issue.
 */
async function request(ctx, operationName, query, variables = {}, { notFound = null } = {}) {
  if (typeof ctx.secret !== 'string' || !WELL_FORMED_KEY.test(ctx.secret)) {
    throw trackerError('AUTH', 'The API key is malformed');
  }
  let res;
  try {
    res = await ctx.fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: ctx.secret },
      body: JSON.stringify({ operationName, query, variables }),
    });
  } catch (err) {
    // Not err.message, and not err as the cause: a fetch error can quote the
    // headers it was given, the key among them.
    const code = networkCode(err);
    throw trackerError('NETWORK', code ? `Linear is unreachable (${code})` : 'Linear is unreachable');
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
    if (notFound && isNotFound(`${message} ${first.message || ''}`, notFound)) {
      throw trackerError('NOT_FOUND', message || 'Not found in Linear');
    }
    throw trackerError('PROVIDER', `Linear: ${message || type || 'request failed'}`);
  }
  if (!res.ok || !body || typeof body.data !== 'object' || body.data === null) {
    throw trackerError('PROVIDER', `Linear answered HTTP ${res.status}`);
  }
  return body.data;
}

/**
 * Every node of a paged collection, up to `maxPages` pages. `complete` is
 * false when the collection goes on past that, or when Linear says there is
 * a next page without a cursor to reach it.
 */
async function collectPages(ctx, operationName, field, nodeFields, filter, maxPages = METADATA_MAX_PAGES) {
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
  for (let page = 0; page < maxPages; page++) {
    const variables = { first: METADATA_PAGE, after };
    if (filter) variables.filter = filter.value;
    const data = await request(ctx, operationName, query, variables);
    const conn = data[field] || {};
    nodes.push(...(conn.nodes || []));
    if (!conn.pageInfo?.hasNextPage) return { nodes, complete: true };
    if (!conn.pageInfo.endCursor) break;
    after = conn.pageInfo.endCursor;
  }
  return { nodes, complete: false };
}

/** Every node of a paged collection, as far as METADATA_MAX_PAGES pages reach. */
async function collect(ctx, operationName, field, nodeFields, filter) {
  return (await collectPages(ctx, operationName, field, nodeFields, filter)).nodes;
}

// ── Mapping ──────────────────────────────────────────────────────────────────

function toPerson(user) {
  return user ? { id: user.id, name: user.name, avatarUrl: user.avatarUrl || null } : null;
}

function cycleLabel(cycle) {
  return cycle.name || `Cycle ${cycle.number}`;
}

function toState(state) {
  return {
    id: state?.id,
    name: state?.name,
    color: state?.color,
    category: CATEGORY_BY_TYPE[state?.type] || 'backlog',
  };
}

const isClosed = (type) => ['done', 'canceled'].includes(CATEGORY_BY_TYPE[type]);

/**
 * `{ total, done }` from a connection of sub-issues, null when there are none,
 * or when it holds only the first page of them: a partial count is not one.
 */
function progressOf(conn) {
  const nodes = conn?.nodes;
  if (!nodes?.length || conn.pageInfo?.hasNextPage) return null;
  return { total: nodes.length, done: nodes.filter((n) => isClosed(n.state?.type)).length };
}

/** The counts `subIssueCounts` found, on the issue and on its parent. */
function withProgress(issue, node, counts) {
  issue.subIssues = counts.get(node.id) || null;
  if (issue.parent) issue.parent.subIssues = counts.get(node.parent.id) || null;
  return issue;
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
    state: toState(node.state),
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
    parent: node.parent
      ? { key: node.parent.identifier, title: node.parent.title, url: node.parent.url, state: node.parent.state ? toState(node.parent.state) : null }
      : null,
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
    const text = [{ title: { containsIgnoreCase: q.text } }, { description: { containsIgnoreCase: q.text } }];
    // Something shaped like a key finds that issue, and still searches the
    // text: "utf-8" and "covid-19" are words before they are keys.
    const key = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,7})$/.exec(q.text);
    if (key) text.unshift({ team: { key: { eqIgnoreCase: key[1] } }, number: { eq: Number(key[2]) } });
    // "4504" is how people say XCP-4504 out loud: the number, in any team.
    else if (/^\d{1,7}$/.test(q.text)) text.unshift({ number: { eq: Number(q.text) } });
    and.push({ or: text });
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

/** `filter` with one more clause, combined with AND like the rest. */
function withClause(filter, clause) {
  return { and: [...(filter?.and || []), clause] };
}

/** Earliest due date first; the same date, most recently updated first. */
function byDueDate(a, b) {
  return a.dueDate.localeCompare(b.dueDate)
    || String(b.updatedAt).localeCompare(String(a.updatedAt))
    || String(a.id).localeCompare(String(b.id));
}

/**
 * The cursor of a `priority` or `due` page, which the adapter wrote itself.
 * Anything else is refused rather than read as the first page, which would
 * hand the same issues back a second time.
 */
function readCursor(cursor, sort) {
  if (!cursor) return null;
  let value = null;
  try {
    value = JSON.parse(cursor);
  } catch {
    // Falls through to the refusal below.
  }
  if (!value || typeof value !== 'object' || value.s !== sort) throw trackerError('PROVIDER', 'Invalid page cursor');
  return value;
}

// ── Client ───────────────────────────────────────────────────────────────────

function createClient({ secret, fetch }) {
  const ctx = { secret, fetch };

  /**
   * How many sub-issues each listed issue and each listed issue's parent has,
   * and how many are closed: all of them, not only the listed ones. Linear has
   * no count field, so this asks for the children themselves, which costs
   * a few points per child rather than a nested connection per listed issue.
   * Decoration only: a failure, or more children than PROGRESS_MAX_PAGES
   * reach, leaves the counts out and the list stands.
   */
  async function subIssueCounts(nodes) {
    const ids = [...new Set(nodes.flatMap((n) => [n.id, n.parent?.id]).filter(Boolean))];
    if (!ids.length) return new Map();
    let children;
    try {
      const res = await collectPages(ctx, 'SubIssues', 'issues', 'parent { id } state { type }', {
        type: 'IssueFilter', value: { parent: { id: { in: ids } } },
      }, PROGRESS_MAX_PAGES);
      // A partial count would be shown as the real one: none is better.
      if (!res.complete) return new Map();
      children = res.nodes;
    } catch {
      return new Map();
    }
    const counts = new Map();
    for (const child of children) {
      const id = child.parent?.id;
      if (!id) continue;
      const c = counts.get(id) || { total: 0, done: 0 };
      c.total++;
      if (isClosed(child.state?.type)) c.done++;
      counts.set(id, c);
    }
    return counts;
  }

  /** One page of full issues, as Linear orders them. */
  async function issuePage(filter, first, after, orderBy = 'updatedAt') {
    const data = await request(ctx, 'Issues', `query Issues($first: Int!, $after: String, $filter: IssueFilter, $orderBy: PaginationOrderBy) {
      issues(first: $first, after: $after, filter: $filter, orderBy: $orderBy) {
        nodes { ...IssueFields }
        pageInfo { hasNextPage endCursor }
      }
    }
    ${ISSUE_FIELDS}`, { first, after: after || null, filter, orderBy });
    const conn = data.issues || {};
    return { nodes: conn.nodes || [], next: conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor || null : null };
  }

  /**
   * Priority order across pages: every urgent issue, then every high one,
   * and so on, each priority newest first. A page that empties one priority
   * goes on with the next, so it is only short at the very end.
   */
  async function priorityPage(query, cursor) {
    const base = buildIssueFilter(query);
    const order = PRIORITY_ORDER.filter((p) => !query.priorities.length || query.priorities.includes(p));
    let at = cursor ? order.indexOf(cursor.p) : 0;
    if (at < 0) throw trackerError('PROVIDER', 'Invalid page cursor');
    let after = cursor?.a || null;
    const nodes = [];
    while (at < order.length && nodes.length < query.limit) {
      const page = await issuePage(withClause(base, { priority: { eq: order[at] } }), query.limit - nodes.length, after);
      nodes.push(...page.nodes);
      if (page.next) return { nodes, next: { s: 'priority', p: order[at], a: page.next } };
      at++;
      after = null;
    }
    return { nodes, next: at < order.length ? { s: 'priority', p: order[at], a: null } : null };
  }

  /**
   * Due date order across pages: every dated issue, earliest first, then the
   * undated ones, newest first. Linear cannot order by due date, so the dated
   * ones are ranked from a scan of their ids and dates, and a page fetches
   * its slice of that ranking.
   */
  async function duePage(query, cursor) {
    const base = buildIssueFilter(query);
    const nodes = [];
    if (!cursor || cursor.d !== undefined) {
      const offset = Number.isInteger(cursor?.d) && cursor.d >= 0 ? cursor.d : 0;
      const scan = await collectPages(ctx, 'DueDates', 'issues', 'id dueDate updatedAt', {
        type: 'IssueFilter', value: withClause(base, { dueDate: { null: false } }),
      }, DUE_SCAN_MAX_PAGES);
      if (!scan.complete) {
        throw trackerError('PROVIDER', `More than ${DUE_SCAN_MAX_PAGES * METADATA_PAGE} issues with a due date match: narrow the filters to sort by due date`);
      }
      const ranked = scan.nodes.filter((n) => n.dueDate).sort(byDueDate);
      const ids = ranked.slice(offset, offset + query.limit).map((n) => n.id);
      if (ids.length) {
        const page = await issuePage({ id: { in: ids } }, ids.length, null);
        const byId = new Map(page.nodes.map((n) => [n.id, n]));
        nodes.push(...ids.map((id) => byId.get(id)).filter(Boolean));
      }
      if (offset + query.limit < ranked.length) return { nodes, next: { s: 'due', d: offset + query.limit } };
      if (ids.length >= query.limit) return { nodes, next: { s: 'due', u: null } };
    }
    const page = await issuePage(withClause(base, { dueDate: { null: true } }), query.limit - nodes.length, cursor?.u || null);
    nodes.push(...page.nodes);
    return { nodes, next: page.next ? { s: 'due', u: page.next } : null };
  }

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
      let page;
      if (query.sort === 'priority') page = await priorityPage(query, readCursor(cursor, 'priority'));
      else if (query.sort === 'due') page = await duePage(query, readCursor(cursor, 'due'));
      else page = await issuePage(buildIssueFilter(query), query.limit, cursor, query.sort === 'created' ? 'createdAt' : 'updatedAt');
      const counts = await subIssueCounts(page.nodes);
      return {
        issues: page.nodes.map((n) => withProgress(toIssue(n), n, counts)),
        next: page.next && typeof page.next === 'object' ? JSON.stringify(page.next) : page.next,
      };
    },

    async getIssue(key) {
      const data = await request(ctx, 'Issue', `query Issue($id: String!) {
        issue(id: $id) {
          ...IssueFields
          description
          comments(first: 100) { nodes { id body createdAt user { ${USER_FIELDS} } } }
          children(first: 100) { nodes { ...IssueFields } pageInfo { hasNextPage } }
          parent { children(first: 100) { nodes { state { type } } pageInfo { hasNextPage } } }
        }
      }
      ${ISSUE_FIELDS}`, { id: key }, { notFound: 'Issue' });
      const node = data.issue;
      if (!node) throw trackerError('NOT_FOUND', `No Linear issue ${key}`);
      const comments = (node.comments?.nodes || [])
        .map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, author: toPerson(c.user) }))
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      const issue = toIssue(node);
      issue.subIssues = progressOf(node.children);
      if (issue.parent) issue.parent.subIssues = progressOf(node.parent.children);
      return {
        ...issue,
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
      ${ISSUE_FIELDS}`, { id: key, input }, { notFound: 'Issue' });
      if (!data.issueUpdate?.success || !data.issueUpdate.issue) throw trackerError('PROVIDER', `Linear did not update ${key}`);
      const node = data.issueUpdate.issue;
      return withProgress(toIssue(node), node, await subIssueCounts([node]));
    },

    async addComment(key, body) {
      const data = await request(ctx, 'CommentCreate', `mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id body createdAt user { ${USER_FIELDS} } } }
      }`, { input: { issueId: key, body } }, { notFound: 'Issue' });
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
  _internals: { buildIssueFilter, toIssue, CATEGORY_BY_TYPE },
};
