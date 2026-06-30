export type Vehicle = 'car' | 'van';
export const EXTRA_CODES = ['sightseeing', 'safari-wait', 'luggage', 'front', 'flex', 'waiting'] as const;
export type ExtraCode = typeof EXTRA_CODES[number];

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
  bufferPct: 10,
  fxUsdToLkr: 320, // ⚠️ manual rate — ops updates occasionally (issue I3). Display only; engine stays USD.
  extras: { sightseeing: 1000, 'safari-wait': 1900, luggage: 500, front: 800, flex: 1200, waiting: 1000 },
  shared: { colomboPickupCents: 300 },
} as const;
