// Sale facts for GA4 (spec 2026-10-03 §5.4). Places go through knownPlace — a known town /
// region / type or "Other", never the stored string (privacy, and GA4 cardinality).

import { knownPlace } from './knownPlace';

export type ServiceType = 'transfer' | 'shared_seat' | 'trip' | 'chauffeur';

export interface PurchaseFactsInput {
  service: ServiceType;
  stops: string[];
  pax: number | null;
  vehicle: string | null;
  date: string | null;
}

export interface PurchaseFacts {
  service_type: ServiceType;
  pickup: string; pickup_region: string; pickup_type: string;
  dropoff: string; dropoff_region: string; dropoff_type: string;
  route: string; region_route: string;
  pax: number | null;
  vehicle_type: 'car' | 'van' | 'shared' | 'unknown';
  travel_date: string | null;
}

const isoDay = (s: string | null | undefined): string | null => {
  const d = String(s ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
};

export function purchaseFacts(i: PurchaseFactsInput): PurchaseFacts {
  const from = knownPlace(i.stops[0]);
  const to = knownPlace(i.stops[i.stops.length - 1]);
  const v = i.vehicle ?? '';
  return {
    service_type: i.service,
    pickup: from.town, pickup_region: from.region, pickup_type: from.type,
    dropoff: to.town, dropoff_region: to.region, dropoff_type: to.type,
    route: `${from.town} → ${to.town}`,
    region_route: `${from.region} → ${to.region}`,
    pax: typeof i.pax === 'number' && Number.isFinite(i.pax) ? i.pax : null,
    vehicle_type: i.service === 'shared_seat' ? 'shared' : v === 'car' ? 'car' : v.startsWith('van') ? 'van' : 'unknown',
    travel_date: isoDay(i.date),
  };
}
