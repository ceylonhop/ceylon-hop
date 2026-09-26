// The canonical set of prices the static front-end is allowed to know. `tools/generate-pricing.mjs`
// dumps it from the CODE card (scripts/dump-pricing.ts) as the site's offline fallback, and
// GET /quote/pricing serves it from the LIVE card (spec 2026-09-26) so the site follows the
// founder's saved rates on page load. Either way the front-end never hand-copies a price. Cents -> whole USD conversion happens here, once, at the
// boundary — the backend stays in integer minor units.
import { RATE_CARD, type RateCard } from './rateCard';
import { DEFAULT_CORRIDORS, SHARED_PRODUCTS } from '../db/departureRepo';
import { SEATS_COVERING_VAN } from './seatPrice';

export type PricingPayload = {
  perKm: { car: number; van: number };
  floors: { car: number; van: number };
  bufferPct: number;
  priceFinishing: { maxReductionBps: number; roundToCents: number };
  chauffeurDayFee: number;
  chauffeurIdleMinKm: { car: number; van: number }; // idle-day min km/day (km, not USD)
  depositPct: number; // fraction, e.g. 0.10
  depositCap: number; // whole USD
  extras: Record<string, number>; // USD per extra code
  corridorSeat: Record<string, number>; // corridorId -> whole-USD seat price
  // Seat-price inputs in CENTS, so the front-end reproduces seatPriceForDistance() exactly.
  // The dollar `perKm`/`floors` above lose the last place through ×100, which can land on the
  // other side of a 50c rounding boundary — a silent 50c disagreement with the server.
  seatPricing: { perKmCentsVan: number; floorCentsVan: number; seatsCoveringVan: number };
  // The shared catalogue: the DIRECTED legs we actually sell, each with its own USD
  // price and boarding time. The front-end offers a shared seat on these and nothing
  // else — corridor adjacency is not an offer (see departureRepo.ts SHARED_PRODUCTS).
  sharedProducts: Array<{
    id: string;
    corridorId: string;
    from: string;
    to: string;
    seat: number; // whole USD
    time: string;
    pickup: string | null;
  }>;
};

const usd = (cents: number) => cents / 100;

export function buildPricingPayload(card: RateCard = RATE_CARD): PricingPayload {
  const extras: Record<string, number> = {};
  for (const [code, cents] of Object.entries(card.extras)) extras[code] = usd(cents);

  const corridorSeat: Record<string, number> = {};
  for (const cor of DEFAULT_CORRIDORS) corridorSeat[cor.id] = usd(cor.seatPrice);

  return {
    perKm: { car: usd(card.perKmCents.car), van: usd(card.perKmCents.van) },
    floors: { car: usd(card.floorCents.car), van: usd(card.floorCents.van) },
    bufferPct: card.bufferPct,
    // Not founder-editable, so a live card always carries the code card's rule; `?:` on RateCard is
    // only for old locked snapshots.
    priceFinishing: card.priceFinishing ?? RATE_CARD.priceFinishing,
    chauffeurDayFee: usd(card.chauffeur.dayRateCents),
    chauffeurIdleMinKm: { car: card.chauffeur.idleMinKm.car, van: card.chauffeur.idleMinKm.van },
    depositPct: card.deposit.pct / 100,
    depositCap: usd(card.deposit.capCents),
    extras,
    corridorSeat,
    seatPricing: {
      perKmCentsVan: card.perKmCents.van,
      floorCentsVan: card.floorCents.van,
      seatsCoveringVan: SEATS_COVERING_VAN,
    },
    sharedProducts: SHARED_PRODUCTS.map((p) => ({
      id: p.id,
      corridorId: p.corridorId,
      from: p.fromPlace,
      to: p.toPlace,
      seat: usd(p.seatPrice),
      time: p.time,
      pickup: p.pickup,
    })),
  };
}
