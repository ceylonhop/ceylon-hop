import { RATE_CARD, type Vehicle } from './rateCard';

export function selectVehicle(pax: number, bags: number): Vehicle | 'too_big' {
  const { car, van } = RATE_CARD.vehicle;
  if (pax <= car.maxPax && bags <= car.maxBags) return 'car';
  if (pax <= van.maxPax && bags <= van.maxBags) return 'van';
  return 'too_big';
}
