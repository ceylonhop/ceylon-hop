import { describe, it, expect, beforeAll } from 'vitest';
import { loadTransfers, carFare, vanFare } from './_load.js';
// The backend rate card is the single source of truth. Front-end price CONSTANTS are now
// GENERATED from it (see tools/generate-pricing.mjs + web-tests/unit/pricing-codegen.test.js,
// which guard freshness + constant parity). This test is the behavioral complement: it verifies
// the front-end's legPrice FORMULA (billable-km buffer, per-km, floor) produces the same price
// the backend engine charges — across the floor and per-km regimes — so a formula change (not
// just a constant) can't silently diverge the customer quote from the backend charge.
import { legPriceCents, billableKm } from '../../api/src/quote/private.ts';
import { finishPrice } from '../../api/src/quote/priceFinish.ts';
import { RATE_CARD } from '../../api/src/quote/rateCard.ts';

let T;
beforeAll(() => { T = loadTransfers(); });

// The customer site shows WHOLE-DOLLAR prices; the backend charges to the cent. Same rate,
// different display granularity — compare the backend price rounded to whole dollars. Because
// billableKm and perKmCents are integers, this matches the front-end's own rounding exactly
// when the rate matches, and diverges the instant the rate or formula drifts.
const backendLegUsd = (rawKm, veh) => Math.round(legPriceCents(billableKm(rawKm), veh) / 100);

describe('customer transfer prices match the backend (rate + buffer + floor, end to end)', () => {
  const kms = [30, 50, 100, 136, 200, 335]; // spans both the floor and the per-km regime
  for (const km of kms) {
    it(`car ${km}km`, () => expect(T.legPrice(km, 'car')).toBe(backendLegUsd(km, 'car')));
    it(`van ${km}km`, () => expect(T.legPrice(km, 'van')).toBe(backendLegUsd(km, 'van')));
  }
  it('the test-suite fare mirrors (_load.js) also match the backend', () => {
    for (const km of kms) {
      expect(carFare(km), `carFare(${km})`).toBe(backendLegUsd(km, 'car'));
      expect(vanFare(km), `vanFare(${km})`).toBe(backendLegUsd(km, 'van'));
    }
  });
});

describe('customer final-price finishing matches the backend', () => {
  const rawCents = [4000, 8099, 8110, 40148, 102000, 112500, 112936, 152000, 206018];
  for (const raw of rawCents) {
    it(`${raw} cents`, () => {
      const backend = finishPrice(raw, 0, RATE_CARD.priceFinishing).finalCents;
      expect(Math.round(T.finishPrice(raw / 100) * 100)).toBe(backend);
    });
  }
});
