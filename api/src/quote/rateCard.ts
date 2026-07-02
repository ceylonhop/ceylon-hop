export type Vehicle = 'car' | 'van' | 'van9' | 'van14' | 'custom';
export const EXTRA_CODES = ['sightseeing', 'safari-wait', 'luggage', 'front', 'flex', 'waiting'] as const;
export type ExtraCode = typeof EXTRA_CODES[number];

// A chauffeur-guide trip includes the vehicle (and driver) all day, so these extras are
// already covered by the day rate and must never be charged again on a chauffeur quote.
export const CHAUFFEUR_INCLUDED_EXTRAS = ['sightseeing', 'waiting', 'safari-wait'] as const;

export const RATE_CARD = {
  version: '2026-06-28',
  currency: 'USD',
  markupPct: 25,
  // van9/van14/custom rates are placeholders pending real numbers (follow perKm = round(cost × 1.25))
  perKmCents: { car: 46, van: 83, van9: 100, van14: 130, custom: 175 },
  costPerKmCents: { car: 37, van: 66, van9: 80, van14: 104, custom: 140 }, // for margin reporting only
  floorCents: { car: 2900, van: 5000, van9: 6500, van14: 8500, custom: 11000 },
  chauffeur: { dayRateCents: 3500, idleMinKm: { car: 100, van: 150, van9: 150, van14: 200, custom: 200 } },
  deposit: { pct: 10, capCents: 5000 },
  vehicle: {
    car:    { maxPax: 3,  maxBags: 3  },
    van:    { maxPax: 6,  maxBags: 6  },
    van9:   { maxPax: 9,  maxBags: 8  },
    van14:  { maxPax: 14, maxBags: 12 },
    custom: { maxPax: 99, maxBags: 99 },
  },
  bufferPct: 10,
  fxUsdToLkr: 320, // ⚠️ manual rate — ops updates occasionally (issue I3). Display only; engine stays USD.
  extras: { sightseeing: 1000, 'safari-wait': 1900, luggage: 500, front: 800, flex: 1200, waiting: 1000 },
  shared: { colomboPickupCents: 300 },
} as const;
