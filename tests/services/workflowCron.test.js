// Regression tests for parseCron — the 5-field cron matcher used by the
// WorkflowScheduler. Exported as WorkflowScheduler.parseCron.

jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/data' },
}), { virtual: true });

const WorkflowScheduler = require('../../src/main/services/WorkflowScheduler');
const { parseCron } = WorkflowScheduler;

// Build a Date with a specific minute (other fields chosen to satisfy any '*').
// Base: 2024-01-15 (Monday) 12:00 — dom=15, month=1(Jan→getMonth 0→+1=1), dow=1.
function dateAtMinute(minute, hour = 12) {
  return new Date(2024, 0, 15, hour, minute, 0, 0);
}

describe('parseCron', () => {
  describe('field count validation', () => {
    test('throws when fewer than 5 fields', () => {
      expect(() => parseCron('* * * *')).toThrow(/Invalid cron expression/);
    });

    test('throws when more than 5 fields', () => {
      expect(() => parseCron('* * * * * *')).toThrow(/Invalid cron expression/);
    });

    test('accepts exactly 5 fields', () => {
      expect(() => parseCron('* * * * *')).not.toThrow();
    });
  });

  describe('wildcard', () => {
    test('all-wildcards matches any date', () => {
      const m = parseCron('* * * * *');
      expect(m(dateAtMinute(0))).toBe(true);
      expect(m(dateAtMinute(37))).toBe(true);
    });
  });

  describe('step */N on minute field', () => {
    const m = parseCron('*/15 * * * *');
    test('matches 0, 15, 30, 45', () => {
      expect(m(dateAtMinute(0))).toBe(true);
      expect(m(dateAtMinute(15))).toBe(true);
      expect(m(dateAtMinute(30))).toBe(true);
      expect(m(dateAtMinute(45))).toBe(true);
    });
    test('does not match 7, 20, 31', () => {
      expect(m(dateAtMinute(7))).toBe(false);
      expect(m(dateAtMinute(20))).toBe(false);
      expect(m(dateAtMinute(31))).toBe(false);
    });
  });

  describe('range-step a-b/N', () => {
    const m = parseCron('0-30/10 * * * *');
    test('matches 0, 10, 20, 30', () => {
      expect(m(dateAtMinute(0))).toBe(true);
      expect(m(dateAtMinute(10))).toBe(true);
      expect(m(dateAtMinute(20))).toBe(true);
      expect(m(dateAtMinute(30))).toBe(true);
    });
    test('does not match 40 (outside range) or 5 (off step)', () => {
      expect(m(dateAtMinute(40))).toBe(false);
      expect(m(dateAtMinute(5))).toBe(false);
    });
  });

  describe('comma list', () => {
    const m = parseCron('0,30 * * * *');
    test('matches 0 and 30', () => {
      expect(m(dateAtMinute(0))).toBe(true);
      expect(m(dateAtMinute(30))).toBe(true);
    });
    test('does not match 15', () => {
      expect(m(dateAtMinute(15))).toBe(false);
    });
  });

  describe('exact value', () => {
    const m = parseCron('42 * * * *');
    test('matches 42 only', () => {
      expect(m(dateAtMinute(42))).toBe(true);
      expect(m(dateAtMinute(41))).toBe(false);
      expect(m(dateAtMinute(43))).toBe(false);
    });
  });

  describe('plain range a-b', () => {
    const m = parseCron('10-12 * * * *');
    test('matches inclusive endpoints', () => {
      expect(m(dateAtMinute(10))).toBe(true);
      expect(m(dateAtMinute(12))).toBe(true);
    });
    test('excludes just outside', () => {
      expect(m(dateAtMinute(9))).toBe(false);
      expect(m(dateAtMinute(13))).toBe(false);
    });
  });

  describe('hour field', () => {
    test('specific hour matches only that hour', () => {
      const m = parseCron('* 9 * * *');
      expect(m(dateAtMinute(0, 9))).toBe(true);
      expect(m(dateAtMinute(0, 10))).toBe(false);
    });
  });

  describe('invalid expressions throw', () => {
    test('step < 1 rejected', () => {
      expect(() => parseCron('*/0 * * * *')).toThrow(/Invalid cron step/);
    });

    test('out-of-range minute value rejected', () => {
      expect(() => parseCron('60 * * * *')).toThrow(/Invalid cron/);
    });

    test('out-of-range hour value rejected', () => {
      expect(() => parseCron('* 24 * * *')).toThrow(/Invalid cron/);
    });

    test('range start > end rejected', () => {
      expect(() => parseCron('30-10 * * * *')).toThrow(/start > end/);
    });

    test('range-step with start > end rejected', () => {
      expect(() => parseCron('30-10/5 * * * *')).toThrow(/start > end/);
    });

    test('non-numeric step rejected', () => {
      expect(() => parseCron('*/abc * * * *')).toThrow(/Invalid cron step/);
    });
  });
});
