import { describe, it, expect } from 'vitest';
import { payLines, selectionAmountCents, isFullSelection, isContiguous, gapAfterLeg } from './paySelection';
import { quote } from './engine';
import { RATE_CARD } from './rateCard';
import type { SavedQuote } from '../db/quoteRepo';
import type { QuoteRequest } from './types';

const req: QuoteRequest = {
  product: 'private',
  vehicle: 'car',
  pax: 2,
  bags: 2,
  legs: [
    { from: 'Colombo', to: 'Kandy', distanceKm: 120 },
    { from: 'Kandy', to: 'Ella', distanceKm: 140 },
    { from: 'Ella', to: 'Galle', distanceKm: 200 },
  ],
  extras: [{ code: 'luggage', legIndex: 1 }, 'flex'],
};

// A stored quote is `request: { engine, tool }` + `result`. Build it through the REAL engine, so
// the fixture carries the same line items a saved quote does rather than a hand-written shape.
function savedQuote(request: QuoteRequest = req): SavedQuote {
  const result = quote(request, RATE_CARD);
  return { request: { engine: request }, result, totalCents: result.totalCents } as unknown as SavedQuote;
}

describe('payLines', () => {
  it('emits one line per leg then one per extra, in request order', () => {
    const lines = payLines(savedQuote());
    expect(lines.map((l) => `${l.kind}:${l.index}`)).toEqual([
      'leg:0', 'leg:1', 'leg:2', 'extra:0', 'extra:1',
    ]);
    // The label is the engine's own, verbatim — it names the priced vehicle tier too. That is
    // what the quote already shows the customer, so it is what the receipt must show.
    expect(lines[0].label).toBe('Colombo → Kandy (car)');
    expect(lines[3].legIndex).toBe(1);
    expect(lines[4].legIndex).toBeUndefined();
  });

  it('excludes the charm-finishing adjustment row', () => {
    expect(payLines(savedQuote())).toHaveLength(5); // 3 legs + 2 extras, never price_adjustment
  });

  // THE invariant of this feature: the lines a partial link charges from are the same numbers
  // the quote itself was built from. If this drifts, every partial sale charges a fiction.
  it('sums with the adjustment to the quote total', () => {
    const q = savedQuote();
    const sum = payLines(q).reduce((a, l) => a + l.amountCents, 0);
    const { priceAdjustmentCents } = q.result as { priceAdjustmentCents: number };
    expect(sum + priceAdjustmentCents).toBe(q.totalCents);
  });

  it('refuses a chauffeur quote', () => {
    const chauffeur: QuoteRequest = {
      product: 'chauffeur',
      vehicle: 'car',
      firstDate: '2026-09-01',
      lastDate: '2026-09-02',
      travelDays: [{ date: '2026-09-01', from: 'Colombo', to: 'Kandy', distanceKm: 120 }],
    };
    expect(() => payLines(savedQuote(chauffeur))).toThrow();
  });
});

describe('selectionAmountCents', () => {
  it('sums only the ticked lines', () => {
    const lines = payLines(savedQuote());
    const sel = { legIndexes: [0, 1], extraIndexes: [0] };
    expect(selectionAmountCents(lines, sel)).toBe(
      lines[0].amountCents + lines[1].amountCents + lines[3].amountCents,
    );
  });

  it('never falls below the per-leg floor for the priced tier', () => {
    const lines = payLines(savedQuote({ ...req, legs: [{ from: 'A', to: 'B', distanceKm: 1 }], extras: [] }));
    expect(selectionAmountCents(lines, { legIndexes: [0], extraIndexes: [] }))
      .toBeGreaterThanOrEqual(RATE_CARD.floorCents.car);
  });
});

describe('isFullSelection', () => {
  it('is true only when every line is ticked', () => {
    const lines = payLines(savedQuote());
    expect(isFullSelection(lines, { legIndexes: [0, 1, 2], extraIndexes: [0, 1] })).toBe(true);
    expect(isFullSelection(lines, { legIndexes: [0, 1, 2], extraIndexes: [0] })).toBe(false);
    expect(isFullSelection(lines, { legIndexes: [0, 2], extraIndexes: [0, 1] })).toBe(false);
  });
});

describe('isContiguous', () => {
  it('accepts a run and rejects a hole', () => {
    expect(isContiguous([0, 1, 2])).toBe(true);
    expect(isContiguous([1, 2])).toBe(true);
    expect(isContiguous([2, 0, 1])).toBe(true); // order-insensitive
    expect(isContiguous([0, 2])).toBe(false);
    expect(isContiguous([])).toBe(false);
  });
});

describe('gapAfterLeg', () => {
  it('names the leg the gap opens after, for the ops warning', () => {
    const lines = payLines(savedQuote());
    expect(gapAfterLeg(lines, { legIndexes: [0, 2], extraIndexes: [] })).toBe('Colombo → Kandy (car)');
    expect(gapAfterLeg(lines, { legIndexes: [0, 1], extraIndexes: [] })).toBeNull();
  });
});
