/**
 * The @tickets mention source with the Linear adapter, over the fixture: the
 * text Claude receives names the priority in words and labels the team, the
 * project and the cycle. What holds for any tracker is in chatTicketsTab.test.js,
 * over the fake adapter.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const issueSource = require('../../src/renderer/services/mention-sources/issue.source');
const { createIssueTrackerService } = require('../../src/main/services/IssueTrackerService');
const { createIssueLinkService } = require('../../src/main/services/IssueLinkService');
const { describeTrackers } = require('../../src/main/issue-trackers/_registry');
const linear = require('../../src/main/issue-trackers/linear.tracker');
const fixture = require('../issue-trackers/fixtures/linear.fixture');

let dir;
let api;
let changedListeners;
let conn;

function wrap(fn, key) {
  return jest.fn(async (...args) => {
    try {
      const value = await fn(...args);
      return key ? { ok: true, [key]: value } : { ok: true, ...value };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code || 'PROVIDER' };
    }
  });
}

beforeEach(async () => {
  fixture.reset();
  issueSource._reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-chat-tickets-'));
  const secrets = new Map();
  const trackers = createIssueTrackerService({
    storePath: path.join(dir, 'issue-trackers.json'),
    secrets: { get: async (a) => secrets.get(a) ?? null, set: async (a, v) => { secrets.set(a, v); }, delete: async (a) => secrets.delete(a) },
    registry: { get: (id) => (id === 'linear' ? linear : null), describe: () => describeTrackers([linear]) },
    fetch: fixture.fetch,
  });
  changedListeners = [];
  const links = createIssueLinkService({
    storePath: path.join(dir, 'issue-links.json'),
    broadcast: (sessionKey) => changedListeners.forEach((fn) => fn({ sessionKey })),
  });
  conn = await trackers.connect('linear', fixture.secret);
  api = {
    dialog: { openExternal: jest.fn() },
    issueTrackers: {
      providers: wrap(async () => trackers.listProviders(), 'providers'),
      connections: wrap(() => trackers.listConnections(), 'connections'),
      metadata: wrap((id) => trackers.metadata(id), 'metadata'),
      listIssues: wrap((id, q, c) => trackers.listIssues(id, q, c)),
      getIssue: wrap((id, key) => trackers.getIssue(id, key), 'issue'),
      updateIssue: wrap((id, key, patch) => trackers.updateIssue(id, key, patch), 'issue'),
      addComment: wrap((id, key, body) => trackers.addComment(id, key, body), 'comment'),
    },
    issueLinks: {
      get: wrap((k) => links.get(k), 'links'),
      link: wrap((k, l, o) => links.link(k, l, o || {}), 'links'),
      dismiss: wrap((k, refs) => links.dismiss(k, refs), 'links'),
      confirm: wrap((k, refs) => links.confirm(k, refs), 'links'),
      suggest: (k, l) => links.suggest(k, l),
      rekey: wrap((a, b) => links.rekey(a, b), 'moved'),
      copy: wrap((a, b) => links.copy(a, b), 'copied'),
      onChanged: (fn) => {
        changedListeners.push(fn);
        return () => { changedListeners = changedListeners.filter((x) => x !== fn); };
      },
    },
  };
  global.window.electron_api = { ...(global.window.electron_api || {}), issueTrackers: api.issueTrackers };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('@tickets mention source', () => {
  test('lists open tickets, cached, labelled by key', async () => {
    const items = await issueSource.getData();
    expect(items.map((i) => i.issue.key)).toContain('ENG-142');
    expect(items.some((i) => i.issue.state.category === 'done')).toBe(false);
    await issueSource.getData();
    expect(api.issueTrackers.listIssues).toHaveBeenCalledTimes(1);
    const item = items.find((i) => i.issue.key === 'ENG-142');
    expect(issueSource.render(item)).toMatchObject({ label: 'ENG-142  Session tickets tab', color: '#f2c94c' });
    expect(issueSource.getChipData(item)).toMatchObject({ type: 'tickets', data: { chipLabel: '@ENG-142', ref: 'linear:ENG-142' } });
  });

  test('resolve fetches the ticket for Claude and links it to the session', async () => {
    const linkTicket = jest.fn();
    const text = await issueSource.resolve(
      { ref: 'linear:ENG-142', key: 'ENG-142', title: 'Session tickets tab', connectionId: conn.id },
      { linkTicket },
    );
    expect(linkTicket).toHaveBeenCalledWith({ ref: 'linear:ENG-142', connectionId: conn.id, title: 'Session tickets tab' }, 'mention');
    // Priority in words and facets labelled like the rest: "Priority: 1" and
    // "project: Tickets" told Claude nothing it could use.
    // Fenced as tracker data (ticketBlock in shared/issue-trackers.js), then the ticket.
    const lines = text.split('\n');
    expect(lines[0]).toBe('<ticket key="ENG-142">');
    const head = lines.indexOf('# ENG-142: Session tickets tab');
    expect(lines.slice(head, head + 2)).toEqual([
      '# ENG-142: Session tickets tab',
      'Status: In Progress | Priority: Urgent | Assignee: Ada Lovelace | Team: Engineering | Project: Tickets | Cycle: Cycle 42 | Labels: feature',
    ]);
    expect(text).toContain('## Why');
    expect(text).toContain('## Latest comments');
    expect(text).toContain('## Sub-issues (1/3 done)\n- ENG-151 [Todo] Persist ticket filters per screen');
  });

  test('a ticket that cannot be loaded still sends something useful', async () => {
    const text = await issueSource.resolve({ ref: 'linear:ENG-99999', key: 'ENG-99999', title: 'Gone', connectionId: conn.id }, {});
    expect(text).toMatch(/^<ticket key="ENG-99999">\n[^\n]*\n\n# ENG-99999: Gone\n\[Could not load the ticket:/);
    expect(text.trimEnd().endsWith('</ticket>')).toBe(true);
  });
});
