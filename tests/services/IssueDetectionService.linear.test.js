/**
 * Automatic ticket detection with the Linear adapter, against the real link
 * store and tracker service over the fixture: Linear's MCP tool names, a
 * creation keyed from its result, and `ENG-142` keys in branch names, pull
 * request titles and prompts, only for the prefixes the workspace has. What
 * holds for any tracker is in IssueDetectionService.test.js, over the fake.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createIssueDetectionService } = require('../../src/main/services/IssueDetectionService');
const { createIssueTrackerService } = require('../../src/main/services/IssueTrackerService');
const { createIssueLinkService } = require('../../src/main/services/IssueLinkService');
const { describeTrackers } = require('../../src/main/issue-trackers/_registry');
const linear = require('../../src/main/issue-trackers/linear.tracker');
const fixture = require('../issue-trackers/fixtures/linear.fixture');

let dir;
let trackers;
let links;
let detection;
let conn;
const registry = { get: (id) => (id === 'linear' ? linear : null), describe: () => describeTrackers([linear]) };

beforeEach(async () => {
  fixture.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-detect-'));
  const secrets = new Map();
  trackers = createIssueTrackerService({
    storePath: path.join(dir, 'issue-trackers.json'),
    secrets: { get: async (a) => secrets.get(a) ?? null, set: async (a, v) => { secrets.set(a, v); }, delete: async (a) => secrets.delete(a) },
    registry,
    fetch: fixture.fetch,
  });
  links = createIssueLinkService({ storePath: path.join(dir, 'issue-links.json') });
  detection = createIssueDetectionService({ trackers, links, registry, isChatSession: () => false });
  conn = await trackers.connect('linear', fixture.secret);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const statuses = async (key) => Object.fromEntries((await links.get(key)).map((l) => [l.ref, l.status]));

describe('tool calls', () => {
  test('a Linear tool that targets a ticket suggests it, with the tool as evidence', async () => {
    const refs = await detection.observeToolCall('s1', { name: 'mcp__claude_ai_Linear__save_comment', input: { issueId: 'ENG-142', body: 'x' }, result: 'ok' });
    expect(refs).toEqual(['linear:ENG-142']);
    const [link] = await links.get('s1');
    expect(link).toMatchObject({ ref: 'linear:ENG-142', status: 'suggested', source: 'tool', evidence: 'save_comment (write)', title: 'Session tickets tab', connectionId: conn.id });
  });

  test('a creation is keyed from the result', async () => {
    await detection.observeToolCall('s1', { name: 'mcp__linear__save_issue', input: { team: 'ENG', title: 'New' }, result: [{ type: 'text', text: '{"identifier":"ENG-155"}' }] });
    expect(await statuses('s1')).toEqual({ 'linear:ENG-155': 'suggested' });
  });

  test('a key the tracker does not know is not suggested', async () => {
    expect(await detection.observeToolCall('s1', { name: 'mcp__linear__get_issue', input: { id: 'ENG-99999' } })).toEqual([]);
    expect(await links.get('s1')).toEqual([]);
  });

  test('other tools, lists and errors are ignored', async () => {
    expect(await detection.observeToolCall('s1', { name: 'Bash', input: { command: 'echo ENG-142' } })).toEqual([]);
    expect(await detection.observeToolCall('s1', { name: 'mcp__linear__list_issues', input: {}, result: '{"identifier":"ENG-142"}' })).toEqual([]);
  });
});

describe('text', () => {
  test('a branch name names its ticket', async () => {
    expect(await detection.observeText('s1', 'ada/eng-142-session-tickets-tab', 'branch', 'ada/eng-142-session-tickets-tab')).toEqual(['linear:ENG-142']);
    expect((await links.get('s1'))[0]).toMatchObject({ source: 'branch', evidence: 'ada/eng-142-session-tickets-tab' });
  });

  test('a PR title and a prompt, only for prefixes the workspace has', async () => {
    expect(await detection.observeText('s1', 'ENG-142: session tab (see UTF-8 notes and OPS-12)', 'pr', '#57')).toEqual(['linear:ENG-142', 'linear:OPS-12']);
    expect(await detection.observeText('s1', 'fix SHA-256 handling', 'prompt')).toEqual([]);
  });
});
