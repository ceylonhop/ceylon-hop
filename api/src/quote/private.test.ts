import { describe, it, expect } from 'vitest';
import { billableKm, legPriceCents, quotePrivateLegs } from './private';
import { RATE_CARD } from './rateCard';
import { normalizeRide } from './types';
import type { PrivateLeg, Ride } from './types';

describe('legPriceCents', () => {
  it('prices per km (Tatia Kandy→Nanu Oya 80km car → $32.20, above $29 floor)', () => {
    expect(legPriceCents(80, 'car')).toBe(3220); // round(80 × 40.25) = 3220 > 2900 floor
  });
  it('applies the $29 car floor on short legs (35km → $29)', () => {
    expect(legPriceCents(35, 'car')).toBe(2900);
  });
  it('applies the $50 van floor (40km van = 1880 → floored to 5000)', () => {
    expect(legPriceCents(40, 'van')).toBe(5000);
  });
  it('van per-km above the floor (200km van = $108.10)', () => {
    expect(legPriceCents(200, 'van')).toBe(10810); // round(200 × 54.05) = 10810
  });
});

describe('billableKm', () => {
  it('adds 10% with a 5km floor and 15km cap per leg', () => {
    expect(billableKm(80)).toBe(88);
    expect(billableKm(75)).toBe(83);   // 82.5 → 83
    expect(billableKm(35)).toBe(40);   // 3.5km buffer rounds to 4, then floors to 5
    expect(billableKm(200)).toBe(215); // 20km buffer caps at 15
  });
});

describe('quotePrivateLegs', () => {
  it('prices off buffered km (Julián subtotal 6241) — via normalizeRide, same as today\'s 2-leg output', () => {
    const legs: PrivateLeg[] = [
      { from: 'Mirissa', to: 'Tangalle', distanceKm: 35 }, // bill 40 → $29 floor
      { from: 'Yala', to: 'Tangalle', distanceKm: 75 },    // bill 83 → 83×40.25 = 3341
    ];
    const rides: Ride[] = legs.map(normalizeRide);
    const r = quotePrivateLegs(rides, 'car');
    expect(r.subtotalCents).toBe(6241); // 2900 floor + 3341
    expect(r.lineItems).toHaveLength(2);
    expect(r.warnings).toContain('Mirissa→Tangalle hit the $29 car minimum');
  });

  it('2-stop ride output is byte-identical to a normalizeRide()-passed leg (no stops/segmentKms in meta)', () => {
    const ride = normalizeRide({ from: 'Mirissa', to: 'Tangalle', distanceKm: 35 });
    const r = quotePrivateLegs([ride], 'car');
    expect(r.lineItems).toEqual([
      {
        label: 'Mirissa → Tangalle (car)',
        amountCents: 2900,
        meta: { distanceKm: 35, billableKm: 40, vehicle: 'car' },
      },
    ]);
    // GC-4: a 2-stop ride's meta must NOT carry stops/segmentKms — deep-equal above already
    // proves it (extra keys would fail toEqual), but assert explicitly for intent.
    expect('stops' in r.lineItems[0].meta!).toBe(false);
    expect('segmentKms' in r.lineItems[0].meta!).toBe(false);
  });

  it('multi-stop ride (Kandy→Dambulla 72km→Habarana 23km) prices as ONE ride, buffered once', () => {
    // 95 raw km, buffer = clamp(round(95×10%), 5, 15) = 10 → 105 billable km, computed live
    // from RATE_CARD (not hardcoding the spec's $42.26 example) — see the spec worked example
    // in docs/superpowers/specs/2026-07-20-multi-stop-rides-design.md §4.
    const ride: Ride = { stops: ['Kandy', 'Dambulla', 'Habarana'], segmentKms: [72, 23] };
    const rawKm = 95;
    const bKm = billableKm(rawKm);
    const expectedCents = Math.max(RATE_CARD.floorCents.car, Math.round(bKm * RATE_CARD.perKmCents.car));

    const r = quotePrivateLegs([ride], 'car');
    expect(bKm).toBe(105);
    expect(expectedCents).toBe(4226); // matches the spec's $42.26 worked example
    expect(r.subtotalCents).toBe(expectedCents);
    expect(r.lineItems).toHaveLength(1); // ONE ride = ONE line item, not two floored legs
    expect(r.lineItems[0]).toEqual({
      label: 'Kandy → Dambulla → Habarana (car)',
      amountCents: expectedCents,
      meta: { distanceKm: rawKm, billableKm: bKm, vehicle: 'car', stops: ride.stops, segmentKms: ride.segmentKms },
    });
    expect(r.warnings).toHaveLength(0); // 105km well above the floor — no warning at all
  });

  it('out-and-back (Habarana→Polonnaruwa→Habarana, ~47km each way) prices as ONE ride — no double floor', () => {
    // Spec worked example: today (2 legs) = 2 × floor-hit = $58.00; new (1 ride) = 94+9=103km
    // → $41.46, well above the $29 floor. This is the "floors once not twice" case: naive
    // per-leg pricing would floor BOTH 47km legs; combined per-ride pricing floors NEITHER.
    const ride: Ride = { stops: ['Habarana', 'Polonnaruwa', 'Habarana'], segmentKms: [47, 47] };
    const rawKm = 94;
    const bKm = billableKm(rawKm);
    const expectedCents = Math.max(RATE_CARD.floorCents.car, Math.round(bKm * RATE_CARD.perKmCents.car));

    const r = quotePrivateLegs([ride], 'car');
    expect(bKm).toBe(103);
    expect(expectedCents).toBe(4146); // matches the spec's $41.46 worked example
    expect(r.subtotalCents).toBe(expectedCents);
    expect(r.lineItems).toHaveLength(1);
    expect(r.warnings).toHaveLength(0); // NOT floored twice (nor once) — proves per-ride, not per-leg
  });

  it('a short out-and-back that DOES hit the floor is floored ONCE (one warning), not per-segment', () => {
    // 10+10 raw = 20km, buffer clamps to 5 → 25 billable km, well under the $29 floor either
    // way. Naive per-leg pricing (2× 10km legs) would floor twice and emit 2 warnings; per-ride
    // pricing must floor exactly once and emit exactly ONE warning, using the spaced 3-stop form.
    const ride: Ride = { stops: ['X', 'Y', 'X'], segmentKms: [10, 10] };
    const r = quotePrivateLegs([ride], 'car');
    const bKm = billableKm(20);
    expect(bKm).toBe(25);
    expect(r.lineItems).toHaveLength(1);
    expect(r.subtotalCents).toBe(RATE_CARD.floorCents.car);
    expect(r.warnings).toEqual(['X → Y → X hit the $29 car minimum']); // byte-exact spaced 3-stop form
  });

  it('floor-hit warning byte-exact forms: no-space arrow for 2 stops, spaced join for 3+', () => {
    const twoStop: Ride = { stops: ['Mirissa', 'Tangalle'], segmentKms: [35] };
    const threeStop: Ride = { stops: ['A', 'B', 'C'], segmentKms: [5, 5] }; // 10 raw → floors
    const r = quotePrivateLegs([twoStop, threeStop], 'car');
    expect(r.warnings).toContain('Mirissa→Tangalle hit the $29 car minimum'); // byte-exact, NO spaces
    expect(r.warnings).toContain('A → B → C hit the $29 car minimum'); // byte-exact, spaced join
  });
});
