const { formatDuration } = require('../../src/main/utils/formatDuration');

describe('formatDuration (main process)', () => {
  describe('edge cases', () => {
    test('0ms returns "0m"', () => {
      expect(formatDuration(0)).toBe('0m');
    });

    test('negative value returns "0m"', () => {
      expect(formatDuration(-5000)).toBe('0m');
    });

    test('null returns "0m"', () => {
      expect(formatDuration(null)).toBe('0m');
    });

    test('undefined returns "0m"', () => {
      expect(formatDuration(undefined)).toBe('0m');
    });

    test('NaN returns "0m"', () => {
      expect(formatDuration(NaN)).toBe('0m');
    });

    test('false returns "0m"', () => {
      expect(formatDuration(false)).toBe('0m');
    });

    test('empty string returns "0m"', () => {
      expect(formatDuration('')).toBe('0m');
    });
  });

  describe('minutes only', () => {
    test('30s (30000ms) returns "0m"', () => {
      expect(formatDuration(30000)).toBe('0m');
    });

    test('1 minute (60000ms) returns "1m"', () => {
      expect(formatDuration(60000)).toBe('1m');
    });

    test('5 minutes (300000ms) returns "5m"', () => {
      expect(formatDuration(300000)).toBe('5m');
    });

    test('59 minutes (3540000ms) returns "59m"', () => {
      expect(formatDuration(3540000)).toBe('59m');
    });

    test('59m59s returns "59m"', () => {
      expect(formatDuration(3599000)).toBe('59m');
    });
  });

  describe('hours and minutes', () => {
    test('1 hour exact (3600000ms) returns "1h"', () => {
      expect(formatDuration(3600000)).toBe('1h');
    });

    test('1h 1m returns "1h 1m"', () => {
      expect(formatDuration(3660000)).toBe('1h 1m');
    });

    test('1h 30m (5400000ms) returns "1h 30m"', () => {
      expect(formatDuration(5400000)).toBe('1h 30m');
    });

    test('2h exact returns "2h"', () => {
      expect(formatDuration(7200000)).toBe('2h');
    });

    test('2h 5m returns "2h 5m"', () => {
      expect(formatDuration(7500000)).toBe('2h 5m');
    });

    test('10h 45m returns "10h 45m"', () => {
      expect(formatDuration(38700000)).toBe('10h 45m');
    });

    test('23h 59m returns "23h 59m"', () => {
      expect(formatDuration(86340000)).toBe('23h 59m');
    });
  });

  describe('large values', () => {
    test('24h exact returns "24h"', () => {
      expect(formatDuration(86400000)).toBe('24h');
    });

    test('100h returns "100h"', () => {
      expect(formatDuration(360000000)).toBe('100h');
    });

    test('999h returns "999h"', () => {
      expect(formatDuration(3596400000)).toBe('999h');
    });

    test('999h 59m returns "999h 59m"', () => {
      expect(formatDuration(3599940000)).toBe('999h 59m');
    });
  });

  describe('seconds are truncated', () => {
    test('1m 30s returns "1m" (seconds dropped)', () => {
      expect(formatDuration(90000)).toBe('1m');
    });

    test('1h 0m 45s returns "1h" (seconds dropped)', () => {
      expect(formatDuration(3645000)).toBe('1h');
    });
  });
});
