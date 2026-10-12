import { describe, it, expect } from 'vitest';
import { alternativeOf, chauffeurFeasibility, soldView, soldViewFor, addOnsFor } from './quoteAlternative';

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

describe('soldView', () => {
  const sold = (over: Record<string, unknown> = {}) => ({
    ...stored(
      { engine: { product: 'chauffeur', vehicle: 'car' }, result: altResult({ marginEstimateCents: 5_100 }) },
      { product: 'private', totalCents: 11_450, marginCents: 2_000, soldCents: 22_700,
        payLinkSelection: { service: 'chauffeur' }, request: { tool: { legs: [] }, engine: { product: 'private' } } },
    ),
    ...over,
  });

  it('is the very same quote when there is no service selection', () => {
    const plain = stored({}, { payLinkSelection: null });
    expect(soldView(plain as never)).toBe(plain);
    const part = stored({}, { payLinkSelection: { legIndexes: [0], extraIndexes: [] }, soldCents: 100 });
    expect(soldView(part as never)).toBe(part);
  });

  it('projects the frozen chauffeur option, with the selection and soldCents cleared', () => {
    const v = soldView(sold() as never)!;
    expect(v.product).toBe('chauffeur');
    expect(v.totalCents).toBe(22_700);
    expect(v.marginCents).toBe(5_100);
    expect((v.request as { engine: { product: string }; tool: unknown }).engine.product).toBe('chauffeur');
    expect((v.request as { tool: unknown }).tool).toEqual({ legs: [] }); // the tool payload is kept
    expect((v.result as { totalCents: number }).totalCents).toBe(22_700);
    expect(v.payLinkSelection).toBeNull();
    expect(v.soldCents).toBeNull();
  });

  it('fails closed (null) when the alternative is gone, malformed or no longer the quote\'s', () => {
    expect(soldView(sold({ result: { totalCents: 11_450 } }) as never)).toBeNull(); // dangling
    expect(soldView(sold({ soldCents: 22_699 }) as never)).toBeNull(); // amount mismatch
    expect(soldView(sold({ soldCents: null }) as never)).toBeNull();
    expect(soldView(sold({ requestedService: 'private' }) as never)).toBeNull();
  });
  it('fails closed on a selection that is neither a leg selection nor { service: "chauffeur" }', () => {
    expect(soldView(sold({ payLinkSelection: { service: 'private' } }) as never)).toBeNull();
    expect(soldView(sold({ payLinkSelection: {} }) as never)).toBeNull();
    expect(soldView(sold({ payLinkSelection: { legIndexes: 'x', extraIndexes: [] } }) as never)).toBeNull();
  });
});

// As sold follows the BOOKING once there is one: the selection lives on the quote and moves when
// the agent re-mints, but a booking already created stays what it was.
describe('soldViewFor / addOnsFor', () => {
  const chauffeurBooking = (total = 22_700) => ({ mode: 'trip', total, input: { serviceType: 'chauffeur' } });
  const privateTrip = { mode: 'trip', total: 11_450, input: { serviceType: 'private' } };
  const single = { mode: 'single', total: 11_450, input: {} };
  const quoteWith = (selection: unknown, soldCents: number | null = null) => ({
    ...stored({ engine: { product: 'chauffeur', vehicle: 'car' } }, {
      product: 'private', totalCents: 11_450, marginCents: 2_000, soldCents, payLinkSelection: selection,
      request: { tool: { legs: [] }, engine: { product: 'private' } },
    }),
  });

  it.each([['no selection', null, null], ['a service selection', { service: 'chauffeur' }, 22_700]])(
    'a chauffeur booking at the alt total is the chauffeur quote whatever the selection is (%s)', (_l, sel, sold) => {
      const v = soldViewFor(quoteWith(sel, sold) as never, chauffeurBooking() as never);
      expect(v.product).toBe('chauffeur');
      expect(v.totalCents).toBe(22_700);
      expect(v.payLinkSelection).toBeNull();
    });

  it('a chauffeur booking whose total is not the alt total is NOT projected', () => {
    expect(soldViewFor(quoteWith(null) as never, chauffeurBooking(22_699) as never).product).toBe('private');
  });

  it.each([['a private trip booking', privateTrip], ['a single booking', single]])(
    '%s is the primary quote even while the selection says chauffeur', (_l, b) => {
      const v = soldViewFor(quoteWith({ service: 'chauffeur' }, 22_700) as never, b as never);
      expect(v.product).toBe('private');
      expect(v.totalCents).toBe(11_450);
      expect(v.payLinkSelection).toBeNull();
      expect(v.soldCents).toBeNull();
    });

  it('leaves a part-of-trip selection alone for a booking', () => {
    const q = quoteWith({ legIndexes: [0], extraIndexes: [] }, 100);
    expect(soldViewFor(q as never, privateTrip as never)).toBe(q);
  });

  it('with no booking it is the selection-based view, falling back to the primary rather than null', () => {
    expect(soldViewFor(quoteWith({ service: 'chauffeur' }, 22_700) as never, null).product).toBe('chauffeur');
    expect(soldViewFor(quoteWith({ service: 'chauffeur' }, 5) as never, null).product).toBe('private');
  });

  const lines = [{ label: 'A → B (car)', amountCents: 1 }, { label: 'Waiting fee — A → B', amountCents: 1 }];
  const withAddOn = (selection: unknown) => ({
    request: { engine: { product: 'private', legs: [{}], extras: [{ code: 'waiting', legIndex: 0 }] } },
    result: { lineItems: lines }, payLinkSelection: selection,
  });
  it('add-ons: none for a chauffeur booking; a private booking gets what it would with no service selection', () => {
    expect(addOnsFor(withAddOn({ service: 'chauffeur' }) as never, chauffeurBooking() as never)).toEqual([]);
    expect(addOnsFor(withAddOn(null) as never, chauffeurBooking() as never)).toEqual([]);
    expect(addOnsFor(withAddOn({ service: 'chauffeur' }) as never, single as never)).toEqual(['Waiting fee — A → B']);
    expect(addOnsFor(withAddOn(null) as never, single as never)).toEqual(['Waiting fee — A → B']);
    expect(addOnsFor(withAddOn({ legIndexes: [0], extraIndexes: [] }) as never, single as never)).toEqual([]);
  });
});
