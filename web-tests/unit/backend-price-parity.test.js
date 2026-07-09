import { describe, it, expect, beforeAll } from 'vitest';
import { loadTransfers, carFare, vanFare } from './_load.js';
// The backend is the source of truth. These imports pull the REAL rate card and the corridor
// seat prices straight from api/, so this test fails the moment any customer-facing price copy
// drifts from the backend — the gap that let the rate change need four hand-edits today.
import { RATE_CARD } from '../../api/src/quote/rateCard.ts';
import { legPriceCents, billableKm } from '../../api/src/quote/private.ts';
import { DEFAULT_CORRIDORS } from '../../api/src/db/departureRepo.ts';

let T;
beforeAll(() => { T = loadTransfers(); });

// The customer site shows WHOLE-DOLLAR prices; the backend charges to the cent. Same rate,
// different display granularity — so compare the backend price rounded to whole dollars.
// (Because billableKm and perKmCents are integers, this equals the front-end's own rounding
// exactly when the rate matches, and diverges the instant the rate drifts.)
const backendLegUsd = (rawKm, veh) => Math.round(legPriceCents(billableKm(rawKm), veh) / 100);

describe('customer per-km rate matches the backend rate card', () => {
  it('T.PER_KM equals rateCard.perKmCents (car/van, the two customer tiers)', () => {
    expect(Math.round(T.PER_KM.car * 100)).toBe(RATE_CARD.perKmCents.car);
    expect(Math.round(T.PER_KM.van * 100)).toBe(RATE_CARD.perKmCents.van);
  });
});

describe('customer transfer prices match the backend (rate + floor, end to end)', () => {
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

describe('customer shared-seat corridors match the backend departure repo', () => {
  it('every front-end corridor seat == the backend corridor seatPrice', () => {
    const byId = new Map(DEFAULT_CORRIDORS.map((c) => [c.id, c.seatPrice]));
    expect(T.CORRIDORS.length).toBeGreaterThan(0);
    for (const c of T.CORRIDORS) {
      expect(byId.has(c.id), `backend has no corridor ${c.id}`).toBe(true);
      expect(c.seat * 100, `corridor ${c.id} seat`).toBe(byId.get(c.id));
    }
  });
});
