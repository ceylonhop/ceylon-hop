import { describe, it, expect, beforeAll } from 'vitest';
import { loadTransfers } from './_load.js';
// Reverse direction of the maps.test.ts 'front-end catalogue' suite: that one proves the
// SERVER resolves every town the front end knows; this one proves the FRONT END resolves
// every town the server offers. Without it, a via-stop added to KNOWN_PLACES (ops quoting)
// silently returns null from the planner's kmBetween() — three towns had already drifted
// that way (Nilaveli Beach, Nanu Oya, Thanthirimale) when this test was written.
import { KNOWN_PLACES, FakeMapsAdapter } from '../../api/src/adapters/maps.ts';

let T;
beforeAll(() => { T = loadTransfers(); });

// A wrong-town coordinate would still "resolve", so pin each front-end point to the server's
// coordinates for the same name. 0.02° ≈ 2 km — loose enough for legacy rounding drift
// (Habarana is 0.01° off today), tight enough that a different town cannot pass.
const MAX_COORD_DRIFT_DEG = 0.02;

describe('front-end catalogue covers the server place vocabulary', () => {
  for (const town of KNOWN_PLACES) {
    it(`resolves ${town} at the server's coordinates`, async () => {
      const p = T.resolvePlace(town);
      expect(p, `${town} does not resolve in transfers-data.js (PLACES/EXTRA)`).toBeTruthy();
      const server = await new FakeMapsAdapter().geocode(town);
      expect(server, `${town} missing from server COORDS`).toBeTruthy();
      expect(Math.abs(p.lat - server.lat)).toBeLessThanOrEqual(MAX_COORD_DRIFT_DEG);
      expect(Math.abs(p.lng - server.lng)).toBeLessThanOrEqual(MAX_COORD_DRIFT_DEG);
    });
  }

  it('kmBetween prices a leg from every server town', () => {
    for (const town of KNOWN_PLACES) {
      if (town === 'Kandy') continue;
      const km = T.kmBetween(town, 'Kandy');
      expect(km, `kmBetween(${town}, Kandy) returned null`).not.toBeNull();
      expect(km).toBeGreaterThan(0);
    }
  });
});
