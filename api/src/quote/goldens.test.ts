// api/src/quote/goldens.test.ts
// Phase 0 of docs/superpowers/specs/2026-07-20-multi-stop-rides-design.md.
// Snapshots are captured from the PRE-ride-model engine and are the equivalence
// contract for the refactor: the new engine must reproduce every one deep-equal.
// NEVER regenerate these to make a diff pass — a golden diff is a bug in new code.
import { describe, it, expect } from 'vitest';
import { quote } from './engine';
import { quoteBreakdown } from './breakdown';
import type { QuoteRequest } from './types';

const GOLDEN_REQUESTS: Record<string, QuoteRequest> = {
  // long single leg, no floor
  private_car_single_long: { product: 'private', vehicle: 'car', pax: 2, bags: 2,
    legs: [{ from: 'Colombo Airport (CMB)', to: 'Ella', distanceKm: 205 }] },
  // short single leg — floor hit, captures the no-space warning string byte-for-byte
  private_car_single_floor: { product: 'private', vehicle: 'car', pax: 2, bags: 2,
    legs: [{ from: 'Dambulla', to: 'Habarana', distanceKm: 23 }] },
  // the spec §4 worked-example day quoted the OLD way (2 legs, 2 buffers, floor on leg 2)
  private_car_two_legs_spec_example: { product: 'private', vehicle: 'car', pax: 2, bags: 2,
    legs: [{ from: 'Kandy', to: 'Dambulla', distanceKm: 72 }, { from: 'Dambulla', to: 'Habarana', distanceKm: 23 }] },
  // multi-leg van with extras
  private_van_three_legs_extras: { product: 'private', vehicle: 'van', pax: 5, bags: 5,
    legs: [
      { from: 'Colombo Airport (CMB)', to: 'Kandy', distanceKm: 115 },
      { from: 'Kandy', to: 'Nuwara Eliya', distanceKm: 77 },
      { from: 'Nuwara Eliya', to: 'Ella', distanceKm: 56 },
    ], extras: ['sightseeing', 'waiting'] },
  // capacity upgrade path (car requested for 6 pax → van) + its warning
  private_upgrade_car_to_van: { product: 'private', vehicle: 'car', pax: 6, bags: 4,
    legs: [{ from: 'Galle', to: 'Mirissa', distanceKm: 45 }] },
  // custom-priced tier with operator rate (GL-1d)
  private_van14_custom_rate: { product: 'private', vehicle: 'van14', pax: 12, bags: 10,
    legs: [{ from: 'Colombo', to: 'Kandy', distanceKm: 115 }], customPerKmCents: 120 },
  // zero-distance leg (post-deploy-review guard: floors, doesn't crash)
  private_car_zero_km: { product: 'private', vehicle: 'car', pax: 1, bags: 0,
    legs: [{ from: 'Fort', to: 'Fort Station', distanceKm: 0 }] },
  // chauffeur: 5-day span, 3 travel days → 2 idle days; includes an included-extra warning
  // ('childSeat' is not a real EXTRA_CODES entry — 'sightseeing' exercises the same
  // CHAUFFEUR_INCLUDED_EXTRAS branch, see rateCard.ts)
  chauffeur_van_span_idle: { product: 'chauffeur', vehicle: 'van', pax: 4, bags: 4,
    firstDate: '2030-01-10', lastDate: '2030-01-14',
    travelDays: [
      { date: '2030-01-10', from: 'Colombo Airport (CMB)', to: 'Kandy', distanceKm: 115 },
      { date: '2030-01-12', from: 'Kandy', to: 'Ella', distanceKm: 137 },
      { date: '2030-01-14', from: 'Ella', to: 'Colombo', distanceKm: 210 },
    ], extras: ['sightseeing'] },
  // chauffeur without pax/bags (back-compat: no capacity upgrade branch)
  chauffeur_car_no_pax: { product: 'chauffeur', vehicle: 'car',
    firstDate: '2030-02-01', lastDate: '2030-02-02',
    travelDays: [
      { date: '2030-02-01', from: 'Negombo', to: 'Sigiriya', distanceKm: 148 },
      { date: '2030-02-02', from: 'Sigiriya', to: 'Kandy', distanceKm: 90 },
    ] },
  // shared (untouched by the refactor, pinned anyway)
  shared_two_seats: { product: 'shared', legs: [{ routeId: 'ella-kandy', seats: 2, seatPriceCents: 2950 }] },
};

describe('golden corpus — pre-ride-model engine outputs', () => {
  for (const [name, req] of Object.entries(GOLDEN_REQUESTS)) {
    it(`quote(): ${name}`, () => {
      expect(quote(req)).toMatchSnapshot();
    });
  }
  for (const [name, req] of Object.entries(GOLDEN_REQUESTS)) {
    if (req.product === 'shared') continue;
    it(`quoteBreakdown(): ${name}`, () => {
      expect(quoteBreakdown(req)).toMatchSnapshot();
    });
  }
});
