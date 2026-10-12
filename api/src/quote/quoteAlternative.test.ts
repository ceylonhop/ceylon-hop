import { describe, it, expect } from 'vitest';
import { alternativeOf, chauffeurFeasibility } from './quoteAlternative';

// Shapes are hand-built here ONLY to pin the reader's validation; the round-trip through the real
// /save lives in routes/internalQuote.test.ts.
const altResult = (over: Record<string, unknown> = {}) => ({
  product: 'chauffeur', currency: 'USD', lineItems: [], subtotalCents: 22_700, totalCents: 22_700,
  depositCents: 6_810, amountDueNowCents: 6_810, rateCardVersion: 'v1', warnings: [], ...over,
});
const stored = (altOver: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  requestedService: 'both',
  request: { engine: { product: 'private' } },
  result: {
    totalCents: 11_450,
    alt: { product: 'chauffeur', engine: { product: 'chauffeur' }, result: altResult(), ...altOver },
  },
  ...over,
});

describe('chauffeurFeasibility', () => {
  const d = (date?: string, category?: string) => ({ date, category });
  it('is feasible with every leg dated and two or more distinct dates', () => {
    expect(chauffeurFeasibility([d('2026-12-01'), d('2026-12-03')])).toBeNull();
  });
  it('counts a stay day as a dated leg', () => {
    expect(chauffeurFeasibility([d('2026-12-01'), d('2026-12-02', 'stay_day')])).toBeNull();
  });
  it('refuses an undated leg, whatever the other dates are', () => {
    expect(chauffeurFeasibility([d('2026-12-01'), d(undefined), d('2026-12-03')])).toBe('add a date to every leg');
  });
  it('refuses a single distinct date', () => {
    expect(chauffeurFeasibility([d('2026-12-01'), d('2026-12-01')])).toBe('single-day — point-to-point only');
  });
});

describe('alternativeOf', () => {
  it('returns the stored alternative for a both-quote priced private', () => {
    const alt = alternativeOf(stored() as never);
    expect(alt?.product).toBe('chauffeur');
    expect(alt?.result.totalCents).toBe(22_700);
  });

  it('is null when nothing is stored', () => {
    expect(alternativeOf({ requestedService: 'both', request: { engine: { product: 'private' } }, result: { totalCents: 1 } } as never)).toBeNull();
    expect(alternativeOf({ requestedService: 'both', request: null, result: null } as never)).toBeNull();
  });

  it('ignores an alt on anything but a both-quote priced private', () => {
    expect(alternativeOf(stored({}, { requestedService: 'private' }) as never)).toBeNull();
    expect(alternativeOf(stored({}, { requestedService: null }) as never)).toBeNull();
    expect(alternativeOf(stored({}, { request: { engine: { product: 'chauffeur' } } }) as never)).toBeNull();
  });

  it('ignores an alt on a discounted quote (D2)', () => {
    const q = stored();
    (q.result as Record<string, unknown>).discount = { method: 'fixed' };
    expect(alternativeOf(q as never)).toBeNull();
    const q2 = stored();
    (q2.result as Record<string, unknown>).discountCents = 1000;
    expect(alternativeOf(q2 as never)).toBeNull();
  });

  it.each([
    ['a wrong product', { product: 'private' }],
    ['a non-chauffeur engine', { engine: { product: 'private' } }],
    ['a non-chauffeur result', { result: altResult({ product: 'private' }) }],
    ['a zero total', { result: altResult({ totalCents: 0 }) }],
    ['a fractional total', { result: altResult({ totalCents: 100.5 }) }],
    ['a string total', { result: altResult({ totalCents: '22700' }) }],
    ['a missing deposit', { result: altResult({ depositCents: undefined }) }],
    ['a non-USD currency', { result: altResult({ currency: 'LKR' }) }],
  ])('rejects %s', (_l, over) => {
    expect(alternativeOf(stored(over) as never)).toBeNull();
  });
});
