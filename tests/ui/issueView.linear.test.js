/**
 * The Tickets screen's pure half with Linear's data, run through the real
 * adapter and sanitiser: several teams, each with its own workflow, the
 * priority scale, cycles and projects, branch names. What holds for any
 * tracker is in issueView.test.js, over the fake adapter.
 */

'use strict';

const view = require('../../src/renderer/ui/panels/issues/issueView');
const { t } = require('../../src/renderer/i18n');
const linear = require('../../src/main/issue-trackers/linear.tracker');
const fixture = require('../issue-trackers/fixtures/linear.fixture');
const { sanitizeIssue, sanitizeIssueDetail, sanitizeMetadata, normalizeQuery } = require('../../src/shared/issue-trackers');

let metadata;
let issues;

beforeAll(async () => {
  fixture.reset();
  const client = linear.createClient({ secret: fixture.secret, fetch: fixture.fetch });
  metadata = sanitizeMetadata(await client.metadata()).metadata;
  const page = await client.listIssues(normalizeQuery({ limit: 100 }), null);
  issues = page.issues.map((raw) => sanitizeIssue(raw, 'linear').issue);
});

const keysOf = (group) => group.issues.map((i) => i.key);

describe('status', () => {
  test('the menu merges same-named states across teams, in workflow order', () => {
    const options = view.statusOptions(metadata);
    expect(options.map((o) => o.category)).toEqual(['backlog', 'todo', 'started', 'done', 'canceled']);
    const started = options.find((o) => o.category === 'started').states;
    expect(started.map((s) => s.name)).toEqual(['In Progress', 'In Review']);
    expect(started[0].ids.sort()).toEqual(['s-des-progress', 's-eng-progress', 's-ops-progress']);
  });

  test('a whole category is sent as a category, a single state as all its ids', () => {
    const q = view.buildQuery({ ...view.DEFAULT_VIEW, status: ['cat:todo', 'state:started:In Review'] }, metadata);
    expect(q.stateCategories).toEqual(['todo']);
    expect(q.stateIds).toEqual(['s-eng-review']);
    expect(q.limit).toBe(view.PAGE_SIZE);
  });
});

describe('groupIssues', () => {
  test('by status: categories in order, then states in the menu order', () => {
    const groups = view.groupIssues(issues, 'status', metadata);
    const menuOrder = view.statusOptions(metadata).flatMap((o) => o.states.map((s) => s.name));
    const listOrder = groups.map((g) => g.label);
    expect(listOrder).toEqual(menuOrder.filter((name) => listOrder.includes(name)));
    expect(listOrder.slice(-2)).toEqual(['Done', 'Canceled']);
  });

  test('by assignee: people by name, the unassigned last', () => {
    const groups = view.groupIssues(issues, 'assignee', metadata);
    expect(groups.map((g) => g.label)).toEqual([
      'Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Margaret Hamilton', t('tickets.groupBy.noAssignee'),
    ]);
    expect(keysOf(groups[0])).toContain('ENG-142');
  });

  test('by priority: urgent first, no priority last', () => {
    const groups = view.groupIssues(issues, 'priority', metadata);
    expect(groups.map((g) => g.priority)).toEqual([1, 2, 3, 4, 0]);
  });

  test('by a facet, with issues that lack it in a last group', () => {
    const groups = view.groupIssues(issues, 'facet:project', metadata);
    expect(groups.map((g) => g.label)).toEqual(['Onboarding', 'Session tabs', 'Tickets', t('tickets.groupBy.noValue')]);
  });

  test('the container takes the word of the facet that stands for it', () => {
    expect(view.containerLabel(metadata)).toBe(t('tickets.facets.team'));
    const options = view.groupByOptions(metadata, { priority: true });
    expect(options.map((o) => o.id)).toEqual(['status', 'assignee', 'priority', 'container', 'facet:project', 'facet:cycle', 'none']);
    expect(view.groupByOptions(metadata, { priority: false }).map((o) => o.id)).not.toContain('priority');
  });
});

describe('HTML', () => {
  const issue = () => issues.find((i) => i.key === 'ENG-142');

  test('a row carries the ref and key it opens, and the state colour as a custom property', () => {
    document.body.innerHTML = view.rowHtml(issue());
    const row = document.querySelector('.issue-row');
    expect(row.dataset).toMatchObject({ ref: 'linear:ENG-142', key: 'ENG-142' });
    expect(row.querySelector('.issue-state').getAttribute('style')).toBe('--state-color: #f2c94c');
    expect(row.querySelector('.issue-priority').dataset.priority).toBe('1');
    expect(row.querySelector('.issue-avatar').textContent).toBe('AL');
  });

  test('the detail renders markdown through the given renderer, and only there', async () => {
    const client = linear.createClient({ secret: fixture.secret, fetch: fixture.fetch });
    const { issue: detail } = sanitizeIssueDetail(await client.getIssue('ENG-142'), 'linear');
    const renderMarkdown = jest.fn((md) => `<div class="md">${md.length}</div>`);
    document.body.innerHTML = view.detailHtml(detail, { renderMarkdown, providerName: 'Linear', metadata });
    expect(renderMarkdown).toHaveBeenCalledTimes(3); // description + two comments
    expect(document.querySelector('.issue-detail-title').textContent).toBe('Session tickets tab');
    expect(document.querySelectorAll('.issue-detail-children .issue-row')).toHaveLength(3);
    expect(document.querySelector('[data-action="open"]').textContent).toBe(t('tickets.detail.openIn', { provider: 'Linear' }));
    expect(document.querySelector('[data-action="copy-branch"]').title).toBe(detail.branchName);
  });
});

describe('board', () => {
  test('several teams on screen: the five shared categories', () => {
    const board = view.boardColumns(issues, metadata, view.restoreView(null));
    expect(board.mode).toBe('categories');
    expect(board.columns.map((c) => c.category)).toEqual(['backlog', 'todo', 'started', 'done', 'canceled']);
    expect(board.columns.find((c) => c.category === 'started').issues.map((i) => i.key)).toContain('ENG-142');
  });

  test('one team picked: that team\'s real states, in workflow order', () => {
    const board = view.boardColumns(issues.filter((i) => i.container.id === 't-eng'), metadata, { facets: { team: ['t-eng'] } });
    expect(board.mode).toBe('states');
    expect(board.columns.map((c) => c.label)).toEqual(['Triage', 'Backlog', 'Todo', 'In Progress', 'In Review', 'Done', 'Canceled', 'Duplicate']);
  });

  test('every listed ticket in one team also means that team\'s states', () => {
    const ops = issues.filter((i) => i.container.id === 't-ops');
    expect(view.boardColumns(ops, metadata, view.restoreView(null)).mode).toBe('states');
  });

  test('a drop on a category column picks the first state of the ticket\'s own team', () => {
    const ops12 = issues.find((i) => i.key === 'OPS-12');
    expect(view.dropTargetState(ops12, { key: 'cat:done', category: 'done' }, metadata)).toBe('s-ops-done');
    expect(view.dropTargetState(ops12, { key: 'cat:started', category: 'started' }, metadata)).toBeNull();
  });

  test('a drop on a state column takes that state, or nothing when it is already there', () => {
    const eng142 = issues.find((i) => i.key === 'ENG-142');
    expect(view.dropTargetState(eng142, { key: 'state:s-eng-review', category: 'started', stateId: 's-eng-review' }, metadata)).toBe('s-eng-review');
    expect(view.dropTargetState(eng142, { key: 'state:s-eng-progress', category: 'started', stateId: 's-eng-progress' }, metadata)).toBeNull();
  });

  test('a ticket can only be moved to its own team\'s states', () => {
    const ops12 = issues.find((i) => i.key === 'OPS-12');
    const ids = view.statesForIssue(ops12, metadata).map((st) => st.id);
    expect(ids.every((id) => id.startsWith('s-ops-'))).toBe(true);
    expect(ids[0]).toBe('s-ops-backlog');
  });

  test('the detail offers edit buttons only for what is writable', () => {
    const detail = { ...issues.find((i) => i.key === 'ENG-142'), description: null, comments: [], children: [] };
    document.body.innerHTML = view.detailHtml(detail, { renderMarkdown: () => '', providerName: 'Linear', metadata, editableFields: { state: true, assignee: false, priority: true } });
    expect([...document.querySelectorAll('.issue-prop-edit')].map((b) => b.dataset.edit)).toEqual(['state', 'priority']);
  });
});

describe('sub-issues', () => {
  test('by status, a sub-issue in another status than its parent sits under it, shown for context, in its own group', () => {
    const groups = view.groupIssues(issues, 'status', metadata);
    document.body.innerHTML = view.groupsHtml(groups);
    const todo = [...document.querySelectorAll('.issue-group')].find((g) => g.querySelector('.issue-group-label').textContent === 'Todo');
    const rows = [...todo.querySelectorAll('.issue-row')];
    const context = rows.find((r) => r.dataset.key === 'ENG-142');
    expect(context.classList.contains('context')).toBe(true);
    expect(context.querySelector('.issue-progress').textContent.trim()).toBe('1/3'); // ENG-117 is done, and not listed
    expect(rows[rows.indexOf(context) + 1].dataset).toMatchObject({ key: 'ENG-151', depth: '1', last: '' });
    const started = [...document.querySelectorAll('.issue-group')].find((g) => g.querySelector('.issue-group-label').textContent === 'In Progress');
    expect(started.querySelector('.issue-row:not(.context)[data-key="ENG-142"]')).not.toBeNull();
  });
});
