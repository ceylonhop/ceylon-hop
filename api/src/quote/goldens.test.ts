// api/src/quote/goldens.test.ts
// Phase 0 of docs/superpowers/specs/2026-07-20-multi-stop-rides-design.md.
// Snapshots are captured from the PRE-ride-model engine and are the equivalence
// contract for the refactor: the new engine must reproduce every one deep-equal.
// NEVER regenerate these to make a diff pass — a golden diff is a bug in new code.
//
// REGENERATED 2026-08-19 — the ONLY legitimate reason to do so: the final-price policy itself
// changed by owner decision (priceFinish.ts, threshold finishing replacing the $10 charm grid),
// so these snapshots' finishing rows are the thing under revision rather than the contract being
// broken. Every changed figure was read and checked against the new rule before regenerating:
// $88.55→$88.00, $188.62→$188.00 and $535.22→$535.00 drop cents where no threshold is in reach;
// $60.80→$59.99 crosses one the old grid could not see; the van14 case keeps $149.00 exactly and
// only renames its strategy. Core fares, buffers, floors and extras are unchanged throughout.
// The standing rule still holds for every other diff: a golden change is a bug in new code.
//
// SECOND PURPOSE (2026-08-09) — the zero-discount gate for founder manual discounts,
// Task 1 of docs/superpowers/plans/2026-08-09-founder-manual-discounts.md. Discounts add
// an arithmetic step between core pricing and finishing; this corpus is what proves that
// omitting a discount leaves every existing price cent-identical. The cases below the
// marker were added for that gate, covering ground the refactor corpus did not need.
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

  // ─── added 2026-08-09 for the zero-discount gate ───────────────────────────────
  // The van minimum fare. It moved 50.00 → 49.99 on 2026-08-07 (PR #349) and the
  // refactor corpus has no van case short enough to hit a floor at all, so nothing
  // currently pins it. 25 km → buffer 5 → 30 billable × 54.05¢ = $16.22, floor wins.
  private_van_single_floor: { product: 'private', vehicle: 'van', pax: 4, bags: 4,
    legs: [{ from: 'Galle', to: 'Unawatuna', distanceKm: 25 }] },
  // A multi-stop RIDE (3 stops, 2 segments) — the shape multi-stop rides introduced.
  // The discount design rules that via stops break route identity, so the shape has to
  // be pinned before anything reads it. Note the corpus above only ever uses PrivateLeg.
  private_car_multi_stop_ride: { product: 'private', vehicle: 'car', pax: 2, bags: 2,
    legs: [{ stops: ['Colombo', 'Pinnawala', 'Kandy'], segmentKms: [85, 40] }] },
  // Every chargeable extra at once. A manual discount's eligible base is the FULL quote
  // including extras, and each extra's cost is assumed equal to its sell price (spec
  // §5.3), so all six need their sell prices pinned before that assumption is coded.
  private_car_all_extras: { product: 'private', vehicle: 'car', pax: 3, bags: 3,
    legs: [{ from: 'Kandy', to: 'Sigiriya', distanceKm: 90 }],
    extras: ['sightseeing', 'safari-wait', 'luggage', 'front', 'flex', 'waiting'] },
  // Finishing where the PROPORTIONAL cap rejects the charm candidate and the strategy
  // falls back to nearest-50. 70 km → buffer 7 → 77 billable × 40.25¢ = $30.99; the
  // charm target on the $10 grid is $29.00, a $1.99 drop = 6.4% of the raw, well over
  // the 2.5% bps limit → rejected, so it rounds to $31.00 instead.
  // Discounts move the subtotal that this decision is made from, so the boundary must
  // be pinned first. (The absolute $10 cap cannot bind on a $10 grid — max drop is
  // $9.99 by construction — so it is deliberately not exercised here.)
  private_car_finishing_bps_rejects_charm: { product: 'private', vehicle: 'car', pax: 2, bags: 2,
    legs: [{ from: 'Matara', to: 'Tangalle', distanceKm: 70 }] },
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
