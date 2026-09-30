/**
 * Which account can take a conversation over, and the bars that say so.
 *
 * blockingLimit() is what greys an account out in the switch offer a usage
 * limit opens. Getting it wrong either way costs the user: too eager, and an
 * account with room left cannot be picked; too lax, and the switch lands on
 * an account that is spent too, which is the blind switch this replaced.
 */
const {
  blockingLimit,
  buildAccountUsageHtml,
  buildUsageBucketHtml,
  formatBucketReset,
} = require('../../src/renderer/ui/components/accountUsage');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const h = 3600000;
const at = (ms) => new Date(NOW + ms).toISOString();

const session = (utilization, resetsAt = at(2 * h)) =>
  ({ id: 'session', type: 'session', label: null, labelKey: 'ui.session', utilization, resetsAt });
const weekly = (utilization, resetsAt = at(72 * h)) =>
  ({ id: 'weekly', type: 'weekly', label: null, labelKey: 'ui.weekly', utilization, resetsAt });
const scoped = (label, utilization, resetsAt = at(48 * h)) =>
  ({ id: `scoped:${label}`, type: 'scoped', label, labelKey: null, utilization, resetsAt });
const usage = (...buckets) => ({ accountId: 'acc', data: { buckets }, stale: false, error: null });

describe('blockingLimit', () => {
  test('a full plan-wide window rules the account out, whatever the model', () => {
    expect(blockingLimit(usage(session(100), weekly(40)), { now: NOW })).toMatchObject({ id: 'session' });
    expect(blockingLimit(usage(session(10), weekly(100)), { model: 'claude-sonnet-5', now: NOW }))
      .toMatchObject({ id: 'weekly' });
  });

  test('room left in every window blocks nothing', () => {
    expect(blockingLimit(usage(session(64), weekly(88)), { now: NOW })).toBeNull();
  });

  test('"full" is the figure as displayed, so a row reading 100% cannot be picked', () => {
    expect(blockingLimit(usage(session(99.4)), { now: NOW })).toBeNull();
    expect(blockingLimit(usage(session(99.6)), { now: NOW })).toMatchObject({ id: 'session' });
    expect(blockingLimit(usage(session(104)), { now: NOW })).toMatchObject({ id: 'session' });
  });

  test('a window whose reset has passed has started over', () => {
    expect(blockingLimit(usage(session(100, at(-5 * 60000))), { now: NOW })).toBeNull();
  });

  test('a full window with no reset time still blocks', () => {
    expect(blockingLimit(usage(session(100, null)), { now: NOW })).toMatchObject({ id: 'session' });
  });

  test('a model-scoped limit only applies to a conversation on that model', () => {
    const u = usage(session(20), weekly(30), scoped('Fable', 100));
    expect(blockingLimit(u, { model: 'claude-fable-5-1', now: NOW })).toMatchObject({ id: 'scoped:Fable' });
    expect(blockingLimit(u, { model: 'claude-sonnet-5', now: NOW })).toBeNull();
    // Nothing says it applies without a model.
    expect(blockingLimit(u, { now: NOW })).toBeNull();
  });

  test('the API naming the model with its version still matches the family', () => {
    const u = usage(scoped('Fable 5.1', 100));
    expect(blockingLimit(u, { model: 'claude-fable-5-1[1m]', now: NOW })).toMatchObject({ type: 'scoped' });
  });

  test('with several full limits, the one freeing up last is when the account is back', () => {
    const u = usage(session(100, at(2 * h)), weekly(100, at(30 * h)));
    expect(blockingLimit(u, { now: NOW })).toMatchObject({ id: 'weekly' });
  });

  test('stale figures still count: usage only rises until the reset', () => {
    const u = { ...usage(session(100)), stale: true };
    expect(blockingLimit(u, { now: NOW })).toMatchObject({ id: 'session' });
  });

  test('figures that could not be read block nothing: unknown is not spent', () => {
    expect(blockingLimit(undefined, { now: NOW })).toBeNull();
    expect(blockingLimit({ accountId: 'acc', data: null, stale: true, error: 'HTTP 401' }, { now: NOW })).toBeNull();
  });
});

describe('account usage strip', () => {
  const html = (s) => {
    const el = document.createElement('div');
    el.innerHTML = s;
    return el;
  };

  test('while the figures load it says so', () => {
    expect(html(buildAccountUsageHtml(null)).textContent).toContain('Reading usage');
  });

  test('an account with no figures says what to do rather than drawing empty bars', () => {
    const el = html(buildAccountUsageHtml({ data: null, error: 'no token' }));
    expect(el.querySelector('.usage-item')).toBeNull();
    expect(el.querySelector('.account-usage-note').getAttribute('title')).toBe('no token');
  });

  test('one bar per bucket, with the severity tint and a scoped label kept as data', () => {
    const el = html(buildAccountUsageHtml(usage(session(100), weekly(72), scoped('<b>Fable</b>', 12))));
    const items = el.querySelectorAll('.usage-item');
    expect([...items].map(i => i.dataset.type)).toEqual(['session', 'weekly', 'scoped']);
    expect(items[0].querySelector('.usage-bar').classList.contains('danger')).toBe(true);
    expect(items[1].querySelector('.usage-bar').classList.contains('warning')).toBe(true);
    expect(items[2].querySelector('.usage-label').textContent).toBe('<b>Fable</b>');
    expect(items[2].querySelector('b')).toBeNull();
  });

  test('figures the API could not confirm are marked stale', () => {
    const el = html(buildAccountUsageHtml({ ...usage(session(10)), stale: true }));
    expect(el.querySelector('.account-usage-bars').classList.contains('stale')).toBe(true);
  });

  test('the reset countdown is spelled in the UI language, not English-or-French', () => {
    // Settings' own copy of this was `lang === 'fr' ? 'j' : 'd'`.
    const i18n = require('../../src/renderer/i18n');
    const bucket = session(50, at(2 * 24 * h + 5 * h));
    const spelling = {};
    for (const lang of ['en', 'fr', 'zh-CN']) {
      i18n.setLanguage(lang);
      spelling[lang] = formatBucketReset(bucket, NOW);
    }
    i18n.setLanguage('en');
    expect(spelling).toEqual({ en: '2d 5h', fr: '2j 5h', 'zh-CN': '2天 5小时' });
  });

  test('a passed or missing reset shows no countdown', () => {
    expect(formatBucketReset(session(50, at(-h)), NOW)).toBe('');
    expect(formatBucketReset(session(50, null), NOW)).toBe('');
    expect(html(buildUsageBucketHtml(session(50, null), NOW)).querySelector('.usage-reset').textContent).toBe('');
  });
});
