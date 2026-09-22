/**
 * IdleAnimationPauser freezes perpetual CSS animations while the window is
 * unfocused, and nothing else.
 *
 * The behavioural contract is unchanged from the version that used
 * `Animation.pause()`. What changed is the mechanism, and that is what most of
 * these tests are really guarding: `document.getAnimations()` is superlinear in
 * document size (measured in this app: 534 ms at 21k nodes, 13.4 s at 81k,
 * 97 s at 200k), and it used to run on every blur and on a 100 ms debounce
 * after every animation start while blurred. A long transcript therefore paid
 * a multi-second freeze each time the user tabbed away, and a session left
 * streaming in the background ran those sweeps back to back.
 *
 * So the load-bearing assertion here is the negative one: after init, no code
 * path may walk the document.
 */
const pauser = require('../../src/renderer/services/IdleAnimationPauser');

const PAUSED = pauser.PAUSE_CLASS;

/** An element whose animations resolve to `counts` in computed style. */
function animatedEl(counts, { connected = true } = {}) {
  const el = document.createElement('div');
  el.dataset.counts = counts;
  if (connected) document.body.appendChild(el);
  return el;
}

function startAnimation(el, pseudoElement = '') {
  const e = new Event('animationstart', { bubbles: true });
  Object.defineProperty(e, 'target', { value: el, configurable: true });
  e.pseudoElement = pseudoElement;
  document.dispatchEvent(e);
}

function endAnimation(el) {
  const e = new Event('animationend', { bubbles: true });
  Object.defineProperty(e, 'target', { value: el, configurable: true });
  document.dispatchEvent(e);
}

let docGetAnimations;

beforeEach(() => {
  document.body.innerHTML = '';
  // jsdom resolves no animation properties, so computed style is stubbed from
  // the element's own data attribute.
  jest.spyOn(window, 'getComputedStyle').mockImplementation((el) => ({
    animationIterationCount: (el && el.dataset && el.dataset.counts) || '',
  }));
  docGetAnimations = jest.fn(() => []);
  document.getAnimations = docGetAnimations;
  document.hasFocus = jest.fn(() => true);
  pauser.init();
  docGetAnimations.mockClear(); // the boot sweep is allowed exactly one call
});

afterEach(() => {
  pauser._reset();
  delete document.getAnimations;
  window.getComputedStyle.mockRestore();
});

describe('what gets frozen', () => {
  test('blur freezes an element whose animation is infinite', () => {
    const spinner = animatedEl('infinite');
    startAnimation(spinner);

    window.dispatchEvent(new Event('blur'));

    expect(spinner.classList.contains(PAUSED)).toBe(true);
  });

  test('a finite entry animation is never touched', () => {
    const entry = animatedEl('1');
    startAnimation(entry);

    window.dispatchEvent(new Event('blur'));

    expect(entry.classList.contains(PAUSED)).toBe(false);
  });

  test('an element mixing a spinner with an entry animation is left alone', () => {
    // The pause is a property of the element, so freezing this one would stick
    // the entry animation at opacity 0 and hide a streamed message.
    const mixed = animatedEl('infinite, 1');
    startAnimation(mixed);

    window.dispatchEvent(new Event('blur'));

    expect(mixed.classList.contains(PAUSED)).toBe(false);
  });

  test('focus thaws exactly what blur froze', () => {
    const spinner = animatedEl('infinite');
    startAnimation(spinner);

    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));

    expect(spinner.classList.contains(PAUSED)).toBe(false);
  });

  test('a spinner appearing while away starts frozen', () => {
    window.dispatchEvent(new Event('blur'));

    const late = animatedEl('infinite');
    startAnimation(late);

    expect(late.classList.contains(PAUSED)).toBe(true);
  });

  test('an animation starting while focused is not frozen', () => {
    const spinner = animatedEl('infinite');
    startAnimation(spinner);

    expect(spinner.classList.contains(PAUSED)).toBe(false);
  });

  test('a pseudo-element animation is read against its own computed style', () => {
    const el = animatedEl('infinite');
    startAnimation(el, '::before');

    window.dispatchEvent(new Event('blur'));

    expect(window.getComputedStyle).toHaveBeenCalledWith(el, '::before');
    expect(el.classList.contains(PAUSED)).toBe(true);
  });

  test('starting unfocused freezes what is already tracked', () => {
    pauser._reset();
    document.hasFocus = jest.fn(() => false);
    pauser.init();

    const spinner = animatedEl('infinite');
    startAnimation(spinner);

    expect(spinner.classList.contains(PAUSED)).toBe(true);
  });
});

describe('the document is never walked', () => {
  test('blur does not call document.getAnimations', () => {
    const spinner = animatedEl('infinite');
    startAnimation(spinner);

    window.dispatchEvent(new Event('blur'));

    expect(docGetAnimations).not.toHaveBeenCalled();
  });

  test('neither does a burst of animation starts while blurred', () => {
    window.dispatchEvent(new Event('blur'));

    for (let i = 0; i < 50; i++) startAnimation(animatedEl('infinite'));

    // The old module re-armed a full document sweep 100 ms after each of these.
    expect(docGetAnimations).not.toHaveBeenCalled();
  });

  test('nor focus, nor a second blur', () => {
    startAnimation(animatedEl('infinite'));
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('blur'));

    expect(docGetAnimations).not.toHaveBeenCalled();
  });
});

describe('the tracked set stays bounded', () => {
  test('an element that stops animating is dropped', () => {
    const spinner = animatedEl('infinite');
    startAnimation(spinner);
    endAnimation(spinner);

    window.dispatchEvent(new Event('blur'));

    expect(spinner.classList.contains(PAUSED)).toBe(false);
  });

  test('an element pruned from the DOM is dropped on the next blur', () => {
    const spinner = animatedEl('infinite');
    startAnimation(spinner);
    // A spinner whose message the transcript pruner detached never fires
    // animationend, so nothing else would ever let go of it.
    spinner.remove();

    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('blur'));

    expect(spinner.classList.contains(PAUSED)).toBe(false);
  });

  test('a detached element does not throw on blur', () => {
    const spinner = animatedEl('infinite');
    startAnimation(spinner);
    spinner.remove();

    expect(() => window.dispatchEvent(new Event('blur'))).not.toThrow();
  });

  // TranscriptPruner detaches and later re-appends *the same* nodes, so the
  // order below is a normal session, not a corner case: tab away, the pruner
  // takes the spinner's message out from under the pause, tab back. Dropping
  // the element without unpausing it left the class on for good — focus only
  // reaches what is still tracked, and this was dropped from that set.
  test('a spinner paused, pruned, then remounted is not left frozen', () => {
    const spinner = animatedEl('infinite');
    startAnimation(spinner);

    window.dispatchEvent(new Event('blur'));
    expect(spinner.classList.contains(PAUSED)).toBe(true);

    spinner.remove();                      // pruned while paused
    window.dispatchEvent(new Event('focus'));
    document.body.appendChild(spinner);    // remounted by the pruner

    expect(spinner.classList.contains(PAUSED)).toBe(false);
  });

  test('a remounted spinner that re-announces itself is not left frozen', () => {
    const spinner = animatedEl('infinite');
    startAnimation(spinner);
    window.dispatchEvent(new Event('blur'));
    spinner.remove();
    window.dispatchEvent(new Event('focus'));

    // Remount and restart, which is what a re-rendered card does.
    document.body.appendChild(spinner);
    startAnimation(spinner);

    expect(spinner.classList.contains(PAUSED)).toBe(false);
  });
});
