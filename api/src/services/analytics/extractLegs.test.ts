import { describe, it, expect } from 'vitest';
import { extractTrip } from './extractLegs';

// request_json shapes: modern rows are { tool, engine } (internalQuote.ts save); legacy rows may
// be a bare engine request. Everything else must degrade to null, never throw.

const privateEngine = {
  product: 'private',
  vehicle: 'car',
  pax: 2,
  bags: 2,
  legs: [
    { from: 'Colombo Airport (CMB)', to: 'kandy', distanceKm: 115 },
    { stops: ['Kandy', 'ella ', 'Yala'], segmentKms: [140, 90] },
  ],
};

describe('extractTrip', () => {
  it('reads the { tool, engine } wrapper and unions stops once per quote', () => {
    const t = extractTrip({ tool: { whatever: true }, engine: privateEngine })!;
    // 'Kandy' appears in both legs (case-variant) — counted once.
    expect(t.places).toEqual(['Colombo Airport (CMB)', 'Kandy', 'Ella', 'Yala']);
    expect(t.totalKm).toBe(345);
    expect(t.pax).toBe(2);
  });

  it('accepts a bare legacy engine request', () => {
    const t = extractTrip(privateEngine)!;
    expect(t.places).toContain('Kandy');
  });

  it('canonicalizes names against KNOWN_PLACES case-insensitively, keeps unknown literals', () => {
    const t = extractTrip({
      product: 'private', vehicle: 'car', pax: 1, bags: 0,
      legs: [{ from: '  ella', to: 'My Aunt House', distanceKm: 10 }],
    })!;
    expect(t.places).toEqual(['Ella', 'My Aunt House']);
  });

  it('corridors are directional first→last per ride, with the ride km attached', () => {
    const t = extractTrip({ tool: {}, engine: privateEngine })!;
    expect(t.corridors).toEqual([
      { from: 'Colombo Airport (CMB)', to: 'Kandy', km: 115 },
      { from: 'Kandy', to: 'Yala', km: 230 },
    ]);
  });

  it('normalizes chauffeur travelDays (old and ride shapes)', () => {
    const t = extractTrip({
      product: 'chauffeur', vehicle: 'van_6', firstDate: '2099-01-01', lastDate: '2099-01-02', pax: 4,
      travelDays: [
        { date: '2099-01-01', from: 'Galle', to: 'Mirissa', distanceKm: 40 },
        { date: '2099-01-02', stops: ['Mirissa', 'Yala'], segmentKms: [120] },
      ],
    })!;
    expect(t.places).toEqual(['Galle', 'Mirissa', 'Yala']);
    expect(t.totalKm).toBe(160);
    expect(t.pax).toBe(4);
  });

  it('returns null for shared (routeId-based, no place names) and for garbage', () => {
    expect(extractTrip({ product: 'shared', legs: [{ routeId: 'r1', seats: 2, seatPriceCents: 4500 }] })).toBeNull();
    expect(extractTrip(null)).toBeNull();
    expect(extractTrip('not an object')).toBeNull();
    expect(extractTrip({ product: 'private', legs: 'nope' })).toBeNull();
    expect(extractTrip({ engine: { product: 'private', legs: [{ from: 1, to: 2 }] } })).toBeNull();
  });

  it('km becomes null (not NaN) when a segment is missing, places still extracted', () => {
    const t = extractTrip({
      product: 'private', vehicle: 'car', pax: 1, bags: 0,
      legs: [{ stops: ['Kandy', 'Ella'], segmentKms: [null] }],
    })!;
    expect(t.places).toEqual(['Kandy', 'Ella']);
    expect(t.totalKm).toBeNull();
    expect(t.corridors).toEqual([{ from: 'Kandy', to: 'Ella', km: null }]);
  });
});
