import { RATE_CARD, type Vehicle } from './rateCard';

export const VEHICLE_ORDER: Vehicle[] = ['car', 'van', 'van9', 'van14', 'custom'];

export function vehicleRank(v: Vehicle): number {
  return VEHICLE_ORDER.indexOf(v);
}

export function selectVehicle(pax: number, bags: number): Vehicle | 'too_big' {
  for (const v of VEHICLE_ORDER) {
    const caps = RATE_CARD.vehicle[v];
    if (pax <= caps.maxPax && bags <= caps.maxBags) return v;
  }
  return 'too_big';
}
