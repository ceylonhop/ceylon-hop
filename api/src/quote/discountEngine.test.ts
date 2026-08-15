// api/src/quote/discountEngine.test.ts
// Task 2 — the discount wired into quote(). Kept separate from engine.test.ts the same way
// hotZonesEngine.test.ts is, so the untouched-engine suite stays untouched.
import { describe, it, expect } from 'vitest';
import { quote } from './engine';
import { payLines } from './paySelection';
import type { QuoteRequest } from './types';
import type { SavedQuote } from '../db/quoteRepo';

const CAR_200KM: QuoteRequest = {
  product: 'private', vehicle: 'car', pax: 2, bags: 2,
  legs: [{ from: 'Colombo', to: 'Trincomalee', distanceKm: 200 }],
};
// 25 km van → billable 30 → 30 × 54.05¢ = $16.22, so the $49.99 floor is the whole price.
const VAN_AT_FLOOR: QuoteRequest = {
  product: 'private', vehicle: 'van', pax: 4, bags: 4,
  legs: [{ from: 'Galle', to: 'Unawatuna', distanceKm: 25 }],
};
const ask = (amountCents: number) => ({ source: 'manual' as const, method: 'fixed' as const, amountCents, reason: 'test' });

describe('quote() with a manual discount', () => {
  it('adds NO fields at all when no discount is requested', () => {
    const r = quote(CAR_200KM) as unknown as Record<string, unknown>;
    // The zero-discount gate depends on this: extra keys would diff every golden snapshot.
    expect('discountCents' in r).toBe(false);
    expect('discountedSubtotalCents' in r).toBe(false);
    expect('discount' in r).toBe(false);
    expect((r.lineItems as { meta?: { kind?: string } }[]).some((li) => li.meta?.kind === 'discount')).toBe(false);
  });

  it('emits one tagged negative line item and leaves subtotalCents gross', () => {
    const base = quote(CAR_200KM);
    const r = quote(CAR_200KM, undefined, ask(1000));
    expect(r.subtotalCents).toBe(base.subtotalCents); // untouched by the discount
    expect(r.discountCents).toBe(1000);
    // The quoted price, then the discount off it — these reconcile EXACTLY, which is the whole
    // point of finishing before rather than after.
    expect(r.totalBeforeDiscountCents).toBe(base.totalCents);
    expect(r.totalCents).toBe(base.totalCents - 1000);
    expect(r.lineItems).toContainEqual({
      label: 'Discount', amountCents: -1000, meta: { kind: 'discount' },
    });
  });

  it('leaves the undiscounted price completely untouched', () => {
    // Finishing sees exactly what it always saw, so the founder's figure comes off the quoted
    // price verbatim: $10.00 off $62.00 is $52.00, not $51.99.
    const base = quote(CAR_200KM);
    const r = quote(CAR_200KM, undefined, ask(1000));
    const sum = r.lineItems.reduce((s, li) => s + li.amountCents, 0);
    expect(sum).toBe(r.totalCents); // line items still reconcile to the total
    expect(base.totalCents - r.totalCents).toBe(1000); // exactly what was typed
  });

  it('refuses to take a van below its $49.99 minimum', () => {
    const r = quote(VAN_AT_FLOOR, undefined, ask(2000));
    expect(r.subtotalCents).toBe(4999);
    expect(r.discountCents).toBe(0);
    expect(r.discount?.capReason).toBe('vehicle_minimum');
    expect(r.totalCents).toBe(4999); // unchanged — the floor IS the price here
    // A zero-cent result must not look like a discounted quote to a renderer.
    expect(r.lineItems.some((li) => li.meta?.kind === 'discount')).toBe(false);
  });

  it('keeps the total at or above the floor for every request size', () => {
    for (const amount of [100, 1000, 5000, 50_000]) {
      const r = quote(CAR_200KM, undefined, ask(amount));
      expect(r.totalCents).toBeGreaterThanOrEqual(2900);
      expect(r.discountCents!).toBeLessThanOrEqual(Math.floor(r.subtotalCents * 0.3));
    }
  });

  it('rejects a discount on shared, which has no vehicle and no floor', () => {
    const shared: QuoteRequest = { product: 'shared', legs: [{ routeId: 'x', seats: 1, seatPriceCents: 5000 }] };
    expect(() => quote(shared, undefined, ask(100))).toThrow('DISCOUNT_NOT_SUPPORTED');
  });
});

describe('paySelection sees through the discount line', () => {
  const saved = (req: QuoteRequest, discount?: Parameters<typeof quote>[2]): SavedQuote =>
    ({ request: { engine: req }, result: quote(req, undefined, discount) }) as unknown as SavedQuote;

  it('never offers the discount as a tickable charge line', () => {
    const withExtras: QuoteRequest = {
      product: 'private', vehicle: 'car', pax: 2, bags: 2,
      legs: [{ from: 'Kandy', to: 'Ella', distanceKm: 140 }], extras: ['luggage', 'flex'],
    };
    const lines = payLines(saved(withExtras, ask(1000)));
    expect(lines.every((l) => l.amountCents > 0)).toBe(true);
    expect(lines.filter((l) => l.kind === 'extra')).toHaveLength(2);
  });

  it('keeps extra indexes aligned with engine.extras when a discount is present', () => {
    const withExtras: QuoteRequest = {
      product: 'private', vehicle: 'car', pax: 2, bags: 2,
      legs: [{ from: 'Kandy', to: 'Ella', distanceKm: 140 }], extras: ['luggage', 'flex'],
    };
    const plain = payLines(saved(withExtras));
    const discounted = payLines(saved(withExtras, ask(1000)));
    // Same lines, same indexes, same prices — a discount must not shift what a stored
    // pay_link_selection points at.
    expect(discounted).toEqual(plain);
  });
});
