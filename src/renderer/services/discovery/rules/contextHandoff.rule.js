/**
 * A chat's context window nearly full while the context handoff is off.
 *
 * Signal: `context:usage`, raised by the chat's context gauge each time it is
 * repainted, with the occupancy ratio. The gauge itself turns amber at 75 %;
 * this speaks a little before, so the setting is found before the CLI has to
 * compact. Usually reached mid-turn, so the engine holds it until the turn
 * ends.
 */

const RATIO = 0.7;

module.exports = {
  id: 'contextHandoff',
  triggers: ['context:usage'],
  titleKey: 'discovery.rules.contextHandoff.title',
  bodyKey: 'discovery.rules.contextHandoff.body',
  action: { type: 'setting', tab: 'claude', anchor: 'context-handoff-toggle' },

  condition(payload, ctx) {
    const ratio = Number(payload && payload.ratio) || 0;
    const limit = Number(payload && payload.limit) || 0;
    if (limit <= 0 || ratio < RATIO) return false;
    if (ctx.getSetting('contextHandoffEnabled')) return false;
    return { params: { percent: Math.round(Math.min(ratio, 1) * 100) } };
  },

  isUsed(ctx) {
    return !!ctx.getSetting('contextHandoffEnabled');
  },

  RATIO,
};
