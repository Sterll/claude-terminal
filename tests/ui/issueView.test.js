/**
 * The Tickets screen's pure half: what the filter bar sends, how a list is
 * grouped, and the HTML it draws. The data is the fake tracker's, run through
 * the real sanitiser, so these are the shapes the screen actually receives
 * from a GitHub Issues-like tracker: two states shared by the whole workspace,
 * no priorities, repositories as containers.
 */

'use strict';

const view = require('../../src/renderer/ui/panels/issues/issueView');
const { t, getCurrentLanguage } = require('../../src/renderer/i18n');
const fake = require('../issue-trackers/fake.tracker');
const fixture = require('../issue-trackers/fixtures/fake.fixture');
const { sanitizeIssue, sanitizeIssueDetail, sanitizeMetadata, normalizeQuery } = require('../../src/shared/issue-trackers');

let client;
let metadata;
let issues;

beforeAll(async () => {
  client = fake.createClient({ secret: fixture.secret, fetch: fixture.fetch });
  metadata = sanitizeMetadata(await client.metadata()).metadata;
  const page = await client.listIssues(normalizeQuery({ limit: 100 }), null);
  issues = page.issues.map((raw) => sanitizeIssue(raw, 'fake').issue);
});

const keysOf = (group) => group.issues.map((i) => i.key);
const byKey = (key) => issues.find((i) => i.key === key);

describe('restoreView', () => {
  test('a first visit shows every open ticket, grouped by status', () => {
    expect(view.restoreView(undefined)).toEqual({ ...view.DEFAULT_VIEW, status: [...view.DEFAULT_VIEW.status] });
  });

  test('a saved view keeps what is valid and drops the rest', () => {
    const v = view.restoreView({ mine: 'everyone', status: ['cat:done'], priorities: [1, 9], sort: 'random', text: 'kept?', facets: [] });
    expect(v).toMatchObject({ mine: null, status: ['cat:done'], priorities: [1], sort: 'updated', text: '', facets: {} });
  });
});

describe('status', () => {
  test('the menu lists only the categories the tracker uses, each with its states', () => {
    const options = view.statusOptions(metadata);
    expect(options.map((o) => o.category)).toEqual(['todo', 'done']);
    expect(options.map((o) => o.states.map((s) => [s.name, s.ids]))).toEqual([[['Open', ['open']]], [['Closed', ['closed']]]]);
  });

  test('a whole category is sent as a category, a single state as its id', () => {
    const q = view.buildQuery({ ...view.DEFAULT_VIEW, status: ['cat:todo', 'state:done:Closed'] }, metadata);
    expect(q.stateCategories).toEqual(['todo']);
    expect(q.stateIds).toEqual(['closed']);
    expect(q.limit).toBe(view.PAGE_SIZE);
  });

  test('the default view is recognised, and any narrowing is not', () => {
    expect(view.isDefaultView(view.restoreView(null))).toBe(true);
    expect(view.isDefaultView({ ...view.restoreView(null), groupBy: 'assignee', sort: 'created' })).toBe(true);
    expect(view.isDefaultView({ ...view.restoreView(null), mine: 'assigned' })).toBe(false);
    expect(view.isDefaultView({ ...view.restoreView(null), status: ['cat:todo'] })).toBe(false);
    expect(view.isDefaultView({ ...view.restoreView(null), facets: { repository: ['app'] } })).toBe(false);
  });
});

describe('groupIssues', () => {
  test('by status: categories in order, the server order kept inside each', () => {
    const groups = view.groupIssues(issues, 'status', metadata);
    expect(groups.map((g) => g.label)).toEqual(['Open', 'Closed']);
    expect(groups.map(keysOf)).toEqual([['#4', '#2', '#1'], ['#3']]);
  });

  test('by assignee: people by name, the unassigned last', () => {
    const groups = view.groupIssues(issues, 'assignee', metadata);
    expect(groups.map((g) => g.label)).toEqual(['Ada Lovelace', t('tickets.groupBy.noAssignee')]);
    expect(keysOf(groups[0])).toEqual(['#1']);
  });

  test('by container, named after the repository', () => {
    const groups = view.groupIssues(issues, 'container', metadata);
    expect(groups.map((g) => g.label)).toEqual(['acme/app', 'acme/site']);
  });

  test('by a facet, with issues that lack it in a last group', () => {
    const loose = { ...byKey('#2'), ref: 'fake:#9', key: '#9', facets: {} };
    const groups = view.groupIssues([...issues, loose], 'facet:repository', metadata);
    expect(groups.map((g) => g.label)).toEqual(['acme/app', 'acme/site', t('tickets.groupBy.noValue')]);
  });

  test('without grouping, one headerless group keeps the server order', () => {
    const [group] = view.groupIssues(issues, 'none', metadata);
    expect(group.label).toBe('');
    expect(keysOf(group)).toEqual(issues.map((i) => i.key));
  });

  test('the container takes the word of the facet that stands for it, and no priority grouping without priorities', () => {
    expect(view.containerLabel(metadata)).toBe(t('tickets.facets.repository'));
    expect(view.groupByOptions(metadata, fake.capabilities).map((o) => o.id)).toEqual(['status', 'assignee', 'container', 'none']);
    expect(view.groupByOptions(metadata, { priority: true }).map((o) => o.id)).toEqual(['status', 'assignee', 'priority', 'container', 'none']);
  });
});

describe('HTML', () => {
  test('a row carries the ref and key it opens, and the state colour as a custom property', () => {
    document.body.innerHTML = view.rowHtml(byKey('#1'));
    const row = document.querySelector('.issue-row');
    expect(row.dataset).toMatchObject({ ref: 'fake:#1', key: '#1' });
    expect(row.querySelector('.issue-state').getAttribute('style')).toBe('--state-color: #22c55e');
    expect(row.querySelector('.issue-priority').dataset.priority).toBeUndefined(); // no priority, no glyph
    expect(row.querySelector('img.issue-avatar').getAttribute('src')).toBe('https://example.com/ada.png');
    expect(row.querySelector('.issue-label').textContent).toBe('bug');
  });

  test('network text is escaped everywhere it lands', () => {
    const hostile = {
      ...byKey('#1'),
      title: '<img src=x onerror="window.pwned=1">',
      labels: [{ id: 'l', name: '<b>x</b>', color: null }],
      assignee: { id: 'u', name: '<i>Eve</i>', avatarUrl: null },
    };
    document.body.innerHTML = view.groupsHtml([{ key: 'k', label: '<script>x</script>', issues: [hostile] }]);
    expect(document.querySelector('img, b, i, script')).toBeNull();
    expect(document.querySelector('.issue-title').textContent).toBe(hostile.title);
  });

  test('a collapsed group keeps its header and drops its rows', () => {
    const groups = view.groupIssues(issues, 'status', metadata);
    document.body.innerHTML = view.groupsHtml(groups, { collapsed: new Set([groups[0].key]) });
    const first = document.querySelector('.issue-group');
    expect(first.querySelector('.issue-group-header').getAttribute('aria-expanded')).toBe('false');
    expect(first.querySelectorAll('.issue-row')).toHaveLength(0);
  });

  test('the detail renders markdown through the given renderer, and only there', async () => {
    const { issue: parent } = sanitizeIssueDetail(await client.getIssue('#1'), 'fake');
    const renderMarkdown = jest.fn((md) => `<div class="md">${md.length}</div>`);
    document.body.innerHTML = view.detailHtml(parent, { renderMarkdown, providerName: 'Fake Tracker', metadata });
    expect(renderMarkdown).toHaveBeenCalledTimes(1); // the description
    expect(document.querySelector('.issue-detail-title').textContent).toBe('Crash when the tab closes');
    expect(document.querySelectorAll('.issue-detail-children .issue-row')).toHaveLength(1);
    expect(document.querySelector('[data-action="open"]').textContent).toBe(t('tickets.detail.openIn', { provider: 'Fake Tracker' }));
    expect(document.querySelector('[data-action="copy-branch"]')).toBeNull(); // the tracker names no branch
    const props = [...document.querySelectorAll('.issue-prop-label')].map((el) => el.textContent);
    expect(props.filter((label) => label === t('tickets.facets.repository'))).toHaveLength(1); // container and facet at once

    const { issue: commented } = sanitizeIssueDetail(await client.getIssue('#3'), 'fake');
    renderMarkdown.mockClear();
    document.body.innerHTML = view.detailHtml(commented, { renderMarkdown, providerName: 'Fake Tracker', metadata });
    expect(renderMarkdown).toHaveBeenCalledTimes(2); // description + one comment
    expect(document.querySelector('.issue-comment-author').textContent).toBe('Alan Turing');
  });

  test('a detail without description says so instead of rendering nothing', () => {
    const renderMarkdown = jest.fn();
    document.body.innerHTML = view.detailHtml({ ...byKey('#1'), description: null, comments: [], children: [] }, { renderMarkdown, providerName: 'Fake Tracker', metadata });
    expect(renderMarkdown).not.toHaveBeenCalled();
    expect(document.querySelector('.issue-detail-empty').textContent).toBe(t('tickets.detail.noDescription'));
  });
});

test('relativeTime speaks the app language and says "now" under a minute', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const rtf = new Intl.RelativeTimeFormat(getCurrentLanguage(), { numeric: 'auto', style: 'short' });
  expect(view.relativeTime('2026-10-09T11:59:30Z', now)).toBe(rtf.format(0, 'second'));
  expect(view.relativeTime('2026-10-09T09:00:00Z', now)).toBe(rtf.format(-3, 'hour'));
  expect(view.relativeTime('not a date', now)).toBe('');
});

describe('board', () => {
  test('states shared by the whole workspace: the categories, however many repositories are listed', () => {
    const board = view.boardColumns(issues, metadata, view.restoreView(null));
    expect(board.mode).toBe('categories');
    expect(board.columns.map((c) => c.key)).toEqual(['cat:todo', 'cat:done']); // no column a ticket could never reach
    expect(board.columns.find((c) => c.category === 'todo').issues.map((i) => i.key)).toEqual(['#4', '#2', '#1']);
    const one = view.boardColumns(issues.filter((i) => i.container.id === 'app'), metadata, { facets: { repository: ['app'] } });
    expect(one.mode).toBe('categories');
  });

  test('a drop on a category column takes the workspace\'s state for it', () => {
    expect(view.dropTargetState(byKey('#1'), { key: 'cat:done', category: 'done' }, metadata)).toBe('closed');
    expect(view.dropTargetState(byKey('#1'), { key: 'cat:todo', category: 'todo' }, metadata)).toBeNull(); // already there
    expect(view.dropTargetState(byKey('#1'), { key: 'cat:started', category: 'started' }, metadata)).toBeNull(); // no such state
  });

  test('a ticket can be moved to any of the workspace\'s states', () => {
    expect(view.statesForIssue(byKey('#1'), metadata).map((st) => st.id)).toEqual(['open', 'closed']);
  });

  test('cards are draggable only when the tracker lets the state change', () => {
    const todo = issues.filter((i) => i.state.category === 'todo');
    const board = view.boardColumns(todo, metadata, view.restoreView(null));
    document.body.innerHTML = view.boardHtml(board, { draggable: false });
    expect(document.querySelector('.issue-card[draggable]')).toBeNull();
    expect(document.querySelector('.issues-board-empty').textContent).toBe(t('tickets.board.empty'));
    document.body.innerHTML = view.boardHtml(board, { draggable: true });
    expect(document.querySelectorAll('.issue-card[draggable="true"]').length).toBe(todo.length);
    expect(document.querySelector('.issues-board-empty').textContent).toBe(t('tickets.board.dropHere'));
  });

  test('the detail offers edit buttons only for what is writable, and no priority row without priorities', () => {
    const detail = { ...byKey('#1'), description: null, comments: [], children: [] };
    document.body.innerHTML = view.detailHtml(detail, { renderMarkdown: () => '', providerName: 'Fake Tracker', metadata, editableFields: { state: true, assignee: false, priority: true } });
    expect([...document.querySelectorAll('.issue-prop-edit')].map((b) => b.dataset.edit)).toEqual(['state']);
  });
});

describe('sub-issues', () => {
  const shape = (nodes) => nodes.map((n) => (n.children.length
    ? { key: n.issue.key, context: n.context, children: shape(n.children) }
    : { key: n.issue.key, context: n.context }));

  test('a sub-issue goes under its parent when both are listed, wherever the parent is', () => {
    expect(shape(view.nestIssues([byKey('#4'), byKey('#2'), byKey('#1')]))).toEqual([
      { key: '#2', context: false },
      { key: '#1', context: false, children: [{ key: '#4', context: false }] },
    ]);
  });

  test('a parent that is not listed is shown once, for context, where its first sub-issue was', () => {
    const tree = view.nestIssues([byKey('#2'), byKey('#4')]);
    expect(shape(tree)).toEqual([
      { key: '#2', context: false },
      { key: '#1', context: true, children: [{ key: '#4', context: false }] },
    ]);
    expect(tree[1].issue).toMatchObject({ ref: 'fake:#1', title: 'Crash when the tab closes', subIssues: { total: 1, done: 0 }, state: { name: 'Open' } });
  });

  test('only the last sub-issue of a parent closes its branch', () => {
    const second = { ...byKey('#2'), parent: byKey('#4').parent };
    const flat = view.flattenTree(view.nestIssues([byKey('#1'), byKey('#4'), second]));
    expect(flat.map(({ node, depth, last }) => [node.issue.key, depth, last])).toEqual([['#1', 0, true], ['#4', 1, false], ['#2', 1, true]]);
    expect(view.depthAttrs(1, true)).toBe(' data-depth="1" data-last style="--depth: 1"');
    expect(view.depthAttrs(0, true)).toBe('');
  });

  test('a loop sent by an adapter keeps every issue on screen', () => {
    const a = { ...byKey('#1'), parent: { ref: 'fake:#2', key: '#2', title: 'x' } };
    const b = { ...byKey('#2'), parent: { ref: 'fake:#1', key: '#1', title: 'y' } };
    expect(view.flattenTree(view.nestIssues([a, b])).map(({ node }) => node.issue.key).sort()).toEqual(['#1', '#2']);
  });

  test('items that are not issues nest through the accessor, and an unloaded one stays a leaf', () => {
    const links = [{ ref: 'fake:#4' }, { ref: 'fake:#9' }];
    const tree = view.nestIssues(links, (l) => (l.ref === 'fake:#4' ? byKey('#4') : null));
    expect(tree.map((n) => [n.context, n.issue?.key ?? null])).toEqual([[true, '#1'], [false, null]]);
    expect(tree[0].children[0].item).toBe(links[0]);
  });

  test('grouped apart from its parent, a sub-issue sits under it, shown for context, in its own group', () => {
    const groups = view.groupIssues(issues, 'assignee', metadata);
    document.body.innerHTML = view.groupsHtml(groups);
    const [ada, unassigned] = document.querySelectorAll('.issue-group');
    const context = unassigned.querySelector('.issue-row.context');
    expect(context.dataset.key).toBe('#1');
    expect(context.title).toBe(t('tickets.subIssues.contextParent'));
    expect(context.nextElementSibling.dataset).toMatchObject({ key: '#4', depth: '1', last: '' });
    expect(ada.querySelector('.issue-row:not(.context)[data-key="#1"] .issue-progress').textContent.trim()).toBe('0/1');
    expect(unassigned.querySelector('.issue-group-count').textContent).toBe(String(groups[1].issues.length)); // context rows not counted
  });

  test('progress on rows and cards; a sub-issue\'s card names its parent', () => {
    document.body.innerHTML = view.rowHtml(byKey('#1'));
    const progress = document.querySelector('.issue-progress');
    expect(progress.textContent.trim()).toBe('0/1');
    expect(progress.title).toBe(t('tickets.subIssues.progress', { done: 0, total: 1 }));
    document.body.innerHTML = view.cardHtml(byKey('#4'));
    expect(document.querySelector('.issue-card-parent').textContent).toContain('#1');
    expect(view.progressHtml(null)).toBe('');
  });

  test('the detail of a sub-issue leads to its parent', async () => {
    const { issue: detail } = sanitizeIssueDetail(await client.getIssue('#4'), 'fake');
    document.body.innerHTML = view.detailHtml(detail, { renderMarkdown: (md) => md, providerName: 'Fake Tracker', metadata });
    const parent = document.querySelector('.issue-detail-parent .issue-row');
    expect(parent.dataset.key).toBe('#1');
    expect(parent.hasAttribute('title')).toBe(false);
    expect(parent.querySelector('.issue-progress').textContent.trim()).toBe('0/1');
  });
});
