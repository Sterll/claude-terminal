const { parseCron, nextRunAt, isValidCron } = require('../../src/shared/cron');

describe('parseCron', () => {
  const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0);

  it('matches an exact minute and hour', () => {
    const m = parseCron('30 9 * * *');
    expect(m(at(2026, 8, 10, 9, 30))).toBe(true);
    expect(m(at(2026, 8, 10, 9, 31))).toBe(false);
    expect(m(at(2026, 8, 10, 10, 30))).toBe(false);
  });

  it('supports step, range and list syntax', () => {
    const every15 = parseCron('*/15 * * * *');
    expect(every15(at(2026, 8, 10, 3, 0))).toBe(true);
    expect(every15(at(2026, 8, 10, 3, 45))).toBe(true);
    expect(every15(at(2026, 8, 10, 3, 46))).toBe(false);

    const workHours = parseCron('0 9-17 * * *');
    expect(workHours(at(2026, 8, 10, 9, 0))).toBe(true);
    expect(workHours(at(2026, 8, 10, 17, 0))).toBe(true);
    expect(workHours(at(2026, 8, 10, 18, 0))).toBe(false);

    const list = parseCron('0 0 * * 1,3,5');
    expect(list(at(2026, 8, 10, 0, 0))).toBe(true);  // Monday
    expect(list(at(2026, 8, 11, 0, 0))).toBe(false); // Tuesday
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCron('* * * *')).toThrow();
    expect(() => parseCron('60 * * * *')).toThrow();
    expect(() => parseCron('0 24 * * *')).toThrow();
    expect(() => parseCron('*/0 * * * *')).toThrow();
    expect(() => parseCron('10-5 * * * *')).toThrow();
    expect(isValidCron('0 9 * * *')).toBe(true);
    expect(isValidCron('nope')).toBe(false);
  });
});

describe('nextRunAt', () => {
  it('returns the next occurrence strictly after `from`', () => {
    const from = new Date(2026, 7, 10, 8, 0, 0);      // Mon 10 Aug 2026, 08:00
    const next = nextRunAt('30 9 * * *', from);
    expect(next).toEqual(new Date(2026, 7, 10, 9, 30, 0, 0));
  });

  it('rolls over to the next day when today is already past', () => {
    const from = new Date(2026, 7, 10, 10, 0, 0);
    const next = nextRunAt('30 9 * * *', from);
    expect(next).toEqual(new Date(2026, 7, 11, 9, 30, 0, 0));
  });

  it('never returns the current minute', () => {
    const from = new Date(2026, 7, 10, 9, 30, 0);
    const next = nextRunAt('30 9 * * *', from);
    expect(next).toEqual(new Date(2026, 7, 11, 9, 30, 0, 0));
  });

  it('finds the next matching weekday', () => {
    const from = new Date(2026, 7, 10, 12, 0, 0);     // Monday
    const next = nextRunAt('0 10 * * 5', from);        // Fridays at 10:00
    expect(next.getDay()).toBe(5);
    expect(next).toEqual(new Date(2026, 7, 14, 10, 0, 0, 0));
  });

  it('crosses a month boundary', () => {
    const from = new Date(2026, 7, 20, 0, 0, 0);
    const next = nextRunAt('0 9 1 * *', from);         // 1st of each month
    expect(next).toEqual(new Date(2026, 8, 1, 9, 0, 0, 0));
  });

  it('returns null for an expression that can never fire', () => {
    // 30 February
    expect(nextRunAt('0 0 30 2 *', new Date(2026, 0, 1))).toBeNull();
  });

  it('returns null on an invalid expression instead of throwing', () => {
    expect(nextRunAt('not a cron')).toBeNull();
  });

  it('skips impossible days cheaply rather than scanning every minute', () => {
    // Guards the day-skipping optimisation: a naive scan would walk ~527k
    // minutes here before giving up.
    const started = process.hrtime.bigint();
    nextRunAt('0 0 30 2 *', new Date(2026, 0, 1));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(50);
  });
});
