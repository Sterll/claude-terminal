/**
 * cron.js
 * 5-field cron parsing, shared between main (WorkflowScheduler, IPC validation)
 * and renderer (Tasks view "next run" display).
 *
 * Fields: minute hour dom month dow   —   supports  *  /  ,  -
 * All matching is done against LOCAL time, matching the scheduler's ticker.
 */

'use strict';

/**
 * Compile a cron expression into its five independent field matchers.
 *
 * The matchers are kept separate (rather than folded into one closure) so that
 * nextRunAt() can test day-level fields once per day and skip whole days,
 * instead of walking all 1440 minutes of a day that can never match.
 *
 * @param {string} expr
 * @returns {{ matchMin: Fn, matchHour: Fn, matchDom: Fn, matchMon: Fn, matchDow: Fn }}
 * @throws {Error} on a malformed expression
 */
function compileCron(expr) {
  const fields = String(expr ?? '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron expression: "${expr}"`);
  const [minF, hourF, domF, monF, dowF] = fields;

  const parseField = (field, min, max) => {
    if (field === '*') return () => true;

    const parseStep = (raw) => {
      const step = Number(raw);
      if (!Number.isFinite(step) || !Number.isInteger(step) || step < 1) {
        throw new Error(`Invalid cron step "${raw}" in field "${field}"`);
      }
      return step;
    };

    const parseNum = (raw, label) => {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
        throw new Error(`Invalid cron ${label} "${raw}" in field "${field}" (expected ${min}-${max})`);
      }
      return n;
    };

    const parts = field.split(',');
    const matchers = parts.map(part => {
      // */step   → every `step` starting at `min`
      if (part.startsWith('*/')) {
        const step = parseStep(part.slice(2));
        return (v) => (v - min) % step === 0;
      }
      // a-b/step → range with step
      const rangeStep = part.match(/^(\d+)-(\d+)\/(\d+)$/);
      if (rangeStep) {
        const a    = parseNum(rangeStep[1], 'value');
        const b    = parseNum(rangeStep[2], 'value');
        const step = parseStep(rangeStep[3]);
        if (a > b) throw new Error(`Invalid cron range "${part}" (start > end)`);
        return (v) => v >= a && v <= b && (v - a) % step === 0;
      }
      // range a-b
      if (part.includes('-')) {
        const [rawA, rawB] = part.split('-');
        const a = parseNum(rawA, 'value');
        const b = parseNum(rawB, 'value');
        if (a > b) throw new Error(`Invalid cron range "${part}" (start > end)`);
        return (v) => v >= a && v <= b;
      }
      // exact value
      const n = parseNum(part, 'value');
      return (v) => v === n;
    });
    return (v) => matchers.some(m => m(v));
  };

  return {
    matchMin:  parseField(minF,  0, 59),
    matchHour: parseField(hourF, 0, 23),
    matchDom:  parseField(domF,  1, 31),
    matchMon:  parseField(monF,  1, 12),
    matchDow:  parseField(dowF,  0, 6),   // 0 = Sunday
  };
}

/**
 * Parse a 5-field cron expression into a single matcher function.
 * @param {string} expr
 * @returns {(date: Date) => boolean}
 */
function parseCron(expr) {
  const c = compileCron(expr);
  return (date) =>
    c.matchMin(date.getMinutes())
    && c.matchHour(date.getHours())
    && c.matchDom(date.getDate())
    && c.matchMon(date.getMonth() + 1)
    && c.matchDow(date.getDay());
}

/** Does the calendar day of `date` satisfy the dom/month/dow fields? */
function matchesDay(c, date) {
  return c.matchDom(date.getDate())
    && c.matchMon(date.getMonth() + 1)
    && c.matchDow(date.getDay());
}

/**
 * Compute the next date at which `expr` fires, strictly after `from`.
 *
 * Searches at most one year ahead. Days whose dom/month/dow can never match are
 * skipped wholesale, so the worst case is ~366 day checks plus one day of
 * minute checks — not the 527k minutes a naive scan would take.
 *
 * @param {string} expr
 * @param {Date}   [from=new Date()]
 * @returns {Date|null} null if the expression is invalid or never fires within a year
 */
function nextRunAt(expr, from = new Date()) {
  let c;
  try { c = compileCron(expr); } catch { return null; }

  // Start at the top of the next minute — the scheduler is minute-granular and
  // a match on the current minute has already fired (or been skipped).
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  for (let day = 0; day <= 366; day++) {
    if (matchesDay(c, d)) {
      const dom = d.getDate();
      while (d.getDate() === dom) {
        if (c.matchHour(d.getHours()) && c.matchMin(d.getMinutes())) {
          return new Date(d.getTime());
        }
        d.setMinutes(d.getMinutes() + 1);
      }
      // Fell through to the next day already — don't advance twice.
    } else {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    }
  }
  return null;
}

/** True when `expr` is a well-formed 5-field cron expression. */
function isValidCron(expr) {
  try { compileCron(expr); return true; } catch { return false; }
}

module.exports = { compileCron, parseCron, matchesDay, nextRunAt, isValidCron };
