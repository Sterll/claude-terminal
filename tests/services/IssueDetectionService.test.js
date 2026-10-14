/**
 * Automatic ticket detection, against the real link store and tracker service,
 * over the fake test adapter (GitHub Issues-like: `#12` keys, `mcp__fake__*` tools). It must suggest, never link; suggest only
 * tickets that exist; never come back on a dismissal; and pair a tool call
 * with its result, since a creation's key is only in the result.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createIssueDetectionService } = require('../../src/main/services/IssueDetectionService');
const { createIssueTrackerService } = require('../../src/main/services/IssueTrackerService');
const { createIssueLinkService } = require('../../src/main/services/IssueLinkService');
const { ticketBlock } = require('../../src/shared/issue-trackers');
const { describeTrackers } = require('../../src/main/issue-trackers/_registry');
const fake = require('../issue-trackers/fake.tracker');
const fixture = require('../issue-trackers/fixtures/fake.fixture');

let dir;
let trackers;
let links;
let detection;
let conn;
const registry = { get: (id) => (id === 'fake' ? fake : null), describe: () => describeTrackers([fake]) };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-detect-'));
  const secrets = new Map();
  trackers = createIssueTrackerService({
    storePath: path.join(dir, 'issue-trackers.json'),
    secrets: { get: async (a) => secrets.get(a) ?? null, set: async (a, v) => { secrets.set(a, v); }, delete: async (a) => secrets.delete(a) },
    registry,
    fetch: fixture.fetch,
  });
  links = createIssueLinkService({ storePath: path.join(dir, 'issue-links.json') });
  detection = createIssueDetectionService({ trackers, links, registry, wait: async () => {}, isChatSession: () => false });
  conn = await trackers.connect('fake', fixture.secret);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const statuses = async (key) => Object.fromEntries((await links.get(key)).map((l) => [l.ref, l.status]));

/** Detection runs off the event, through the disk: wait for the links rather than for a guessed delay. */
async function waitForLinks(key, count) {
  const end = Date.now() + 3000;
  while (Date.now() < end && (await links.get(key)).length < count) await new Promise((r) => setTimeout(r, 20));
}

describe('tool calls', () => {
  test('a tracker tool that targets a ticket suggests it, with the tool as evidence', async () => {
    const refs = await detection.observeToolCall('s1', { name: 'mcp__fake__update_issue', input: { number: 1, state: 'closed' }, result: 'ok' });
    expect(refs).toEqual(['fake:#1']);
    const [link] = await links.get('s1');
    expect(link).toMatchObject({ ref: 'fake:#1', status: 'suggested', source: 'tool', evidence: 'update_issue (write)', title: 'Crash when the tab closes', connectionId: conn.id });
  });

  test('a creation is keyed from the result', async () => {
    await detection.observeToolCall('s1', { name: 'mcp__fake__create_issue', input: { title: 'New' }, result: { number: 2 } });
    expect(await statuses('s1')).toEqual({ 'fake:#2': 'suggested' });
  });

  test('a key the tracker does not know is not suggested', async () => {
    expect(await detection.observeToolCall('s1', { name: 'mcp__fake__get_issue', input: { number: 999999 } })).toEqual([]);
    expect(await links.get('s1')).toEqual([]);
  });

  test('other tools and other servers are ignored', async () => {
    expect(await detection.observeToolCall('s1', { name: 'Bash', input: { command: 'echo #1' } })).toEqual([]);
    expect(await detection.observeToolCall('s1', { name: 'mcp__other__get_issue', input: { number: 1 } })).toEqual([]);
  });

  test('a ticket already linked, or dismissed, is never suggested again', async () => {
    await links.link('s1', { ref: 'fake:#1', connectionId: conn.id });
    await links.suggest('s1', { ref: 'fake:#2', connectionId: conn.id });
    await links.dismiss('s1', ['fake:#2']);
    const fetchSpy = jest.spyOn(trackers, 'getIssue');
    expect(await detection.observeToolCall('s1', { name: 'mcp__fake__get_issue', input: { number: 1 } })).toEqual([]);
    expect(await detection.observeToolCall('s1', { name: 'mcp__fake__get_issue', input: { number: 2 } })).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled(); // known tickets cost no request
    expect(await statuses('s1')).toEqual({ 'fake:#1': 'linked', 'fake:#2': 'dismissed' });
  });
});

describe('text', () => {
  test('a branch name names its ticket, recorded with its source', async () => {
    expect(await detection.observeText('s1', 'tab-crash-#1', 'branch', 'tab-crash-#1')).toEqual(['fake:#1']);
    expect((await links.get('s1'))[0]).toMatchObject({ source: 'branch', evidence: 'tab-crash-#1' });
  });

  test('a PR title and a prompt, only tickets that exist', async () => {
    expect(await detection.observeText('s1', 'Fix the crash (#1), docs in #2', 'pr', '#57')).toEqual(['fake:#1', 'fake:#2']);
    expect(await detection.observeText('s1', 'see #999999', 'prompt')).toEqual([]);
  });

  test('keys inside a pasted ticket are the tracker\'s: only what the user typed around it is read', async () => {
    const draft = `Work on ticket #1. Here it is:\n\n${ticketBlock('#1', '# #1: Crash\nSub-issue of #2\n- #3 [Open] child')}\n\nAlso fix #2 while you are there`;
    expect(await detection.observeText('s1', draft, 'prompt')).toEqual(['fake:#1', 'fake:#2']);
    expect(await detection.observeText('s2', ticketBlock('#3', '# #3: Old flaky test'), 'prompt')).toEqual([]);
  });

  test('an unknown source is refused', async () => {
    expect(await detection.observeText('s1', '#1', 'assistant')).toEqual([]);
  });
});

describe('chat sessions', () => {
  function fakeChat() {
    let listener;
    return {
      addEventListener: (fn) => { listener = fn; return () => { listener = null; }; },
      emit: (message) => listener('chat-message', { sessionId: 'chat-1', message }),
    };
  }
  const settle = () => new Promise((r) => setTimeout(r, 200));

  test('a tracker tool call is paired with its result and keyed by the SDK session', async () => {
    const chat = fakeChat();
    detection.attachChat(chat);
    chat.emit({ type: 'assistant', session_id: 'sdk-1', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__fake__update_issue', input: { number: 2, state: 'closed' } }] } });
    expect(await links.get('sdk-1')).toEqual([]); // nothing until the result
    chat.emit({ type: 'user', session_id: 'sdk-1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } });
    await waitForLinks('sdk-1', 1);
    expect(await statuses('sdk-1')).toEqual({ 'fake:#2': 'suggested' });
  });

  test('a failed tool call suggests nothing', async () => {
    const chat = fakeChat();
    detection.attachChat(chat);
    chat.emit({ type: 'assistant', session_id: 'sdk-1', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'mcp__fake__get_issue', input: { number: 1 } }] } });
    chat.emit({ type: 'user', session_id: 'sdk-1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'boom' }] } });
    await settle();
    expect(await links.get('sdk-1')).toEqual([]);
  });
});

describe('terminal sessions (hooks)', () => {
  test('PostToolUse and UserPromptSubmit are both read', async () => {
    detection.onHookEvent({ hook: 'PostToolUse', stdin: { session_id: 'term-1', tool_name: 'mcp__fake__get_issue', tool_input: { number: 1 }, tool_response: {} } });
    detection.onHookEvent({ hook: 'UserPromptSubmit', stdin: { session_id: 'term-1', prompt: 'continue on #2 please' } });
    await waitForLinks('term-1', 2);
    expect(await statuses('term-1')).toEqual({ 'fake:#1': 'suggested', 'fake:#2': 'suggested' });
  });

  test("a chat session's own hook events are skipped: ChatService and the renderer report it", async () => {
    const getIssue = jest.spyOn(trackers, 'getIssue');
    const chat = createIssueDetectionService({ trackers, links, registry, wait: async () => {}, isChatSession: (id) => id === 'chat-sdk' });
    await chat.onHookEvent({ hook: 'UserPromptSubmit', stdin: { session_id: 'chat-sdk', prompt: 'work on #1, sub-issue of #2' } });
    await chat.onHookEvent({ hook: 'PostToolUse', stdin: { session_id: 'chat-sdk', tool_name: 'mcp__fake__get_issue', tool_input: { number: 1 }, tool_response: {} } });
    expect(await links.get('chat-sdk')).toEqual([]);
    expect(getIssue).not.toHaveBeenCalled();
  });

  test("a prompt hook that beats the chat session's name is checked again before it is read", async () => {
    let named = false;
    const chat = createIssueDetectionService({
      trackers,
      links,
      registry,
      isChatSession: (id) => named && id === 'chat-new',
      wait: async () => { named = true; }, // init arrives while the hook waits
    });
    await chat.onHookEvent({ hook: 'UserPromptSubmit', stdin: { session_id: 'chat-new', prompt: 'continue on #2 please' } });
    expect(await links.get('chat-new')).toEqual([]);
  });

  test('an event without a session is ignored', () => {
    expect(() => detection.onHookEvent({ hook: 'PostToolUse', stdin: { tool_name: 'mcp__fake__get_issue' } })).not.toThrow();
    expect(() => detection.onHookEvent(null)).not.toThrow();
  });
});
