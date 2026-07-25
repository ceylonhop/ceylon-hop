// Fixture: the §1 sample itinerary from docs/superpowers/specs/2026-07-20-multi-stop-rides-design.md
// — a real inbound itinerary (received 2026-07-20) that motivated the ride model. It exercises
// an en-route stop (19 Aug), an out-and-back (21 Aug), a 4-stop hybrid (22 Aug), and — priced
// as a chauffeur span — the "broken chain" reposition day (17 Aug train_support).
//
// Interfaces: consumes only the public `quote()` API (spec §8 test-blast-radius note).
import { describe, it, expect } from 'vitest';
import { quote } from './engine';
import { RATE_CARD } from './rateCard';
import type { QuoteRequest, Ride } from './types';

// km are reasonable literals EXCEPT the two §4 worked-example days (19 Aug, 21 Aug), which
// must exactly match the spec's 72+23 km and 47+47 km segments so their cents are pinned
// against the live rate card, not hand-picked.
const SAMPLE_RIDES: Ride[] = [
  { stops: ['Colombo Airport (CMB)', 'Ella'], segmentKms: [220] }, // 16 Aug
  { stops: ['Nanu Oya', 'Kandy'], segmentKms: [15] }, // 17 Aug — deliberately short: floors
  { stops: ['Kandy', 'Dambulla Cave Temple', 'Habarana'], segmentKms: [72, 23] }, // 19 Aug — §4 worked example (en-route)
  { stops: ['Habarana', 'Polonnaruwa', 'Habarana'], segmentKms: [47, 47] }, // 21 Aug — §4 worked example (out-and-back)
  { stops: ['Habarana', 'Anuradhapura', 'Thanthirimale', 'Anuradhapura'], segmentKms: [45, 50, 50] }, // 22 Aug — 4-stop hybrid
  { stops: ['Anuradhapura', 'Nilaveli Beach'], segmentKms: [110] }, // 23 Aug
  { stops: ['Nilaveli Beach', 'Negombo'], segmentKms: [260] }, // 25 Aug
];

describe('sample itinerary (spec §1) — point-to-point, product:"private"', () => {
  const req: QuoteRequest = { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: SAMPLE_RIDES };
  const result = quote(req, RATE_CARD);
  // Exclude the (optional) final-price-adjustment line item — it's a whole-quote finishing
  // step, not a ride. Ride line items themselves never carry meta.kind.
  const rideLineItems = result.lineItems.filter((li) => li.meta?.kind !== 'price_adjustment');

  it('produces exactly one line item per ride — 7 rides in, 7 ride line items out', () => {
    expect(rideLineItems).toHaveLength(7);
  });

  it('floors the short 17 Aug ride at the (live) car minimum, per ride', () => {
    expect(rideLineItems[1].label).toBe('Nanu Oya → Kandy (car)');
    expect(rideLineItems[1].amountCents).toBe(RATE_CARD.floorCents.car);
  });

  it('prices the 19 Aug en-route day (Kandy→Dambulla→Habarana, 72+23 km) per §4', () => {
    // Ride pricing is per-ride and independent of the other rides in the request — only the
    // request TOTAL goes through price finishing — so a solo one-ride quote pins the exact
    // same cents as this ride's line item inside the 7-ride request, computed live off the
    // rate card rather than hardcoded (so a rate-card change can't silently desync this test).
    const solo = quote({ product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [SAMPLE_RIDES[2]] }, RATE_CARD);
    expect(rideLineItems[2].label).toBe('Kandy → Dambulla Cave Temple → Habarana (car)');
    expect(rideLineItems[2].amountCents).toBe(solo.lineItems[0].amountCents);
  });

  it('prices the 21 Aug out-and-back day (Habarana→Polonnaruwa→Habarana, 47+47 km) per §4', () => {
    const solo = quote({ product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [SAMPLE_RIDES[3]] }, RATE_CARD);
    expect(rideLineItems[3].label).toBe('Habarana → Polonnaruwa → Habarana (car)');
    expect(rideLineItems[3].amountCents).toBe(solo.lineItems[0].amountCents);
  });
});

describe('sample itinerary (spec §1) — same span as chauffeur, 2030-08-16..2030-08-25', () => {
  // §4: "the travel-day list is not identical to the customer's ride list — e.g. 17 Aug
  // needs a train_support reposition day (car drives to meet the train) even though the
  // customer sits on the train." So chauffeur travel days = the 7 rides + 1 reposition day
  // (old shape) = 8, over a 10-day span (16–25 Aug inclusive) → idleDays = 10 − 8 = 2
  // (18/20/24 Aug are the §1 item-5 "independent days with gaps").
  const req: QuoteRequest = {
    product: 'chauffeur',
    vehicle: 'car',
    pax: 2,
    bags: 2,
    firstDate: '2030-08-16',
    lastDate: '2030-08-25',
    travelDays: [
      { date: '2030-08-16', ...SAMPLE_RIDES[0] },
      { date: '2030-08-17', from: 'Ella', to: 'Nanu Oya', distanceKm: 20 }, // train_support reposition — old shape, its own travel day
      { date: '2030-08-17', ...SAMPLE_RIDES[1] },
      { date: '2030-08-19', ...SAMPLE_RIDES[2] },
      { date: '2030-08-21', ...SAMPLE_RIDES[3] },
      { date: '2030-08-22', ...SAMPLE_RIDES[4] },
      { date: '2030-08-23', ...SAMPLE_RIDES[5] },
      { date: '2030-08-25', ...SAMPLE_RIDES[6] },
    ],
  };
  const result = quote(req, RATE_CARD);
  const dayRateLine = result.lineItems.find((li) => li.label.startsWith('Chauffeur day rate'));
  const distanceLine = result.lineItems.find((li) => li.label.startsWith('Distance —'));

  it('spans exactly 10 days (16 Aug .. 25 Aug inclusive)', () => {
    expect(dayRateLine).toBeTruthy();
    const days = Number(dayRateLine!.label.match(/— (\d+) day/)?.[1]);
    expect(days).toBe(10);
  });

  it('bills 2 idle days — 8 travel days (7 rides + reposition) across a 10-day span', () => {
    expect(distanceLine).toBeTruthy();
    const idleKm = Number(distanceLine!.label.match(/\+ (\d+) idle-day min/)?.[1]);
    // idleDays derived live from the rate card's per-vehicle idle minimum, not hardcoded.
    expect(idleKm / RATE_CARD.chauffeur.idleMinKm.car).toBe(2);
  });
});
