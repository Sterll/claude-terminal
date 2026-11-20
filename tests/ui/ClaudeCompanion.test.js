/**
 * ClaudeCompanion: the physics helpers, the pixel art, and the companion's
 * wiring to the sessions (terminalsState), its menu, its routines, its props
 * and its teardown.
 */

const {
  createCompanion, initCompanion, stepBody, releaseVelocity, formatClock,
} = require('../../src/renderer/ui/companion/ClaudeCompanion');
const { spriteSvg, PALETTES, ACCESSORIES } = require('../../src/renderer/ui/companion/sprite');
const { addTerminal, updateTerminal, clearAllTerminals } = require('../../src/renderer/state/terminals.state');
const { State } = require('../../src/renderer/state/State');
const { t } = require('../../src/renderer/i18n');

const flush = () => new Promise((r) => setTimeout(r, 40));
const openMenu = () => document.querySelector('.ctc-hit')
  .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 }));
const menuActions = () => [...document.querySelectorAll('.ctc-menu button[data-action]')].map((b) => b.dataset.action);
const clickAction = (action) => document.querySelector(`.ctc-menu button[data-action="${action}"]`).click();
const clickCompanion = () => {
  const hit = document.querySelector('.ctc-hit');
  hit.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  hit.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
};

/** Fake timers at 10:00, so no late-night nudge lands in the middle of a test. */
function useFakeClock() {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 0, 5, 10, 0, 0));
}

beforeAll(() => {
  // jsdom has no PointerEvent; the companion only reads MouseEvent fields.
  if (!window.PointerEvent) window.PointerEvent = MouseEvent;
});

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
});

afterEach(async () => {
  jest.useRealTimers();
  clearAllTerminals();
  // terminalsState batches its notifications on rAF: let this one land, or a
  // test on fake timers would find a notification still pending and never
  // hear about its own changes.
  await flush();
});

describe('stepBody', () => {
  test('falls under gravity and comes to rest on the floor', () => {
    const b = { x: 100, y: 100, vx: 0, vy: 0 };
    for (let i = 0; i < 400; i++) stepBody(b, 1 / 60, 70, 70, 0.45);
    expect(b.grounded).toBe(true);
    expect(b.vy).toBe(0);
    expect(b.y).toBe(800 - 70 - 6);
  });

  test('bounces off the side walls and stays inside the window', () => {
    const b = { x: 1100, y: 300, vx: 3000, vy: 0 };
    const impact = stepBody(b, 1 / 30, 70, 70, 0.5);
    expect(impact).toBeGreaterThan(0);
    expect(b.x).toBe(1200 - 70);
    expect(b.vx).toBeLessThan(0);
  });
});

describe('releaseVelocity', () => {
  test('measures the throw over the last samples', () => {
    const [vx, vy] = releaseVelocity([{ t: 0, x: 0, y: 0 }, { t: 50, x: 50, y: -25 }]);
    expect(vx).toBeCloseTo(1000);
    expect(vy).toBeCloseTo(-500);
  });

  test('caps a flick at the maximum throw speed', () => {
    const [vx, vy] = releaseVelocity([{ t: 0, x: 0, y: 0 }, { t: 10, x: 1000, y: 0 }]);
    expect(Math.hypot(vx, vy)).toBeCloseTo(2600);
  });

  test('a release without movement throws nothing', () => {
    expect(releaseVelocity([])).toEqual([0, 0]);
  });
});

test('formatClock rounds up to the second', () => {
  expect(formatClock(25 * 60 * 1000)).toBe('25:00');
  expect(formatClock(61_001)).toBe('1:02');
  expect(formatClock(-5)).toBe('0:00');
});

describe('sprite', () => {
  test('draws a different face per mood, and falls back to idle', () => {
    expect(spriteSvg('idle')).not.toBe(spriteSvg('happy'));
    expect(spriteSvg('unknown-mood')).toBe(spriteSvg('idle'));
  });

  test('every colour and accessory draws, each one differently', () => {
    const colours = Object.keys(PALETTES).map((color) => spriteSvg('idle', [0, 0], { color }));
    const hats = Object.keys(ACCESSORIES).map((hat) => spriteSvg('idle', [0, 0], { hat }));
    expect(new Set(colours).size).toBe(colours.length);
    expect(new Set(hats).size).toBe(hats.length);
    expect(spriteSvg('idle', [0, 0], { color: 'blue' })).toContain(PALETTES.blue.body);
  });
});

describe('companion', () => {
  test('mounts, opens its menu on right-click, and cleans up on destroy', () => {
    const c = createCompanion();
    expect(document.querySelector('.ct-companion .ctc-sprite svg')).not.toBeNull();

    openMenu();
    expect(menuActions()).toEqual(['breathe', 'stretch', 'focus', 'cookie', 'ball', 'sleep', 'sound', 'home', 'hide']);
    expect(document.querySelectorAll('.ctc-swatch')).toHaveLength(Object.keys(PALETTES).length);
    expect(document.querySelectorAll('.ctc-hat')).toHaveLength(Object.keys(ACCESSORIES).length);

    const onHide = jest.fn();
    c.onHide = onHide;
    clickAction('hide');
    expect(onHide).toHaveBeenCalled();
    expect(document.querySelector('.ctc-menu')).toBeNull();

    c.destroy();
    expect(document.querySelector('.ct-companion')).toBeNull();
    expect(document.querySelector('.ctc-fx')).toBeNull();
    expect(JSON.parse(localStorage.getItem('ct-companion')).met).toBe(true);
  });

  test('a colour and an accessory picked in the menu are applied and remembered', () => {
    const c = createCompanion();
    openMenu();
    document.querySelector('.ctc-swatch[data-color="green"]').click();
    document.querySelector('.ctc-hat[data-hat="crown"]').click();
    // The menu stays open, showing the new choice.
    expect(document.querySelector('.ctc-swatch.active').dataset.color).toBe('green');
    expect(document.querySelector('.ctc-hat.active').dataset.hat).toBe('crown');
    expect(document.querySelector('.ct-companion .ctc-sprite').innerHTML).toContain(PALETTES.green.body);
    const saved = JSON.parse(localStorage.getItem('ct-companion'));
    expect(saved).toMatchObject({ color: 'green', hat: 'crown' });
    c.destroy();

    createCompanion().destroy();
    expect(JSON.parse(localStorage.getItem('ct-companion'))).toMatchObject({ color: 'green', hat: 'crown' });
  });

  test('the sound toggle is remembered', () => {
    const c = createCompanion();
    openMenu();
    clickAction('sound');
    expect(JSON.parse(localStorage.getItem('ct-companion')).sound).toBe(true);
    expect(document.querySelector('.ctc-menu button[data-action="sound"]').getAttribute('aria-checked')).toBe('true');
    c.destroy();
  });

  test('shows thinking dots while a session works and "!" while one waits', async () => {
    const c = createCompanion();
    const indicator = document.querySelector('.ctc-indicator');
    expect(indicator.dataset.kind).toBe('');

    addTerminal('t1', { status: 'working', type: 'chat' });
    await flush();
    expect(c._state.session).toBe('working');
    expect(indicator.dataset.kind).toBe('working');

    updateTerminal('t1', { attention: 'input' });
    await flush();
    expect(c._state.session).toBe('waiting');
    expect(indicator.textContent).toBe('!');

    updateTerminal('t1', { attention: null, status: 'ready' });
    await flush();
    expect(c._state.session).toBe('none');
    expect(indicator.dataset.kind).toBe('');
    c.destroy();
  });

  test('a click while Claude waits opens the waiting tab', async () => {
    const focusTerminal = jest.fn();
    const c = createCompanion({ focusTerminal });
    addTerminal('t1', { status: 'working', type: 'chat' });
    addTerminal('t2', { status: 'working', type: 'chat', attention: 'input' });
    await flush();
    expect(document.querySelector('.ctc-bubble').textContent).toBe(t('companion.waitingClick'));
    clickCompanion();
    expect(focusTerminal).toHaveBeenCalledWith('t2');
    c.destroy();
  });

  test('a finished turn is celebrated with its project name', () => {
    useFakeClock();
    const c = createCompanion();
    addTerminal('t1', { status: 'working', type: 'chat', project: { name: 'Pulse' } });
    jest.advanceTimersByTime(50);
    jest.advanceTimersByTime(5000);
    updateTerminal('t1', { status: 'ready' });
    jest.advanceTimersByTime(50);
    expect(document.querySelector('.ctc-bubble').textContent).toBe(t('companion.doneIn', { project: 'Pulse' }));
    c.destroy();
  });

  test('ignores basic, FiveM and web app terminals', async () => {
    const c = createCompanion();
    addTerminal('b1', { status: 'working', isBasic: true });
    addTerminal('f1', { status: 'working', type: 'fivem' });
    await flush();
    expect(c._state.session).toBe('none');
    c.destroy();
  });

  test('the ball comes and goes from the menu', () => {
    const c = createCompanion();
    openMenu();
    clickAction('ball');
    expect(document.querySelector('.ctc-ball')).not.toBeNull();
    openMenu();
    clickAction('ball-away');
    expect(document.querySelector('.ctc-ball')).toBeNull();
    c.destroy();
  });

  test('a cookie falls, the companion walks to it and eats it', () => {
    useFakeClock();
    const c = createCompanion();
    c.run('cookie');
    expect(c._props.cookie).toBeDefined();
    jest.advanceTimersByTime(8000); // fall, walk over, eight bites
    expect(c._props.cookie).toBeUndefined();
    expect(document.querySelector('.ctc-cookie')).toBeNull();
    expect(c._state.snacks).toBe(1);
    expect(c._state.mode).not.toBe('eat');
    c.destroy();
  });

  test('the stretch routine runs to the end and says so', () => {
    useFakeClock();
    const c = createCompanion();
    c.stretch();
    expect(c._state.mode).toBe('routine');
    expect(document.querySelector('.ct-companion').classList.contains('ctc-routine-stretch')).toBe(true);
    jest.advanceTimersByTime(4000);
    expect(document.querySelector('.ct-companion').classList.contains('ctc-st-up')).toBe(true);
    jest.advanceTimersByTime(30_000);
    expect(c._state.mode).not.toBe('routine');
    expect(document.querySelector('.ct-companion').classList.contains('ctc-routine')).toBe(false);
    expect(document.querySelector('.ctc-bubble').textContent).toBe(t('companion.stretchDone'));
    c.destroy();
  });

  test('a click stops a routine', () => {
    const c = createCompanion();
    c.breathe();
    expect(c._state.mode).toBe('routine');
    clickCompanion();
    expect(c._state.mode).toBe('idle');
    c.destroy();
  });

  test('the focus timer counts down, then offers a stretch for the break', () => {
    useFakeClock();
    const c = createCompanion();
    c.run('focus');
    const timer = document.querySelector('.ctc-timer');
    expect(timer.hidden).toBe(false);
    expect(timer.textContent).toBe('25:00');
    jest.advanceTimersByTime(60_000);
    expect(timer.textContent).toBe('24:00');

    jest.advanceTimersByTime(24 * 60_000 + 1000);
    expect(timer.dataset.phase).toBe('break');
    expect(document.querySelector('.ctc-bubble').textContent).toBe(t('companion.focusDone'));
    jest.advanceTimersByTime(2000); // land the celebration hop
    clickCompanion(); // takes the offer
    expect(c._state.mode).toBe('routine');
    expect(c._state.routine.name).toBe('stretch');

    openMenu();
    clickAction('timer-stop');
    expect(timer.hidden).toBe(true);
    c.destroy();
  });

  test('initCompanion follows settings.companionEnabled', async () => {
    const settingsState = new State({ companionEnabled: true });
    const setSetting = jest.fn((k, v) => settingsState.setProp(k, v));
    initCompanion({ settingsState, setSetting });
    expect(document.querySelector('.ct-companion')).not.toBeNull();

    settingsState.setProp('companionEnabled', false);
    await flush();
    expect(document.querySelector('.ct-companion')).toBeNull();

    settingsState.setProp('companionEnabled', true);
    await flush();
    expect(document.querySelector('.ct-companion')).not.toBeNull();
  });
});
