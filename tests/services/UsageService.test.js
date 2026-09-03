/**
 * Guards the usage bucket parsing.
 *
 * The titlebar used to read one fixed key per limit — `five_hour`, `seven_day`,
 * `seven_day_sonnet`. The per-model key went null when the scoped weekly limit
 * moved off Sonnet, and nothing caught it: the bar simply showed "Sonnet --%"
 * against an empty gauge for as long as it took someone to notice. These tests
 * pin the shape we read now, so the next model rename is a data change rather
 * than a silent blank bar.
 */

const { readBuckets } = require('../../src/main/services/UsageService');

/** A response captured from /api/oauth/usage, trimmed to the fields we read. */
const LIVE_RESPONSE = {
  five_hour: { utilization: 16.0, resets_at: '2026-09-03T11:50:00Z' },
  seven_day: { utilization: 6.0, resets_at: '2026-09-08T00:00:00Z' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  nimbus_quill: { utilization: 0.0, resets_at: null },
  limits: [
    {
      kind: 'session', group: 'session', percent: 16, severity: 'normal',
      resets_at: '2026-09-03T11:50:00Z', scope: null, is_active: true
    },
    {
      kind: 'weekly_all', group: 'weekly', percent: 6, severity: 'normal',
      resets_at: '2026-09-08T00:00:00Z', scope: null, is_active: false
    },
    {
      kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal',
      resets_at: null, scope: { model: { id: null, display_name: 'Fable' } }, is_active: false
    }
  ]
};

describe('readBuckets', () => {
  test('reads the three buckets a live response describes', () => {
    expect(readBuckets(LIVE_RESPONSE)).toEqual([
      { id: 'session', type: 'session', label: null, labelKey: 'ui.session', utilization: 16, resetsAt: '2026-09-03T11:50:00Z' },
      { id: 'weekly', type: 'weekly', label: null, labelKey: 'ui.weekly', utilization: 6, resetsAt: '2026-09-08T00:00:00Z' },
      { id: 'scoped:Fable', type: 'scoped', label: 'Fable', labelKey: null, utilization: 0, resetsAt: null }
    ]);
  });

  test('takes the scoped label from the API, not from a hardcoded model name', () => {
    const renamed = {
      ...LIVE_RESPONSE,
      limits: [{ kind: 'weekly_scoped', percent: 42, resets_at: null, scope: { model: { display_name: 'Mythos' } } }]
    };
    expect(readBuckets(renamed)).toEqual([
      { id: 'scoped:Mythos', type: 'scoped', label: 'Mythos', labelKey: null, utilization: 42, resetsAt: null }
    ]);
  });

  test('renders every scoped limit when a plan exposes more than one', () => {
    const twoModels = {
      ...LIVE_RESPONSE,
      limits: [
        { kind: 'weekly_scoped', percent: 10, resets_at: null, scope: { model: { display_name: 'Fable' } } },
        { kind: 'weekly_scoped', percent: 20, resets_at: null, scope: { model: { display_name: 'Opus' } } }
      ]
    };
    expect(readBuckets(twoModels).map(b => b.label)).toEqual(['Fable', 'Opus']);
  });

  test('keeps only the plan-wide buckets when a plan has no scoped limit', () => {
    const noScope = { ...LIVE_RESPONSE, limits: LIVE_RESPONSE.limits.slice(0, 2) };
    expect(readBuckets(noScope).map(b => b.id)).toEqual(['session', 'weekly']);
  });

  test('drops a scoped limit the server did not name rather than showing a blank bar', () => {
    const unnamed = {
      ...LIVE_RESPONSE,
      limits: [...LIVE_RESPONSE.limits.slice(0, 2), { kind: 'weekly_scoped', percent: 5, scope: null }]
    };
    expect(readBuckets(unnamed).map(b => b.id)).toEqual(['session', 'weekly']);
  });

  test('ignores a limit with no percent instead of rendering NaN', () => {
    const broken = { limits: [{ kind: 'session', resets_at: null, scope: null }] , five_hour: null, seven_day: null };
    expect(readBuckets(broken)).toEqual([]);
  });

  test('falls back to the legacy keys when the response has no limits array', () => {
    const legacy = {
      five_hour: { utilization: 30, resets_at: '2026-09-03T11:50:00Z' },
      seven_day: { utilization: 12, resets_at: '2026-09-08T00:00:00Z' }
    };
    expect(readBuckets(legacy).map(b => ({ id: b.id, utilization: b.utilization })))
      .toEqual([{ id: 'session', utilization: 30 }, { id: 'weekly', utilization: 12 }]);
  });

  test('falls back rather than blanking the bar when limits is present but unusable', () => {
    const empty = { ...LIVE_RESPONSE, limits: [] };
    expect(readBuckets(empty).map(b => b.id)).toEqual(['session', 'weekly']);
  });

  test('survives an empty or malformed response', () => {
    expect(readBuckets({})).toEqual([]);
    expect(readBuckets(null)).toEqual([]);
    expect(readBuckets({ limits: null })).toEqual([]);
  });
});
