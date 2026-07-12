import { describe, it, expect, beforeAll } from 'vitest';
import { loadTransfers } from './_load.js';

// exactSpotDecision guards that the booking-page "exact spot" only REFINES the area the
// customer already chose (a hotel/landmark inside it), not swaps in a different route.
// Straight-line distance from the area point must stay within MAX_EXACT_KM (10). Beyond
// that the caller hard-blocks Continue instead of silently re-pricing.
let T;
beforeAll(() => { T = loadTransfers(); });

const CMB = { lat: 7.18, lng: 79.88 };   // Colombo Airport (the chosen pick-up area)

describe('exactSpotDecision', () => {
  it('exposes a 10 km default limit', () => {
    expect(T.MAX_EXACT_KM).toBe(10);
  });

  it('allows a spot inside the area (a hotel a few km away)', () => {
    const spot = { lat: 7.20, lng: 79.90 }; // ~2.9 km from CMB
    const d = T.exactSpotDecision(CMB, spot);
    expect(d.ok).toBe(true);
    expect(d.km).toBeLessThanOrEqual(10);
  });

  it('blocks a spot far outside the area (Jaffna — the reported bug)', () => {
    const jaffna = { lat: 9.66, lng: 80.02 }; // ~276 km from CMB
    const d = T.exactSpotDecision(CMB, jaffna);
    expect(d.ok).toBe(false);
    expect(d.km).toBeGreaterThan(200);
    expect(d.limit).toBe(10);
  });

  it('allows a spot just inside the limit', () => {
    const inside = { lat: 7.18 + 9 / 111, lng: 79.88 }; // ~9 km due north
    const d = T.exactSpotDecision(CMB, inside, 10);
    expect(d.ok).toBe(true);
    expect(d.km).toBe(9);
  });

  it('blocks just past the limit', () => {
    const past = { lat: 7.18 + 12 / 111, lng: 79.88 }; // ~12 km
    const d = T.exactSpotDecision(CMB, past, 10);
    expect(d.ok).toBe(false);
    expect(d.km).toBe(12);
  });

  it('respects a custom limit', () => {
    const spot = { lat: 7.23, lng: 79.88 }; // ~5.6 km
    expect(T.exactSpotDecision(CMB, spot, 3).ok).toBe(false);
    expect(T.exactSpotDecision(CMB, spot, 8).ok).toBe(true);
  });

  it('fails open when a coordinate is missing (never blocks the unverifiable)', () => {
    expect(T.exactSpotDecision(CMB, null).ok).toBe(true);
    expect(T.exactSpotDecision(null, CMB).ok).toBe(true);
    expect(T.exactSpotDecision(CMB, { lat: null, lng: null }).ok).toBe(true);
    expect(T.exactSpotDecision(CMB, null).km).toBe(null);
  });
});
