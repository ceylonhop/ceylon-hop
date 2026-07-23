import { describe, it, expect } from 'vitest';
import { RATE_CARD, type RateCard } from './rateCard';
import type { HotZone } from './hotZones';
import { quotePrivateLegs } from './private';
import { quoteChauffeur } from './chauffeur';
import { quote } from './engine';
import { normalizeRide, normalizeChauffeurDay, type Ride } from './types';

const withZones = (zones: HotZone[]): RateCard => ({ ...RATE_CARD, hotZones: zones });
const ELLA: HotZone = { placeName: 'Ella', boostPct: 15 };

const ride = (a: string, b: string, km: number): Ride => normalizeRide({ from: a, to: b, distanceKm: km });

describe('private legs — hot-zone boost (D1/D2/D6/D9)', () => {
  it('boosts a zone-touching leg by +15% on the per-km rate', () => {
    // Kandy→Ella 100km car: billableKm=110, rate 40.25¢. base=round(110×40.25)=4428.
    const base = quotePrivateLegs([ride('Kandy', 'Ella', 100)], 'car');
    expect(base.lineItems[0].amountCents).toBe(4428);
    expect(base.perRideBoost).toEqual([1]);
    // With an Ella zone: round(110 × 40.25 × 1.15) = round(5091.625) = 5092.
    const boosted = quotePrivateLegs([ride('Kandy', 'Ella', 100)], 'car', undefined, withZones([ELLA]));
    expect(boosted.lineItems[0].amountCents).toBe(5092);
    expect(boosted.perRideBoost).toEqual([1.15]);
    // Founder-only annotation rides in meta (D9), never in warnings.
    expect(boosted.lineItems[0].meta?.hotZone).toEqual({ placeName: 'Ella', boostPct: 15, label: 'Ella premium +15%' });
    expect(boosted.warnings.join(' ')).not.toMatch(/Ella|premium|zone/i);
  });

  it('a leg NOT touching a zone is unchanged', () => {
    const boosted = quotePrivateLegs([ride('Kandy', 'Nuwara Eliya', 80)], 'car', undefined, withZones([ELLA]));
    const base = quotePrivateLegs([ride('Kandy', 'Nuwara Eliya', 80)], 'car');
    expect(boosted.lineItems[0].amountCents).toBe(base.lineItems[0].amountCents);
    expect(boosted.perRideBoost).toEqual([1]);
    expect(boosted.lineItems[0].meta?.hotZone).toBeUndefined();
  });

  it('a zone does nothing to a floor-priced short hop (D6) — no annotation', () => {
    // 10km car: billableKm=15 → round(15×40.25×1.15)=694 < 2900 floor → still 2900.
    const boosted = quotePrivateLegs([ride('Ella', 'Demodara', 10)], 'car', undefined, withZones([ELLA]));
    expect(boosted.lineItems[0].amountCents).toBe(2900);
    expect(boosted.perRideBoost).toEqual([1.15]); // boost computed…
    expect(boosted.lineItems[0].meta?.hotZone).toBeUndefined(); // …but had no effect ⇒ not annotated
  });
});

describe('engine cost basis — the boost books as COST, not margin (D6)', () => {
  const trip = (card?: RateCard) =>
    quote({ product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Ella', distanceKm: 100 }] }, card);

  it('scales the cost basis by the same 1.15, so margin is not inflated', () => {
    const base = trip();
    const boosted = trip(withZones([ELLA]));
    // costBasis = total − margin. Unboosted: round(110×35)=3850. Boosted: round(110×35×1.15)=4428.
    const baseCost = base.totalCents - (base.marginEstimateCents ?? 0);
    const boostedCost = boosted.totalCents - (boosted.marginEstimateCents ?? 0);
    expect(baseCost).toBe(3850);
    expect(boostedCost).toBe(4428); // == round(3850 × 1.15) — cost rose WITH the sell price
    // If the boost were booked as pure margin, boostedCost would still be 3850 (margin inflated).
    expect(boostedCost).not.toBe(baseCost);
  });
});

describe('D11 — custom per-km tiers ignore zones (sell AND cost)', () => {
  it('a van14 custom-rate quote touching Ella is identical with or without an active zone', () => {
    const req = { product: 'private' as const, vehicle: 'van14' as const, pax: 12, bags: 6, customPerKmCents: 200, legs: [{ from: 'Kandy', to: 'Ella', distanceKm: 100 }] };
    const noZone = quote(req);
    const withZone = quote(req, withZones([ELLA]));
    expect(withZone.totalCents).toBe(noZone.totalCents);
    expect(withZone.marginEstimateCents).toBe(noZone.marginEstimateCents);
    expect(withZone.lineItems[0].meta?.hotZone).toBeUndefined();
  });
});

describe('chauffeur — per-day boost (D10)', () => {
  const day = (date: string, a: string, b: string, km: number) => normalizeChauffeurDay({ date, from: a, to: b, distanceKm: km });

  it('boosts only the zone-touching travel day; day rate is NOT boosted', () => {
    const input = { vehicle: 'car' as const, firstDate: '2026-08-01', lastDate: '2026-08-01', travelDays: [day('2026-08-01', 'Kandy', 'Ella', 100)] };
    const base = quoteChauffeur(input);
    const boosted = quoteChauffeur(input, withZones([ELLA]));
    // day rate identical (unboosted); distance charge boosted: base bill 110 → weighted 126.5.
    expect(boosted.lineItems[0].amountCents).toBe(base.lineItems[0].amountCents); // day rate
    expect(base.lineItems[1].amountCents).toBe(Math.round(110 * RATE_CARD.perKmCents.car));
    expect(boosted.lineItems[1].amountCents).toBe(Math.round(110 * 1.15 * RATE_CARD.perKmCents.car));
    expect(boosted.meta.boostedBillableKm).toBeCloseTo(126.5);
    expect(boosted.lineItems[1].meta?.hotZone).toMatchObject({ placeName: 'Ella', boostPct: 15 });
  });

  it('an idle day parked in a zone gets its idle-min km boosted (D10 inherit)', () => {
    // 2-day trip, 1 travel day Kandy→Ella, 1 idle day parked in Ella. car idleMinKm=50.
    const input = { vehicle: 'car' as const, firstDate: '2026-08-01', lastDate: '2026-08-02', travelDays: [day('2026-08-01', 'Kandy', 'Ella', 100)] };
    const boosted = quoteChauffeur(input, withZones([ELLA]));
    // weighted travel 110×1.15=126.5 + idle 50×1.15=57.5 = 184.
    expect(boosted.meta.boostedBillableKm).toBeCloseTo(184);
    expect(boosted.lineItems[1].amountCents).toBe(Math.round(184 * RATE_CARD.perKmCents.car));
  });

  it('idle day parked OUTSIDE a zone leaves idle km unboosted', () => {
    // travel day Colombo→Kandy (no zone), idle day parked in Kandy. Only... nothing boosted.
    const input = { vehicle: 'car' as const, firstDate: '2026-08-01', lastDate: '2026-08-02', travelDays: [day('2026-08-01', 'Colombo City', 'Kandy', 100)] };
    const base = quoteChauffeur(input);
    const boosted = quoteChauffeur(input, withZones([ELLA]));
    expect(boosted.subtotalCents).toBe(base.subtotalCents);
  });
});
