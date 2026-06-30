export type Vehicle = 'car' | 'van';
export type ExtraCode = 'sightseeing' | 'safari-wait' | 'luggage' | 'front' | 'flex';

export const RATE_CARD = {
  version: '2026-06-28',
  currency: 'USD',
  markupPct: 25,
  perKmCents: { car: 46, van: 83 },
  costPerKmCents: { car: 37, van: 66 }, // for margin reporting only
  floorCents: { car: 2900, van: 5000 },
  chauffeur: { dayRateCents: 3500, idleMinKm: { car: 100, van: 150 } },
  deposit: { pct: 10, capCents: 5000 },
  vehicle: { car: { maxPax: 3, maxBags: 3 }, van: { maxPax: 6, maxBags: 6 } },
  extras: { sightseeing: 1000, 'safari-wait': 1900, luggage: 500, front: 800, flex: 1200 },
  shared: { colomboPickupCents: 300 },
} as const;
