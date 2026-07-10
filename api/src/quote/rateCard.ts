export type Vehicle = 'car' | 'van' | 'van9' | 'van14' | 'custom';
export const EXTRA_CODES = ['sightseeing', 'safari-wait', 'luggage', 'front', 'flex', 'waiting'] as const;
export type ExtraCode = typeof EXTRA_CODES[number];

// A chauffeur-guide trip includes the vehicle (and driver) all day, so these extras are
// already covered by the day rate and must never be charged again on a chauffeur quote.
export const CHAUFFEUR_INCLUDED_EXTRAS = ['sightseeing', 'waiting', 'safari-wait'] as const;

export const RATE_CARD = {
  version: '2026-07-09',
  currency: 'USD',
  markupPct: 25,
  // Owner-provided 2026-07-09 as LKR/km, converted at 1 USD = 330 LKR (see fxUsdToLkr):
  //   car 115 → 35¢ · van 155 → 47¢ · van9 155 (= van6) → 47¢ · van14 160 → 48¢.
  // custom still a placeholder pending a real number. cost = round(perKm / 1.25) to keep the
  // 25% markup/margin model consistent.
  perKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
  costPerKmCents: { car: 28, van: 38, van9: 38, van14: 38, custom: 140 }, // for margin reporting only
  floorCents: { car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 }, // van9 floor = van6's $50 (confirm)
  // $27/day driver charge (owner 2026-07-10). Idle days (car kept, no travel) bill a flat
  // 100 km/day minimum for EVERY vehicle, on top of the day charge (owner 2026-07-10).
  chauffeur: { dayRateCents: 2700, idleMinKm: { car: 100, van: 100, van9: 100, van14: 100, custom: 100 } },
  deposit: { pct: 10, capCents: 5000 },
  vehicle: {
    car:    { maxPax: 3,  maxBags: 3  },
    van:    { maxPax: 6,  maxBags: 6  },
    van9:   { maxPax: 9,  maxBags: 8  },
    van14:  { maxPax: 14, maxBags: 12 },
    custom: { maxPax: 99, maxBags: 99 },
  },
  bufferPct: 10,
  fxUsdToLkr: 330, // ⚠️ manual rate — ops updates occasionally (issue I3). Display only; engine stays USD.
  extras: { sightseeing: 1000, 'safari-wait': 1900, luggage: 500, front: 800, flex: 1200, waiting: 1000 },
  shared: { colomboPickupCents: 300 },
} as const;
