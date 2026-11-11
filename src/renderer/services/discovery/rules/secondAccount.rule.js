/**
 * A usage limit nearly reached with a single Claude account: a second one can
 * take over.
 *
 * Signal: `usage:updated`, raised by the titlebar usage chip each time it
 * paints a fresh reading, with its buckets (`utilization` in percent; `null`
 * for a limit the API did not report). Someone with two saved accounts or more
 * already has the switch.
 */

const PERCENT = 85;

function highestUtilization(buckets) {
  if (!Array.isArray(buckets)) return null;
  let max = null;
  for (const bucket of buckets) {
    const value = bucket && typeof bucket.utilization === 'number' ? bucket.utilization : null;
    if (value !== null && Number.isFinite(value) && (max === null || value > max)) max = value;
  }
  return max;
}

module.exports = {
  id: 'secondAccount',
  triggers: ['usage:updated'],
  titleKey: 'discovery.rules.secondAccount.title',
  bodyKey: 'discovery.rules.secondAccount.body',
  action: { type: 'setting', tab: 'claude', anchor: 'btn-account-login' },
  cooldownDays: 14,

  condition(payload, ctx) {
    const max = highestUtilization(payload && payload.buckets);
    if (max === null || max < PERCENT) return false;
    if ((ctx.getAccounts() || []).length > 1) return false;
    return { params: { percent: Math.round(max) } };
  },

  isUsed(ctx) {
    return (ctx.getAccounts() || []).length > 1;
  },

  highestUtilization,
  PERCENT,
};
