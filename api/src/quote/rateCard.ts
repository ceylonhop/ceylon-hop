export type Vehicle = 'car' | 'van' | 'van9' | 'van14' | 'custom';
export const EXTRA_CODES = ['sightseeing', 'safari-wait', 'luggage', 'front', 'flex', 'waiting'] as const;
export type ExtraCode = typeof EXTRA_CODES[number];

// A chauffeur-guide trip includes the vehicle (and driver) all day, so these extras are
// already covered by the day rate and must never be charged again on a chauffeur quote.
export const CHAUFFEUR_INCLUDED_EXTRAS = ['sightseeing', 'waiting', 'safari-wait'] as const;

// ── Pricing model (owner 2026-07-11) ──────────────────────────────────────────────
// The stored per-km and day-rate numbers are our COSTS. The customer SELL price =
// cost × (1 + markup), so the margin is real: sell − cost = markup × cost.
//   • per-km + chauffeur day rate: cost + 15% margin.
//   • minimum fares (floors) + extras: FINAL prices, NO markup (owner call).
// Owner-provided per-km COSTS in LKR/km, converted at 1 USD = 330 LKR (see fxUsdToLkr):
//   car 115 → 35¢ · van 155 → 47¢ · van9 155 (= van6) → 47¢ · van14 160 → 48¢. custom placeholder.
const MARKUP_PCT = 15;
const COST_PER_KM_CENTS = { car: 35, van: 47, van9: 47, van14: 48, custom: 175 } as const;
const DAY_RATE_COST_CENTS = 2700; // $27/day driver COST (owner 2026-07-10)

// SELL = cost × (1 + markup), via integer-cent math so it stays exact (costCents × 1.15
// hits float error: 2700 × 1.15 = 3104.9999…). The per-km sell is kept as (possibly
// fractional) cents on purpose — the final leg price rounds exactly once, so a whole-cent
// per-km cost never loses precision to an early per-km rounding (car 35¢ → 40.25¢ sell).
const sell = (costCents: number): number => (costCents * (100 + MARKUP_PCT)) / 100;

export const RATE_CARD = {
  version: '2026-07-11',
  currency: 'USD',
  markupPct: MARKUP_PCT,
  // Customer SELL rate per km = cost × 1.15 (the engine + front-end price off this).
  perKmCents: {
    car: sell(COST_PER_KM_CENTS.car),
    van: sell(COST_PER_KM_CENTS.van),
    van9: sell(COST_PER_KM_CENTS.van9),
    van14: sell(COST_PER_KM_CENTS.van14),
    custom: sell(COST_PER_KM_CENTS.custom),
  },
  costPerKmCents: COST_PER_KM_CENTS, // real owner cost — margin = sell − cost
  // Minimum fares are FINAL prices with NO markup: a leg that prices below the floor is charged
  // the floor as-is (the floor already covers the fixed cost of a short trip).
  floorCents: { car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 }, // van9 floor = van6's $50
  // Chauffeur: SELL day rate = cost × 1.15 (dayRateCostCents kept for margin). Idle days bill a
  // flat 100 km/day min at the sell per-km, on top of the day charge.
  chauffeur: {
    dayRateCents: Math.round(sell(DAY_RATE_COST_CENTS)), // customer SELL day rate (whole-cent per-day charge)
    dayRateCostCents: DAY_RATE_COST_CENTS,   // real cost — margin only
    idleMinKm: { car: 100, van: 100, van9: 100, van14: 100, custom: 100 },
  },
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
  // Extras are FINAL prices with NO markup (owner 2026-07-11).
  extras: { sightseeing: 1000, 'safari-wait': 1900, luggage: 500, front: 800, flex: 1200, waiting: 1000 },
  shared: { colomboPickupCents: 300 },
} as const;
