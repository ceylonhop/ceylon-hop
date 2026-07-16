import { describe, expect, it } from 'vitest';
import { finishPrice } from './priceFinish';

const config = { maxReductionBps: 250, roundToCents: 50 };

describe('finishPrice', () => {
  it.each([
    [8099, 7900, 'charm'],
    [40148, 39900, 'charm'],
    [102000, 99900, 'charm'],
    [112500, 109900, 'charm'],
    [152000, 149900, 'charm'],
    [204500, 199900, 'charm'],
  ] as const)('finishes %i cents as %i cents using %s', (raw, expected, strategy) => {
    expect(finishPrice(raw, 0, config)).toEqual({
      rawCents: raw,
      finalCents: expected,
      adjustmentCents: expected - raw,
      strategy,
    });
  });

  it.each([
    [8110, 8100],
    [112936, 112950],
    [206018, 206000],
  ])('falls back from an ineligible charm target and rounds %i cents to %i cents', (raw, expected) => {
    expect(finishPrice(raw, 0, config)).toMatchObject({
      finalCents: expected,
      adjustmentCents: expected - raw,
      strategy: 'nearest_50_cents',
    });
  });

  it('accepts an exact 2.5% reduction and rejects one above 2.5%', () => {
    expect(finishPrice(4000, 0, config).finalCents).toBe(3900);
    expect(finishPrice(8110, 0, config).finalCents).toBe(8100);
  });

  it('rounds an exact 25-cent tie down in the customer\'s favour', () => {
    expect(finishPrice(8125, 0, config).finalCents).toBe(8100);
  });

  it('leaves a price already on a charm target unchanged', () => {
    expect(finishPrice(39900, 0, config)).toEqual({
      rawCents: 39900,
      finalCents: 39900,
      adjustmentCents: 0,
      strategy: 'unchanged',
    });
  });

  it('rejects a downward adjustment below the minimum allowed price', () => {
    expect(finishPrice(40148, 40000, config).finalCents).toBe(40150);
    expect(finishPrice(8110, 8105, config).finalCents).toBe(8110);
  });

  it('rejects invalid, non-integer money inputs', () => {
    expect(() => finishPrice(8099.5, 0, config)).toThrow('INVALID_PRICE');
    expect(() => finishPrice(-1, 0, config)).toThrow('INVALID_PRICE');
  });
});
