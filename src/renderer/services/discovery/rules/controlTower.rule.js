/**
 * Three Claude tabs or more on one project: Control Tower shows them all at
 * once, and the split view puts two side by side.
 *
 * Signal: `tabs:changed`, raised by the host when the largest number of
 * Claude tabs (chat or terminal, never a plain shell or a type console) open
 * on a single project changes. Someone who already opened Control Tower knows
 * it; someone who already splits the view is told about Control Tower only.
 */

const MIN_CLAUDE_TABS = 3;

module.exports = {
  id: 'controlTower',
  triggers: ['tabs:changed'],
  usedWhen: ['tab:control-tower'],
  titleKey: 'discovery.rules.controlTower.title',
  bodyKey: 'discovery.rules.controlTower.body',
  action: { type: 'tab', tab: 'control-tower' },
  cooldownDays: 21,

  condition(payload, ctx) {
    const count = Number(payload && payload.maxClaudeTabs) || 0;
    if (count < MIN_CLAUDE_TABS) return false;
    if (ctx.isSplitInUse && ctx.isSplitInUse()) {
      return { params: { count }, bodyKey: 'discovery.rules.controlTower.bodyNoSplit' };
    }
    return { params: { count, shortcut: ctx.splitShortcut ? ctx.splitShortcut() : 'Ctrl+Shift+D' } };
  },

  MIN_CLAUDE_TABS,
};
