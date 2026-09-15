/**
 * The titlebar usage chip's pieces: one bar per limit, and the countdown to
 * the next reset.
 *
 * Only the parts that do not need the chip's own mutable state live here —
 * building a bar, painting a percentage into one, spelling a countdown. The
 * reconciliation against a bucket list and the interval that drives the
 * countdown stay in renderer.js, which owns the elements.
 *
 * The countdown is deliberately terse, because it shares a line with the bar
 * it belongs to: "2d 5h", then "5h 03min", then "41min". Its units come from
 * i18n rather than a conditional, which is the whole reason it is here — the
 * previous spelling was `lang === 'fr' ? 'j' : 'd'`, so Spanish, Indonesian
 * and Chinese users read English unit letters next to translated labels.
 */

const { t } = require('../../i18n');

/** The elements one usage bar is made of, ready to be appended. */
function createUsageBucketEl(bucket) {
  const item = document.createElement('div');
  item.className = 'usage-item';
  item.dataset.type = bucket.type;

  const header = document.createElement('div');
  header.className = 'usage-header';

  const label = document.createElement('span');
  label.className = 'usage-label';
  if (bucket.labelKey) label.dataset.i18n = bucket.labelKey;

  const value = document.createElement('span');
  value.className = 'usage-value';
  const percent = document.createElement('span');
  percent.className = 'usage-percent';
  percent.textContent = '--';
  const reset = document.createElement('span');
  reset.className = 'usage-reset';
  value.append(percent, reset);

  header.append(label, value);

  const barContainer = document.createElement('div');
  barContainer.className = 'usage-bar-container';
  const bar = document.createElement('div');
  bar.className = 'usage-bar';
  bar.style.width = '0%';
  barContainer.appendChild(bar);

  item.append(header, barContainer);
  return { item, label, bar, percent, reset };
}

/**
 * Paint a utilisation figure into a bar.
 *
 * `null` means the API did not report this limit, which is not the same as
 * zero and must not read as an empty bar with a confident "0%".
 */
function updateUsageBar(elements, percent) {
  if (!elements.bar || !elements.percent) return;

  if (percent === null || percent === undefined) {
    elements.percent.textContent = '--';
    elements.bar.style.width = '0%';
    elements.bar.classList.remove('warning', 'danger');
    return;
  }

  const roundedPercent = Math.round(percent);
  elements.percent.textContent = `${roundedPercent}%`;
  // The bar is clamped but the figure is not: past 100% the number is the
  // interesting part, and a bar wider than its container would break the row.
  elements.bar.style.width = `${Math.min(roundedPercent, 100)}%`;

  elements.bar.classList.remove('warning', 'danger');
  if (roundedPercent >= 90) {
    elements.bar.classList.add('danger');
  } else if (roundedPercent >= 70) {
    elements.bar.classList.add('warning');
  }
}

/**
 * "2d 5h" / "5h 03min" / "41min", or '' when there is nothing to count down to.
 *
 * @param {number} remainingMs
 * @returns {string}
 */
function formatResetCountdown(remainingMs) {
  if (!(remainingMs > 0)) return '';
  const d = Math.floor(remainingMs / 86400000);
  const h = Math.floor((remainingMs % 86400000) / 3600000);
  const m = Math.floor((remainingMs % 3600000) / 60000);

  const dU = t('time.unitDayShort');
  const hU = t('time.unitHourShort');
  const mU = t('time.unitMinuteShort');

  if (d > 0) return `${d}${dU} ${h}${hU}`;
  if (h > 0) return `${h}${hU} ${String(m).padStart(2, '0')}${mU}`;
  return `${m}${mU}`;
}

/** @param {HTMLElement} el @param {Date|null} target */
function updateResetEl(el, target) {
  if (!el) return;
  el.textContent = target ? formatResetCountdown(target.getTime() - Date.now()) : '';
}

module.exports = {
  createUsageBucketEl,
  updateUsageBar,
  formatResetCountdown,
  updateResetEl,
};
