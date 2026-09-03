/**
 * Idle-cost regression test for the chat markdown tickers.
 *
 * attachInteractivity() used to arm a 1 Hz interval on every chat container,
 * scanning that container's whole subtree for Discord presence cards whether or
 * not any existed — and it could never stop when none ever appeared, because its
 * exit condition required having seen one first. With a few tabs open on long
 * transcripts that measured tens of milliseconds of querySelectorAll per second,
 * for the life of the process.
 *
 * The ticker is now armed by postProcess(), only for a render batch that
 * actually contains a presence card, and retires itself once the last one leaves
 * the document.
 */

jest.mock('../../src/renderer/i18n', () => ({ t: (key) => key }));

describe('markdown idle tickers', () => {
  let interactivity;
  let postProcess;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    document.body.innerHTML = '';
    interactivity = require('../../src/renderer/services/markdown/interactivity');
    ({ postProcess } = require('../../src/renderer/services/markdown/postProcess'));
  });

  afterEach(() => {
    interactivity.stopPresenceTicker();
    jest.useRealTimers();
  });

  /** A rendered batch holding one presence card with a live elapsed timer. */
  function presenceBatch(startedMsAgo) {
    const batch = document.createElement('div');
    batch.innerHTML = `<div class="dc-presence">`
      + `<div class="dc-presence-time" data-start="${Date.now() - startedMsAgo}"></div>`
      + `</div>`;
    document.body.appendChild(batch);
    return batch;
  }

  it('arms no timer when interactivity is attached to a container', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    interactivity.attachInteractivity(container);

    expect(jest.getTimerCount()).toBe(0);
  });

  it('arms no timer for a rendered batch without a presence card', () => {
    const batch = document.createElement('div');
    batch.innerHTML = '<p>just prose, and a <code>code span</code></p>';
    document.body.appendChild(batch);

    postProcess(batch);

    expect(jest.getTimerCount()).toBe(0);
  });

  it('arms the ticker for a batch that has one, and keeps it counting', () => {
    const batch = presenceBatch(65_000);

    postProcess(batch);
    expect(jest.getTimerCount()).toBe(1);

    const time = batch.querySelector('.dc-presence-time');
    expect(time.textContent).toBe('01:05 elapsed');

    jest.advanceTimersByTime(1000);
    expect(time.textContent).toBe('01:06 elapsed');
  });

  it('arms only one ticker no matter how many batches carry a card', () => {
    postProcess(presenceBatch(1000));
    postProcess(presenceBatch(2000));

    expect(jest.getTimerCount()).toBe(1);
  });

  it('retires the ticker once the last presence card leaves the document', () => {
    const batch = presenceBatch(1000);
    postProcess(batch);
    expect(jest.getTimerCount()).toBe(1);

    // Closing the tab that held the card detaches it from the document.
    batch.remove();
    jest.advanceTimersByTime(1000);

    expect(jest.getTimerCount()).toBe(0);
  });

  it('leaves a card open in another tab counting when one tab is torn down', () => {
    const kept = presenceBatch(1000);
    const closed = presenceBatch(1000);
    postProcess(kept);

    // ChatView calls this from destroy(); it must not silence the global ticker.
    interactivity.detachInteractivity(closed);
    closed.remove();
    jest.advanceTimersByTime(1000);

    expect(jest.getTimerCount()).toBe(1);
    expect(kept.querySelector('.dc-presence-time').textContent).toBe('00:02 elapsed');
  });
});
