/**
 * ProjectTimeline — normalisation, windowing and export.
 *
 * The six sources hand back six different record shapes with three different
 * ways of spelling a timestamp, and the records are frequently incomplete: a
 * run that is still going has no `finishedAt`, a session that has not been
 * titled yet has neither `customTitle` nor `aiTitle`, and time tracking can
 * hold a truncated entry after a crash. Those are the cases worth pinning down,
 * because each of them would otherwise put an event at epoch 0 or render an
 * `undefined` into the UI.
 */

const Timeline = require('../../src/renderer/services/ProjectTimeline');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Fixed clock, so "today"/"yesterday" and the window never depend on the wall. */
const NOW = new Date('2026-09-09T15:00:00.000Z').getTime();

describe('toEpoch', () => {
  test('accepts the three spellings the sources use', () => {
    expect(Timeline.toEpoch('2026-09-09T10:00:00.000Z')).toBe(Date.parse('2026-09-09T10:00:00.000Z'));
    expect(Timeline.toEpoch(1757404800000)).toBe(1757404800000);
    expect(Timeline.toEpoch(new Date(1757404800000))).toBe(1757404800000);
  });

  test('returns null rather than 0 for anything unusable', () => {
    // 0 would be a valid-looking timestamp that sorts to the bottom of every
    // timeline forever, which is exactly the bug this guards.
    for (const bad of [null, undefined, '', 'not a date', NaN, 0, -5, {}]) {
      expect(Timeline.toEpoch(bad)).toBeNull();
    }
  });
});

describe('normalizeCommits', () => {
  test('prefers isoDate, falls back to date, drops the undatable', () => {
    const events = Timeline.normalizeCommits([
      { hash: 'abc1234', fullHash: 'abc1234def', message: 'feat: a\n\nbody', author: 'Yanis', isoDate: '2026-09-09T09:00:00Z', date: 'garbage' },
      { hash: 'def5678', message: 'fix: b', author: 'Yanis', date: '2026-09-08T09:00:00Z' },
      { hash: 'nope', message: 'no date at all' },
    ]);

    expect(events).toHaveLength(2);
    expect(events[0].ts).toBe(Date.parse('2026-09-09T09:00:00Z'));
    // Only the subject line: a commit body would blow the row height apart.
    expect(events[0].title).toBe('feat: a');
    expect(events[0].subtitle).toBe('Yanis · abc1234');
    expect(events[0].ref.hash).toBe('abc1234def');
  });

  test('survives a non-array and an empty message', () => {
    expect(Timeline.normalizeCommits(null)).toEqual([]);
    expect(Timeline.normalizeCommits(undefined)).toEqual([]);
    const [e] = Timeline.normalizeCommits([{ isoDate: '2026-09-09T09:00:00Z' }]);
    expect(e.title).toBe('(no message)');
  });
});

describe('normalizeSessions', () => {
  test('title falls back user → model → summary → first prompt', () => {
    const base = { modified: '2026-09-09T09:00:00Z' };
    const title = (extra) => Timeline.normalizeSessions([{ ...base, ...extra }])[0].title;

    expect(title({ customTitle: 'mine', aiTitle: 'theirs', firstPrompt: 'p' })).toBe('mine');
    expect(title({ aiTitle: 'theirs', firstPrompt: 'p' })).toBe('theirs');
    expect(title({ summary: 'sum', firstPrompt: 'p' })).toBe('sum');
    expect(title({ firstPrompt: 'p' })).toBe('p');
  });

  test('an untitled session still gets a readable label', () => {
    const [e] = Timeline.normalizeSessions([{ modified: '2026-09-09T09:00:00Z', sessionId: 's1' }]);
    expect(e.title).toBeTruthy();
    expect(e.title).not.toContain('undefined');
    expect(e.ref.sessionId).toBe('s1');
  });

  test('a very long first prompt is truncated', () => {
    const [e] = Timeline.normalizeSessions([
      { modified: '2026-09-09T09:00:00Z', firstPrompt: 'x'.repeat(500) },
    ]);
    expect(e.title.length).toBeLessThanOrEqual(160);
  });
});

describe('normalizeTimeSessions', () => {
  test('places the block at its end, not its start', () => {
    const [e] = Timeline.normalizeTimeSessions([{
      startTime: '2026-09-09T08:00:00Z',
      endTime: '2026-09-09T10:00:00Z',
      duration: 2 * HOUR,
    }]);
    expect(e.ts).toBe(Date.parse('2026-09-09T10:00:00Z'));
  });

  test('drops entries a crash left without a usable duration', () => {
    expect(Timeline.normalizeTimeSessions([
      { startTime: '2026-09-09T08:00:00Z', endTime: '2026-09-09T10:00:00Z', duration: 0 },
      { startTime: '2026-09-09T08:00:00Z', endTime: '2026-09-09T10:00:00Z', duration: -1 },
      { startTime: '2026-09-09T08:00:00Z', endTime: '2026-09-09T10:00:00Z' },
      { startTime: '2026-09-09T08:00:00Z', duration: HOUR },
    ])).toEqual([]);
  });
});

describe('normalizeWorkflowRuns', () => {
  const runs = [
    { id: 'r1', workflowName: 'nightly', projectPath: '/home/y/proj', status: 'success', startedAt: NOW - 2 * HOUR, finishedAt: NOW - HOUR, duration: HOUR, trigger: 'cron' },
    { id: 'r2', workflowName: 'other', projectPath: '/home/y/elsewhere', status: 'success', finishedAt: NOW },
    { id: 'r3', workflowName: 'live', projectPath: '/home/y/proj', status: 'running', startedAt: NOW - 60000 },
  ];

  test('keeps only the runs belonging to this project', () => {
    const events = Timeline.normalizeWorkflowRuns(runs, '/home/y/proj');
    expect(events.map(e => e.ref.runId).sort()).toEqual(['r1', 'r3']);
  });

  test('matches the path regardless of trailing slash or case', () => {
    expect(Timeline.normalizeWorkflowRuns(runs, '/home/y/proj/')).toHaveLength(2);
    expect(Timeline.normalizeWorkflowRuns(runs, '/HOME/Y/PROJ')).toHaveLength(2);
  });

  test('an unfinished run is placed at its start rather than dropped', () => {
    const [live] = Timeline.normalizeWorkflowRuns([runs[2]], '/home/y/proj');
    expect(live.ts).toBe(NOW - 60000);
    expect(live.tone).toBe('warning');
  });

  test('outcome drives the tone', () => {
    const tone = (status) => Timeline.normalizeWorkflowRuns(
      [{ id: 'x', projectPath: '/p', status, finishedAt: NOW }], '/p'
    )[0].tone;
    expect(tone('success')).toBe('success');
    expect(tone('failed')).toBe('danger');
    expect(tone('cancelled')).toBe('muted');
  });

  test('without a project path nothing is attributed', () => {
    expect(Timeline.normalizeWorkflowRuns(runs, '')).toEqual([]);
    expect(Timeline.normalizeWorkflowRuns(runs, null)).toEqual([]);
  });
});

describe('normalizeParallelRuns', () => {
  test('a merged run reads as a success', () => {
    const [e] = Timeline.normalizeParallelRuns([
      { id: 'p1', goal: 'split the panel', phase: 'merged', startedAt: NOW - DAY, endedAt: NOW - HOUR, mainBranch: 'main', tasks: [1, 2, 3] },
    ]);
    expect(e.tone).toBe('success');
    expect(e.title).toBe('split the panel');
    expect(e.subtitle).toContain('main');
  });

  test('a run still going is placed at its start', () => {
    const [e] = Timeline.normalizeParallelRuns([{ id: 'p2', phase: 'running', startedAt: NOW - HOUR }]);
    expect(e.ts).toBe(NOW - HOUR);
  });
});

describe('normalizeArtifacts', () => {
  test('drops artifacts with no creation date', () => {
    const events = Timeline.normalizeArtifacts([
      { id: 'a1', title: 'Report', createdAt: '2026-09-09T09:00:00Z', kind: 'html' },
      { id: 'a2', title: 'Orphan' },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].ref.artifactId).toBe('a1');
  });
});

describe('groupByDay', () => {
  const ev = (ts, kind = 'commit') => ({ ts, kind, title: String(ts) });

  test('groups by local day, newest first', () => {
    const groups = Timeline.groupByDay(
      [ev(NOW - 2 * DAY), ev(NOW - HOUR), ev(NOW - 2 * HOUR), ev(NOW - 2 * DAY - HOUR)],
      { now: NOW }
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].events).toHaveLength(2);
    expect(groups[0].events[0].ts).toBeGreaterThan(groups[0].events[1].ts);
    expect(groups[0].ts).toBeGreaterThan(groups[1].ts);
  });

  test('drops anything outside the window', () => {
    const groups = Timeline.groupByDay(
      [ev(NOW - 40 * DAY), ev(NOW - HOUR)],
      { days: 14, now: NOW }
    );
    expect(groups).toHaveLength(1);
  });

  test('drops events dated in the future', () => {
    // A commit with a skewed committer date should not open a day above today.
    const groups = Timeline.groupByDay([ev(NOW + 5 * DAY), ev(NOW - HOUR)], { now: NOW });
    expect(groups).toHaveLength(1);
    expect(groups[0].events).toHaveLength(1);
  });

  test('ignores malformed events instead of throwing', () => {
    expect(() => Timeline.groupByDay([null, undefined, {}, { ts: 'x' }], { now: NOW })).not.toThrow();
    expect(Timeline.groupByDay([null, {}, { ts: NaN }], { now: NOW })).toEqual([]);
    expect(Timeline.groupByDay(null, { now: NOW })).toEqual([]);
  });

  test('same-millisecond events tie-break by source order, not at random', () => {
    const ts = NOW - HOUR;
    const groups = Timeline.groupByDay(
      [{ ts, kind: 'artifact', title: 'a' }, { ts, kind: 'commit', title: 'c' }],
      { now: NOW }
    );
    expect(groups[0].events.map(e => e.kind)).toEqual(['commit', 'artifact']);
  });
});

describe('countByKind', () => {
  test('reports every source, including the empty ones', () => {
    const counts = Timeline.countByKind([{ kind: 'commit' }, { kind: 'commit' }, { kind: 'session' }]);
    expect(counts.commit).toBe(2);
    expect(counts.session).toBe(1);
    // The chips need a zero rather than an absent key, so they can render disabled.
    for (const kind of Timeline.KINDS) expect(counts[kind]).toBeGreaterThanOrEqual(0);
  });

  test('ignores an unknown kind rather than inventing a bucket', () => {
    const counts = Timeline.countByKind([{ kind: 'wat' }, null]);
    expect(counts.wat).toBeUndefined();
    expect(Object.values(counts).every(n => n === 0)).toBe(true);
  });
});

describe('dayLabel', () => {
  test('today and yesterday are day comparisons, not 24h windows', () => {
    const lateYesterday = new Date('2026-09-08T23:30:00').getTime();
    const earlyToday = new Date('2026-09-09T00:30:00').getTime();
    const now = new Date('2026-09-09T15:00:00').getTime();

    expect(Timeline.dayLabel(earlyToday, now)).toBe(Timeline.dayLabel(now, now));
    expect(Timeline.dayLabel(lateYesterday, now)).not.toBe(Timeline.dayLabel(now, now));
    // ...and both resolve to a real label, not a dot-path from a missing key.
    expect(Timeline.dayLabel(lateYesterday, now)).not.toContain('timeline.');
  });

  test('older days fall back to a formatted date', () => {
    const label = Timeline.dayLabel(new Date('2026-08-01T10:00:00').getTime(), NOW);
    expect(label).not.toContain('timeline.');
    expect(label.length).toBeGreaterThan(3);
  });
});

describe('toMarkdown', () => {
  test('renders one heading per day and one bullet per event', () => {
    const groups = Timeline.groupByDay([
      { ts: NOW - HOUR, kind: 'commit', title: 'feat: x', subtitle: 'Yanis · abc1234' },
      { ts: NOW - 2 * HOUR, kind: 'session', title: 'refactor' },
      { ts: NOW - DAY, kind: 'workflow', title: 'nightly', subtitle: 'succeeded' },
    ], { now: NOW });

    const md = Timeline.toMarkdown(groups, { name: 'claude-terminal' });

    expect(md).toContain('# claude-terminal');
    expect(md.match(/^## /gm)).toHaveLength(2);
    expect(md.match(/^- /gm)).toHaveLength(3);
    expect(md).toContain('feat: x');
    expect(md).toContain('Yanis · abc1234');
    // An event without a subtitle must not trail an empty separator.
    expect(md).not.toContain('refactor —');
  });

  test('says so when there is nothing, rather than emitting an empty document', () => {
    const md = Timeline.toMarkdown([], { name: 'empty' });
    expect(md).toContain('# empty');
    expect(md.match(/^- /gm)).toBeNull();
  });

  test('tolerates a project with no name', () => {
    expect(() => Timeline.toMarkdown([], {})).not.toThrow();
    expect(() => Timeline.toMarkdown([], null)).not.toThrow();
  });
});

describe('labels', () => {
  test('every known status and kind resolves to a real string', () => {
    const statuses = [
      'success', 'failed', 'running', 'pending', 'cancelled', 'skipped', 'timeout',
      'interrupted', 'done', 'merged', 'merging', 'decomposing', 'reviewing',
    ];
    for (const s of statuses) {
      expect(Timeline.statusLabel(s)).not.toContain('timeline.status.');
    }
    for (const k of Timeline.KINDS) {
      expect(Timeline.kindLabel(k)).not.toContain('timeline.kind.');
    }
  });

  test('an unknown value degrades to itself, never to a dot-path', () => {
    expect(Timeline.statusLabel('quantum')).toBe('quantum');
    expect(Timeline.kindLabel('quantum')).toBe('quantum');
    expect(Timeline.statusLabel(undefined)).toBe('');
    expect(Timeline.kindLabel(undefined)).toBe('');
  });
});
