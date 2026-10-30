/**
 * The side column's Tickets. What it must get right: the linked tickets by
 * state, what is in progress first; a detected one answered from the row
 * without opening the tab; a ticket not read yet, or that failed to read,
 * saying so rather than showing nothing; and clicks that go where they say.
 */

'use strict';

const { createSideTickets } = require('../../src/renderer/ui/components/chat/sideTickets');
const { t } = require('../../src/renderer/i18n');

const link = (ref, over = {}) => ({ ref, connectionId: 'c1', title: `Title of ${ref}`, source: 'manual', status: 'linked', at: 1, ...over });
const issue = (key, category, over = {}) => ({
  ref: `fake:${key}`, key, title: `Issue ${key}`, url: `https://tracker/${key}`,
  state: { id: category, name: category.toUpperCase(), color: '#f2c94c', category },
  priority: 2, assignee: { id: 'u1', name: 'Alex Martin', avatarUrl: null }, subIssues: null, ...over,
});

describe('createSideTickets', () => {
  let bodyEl;
  let deps;
  let side;
  const refs = () => [...bodyEl.querySelectorAll('.chat-side-ticket')].map((el) => el.dataset.ref);
  const rowOf = (ref) => [...bodyEl.querySelectorAll('.chat-side-ticket')].find((el) => el.dataset.ref === ref);

  beforeEach(() => {
    document.body.innerHTML = '<div class="body"></div>';
    bodyEl = document.querySelector('.body');
    deps = { bodyEl, onOpen: jest.fn(), onOpenTab: jest.fn(), onLinkNew: jest.fn(), onAnswer: jest.fn() };
    side = createSideTickets(deps);
  });

  afterEach(() => side.destroy());

  const links = [
    link('fake:A-1'),
    link('fake:A-2'),
    link('fake:A-3'),
    link('fake:A-9', { status: 'suggested', source: 'branch', evidence: 'feat/A-9-deps' }),
    link('fake:A-8', { status: 'dismissed' }),
  ];
  const known = new Map([
    ['fake:A-1', { issue: issue('A-1', 'done') }],
    ['fake:A-2', { issue: issue('A-2', 'started', { subIssues: { total: 5, done: 2 } }) }],
    ['fake:A-3', { error: { code: 'NETWORK' } }],
  ]);
  const getIssue = (ref) => known.get(ref) || null;

  test('counts the linked tickets and the suggestions waiting; a dismissed one is neither', () => {
    expect(side.stats(links)).toEqual({ count: 3, suggested: 1 });
  });

  test('in progress first, done last, then what was detected', () => {
    side.render(links, getIssue);
    expect(refs()).toEqual(['fake:A-2', 'fake:A-3', 'fake:A-1', 'fake:A-9']);
    const started = rowOf('fake:A-2');
    expect(started.querySelector('.issue-state').dataset.category).toBe('started');
    expect(started.querySelector('.chat-side-ticket-title').textContent).toBe('Issue A-2');
    expect(started.querySelector('.issue-progress').textContent).toContain('2/5');
    expect(started.querySelector('.issue-avatar').textContent).toBe('AM');
  });

  test('a ticket that failed to read says so; one not read yet says it is loading', () => {
    side.render([link('fake:A-3'), link('fake:A-4')], getIssue);
    expect(rowOf('fake:A-3').querySelector('.chat-side-ticket-meta').textContent.trim()).toBe(t('chat.tickets.loadFailed'));
    expect(rowOf('fake:A-4').querySelector('.chat-side-ticket-meta').textContent.trim()).toBe(t('tickets.panel.loading'));
    // The title it was linked with stands in until the tracker answers.
    expect(rowOf('fake:A-4').querySelector('.chat-side-ticket-title').textContent).toBe('Title of fake:A-4');
  });

  test('a suggestion says where it was found, and is answered from the row', () => {
    side.render(links, getIssue);
    const suggestion = rowOf('fake:A-9');
    expect(suggestion.classList.contains('suggested')).toBe(true);
    expect(suggestion.querySelector('.chat-side-ticket-why').textContent).toBe(`${t('chat.tickets.sourceBranch')} · feat/A-9-deps`);

    suggestion.querySelector('[data-action="confirm"]').click();
    expect(deps.onAnswer).toHaveBeenLastCalledWith('fake:A-9', true);
    suggestion.querySelector('[data-action="dismiss"]').click();
    expect(deps.onAnswer).toHaveBeenLastCalledWith('fake:A-9', false);
    expect(deps.onOpen).not.toHaveBeenCalled();
  });

  test('a row opens the tab on its ticket; the footer links or opens the tab', () => {
    side.render(links, getIssue);
    rowOf('fake:A-1').querySelector('.chat-side-ticket-title').click();
    expect(deps.onOpen).toHaveBeenCalledWith('fake:A-1');
    rowOf('fake:A-2').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(deps.onOpen).toHaveBeenLastCalledWith('fake:A-2');

    bodyEl.querySelector('[data-action="link-new"]').click();
    expect(deps.onLinkNew).toHaveBeenCalledTimes(1);
    bodyEl.querySelector('[data-action="open-tab"]').click();
    expect(deps.onOpenTab).toHaveBeenCalledTimes(1);
  });

  test('nothing linked yet: says so, and still offers to link one', () => {
    side.render([], getIssue);
    expect(bodyEl.querySelector('.chat-side-empty').textContent).toBe(t('chat.side.noTickets'));
    expect(bodyEl.querySelector('[data-action="link-new"]')).not.toBeNull();
  });

  test('titles from the tracker are escaped', () => {
    side.render([link('fake:A-5', { title: '<img src=x onerror=alert(1)>' })], () => null);
    expect(bodyEl.querySelector('img')).toBeNull();
    expect(bodyEl.querySelector('.chat-side-ticket-title').textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
