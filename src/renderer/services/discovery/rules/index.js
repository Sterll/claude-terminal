/**
 * Every suggestion rule, in priority order: when one signal matches several,
 * the first listed wins the day.
 *
 * Adding a rule is a file in this folder plus one line here; the engine does
 * not change. A rule is:
 *
 *   id            stable, it keys the user's dismissals in discovery.json
 *   triggers      signal names it listens to (see index.js `report()` callers)
 *   usedWhen      usage keys that mean "already uses it" ('tab:<id>' is
 *                 recorded for every sidebar screen opened)
 *   condition     (payload, ctx) => false | true | { params, bodyKey, titleKey }
 *                 sync or async; ctx.memory is a persisted scratch space
 *   isUsed        optional live probe, (ctx) => boolean, asked only once the
 *                 condition holds; a true answer is remembered for good
 *   titleKey, bodyKey   i18n keys, interpolated with the verdict's params
 *   action        { type: 'tab', tab, highlight? } | { type: 'setting', tab, anchor? }
 *   cooldownDays, maxShows, countsWhileQuiet   optional, see engine.js
 *
 * Parallel Tasks are deliberately absent: the chat already suggests them with
 * the `parallel-suggest` block, at the moment a task splits.
 */

module.exports = [
  require('./contextHandoff.rule'),
  require('./secondAccount.rule'),
  require('./controlTower.rule'),
  require('./repeatedPrompt.rule'),
  require('./commitGenerate.rule'),
  require('./database.rule'),
  require('./ticketTracker.rule'),
];
