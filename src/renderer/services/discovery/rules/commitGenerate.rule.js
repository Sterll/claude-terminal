/**
 * Commit messages typed by hand in the Git panel: the panel can draft one.
 *
 * Signal: `git:committed`, raised by GitChangesPanel after a successful
 * commit, with `generated: true` when the message came from its generate
 * button since the previous commit. Generating marks `git:generate-commit` as
 * used, which retires this rule. Amends are not counted (an amend often keeps
 * the message it had).
 */

const MANUAL_COMMITS = 3;

module.exports = {
  id: 'commitGenerate',
  triggers: ['git:committed'],
  usedWhen: ['git:generate-commit'],
  titleKey: 'discovery.rules.commitGenerate.title',
  bodyKey: 'discovery.rules.commitGenerate.body',
  action: { type: 'tab', tab: 'git', highlight: '#btn-generate-commit' },
  countsWhileQuiet: true,

  condition(payload, ctx) {
    if (!payload || payload.generated || payload.amend) return false;
    const memory = ctx.memory.get();
    const manual = (memory.manual || 0) + 1;
    ctx.memory.set({ ...memory, manual });
    return manual >= MANUAL_COMMITS;
  },

  MANUAL_COMMITS,
};
