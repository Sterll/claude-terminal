/**
 * The titlebar usage chip, lifted out of renderer.js.
 *
 * renderer.js has no test harness of its own — it is a 7.6k-line script that
 * queries the document at load — so these are the first assertions any of
 * this has had. Both things they pin had already gone wrong once: a severity
 * colour that was added but never removed, and a unit spelling written as
 * `lang === 'fr' ? 'j' : 'd'`.
 */
const {
  createUsageBucketEl,
  updateUsageBar,
  formatResetCountdown,
  updateResetEl,
} = require('../../src/renderer/ui/components/usageChip');

describe('usage chip — bars', () => {
  const bar = () => createUsageBucketEl({ id: 'session', type: 'session', labelKey: 'ui.session' });

  test('a bucket builds a labelled bar wired for i18n', () => {
    const els = bar();
    expect(els.item.dataset.type).toBe('session');
    expect(els.label.dataset.i18n).toBe('ui.session');
    expect(els.percent.textContent).toBe('--');
    expect(els.bar.style.width).toBe('0%');
  });

  test('a reported figure fills the bar and colours by severity', () => {
    const a = bar(); updateUsageBar(a, 42);
    expect(a.percent.textContent).toBe('42%');
    expect(a.bar.style.width).toBe('42%');
    expect(a.bar.className).toBe('usage-bar');

    const b = bar(); updateUsageBar(b, 75);
    expect(b.bar.classList.contains('warning')).toBe(true);

    const c = bar(); updateUsageBar(c, 95);
    expect(c.bar.classList.contains('danger')).toBe(true);
  });

  test('past 100% the figure keeps going but the bar does not', () => {
    const els = bar();
    updateUsageBar(els, 140);
    expect(els.percent.textContent).toBe('140%');
    expect(els.bar.style.width).toBe('100%');
  });

  test('a limit the API did not report reads as unknown, not as zero', () => {
    const els = bar();
    updateUsageBar(els, 80);
    updateUsageBar(els, null);
    expect(els.percent.textContent).toBe('--');
    expect(els.bar.style.width).toBe('0%');
    // The severity colour has to go with it, or a stale red bar sits under "--".
    expect(els.bar.className).toBe('usage-bar');
  });

  test('severity is recomputed, not accumulated', () => {
    const els = bar();
    updateUsageBar(els, 95);
    updateUsageBar(els, 10);
    expect(els.bar.classList.contains('danger')).toBe(false);
    expect(els.bar.classList.contains('warning')).toBe(false);
  });
});

describe('usage chip — reset countdown', () => {
  const h = 3600000;
  const d = 86400000;

  test('drops to the two coarsest units that apply', () => {
    expect(formatResetCountdown(2 * d + 5 * h)).toBe('2d 5h');
    expect(formatResetCountdown(5 * h + 3 * 60000)).toBe('5h 03min');
    expect(formatResetCountdown(41 * 60000)).toBe('41min');
  });

  test('pads the minutes beside an hour so the row does not jitter', () => {
    expect(formatResetCountdown(5 * h + 3 * 60000)).toContain('03min');
  });

  test('an elapsed or missing target shows nothing rather than a negative', () => {
    expect(formatResetCountdown(0)).toBe('');
    expect(formatResetCountdown(-5000)).toBe('');
    expect(formatResetCountdown(NaN)).toBe('');
  });

  test('the units are translated, not an English-or-French conditional', () => {
    // The previous spelling was `lang === 'fr' ? 'j' : 'd'`, so es, id and
    // zh-CN read English letters next to translated labels.
    const i18n = require('../../src/renderer/i18n');
    const spelling = {};
    for (const lang of ['en', 'fr', 'id', 'zh-CN']) {
      i18n.setLanguage(lang);
      spelling[lang] = formatResetCountdown(2 * d + 5 * h);
    }
    i18n.setLanguage('en');

    expect(spelling.en).toBe('2d 5h');
    expect(spelling.fr).toBe('2j 5h');
    expect(spelling['zh-CN']).toBe('2天 5小时');
    expect(spelling.id).not.toBe(spelling.en);
  });

  test('updateResetEl clears the element when there is no target', () => {
    const el = document.createElement('span');
    updateResetEl(el, new Date(Date.now() + 2 * h));
    expect(el.textContent).not.toBe('');
    updateResetEl(el, null);
    expect(el.textContent).toBe('');
    expect(() => updateResetEl(null, null)).not.toThrow();
  });
});
