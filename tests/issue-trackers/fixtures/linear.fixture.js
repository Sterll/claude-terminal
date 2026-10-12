/**
 * Contract fixture for the Linear adapter: a fake Linear GraphQL endpoint over
 * an invented workspace. Nothing here is real data.
 *
 * It dispatches on the `operationName` every adapter request carries, and it
 * evaluates the `IssueFilter` the adapter builds, so a filter the adapter
 * mistranslates returns the wrong issues here as it would against Linear. A
 * filter field it does not know is answered with a GraphQL error rather than
 * ignored, so a new clause cannot slip past the tests unevaluated.
 *
 * Also used to take the PR screenshots with fake data.
 */

'use strict';

const SECRET = 'lin_api_fixture0000000000000000000000000000000';
const VIEWER = 'u-ada';
const NOW = Date.parse('2026-10-09T09:00:00.000Z');
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();

const ORGANIZATION = { id: 'org-acme', name: 'Acme', urlKey: 'acme' };

const USERS = [
  { id: 'u-ada', name: 'Ada Lovelace', avatarUrl: null },
  { id: 'u-grace', name: 'Grace Hopper', avatarUrl: null },
  { id: 'u-alan', name: 'Alan Turing', avatarUrl: null },
  { id: 'u-margaret', name: 'Margaret Hamilton', avatarUrl: null },
];

const TEAMS = [
  { id: 't-eng', key: 'ENG', name: 'Engineering' },
  { id: 't-ops', key: 'OPS', name: 'Operations' },
  { id: 't-des', key: 'DES', name: 'Design' },
];

const STATE_SET = [
  ['triage', 'Triage', 'triage', '#fc7840'],
  ['backlog', 'Backlog', 'backlog', '#bec2c8'],
  ['todo', 'Todo', 'unstarted', '#e2e2e2'],
  ['progress', 'In Progress', 'started', '#f2c94c'],
  ['review', 'In Review', 'started', '#0f783c'],
  ['done', 'Done', 'completed', '#5e6ad2'],
  ['canceled', 'Canceled', 'canceled', '#95a2b3'],
  ['duplicate', 'Duplicate', 'duplicate', '#95a2b3'],
];

const STATES = TEAMS.flatMap((team) => STATE_SET
  .filter(([slug]) => team.key === 'ENG' || !['triage', 'review', 'duplicate'].includes(slug))
  .map(([slug, name, type, color], position) => ({
    id: `s-${team.key.toLowerCase()}-${slug}`, name, type, color, position, team: { id: team.id },
  })));

const LABELS = [
  { id: 'l-bug', name: 'bug', color: '#eb5757' },
  { id: 'l-feature', name: 'feature', color: '#bb87fc' },
  { id: 'l-perf', name: 'perf', color: '#4ea7fc' },
  { id: 'l-ux', name: 'ux', color: '#f2994a' },
  { id: 'l-docs', name: 'docs', color: '#26b5ce' },
];

const PROJECTS = [
  { id: 'p-tickets', name: 'Tickets', color: '#5e6ad2' },
  { id: 'p-sessions', name: 'Session tabs', color: '#26b5ce' },
  { id: 'p-onboarding', name: 'Onboarding', color: '#f2c94c' },
];

const CYCLES = [
  { id: 'c-eng-41', number: 41, name: null, isActive: false, startsAt: daysAgo(24), endsAt: daysAgo(10), team: { key: 'ENG' } },
  { id: 'c-eng-42', number: 42, name: null, isActive: true, startsAt: daysAgo(10), endsAt: daysAgo(-4), team: { key: 'ENG' } },
  { id: 'c-eng-43', number: 43, name: null, isActive: false, startsAt: daysAgo(-4), endsAt: daysAgo(-18), team: { key: 'ENG' } },
  { id: 'c-ops-7', number: 7, name: 'Hardening', isActive: true, startsAt: daysAgo(6), endsAt: daysAgo(-8), team: { key: 'OPS' } },
];

/** [identifier, title, state slug, priority, assignee, labels, project, cycle, extra] */
const ROWS = [
  ['ENG-142', 'Session tickets tab', 'progress', 1, 'u-ada', ['l-feature'], 'p-tickets', 'c-eng-42', {
    estimate: 3,
    description: '## Why\nEach session should show the tickets it works on, with their live status.\n\n## Scope\n- Tickets tab beside Changes and Documents\n- Link, unlink, change the status in place',
    comments: [
      { id: 'cm-1', user: 'u-grace', body: 'Can the board show how many sessions work on a card?', at: 2 },
      { id: 'cm-2', user: 'u-ada', body: 'Yes, from the link store. It lands with the session tab.', at: 1 },
    ],
    subscribers: ['u-ada', 'u-grace'],
  }],
  ['ENG-139', 'Transcript pruner loses its position on remount', 'progress', 2, 'u-ada', ['l-bug'], null, 'c-eng-42', { estimate: 2 }],
  ['ENG-137', 'Measure before writing during tab drag', 'review', 2, 'u-ada', ['l-perf'], null, 'c-eng-42', { estimate: 1 }],
  ['ENG-151', 'Persist ticket filters per screen', 'todo', 2, 'u-ada', ['l-feature'], 'p-tickets', null, { parent: 'ENG-142' }],
  ['ENG-148', 'Import Linear custom views as presets', 'todo', 3, 'u-grace', ['l-feature'], 'p-tickets', 'c-eng-43', { creator: 'u-ada' }],
  ['ENG-128', 'Git tab for each session', 'todo', 3, 'u-alan', ['l-feature'], 'p-sessions', 'c-eng-43', {}],
  ['ENG-133', 'Swimlanes by assignee on the board', 'backlog', 0, 'u-grace', ['l-ux'], 'p-tickets', null, {}],
  ['ENG-155', 'Key prefixes shared between two trackers', 'backlog', 4, null, ['l-bug'], 'p-tickets', null, { creator: 'u-ada' }],
  ['ENG-121', 'Confirmation card for detected tickets', 'backlog', 3, null, ['l-feature'], 'p-sessions', null, { parent: 'ENG-142' }],
  ['ENG-160', 'Crash report from the nightly build', 'triage', 0, null, ['l-bug'], null, null, {}],
  ['ENG-117', 'Crash when a tab closes mid-stream', 'done', 1, 'u-alan', ['l-bug'], null, 'c-eng-41', {}],
  ['ENG-110', 'Rewrite the legacy diff view', 'canceled', 4, null, [], null, null, {}],
  ['OPS-12', 'Rotate the relay certificates', 'progress', 2, 'u-margaret', [], null, 'c-ops-7', { dueDate: '2026-10-15' }],
  ['OPS-9', 'Nightly backup check', 'done', 3, 'u-margaret', ['l-docs'], null, null, {}],
  ['DES-31', 'Ticket card density on small screens', 'todo', 3, 'u-grace', ['l-ux'], 'p-tickets', null, { dueDate: '2026-10-20' }],
  ['DES-28', 'Empty state illustrations', 'backlog', 4, null, ['l-ux'], 'p-onboarding', null, {}],
];

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function seed() {
  return ROWS.map(([identifier, title, stateSlug, priority, assignee, labels, project, cycle, extra], i) => {
    const [teamKey, number] = identifier.split('-');
    const team = TEAMS.find((t) => t.key === teamKey);
    return {
      id: `i-${identifier.toLowerCase()}`,
      identifier,
      number: Number(number),
      title,
      teamId: team.id,
      stateId: `s-${teamKey.toLowerCase()}-${stateSlug}`,
      priority,
      assigneeId: assignee,
      creatorId: extra.creator || assignee || 'u-grace',
      labelIds: labels,
      projectId: project,
      cycleId: cycle,
      estimate: extra.estimate ?? null,
      dueDate: extra.dueDate || null,
      description: extra.description || null,
      parent: extra.parent || null,
      subscribers: extra.subscribers || [extra.creator || assignee].filter(Boolean),
      comments: (extra.comments || []).map((c) => ({ id: c.id, userId: c.user, body: c.body, createdAt: daysAgo(c.at) })),
      createdAt: daysAgo(20 + i),
      updatedAt: new Date(NOW - i * 3_600_000 * 5).toISOString(),
    };
  });
}

let issues = seed();

/** Restore the seed data. Contract tests write to it. */
function reset() {
  issues = seed();
}

// ── Shapes, as Linear returns them ───────────────────────────────────────────

const user = (id) => USERS.find((u) => u.id === id) || null;

function issueNode(row) {
  const team = TEAMS.find((t) => t.id === row.teamId);
  const state = STATES.find((s) => s.id === row.stateId);
  const project = PROJECTS.find((p) => p.id === row.projectId);
  const cycle = CYCLES.find((c) => c.id === row.cycleId);
  const assignee = user(row.assigneeId);
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    url: `https://linear.app/acme/issue/${row.identifier}/${slugify(row.title)}`,
    priority: row.priority,
    estimate: row.estimate,
    dueDate: row.dueDate,
    branchName: `ada/${row.identifier.toLowerCase()}-${slugify(row.title)}`,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    state: { id: state.id, name: state.name, color: state.color, type: state.type },
    assignee,
    labels: { nodes: row.labelIds.map((id) => LABELS.find((l) => l.id === id)) },
    team,
    project: project ? { id: project.id, name: project.name } : null,
    cycle: cycle ? { id: cycle.id, number: cycle.number, name: cycle.name } : null,
  };
}

// ── IssueFilter evaluation ───────────────────────────────────────────────────

class UnknownFilter extends Error {}

const lower = (s) => String(s || '').toLowerCase();

function matchField(row, field, cond) {
  const state = STATES.find((s) => s.id === row.stateId);
  const team = TEAMS.find((t) => t.id === row.teamId);
  switch (field) {
    case 'team':
      if (cond.key?.eqIgnoreCase !== undefined) return lower(team.key) === lower(cond.key.eqIgnoreCase);
      if (cond.id?.in) return cond.id.in.includes(team.id);
      break;
    case 'number':
      if (cond.eq !== undefined) return row.number === cond.eq;
      break;
    case 'title':
    case 'description':
      if (cond.containsIgnoreCase !== undefined) return lower(row[field]).includes(lower(cond.containsIgnoreCase));
      break;
    case 'assignee':
      if (cond.isMe?.eq === true) return row.assigneeId === VIEWER;
      if (cond.null === true) return !row.assigneeId;
      if (cond.id?.in) return cond.id.in.includes(row.assigneeId);
      break;
    case 'creator':
      if (cond.isMe?.eq === true) return row.creatorId === VIEWER;
      break;
    case 'subscribers':
      if (cond.some?.isMe?.eq === true) return row.subscribers.includes(VIEWER);
      break;
    case 'state':
      if (cond.type?.in) return cond.type.in.includes(state.type);
      if (cond.id?.in) return cond.id.in.includes(state.id);
      break;
    case 'priority':
      if (cond.in) return cond.in.includes(row.priority);
      break;
    case 'labels':
      if (cond.some?.id?.in) return row.labelIds.some((id) => cond.some.id.in.includes(id));
      break;
    case 'project':
      if (cond.id?.in) return cond.id.in.includes(row.projectId);
      break;
    case 'cycle':
      if (cond.id?.in) return cond.id.in.includes(row.cycleId);
      break;
    case 'updatedAt':
      if (cond.gt !== undefined) return row.updatedAt > cond.gt;
      break;
    default:
  }
  throw new UnknownFilter(`fixture does not evaluate ${field}: ${JSON.stringify(cond)}`);
}

function matches(row, filter) {
  if (!filter) return true;
  return Object.entries(filter).every(([field, cond]) => {
    if (field === 'and') return cond.every((c) => matches(row, c));
    if (field === 'or') return cond.some((c) => matches(row, c));
    return matchField(row, field, cond);
  });
}

// ── Endpoint ─────────────────────────────────────────────────────────────────

const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });

function reply(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

const graphqlError = (message, type, userPresentableMessage) => ({
  data: null,
  errors: [{ message, extensions: { type, userPresentableMessage } }],
});

function resolve(operationName, v) {
  switch (operationName) {
    case 'Viewer':
      return { viewer: user(VIEWER), organization: ORGANIZATION };
    case 'Teams':
      return { teams: page(TEAMS) };
    case 'States':
      return { workflowStates: page(STATES) };
    case 'Users':
      return { users: page(USERS) };
    case 'Labels':
      return { issueLabels: page(LABELS) };
    case 'Projects':
      return { projects: page(PROJECTS) };
    case 'Cycles':
      return { cycles: page(CYCLES.filter((c) => !v.filter?.endsAt?.gt || c.endsAt > v.filter.endsAt.gt)) };
    case 'Issues': {
      const order = v.orderBy === 'createdAt' ? 'createdAt' : 'updatedAt';
      const all = issues.filter((row) => matches(row, v.filter)).sort((a, b) => b[order].localeCompare(a[order]));
      const start = v.after ? Number(v.after) : 0;
      const slice = all.slice(start, start + v.first);
      const more = start + v.first < all.length;
      return { issues: { nodes: slice.map(issueNode), pageInfo: { hasNextPage: more, endCursor: more ? String(start + v.first) : null } } };
    }
    case 'Issue': {
      const row = issues.find((r) => r.identifier === String(v.id).toUpperCase() || r.id === v.id);
      if (!row) return null;
      return {
        issue: {
          ...issueNode(row),
          description: row.description,
          comments: { nodes: row.comments.map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, user: user(c.userId) })) },
          children: { nodes: issues.filter((r) => r.parent === row.identifier).map(issueNode) },
        },
      };
    }
    case 'IssueUpdate': {
      const row = issues.find((r) => r.identifier === String(v.id).toUpperCase() || r.id === v.id);
      if (!row) return null;
      if (v.input.stateId !== undefined) row.stateId = v.input.stateId;
      if (v.input.assigneeId !== undefined) row.assigneeId = v.input.assigneeId;
      if (v.input.priority !== undefined) row.priority = v.input.priority;
      row.updatedAt = new Date(NOW).toISOString();
      return { issueUpdate: { success: true, issue: issueNode(row) } };
    }
    case 'CommentCreate': {
      const row = issues.find((r) => r.identifier === String(v.input.issueId).toUpperCase() || r.id === v.input.issueId);
      if (!row) return null;
      const comment = { id: `cm-${row.comments.length + 100}`, userId: VIEWER, body: v.input.body, createdAt: new Date(NOW).toISOString() };
      row.comments.push(comment);
      return { commentCreate: { success: true, comment: { id: comment.id, body: comment.body, createdAt: comment.createdAt, user: user(VIEWER) } } };
    }
    default:
      throw new UnknownFilter(`fixture does not answer operation ${operationName}`);
  }
}

async function fetch(url, init = {}) {
  if (url !== 'https://api.linear.app/graphql') throw new Error(`unexpected URL ${url}`);
  if (init.headers?.Authorization !== SECRET) {
    return reply(400, graphqlError(
      'Authentication required, not authenticated',
      'authentication error',
      'You need to authenticate to access this operation.',
    ));
  }
  const { operationName, variables } = JSON.parse(init.body);
  let data;
  try {
    data = resolve(operationName, variables || {});
  } catch (err) {
    if (err instanceof UnknownFilter) return reply(400, graphqlError(err.message, 'graphql error'));
    throw err;
  }
  if (data === null) {
    return reply(200, graphqlError('Entity not found: Issue', 'invalid input', 'Could not find referenced Issue.'));
  }
  return reply(200, { data });
}

module.exports = {
  secret: SECRET,
  unknownKey: 'ENG-99999',
  fetch,
  reset,
};
