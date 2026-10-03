/**
 * The backdrop click of a modal.
 *
 * The overlay closes the modal on a click whose target has no `.modal`
 * ancestor. A button whose own click handler replaces the modal body is
 * detached by the time the click bubbles up to the overlay, so closest()
 * found nothing and every such view switch dropped the user out of the dialog.
 */

const { createModal, showModal } = require('../../src/renderer/ui/components/Modal');

function openModal(onClose) {
  const modal = createModal({ id: 'test-modal', title: 'Test', content: '<div class="body"><button class="switch">Next</button></div>', onClose });
  showModal(modal);
  return modal;
}

afterEach(() => {
  document.body.innerHTML = '';
});

test('a button that re-renders the body keeps the modal open', () => {
  const onClose = jest.fn();
  const modal = openModal(onClose);
  const body = modal.querySelector('.body');
  body.querySelector('.switch').addEventListener('click', () => {
    body.innerHTML = '<p class="next-view">second view</p>';
  });

  modal.querySelector('.switch').click();

  expect(onClose).not.toHaveBeenCalled();
  expect(modal.querySelector('.next-view')).not.toBeNull();
});

test('a click on the backdrop itself still closes the modal', () => {
  const onClose = jest.fn();
  const modal = openModal(onClose);
  modal.click();
  expect(onClose).toHaveBeenCalledTimes(1);
});
