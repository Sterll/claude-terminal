/**
 * The chat footer's turn clock.
 *
 * Two behaviours are worth pinning: the formatter keeps seconds visible below
 * the hour (a counter that jumps from "59s" to "1m" and then sits still for a
 * minute reads as frozen), and start() is idempotent — ChatView calls
 * setStreaming(true) from more than one path in a turn and a restart there
 * would silently reset the count the user is reading.
 */

const { createElapsedTimer, formatElapsed } = require('../../src/renderer/ui/components/chat/elapsedTimer');

describe('formatElapsed', () => {
  it('shows bare seconds under a minute', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(999)).toBe('0s');
    expect(formatElapsed(8_000)).toBe('8s');
    expect(formatElapsed(59_999)).toBe('59s');
  });

  it('keeps zero-padded seconds between a minute and an hour', () => {
    expect(formatElapsed(60_000)).toBe('1m 00s');
    expect(formatElapsed(64_000)).toBe('1m 04s');
    expect(formatElapsed(3_599_000)).toBe('59m 59s');
  });

  it('drops to hours and minutes past the hour', () => {
    expect(formatElapsed(3_600_000)).toBe('1h 00m');
    expect(formatElapsed(7_500_000)).toBe('2h 05m');
  });

  it('treats missing or negative input as zero', () => {
    expect(formatElapsed(undefined)).toBe('0s');
    expect(formatElapsed(-5_000)).toBe('0s');
  });
});

describe('createElapsedTimer', () => {
  let el;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    el = document.createElement('span');
    el.hidden = true;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reveals the element and ticks once a second', () => {
    const timer = createElapsedTimer(el);
    timer.start();
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe('0s');

    jest.advanceTimersByTime(3_000);
    expect(el.textContent).toBe('3s');

    timer.destroy();
  });

  it('does not restart when start() is called again mid-turn', () => {
    const timer = createElapsedTimer(el);
    timer.start();
    jest.advanceTimersByTime(10_000);
    timer.start();
    jest.advanceTimersByTime(1_000);
    expect(el.textContent).toBe('11s');
    timer.destroy();
  });

  it('lands on the true total on stop, not on the last whole tick', () => {
    const timer = createElapsedTimer(el);
    timer.start();
    jest.advanceTimersByTime(5_400); // 5s ticked, 5.4s elapsed
    jest.setSystemTime(Date.now() + 700); // 6.1s when the turn ends
    timer.stop();
    expect(el.textContent).toBe('6s');
    expect(el.classList.contains('done')).toBe(true);
    expect(timer.isRunning()).toBe(false);
  });

  it('starts a fresh count after a stop', () => {
    const timer = createElapsedTimer(el);
    timer.start();
    jest.advanceTimersByTime(30_000);
    timer.stop();
    timer.start();
    expect(el.textContent).toBe('0s');
    expect(el.classList.contains('done')).toBe(false);
    timer.destroy();
  });

  it('hides and clears on destroy, and stops ticking', () => {
    const timer = createElapsedTimer(el);
    timer.start();
    jest.advanceTimersByTime(2_000);
    timer.destroy();
    expect(el.hidden).toBe(true);
    expect(el.textContent).toBe('');
    jest.advanceTimersByTime(5_000);
    expect(el.textContent).toBe('');
  });
});
