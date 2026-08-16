// The canonical set of prices the static front-end is allowed to know. `tools/generate-pricing.mjs`
// dumps this (via scripts/dump-pricing.ts) and injects the values into transfers-data.js / routes-data.js
// so the front-end never hand-copies a price. Cents -> whole USD conversion happens here, once, at the
// boundary — the backend stays in integer minor units.
import { RATE_CARD } from './rateCard';
import { DEFAULT_CORRIDORS, SHARED_PRODUCTS } from '../db/departureRepo';

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

export function buildPricingPayload(): PricingPayload {
  const extras: Record<string, number> = {};
  for (const [code, cents] of Object.entries(RATE_CARD.extras)) extras[code] = usd(cents);

  const corridorSeat: Record<string, number> = {};
  for (const cor of DEFAULT_CORRIDORS) corridorSeat[cor.id] = usd(cor.seatPrice);

  return {
    perKm: { car: usd(RATE_CARD.perKmCents.car), van: usd(RATE_CARD.perKmCents.van) },
    floors: { car: usd(RATE_CARD.floorCents.car), van: usd(RATE_CARD.floorCents.van) },
    bufferPct: RATE_CARD.bufferPct,
    priceFinishing: RATE_CARD.priceFinishing,
    chauffeurDayFee: usd(RATE_CARD.chauffeur.dayRateCents),
    chauffeurIdleMinKm: { car: RATE_CARD.chauffeur.idleMinKm.car, van: RATE_CARD.chauffeur.idleMinKm.van },
    depositPct: RATE_CARD.deposit.pct / 100,
    depositCap: usd(RATE_CARD.deposit.capCents),
    extras,
    corridorSeat,
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
