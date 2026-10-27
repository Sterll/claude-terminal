/**
 * Idle chat tabs going to sleep (chat/idleHibernation.js).
 *
 * The decision is the part that matters: closing a session that still had a
 * turn, a question or a background task in flight would cut it off, and
 * closing one that cannot be resumed would lose the conversation's process
 * for good. The timer only decides when that question is asked.
 */

const {
  DEFAULT_HIBERNATE_MINUTES,
  hibernateDelayMs,
  shouldHibernate,
  createIdleHibernation,
} = require('../../src/renderer/ui/components/chat/idleHibernation');

const MIN = 60 * 1000;

/** A tab that may sleep; each test turns one thing back on. */
const idleTab = (over = {}) => ({
  delayMs: 15 * MIN,
  idleMs: 20 * MIN,
  hasSession: true,
  resumable: true,
  active: false,
  busy: false,
  waitingOnUser: false,
  queued: false,
  handoff: false,
  runningTasks: false,
  shared: false,
  cloud: false,
  ...over,
});

describe('hibernateDelayMs', () => {
  test('defaults to 15 minutes when nothing is stored', () => {
    expect(DEFAULT_HIBERNATE_MINUTES).toBe(15);
    expect(hibernateDelayMs(undefined)).toBe(15 * MIN);
    expect(hibernateDelayMs(null)).toBe(15 * MIN);
  });

  test('0, a negative or junk means never', () => {
    expect(hibernateDelayMs(0)).toBe(0);
    expect(hibernateDelayMs(-5)).toBe(0);
    expect(hibernateDelayMs('abc')).toBe(0);
  });

  test('takes minutes', () => {
    expect(hibernateDelayMs(30)).toBe(30 * MIN);
    expect(hibernateDelayMs('5')).toBe(5 * MIN);
  });
});

describe('shouldHibernate', () => {
  test('an idle background tab with a resumable session sleeps', () => {
    expect(shouldHibernate(idleTab())).toBe(true);
  });

  test.each([
    ['the setting is off', { delayMs: 0 }],
    ['the delay has not passed', { idleMs: 14 * MIN }],
    ['no session is running', { hasSession: false }],
    ['the conversation could not be resumed', { resumable: false }],
    ['it is the open tab', { active: true }],
    ['a turn or a send is in flight', { busy: true }],
    ['a card waits on the user', { waitingOnUser: true }],
    ['a message or a switch is queued', { queued: true }],
    ['the handoff is writing its summary', { handoff: true }],
    ['a background task is running', { runningTasks: true }],
    ['it is shared to claude.ai', { shared: true }],
    ['it is a cloud project', { cloud: true }],
  ])('stays awake when %s', (_label, over) => {
    expect(shouldHibernate(idleTab(over))).toBe(false);
  });

  test('anything missing counts against it', () => {
    expect(shouldHibernate(null)).toBe(false);
    expect(shouldHibernate({ delayMs: 15 * MIN, idleMs: 20 * MIN })).toBe(false);
  });
});

describe('createIdleHibernation', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setup(state = {}, { delayMs = 15 * MIN } = {}) {
    let clock = 0;
    const hibernate = jest.fn();
    const current = { ...idleTab(), ...state };
    const timer = createIdleHibernation({
      getDelayMs: () => delayMs,
      getState: () => current,
      hibernate,
      now: () => clock,
    });
    const advance = (ms) => { clock += ms; jest.advanceTimersByTime(ms); };
    return { timer, hibernate, current, advance };
  }

  test('sleeps once the delay has passed since the last activity', () => {
    const { timer, hibernate, advance } = setup();
    timer.touch();
    advance(14 * MIN);
    expect(hibernate).not.toHaveBeenCalled();
    advance(1 * MIN);
    expect(hibernate).toHaveBeenCalledTimes(1);
  });

  test('activity starts the delay over', () => {
    const { timer, hibernate, advance } = setup();
    timer.touch();
    advance(10 * MIN);
    timer.touch();
    advance(10 * MIN);
    expect(hibernate).not.toHaveBeenCalled();
    advance(5 * MIN);
    expect(hibernate).toHaveBeenCalledTimes(1);
  });

  test('a refused check looks again, and sleeps once the tab is left', () => {
    const { timer, hibernate, current, advance } = setup({ active: true });
    timer.touch();
    advance(30 * MIN);
    expect(hibernate).not.toHaveBeenCalled();
    current.active = false;
    advance(1 * MIN);
    expect(hibernate).toHaveBeenCalledTimes(1);
  });

  test('without a session nothing runs until the next activity', () => {
    const { timer, hibernate, current, advance } = setup({ hasSession: false });
    timer.touch();
    advance(15 * MIN);
    expect(jest.getTimerCount()).toBe(0);
    current.hasSession = true;
    timer.touch();
    advance(15 * MIN);
    expect(hibernate).toHaveBeenCalledTimes(1);
  });

  test('turned off, it never sleeps but keeps looking', () => {
    const { timer, hibernate, advance } = setup({}, { delayMs: 0 });
    timer.touch();
    advance(120 * MIN);
    expect(hibernate).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
  });

  test('destroy stops it', () => {
    const { timer, hibernate, advance } = setup();
    timer.touch();
    timer.destroy();
    advance(60 * MIN);
    expect(hibernate).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
