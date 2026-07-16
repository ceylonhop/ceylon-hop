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
import { quote } from '../../api/src/quote/engine.ts';

let T;
beforeAll(() => { T = loadTransfers(); });

const backendLegUsd = (rawKm, veh) => legPriceCents(billableKm(rawKm), veh) / 100;

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

  for (const veh of ['car', 'van']) {
    it(`matches the complete ${veh} quote path for every distance from 1–500 km`, () => {
      for (let km = 1; km <= 500; km += 1) {
        const webRaw = T.legPrice(km, veh);
        const webFinalCents = Math.round(T.finishPrice(webRaw, T.FLOORS[veh]) * 100);
        const backend = quote({
          product: 'private', vehicle: veh, pax: 2, bags: 1,
          legs: [{ from: 'A', to: 'B', distanceKm: km }],
        });
        expect(webFinalCents, `${veh} ${km}km`).toBe(backend.totalCents);
      }
    });

    it(`matches multi-leg ${veh} quotes before and after final-price finishing`, () => {
      for (const kms of [[10, 10], [69, 91], [136, 200], [314, 41]]) {
        const webRaw = kms.reduce((sum, km) => sum + T.legPrice(km, veh), 0);
        const webFinalCents = Math.round(T.finishPrice(webRaw, kms.length * T.FLOORS[veh]) * 100);
        const backend = quote({
          product: 'private', vehicle: veh, pax: 2, bags: 1,
          legs: kms.map((km, i) => ({ from: String(i), to: String(i + 1), distanceKm: km })),
        });
        expect(webFinalCents, `${veh} ${kms.join('+')}km`).toBe(backend.totalCents);
      }
    });
  }

  it('matches backend chauffeur distance charges to the cent', () => {
    for (const veh of ['car', 'van']) {
      for (let km = 1; km <= 1000; km += 1) {
        const expected = Math.round(km * RATE_CARD.perKmCents[veh]);
        expect(Math.round(T.distancePrice(km, veh) * 100), `${veh} ${km}km`).toBe(expected);
      }
    }
  });
});
