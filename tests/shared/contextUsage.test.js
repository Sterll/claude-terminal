// context-usage — what actually occupies the context window.

const { contextTokensFromUsage } = require('../../src/shared/context-usage');

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
