const { normalizeModelId, priceFor, isLongPrompt, costOf } = require('../../src/shared/model-pricing');

describe('model-pricing', () => {
  test('normalizes context tags and snapshot dates', () => {
    expect(normalizeModelId('claude-opus-5-5[1m]')).toBe('claude-opus-5-5');
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(normalizeModelId('Claude-Sonnet-5')).toBe('claude-sonnet-5');
  });

  test('uses published cache-read rates where a model has its own', () => {
    expect(priceFor('claude-fable-5-1').cacheRead).toBe(0.25);
    expect(priceFor('claude-opus-5-5').cacheRead).toBe(0.2);
    // Everyone else reads at a tenth of input.
    expect(priceFor('claude-opus-5').cacheRead).toBeCloseTo(0.5);
  });

  test('prices every token kind with the cache multipliers', () => {
    const cost = costOf('claude-opus-5', {
      input: 1e6, output: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6,
    });
    // 5 + 25 + 5*1.25 + 5*2 + 0.5
    expect(cost).toBeCloseTo(46.75);
  });

  test('fast mode doubles the price', () => {
    const base = costOf('claude-opus-5-5', { output: 1e6 });
    expect(costOf('claude-opus-5-5', { output: 1e6 }, { fast: true })).toBeCloseTo(base * 2);
  });

  test('an unlisted id falls back to its family and says so', () => {
    const price = priceFor('claude-sonnet-6');
    expect(price.estimated).toBe(true);
    expect(price.id).toBe('claude-sonnet-5-5');
    expect(priceFor('claude-haiku-6').id).toBe('claude-haiku-5-5');
    expect(priceFor('claude-opus-5').estimated).toBe(false);
  });

  // https://platform.claude.com/docs/en/about-claude/pricing
  test('Sonnet 5.5 is listed, with its published cache-read rate', () => {
    const price = priceFor('claude-sonnet-5-5');
    expect(price).toMatchObject({ input: 2, output: 10, cacheRead: 0.1, estimated: false });
  });

  describe('Haiku 5.5, priced by prompt length', () => {
    const M = 1e6;

    test('a prompt up to 100,000 tokens pays the standard rates', () => {
      expect(priceFor('claude-haiku-5-5')).toMatchObject({ input: 0.1, output: 0.5, cacheRead: 0.01, estimated: false });
      // 0.1 + 0.5 + 0.125 + 0.2 + 0.01, the five columns of the pricing page
      expect(costOf('claude-haiku-5-5', { input: M, output: M, cacheWrite5m: M, cacheWrite1h: M, cacheRead: M }, { longPrompt: false }))
        .toBeCloseTo(0.935);
    });

    test('a prompt over 100,000 tokens pays the long rates on every kind, output included', () => {
      expect(priceFor('claude-haiku-5-5', { longPrompt: true })).toMatchObject({ input: 0.5, output: 2.5, cacheRead: 0.05 });
      // 0.5 + 2.5 + 0.625 + 1 + 0.05
      expect(costOf('claude-haiku-5-5', { input: M, output: M, cacheWrite5m: M, cacheWrite1h: M, cacheRead: M }, { longPrompt: true }))
        .toBeCloseTo(4.675);
    });

    test('one request reads its tier from its own prompt, cache reads and writes counted', () => {
      const at = n => costOf('claude-haiku-5-5', { input: 1000, cacheRead: n - 1000, output: 1000 });
      expect(at(100000)).toBeCloseTo((1000 * 0.1 + 99000 * 0.01 + 1000 * 0.5) / M);
      expect(at(100001)).toBeCloseTo((1000 * 0.5 + 99001 * 0.05 + 1000 * 2.5) / M);
      // Output does not count toward the threshold.
      expect(costOf('claude-haiku-5-5', { input: 1000, output: 200000 })).toBeCloseTo((1000 * 0.1 + 200000 * 0.5) / M);
    });

    test('a sum of requests says its tier rather than letting the total decide', () => {
      const twoShortPrompts = { input: 120000 };
      expect(costOf('claude-haiku-5-5', twoShortPrompts, { longPrompt: false })).toBeCloseTo(0.012);
      expect(costOf('claude-haiku-5-5', twoShortPrompts)).toBeCloseTo(0.06);
    });

    test('only Haiku 5.5 has a tier: a long prompt elsewhere is priced as usual', () => {
      expect(isLongPrompt('claude-haiku-5-5', { input: 100001 })).toBe(true);
      expect(isLongPrompt('claude-opus-5-5', { input: 900000 })).toBe(false);
      expect(costOf('claude-opus-5-5', { input: M }, { longPrompt: true })).toBeCloseTo(4);
    });
  });

  test('an id with no known family is not priced as free', () => {
    expect(priceFor('gpt-5')).toBeNull();
    expect(costOf('gpt-5', { input: 100 })).toBeNull();
    expect(priceFor('<synthetic>')).toBeNull();
  });
});
