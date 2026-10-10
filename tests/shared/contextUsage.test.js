// context-usage — what actually occupies the context window.

const { contextTokensFromUsage, contextTokensFromMessage, contextWindowFromResult } = require('../../src/shared/context-usage');

describe('contextTokensFromUsage', () => {
  test('counts cached tokens, which is the whole point', () => {
    // Verbatim from a real turn in this app. Reading input_tokens alone gave 2,
    // so the chat gauge reported "2 / 1000K" for a 233K context.
    const usage = {
      input_tokens: 2,
      cache_creation_input_tokens: 1675,
      cache_read_input_tokens: 232050,
      output_tokens: 322,
    };
    expect(contextTokensFromUsage(usage)).toBe(233727);
  });

  test('ignores output tokens — they are not in the window yet', () => {
    expect(contextTokensFromUsage({ input_tokens: 100, output_tokens: 5000 })).toBe(100);
  });

  test('tolerates a partial usage object', () => {
    expect(contextTokensFromUsage({ cache_read_input_tokens: 500 })).toBe(500);
    expect(contextTokensFromUsage({})).toBe(0);
  });

  test('treats junk as unknown rather than throwing', () => {
    expect(contextTokensFromUsage(null)).toBe(0);
    expect(contextTokensFromUsage(undefined)).toBe(0);
    expect(contextTokensFromUsage('nope')).toBe(0);
    expect(contextTokensFromUsage({ input_tokens: -5, cache_read_input_tokens: NaN })).toBe(0);
  });
});

describe('contextTokensFromMessage', () => {
  const frame = (usage, extra = {}) => ({ type: 'assistant', message: { usage }, ...extra });

  test('reads one API call, which is the occupancy at that moment', () => {
    expect(contextTokensFromMessage(frame({
      input_tokens: 4,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 310000,
    }))).toBe(312004);
  });

  test('a turn total is not an occupancy — result messages carry no message.usage', () => {
    // The shape the gauge used to read: usage at the top level, summed across
    // every API call of the turn. That is what showed "1.1M / 1M (109%)".
    expect(contextTokensFromMessage({ type: 'result', usage: { input_tokens: 1_100_000 } })).toBe(0);
  });

  test('skips frames measuring someone else’s window', () => {
    const usage = { input_tokens: 50000 };
    expect(contextTokensFromMessage(frame(usage, { parent_tool_use_id: 'toolu_1' }))).toBe(0);
    expect(contextTokensFromMessage(frame(usage, { subagent_type: 'Explore' }))).toBe(0);
    expect(contextTokensFromMessage(frame(usage, { isSidechain: true }))).toBe(0);
  });

  test('reads what a compaction left, in either casing', () => {
    // As the SDK delivers the boundary…
    expect(contextTokensFromMessage({
      type: 'system', subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 36218, post_tokens: 3356 },
    })).toBe(3356);
    // …and as the CLI writes it to the session file.
    expect(contextTokensFromMessage({
      type: 'system', subtype: 'compact_boundary', isSidechain: false,
      compactMetadata: { trigger: 'manual', preTokens: 36218, postTokens: 3356 },
    })).toBe(3356);
  });

  test('a boundary that does not say what survived measures nothing', () => {
    // pre_tokens is the size *before* — the one figure a post-compaction gauge
    // must not show.
    expect(contextTokensFromMessage({
      type: 'system', subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 940584 },
    })).toBe(0);
  });

  test('takes the CLI’s own count off the /context frame', () => {
    // Verbatim shape: an all-zero usage, and the structured twin of the table.
    expect(contextTokensFromMessage(frame(
      { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      { context_usage: { model: 'claude-haiku-4-5-20251001', total_tokens: 11626, raw_max_tokens: 200000, percentage: 6, categories: [] } }
    ))).toBe(11626);
  });

  test('tolerates junk', () => {
    expect(contextTokensFromMessage(null)).toBe(0);
    expect(contextTokensFromMessage({})).toBe(0);
    expect(contextTokensFromMessage('nope')).toBe(0);
  });
});

describe('contextWindowFromResult', () => {
  test('reads the main model window, not a subagent one', () => {
    const result = {
      modelUsage: {
        'claude-haiku-4-5-20251001': { contextWindow: 200000 },
        'claude-opus-5-5': { contextWindow: 1000000 },
      },
    };
    expect(contextWindowFromResult(result, 'claude-opus-5-5')).toBe(1000000);
    expect(contextWindowFromResult(result, 'claude-haiku-4-5-20251001')).toBe(200000);
  });

  test('matches through the canonical id and a [1m] suffix', () => {
    const result = { modelUsage: { 'claude-opus-5[1m]': { contextWindow: 1000000, canonicalModel: 'claude-opus-5' } } };
    expect(contextWindowFromResult(result, 'claude-opus-5')).toBe(1000000);
  });

  test('falls back to the largest window when the model is unknown', () => {
    const result = { modelUsage: { a: { contextWindow: 200000 }, b: { contextWindow: 1000000 } } };
    expect(contextWindowFromResult(result, 'other')).toBe(1000000);
    expect(contextWindowFromResult(result)).toBe(1000000);
  });

  test('answers 0 when nothing is reported', () => {
    expect(contextWindowFromResult(null)).toBe(0);
    expect(contextWindowFromResult({})).toBe(0);
    expect(contextWindowFromResult({ modelUsage: { a: { contextWindow: 0 } } })).toBe(0);
  });
});
