/**
 * A modal opened from another one.
 *
 * Every modal listens for Escape and Tab on `document`, so connecting an
 * account from the account switch offer used to close both dialogs on one
 * Escape: the sign-in was cancelled and the offer resolved with no choice.
 * Only the modal on top answers the keyboard.
 */

const { createModal, showModal, closeModal } = require('../../src/renderer/ui/components/Modal');

function open(id, onClose) {
  const modal = createModal({ id, title: id, content: `<input class="${id}-input">`, onClose });
  showModal(modal);
  return modal;
}

const pressEscape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

afterEach(() => {
  document.body.innerHTML = '';
});

test('Escape closes the top modal and leaves the one under it open', () => {
  const outerClose = jest.fn();
  const innerClose = jest.fn();
  const outer = open('outer', outerClose);
  const inner = open('inner', innerClose);

  pressEscape();

  expect(innerClose).toHaveBeenCalledTimes(1);
  expect(outerClose).not.toHaveBeenCalled();
  expect(inner.classList.contains('active')).toBe(false);
  expect(outer.isConnected).toBe(true);

  // The next Escape belongs to the modal that is now on top.
  pressEscape();
  expect(outerClose).toHaveBeenCalledTimes(1);
});

test('a modal closed in code hands the keyboard back to the one under it', () => {
  const outerClose = jest.fn();
  open('outer', outerClose);
  const inner = open('inner', jest.fn());

  closeModal(inner);
  pressEscape();

  expect(outerClose).toHaveBeenCalledTimes(1);
});

test('a modal removed from the page without a close does not deafen the rest', () => {
  const outerClose = jest.fn();
  open('outer', outerClose);
  const inner = open('inner', jest.fn());

  inner.remove();
  pressEscape();

  expect(outerClose).toHaveBeenCalledTimes(1);
});

test('a lone modal still closes on Escape', () => {
  const onClose = jest.fn();
  open('only', onClose);
  pressEscape();
  expect(onClose).toHaveBeenCalledTimes(1);
});
