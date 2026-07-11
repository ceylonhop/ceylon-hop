import { RATE_CARD, type RateCard, type Vehicle } from './rateCard';
import type { QuoteRequest } from './types';

export const VEHICLE_ORDER: Vehicle[] = ['car', 'van', 'van9', 'van14', 'custom'];

export function vehicleRank(v: Vehicle): number {
  return VEHICLE_ORDER.indexOf(v);
}

export function selectVehicle(pax: number, bags: number, rateCard: RateCard = RATE_CARD): Vehicle | 'too_big' {
  for (const v of VEHICLE_ORDER) {
    const caps = rateCard.vehicle[v];
    if (pax <= caps.maxPax && bags <= caps.maxBags) return v;
  }
  return 'too_big';
}

// The tier the engine actually prices: for private, the larger of requested vs capacity-required
// (mirrors engine.ts's anti-tamper upgrade logic — never trust req.vehicle blindly for private).
export function pricedVehicle(req: QuoteRequest, rateCard: RateCard = RATE_CARD): Vehicle {
  if (req.product === 'private') {
    const minVehicle = selectVehicle(req.pax, req.bags, rateCard);
    if (minVehicle === 'too_big') return req.vehicle; // engine will throw before breakdown matters
    return vehicleRank(req.vehicle) >= vehicleRank(minVehicle) ? req.vehicle : minVehicle;
  }
  if (req.product === 'chauffeur') {
    if (req.pax == null || req.bags == null) return req.vehicle; // no capacity info → no upgrade
    const minVehicle = selectVehicle(req.pax, req.bags, rateCard);
    if (minVehicle === 'too_big') return req.vehicle; // engine throws before breakdown matters
    return vehicleRank(req.vehicle) >= vehicleRank(minVehicle) ? req.vehicle : minVehicle;
  }
  return 'car'; // shared: placeholder, breakdown legs are [] anyway
}
