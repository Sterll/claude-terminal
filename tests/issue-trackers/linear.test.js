/**
 * The Linear adapter, beyond the shared contract: how a provider-neutral query
 * becomes an IssueFilter, how Linear's failures become error codes, and which
 * MCP tool calls name a ticket.
 *
 * Filter tests run end to end against the fixture, which evaluates the
 * IssueFilter the adapter sends: they check which issues come back, not what
 * the filter object looks like. Every request shape was also validated against
 * Linear's published schema when the adapter was written.
 */

'use strict';

const linear = require('../../src/main/issue-trackers/linear.tracker');
const fixture = require('./fixtures/linear.fixture');
const { normalizeQuery } = require('../../src/shared/issue-trackers');

const NOW_ISO = '2026-10-09T09:00:00.000Z';
const client = () => linear.createClient({ secret: fixture.secret, fetch: fixture.fetch });
const keysOf = async (raw) => (await client().listIssues(normalizeQuery({ limit: 100, ...raw }), null)).issues.map((i) => i.key).sort();

beforeEach(() => fixture.reset());

describe('queries reach Linear with the right meaning', () => {
  test('an identifier finds that issue, whatever its case', async () => {
    expect(await keysOf({ text: 'eng-142' })).toEqual(['ENG-142']);
  });

  test('text shaped like a key is still searched as text', async () => {
    expect(await keysOf({ text: 'utf-8' })).toEqual(['ENG-139']);
    expect(await keysOf({ text: 'UTF-8' })).toEqual(['ENG-139']);
  });

  test('free text searches titles and descriptions', async () => {
    expect(await keysOf({ text: 'pruner' })).toEqual(['ENG-139']);
    expect(await keysOf({ text: 'live status' })).toEqual(['ENG-142']);
  });

  test('"mine" shortcuts', async () => {
    expect(await keysOf({ mine: 'assigned' })).toEqual(['ENG-137', 'ENG-139', 'ENG-142', 'ENG-151']);
    expect(await keysOf({ mine: 'created' })).toEqual(['ENG-137', 'ENG-139', 'ENG-142', 'ENG-148', 'ENG-151', 'ENG-155']);
    expect(await keysOf({ mine: 'subscribed' })).toEqual(['ENG-137', 'ENG-139', 'ENG-142', 'ENG-148', 'ENG-151', 'ENG-155']);
  });

  test('a category covers every Linear state type it stands for', async () => {
    expect(await keysOf({ stateCategories: ['backlog'] })).toEqual(['DES-28', 'ENG-121', 'ENG-133', 'ENG-155', 'ENG-160']);
    expect(await keysOf({ stateCategories: ['started'] })).toEqual(['ENG-137', 'ENG-139', 'ENG-142', 'OPS-12']);
    expect(await keysOf({ stateCategories: ['done', 'canceled'] })).toEqual(['ENG-110', 'ENG-117', 'OPS-9']);
  });

  test('assignee values combine with OR: me, nobody, a person', async () => {
    expect(await keysOf({ assigneeIds: ['none'] })).toEqual(['DES-28', 'ENG-110', 'ENG-121', 'ENG-155', 'ENG-160']);
    expect(await keysOf({ assigneeIds: ['me', 'u-margaret'] })).toEqual(['ENG-137', 'ENG-139', 'ENG-142', 'ENG-151', 'OPS-12', 'OPS-9']);
  });

  test('priority, labels and the three facets', async () => {
    expect(await keysOf({ priorities: [1] })).toEqual(['ENG-117', 'ENG-142']);
    expect(await keysOf({ labelIds: ['l-perf', 'l-docs'] })).toEqual(['ENG-137', 'OPS-9']);
    expect(await keysOf({ facets: { team: ['t-ops'] } })).toEqual(['OPS-12', 'OPS-9']);
    // A bare number is how people say a key out loud: it matches the number in any team.
    expect(await keysOf({ text: '139' })).toContain('ENG-139');
    expect(await keysOf({ facets: { project: ['p-sessions'] } })).toEqual(['ENG-121', 'ENG-128']);
    expect(await keysOf({ facets: { cycle: ['c-eng-42'] } })).toEqual(['ENG-137', 'ENG-139', 'ENG-142']);
  });

  test('clauses combine with AND', async () => {
    expect(await keysOf({ stateCategories: ['todo'], facets: { project: ['p-tickets'] }, assigneeIds: ['u-grace'] }))
      .toEqual(['DES-31', 'ENG-148']);
  });

  test('updatedSince only returns what changed after it', async () => {
    expect(await keysOf({ updatedSince: '2026-10-08T22:00:00.000Z' })).toEqual(['ENG-137', 'ENG-139', 'ENG-142']);
  });

  test('pages follow the cursor without overlap', async () => {
    const c = client();
    const first = await c.listIssues(normalizeQuery({ limit: 6 }), null);
    expect(first.issues).toHaveLength(6);
    expect(typeof first.next).toBe('string');
    const second = await c.listIssues(normalizeQuery({ limit: 6 }), first.next);
    const seen = new Set(first.issues.map((i) => i.key));
    expect(second.issues.some((i) => seen.has(i.key))).toBe(false);
  });

});

describe('priority and due sorts hold across pages', () => {
  /** Every page of a query, `limit` at a time, with the requests they took. */
  async function walk(raw, limit) {
    const sent = [];
    const spy = (url, init) => { sent.push(JSON.parse(init.body)); return fixture.fetch(url, init); };
    const c = linear.createClient({ secret: fixture.secret, fetch: spy });
    const pages = [];
    let cursor = null;
    do {
      const page = await c.listIssues(normalizeQuery({ ...raw, limit }), cursor);
      pages.push(page.issues);
      cursor = page.next;
    } while (cursor && pages.length < 50);
    return { pages, keys: pages.flat().map((i) => i.key), sent };
  }

  const newestFirst = async (raw = {}) => (await client().listIssues(normalizeQuery({ limit: 100, ...raw }), null)).issues;
  const rank = (p) => (p ? p : 5);

  test('priority: urgent first, "no priority" last, each priority newest first, whatever the page size', async () => {
    const all = await newestFirst();
    const expected = all.slice().sort((a, b) => rank(a.priority) - rank(b.priority)).map((i) => i.key);
    expect(expected[0]).toBe('ENG-142');
    for (const limit of [1, 3, 4, 100]) {
      const { keys, pages } = await walk({ sort: 'priority' }, limit);
      expect(keys).toEqual(expected);
      // Only the last page may be short: a page that empties one priority goes on with the next.
      expect(pages.slice(0, -1).every((p) => p.length === limit)).toBe(true);
    }
  });

  test('priority: a priority filter only asks for the priorities it keeps', async () => {
    const { keys, sent } = await walk({ sort: 'priority', priorities: [3, 1] }, 100);
    expect(keys).toEqual(['ENG-142', 'ENG-117', 'ENG-148', 'ENG-128', 'ENG-121', 'OPS-9', 'DES-31']);
    expect(sent.filter((r) => r.operationName === 'Issues').map((r) => r.variables.filter.and.at(-1))).toEqual([
      { priority: { eq: 1 } },
      { priority: { eq: 3 } },
    ]);
  });

  test('due: dated issues earliest first, then the rest newest first, whatever the page size', async () => {
    const undated = (await newestFirst()).filter((i) => !i.dueDate).map((i) => i.key);
    const expected = ['DES-28', 'OPS-12', 'DES-31', ...undated];
    for (const limit of [1, 2, 3, 4, 100]) {
      const { keys, pages } = await walk({ sort: 'due' }, limit);
      expect(keys).toEqual(expected);
      expect(pages.slice(0, -1).every((p) => p.length === limit)).toBe(true);
    }
  });

  test('due: filters apply to the dated and the undated issues alike', async () => {
    const { keys } = await walk({ sort: 'due', facets: { team: ['t-des'] } }, 1);
    expect(keys).toEqual(['DES-28', 'DES-31']);
  });

  test('due: too many dated issues to rank is refused, not ranked from a sample', async () => {
    const fetch = (url, init) => {
      const { operationName, variables } = JSON.parse(init.body);
      if (operationName !== 'DueDates') return fixture.fetch(url, init);
      const n = variables.after ? Number(variables.after) : 0;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          data: { issues: { nodes: [{ id: `i-${n}`, dueDate: '2026-10-10', updatedAt: NOW_ISO }], pageInfo: { hasNextPage: true, endCursor: String(n + 1) } } },
        }),
      });
    };
    const c = linear.createClient({ secret: fixture.secret, fetch });
    await expect(c.listIssues(normalizeQuery({ sort: 'due' }), null)).rejects.toMatchObject({ code: 'PROVIDER' });
  });

  test('a cursor from another sort is refused rather than read as the first page', async () => {
    const c = client();
    const first = await c.listIssues(normalizeQuery({ sort: 'priority', limit: 2 }), null);
    await expect(c.listIssues(normalizeQuery({ sort: 'due', limit: 2 }), first.next)).rejects.toMatchObject({ code: 'PROVIDER' });
    await expect(c.listIssues(normalizeQuery({ sort: 'priority', limit: 2 }), 'not json')).rejects.toMatchObject({ code: 'PROVIDER' });
  });
});

describe('mapping', () => {
  test('Linear state types map onto the shared categories', () => {
    expect(linear._internals.CATEGORY_BY_TYPE).toEqual({
      triage: 'backlog', backlog: 'backlog', unstarted: 'todo', started: 'started',
      completed: 'done', canceled: 'canceled', duplicate: 'canceled',
    });
  });

  test('metadata offers team keys, facets and active cycles first', async () => {
    const meta = await client().metadata();
    expect(meta.keys).toEqual(['ENG', 'OPS', 'DES']);
    expect(meta.facets.map((f) => f.id)).toEqual(['team', 'project', 'cycle']);
    const cycles = meta.facets.find((f) => f.id === 'cycle').options.map((o) => o.label);
    expect(cycles.slice(0, 2).sort()).toEqual(['ENG Cycle 42', 'OPS Hardening']);
    expect(meta.states.find((s) => s.id === 's-eng-triage').category).toBe('backlog');
    expect(meta.states.find((s) => s.id === 's-eng-duplicate').category).toBe('canceled');
  });

  test('an issue carries its project and cycle as facets', async () => {
    const issue = await client().getIssue('ENG-142');
    expect(issue.facets).toEqual({ project: 'Tickets', cycle: 'Cycle 42' });
    expect(issue.container).toEqual({ id: 't-eng', name: 'Engineering' });
    expect(issue.comments.map((c) => c.id)).toEqual(['cm-1', 'cm-2']);
    expect(issue.children.map((c) => c.key).sort()).toEqual(['ENG-117', 'ENG-121', 'ENG-151']);
  });

  test('a listed issue carries its parent, and both carry how far their sub-issues are', async () => {
    const sent = [];
    const spy = (url, init) => { sent.push(JSON.parse(init.body)); return fixture.fetch(url, init); };
    const c = linear.createClient({ secret: fixture.secret, fetch: spy });
    const { issues } = await c.listIssues(normalizeQuery({ limit: 100 }), null);
    const byKey = Object.fromEntries(issues.map((i) => [i.key, i]));
    expect(byKey['ENG-151'].parent).toEqual({
      key: 'ENG-142',
      title: 'Session tickets tab',
      url: expect.stringMatching(/^https:\/\/linear\.app\/acme\/issue\/ENG-142\//),
      state: expect.objectContaining({ name: 'In Progress', category: 'started' }),
      subIssues: { total: 3, done: 1 }, // ENG-117 is done, whether or not it is listed
    });
    expect(byKey['ENG-142'].subIssues).toEqual({ total: 3, done: 1 });
    expect(byKey['ENG-142'].parent).toBeNull();
    expect(byKey['ENG-139'].subIssues).toBeNull();
    // One request for the page, one for every count on it.
    expect(sent.map((r) => r.operationName)).toEqual(['Issues', 'SubIssues']);
    expect(sent[1].variables.filter.parent.id.in).toEqual(expect.arrayContaining(['i-eng-142', 'i-ops-12']));
  });

  test('counts that cannot be read leave the list standing', async () => {
    const spy = (url, init) => (JSON.parse(init.body).operationName === 'SubIssues'
      ? Promise.resolve({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) })
      : fixture.fetch(url, init));
    const c = linear.createClient({ secret: fixture.secret, fetch: spy });
    const { issues } = await c.listIssues(normalizeQuery({ limit: 100 }), null);
    expect(issues.length).toBeGreaterThan(10);
    expect(issues.every((i) => i.subIssues === null)).toBe(true);
    expect(issues.find((i) => i.key === 'ENG-151').parent.key).toBe('ENG-142');
  });

  describe('sub-issue counts are exact or absent', () => {
    // Answers SubIssues with one done child of ENG-142 per page, paged as pageInfoFor says; the rest goes to the fixture.
    const subIssuesFetch = (pageInfoFor) => {
      const sent = [];
      const fetch = (url, init) => {
        const body = JSON.parse(init.body);
        if (body.operationName !== 'SubIssues') return fixture.fetch(url, init);
        sent.push(body.variables);
        const pageNo = body.variables.after ? Number(body.variables.after) : 0;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            data: { issues: { nodes: [{ parent: { id: 'i-eng-142' }, state: { type: 'completed' } }], pageInfo: pageInfoFor(pageNo) } },
          }),
        });
      };
      return { fetch, sent };
    };
    const list = async (fetch) => {
      const { issues } = await linear.createClient({ secret: fixture.secret, fetch }).listIssues(normalizeQuery({ limit: 100 }), null);
      return issues;
    };

    test('every page is counted', async () => {
      const { fetch, sent } = subIssuesFetch((n) => ({ hasNextPage: n < 2, endCursor: n < 2 ? String(n + 1) : null }));
      const issues = await list(fetch);
      expect(sent).toHaveLength(3);
      expect(issues.find((i) => i.key === 'ENG-142').subIssues).toEqual({ total: 3, done: 3 });
    });

    test('more children than the page budget leaves every count out', async () => {
      const { fetch, sent } = subIssuesFetch((n) => ({ hasNextPage: true, endCursor: String(n + 1) }));
      const issues = await list(fetch);
      expect(sent).toHaveLength(4);
      expect(issues.length).toBeGreaterThan(10);
      expect(issues.every((i) => i.subIssues === null)).toBe(true);
    });

    test('a next page without a cursor is not read again from the start', async () => {
      const { fetch, sent } = subIssuesFetch(() => ({ hasNextPage: true, endCursor: null }));
      const issues = await list(fetch);
      expect(sent.map((v) => v.after)).toEqual([null]);
      expect(issues.every((i) => i.subIssues === null)).toBe(true);
    });

    test('the detail leaves out a count it only has the first page of', async () => {
      const fetch = async (url, init) => {
        const res = await fixture.fetch(url, init);
        const body = await res.json();
        if (body.data?.issue) body.data.issue.children.pageInfo = { hasNextPage: true };
        return { ...res, json: async () => body };
      };
      const issue = await linear.createClient({ secret: fixture.secret, fetch }).getIssue('ENG-142');
      expect(issue.children).toHaveLength(3);
      expect(issue.subIssues).toBeNull();
    });
  });

  test('the detail counts its own sub-issues and its parent\'s', async () => {
    const parent = await client().getIssue('ENG-142');
    expect(parent.subIssues).toEqual({ total: 3, done: 1 });
    const child = await client().getIssue('ENG-151');
    expect(child.parent).toMatchObject({ key: 'ENG-142', subIssues: { total: 3, done: 1 } });
    expect(child.subIssues).toBeNull();
  });

  test('updateIssue sends only the fields it was given', async () => {
    const sent = [];
    const spy = (url, init) => { sent.push(JSON.parse(init.body)); return fixture.fetch(url, init); };
    const c = linear.createClient({ secret: fixture.secret, fetch: spy });
    const issue = await c.updateIssue('ENG-142', { stateId: 's-eng-review' });
    expect(sent[0].variables).toEqual({ id: 'ENG-142', input: { stateId: 's-eng-review' } });
    expect(issue.state.name).toBe('In Review');
  });

  test('an empty patch is refused before any request', async () => {
    const spy = jest.fn();
    await expect(linear.createClient({ secret: 'k', fetch: spy }).updateIssue('ENG-1', {})).rejects.toMatchObject({ code: 'PROVIDER' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('transport', () => {
  const respond = (status, body, headers = {}) => jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? null },
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected token <');
      return body;
    },
  }));

  const call = (fetch) => linear.createClient({ secret: 'lin_api_x', fetch }).whoAmI();

  test('sends the key bare, as Linear expects for personal keys, and names the operation', async () => {
    const fetch = respond(200, { data: { viewer: { id: 'u', name: 'U' }, organization: { id: 'o', name: 'O', urlKey: 'o' } } });
    await call(fetch);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.linear.app/graphql');
    expect(init.headers.Authorization).toBe('lin_api_x');
    expect(JSON.parse(init.body).operationName).toBe('Viewer');
  });

  test.each([
    ['a thrown fetch', jest.fn(async () => { throw new Error('getaddrinfo ENOTFOUND'); }), 'NETWORK'],
    ['HTTP 401 with an HTML body', respond(401, undefined), 'AUTH'],
    ['an authentication error', respond(400, { errors: [{ message: 'x', extensions: { type: 'authentication error' } }] }), 'AUTH'],
    ['a forbidden error', respond(400, { errors: [{ message: 'Forbidden', extensions: { type: 'forbidden' } }] }), 'PROVIDER'],
    // whoAmI is about no one entity: a "not found" there is a failure, not a missing ticket.
    ['an entity not found', respond(200, { data: null, errors: [{ message: 'Entity not found: Issue', extensions: { type: 'invalid input' } }] }), 'PROVIDER'],
    ['HTTP 500 without JSON', respond(500, undefined), 'PROVIDER'],
    ['a 200 without data', respond(200, {}), 'PROVIDER'],
  ])('maps %s', async (_label, fetch, code) => {
    await expect(call(fetch)).rejects.toMatchObject({ code });
  });

  test.each([
    ['a newline', 'lin_api_secret0000\nextra'],
    ['a NUL', 'lin_api_secret0000\0'],
    ['an inner space', 'lin_api_secret0000 extra'],
    ['a non-ASCII character', 'lin_api_secret0000é'],
    ['an empty string', ''],
  ])('a key with %s is refused before any request, without being quoted', async (_label, secret) => {
    const fetch = jest.fn();
    const err = await linear.createClient({ secret, fetch }).whoAmI().catch((e) => e);
    expect(err).toMatchObject({ code: 'AUTH', message: 'The API key is malformed' });
    if (secret) expect(err.message).not.toContain('secret0000');
    expect(err.cause).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('a thrown fetch is reported without quoting what it was given', async () => {
    const secret = 'lin_api_secret0000';
    const fetch = jest.fn(async () => {
      throw new TypeError(`Headers.append: "${secret}" is an invalid header value.`);
    });
    const err = await linear.createClient({ secret, fetch }).whoAmI().catch((e) => e);
    expect(err).toMatchObject({ code: 'NETWORK', message: 'Linear is unreachable' });
    expect(err.cause).toBeUndefined();
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(secret);
  });

  test('a network failure keeps its system code', async () => {
    const fetch = jest.fn(async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.linear.app'), { code: 'ENOTFOUND' }) });
    });
    await expect(call(fetch)).rejects.toMatchObject({ code: 'NETWORK', message: 'Linear is unreachable (ENOTFOUND)' });
  });

  describe('NOT_FOUND only means the issue asked for is missing', () => {
    const notFound = (message) => respond(200, { data: null, errors: [{ message, extensions: { type: 'invalid input' } }] });
    const clientWith = (fetch) => linear.createClient({ secret: 'lin_api_x', fetch });

    test('a missing issue, read, updated or commented on', async () => {
      const fetch = notFound('Entity not found: Issue');
      await expect(clientWith(fetch).getIssue('ENG-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(clientWith(fetch).updateIssue('ENG-1', { priority: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(clientWith(fetch).addComment('ENG-1', 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    test('another entity missing from an update is a provider failure', async () => {
      const fetch = notFound('Entity not found: WorkflowState');
      await expect(clientWith(fetch).updateIssue('ENG-1', { stateId: 's-gone' })).rejects.toMatchObject({ code: 'PROVIDER' });
    });

    test('a list that fails with "not found" is a provider failure', async () => {
      const fetch = notFound('Entity not found: Team');
      await expect(clientWith(fetch).listIssues(normalizeQuery({}), null)).rejects.toMatchObject({ code: 'PROVIDER' });
      await expect(clientWith(fetch).metadata()).rejects.toMatchObject({ code: 'PROVIDER' });
    });
  });

  test('a rate limit carries how long to wait, from Retry-After', async () => {
    const fetch = respond(400, { errors: [{ message: 'Rate limit exceeded', extensions: { type: 'ratelimited' } }] }, { 'retry-after': '30' });
    await expect(call(fetch)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 30_000 });
  });

  test('or from the reset timestamp when there is no Retry-After', async () => {
    const reset = String(Date.now() + 60_000);
    const fetch = respond(429, {}, { 'x-ratelimit-requests-reset': reset });
    const err = await call(fetch).catch((e) => e);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterMs).toBeGreaterThan(55_000);
  });

  test('metadata follows pagination', async () => {
    let calls = 0;
    const fetch = jest.fn(async (url, init) => {
      const { operationName, variables } = JSON.parse(init.body);
      if (operationName !== 'Users') return fixture.fetch(url, { ...init, headers: { ...init.headers, Authorization: fixture.secret } });
      calls += 1;
      const pageNo = variables.after ? Number(variables.after) : 0;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          data: {
            users: {
              nodes: [{ id: `u${pageNo}`, name: `User ${pageNo}`, avatarUrl: null }],
              pageInfo: { hasNextPage: pageNo < 2, endCursor: String(pageNo + 1) },
            },
          },
        }),
      };
    });
    const meta = await linear.createClient({ secret: 'k', fetch }).metadata();
    expect(calls).toBe(3);
    expect(meta.people.map((p) => p.id)).toEqual(['u0', 'u1', 'u2']);
  });
});

describe('refs', () => {
  const fromToolCall = linear.refs.fromToolCall;

  test('fromText only knows the prefixes it is given', () => {
    expect(linear.refs.fromText('ada/eng-142-session-tickets-tab', ['ENG'])).toEqual(['ENG-142']);
    expect(linear.refs.fromText('ada/eng-142-session-tickets-tab', ['OPS'])).toEqual([]);
  });

  test.each([
    ['the claude.ai connector', 'mcp__claude_ai_Linear__get_issue', { id: 'ENG-142' }, [{ key: 'ENG-142', action: 'read' }]],
    ['the official server', 'mcp__linear__save_issue', { id: 'eng-142', title: 'x' }, [{ key: 'ENG-142', action: 'write' }]],
    ['a renamed server', 'mcp__linear-server__save_comment', { issueId: 'OPS-12', body: 'x' }, [{ key: 'OPS-12', action: 'write' }]],
    ['comments being read', 'mcp__claude_ai_Linear__list_comments', { issueId: 'ENG-1' }, [{ key: 'ENG-1', action: 'read' }]],
  ])('reads a targeted issue from %s', (_label, name, input, expected) => {
    expect(fromToolCall({ name, input, result: '' })).toEqual(expected);
  });

  test('a save without id is a creation, keyed from the result', () => {
    const name = 'mcp__claude_ai_Linear__save_issue';
    const input = { team: 'ENG', title: 'New' };
    expect(fromToolCall({ name, input, result: '{"id":"uuid","identifier":"ENG-155","title":"New"}' }))
      .toEqual([{ key: 'ENG-155', action: 'create' }]);
    expect(fromToolCall({ name, input, result: [{ type: 'text', text: '{"identifier": "ENG-156"}' }] }))
      .toEqual([{ key: 'ENG-156', action: 'create' }]);
    expect(fromToolCall({ name, input, result: { content: [{ type: 'text', text: 'Created https://linear.app/acme/issue/ENG-157/new' }] } }))
      .toEqual([{ key: 'ENG-157', action: 'create' }]);
    expect(fromToolCall({ name, input, result: 'Created.' })).toEqual([]);
  });

  test('a UUID cannot be turned into a key without a request, so it is skipped', () => {
    expect(fromToolCall({ name: 'mcp__linear__get_issue', input: { id: '2f1c1b9e-7c1a-4c55-9a51-1c2b3d4e5f60' } })).toEqual([]);
  });

  test('list results never name a ticket', () => {
    const result = '{"issues":[{"identifier":"ENG-1"},{"identifier":"ENG-2"}]}';
    expect(fromToolCall({ name: 'mcp__claude_ai_Linear__list_issues', input: { team: 'ENG' }, result })).toEqual([]);
  });

  test.each([
    ['another provider', 'mcp__github__get_issue'],
    ['a malformed name', 'mcp__linear'],
    ['a built-in tool', 'Bash'],
    ['no name', undefined],
  ])('ignores %s', (_label, name) => {
    expect(fromToolCall({ name, input: { id: 'ENG-1' }, result: '' })).toEqual([]);
  });
});

describe('status is one filter', () => {
  test('a category and a single state add up instead of cancelling out', async () => {
    expect(await keysOf({ stateCategories: ['todo'], stateIds: ['s-eng-review'] }))
      .toEqual(['DES-31', 'ENG-128', 'ENG-137', 'ENG-148', 'ENG-151']);
  });
});
