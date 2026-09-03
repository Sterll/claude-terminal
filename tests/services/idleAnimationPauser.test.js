/**
 * IdleAnimationPauser — pauses infinite CSS animations on window blur and
 * resumes exactly those on focus, leaving finite (entry) animations alone.
 */
const pauser = require('../../src/renderer/services/IdleAnimationPauser');

function fakeAnim({ iterations, playState = 'running' }) {
  return {
    playState,
    effect: { getTiming: () => ({ iterations }) },
    pause: jest.fn(function () { this.playState = 'paused'; }),
    play: jest.fn(function () { this.playState = 'running'; }),
  };
}

describe('IdleAnimationPauser', () => {
  let animations;

  beforeEach(() => {
    jest.useFakeTimers();
    animations = [];
    document.getAnimations = jest.fn(() => animations);
    document.hasFocus = jest.fn(() => true);
    pauser.init();
  });

  afterEach(() => {
    pauser._reset();
    delete document.getAnimations;
    jest.useRealTimers();
  });

  test('blur pauses infinite animations only', () => {
    const spinner = fakeAnim({ iterations: Infinity });
    const entry = fakeAnim({ iterations: 1 });
    animations.push(spinner, entry);

    window.dispatchEvent(new Event('blur'));

    expect(spinner.pause).toHaveBeenCalled();
    expect(entry.pause).not.toHaveBeenCalled();
  });

  test('focus resumes only what blur paused', () => {
    const spinner = fakeAnim({ iterations: Infinity });
    const alreadyPaused = fakeAnim({ iterations: Infinity, playState: 'paused' });
    animations.push(spinner, alreadyPaused);

    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));

    expect(spinner.play).toHaveBeenCalled();
    // Paused by something else (e.g. .background-paused) — not ours to resume.
    expect(alreadyPaused.play).not.toHaveBeenCalled();
  });

  test('an animation starting while blurred gets swept up', () => {
    window.dispatchEvent(new Event('blur'));

    const late = fakeAnim({ iterations: Infinity });
    animations.push(late);
    document.dispatchEvent(new Event('animationstart'));
    jest.advanceTimersByTime(150);

    expect(late.pause).toHaveBeenCalled();
  });

  test('animationstart while focused does nothing', () => {
    const spinner = fakeAnim({ iterations: Infinity });
    animations.push(spinner);

    document.dispatchEvent(new Event('animationstart'));
    jest.advanceTimersByTime(150);

    expect(spinner.pause).not.toHaveBeenCalled();
  });

  test('a resume on an animation whose element died does not throw', () => {
    const dead = fakeAnim({ iterations: Infinity });
    dead.play = jest.fn(() => { throw new Error('detached'); });
    animations.push(dead);

    window.dispatchEvent(new Event('blur'));
    expect(() => window.dispatchEvent(new Event('focus'))).not.toThrow();
  });

  test('starting unfocused pauses immediately on init', () => {
    pauser._reset();
    const spinner = fakeAnim({ iterations: Infinity });
    animations.push(spinner);
    document.hasFocus = jest.fn(() => false);

    pauser.init();

    expect(spinner.pause).toHaveBeenCalled();
  });
});
