import { describe, it, expect } from 'vitest';
import { nearestCatalogTown } from './nearestTown';

// Area for a Google-picked business = our own nearest catalogue town (2026-10-18). Google's own locality
// for Atherya came back as "Kimbissa"; travellers and the booking page know it as Sigiriya.
describe('nearestCatalogTown', () => {
  it('names the closest catalogue town, first part of a combined name', () => {
    expect(nearestCatalogTown(7.9571, 80.7601)).toBe('Sigiriya'); // Athreya, Kimbissa
    expect(nearestCatalogTown(6.8667, 81.0466)).toBe('Ella');
    expect(nearestCatalogTown(5.948, 80.457)).toBe('Mirissa');
  });
  it('never answers the airport', () => {
    expect(nearestCatalogTown(7.18, 79.884)).not.toBe('Colombo Airport (CMB)');
  });
  it('is null when nothing is within 25 km', () => {
    expect(nearestCatalogTown(7.3, 81.4)).toBeNull(); // between Ella and the east coast, no town near
  });
});
