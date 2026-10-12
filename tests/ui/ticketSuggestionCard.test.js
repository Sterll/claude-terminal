/**
 * The card that asks, in the conversation, whether detected tickets belong to
 * the session. It must confirm exactly what is checked, dismiss the rest, and
 * escape what the tracker sent.
 */

'use strict';

const { createSuggestionCard } = require('../../src/renderer/ui/components/chat/ticketSuggestionCard');
const { t } = require('../../src/renderer/i18n');

const SUGGESTIONS = [
  { ref: 'fake:#1', title: 'Crash when the tab closes', source: 'branch', evidence: 'tab-crash-#1' },
  { ref: 'fake:#3', title: '<img src=x onerror=1>', source: 'tool', evidence: 'create_issue (create)' },
];

function mount() {
  const onConfirm = jest.fn(async () => ({ ok: true }));
  const onDismiss = jest.fn(async () => ({ ok: true }));
  document.body.innerHTML = '';
  const card = createSuggestionCard(SUGGESTIONS, { onConfirm, onDismiss });
  document.body.appendChild(card);
  return { card, onConfirm, onDismiss };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test('lists each ticket, checked, with why it was detected; tracker text is escaped', () => {
  const { card } = mount();
  const items = card.querySelectorAll('.ticket-suggestion-item');
  expect(items).toHaveLength(2);
  expect([...card.querySelectorAll('input[type="checkbox"]')].every((c) => c.checked)).toBe(true);
  expect(items[0].querySelector('.ticket-suggestion-why').textContent).toBe(`${t('chat.tickets.sourceBranch')} · tab-crash-#1`);
  expect(card.querySelector('img')).toBeNull();
  expect(card.textContent).toContain(t('chat.tickets.cardNote'));
});

test('linking confirms what is checked and dismisses the rest', async () => {
  const { card, onConfirm, onDismiss } = mount();
  card.querySelectorAll('input[type="checkbox"]')[1].checked = false;
  card.querySelector('.ticket-suggestion-confirm').click();
  await flush();
  expect(onConfirm).toHaveBeenCalledWith(['fake:#1']);
  expect(onDismiss).toHaveBeenCalledWith(['fake:#3']);
  expect(card.classList.contains('settled')).toBe(true);
  expect(card.textContent).toContain(t('chat.tickets.cardLinked', { keys: '#1' }));
});

test('linking with nothing checked dismisses everything', async () => {
  const { card, onConfirm, onDismiss } = mount();
  card.querySelectorAll('input[type="checkbox"]').forEach((c) => { c.checked = false; });
  card.querySelector('.ticket-suggestion-confirm').click();
  await flush();
  expect(onConfirm).not.toHaveBeenCalled();
  expect(onDismiss).toHaveBeenCalledWith(['fake:#1', 'fake:#3']);
  expect(card.textContent).toContain(t('chat.tickets.cardIgnored'));
});

test('ignore dismisses every suggestion', async () => {
  const { card, onConfirm, onDismiss } = mount();
  card.querySelector('.ticket-suggestion-dismiss').click();
  await flush();
  expect(onConfirm).not.toHaveBeenCalled();
  expect(onDismiss).toHaveBeenCalledWith(['fake:#1', 'fake:#3']);
});
