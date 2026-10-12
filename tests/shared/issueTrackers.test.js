/**
 * The normalised issue model. Adapter output is untrusted text on its way to
 * the DOM: colours land in a `style` attribute, URLs in an `href` and in
 * `openExternal`. These tests are what keeps that boundary honest.
 */

'use strict';

const {
  STATE_CATEGORIES,
  LIMITS,
  formatRef,
  parseRef,
  extractKeyedRefs,
  sanitizePerson,
  sanitizeComment,
  sanitizeIssue,
  sanitizeIssueDetail,
  sanitizeMetadata,
  normalizeQuery,
} = require('../../src/shared/issue-trackers');

const minimal = (over = {}) => ({
  key: 'ENG-142',
  title: 'Session tickets tab',
  state: { id: 's1', name: 'In Progress', category: 'started', color: '#F2C94C' },
  ...over,
});

describe('refs', () => {
  test('formatRef and parseRef round-trip', () => {
    expect(formatRef('linear', 'ENG-142')).toBe('linear:ENG-142');
    expect(parseRef('linear:ENG-142')).toEqual({ provider: 'linear', key: 'ENG-142' });
    expect(parseRef('github:#12')).toEqual({ provider: 'github', key: '#12' });
  });

  test.each([
    [null], [''], ['ENG-142'], [':ENG-142'], ['linear:'], ['Linear:ENG-1'], ['linear:ENG 142'], ['linear: ENG-142'],
  ])('parseRef rejects %p', (ref) => {
    expect(parseRef(ref)).toBeNull();
  });
});

describe('extractKeyedRefs', () => {
  const KEYS = ['ENG', 'OPS'];

  test('finds known keys in order, once each', () => {
    expect(extractKeyedRefs('ENG-142: fix OPS-7, then ENG-142 again and ENG-9', KEYS)).toEqual(['ENG-142', 'OPS-7', 'ENG-9']);
  });

  test('reads lower-case branch names and upper-cases the result', () => {
    expect(extractKeyedRefs('bleleve/eng-142-session-tickets-tab', KEYS)).toEqual(['ENG-142']);
  });

  test('accepts an underscore before the key, which \\b would not', () => {
    expect(extractKeyedRefs('feat_ENG-142', KEYS)).toEqual(['ENG-142']);
  });

  test('finds keys inside URLs and brackets', () => {
    expect(extractKeyedRefs('[ENG-1] see https://linear.app/acme/issue/OPS-2/slug', KEYS)).toEqual(['ENG-1', 'OPS-2']);
  });

  test('ignores prefixes the tracker does not have', () => {
    expect(extractKeyedRefs('UTF-8, ISO-8601, SHA-256, RFC-2119', KEYS)).toEqual([]);
  });

  test('does not read a known key out of a longer prefix or number', () => {
    expect(extractKeyedRefs('XENG-142 ENG-142a 2ENG-5', KEYS)).toEqual([]);
  });

  test('finds nothing without known keys', () => {
    expect(extractKeyedRefs('ENG-142', [])).toEqual([]);
    expect(extractKeyedRefs('ENG-142', undefined)).toEqual([]);
    expect(extractKeyedRefs(null, KEYS)).toEqual([]);
  });

  test('stops scanning after the size cap', () => {
    const text = `${'x'.repeat(LIMITS.scanChars)} ENG-1`;
    expect(extractKeyedRefs(text, KEYS)).toEqual([]);
  });
});

describe('sanitizeIssue', () => {
  test('fills every optional field with an explicit empty value', () => {
    const { issue, problems } = sanitizeIssue(minimal(), 'linear');
    expect(problems).toEqual([]);
    expect(issue).toEqual({
      ref: 'linear:ENG-142',
      provider: 'linear',
      key: 'ENG-142',
      id: null,
      title: 'Session tickets tab',
      url: null,
      state: { id: 's1', name: 'In Progress', color: '#f2c94c', category: 'started' },
      priority: null,
      assignee: null,
      labels: [],
      container: null,
      facets: {},
      estimate: null,
      dueDate: null,
      branchName: null,
      createdAt: null,
      updatedAt: null,
    });
  });

  test('keeps a complete issue', () => {
    const { issue, problems } = sanitizeIssue(minimal({
      id: 'uuid-1',
      url: 'https://linear.app/acme/issue/ENG-142',
      priority: 1,
      assignee: { id: 'u1', name: 'Ada', avatarUrl: 'https://cdn.test/a.png' },
      labels: [{ id: 'l1', name: 'feature', color: '#5E6AD2' }],
      container: { id: 't1', name: 'Engineering' },
      facets: { cycle: 'Cycle 42', project: 'Tickets' },
      estimate: 3,
      dueDate: '2026-10-20',
      branchName: 'bleleve/eng-142-session-tickets-tab',
      createdAt: '2026-10-01T09:00:00Z',
      updatedAt: '2026-10-09T09:00:00.000Z',
    }), 'linear');
    expect(problems).toEqual([]);
    expect(issue).toMatchObject({
      priority: 1,
      assignee: { id: 'u1', name: 'Ada', avatarUrl: 'https://cdn.test/a.png' },
      labels: [{ id: 'l1', name: 'feature', color: '#5e6ad2' }],
      container: { id: 't1', name: 'Engineering' },
      facets: { cycle: 'Cycle 42', project: 'Tickets' },
      estimate: 3,
      dueDate: '2026-10-20',
      createdAt: '2026-10-01T09:00:00.000Z',
    });
  });

  test.each([
    ['no key', { key: undefined }, /^key/],
    ['a key with a space', { key: 'ENG 142' }, /^key/],
    ['an empty title', { title: '   ' }, /^title/],
    ['no state name', { state: { category: 'todo' } }, /^state\.name/],
    ['an unknown category', { state: { name: 'Doing', category: 'doing' } }, /^state\.category/],
  ])('drops an issue with %s', (_label, over, expected) => {
    const { issue, problems } = sanitizeIssue(minimal(over), 'linear');
    expect(issue).toBeNull();
    expect(problems.join('\n')).toMatch(expected);
  });

  test('refuses an invalid provider id', () => {
    expect(sanitizeIssue(minimal(), 'Linear').issue).toBeNull();
  });

  test.each([
    ['javascript:alert(1)'],
    ['http://linear.app/acme/issue/ENG-142'],
    ['file:///etc/passwd'],
    ['not a url'],
  ])('drops the URL %p and says so', (url) => {
    const { issue, problems } = sanitizeIssue(minimal({ url }), 'linear');
    expect(issue.url).toBeNull();
    expect(problems).toContain('url: not an https URL');
  });

  test('drops a colour that could escape a style attribute', () => {
    const { issue, problems } = sanitizeIssue(minimal({
      state: { name: 'Todo', category: 'todo', color: 'red;background:url(https://x.test)' },
    }), 'linear');
    expect(issue.state.color).toBeNull();
    expect(problems.join()).toMatch(/state\.color/);
  });

  test('drops an avatar that is not https', () => {
    const { issue } = sanitizeIssue(minimal({ assignee: { id: 'u1', name: 'Ada', avatarUrl: 'javascript:x' } }), 'linear');
    expect(issue.assignee.avatarUrl).toBeNull();
  });

  test('keeps priority 0 and refuses out-of-scale values', () => {
    expect(sanitizeIssue(minimal({ priority: 0 }), 'linear').issue.priority).toBe(0);
    const res = sanitizeIssue(minimal({ priority: 5 }), 'linear');
    expect(res.issue.priority).toBeNull();
    expect(res.problems.join()).toMatch(/priority/);
  });

  test('flattens newlines in the title and caps its length', () => {
    const { issue } = sanitizeIssue(minimal({ title: `Line one\nline two${'x'.repeat(LIMITS.title)}` }), 'linear');
    expect(issue.title.startsWith('Line one line two')).toBe(true);
    expect(issue.title).toHaveLength(LIMITS.title);
  });

  test('caps labels and skips nameless ones', () => {
    const labels = [{ id: 'x' }, ...Array.from({ length: 30 }, (_, i) => ({ id: `l${i}`, name: `l${i}` }))];
    const { issue, problems } = sanitizeIssue(minimal({ labels }), 'linear');
    expect(issue.labels).toHaveLength(LIMITS.labelsPerIssue - 1);
    expect(problems.join()).toMatch(/labels/);
  });

  test('keeps only short string facets with valid ids', () => {
    const { issue, problems } = sanitizeIssue(minimal({ facets: { cycle: 'Cycle 1', 'bad id': 'x', sprint: { n: 1 } } }), 'linear');
    expect(issue.facets).toEqual({ cycle: 'Cycle 1' });
    expect(problems).toHaveLength(2);
  });

  test('a branch name with whitespace is dropped', () => {
    const { issue } = sanitizeIssue(minimal({ branchName: 'eng-142 rm -rf' }), 'linear');
    expect(issue.branchName).toBeNull();
  });

  test('bad dates are dropped, not passed through', () => {
    const { issue, problems } = sanitizeIssue(minimal({ dueDate: '20/10/2026', updatedAt: 'yesterday' }), 'linear');
    expect(issue.dueDate).toBeNull();
    expect(issue.updatedAt).toBeNull();
    expect(problems).toHaveLength(2);
  });
});

describe('sanitizeIssueDetail and sanitizeComment', () => {
  test('adds description, comments and children', () => {
    const { issue, problems } = sanitizeIssueDetail(minimal({
      description: '## Why\nBecause.',
      comments: [{ id: 'c1', body: 'Done in #57', author: { id: 'u1', name: 'Ada' }, createdAt: '2026-10-09T10:00:00Z' }],
      children: [minimal({ key: 'ENG-143', title: 'Child' })],
    }), 'linear');
    expect(problems).toEqual([]);
    expect(issue.description).toBe('## Why\nBecause.');
    expect(issue.comments).toEqual([
      { id: 'c1', author: { id: 'u1', name: 'Ada', avatarUrl: null }, body: 'Done in #57', createdAt: '2026-10-09T10:00:00.000Z' },
    ]);
    expect(issue.children.map((c) => c.ref)).toEqual(['linear:ENG-143']);
  });

  test('defaults to an empty detail', () => {
    const { issue } = sanitizeIssueDetail(minimal(), 'linear');
    expect(issue).toMatchObject({ description: null, comments: [], children: [] });
  });

  test('reports broken children without dropping the parent', () => {
    const { issue, problems } = sanitizeIssueDetail(minimal({ children: [{ title: 'no key' }] }), 'linear');
    expect(issue.children).toEqual([]);
    expect(problems.join()).toMatch(/^children: key/);
  });

  test('a comment without a body is dropped', () => {
    expect(sanitizeComment({ id: 'c1', body: '  ' }).comment).toBeNull();
  });

  test('a comment keeps its markdown verbatim', () => {
    const body = 'line one\n\n- a\n- b';
    expect(sanitizeComment({ body }).comment.body).toBe(body);
  });
});

describe('sanitizePerson', () => {
  test('needs an id and a name', () => {
    expect(sanitizePerson({ id: 'u1' })).toBeNull();
    expect(sanitizePerson({ name: 'Ada' })).toBeNull();
    expect(sanitizePerson({ id: 42, name: 'Ada' })).toEqual({ id: '42', name: 'Ada', avatarUrl: null });
  });
});

describe('sanitizeMetadata', () => {
  test('cleans each list', () => {
    const { metadata, problems } = sanitizeMetadata({
      keys: ['eng', 'ENG', 'OPS'],
      people: [{ id: 'u1', name: 'Ada' }],
      states: [{ id: 's1', name: 'Todo', category: 'todo', color: '#E2E2E2', position: 2, containerId: 't1' }],
      labels: [{ id: 'l1', name: 'bug', color: '#ef4444' }],
      facets: [{ id: 'cycle', label: 'Cycle', options: [{ value: 'c1', label: 'Cycle 42' }] }],
    });
    expect(problems).toEqual([]);
    expect(metadata).toEqual({
      keys: ['ENG', 'OPS'],
      people: [{ id: 'u1', name: 'Ada', avatarUrl: null }],
      states: [{ id: 's1', name: 'Todo', category: 'todo', color: '#e2e2e2', position: 2, containerId: 't1' }],
      labels: [{ id: 'l1', name: 'bug', color: '#ef4444' }],
      facets: [{ id: 'cycle', label: 'Cycle', multi: true, options: [{ value: 'c1', label: 'Cycle 42', color: null }] }],
    });
  });

  test('rejects key prefixes the reference pattern could never match', () => {
    const { metadata, problems } = sanitizeMetadata({ keys: ['ENG', 'MY_PROJ', '1AB', 'TOOLONGPREFIX'] });
    expect(metadata.keys).toEqual(['ENG']);
    expect(problems).toHaveLength(3);
  });

  test('every state carries one of the shared categories', () => {
    const { metadata, problems } = sanitizeMetadata({
      states: [{ id: 's1', name: 'Todo', category: 'todo' }, { id: 's2', name: 'Doing', category: 'doing' }],
    });
    expect(metadata.states.map((s) => s.id)).toEqual(['s1']);
    expect(STATE_CATEGORIES).toContain(metadata.states[0].category);
    expect(problems).toHaveLength(1);
  });

  test('a missing list is empty, a non-list is a problem', () => {
    const { metadata, problems } = sanitizeMetadata({ people: 'everyone' });
    expect(metadata.people).toEqual([]);
    expect(problems).toEqual(['people: not an array']);
  });
});

describe('normalizeQuery', () => {
  test('fills the defaults', () => {
    expect(normalizeQuery(undefined)).toEqual({
      text: '',
      mine: null,
      stateCategories: [],
      stateIds: [],
      assigneeIds: [],
      priorities: [],
      labelIds: [],
      facets: {},
      updatedSince: null,
      sort: 'updated',
      limit: LIMITS.defaultPageSize,
    });
  });

  test('drops values it does not know instead of failing', () => {
    const q = normalizeQuery({
      mine: 'everyone',
      stateCategories: ['done', 'doing', 'todo'],
      priorities: [1, 9, '2'],
      sort: 'random',
      facets: { cycle: ['c1', 'c1', 'c2'], 'bad id': ['x'], empty: [] },
      updatedSince: 'last week',
    });
    expect(q).toMatchObject({
      mine: null,
      stateCategories: ['todo', 'done'],
      priorities: [1],
      sort: 'updated',
      facets: { cycle: ['c1', 'c2'] },
      updatedSince: null,
    });
  });

  test('keeps the special assignee values', () => {
    expect(normalizeQuery({ assigneeIds: ['me', 'none', 'u1', 'me'] }).assigneeIds).toEqual(['me', 'none', 'u1']);
  });

  test('clamps the page size', () => {
    expect(normalizeQuery({ limit: 0 }).limit).toBe(1);
    expect(normalizeQuery({ limit: 1000 }).limit).toBe(LIMITS.maxPageSize);
    expect(normalizeQuery({ limit: 2.5 }).limit).toBe(LIMITS.defaultPageSize);
  });

  test('caps the search text and the filter lists', () => {
    const q = normalizeQuery({ text: 'x'.repeat(500), labelIds: Array.from({ length: 80 }, (_, i) => `l${i}`) });
    expect(q.text).toHaveLength(LIMITS.queryText);
    expect(q.labelIds).toHaveLength(LIMITS.listFilter);
  });
});
