import { describe, it, expect } from 'vitest';
import { withPlaceIds } from './placeIdMaps';
import type { MapsAdapter } from './maps';

// A Google pick is measured by its place ID (what the customer actually chose), not by re-finding
// its name — the name is what failed for 46 customers in 28 days (analytics review 2026-11-10).
function recording() {
  const seen: Array<[string, string]> = [];
  const maps: MapsAdapter = {
    provider: 'rec',
    places: async () => [],
    distance: async (a, b) => { seen.push([a, b]); return { km: 1, durationMin: 1 }; },
    distanceVariants: async (a, b) => { seen.push([a, b]); return null; },
  };
  return { maps, seen };
}

describe('withPlaceIds', () => {
  it('measures a named stop by its place ID', async () => {
    const { maps, seen } = recording();
    await withPlaceIds(maps, { 'Casa Selvita, Kandy, Sri Lanka': 'ChIJabcdef123456' }).distance('Ella', 'Casa Selvita, Kandy, Sri Lanka');
    expect(seen).toEqual([['Ella', 'place_id:ChIJabcdef123456']]);
  });
  it('applies to the road comparison too', async () => {
    const { maps, seen } = recording();
    await withPlaceIds(maps, { Hotel: 'ChIJabcdef123456' }).distanceVariants('Hotel', 'Ella');
    expect(seen).toEqual([['place_id:ChIJabcdef123456', 'Ella']]);
  });
  it('leaves a catalogue town on its exact coordinates, whatever ID is sent with it', async () => {
    const { maps, seen } = recording();
    await withPlaceIds(maps, { Kandy: 'ChIJabcdef123456' }).distance('Kandy', 'Ella');
    expect(seen).toEqual([['Kandy', 'Ella']]);
  });
  it('is the same adapter when no ID was sent', () => {
    const { maps } = recording();
    expect(withPlaceIds(maps, {})).toBe(maps);
  });
});
