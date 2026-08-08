'use strict';

/**
 * time node — delegates to getTimeStats() in src/main/ipc/time.ipc.js, which
 * reads ~/.claude-terminal/timetracking.json (v3 shape: sessions only, all
 * counters computed on the fly).
 *
 * time.ipc.js resolves the file path once at module load and memoises the
 * parsed contents for 2 s. Both are correct in the app — one home, one process
 * — but would leak one sandbox's data into the next, so every scenario drops
 * the module from the require cache after seeding.
 */

const path = require('path');
const { assert } = require('../sandbox');

const ROOT     = path.join(__dirname, '..', '..', '..');
const TIME_IPC = path.join(ROOT, 'src', 'main', 'ipc', 'time.ipc.js');

const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;

function forgetTimeIpc() {
  delete require.cache[require.resolve(TIME_IPC)];
}

/** A persisted session, in the exact shape addSession() writes. */
function session(startMs, endMs, source) {
  const s = {
    id:        `sess-${startMs}`,
    startTime: new Date(startMs).toISOString(),
    endTime:   new Date(endMs).toISOString(),
    duration:  endMs - startMs,
  };
  if (source) s.source = source;
  return s;
}

function startOfDayLocal(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * A window that ends now and is guaranteed to sit entirely inside today, so
 * every expected total is exact regardless of the hour the lab runs at.
 */
function todayWindow(now, maxMs = HOUR) {
  return Math.min(maxMs, now - startOfDayLocal(now)) || 1;
}

/** Local YYYY-MM-DD, i.e. the calendar day a timestamp actually falls on. */
function localDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Seed timetracking.json and reset the module cache. */
function seed(sb, data) {
  sb.dataFile('timetracking.json', { version: 3, month: null, global: { sessions: [] }, projects: {}, ...data });
  forgetTimeIpc();
}

module.exports = {
  type: 'time',
  scenarios: [
    {
      name: 'get_today counts only the part of a session that falls inside today',
      async setup(sb) {
        const now  = Date.now();
        const span = todayWindow(now);
        sb.span = span;

        const todaySession = session(now - span, now);
        const oldSession   = session(now - 40 * DAY, now - 40 * DAY + 2 * HOUR);

        seed(sb, {
          global:   { sessions: [oldSession, todaySession] },
          projects: {
            'p-today': { sessions: [todaySession] },
            'p-stale': { sessions: [oldSession] },
          },
        });
      },
      config: () => ({ action: 'get_today' }),
      assert(out, sb) {
        assert.strictEqual(out.today, sb.span, 'a 40-day-old session leaked into today');
        assert.strictEqual(out.week,  sb.span, 'a 40-day-old session leaked into this week');
        assert.strictEqual(out.month, sb.span, 'a 40-day-old session leaked into this month');
        assert.ok(out.todayFormatted && out.weekFormatted && out.monthFormatted,
          'the formatted durations a notification would show are missing');
      },
    },
    {
      name: 'get_today lists only the projects that were worked on today',
      async setup(sb) {
        const now  = Date.now();
        const span = todayWindow(now);
        sb.span = span;
        seed(sb, {
          global:   { sessions: [session(now - span, now)] },
          projects: {
            'p-today': { sessions: [session(now - span, now)] },
            'p-stale': { sessions: [session(now - 40 * DAY, now - 40 * DAY + 2 * HOUR)] },
          },
        });
      },
      config: () => ({ action: 'get_today' }),
      assert(out, sb) {
        assert.strictEqual(out.projects.length, 1, `unexpected projects: ${JSON.stringify(out.projects)}`);
        assert.strictEqual(out.projects[0].id, 'p-today');
        assert.strictEqual(out.projects[0].today, sb.span);
      },
    },
    {
      name: 'get_week returns seven day buckets that add up to the reported total',
      async setup(sb) {
        const now  = Date.now();
        const span = todayWindow(now);
        sb.span = span;
        seed(sb, { global: { sessions: [session(now - span, now)] } });
      },
      config: () => ({ action: 'get_week' }),
      assert(out, sb) {
        assert.strictEqual(out.days.length, 7);
        const summed = out.days.reduce((acc, d) => acc + d.ms, 0);
        assert.strictEqual(summed, out.total, 'the day buckets do not add up to the week total');
        assert.strictEqual(out.total, sb.span);
        assert.ok(out.totalFormatted, 'totalFormatted is missing');
      },
    },
    {
      name: 'get_week labels every bucket with the calendar day it covers',
      async setup(sb) {
        const now = Date.now();
        seed(sb, { global: { sessions: [session(now - todayWindow(now), now)] } });
      },
      config: () => ({ action: 'get_week' }),
      assert(out) {
        const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        for (const day of out.days) {
          // `date` is produced with toISOString(), which is UTC, while the bucket
          // boundaries and `dayOfWeek` are local. East of UTC the two disagree.
          const labelled = new Date(`${day.date}T12:00:00`);
          assert.strictEqual(NAMES[labelled.getDay()], day.dayOfWeek,
            `bucket says ${day.dayOfWeek} but its date ${day.date} is a ${NAMES[labelled.getDay()]}`);
        }
      },
    },
    {
      name: 'get_week uses the same week boundary as the app time tracking',
      async setup(sb) {
        const now = Date.now();
        seed(sb, { global: { sessions: [session(now - todayWindow(now), now)] } });
      },
      config: () => ({ action: 'get_week' }),
      assert(out) {
        // timeTracking.state.js startOfWeek() treats Monday as the first day of
        // the week; a workflow report must cover the same days as the dashboard.
        assert.strictEqual(out.days[0].dayOfWeek, 'Mon',
          `the week starts on ${out.days[0].dayOfWeek} here but on Mon in the app`);
      },
    },
    {
      name: 'get_week places today in the bucket for today',
      async setup(sb) {
        const now = Date.now();
        sb.span  = todayWindow(now);
        sb.today = localDate(now);
        seed(sb, { global: { sessions: [session(now - sb.span, now)] } });
      },
      config: () => ({ action: 'get_week' }),
      assert(out, sb) {
        const worked = out.days.filter(d => d.ms > 0);
        assert.strictEqual(worked.length, 1, `expected exactly one worked day, got ${worked.length}`);
        assert.strictEqual(worked[0].date, sb.today,
          `today's time was filed under ${worked[0].date} instead of ${sb.today}`);
      },
    },
    {
      name: 'get_project reports totals and session count for that project alone',
      async setup(sb) {
        const now  = Date.now();
        const span = todayWindow(now, 2 * HOUR);
        sb.span = span;
        const half = Math.floor(span / 2);
        seed(sb, {
          global: { sessions: [session(now - span, now)] },
          projects: {
            'p-mine':  { sessions: [session(now - span, now - half), session(now - half, now)] },
            'p-other': { sessions: [session(now - span, now)] },
          },
        });
      },
      config: () => ({ action: 'get_project', projectId: 'p-mine' }),
      assert(out, sb) {
        assert.strictEqual(out.id, 'p-mine');
        assert.strictEqual(out.sessionCount, 2);
        assert.strictEqual(out.today, sb.span, 'another project\'s time was counted');
        assert.strictEqual(out.total, sb.span);
        assert.ok(out.todayFormatted && out.totalFormatted);
      },
    },
    {
      name: 'get_project resolves a $variable projectId',
      async setup(sb) {
        const now  = Date.now();
        const span = todayWindow(now);
        sb.span = span;
        sb.vars.set('target', 'p-mine');
        seed(sb, { projects: { 'p-mine': { sessions: [session(now - span, now)] } } });
      },
      config: () => ({ action: 'get_project', projectId: '$target' }),
      assert(out, sb) {
        assert.strictEqual(out.id, 'p-mine', 'the $target variable was not resolved');
        assert.strictEqual(out.today, sb.span);
      },
    },
    {
      name: 'get_project for a project with no tracked time returns zeros, not an error',
      async setup(sb) { seed(sb, {}); },
      config: () => ({ action: 'get_project', projectId: 'never-opened' }),
      assert(out) {
        assert.strictEqual(out.id, 'never-opened');
        assert.strictEqual(out.today, 0);
        assert.strictEqual(out.total, 0);
        assert.strictEqual(out.sessionCount, 0);
      },
    },
    {
      name: 'get_project without a projectId rejects instead of reporting zero',
      async setup(sb) { seed(sb, {}); },
      config: () => ({ action: 'get_project' }),
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /requires a projectId/i);
      },
    },
    {
      name: 'an unrecognised action rejects instead of quietly returning today',
      async setup(sb) { seed(sb, {}); },
      config: () => ({ action: 'get_yesterday' }),
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /unknown time action/i);
      },
    },
    {
      name: 'a machine that has never tracked time reports zeros rather than failing',
      // No timetracking.json at all.
      async setup() { forgetTimeIpc(); },
      config: () => ({ action: 'get_today' }),
      assert(out) {
        assert.strictEqual(out.today, 0);
        assert.strictEqual(out.week, 0);
        assert.strictEqual(out.month, 0);
        assert.deepStrictEqual(out.projects, []);
      },
    },
  ],
};
