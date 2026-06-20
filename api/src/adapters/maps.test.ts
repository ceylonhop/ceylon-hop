import { describe, it, expect, afterEach } from 'vitest';
import { FakeMapsAdapter, GoogleMapsAdapter } from './maps';

describe('FakeMapsAdapter', () => {
  const maps = new FakeMapsAdapter();

  it('estimates road distance + duration for known places', async () => {
    const r = await maps.distance('Colombo Airport (CMB)', 'Galle');
    expect(r).not.toBeNull();
    // crow-flies × 1.35 ≈ 180 km, matching the marketing site's estimate
    expect(r!.km).toBeGreaterThanOrEqual(175);
    expect(r!.km).toBeLessThanOrEqual(185);
    expect(r!.durationMin).toBeGreaterThan(0);
  });

  it('is case-insensitive on place names', async () => {
    const r = await maps.distance('kandy', 'ELLA');
    expect(r).not.toBeNull();
    expect(r!.km).toBeGreaterThan(0);
  });

  it('returns null for an unknown / typed address (needs real geocoding)', async () => {
    expect(await maps.distance('Galadari Hotel, Colombo', 'Galle')).toBeNull();
  });
});

describe('GoogleMapsAdapter', () => {
  const origFetch = global.fetch;
  afterEach(() => { global.fetch = origFetch; });

  it('parses a Distance Matrix response into km + minutes', async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ rows: [{ elements: [{ status: 'OK', distance: { value: 180000 }, duration: { value: 15420 } }] }] }),
        { status: 200 },
      )) as typeof fetch;
    const r = await new GoogleMapsAdapter('test-key').distance('Colombo', 'Galle');
    expect(r).toEqual({ km: 180, durationMin: 257 });
  });

  it('returns null when the route has no result', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ rows: [{ elements: [{ status: 'ZERO_RESULTS' }] }] }), { status: 200 })) as typeof fetch;
    expect(await new GoogleMapsAdapter('test-key').distance('Nowhere', 'Elsewhere')).toBeNull();
  });
});
