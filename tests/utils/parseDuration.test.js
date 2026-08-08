/**
 * Duration parsing, shared by the `wait` node and by WorkflowRunner's retry
 * delays and step/workflow timeouts.
 *
 * Both used to keep their own copy and both carried the same two silent
 * failures, which is why this now lives in one place with one test.
 */

jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/data' },
}), { virtual: true });

const { parseDuration, DEFAULT_DURATION_MS } = require('../../src/main/workflow-nodes/_registry');

describe('parseDuration', () => {
  it('reads each unit suffix', () => {
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('2m')).toBe(120_000);
    expect(parseDuration('1h')).toBe(3_600_000);
  });

  it('treats a bare number as milliseconds', () => {
    expect(parseDuration('1500')).toBe(1500);
  });

  it('accepts a number as-is', () => {
    expect(parseDuration(750)).toBe(750);
  });

  it('accepts fractional values', () => {
    expect(parseDuration('0.5s')).toBe(500);
    expect(parseDuration('1.5m')).toBe(90_000);
  });

  // ── The two regressions this function exists to prevent ────────────────────

  it('tolerates a space between value and unit', () => {
    // The old pattern required the unit to touch the number, so this fell
    // through to parseInt and became 5 MILLISECONDS instead of 5 seconds — a
    // step timeout that fired instantly.
    expect(parseDuration('5 s')).toBe(5000);
    expect(parseDuration('2 m')).toBe(120_000);
    expect(parseDuration('  10s  ')).toBe(10_000);
  });

  it('treats an explicit zero as zero, not as unset', () => {
    // `parseInt('0', 10) || 60_000` returned the fallback because 0 is falsy,
    // turning "wait 0" into a one-minute stall.
    expect(parseDuration('0')).toBe(0);
    expect(parseDuration('0ms')).toBe(0);
    expect(parseDuration('0s')).toBe(0);
    expect(parseDuration(0)).toBe(0);
  });

  // ── Failure handling ───────────────────────────────────────────────────────

  it('falls back on unparseable input rather than guessing', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseDuration('quickly')).toBe(DEFAULT_DURATION_MS);
    expect(parseDuration('')).toBe(DEFAULT_DURATION_MS);
    expect(parseDuration('5 seconds')).toBe(DEFAULT_DURATION_MS);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('says which caller could not parse the value', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    parseDuration('nope', 'wait.node');
    expect(warn.mock.calls[0][0]).toMatch(/\[wait\.node\]/);
    warn.mockRestore();
  });

  it('falls back for non-string, non-number input', () => {
    expect(parseDuration(null)).toBe(DEFAULT_DURATION_MS);
    expect(parseDuration(undefined)).toBe(DEFAULT_DURATION_MS);
    expect(parseDuration({})).toBe(DEFAULT_DURATION_MS);
  });

  it('never returns a negative duration', () => {
    expect(parseDuration(-500)).toBe(0);
  });

  it('is case-insensitive about units', () => {
    expect(parseDuration('30S')).toBe(30_000);
    expect(parseDuration('250MS')).toBe(250);
  });
});

describe('the two consumers agree', () => {
  it('WorkflowRunner.parseMs delegates to the shared parser', () => {
    // Extracted from source: parseMs is module-private, and the point of this
    // check is that it is a delegation rather than a fourth copy.
    const fs  = require('fs');
    const src = fs.readFileSync(
      require.resolve('../../src/main/services/WorkflowRunner'), 'utf8');
    const body = src.match(/function parseMs\(value\) \{([\s\S]*?)\n\}/);
    expect(body).not.toBeNull();
    expect(body[1]).toMatch(/parseDuration/);
    expect(body[1]).not.toMatch(/parseInt/);
  });

  it('the wait node delegates to the shared parser', () => {
    const fs  = require('fs');
    const src = fs.readFileSync(
      require.resolve('../../src/main/workflow-nodes/wait.node'), 'utf8');
    expect(src).toMatch(/parseDuration/);
    expect(src).not.toMatch(/parseInt\(value/);
  });
});
