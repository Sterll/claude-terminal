/**
 * What ties a chat's Tickets tab to the conversation: suggestions gathered
 * into one card that waits for the end of the turn, each new branch and PR
 * title handed to detection once, and the recap draft.
 */

'use strict';

const { createTicketsWiring } = require('../../src/renderer/ui/components/chat/ticketsWiring');
const { t } = require('../../src/renderer/i18n');

let suggestionListener;
let streaming;
let cards;
let api;
let ticketsTab;
let summary;
let wiring;

beforeEach(() => {
  jest.useFakeTimers();
  streaming = false;
  cards = [];
  summary = null;
  api = { issueLinks: { observeText: jest.fn(async () => ({ ok: true })) } };
  ticketsTab = {
    onSuggestions: (fn) => { suggestionListener = fn; },
    confirm: jest.fn(),
    dismiss: jest.fn(),
    getKey: () => 'tab:chat-1',
  };
  wiring = createTicketsWiring({
    api,
    ticketsTab,
    getGitSummary: () => summary,
    getProject: () => ({ name: 'acme' }),
    getEditedFiles: () => ['/repo/src/a.js', 'C:\\repo\\src\\b.js'],
    showCard: (card) => cards.push(card),
    isStreaming: () => streaming,
  });
});

afterEach(() => {
  wiring.destroy();
  jest.useRealTimers();
});

const S1 = { ref: 'fake:#1', title: 'One', source: 'branch', evidence: 'x' };
const S2 = { ref: 'fake:#2', title: 'Two', source: 'pr', evidence: '#5' };

test('suggestions from one moment make one card', () => {
  suggestionListener([S1]);
  jest.advanceTimersByTime(300);
  suggestionListener([S2]);
  jest.advanceTimersByTime(600);
  expect(cards).toHaveLength(1);
  expect(cards[0].querySelectorAll('.ticket-suggestion-item')).toHaveLength(2);
});

test('during a turn the card waits for its end', () => {
  streaming = true;
  suggestionListener([S1]);
  jest.advanceTimersByTime(1000);
  expect(cards).toHaveLength(0);
  streaming = false;
  wiring.flushCards();
  expect(cards).toHaveLength(1);
  wiring.flushCards(); // nothing left
  expect(cards).toHaveLength(1);
});

test('nothing is shown once destroyed', () => {
  suggestionListener([S1]);
  wiring.destroy();
  jest.advanceTimersByTime(1000);
  wiring.flushCards();
  expect(cards).toHaveLength(0);
});

test('each new branch and PR title is handed to detection once', () => {
  const s = { isRepo: true, branch: 'eng-142-tabs', pr: { pullRequest: { number: 7, title: 'Fix ENG-142' } } };
  wiring.observeGit(s);
  wiring.observeGit(s);
  expect(api.issueLinks.observeText.mock.calls).toEqual([
    ['tab:chat-1', 'eng-142-tabs', 'branch', 'eng-142-tabs'],
    ['tab:chat-1', 'Fix ENG-142', 'pr', '#7'],
  ]);
  wiring.observeGit({ isRepo: false, branch: 'other' });
  expect(api.issueLinks.observeText).toHaveBeenCalledTimes(2);
});

test('the recap names the branch, its commits, the PR and the edited files', () => {
  summary = {
    isRepo: true,
    branch: 'eng-142-tabs',
    onBase: false,
    commits: [{ short: 'abc1234', subject: 'Add the tab' }],
    pr: { pullRequest: { number: 7, title: 'Fix ENG-142', url: 'https://example.com/pr/7' } },
  };
  const recap = wiring.buildRecap().split('\n');
  expect(recap[0]).toBe(t('chat.tickets.recapHeading', { project: 'acme' }));
  expect(recap).toContain(`- ${t('chat.tickets.recapBranch')}: \`eng-142-tabs\``);
  expect(recap).toContain('  - `abc1234` Add the tab');
  expect(recap).toContain(`- ${t('chat.tickets.recapPr')}: [#7 Fix ENG-142](https://example.com/pr/7)`);
  expect(recap.at(-1)).toBe(`- ${t('chat.tickets.recapFiles', { count: 2 })}: \`a.js\`, \`b.js\``);
});
