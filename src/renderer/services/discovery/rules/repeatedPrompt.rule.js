/**
 * The same long prompt sent again and again: that is an automation.
 *
 * Signal: `prompt:sent` with the typed text, from a chat tab (ChatView) or a
 * terminal tab whose hooks report the prompt (UserPromptSubmit). Prompts are
 * never stored: only a hash of the normalised text, a count and the time of
 * the last send, for the 40 most recent prompts.
 *
 * Two sends count as a repeat only when at least REPEAT_GAP_MS apart, so
 * resending a message after an error or an interrupt is not mistaken for a
 * routine. Slash commands and short prompts are left out: "continue" and
 * "/compact" are habits, not tasks.
 */

const MIN_LENGTH = 80;
const REPEATS = 3;
const REPEAT_GAP_MS = 10 * 60 * 1000;
const MAX_TRACKED = 40;

function normalise(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** FNV-1a, 32 bits. Collisions only cost a suggestion, never data. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

module.exports = {
  id: 'repeatedPrompt',
  triggers: ['prompt:sent'],
  usedWhen: ['tab:workflows'],
  titleKey: 'discovery.rules.repeatedPrompt.title',
  bodyKey: 'discovery.rules.repeatedPrompt.body',
  action: { type: 'tab', tab: 'workflows' },
  // Keeps counting while another suggestion holds the day.
  countsWhileQuiet: true,

  condition(payload, ctx) {
    const text = normalise(payload && payload.text);
    if (text.length < MIN_LENGTH || text.startsWith('/')) return false;

    const key = hash(text);
    const at = ctx.now();
    const memory = ctx.memory.get();
    const prompts = { ...(memory.prompts || {}) };
    const entry = prompts[key] ? { ...prompts[key] } : { n: 0, last: 0 };
    if (!entry.last || at - entry.last >= REPEAT_GAP_MS) entry.n += 1;
    entry.last = at;
    prompts[key] = entry;

    const kept = Object.entries(prompts)
      .sort((a, b) => b[1].last - a[1].last)
      .slice(0, MAX_TRACKED);
    ctx.memory.set({ ...memory, prompts: Object.fromEntries(kept) });

    return entry.n >= REPEATS ? { params: { count: entry.n } } : false;
  },

  /** Anyone with an automation or a workflow already knows where they live. */
  async isUsed(ctx) {
    try {
      const res = await ctx.api.workflow.list();
      return !!(res && res.success && Array.isArray(res.workflows) && res.workflows.length > 0);
    } catch {
      return false;
    }
  },

  normalise,
  hash,
  MIN_LENGTH,
  REPEATS,
  REPEAT_GAP_MS,
  MAX_TRACKED,
};
