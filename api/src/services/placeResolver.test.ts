import { describe, it, expect } from 'vitest';
import { InMemoryPlaceResolutionRepo } from '../db/placeResolutionRepo';
import { PlaceResolver, AUTO_LINK_KM } from './placeResolver';

// A geocoder stub. The real one is Google; what matters here is only WHERE it claims a string
// sits, because the whole design turns on never trusting that claim on its own.
const geo = (points: Record<string, { lat: number; lng: number; displayName?: string }>) => ({
  geocode: async (q: string) => {
    const hit = points[q.trim().toLowerCase()];
    return hit ? { lat: hit.lat, lng: hit.lng, displayName: hit.displayName ?? q, area: null } : null;
  },
});

describe('PlaceResolver — a distance may only be priced from an identified place', () => {
  it('resolves a catalog place from the seeded table', async () => {
    const r = new PlaceResolver(new InMemoryPlaceResolutionRepo(), geo({}));
    const out = await r.resolve('Kandy');
    expect(out.kind).toBe('resolved');
    if (out.kind !== 'resolved') return;
    expect([out.lat, out.lng]).toEqual([7.29, 80.63]);
  });

  it('resolves the label variant onto the same catalog row', async () => {
    const r = new PlaceResolver(new InMemoryPlaceResolutionRepo(), geo({}));
    const bare = await r.resolve('Yala');
    const suffixed = await r.resolve('Yala, Sri Lanka');
    expect(suffixed).toEqual(bare);
  });

  // The incident, pinned. Google puts "Yala, Sri Lanka" near Horana; nothing may adopt that.
  it('does NOT adopt a geocode for an unknown string, even a confident one', async () => {
    const repo = new InMemoryPlaceResolutionRepo(false); // empty catalog
    const r = new PlaceResolver(repo, geo({ 'yala, sri lanka': { lat: 6.664, lng: 80.0706 } }));
    const out = await r.resolve('Yala, Sri Lanka');
    expect(out.kind).toBe('needs_confirmation');
    expect(await repo.get('yala, sri lanka')).toBeNull(); // nothing written
  });

  it('needs confirmation for a place nobody has ever confirmed', async () => {
    const r = new PlaceResolver(new InMemoryPlaceResolutionRepo(), geo({}));
    const out = await r.resolve('Amanwella Hotel, Tangalle');
    expect(out.kind).toBe('needs_confirmation');
    if (out.kind !== 'needs_confirmation') return;
    expect(out.name).toBe('Amanwella Hotel, Tangalle');
  });

  describe('auto-link — a geocode may identify a place we already trust, never introduce one', () => {
    it('links a new string that lands within the radius of exactly one trusted row', async () => {
      const repo = new InMemoryPlaceResolutionRepo();
      // ~0.4 km from the catalog's Kandy (7.29, 80.63).
      const r = new PlaceResolver(repo, geo({ 'kandy city centre': { lat: 7.2932, lng: 80.6318 } }));
      const out = await r.resolve('Kandy City Centre');
      expect(out.kind).toBe('resolved');
      if (out.kind !== 'resolved') return;
      // Takes the ANCHOR's coordinate, not the geocode's — the anchor is the verified one.
      expect([out.lat, out.lng]).toEqual([7.29, 80.63]);
      const written = await repo.get('kandy city centre');
      expect(written?.source).toBe('auto_linked');
    });

    it('refuses to link when the geocode is beyond the radius', async () => {
      const repo = new InMemoryPlaceResolutionRepo();
      const r = new PlaceResolver(repo, geo({ 'somewhere else': { lat: 7.45, lng: 80.63 } })); // ~18 km
      expect((await r.resolve('Somewhere Else')).kind).toBe('needs_confirmation');
      expect(await repo.get('somewhere else')).toBeNull();
    });

    it('refuses to link when two trusted rows are both in range — that is a choice, not an identification', async () => {
      const repo = new InMemoryPlaceResolutionRepo(false);
      await repo.upsert({ canonKey: 'pier a', displayName: 'Pier A', lat: 6.0, lng: 80.0 });
      await repo.upsert({ canonKey: 'pier b', displayName: 'Pier B', lat: 6.002, lng: 80.002 });
      const r = new PlaceResolver(repo, geo({ 'the pier': { lat: 6.001, lng: 80.001 } }));
      expect((await r.resolve('The Pier')).kind).toBe('needs_confirmation');
    });

    it('does not link when the geocoder has nothing', async () => {
      const r = new PlaceResolver(new InMemoryPlaceResolutionRepo(), geo({}));
      expect((await r.resolve('Nowhere At All')).kind).toBe('needs_confirmation');
    });
  });

  it('an explicit confirmation makes the same string resolve forever after', async () => {
    const repo = new InMemoryPlaceResolutionRepo();
    const r = new PlaceResolver(repo, geo({}));
    expect((await r.resolve('Hiriketiya Beach')).kind).toBe('needs_confirmation');
    await repo.upsert({ canonKey: 'Hiriketiya Beach', displayName: 'Hiriketiya Beach', lat: 5.9573, lng: 80.6989, confirmedBy: 'ops@x.com' });
    const out = await r.resolve('hiriketiya  beach'); // sloppier spacing, same place
    expect(out.kind).toBe('resolved');
    if (out.kind !== 'resolved') return;
    expect(out.lat).toBeCloseTo(5.9573, 4);
  });

  it('exposes the radius it used, so the number is testable rather than buried', () => {
    expect(AUTO_LINK_KM).toBe(1.0);
  });
});
