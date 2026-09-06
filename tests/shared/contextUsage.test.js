// context-usage — what actually occupies the context window.

const { contextTokensFromUsage, contextTokensFromMessage } = require('../../src/shared/context-usage');

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

  test('tolerates junk', () => {
    expect(contextTokensFromMessage(null)).toBe(0);
    expect(contextTokensFromMessage({})).toBe(0);
    expect(contextTokensFromMessage('nope')).toBe(0);
  });
});
