const { normalizeModelId, priceFor, costOf } = require('../../src/shared/model-pricing');

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
    const price = priceFor('claude-sonnet-5-5');
    expect(price.estimated).toBe(true);
    expect(price.input).toBe(priceFor('claude-sonnet-5').input);
    expect(priceFor('claude-opus-5').estimated).toBe(false);
  });

  test('an id with no known family is not priced as free', () => {
    expect(priceFor('gpt-5')).toBeNull();
    expect(costOf('gpt-5', { input: 100 })).toBeNull();
    expect(priceFor('<synthetic>')).toBeNull();
  });
});
